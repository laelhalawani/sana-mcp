package install

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
	detectharness "github.com/sairaph/detect-harness"
)

// step is one screen of the installer.
type step int

const (
	// stepDetecting is first because probing every harness walks the
	// filesystem and takes a visible moment. Without a screen for it the
	// installer would print its download bar and then show nothing at all.
	stepDetecting step = iota
	stepHarnesses
	stepApplying
	stepSignInAsk
	stepSignInEmail
	stepSignInCode
	stepSyncing
	stepDone
)

type model struct {
	ctx       context.Context
	runtime   *bootstrap.Runtime
	installer *Installer

	step      step
	frame     int
	harnesses []Harness
	selected  map[detectharness.ID]bool
	cursor    int
	showAll   bool
	message   string

	results []detectharness.Result

	signedIn bool
	email    string
	pending  sana.PendingSignIn
	input    string
	failure  string

	status store.Status
	quit   bool
}

type detectedMsg []Harness
type appliedMsg []detectharness.Result
type tickMsg time.Time
type signInRequestedMsg struct {
	pending sana.PendingSignIn
	err     error
}
type signedInMsg struct {
	email string
	err   error
}
type statusMsg store.Status

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func (m model) spinner() string { return spinnerFrames[m.frame%len(spinnerFrames)] }

func tick() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m model) Init() tea.Cmd {
	return tea.Batch(tick(), func() tea.Msg {
		return detectedMsg(m.installer.Detect(m.ctx))
	})
}

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tickMsg:
		m.frame++
		// The spinner wants 120 ms; the progress numbers change at most once a
		// second. Polling on every frame reopened the database eight times a
		// second for the same answer.
		if m.step == stepSyncing && m.frame%8 == 0 {
			return m, tea.Batch(tick(), m.readStatus())
		}
		return m, tick()

	case detectedMsg:
		m.harnesses = msg
		m.selected = map[detectharness.ID]bool{}
		for _, harness := range msg {
			// Anything already configured stays configured unless the user says
			// otherwise; anything detected is offered on by default, because
			// that is what someone running an installer is asking for.
			if harness.Configured || harness.State == detectharness.Detected {
				m.selected[harness.ID] = true
			}
		}
		m.cursor = m.firstVisible()
		m.step = stepHarnesses
		return m, nil

	case appliedMsg:
		m.results = msg
		if m.signedIn {
			m.step = stepSyncing
			return m, tea.Batch(m.startSync(), m.readStatus())
		}
		m.step = stepSignInAsk
		return m, nil

	case signInRequestedMsg:
		if msg.err != nil {
			m.failure = msg.err.Error()
			m.step = stepSignInEmail
			return m, nil
		}
		m.pending = msg.pending
		m.failure = ""
		m.input = ""
		m.step = stepSignInCode
		return m, nil

	case signedInMsg:
		if msg.err != nil {
			m.failure = msg.err.Error()
			m.input = ""
			m.step = stepSignInCode
			return m, nil
		}
		m.signedIn = true
		m.email = msg.email
		m.failure = ""
		m.step = stepSyncing
		return m, tea.Batch(m.startSync(), m.readStatus())

	case statusMsg:
		m.status = store.Status(msg)
		if m.status.Complete() {
			m.step = stepDone
			return m, tea.Quit
		}
		return m, nil

	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m model) key(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.step {
	case stepHarnesses:
		switch key.String() {
		case "up", "k":
			m.moveCursor(-1)
		case "down", "j":
			m.moveCursor(1)
		case "v":
			m.showAll = !m.showAll
			m.cursor = m.firstVisible()
		case " ":
			m.toggle()
		case "a":
			m.toggleAll()
		case "enter":
			m.step = stepApplying
			return m, m.apply()
		case "esc", "q", "ctrl+c":
			m.quit = true
			return m, tea.Quit
		}
	case stepSignInAsk:
		switch key.String() {
		case "y", "enter":
			m.step = stepSignInEmail
			m.input = ""
		case "n", "esc", "q":
			m.step = stepDone
			return m, tea.Quit
		case "ctrl+c":
			m.quit = true
			return m, tea.Quit
		}
	case stepSignInEmail, stepSignInCode:
		switch key.Type {
		case tea.KeyEnter:
			value := strings.TrimSpace(m.input)
			if value == "" {
				return m, nil
			}
			if m.step == stepSignInEmail {
				m.email = value
				m.input = ""
				return m, m.requestCode(value)
			}
			m.input = ""
			return m, m.submitCode(value)
		case tea.KeyEsc:
			m.step = stepDone
			return m, tea.Quit
		case tea.KeyCtrlC:
			m.quit = true
			return m, tea.Quit
		default:
			m.input, _ = tui.Typed(m.input, key)
		}
	case stepSyncing:
		switch key.String() {
		case "enter", "esc", "q":
			// Leaving the progress view does not stop the sync: it continues in
			// the background, which the summary says.
			m.step = stepDone
			return m, tea.Quit
		case "ctrl+c":
			m.quit = true
			return m, tea.Quit
		}
	}
	return m, nil
}

// visible is which harnesses earn a line.
//
// A client is worth showing if it is here, or if this tool is already
// registered with it. Everything else is behind v: a list of thirteen clients,
// eleven of them "not detected", tells the user nothing they asked for.
func (m model) visible() []int {
	var indices []int
	for index, harness := range m.harnesses {
		if harness.State == detectharness.Detected || harness.Configured || m.showAll {
			indices = append(indices, index)
		}
	}
	return indices
}

func (m model) firstVisible() int {
	if indices := m.visible(); len(indices) > 0 {
		return indices[0]
	}
	return 0
}

// moveCursor walks the visible rows, so hidden clients are skipped rather than
// silently landed on.
func (m *model) moveCursor(direction int) {
	indices := m.visible()
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
	if m.cursor >= len(m.harnesses) {
		return
	}
	harness := m.harnesses[m.cursor]
	if !harness.Selectable() {
		m.message = harness.Name + " could not be inspected, so it cannot be changed."
		return
	}
	m.selected[harness.ID] = !m.selected[harness.ID]
	m.message = ""
}

func (m *model) toggleAll() {
	anyUnselected := false
	for _, harness := range m.harnesses {
		if harness.Selectable() && !m.selected[harness.ID] {
			anyUnselected = true
			break
		}
	}
	for _, harness := range m.harnesses {
		if harness.Selectable() {
			m.selected[harness.ID] = anyUnselected
		}
	}
	if anyUnselected {
		m.message = "Selected every detected client."
	} else {
		m.message = "Cleared every client."
	}
}

// header matches the installer script's own output: a leading blank line and a
// two-space indent, so the download and the setup read as one thing rather than
// two programs taking turns.
func header() string {
	return "\n" + tui.Title.Render("  sana-mcp setup") + "\n"
}

func (m model) viewHarnesses() string {
	var out strings.Builder
	out.WriteString("\n  AI clients — which should be able to read your meetings?\n\n")

	indices := m.visible()
	if len(indices) == 0 {
		out.WriteString(tui.Dim.Render(
			"  No AI clients detected. Install one, then run\n  `sana-mcp configure`.\n"))
	}
	for _, index := range indices {
		harness := m.harnesses[index]
		cursor := " "
		if index == m.cursor && harness.Selectable() {
			cursor = tui.Cursor.Render(">")
		}
		mark := tui.Off.Render("○")
		if !harness.Selectable() {
			mark = tui.Dim.Render("·")
		} else if m.selected[harness.ID] {
			mark = tui.On.Render("●")
		}
		line := fmt.Sprintf("%-22s %s", harness.Name, tui.Dim.Render(harness.StatusText()))
		if !harness.Selectable() {
			line = tui.Dim.Render(fmt.Sprintf("%-22s ", harness.Name)) + tui.Warn.Render(harness.StatusText())
		}
		fmt.Fprintf(&out, " %s %s %s\n", cursor, mark, line)
	}

	hidden := len(m.harnesses) - len(indices)
	if hidden > 0 && !m.showAll {
		out.WriteString("\n" + tui.Dim.Render(
			fmt.Sprintf("  press v to show %d client(s) that are not installed", hidden)))
	} else if m.showAll {
		out.WriteString("\n" + tui.Dim.Render("  press v to hide clients that are not installed"))
	}
	if m.message != "" {
		out.WriteString("\n\n  " + m.message)
	}
	out.WriteString("\n\n" + tui.Footer.Render(
		"  ↑↓ move · space toggle · a all/none · v show all · enter continue · q cancel"))
	return out.String()
}

func (m model) apply() tea.Cmd {
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
		results = append(results, m.installer.Apply(m.ctx, absent, detectharness.Absent)...)
		return appliedMsg(results)
	}
}

func (m model) requestCode(email string) tea.Cmd {
	return func() tea.Msg {
		client := sana.New("", nil)
		pending, err := client.RequestSignInCode(m.ctx, email)
		return signInRequestedMsg{pending: pending, err: err}
	}
}

func (m model) submitCode(code string) tea.Cmd {
	pending := m.pending
	paths := m.runtime.Paths
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

// startSync runs one sync cycle in the background so the progress view has
// something to report. The daemon owns later cycles.
func (m model) startSync() tea.Cmd {
	runtime := m.runtime
	return func() tea.Msg {
		syncNow(runtime)
		return nil
	}
}

func (m model) readStatus() tea.Cmd {
	path := m.runtime.Paths.Database
	return func() tea.Msg {
		database, err := store.Open(path)
		if err != nil {
			return nil
		}
		defer database.Close()
		status, err := database.Status()
		if err != nil {
			return nil
		}
		return statusMsg(status)
	}
}

func (m model) View() string {
	var out strings.Builder
	out.WriteString(header())

	switch m.step {
	case stepDetecting:
		fmt.Fprintf(&out, "  %s Looking for AI clients...\n", m.spinner())

	case stepHarnesses:
		out.WriteString(m.viewHarnesses())
	case stepApplying:
		fmt.Fprintf(&out, "  %s Writing client configuration...\n", m.spinner())

	case stepSignInAsk:
		out.WriteString("  Sign in to Sana now? [Y/n]\n")
		out.WriteString(tui.Dim.Render("  You can also sign in later with: sana-mcp login") + "\n")

	case stepSignInEmail:
		if m.failure != "" {
			out.WriteString("  " + tui.Failed.Render(m.failure) + "\n\n")
		}
		fmt.Fprintf(&out, "  Email: %s\n", m.input)
		out.WriteString(tui.Dim.Render("  enter to send a sign-in code, esc to skip") + "\n")

	case stepSignInCode:
		if m.failure != "" {
			out.WriteString("  " + tui.Failed.Render(m.failure) + "\n\n")
		}
		fmt.Fprintf(&out, "  A code was emailed to %s\n\n", m.email)
		fmt.Fprintf(&out, "  Code: %s\n", m.input)
		out.WriteString(tui.Dim.Render("  enter to confirm, esc to skip") + "\n")

	case stepSyncing:
		fmt.Fprintf(&out, "  %s %s\n\n", m.spinner(), render.StatusLabel(m.status))
		out.WriteString("  " + render.ProgressBar(m.status.TranscriptsDone, m.status.TranscriptsTotal, 28) + "\n")
		fmt.Fprintf(&out, "  %d/%d transcripts\n", m.status.TranscriptsDone, m.status.TranscriptsTotal)
		out.WriteString("\n" + tui.Dim.Render("  enter to leave it running in the background") + "\n")

	case stepDone:
		out.WriteString(m.summary())
	}
	return out.String()
}

func (m model) summary() string {
	var out strings.Builder
	configured := 0
	var failures []string
	for _, result := range m.results {
		switch {
		case result.Desired == detectharness.Present && result.State == detectharness.Applied:
			configured++
		case result.State != detectharness.Applied && result.Reason != "":
			failures = append(failures, fmt.Sprintf("%s: %s", result.Name, result.Reason))
		}
	}
	fmt.Fprintf(&out, "  AI clients    %d connected\n", configured)
	if m.signedIn {
		fmt.Fprintf(&out, "  Sana account  signed in as %s\n", m.email)
	} else {
		out.WriteString("  Sana account  " + tui.Warn.Render("not signed in") + "\n")
	}
	switch {
	case m.status.Complete():
		out.WriteString("  Meeting sync  " + tui.On.Render("complete") + "\n")
	case m.signedIn:
		out.WriteString("  Meeting sync  continuing in the background\n")
	default:
		out.WriteString("  Meeting sync  waiting for sign-in\n")
	}
	for _, failure := range failures {
		out.WriteString("  " + tui.Failed.Render(failure) + "\n")
	}
	if hints := m.reloadHints(); len(hints) > 0 {
		fmt.Fprintf(&out, "  Reload        %s\n", strings.Join(hints, "; "))
	}
	if !m.signedIn {
		out.WriteString("\n  Next: " + tui.Title.Render("sana-mcp login") + "\n")
		return out.String()
	}
	out.WriteString("\n  Next: " + tui.Title.Render("sana-mcp") + "\n")
	return out.String()
}

// reloadHints derives the reload advice from what was actually applied, rather
// than accumulating it as state that has to be kept in step.
func (m model) reloadHints() []string {
	byID := make(map[detectharness.ID]string, len(m.harnesses))
	for _, harness := range m.harnesses {
		byID[harness.ID] = harness.ReloadHint
	}
	var hints []string
	seen := map[string]bool{}
	for _, result := range m.results {
		if result.Desired != detectharness.Present || result.State != detectharness.Applied {
			continue
		}
		hint := byID[result.HarnessID]
		if hint == "" || seen[hint] {
			continue
		}
		seen[hint] = true
		hints = append(hints, hint)
	}
	return hints
}

// Run executes configure, install, or uninstall.
func Run(ctx context.Context, runtime *bootstrap.Runtime, command cli.Command, options cli.Options) int {
	installer, err := NewInstaller(runtime)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}

	if command.Name == "uninstall" {
		return runUninstall(ctx, installer, options)
	}

	session, _ := sana.LoadSession(runtime.Paths.Session)
	initial := model{
		ctx:       ctx,
		runtime:   runtime,
		installer: installer,
		signedIn:  session.SignedIn(),
	}
	if initial.signedIn {
		initial.email = session.Email
	}
	program := tea.NewProgram(initial, tea.WithContext(ctx))
	final, err := program.Run()
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if result, ok := final.(model); ok && result.quit {
		fmt.Fprintln(options.Stdout, "Cancelled; no changes were made.")
		return 1
	}
	return 0
}

func runUninstall(ctx context.Context, installer *Installer, options cli.Options) int {
	var ids []detectharness.ID
	for _, harness := range installer.Detect(ctx) {
		if harness.Configured {
			ids = append(ids, harness.ID)
		}
	}
	if len(ids) == 0 {
		fmt.Fprintln(options.Stdout, "sana-mcp is not registered with any client.")
		return 0
	}
	results := installer.Apply(ctx, ids, detectharness.Absent)
	removed := 0
	for _, result := range results {
		if result.State == detectharness.Applied {
			removed++
		}
	}
	fmt.Fprintf(options.Stdout, "Removed sana-mcp from %d client(s).\n", removed)
	return 0
}
