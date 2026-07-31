package install

import (
	"context"
	"fmt"
	"os"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/localstate"
	detectharness "github.com/sairaph/detect-harness"
	"golang.org/x/term"
)

// Without a terminal there is nobody to answer a question, so this path asks
// none and prints plain indented lines.
//
// It exists because piping the installer through a shell is the normal install
// route, and a container, a CI job or a harness invoking `sana-mcp configure`
// all arrive here. Starting a full-screen program with no controllable input
// leaves it drawing frames at a pipe until something kills it.

// interactive reports whether both ends are a terminal.
func interactive(options cli.Options) bool {
	stdin, ok := options.Stdin.(*os.File)
	if !ok {
		return false
	}
	stdout, ok := options.Stdout.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(stdin.Fd())) && term.IsTerminal(int(stdout.Fd()))
}

// runUnattended registers every detected client, or removes every registration.
func runUnattended(
	ctx context.Context,
	runtime *bootstrap.Runtime,
	installer *Installer,
	options cli.Options,
	remove bool,
) int {
	// A blank line first: this output follows the install script's progress
	// bar, and the two should not run together.
	fmt.Fprintln(options.Stdout)

	// A replacement a previous run never finished is undone first, exactly as
	// the interactive path does it, or the data stays hidden in a sibling
	// directory while the fresh root reports itself perfectly usable.
	//
	// A failure stops an install, which is about to write to that state, but
	// never an uninstall: refusing to remove anything, with a message asking
	// the user to preserve the very data they asked to delete, is not an
	// answer to the question they put.
	if err := localstate.Recover(runtime.Paths); err != nil {
		fmt.Fprintln(options.Stderr, "  sana-mcp:", err)
		if !remove {
			return 1
		}
	}
	if !remove {
		// Local state that cannot be read is not replaced without being asked,
		// and there is nobody to ask. Saying so is the whole of what this can
		// do; the alternative is deleting a person's meetings unattended.
		if report := localstate.Inspect(runtime.Paths); report.Incompatible() {
			fmt.Fprintln(options.Stdout, "  Existing Sana data cannot be read by this version.")
			fmt.Fprintln(options.Stdout, "  Run `sana-mcp configure` in a terminal to replace it.")
			return 1
		}
	}

	var ids []detectharness.ID
	byID := map[detectharness.ID]Harness{}
	for _, harness := range installer.Detect(ctx) {
		byID[harness.ID] = harness
		switch {
		case remove && harness.Configured:
			ids = append(ids, harness.ID)
		case !remove && harness.Selectable() && harness.State == detectharness.Detected:
			// Registering with a client that is not installed writes a config
			// file for software the user does not have.
			ids = append(ids, harness.ID)
		}
	}

	desired := detectharness.Present
	if remove {
		desired = detectharness.Absent
	}
	results := installer.Apply(ctx, ids, desired)

	if len(results) == 0 {
		if remove {
			fmt.Fprintln(options.Stdout, "  sana-mcp was not registered with any client.")
		} else {
			fmt.Fprintln(options.Stdout,
				"  No AI clients were detected. Install one, then run `sana-mcp configure`.")
		}
	}

	failures := 0
	changed := false
	for _, result := range results {
		fmt.Fprintf(options.Stdout, "  %-22s %s\n", result.Name, summarise(result, !remove))
		if result.State == detectharness.ApplyFailed || result.State == detectharness.ApplyConflict {
			failures++
		}
		if result.State == detectharness.Applied {
			changed = true
		}
	}
	if changed && !remove {
		fmt.Fprintln(options.Stdout, "\n  Restart the affected clients so they pick up the change:")
		for _, result := range results {
			hint := byID[result.HarnessID].ReloadHint
			if result.State == detectharness.Applied && hint != "" {
				fmt.Fprintf(options.Stdout, "  %-22s %s\n", result.Name, hint)
			}
		}
	}

	self, _ := os.Executable()
	if !remove {
		// The same superseded copies the interactive path clears. Without this
		// an unattended upgrade leaves the older binary first on PATH, which is
		// the whole failure the mechanism exists to prevent.
		for _, removal := range localstate.RemoveSuperseded(
			localstate.Superseded(runtime.Paths, self)) {
			if removal.Err != nil {
				fmt.Fprintf(options.Stderr, "  %s: %v\n", removal.Leftover.Path, removal.Err)
				continue
			}
			fmt.Fprintf(options.Stdout, "  %-22s %s\n", "older version", removal.Leftover.Path)
		}
	}
	if remove {
		localstate.StopDaemons(ctx, runtime.Paths, self)
		for _, removal := range localstate.PlanUninstall(runtime.Paths, self).Apply() {
			switch {
			case removal.Deferred:
				// Windows cannot unlink a running image, and nothing runs after
				// this process to finish it. Not a failure; a thing to do.
				fmt.Fprintf(options.Stdout, "  %-22s %s\n",
					"still running, delete", removal.Leftover.Path)
			case removal.Err != nil:
				failures++
				fmt.Fprintf(options.Stderr, "  %s: %v\n", removal.Leftover.Path, removal.Err)
			default:
				fmt.Fprintf(options.Stdout, "  %-22s %s\n", "removed", removal.Leftover.Path)
			}
		}
	}
	if failures > 0 {
		return 1
	}
	return 0
}
