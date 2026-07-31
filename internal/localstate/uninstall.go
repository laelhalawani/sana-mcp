package localstate

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/config"
)

// binaryName is what every installer this project has shipped calls the
// executable.
func binaryName() string {
	if runtime.GOOS == "windows" {
		return "sana-mcp.exe"
	}
	return "sana-mcp"
}

// Leftover is one thing on disk that belongs to sana-mcp.
type Leftover struct {
	// Kind is "data", "binary" or "profile", which is how the uninstall groups
	// what it is about to do.
	Kind string
	Path string
	// Detail is the extra fact a person needs before agreeing: which line, or
	// that this is the binary currently running.
	Detail string
	// Self marks the running executable. It is removed last, and on Windows it
	// cannot be removed at all while it is running.
	Self bool
}

// Plan is everything an uninstall would remove.
type Plan struct {
	Leftovers []Leftover
}

// Empty reports that there is nothing to remove.
func (p Plan) Empty() bool { return len(p.Leftovers) == 0 }

// installDirectories are where the shipped installers have put the binary.
// A previous implementation used ~/.local/bin, which is why an uninstall that
// only looked at its own install directory left a working older binary first
// on PATH.
func installDirectories(paths config.Paths) []string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	directories := []string{filepath.Join(paths.Root, "bin")}
	if home != "" {
		directories = append(directories,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "bin"),
		)
	}
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			directories = append(directories, filepath.Join(local, "Programs", "sana-mcp"))
		}
	} else {
		directories = append(directories, "/usr/local/bin")
	}
	return directories
}

// profileFiles are the shell startup files the POSIX installer appends to.
func profileFiles() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var files []string
	for _, name := range []string{".zshrc", ".bashrc", ".profile", ".bash_profile"} {
		files = append(files, filepath.Join(home, name))
	}
	return files
}

// profileMarker is the comment the installer writes above the line it adds.
const profileMarker = "# added by sana-mcp installer"

// PlanUninstall lists everything that would be removed, without removing it.
//
// self is the running executable, so it can be reported as such and removed
// last. An empty self means the caller could not resolve it.
func PlanUninstall(paths config.Paths, self string) Plan {
	var plan Plan
	seen := map[string]bool{}

	if _, err := os.Stat(paths.Root); err == nil {
		plan.Leftovers = append(plan.Leftovers, Leftover{
			Kind:   "data",
			Path:   paths.Root,
			Detail: "meetings, transcripts, corrections and the stored sign-in",
		})
	}

	resolvedSelf := self
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		resolvedSelf = resolved
	}

	// Only the directories this project's own installers write to.
	//
	// Scanning PATH instead looked thorough and was dangerous: PATH routinely
	// names directories belonging to another home or another user, and an
	// uninstall offering to delete a binary it never installed is a much worse
	// failure than missing one. Anything else on PATH is reported by
	// StillOnPath afterwards rather than removed.
	for _, directory := range installDirectories(paths) {
		if directory == "" {
			continue
		}
		path := filepath.Join(directory, binaryName())
		if seen[path] {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		seen[path] = true
		leftover := Leftover{Kind: "binary", Path: path}
		if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved == resolvedSelf {
			leftover.Self = true
			leftover.Detail = "the copy running right now"
		}
		// The binary inside the data root goes with the data root, so listing
		// it separately would report a removal twice.
		if !strings.HasPrefix(path, paths.Root+string(filepath.Separator)) {
			plan.Leftovers = append(plan.Leftovers, leftover)
		}
	}

	for _, file := range profileFiles() {
		if lines := profileAdditions(file); len(lines) > 0 {
			plan.Leftovers = append(plan.Leftovers, Leftover{
				Kind:   "profile",
				Path:   file,
				Detail: strings.Join(lines, "; "),
			})
		}
	}
	return plan
}

// profileAdditions returns the lines the installer added to a startup file.
func profileAdditions(file string) []string {
	handle, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer handle.Close()

	var found []string
	scanner := bufio.NewScanner(handle)
	marked := false
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == profileMarker {
			marked = true
			found = append(found, trimmed)
			continue
		}
		if marked {
			marked = false
			if strings.Contains(line, "sana-mcp") {
				found = append(found, trimmed)
			}
		}
	}
	return found
}

// StillOnPath reports a sana-mcp that is still reachable after an uninstall.
//
// It is a warning, not a removal: a binary somewhere this program did not
// install is someone else's to delete. But leaving without saying so is how a
// machine ends up running an old copy that nobody remembers installing.
func StillOnPath(removed []Removal) string {
	gone := map[string]bool{}
	for _, removal := range removed {
		if removal.Err == nil {
			gone[removal.Leftover.Path] = true
		}
	}
	for _, directory := range filepath.SplitList(os.Getenv("PATH")) {
		if directory == "" {
			continue
		}
		path := filepath.Join(directory, binaryName())
		if gone[path] {
			continue
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}

// StopDaemons asks every sana-mcp binary on this machine to stop its daemon.
//
// Asking each binary rather than killing a pid is what makes this work across
// implementations: a daemon started by a previous version keeps its own control
// files, and only that version knows how to shut it down.
func StopDaemons(ctx context.Context, plan Plan) []string {
	var stopped []string
	for _, leftover := range plan.Leftovers {
		if leftover.Kind != "binary" {
			continue
		}
		timed, cancel := context.WithTimeout(ctx, 10*time.Second)
		command := exec.CommandContext(timed, leftover.Path, "daemon", "--stop")
		output, err := command.Output()
		cancel()
		if err != nil {
			continue
		}
		if line := strings.TrimSpace(string(output)); strings.Contains(line, "Stopped") {
			stopped = append(stopped, line)
		}
	}
	return stopped
}

// Removal is what happened to one leftover.
type Removal struct {
	Leftover Leftover
	Err      error
	// Deferred marks something that could not be removed now but will be gone
	// once this process exits.
	Deferred bool
}

// Apply removes everything in the plan.
func (p Plan) Apply() []Removal {
	removals := make([]Removal, 0, len(p.Leftovers))
	var self *Leftover

	for index := range p.Leftovers {
		leftover := p.Leftovers[index]
		if leftover.Self {
			self = &p.Leftovers[index]
			continue
		}
		removals = append(removals, remove(leftover))
	}
	// The running binary last: removing it first would leave the rest of this
	// uninstall running from a file that is already gone.
	if self != nil {
		removals = append(removals, remove(*self))
	}
	return removals
}

func remove(leftover Leftover) Removal {
	switch leftover.Kind {
	case "profile":
		return Removal{Leftover: leftover, Err: stripProfile(leftover.Path)}
	case "binary":
		err := os.Remove(leftover.Path)
		if err != nil && leftover.Self && runtime.GOOS == "windows" {
			// Windows will not unlink a running image. Saying so is better than
			// reporting a failure the user cannot act on.
			return Removal{Leftover: leftover, Deferred: true}
		}
		if os.IsNotExist(err) {
			err = nil
		}
		return Removal{Leftover: leftover, Err: err}
	default:
		err := os.RemoveAll(leftover.Path)
		if os.IsNotExist(err) {
			err = nil
		}
		return Removal{Leftover: leftover, Err: err}
	}
}

// stripProfile removes the marker line and the line it introduced, rewriting
// the file only if something was found.
func stripProfile(file string) error {
	payload, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	lines := strings.Split(string(payload), "\n")
	kept := make([]string, 0, len(lines))
	skipNext := false
	changed := false
	for _, line := range lines {
		if skipNext {
			skipNext = false
			if strings.Contains(line, "sana-mcp") {
				changed = true
				continue
			}
		}
		if strings.TrimSpace(line) == profileMarker {
			skipNext = true
			changed = true
			continue
		}
		kept = append(kept, line)
	}
	if !changed {
		return nil
	}
	info, err := os.Stat(file)
	mode := os.FileMode(0o600)
	if err == nil {
		mode = info.Mode().Perm()
	}
	return os.WriteFile(file, []byte(strings.Join(kept, "\n")), mode)
}
