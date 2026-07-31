package install

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/daemon"
	"github.com/laelhalawani/sana-mcp/internal/localstate"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/statusview"
	detectharness "github.com/sairaph/detect-harness"
)

// The installer is one program whose screen evolves in place, in the shape
// interactive-terminal-mcp uses: a bold header, one section line, the content,
// and a footer. Printing each step instead appends a new block per question and
// leaves the finished ones stranded above the current one.
var (
	styleTitle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("81"))
	styleDim    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	styleCursor = lipgloss.NewStyle().Foreground(lipgloss.Color("81"))
	styleOn     = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	styleOff    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	styleError  = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	styleHint   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	styleFooter = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
)

// step is one screen of the installer.
type step int

const (
	// stepDetecting is first because probing every client walks the filesystem
	// and takes a visible moment. Without a screen for it the installer prints
	// its download bar and then shows nothing at all.
	stepDetecting step = iota
	stepReplace
	stepHarnesses
	stepApplying
	stepSignIn
	stepEmail
	stepCode
	stepSyncing
	stepDone
	// stepPlan and stepRemoving belong to uninstall, which is the same program
	// with a different first screen.
	stepPlan
	stepRemoving
)

// header matches the installer script's own output: a leading blank line and a
// two-space indent, so the download and the setup read as one thing rather than
// two programs taking turns.
func header() string {
	return "\n" + styleTitle.Render("  sana-mcp setup")
}

func uninstallHeader() string {
	return "\n" + styleTitle.Render("  sana-mcp uninstall")
}

type model struct {
	ctx       context.Context
	runtime   *bootstrap.Runtime
	installer *Installer

	step  step
	frame int

	// local state
	report localstate.Report
	reset  *localstate.Reset

	// clients
	harnesses []Harness
	selected  map[detectharness.ID]bool
	cursor    int
	showAll   bool
	results   []detectharness.Result

	// choices, used by every yes/no screen
	choice int

	// sign-in
	signedIn bool
	email    string
	pending  sana.PendingSignIn
	input    string

	// sync
	status statusview.Info

	// settled marks the point of no return: client configuration written, the
	// replacement accepted. Nothing after it may be described as a run that
	// changed nothing, however few clients happened to be involved.
	settled bool
	// warning is something that went wrong but did not stop the setup.
	warning string
	// self is this executable, resolved once so every step names the same file.
	self string
	// unreachable is the PATH line to add when the installed command will not
	// resolve. The script appends its entry to the first startup file that
	// exists, which is not necessarily the one this shell reads.
	unreachable string

	// what this install replaced, and what an uninstall removes
	superseded []localstate.Removal
	plan       localstate.Plan
	registered []detectharness.ID
	removals   []localstate.Removal
	stopped    []string

	message string
	failure string
	cancel  bool
}

type detectedMsg []Harness
type appliedMsg []detectharness.Result
type spinMsg struct{}
type statusMsg statusview.Info
type signInRequestedMsg struct {
	pending sana.PendingSignIn
	err     error
}
type signedInMsg struct {
	email string
	err   error
}
type removedMsg struct {
	stopped  []string
	results  []detectharness.Result
	removals []localstate.Removal
}

// spinFrames are deliberately plain. The installer is the first thing a person
// sees, sometimes in a console whose font has no braille glyphs, and a row of
// replacement boxes is a worse first impression than a character that draws.
var spinFrames = []string{"-", "\\", "|", "/"}

func (m *model) spinner() string { return spinFrames[m.frame%len(spinFrames)] }

// spinning is every step whose view draws a spinner.
func (m *model) spinning() bool {
	switch m.step {
	case stepDetecting, stepApplying, stepRemoving, stepSyncing:
		return true
	}
	return false
}

func spin() tea.Cmd {
	return tea.Tick(110*time.Millisecond, func(time.Time) tea.Msg { return spinMsg{} })
}

func poll() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return statusMsg{} })
}

func (m *model) Init() tea.Cmd {
	if m.step == stepPlan {
		return nil
	}
	return tea.Batch(spin(), m.detect())
}

func (m *model) detect() tea.Cmd {
	return func() tea.Msg { return detectedMsg(m.installer.Detect(m.ctx)) }
}

func (m *model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch message := message.(type) {
	case spinMsg:
		// Every step that draws a spinner has to keep asking for frames, or it
		// renders one frozen character that reads as a stall.
		if !m.spinning() {
			return m, nil
		}
		m.frame++
		return m, spin()

	case detectedMsg:
		m.adopt(message)
		return m, nil

	case appliedMsg:
		m.results = message
		// Client configuration has been written, so the replacement is the
		// state this machine is keeping. Accepting it here rather than when the
		// program exits is what makes that a single point of no return: closing
		// the window on the summary used to roll the whole finished setup back
		// and report that nothing had changed.
		m.settled = true
		if m.reset != nil {
			if err := m.reset.Commit(); err != nil {
				// Not fatal - the new state is in place and in use - but a full
				// copy of the old data is still on disk, so it is named rather
				// than dropped.
				m.warning = "The replaced data is still at " +
					m.reset.Quarantine() + ": " + err.Error()
			}
			m.reset = nil
		}
		// The copies this install replaces go now, while the machine is being
		// changed anyway. Leaving them means the older one stays ahead on PATH
		// and the command still runs the version just replaced.
		if superseded := localstate.Superseded(m.runtime.Paths, m.self); !superseded.Empty() {
			m.superseded = localstate.RemoveSuperseded(superseded)
		}
		// Having just deleted the copy that may have been the reachable one,
		// check that this one is.
		m.unreachable = localstate.PathHint(m.runtime.Paths)
		if m.signedIn {
			return m.startSync()
		}
		m.step, m.choice, m.message = stepSignIn, 0, ""
		return m, nil

	case signInRequestedMsg:
		if message.err != nil {
			// A bad address or an unreachable Sana is recoverable: it belongs
			// on the screen the user is on, not in the fatal-error path that
			// rolls the whole setup back.
			m.message = message.err.Error()
			m.step, m.input = stepEmail, ""
			return m, nil
		}
		m.pending, m.message, m.input = message.pending, "", ""
		m.step = stepCode
		return m, nil

	case signedInMsg:
		if message.err != nil {
			m.message, m.input = message.err.Error(), ""
			m.step = stepCode
			return m, nil
		}
		m.signedIn, m.email, m.message = true, message.email, ""
		return m.startSync()

	case statusMsg:
		m.status = statusview.Read(m.runtime.Paths)
		if m.status.Status.Complete() {
			m.step = stepDone
			return m, nil
		}
		if m.step == stepSyncing {
			return m, poll()
		}
		return m, nil

	case removedMsg:
		m.settled = true
		m.stopped, m.results, m.removals = message.stopped, message.results, message.removals
		m.step = stepDone
		return m, nil

	case tea.KeyMsg:
		return m.key(message)
	}
	return m, nil
}

func (m *model) key(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Applying and removing take no keys at all, ctrl+c included. Both are a
	// few seconds of file writes, and interrupting one leaves half the clients
	// registered or half the data removed, under a message saying nothing
	// happened.
	if m.step == stepApplying || m.step == stepRemoving {
		return m, nil
	}
	if key.String() == "ctrl+c" {
		m.cancel = true
		return m, tea.Quit
	}
	switch m.step {
	case stepDetecting:
		// Nothing has been written yet, so leaving is free. Applying and
		// removing deliberately take no keys at all: quitting mid-write
		// abandons half-written client configuration and reports that nothing
		// was changed.
		if name := key.String(); name == "q" || name == "esc" {
			m.cancel = true
			return m, tea.Quit
		}
	case stepReplace:
		return m.chooseKey(key, 2, m.confirmReplace)
	case stepHarnesses:
		return m.harnessKey(key)
	case stepSignIn:
		return m.chooseKey(key, 2, m.confirmSignIn)
	case stepEmail, stepCode:
		return m.inputKey(key)
	case stepPlan:
		return m.chooseKey(key, 2, m.confirmUninstall)
	case stepSyncing:
		switch key.String() {
		case "enter", "esc", "q":
			// Leaving the progress view does not stop the sync; the summary
			// says so.
			m.step = stepDone
		}
	case stepDone:
		switch key.String() {
		case "enter", "esc", "q":
			return m, tea.Quit
		}
	}
	return m, nil
}

// chooseKey drives a two-option list. confirm is called with the chosen index.
func (m *model) chooseKey(key tea.KeyMsg, options int, confirm func(int) tea.Cmd) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "up", "k":
		m.choice = (m.choice - 1 + options) % options
	case "down", "j":
		m.choice = (m.choice + 1) % options
	case "enter":
		return m, confirm(m.choice)
	case "esc", "q":
		return m, confirm(options - 1)
	}
	return m, nil
}

func (m *model) inputKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.Type {
	case tea.KeyEnter:
		value := strings.TrimSpace(m.input)
		if value == "" {
			return m, nil
		}
		if m.step == stepEmail {
			m.email, m.input = value, ""
			return m, m.requestCode(value)
		}
		m.input = ""
		return m, m.submitCode(value)
	case tea.KeyEsc:
		m.step = stepDone
	case tea.KeyBackspace:
		if runes := []rune(m.input); len(runes) > 0 {
			m.input = string(runes[:len(runes)-1])
		}
	case tea.KeyRunes, tea.KeySpace:
		m.input += string(key.Runes)
	}
	return m, nil
}

func (m *model) harnessKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "up", "k":
		m.moveCursor(-1)
	case "down", "j":
		m.moveCursor(1)
	case "v":
		m.showAll = !m.showAll
		if !m.onVisibleRow() || !m.harnesses[m.cursor].Selectable() {
			m.cursor = m.firstSelectable()
		}
	case " ":
		m.toggle()
	case "a":
		m.toggleAll()
	case "enter":
		m.step = stepApplying
		return m, tea.Batch(spin(), m.apply())
	case "esc", "q":
		m.cancel = true
		return m, tea.Quit
	}
	return m, nil
}

// adopt takes the detection result and sets up the selection it implies. The
// incompatible-state question comes first when there is one: registering
// clients and then finding the local data unreadable changes the machine in
// exchange for nothing.
func (m *model) adopt(harnesses []Harness) {
	m.harnesses = harnesses
	m.selected = map[detectharness.ID]bool{}
	for _, harness := range harnesses {
		m.selected[harness.ID] = harness.Configured ||
			(harness.State == detectharness.Detected && harness.Selectable())
	}
	m.cursor = m.firstSelectable()
	if m.report.Incompatible() {
		m.step, m.choice = stepReplace, 1
		return
	}
	m.step = stepHarnesses
}

func (m *model) confirmReplace(choice int) tea.Cmd {
	if choice != 0 {
		m.cancel = true
		return tea.Quit
	}
	// Whatever wrote that state may still be writing to it. Each installed
	// binary is asked to stop its own daemon: one started by another version
	// answers only to that version.
	localstate.StopDaemons(m.ctx, m.runtime.Paths, m.self)

	reset, err := localstate.Begin(m.runtime.Paths)
	if err != nil {
		m.failure = err.Error()
		return tea.Quit
	}
	m.reset = reset
	m.refreshSession()
	m.step = stepHarnesses
	return nil
}

func (m *model) confirmSignIn(choice int) tea.Cmd {
	if choice != 0 {
		m.step = stepDone
		return nil
	}
	m.step, m.input, m.message = stepEmail, "", ""
	return nil
}

func (m *model) startSync() (tea.Model, tea.Cmd) {
	daemon.EnsureRunning(m.runtime)
	m.step = stepSyncing
	m.status = statusview.Read(m.runtime.Paths)
	return m, tea.Batch(spin(), poll())
}

// refreshSession re-reads what is on disk. Replacing the local state moves the
// stored sign-in aside, so the value read before any of this started is stale -
// and believing it left the installer waiting for a sync that could never run,
// with no sign-in offered.
func (m *model) refreshSession() {
	session, _ := sana.LoadSession(m.runtime.Paths.Session)
	m.signedIn = session.SignedIn()
	if m.signedIn {
		m.email = session.Address()
	}
}

func (m *model) apply() tea.Cmd {
	return func() tea.Msg {
		var present, absent []detectharness.ID
		for _, harness := range m.harnesses {
			if !harness.Selectable() {
				continue
			}
			if m.selected[harness.ID] {
				present = append(present, harness.ID)
			} else if harness.Configured {
				absent = append(absent, harness.ID)
			}
		}
		results := m.installer.Apply(m.ctx, present, detectharness.Present)
		return appliedMsg(append(results, m.installer.Apply(m.ctx, absent, detectharness.Absent)...))
	}
}

func (m *model) requestCode(email string) tea.Cmd {
	return func() tea.Msg {
		client := sana.New("", nil)
		pending, err := client.RequestSignInCode(m.ctx, email)
		return signInRequestedMsg{pending: pending, err: err}
	}
}

func (m *model) submitCode(code string) tea.Cmd {
	pending, paths := m.pending, m.runtime.Paths
	return func() tea.Msg {
		client := sana.New("", nil)
		user, err := client.SubmitSignInCode(m.ctx, pending, code)
		if err != nil {
			return signedInMsg{err: err}
		}
		if err := sana.SaveSession(paths.Session, sana.SessionFrom(client, user)); err != nil {
			return signedInMsg{err: err}
		}
		return signedInMsg{email: user.Email}
	}
}

// --- selection helpers ------------------------------------------------------

// visible is which harnesses earn a line: the ones that are here, the ones
// already registered, and anything currently selected. A list of thirteen
// clients, eleven of them "not detected", tells the user nothing they asked
// for.
//
// Selected rows stay on screen even after v hides their group. Letting them
// disappear meant a client revealed with v, selected, and then hidden again was
// still registered - a config file written for software the user could no
// longer see chosen, and could not unpick.
func (m *model) visible() []int {
	var indices []int
	for index, harness := range m.harnesses {
		if harness.State == detectharness.Detected || harness.Configured ||
			m.showAll || m.selected[harness.ID] {
			indices = append(indices, index)
		}
	}
	return indices
}

// firstSelectable is where the cursor opens.
//
// It has to be a row the cursor is actually drawn on: the pointer is only
// rendered for a selectable harness, so starting on an unselectable one opens a
// list with no visible cursor at all.
func (m *model) firstSelectable() int {
	for _, index := range m.visible() {
		if m.harnesses[index].Selectable() {
			return index
		}
	}
	return m.firstVisible()
}

func (m *model) firstVisible() int {
	if indices := m.visible(); len(indices) > 0 {
		return indices[0]
	}
	return 0
}

// onVisibleRow reports whether the cursor is on a row that is actually drawn.
//
// With nothing detected the list is empty, and a cursor of zero still pointed
// at a harness - so space on the "No AI clients detected" screen selected and
// then registered a client that was never on screen.
func (m *model) onVisibleRow() bool {
	for _, index := range m.visible() {
		if index == m.cursor {
			return true
		}
	}
	return false
}

// moveCursor walks the rows a pointer is drawn on.
//
// The pointer is only rendered for a selectable row, so stepping onto one that
// cannot be configured - Claude Desktop on Linux, which sorts first - left the
// list with no cursor visible anywhere.
func (m *model) moveCursor(direction int) {
	var indices []int
	for _, index := range m.visible() {
		if m.harnesses[index].Selectable() {
			indices = append(indices, index)
		}
	}
	if len(indices) == 0 {
		return
	}
	position := 0
	for index, value := range indices {
		if value == m.cursor {
			position = index
		}
	}
	position += direction
	if position < 0 {
		position = len(indices) - 1
	}
	if position >= len(indices) {
		position = 0
	}
	m.cursor = indices[position]
}

func (m *model) toggle() {
	if m.cursor >= len(m.harnesses) || !m.onVisibleRow() {
		return
	}
	harness := m.harnesses[m.cursor]
	if !harness.Selectable() {
		m.message = harness.Name + " could not be inspected, so it cannot be changed."
		return
	}
	m.selected[harness.ID] = !m.selected[harness.ID]
	m.message = ""
	// A row shown only because it was selected leaves the list when it is not.
	// Leaving the cursor on it made the next keypress do nothing at all.
	if !m.onVisibleRow() {
		m.cursor = m.firstSelectable()
	}
}

// toggleAll turns every visible row on, or clears them if they are all on.
//
// Visible, not every harness. Selecting rows hidden behind v wrote real
// configuration files for software the user does not have and cannot see, under
// a message announcing that it had selected the detected ones.
func (m *model) toggleAll() {
	indices := m.visible()
	anyUnselected := false
	for _, index := range indices {
		harness := m.harnesses[index]
		if harness.Selectable() && !m.selected[harness.ID] {
			anyUnselected = true
			break
		}
	}
	for _, index := range indices {
		harness := m.harnesses[index]
		if harness.Selectable() {
			m.selected[harness.ID] = anyUnselected
		}
	}
	selectable := 0
	for _, index := range indices {
		if m.harnesses[index].Selectable() {
			selectable++
		}
	}
	switch {
	case anyUnselected:
		m.message = "Selected every client shown."
	case selectable > 0:
		m.message = "Cleared every client shown."
	default:
		// Nothing on screen could be changed, so nothing is claimed.
		m.message = ""
	}
}

// connected counts the clients this run left registered.
func (m *model) connected() int {
	count := 0
	for _, result := range m.results {
		if result.Desired == detectharness.Present &&
			(result.State == detectharness.Applied || result.State == detectharness.ApplyNoop) {
			count++
		}
	}
	return count
}

// reloadHint is one client and what has to be done to it. The client's name
// stays attached: a bare instruction to restart something, with nothing saying
// what, is not advice anyone can follow.
type reloadHint struct {
	client string
	action string
}

func (m *model) reloadHints() []reloadHint {
	byID := make(map[detectharness.ID]string, len(m.harnesses))
	for _, harness := range m.harnesses {
		byID[harness.ID] = harness.ReloadHint
	}
	var hints []reloadHint
	for _, result := range m.results {
		if result.Desired != detectharness.Present || result.State != detectharness.Applied {
			continue
		}
		if action := byID[result.HarnessID]; action != "" {
			hints = append(hints, reloadHint{client: result.Name, action: action})
		}
	}
	return hints
}

// summarise renders one client's outcome in at most a few words.
func summarise(result detectharness.Result, enabling bool) string {
	switch result.State {
	case detectharness.Applied:
		if enabling {
			// An update rewrote an entry that was already there under this
			// name. Usually that is this program's own older registration, but
			// it can be someone else's server - and silently calling that
			// "registered" is the one case where the user needs the difference.
			if result.Action == "update" {
				return "replaced an existing entry"
			}
			return "registered"
		}
		return "removed"
	case detectharness.ApplyNoop:
		return "already correct"
	case detectharness.ApplySkipped:
		return "skipped: " + result.Reason
	case detectharness.ApplyConflict:
		return "conflict: another server is registered under this name"
	case detectharness.ApplyFailed:
		return "failed: " + result.Reason
	default:
		return string(result.State)
	}
}

// Run executes configure, install, or uninstall.
func Run(ctx context.Context, runtime *bootstrap.Runtime, command cli.Command, options cli.Options) int {
	installer, err := NewInstaller(runtime)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	// No terminal means no questions can be asked, so nothing is asked.
	if !interactive(options) {
		return runUnattended(ctx, runtime, installer, options, command.Name == "uninstall")
	}

	self, _ := os.Executable()
	state := &model{ctx: ctx, runtime: runtime, installer: installer, self: self}

	if command.Name == "uninstall" {
		// An interrupted replacement is undone first, so what the plan lists is
		// the whole of what is on disk rather than whatever a half-finished
		// setup happened to leave in the data root.
		if err := localstate.Recover(runtime.Paths); err != nil {
			fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		}
		state.plan = localstate.PlanUninstall(runtime.Paths, self)
		for _, harness := range installer.Detect(ctx) {
			if harness.Configured {
				state.registered = append(state.registered, harness.ID)
				state.harnesses = append(state.harnesses, harness)
			}
		}
		if state.plan.Empty() && len(state.registered) == 0 {
			fmt.Fprintln(options.Stdout, "  sana-mcp is not installed on this machine.")
			return 0
		}
		state.step, state.choice = stepPlan, 1
	} else {
		// A run that died half-way through a replacement is undone before this
		// one looks at the state, so what it reports is what is there.
		if err := localstate.Recover(runtime.Paths); err != nil {
			fmt.Fprintln(options.Stderr, "sana-mcp:", err)
			return 1
		}
		state.report = localstate.Inspect(runtime.Paths)
		session, _ := sana.LoadSession(runtime.Paths.Session)
		state.signedIn = session.SignedIn()
		state.email = session.Address()
	}

	// A reset still held when this returns was never accepted, which means the
	// run ended before anything was written - cancelled, failed, or killed.
	// Putting the old state back is the only correct reading of any of those,
	// and it is deferred because a signal is one of the ways to get here: the
	// version that ran it after the error check left a person's meetings in a
	// hidden directory whenever the process was terminated.
	defer func() {
		if state.reset == nil {
			return
		}
		if err := state.reset.Rollback(); err != nil {
			fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		}
		state.reset = nil
	}()

	program := tea.NewProgram(state, tea.WithContext(ctx),
		tea.WithInput(options.Stdin), tea.WithOutput(options.Stdout))
	if _, err := program.Run(); err != nil && !state.settled {
		// Only before the point of no return. A signal arriving while the
		// summary of a finished setup is on screen is not a failed setup, and
		// reporting it as one makes the install script announce that configure
		// did not complete.
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}

	if state.failure != "" {
		fmt.Fprintln(options.Stderr, "sana-mcp:", state.failure)
		return 1
	}
	if state.cancel && !state.settled {
		fmt.Fprintln(options.Stdout, "  Cancelled; no changes were made.")
		// Zero, so the installer script does not follow a deliberate cancel
		// with "configure did not complete".
		return 0
	}
	for _, removal := range state.removals {
		// Deferred is not a failure: it is a file Windows will not unlink while
		// it is running, named on screen for the user to delete. Counting it
		// made every Windows uninstall exit 1 under a summary saying it had
		// worked.
		if removal.Err != nil && !removal.Deferred {
			return 1
		}
	}
	for _, result := range state.results {
		if result.State == detectharness.ApplyFailed || result.State == detectharness.ApplyConflict {
			return 1
		}
	}
	return 0
}
