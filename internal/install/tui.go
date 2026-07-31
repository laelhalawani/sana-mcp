package install

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/daemon"
	"github.com/laelhalawani/sana-mcp/internal/localstate"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/statusview"
	"github.com/laelhalawani/sana-mcp/internal/tui"
	detectharness "github.com/sairaph/detect-harness"
)

// The installer prints as it goes rather than owning the screen.
//
// Everything it settles - a client registered, a client that could not be, a
// code emailed - stays in scrollback, so the run reads afterwards as a record
// of what happened. Only the two screens that are genuinely live take over a
// region: the client wizard, and the sync progress at the end.

// describeApply says what happened to one client, in the words a person would
// use for it.
func describeApply(result detectharness.Result) string {
	switch result.State {
	case detectharness.Applied:
		return "registered"
	case detectharness.ApplyNoop:
		return "already registered (no change)"
	case detectharness.ApplyConflict:
		return "conflict: " + result.Reason
	case detectharness.ApplySkipped:
		return "skipped: " + result.Reason
	default:
		return "failed: " + result.Reason
	}
}

// describeRemove is the same for a removal, where "nothing to do" means
// something different.
func describeRemove(result detectharness.Result) string {
	switch result.State {
	case detectharness.Applied:
		return "removed"
	case detectharness.ApplyNoop:
		return "not registered (nothing to remove)"
	default:
		return describeApply(result)
	}
}

// applyState maps a result onto the glyph vocabulary. A conflict or a failure
// needs a person to act, so both are failures here; a skip is not.
func applyState(result detectharness.Result) tui.ApplyState {
	switch result.State {
	case detectharness.Applied:
		return tui.ApplyOK
	case detectharness.ApplyNoop:
		return tui.ApplyNoop
	case detectharness.ApplyConflict, detectharness.ApplyFailed:
		return tui.ApplyFailed
	default:
		return tui.ApplySkipped
	}
}

// needsManualAction reports a result the user has to do something about.
func needsManualAction(result detectharness.Result) bool {
	return result.State == detectharness.ApplyConflict || result.State == detectharness.ApplyFailed
}

// printApplyResult writes one settled client row.
func printApplyResult(terminal tui.Terminal, harness Harness, result detectharness.Result, enabling bool) {
	description := describeRemove(result)
	if enabling {
		description = describeApply(result)
	}
	hint := ""
	if result.State == detectharness.Applied && enabling {
		hint = harness.ReloadHint
	}
	terminal.Print(terminal.UI.Row(
		terminal.UI.StatusGlyph(applyState(result), enabling),
		harness.Name, description, hint,
	))
}

// setup is one run of the installer.
type setup struct {
	ctx       context.Context
	runtime   *bootstrap.Runtime
	terminal  tui.Terminal
	installer *Installer
}

// Run executes configure, install, or uninstall.
func Run(ctx context.Context, runtime *bootstrap.Runtime, command cli.Command, options cli.Options) int {
	terminal := openTerminal(options)

	installer, err := NewInstaller(runtime)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	flow := &setup{ctx: ctx, runtime: runtime, terminal: terminal, installer: installer}

	if command.Name == "uninstall" {
		return flow.uninstall()
	}
	return flow.install()
}

// openTerminal resolves the streams the prompts need. The CLI passes writers so
// tests can capture them, but an interactive prompt needs the files themselves.
func openTerminal(options cli.Options) tui.Terminal {
	in, out := os.Stdin, os.Stdout
	if file, ok := options.Stdin.(*os.File); ok {
		in = file
	}
	if file, ok := options.Stdout.(*os.File); ok {
		out = file
	}
	return tui.Open(in, out)
}

func (s *setup) install() int {
	ui := s.terminal.UI

	// Anything a previous run left half-done is undone before this one looks at
	// the state, so what it reports is what is actually there.
	if err := localstate.Recover(s.runtime.Paths); err != nil {
		s.terminal.Print(ui.Red("Previous setup could not be tidied up: "), err.Error())
		return 1
	}

	reset, code := s.replaceIncompatibleState()
	if code != 0 {
		return code
	}

	failed := func(code int) int {
		if reset != nil {
			if err := reset.Rollback(); err != nil {
				s.terminal.Print(ui.Red("The previous local state could not be restored: "), err.Error())
			}
		}
		return code
	}

	harnesses := s.installer.Detect(s.ctx)
	rows := make([]tui.WizardRow, 0, len(harnesses))
	byID := make(map[string]Harness, len(harnesses))
	for _, harness := range harnesses {
		if !harness.Selectable() {
			// A client that is here but cannot be configured is reported: the
			// user has it, and needs to know it was left out.
			//
			// A client that is not here is not mentioned at all. Claude Desktop
			// has no Linux configuration, and announcing that as a failure on
			// every Linux install is a screenful of red about software the user
			// never installed.
			if harness.State == detectharness.Detected {
				s.terminal.Print(ui.Row(
					ui.StatusGlyph(tui.ApplyFailed, true),
					harness.Name,
					"configuration unavailable: "+harness.ConfigError,
					"",
				))
			}
			continue
		}
		byID[string(harness.ID)] = harness
		rows = append(rows, tui.WizardRow{
			ID:   string(harness.ID),
			Name: harness.Name,
			// An existing registration stays visible even when the client
			// itself was not detected, so it can be disconnected without
			// revealing every hidden row.
			Detected: harness.State == detectharness.Detected || harness.Configured,
			Current:  harness.Configured,
		})
	}

	if !s.terminal.Policy.Interactive {
		s.terminal.Print("An interactive terminal is required to choose clients.")
		return failed(1)
	}

	selection, err := s.terminal.Wizard(s.ctx, "Configure sana-mcp for your AI clients", rows)
	if err != nil {
		s.terminal.Print(ui.Red("Client selection failed: "), err.Error())
		return failed(1)
	}
	if !selection.Submitted {
		s.terminal.Blank()
		s.terminal.Print("Cancelled; no changes were made.")
		return failed(1)
	}

	results, connected := s.apply(rows, byID, selection)
	incomplete := false
	for _, result := range results {
		if !needsManualAction(result) {
			continue
		}
		id := string(result.HarnessID)
		printApplyResult(s.terminal, byID[id], result, selection.Desired[id])
		incomplete = true
	}
	if incomplete {
		s.terminal.Blank()
		s.terminal.Print(ui.Red("Configuration is incomplete."),
			" Review the client details above before trying again.")
		return failed(1)
	}

	signedIn := s.signIn()
	if err := s.showSummary(connected, signedIn, reloadHints(byID, results)); err != nil {
		s.terminal.Print(ui.Red("Setup finished, but its final screen failed: "), err.Error())
	}
	if reset != nil {
		if err := reset.Commit(); err != nil {
			s.terminal.Print(ui.Yellow("The replaced local state could not be deleted: "), err.Error())
		}
	}
	return 0
}

// replaceIncompatibleState checks the local state before anything is written,
// and replaces it only with the user's agreement.
//
// This runs first for one reason: an installer that registers clients and then
// discovers it cannot read the local database has already changed the machine
// in exchange for nothing.
func (s *setup) replaceIncompatibleState() (*localstate.Reset, int) {
	ui := s.terminal.UI
	report := localstate.Inspect(s.runtime.Paths)
	if !report.Incompatible() {
		return nil, 0
	}

	s.terminal.Blank()
	s.terminal.Print(ui.Yellow("This version cannot use the Sana data already on this machine."))
	s.terminal.Print("  ", ui.Dim(report.Reason))
	s.terminal.Blank()
	s.terminal.Print("Continuing replaces it: your meetings and transcripts will be downloaded")
	s.terminal.Print("again, and you may have to sign in to Sana again. Nothing is deleted until")
	s.terminal.Print("the new setup succeeds.")
	if len(report.Foreign) > 0 {
		s.terminal.Print("  ", ui.Dim("also left behind: "+strings.Join(report.Foreign, ", ")))
	}
	s.terminal.Blank()

	if !s.terminal.Policy.Interactive {
		s.terminal.Print("Run sana-mcp install in a terminal to confirm this, or remove ",
			report.Root, " yourself.")
		return nil, 1
	}
	agreed, err := s.terminal.Confirm(s.ctx, "Replace it and continue?", false)
	if err != nil || !agreed {
		s.terminal.Blank()
		s.terminal.Print("Cancelled; no changes were made.")
		return nil, 1
	}

	// Whatever version wrote that state may still be syncing into it. Asking
	// each installed binary to stop its own daemon is the only way to reach a
	// daemon this build did not start; renaming the database out from under a
	// live writer is how a half-written file gets left behind.
	self, _ := os.Executable()
	for _, line := range localstate.StopDaemons(s.ctx, localstate.PlanUninstall(s.runtime.Paths, self)) {
		s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, false), "Background sync", line, ""))
	}

	reset, err := localstate.Begin(s.runtime.Paths)
	if err != nil {
		s.terminal.Print(ui.Red("The old data could not be moved aside: "), err.Error())
		return nil, 1
	}
	s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, true),
		"Previous Sana data", "moved aside", ""))
	return reset, 0
}

// apply writes the chosen registrations and reports how many clients ended up
// connected.
func (s *setup) apply(
	rows []tui.WizardRow,
	byID map[string]Harness,
	selection tui.WizardResult,
) ([]detectharness.Result, int) {
	var present, absent []detectharness.ID
	connected := 0
	for _, row := range rows {
		harness := byID[row.ID]
		if selection.Desired[row.ID] {
			connected++
			present = append(present, harness.ID)
			continue
		}
		if row.Current {
			absent = append(absent, harness.ID)
		}
	}
	results := s.installer.Apply(s.ctx, present, detectharness.Present)
	results = append(results, s.installer.Apply(s.ctx, absent, detectharness.Absent)...)
	return results, connected
}

// reloadHints is the advice for the clients that were actually registered.
func reloadHints(byID map[string]Harness, results []detectharness.Result) []string {
	var hints []string
	seen := map[string]bool{}
	for _, result := range results {
		if result.Desired != detectharness.Present || result.State != detectharness.Applied {
			continue
		}
		hint := byID[string(result.HarnessID)].ReloadHint
		if hint == "" || seen[hint] {
			continue
		}
		seen[hint] = true
		hints = append(hints, hint)
	}
	return hints
}

// signIn offers to sign in to Sana, and reports whether the user ended up
// signed in. Declining is a normal outcome, not a failure.
func (s *setup) signIn() bool {
	ui := s.terminal.UI

	if session, err := sana.LoadSession(s.runtime.Paths.Session); err == nil && session.SignedIn() {
		return true
	}
	wanted, err := s.terminal.Confirm(s.ctx, "Sign in to Sana now?", true)
	if err != nil || !wanted {
		return false
	}
	email, err := s.terminal.Input(s.ctx, "Email for your Sana account:")
	if err != nil || email == "" {
		return false
	}

	client := sana.New("", nil)
	pending, err := client.RequestSignInCode(s.ctx, email)
	if err != nil {
		s.terminal.Blank()
		s.terminal.Print(ui.Red("Sana sign-in is unavailable: "), err.Error())
		return false
	}
	s.terminal.Print("We emailed a 6-digit sign-in code to ", email, ".")

	code, err := s.terminal.Input(s.ctx, "Enter the 6-digit code:")
	if err != nil {
		return false
	}
	user, err := client.SubmitSignInCode(s.ctx, pending, code)
	if err != nil {
		s.terminal.Blank()
		s.terminal.Print(ui.Red("Sana sign-in did not complete: "), err.Error())
		return false
	}
	if err := sana.SaveSession(s.runtime.Paths.Session, sana.SessionFrom(client, user)); err != nil {
		s.terminal.Blank()
		s.terminal.Print(ui.Red("Signed in, but the session could not be saved: "), err.Error())
		return false
	}
	return true
}

// showSummary ends the run. When there is a session and a terminal it watches
// the first sync live; otherwise it prints what it knows and stops.
func (s *setup) showSummary(connected int, signedIn bool, hints []string) error {
	ui := s.terminal.UI

	if !signedIn || !s.terminal.Policy.Interactive {
		info := statusview.Read(s.runtime.Paths)
		s.terminal.Blank()
		s.terminal.Print(ui.Bold("sana-mcp setup"))
		s.terminal.Print("AI clients  ", fmt.Sprint(connected), " connected")
		account := "not signed in"
		if signedIn {
			account = "signed in"
		}
		s.terminal.Print("Sana account  ", account)
		sync := "continuing in background"
		if info.Status.Complete() {
			sync = "complete"
		}
		s.terminal.Print("Meeting sync  ", sync)
		if len(hints) > 0 {
			s.terminal.Print("Reload  ", strings.Join(hints, "; "))
		}
		s.terminal.Print("Next: sana-mcp")
		return nil
	}

	// The daemon does the syncing and the screen watches it.
	//
	// Running a sync cycle here instead blocked for as long as it took, with
	// nothing on screen: the progress view cannot report on work that is
	// happening between it and the terminal.
	daemon.EnsureRunning(s.runtime)

	var final statusview.Info
	read := func() statusview.Info {
		final = statusview.Read(s.runtime.Paths)
		return final
	}
	if _, err := statusview.Run(s.ctx, s.terminal, statusview.ModeSetup, read,
		&statusview.Setup{ConnectedClients: connected, SignedIn: signedIn}); err != nil {
		return err
	}

	s.terminal.Blank()
	if final.Status.Complete() {
		s.terminal.Print(ui.Green("Meeting sync complete."))
	} else {
		s.terminal.Print("Meeting sync continues in the background.")
	}
	if len(hints) > 0 {
		s.terminal.Print("Reload  ", strings.Join(hints, "; "))
	}
	s.terminal.Print("Run: sana-mcp")
	return nil
}

// uninstall removes sana-mcp from this machine: the client registrations, the
// local data, every copy of the binary the installers have shipped, and the
// PATH line they added.
//
// It is one command because a partial uninstall is what leaves a machine with
// an old binary first on PATH quietly serving a client that was never
// unregistered.
func (s *setup) uninstall() int {
	ui := s.terminal.UI

	var registered []detectharness.ID
	var names []string
	for _, harness := range s.installer.Detect(s.ctx) {
		if harness.Configured {
			registered = append(registered, harness.ID)
			names = append(names, harness.Name)
		}
	}

	self, err := os.Executable()
	if err != nil {
		self = ""
	}
	plan := localstate.PlanUninstall(s.runtime.Paths, self)

	if len(registered) == 0 && plan.Empty() {
		s.terminal.Print("sana-mcp is not installed on this machine.")
		return 0
	}

	s.terminal.Blank()
	s.terminal.Print(ui.Bold("Uninstall sana-mcp"))
	if len(names) > 0 {
		s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, false),
			"AI clients", strings.Join(names, ", "), "will be unregistered"))
	}
	for _, leftover := range plan.Leftovers {
		s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, false),
			leftover.Path, leftover.Detail, ""))
	}
	s.terminal.Blank()

	if s.terminal.Policy.Interactive {
		agreed, err := s.terminal.Confirm(s.ctx, "Remove all of this?", false)
		if err != nil || !agreed {
			s.terminal.Print("Cancelled; nothing was removed.")
			return 1
		}
	}

	for _, line := range localstate.StopDaemons(s.ctx, plan) {
		s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, false), "Background sync", line, ""))
	}

	failures := 0
	for _, result := range s.installer.Apply(s.ctx, registered, detectharness.Absent) {
		printApplyResult(s.terminal, Harness{Name: result.Name}, result, false)
		if needsManualAction(result) {
			failures++
		}
	}
	removals := plan.Apply()
	for _, removal := range removals {
		switch {
		case removal.Err != nil:
			failures++
			s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyFailed, false),
				removal.Leftover.Path, removal.Err.Error(), ""))
		case removal.Deferred:
			s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyNoop, false),
				removal.Leftover.Path, "will be gone once this program exits", ""))
		default:
			s.terminal.Print(ui.Row(ui.StatusGlyph(tui.ApplyOK, false),
				removal.Leftover.Path, "removed", ""))
		}
	}

	s.terminal.Blank()
	if failures > 0 {
		s.terminal.Print(ui.Red("Uninstall is incomplete."), " Review the details above.")
		return 1
	}
	if remaining := localstate.StillOnPath(removals); remaining != "" {
		s.terminal.Print(ui.Yellow("Another sana-mcp is still on your PATH: "), remaining)
		s.terminal.Print("It was not installed by sana-mcp, so it was left alone. Remove it yourself if you want it gone.")
	}
	s.terminal.Print("sana-mcp has been removed. Open a new terminal to clear it from your PATH.")
	return 0
}
