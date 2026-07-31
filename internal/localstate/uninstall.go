package localstate

import (
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
	// Exactly the two places a shipped installer has written on POSIX:
	// ~/.sana-mcp/bin now, ~/.local/bin before that. /usr/local/bin and ~/bin
	// were guesses, and guessing here means offering to delete a binary this
	// project never installed - on a Homebrew machine, one the user put there
	// by hand.
	directories := []string{filepath.Join(paths.Root, "bin")}
	if home != "" {
		directories = append(directories, filepath.Join(home, ".local", "bin"))
	}
	if runtime.GOOS == "windows" {
		// %LOCALAPPDATA%\sana-mcp, which is what install.ps1 writes. Guessing
		// a Programs subdirectory meant every Windows uninstall reported
		// success while leaving the executable and its PATH entry in place.
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			directories = append(directories, filepath.Join(local, "sana-mcp"))
		}
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

// The markers the shipped installers have written above the PATH line they add.
//
// Two of them, because an earlier version used a fenced block. Knowing only the
// current one is how an install left the older version's entry in place, still
// ahead on PATH, so the freshly installed binary was shadowed by the one it
// replaced.
const (
	profileMarker = "# added by sana-mcp installer"
	profileOpen   = "# >>> sana-mcp installer >>>"
	profileClose  = "# <<< sana-mcp installer <<<"
)

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
	// A replacement that was interrupted between moving the old data aside and
	// deleting it leaves it in a sibling directory. Without this an uninstall
	// reports that everything is gone while the whole previous dataset is still
	// sitting in the home directory.
	for _, quarantine := range quarantines(paths) {
		plan.Leftovers = append(plan.Leftovers, Leftover{
			Kind:   "data",
			Path:   quarantine,
			Detail: "data set aside by an interrupted setup",
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

// profileEdit splits a startup file into the lines that stay and the lines this
// program added, asking drop which of its own entries to take out.
//
// Reporting and rewriting share it, so what an uninstall promises to remove and
// what it removes cannot disagree. The drop callback is what lets an install
// take out a stale entry while leaving the one that points at itself.
func profileEdit(lines []string, drop func(entry []string) bool) (kept, removed []string) {
	kept = make([]string, 0, len(lines))
	var entry []string

	// settle decides one gathered entry.
	settle := func() {
		if len(entry) == 0 {
			return
		}
		if drop(entry) {
			removed = append(removed, entry...)
		} else {
			kept = append(kept, entry...)
		}
		entry = nil
	}

	inBlock := false
	afterMarker := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// A marker only ever introduces the one line under it. Anything else -
		// including an opening fence - ends its reach, or the marker would
		// swallow whatever happened to come next.
		if afterMarker {
			afterMarker = false
			if !inBlock && trimmed != profileOpen && trimmed != profileMarker &&
				strings.Contains(line, "sana-mcp") {
				entry = append(entry, line)
				settle()
				continue
			}
			settle()
		}
		switch {
		case inBlock && trimmed == profileOpen:
			// A second opening fence proves the first was never closed, and its
			// extent is unknown. Everything gathered under it is kept, and this
			// line starts a fresh entry - otherwise a later block's close
			// marker silently swallowed all the user's lines in between.
			kept = append(kept, entry...)
			entry = []string{line}
			continue
		case inBlock:
			entry = append(entry, line)
			if trimmed == profileClose {
				inBlock = false
				settle()
			}
			continue
		case trimmed == profileOpen:
			inBlock = true
			entry = append(entry, line)
			continue
		case trimmed == profileMarker:
			afterMarker = true
			entry = append(entry, line)
			continue
		}
		kept = append(kept, line)
	}
	// An entry still open at the end of the file was never terminated, so its
	// extent is unknown. Keeping it is the only safe reading: treating the rest
	// of the file as ours deletes everything below a fence whose closing line
	// someone removed by hand.
	if inBlock || afterMarker {
		kept = append(kept, entry...)
		entry = nil
	}
	settle()
	return kept, removed
}

func always([]string) bool { return true }

// profileAdditions returns the lines the installer added to a startup file.
func profileAdditions(file string) []string {
	payload, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	_, removed := profileEdit(strings.Split(string(payload), "\n"), always)
	trimmed := make([]string, 0, len(removed))
	for _, line := range removed {
		trimmed = append(trimmed, strings.TrimSpace(line))
	}
	return trimmed
}

// PathLeftBehind is the PATH entry an uninstall cannot remove itself, or "".
//
// install.ps1 writes the install directory into the persisted user PATH, which
// lives in the registry rather than in any file this program edits. Saying
// "open a new terminal to clear it from your PATH" left it there for good.
func PathLeftBehind(paths config.Paths) string {
	if runtime.GOOS != "windows" {
		return ""
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return ""
	}
	directory := filepath.Join(local, "sana-mcp")
	if !strings.Contains(os.Getenv("PATH"), directory) {
		return ""
	}
	return directory
}

// displacedCopies are the older binaries an install moved aside.
func displacedCopies(binary string) []string {
	matches, err := filepath.Glob(binary + ".old-*")
	if err != nil {
		return nil
	}
	return matches
}

// StillOnPath reports a sana-mcp that is still reachable after an uninstall.
//
// It is a warning, not a removal: a binary somewhere this program did not
// install is someone else's to delete. But leaving without saying so is how a
// machine ends up running an old copy that nobody remembers installing.
func StillOnPath(removed []Removal) string {
	gone := map[string]bool{}
	for _, removal := range removed {
		// A deferred file is already named on screen as one the user has to
		// delete. Listing it again as "another sana-mcp" describes one file as
		// two.
		if removal.Err == nil || removal.Deferred {
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

// PathHint returns the line to add to a shell profile when the installed binary
// will not be found by the user's next shell, or "" when it will.
//
// It reads the startup file that shell actually loads, not this process's PATH.
// The installer script exports the directory for its own use before running the
// setup, so anything asking exec.LookPath is answering a question about the
// installer rather than about the user - and the case worth warning about is
// precisely the one where the two differ: the script appends its entry to the
// first startup file that exists, which on a machine with a stray ~/.zshrc is
// not the file a bash user reads.
func PathHint(paths config.Paths) string {
	directory := filepath.Join(paths.Root, "bin")
	if _, err := os.Stat(filepath.Join(directory, binaryName())); err != nil {
		return ""
	}
	if runtime.GOOS == "windows" {
		// install.ps1 writes the persisted user PATH, which a new session
		// reads; there is no startup file to inspect.
		if found, err := exec.LookPath(binaryName()); err == nil {
			if resolved, err := filepath.EvalSymlinks(found); err == nil {
				found = resolved
			}
			if filepath.Dir(found) == directory {
				return ""
			}
		}
		return directory
	}
	for _, file := range loginFiles() {
		if mentionsDirectory(file, directory) {
			return ""
		}
	}
	// $HOME rather than the literal path, and never a tilde: ~ does not expand
	// inside double quotes, so a pasted line would make a directory called "~".
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if rest, found := strings.CutPrefix(directory, home+string(filepath.Separator)); found {
			return `export PATH="$HOME/` + rest + `:$PATH"`
		}
	}
	return `export PATH="` + directory + `:$PATH"`
}

// mentionsDirectory reports a startup file that puts the directory on PATH.
//
// Commented-out lines do not count, the directory has to appear as a whole path
// component rather than as a substring of a longer one, and $HOME and ~ are
// resolved - a line written either of those ways is the normal thing to find in
// a hand-edited profile, and missing it warned people whose PATH plainly
// contained the directory.
func mentionsDirectory(file, directory string) bool {
	payload, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	home, _ := os.UserHomeDir()
	for _, line := range strings.Split(string(payload), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		for _, field := range strings.FieldsFunc(line, func(char rune) bool {
			// Not { or }: ${HOME} has to survive as one field for the
			// expansion below to see it.
			return char == ':' || char == '"' || char == '\'' || char == '=' ||
				char == ' ' || char == '\t'
		}) {
			if pathComponent(field, home) == directory {
				return true
			}
		}
	}
	return false
}

// pathComponent resolves the ways a startup file writes a home-relative path.
func pathComponent(field, home string) string {
	field = strings.TrimRight(field, string(filepath.Separator))
	if home == "" {
		return field
	}
	for _, prefix := range []string{"$HOME", "${HOME}", "~"} {
		if rest, found := strings.CutPrefix(field, prefix); found &&
			(rest == "" || strings.HasPrefix(rest, string(filepath.Separator))) {
			return home + rest
		}
	}
	return field
}

// loginFiles are the startup files the user's own shell reads, most specific
// first. An unrecognised shell falls back to every file the installer writes to,
// which errs towards saying nothing rather than towards a false warning.
func loginFiles() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	switch filepath.Base(os.Getenv("SHELL")) {
	case "zsh":
		// .zshenv and .zprofile are where zsh users are told to set PATH, so a
		// list of only .zshrc warned people whose PATH plainly contained it.
		// No .profile: zsh does not read it, so an entry there is not one this
		// shell will ever see.
		return []string{
			filepath.Join(home, ".zshenv"),
			filepath.Join(home, ".zprofile"),
			filepath.Join(home, ".zshrc"),
		}
	case "bash":
		return []string{
			filepath.Join(home, ".bashrc"),
			filepath.Join(home, ".bash_profile"),
			filepath.Join(home, ".bash_login"),
			filepath.Join(home, ".profile"),
		}
	}
	return profileFiles()
}

// StopDaemons asks every installed sana-mcp to stop its daemon.
//
// Asking each binary rather than killing a pid is what makes this work across
// versions: a daemon started by a previous one keeps its own control files, and
// only that version knows how to shut it down.
//
// The candidates are built here rather than taken from an uninstall plan. The
// plan deliberately leaves out the binary inside the data root, because that
// one is removed along with the root - so a plan-driven stop asked nobody at
// all on a standard install, and the daemon kept polling Sana every fifteen
// minutes after the user was told everything had been removed.
func StopDaemons(ctx context.Context, paths config.Paths, self string) []string {
	candidates := append(installDirectories(paths), "")
	seen := map[string]bool{}
	var stopped []string

	for _, directory := range candidates {
		path := self
		if directory != "" {
			path = filepath.Join(directory, binaryName())
		}
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			continue
		}
		timed, cancel := context.WithTimeout(ctx, 10*time.Second)
		output, err := exec.CommandContext(timed, path, "daemon", "--stop").Output()
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
		// The Windows installer renames the running executable aside before
		// putting the new one in place, because a running image cannot be
		// deleted. Those displaced copies sit next to the binary and would
		// otherwise survive an uninstall that reported success.
		for _, displaced := range displacedCopies(leftover.Path) {
			os.Remove(displaced)
		}
		err := os.Remove(leftover.Path)
		if err != nil && leftover.Self && runtime.GOOS == "windows" {
			// Windows will not unlink a running image, and nothing here runs
			// after this process exits to finish the job. Marking it as
			// remaining is the honest answer; claiming it would be gone left a
			// working copy behind under a message saying it had been removed.
			return Removal{Leftover: leftover, Deferred: true, Err: err}
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

// stripProfile removes everything this program added to a startup file.
func stripProfile(file string) error { return rewriteProfile(file, always) }

// rewriteProfile applies one edit, writing only when something changed.
func rewriteProfile(file string, drop func(entry []string) bool) error {
	payload, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	kept, removed := profileEdit(strings.Split(string(payload), "\n"), drop)
	if len(removed) == 0 {
		return nil
	}
	info, err := os.Stat(file)
	mode := os.FileMode(0o600)
	if err == nil {
		mode = info.Mode().Perm()
	}
	return os.WriteFile(file, []byte(strings.Join(kept, "\n")), mode)
}

// Superseded is what an older install of this program left behind that this one
// replaces: copies of the binary in the other directories the shipped
// installers have used.
//
// An install that ignores these looks like it did nothing. The older copy stays
// earlier on PATH, so typing the command still runs the version that was just
// replaced - which is exactly what happened to the first person to upgrade.
//
// Only binaries. The stale PATH entry that points at the directory it lived in
// is left alone: an entry naming a directory that no longer holds the program
// does nothing, while removing it can take the command off PATH altogether -
// the installer script appends its own entry to the first startup file that
// exists, which is not necessarily the one the user's shell reads.
func Superseded(paths config.Paths, self string) Plan {
	current := filepath.Join(paths.Root, "bin")
	var plan Plan

	resolvedSelf := self
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		resolvedSelf = resolved
	}
	for _, directory := range installDirectories(paths) {
		if directory == "" || directory == current {
			continue
		}
		path := filepath.Join(directory, binaryName())
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved == resolvedSelf {
			continue
		}
		plan.Leftovers = append(plan.Leftovers, Leftover{Kind: "binary", Path: path})
	}
	return plan
}

// RemoveSuperseded takes out what Superseded found.
func RemoveSuperseded(plan Plan) []Removal {
	removals := make([]Removal, 0, len(plan.Leftovers))
	for _, leftover := range plan.Leftovers {
		removals = append(removals, remove(leftover))
	}
	return removals
}
