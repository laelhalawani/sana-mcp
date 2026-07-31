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
			m.cursor = tui.Wrap(m.cursor, -1, len(m.harnesses))
		case "down", "j":
			m.cursor = tui.Wrap(m.cursor, 1, len(m.harnesses))
		case " ":
			if m.cursor < len(m.harnesses) {
				harness := m.harnesses[m.cursor]
				if harness.Selectable() {
					m.selected[harness.ID] = !m.selected[harness.ID]
				}
			}
		case "a":
			allOn := true
			for _, harness := range m.harnesses {
				if harness.Selectable() && !m.selected[harness.ID] {
					allOn = false
				}
			}
			for _, harness := range m.harnesses {
				if harness.Selectable() {
					m.selected[harness.ID] = !allOn
				}
			}
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
	out.WriteString(tui.Title.Render("sana-mcp setup") + "\n\n")

	switch m.step {
	case stepDetecting:
		fmt.Fprintf(&out, "  %s Looking for AI clients...\n", m.spinner())

	case stepHarnesses:
		out.WriteString("  Configure sana-mcp for your AI clients\n\n")
		for index, harness := range m.harnesses {
			// Padding is applied to the plain name before any styling: colour
			// codes count toward a %-24s width and would ragged the column.
			name := fmt.Sprintf("%-26s", harness.Name)
			pointer := " "
			box := "( )"
			switch {
			case !harness.Selectable():
				// A harness that cannot be inspected or written is shown so the
				// user knows it was considered, but reads as "not detected":
				// they want to know whether it is there, not why the library
				// could not reach it.
				out.WriteString(tui.Dim.Render(
					fmt.Sprintf("    ( ) %s%s", name, harness.StatusText())) + "\n")
				continue
			case m.selected[harness.ID]:
				box = tui.On.Render("(x)")
			}
			if index == m.cursor {
				pointer = tui.Cursor.Render(">")
				name = tui.Cursor.Render(name)
			}
			fmt.Fprintf(&out, "  %s %s %s%s\n",
				pointer, box, name, tui.Dim.Render(harness.StatusText()))
		}
		out.WriteString("\n" + tui.Dim.Render(
			"  up/down move  space toggle  a all  enter confirm  esc cancel") + "\n")

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
