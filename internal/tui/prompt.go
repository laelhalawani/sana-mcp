package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/term"
)

// ErrCancelled is returned when the user backs out of a prompt.
var ErrCancelled = errors.New("cancelled")

// Terminal is the pair of streams a prompt owns, and the policy derived from
// them. One is built per process and passed down: nothing below reaches for
// os.Stdout on its own.
type Terminal struct {
	In     *os.File
	Out    *os.File
	Policy Policy
	UI     UI
}

// Open measures the terminal and builds its policy.
func Open(in, out *os.File) Terminal {
	inputTTY := term.IsTerminal(int(in.Fd()))
	outputTTY := term.IsTerminal(int(out.Fd()))
	columns, rows := 0, 0
	if outputTTY {
		if width, height, err := term.GetSize(int(out.Fd())); err == nil {
			columns, rows = width, height
		}
	}
	policy := DetectPolicy(inputTTY, outputTTY, columns, rows)
	return Terminal{In: in, Out: out, Policy: policy, UI: New(policy)}
}

// Print writes one composed line. Everything the installer settles into
// scrollback goes through here.
func (t Terminal) Print(parts ...any) {
	fmt.Fprintln(t.Out, string(t.UI.Line(parts...)))
}

// Blank writes an empty line.
func (t Terminal) Blank() { fmt.Fprintln(t.Out) }

// run drives one prompt model over this terminal. The program does not take the
// alternate screen: a prompt owns the rows it drew and nothing else, so what it
// printed before stays on screen and what it draws is erased when it finishes.
func (t Terminal) run(ctx context.Context, model tea.Model) (tea.Model, error) {
	program := tea.NewProgram(
		model,
		tea.WithContext(ctx),
		tea.WithInput(t.In),
		tea.WithOutput(t.Out),
	)
	return program.Run()
}

// promptBase is the state every prompt shares: the terminal policy, whether it
// has finished, and whether it was cancelled.
type promptBase struct {
	ui        UI
	done      bool
	cancelled bool
}

func (p *promptBase) resize(msg tea.WindowSizeMsg) {
	p.ui.Policy.Columns = msg.Width
	p.ui.Policy.Rows = msg.Height
}

// finish erases the prompt region. The caller prints the settled line itself,
// which is what keeps a transcript of the run in scrollback rather than a
// sequence of half-erased prompts.
func (p *promptBase) finish(cancelled bool) tea.Cmd {
	p.done = true
	p.cancelled = cancelled
	return tea.Quit
}

// Confirm asks a yes/no question.
func (t Terminal) Confirm(ctx context.Context, message string, preset bool) (bool, error) {
	final, err := t.run(ctx, &confirmModel{
		promptBase: promptBase{ui: t.UI},
		message:    message,
		answer:     preset,
	})
	if err != nil {
		return false, err
	}
	model := final.(*confirmModel)
	if model.cancelled {
		return false, ErrCancelled
	}
	return model.answer, nil
}

type confirmModel struct {
	promptBase
	message string
	answer  bool
}

func (m *confirmModel) Init() tea.Cmd { return nil }

func (m *confirmModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg)
	case tea.KeyMsg:
		switch strings.ToLower(msg.String()) {
		case "y":
			m.answer = true
			return m, m.finish(false)
		case "n":
			m.answer = false
			return m, m.finish(false)
		case "enter":
			return m, m.finish(false)
		case "esc", "q", "ctrl+c":
			return m, m.finish(true)
		}
	}
	return m, nil
}

func (m *confirmModel) View() string {
	if m.done {
		return ""
	}
	choices := "y/N"
	if m.answer {
		choices = "Y/n"
	}
	return string(m.ui.Line(
		m.ui.Cyan(m.ui.Glyphs.Pointer), " ",
		m.ui.Bold(m.message), " ",
		m.ui.Dim("("+choices+")"),
	))
}

// Input reads one line of text.
func (t Terminal) Input(ctx context.Context, message string) (string, error) {
	final, err := t.run(ctx, &inputModel{
		promptBase: promptBase{ui: t.UI},
		message:    message,
	})
	if err != nil {
		return "", err
	}
	model := final.(*inputModel)
	if model.cancelled {
		return "", ErrCancelled
	}
	return strings.TrimSpace(model.value), nil
}

type inputModel struct {
	promptBase
	message string
	value   string
}

func (m *inputModel) Init() tea.Cmd { return nil }

func (m *inputModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg)
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyEnter:
			return m, m.finish(false)
		case tea.KeyEsc, tea.KeyCtrlC:
			return m, m.finish(true)
		default:
			m.value, _ = Typed(m.value, msg)
		}
	}
	return m, nil
}

func (m *inputModel) View() string {
	if m.done {
		return ""
	}
	return string(m.ui.Line(
		m.ui.Cyan(m.ui.Glyphs.Pointer), " ",
		m.ui.Bold(m.message), " ",
		m.ui.Cyan(m.value),
	))
}

// Select asks the user to pick one of a list. It returns the index chosen, or
// ErrCancelled.
func (t Terminal) Select(ctx context.Context, message string, choices []string) (int, error) {
	final, err := t.run(ctx, &selectModel{
		promptBase: promptBase{ui: t.UI},
		message:    message,
		choices:    choices,
	})
	if err != nil {
		return 0, err
	}
	model := final.(*selectModel)
	if model.cancelled {
		return 0, ErrCancelled
	}
	return model.cursor, nil
}

type selectModel struct {
	promptBase
	message string
	choices []string
	cursor  int
}

func (m *selectModel) Init() tea.Cmd { return nil }

func (m *selectModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg)
	case tea.KeyMsg:
		switch strings.ToLower(msg.String()) {
		case "up", "k":
			m.cursor = Wrap(m.cursor, -1, len(m.choices))
		case "down", "j":
			m.cursor = Wrap(m.cursor, 1, len(m.choices))
		case "enter":
			return m, m.finish(false)
		case "esc", "ctrl+c":
			return m, m.finish(true)
		}
	}
	return m, nil
}

func (m *selectModel) View() string {
	if m.done {
		return ""
	}
	ui := m.ui
	lines := []string{string(ui.Line(ui.Cyan(ui.Glyphs.Pointer), " ", ui.Bold(m.message)))}
	for index, choice := range m.choices {
		pointer, label := ui.Plain(" "), ui.Plain(choice)
		if index == m.cursor {
			pointer, label = ui.Cyan(ui.Glyphs.Pointer), ui.Cyan(choice)
		}
		lines = append(lines, string(ui.Line(pointer, " ", label)))
	}
	return strings.Join(lines, "\n")
}

// WizardRow is one client offered for registration.
type WizardRow struct {
	ID   string
	Name string
	// Detected means the client was found on this machine. An undetected client
	// is hidden until the user asks for it, and cannot be reached by the cursor
	// while it is hidden.
	Detected bool
	// Current is whether this server is registered with it right now. It seeds
	// the selection, so leaving the wizard alone changes nothing.
	Current bool
}

// WizardResult is what the user chose. Submitted is false when they cancelled,
// in which case Desired must be ignored.
type WizardResult struct {
	Submitted bool
	Desired   map[string]bool
}

// Wizard runs the client toggle list.
func (t Terminal) Wizard(ctx context.Context, message string, rows []WizardRow) (WizardResult, error) {
	desired := make(map[string]bool, len(rows))
	for _, row := range rows {
		desired[row.ID] = row.Current
	}
	model := &wizardModel{
		promptBase: promptBase{ui: t.UI},
		message:    message,
		desired:    desired,
	}
	for _, row := range rows {
		if row.Detected {
			model.detected = append(model.detected, row)
			continue
		}
		model.others = append(model.others, row)
	}
	final, err := t.run(ctx, model)
	if err != nil {
		return WizardResult{}, err
	}
	result := final.(*wizardModel)
	return WizardResult{Submitted: !result.cancelled, Desired: result.desired}, nil
}

type wizardModel struct {
	promptBase
	message  string
	detected []WizardRow
	others   []WizardRow
	desired  map[string]bool
	showAll  bool
	cursor   int
}

func (m *wizardModel) Init() tea.Cmd { return nil }

// selectable is the rows the cursor can reach: the detected ones, plus the rest
// only once the user has asked to see them.
func (m *wizardModel) selectable() []WizardRow {
	if !m.showAll {
		return m.detected
	}
	return append(append([]WizardRow{}, m.detected...), m.others...)
}

func (m *wizardModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.resize(msg)
	case tea.KeyMsg:
		rows := m.selectable()
		switch strings.ToLower(msg.String()) {
		case "up", "k":
			m.cursor = Wrap(m.cursor, -1, len(rows))
		case "down", "j":
			m.cursor = Wrap(m.cursor, 1, len(rows))
		case " ":
			if m.cursor < len(rows) {
				row := rows[m.cursor]
				m.desired[row.ID] = !m.desired[row.ID]
			}
		case "a":
			allOn := true
			for _, row := range rows {
				if !m.desired[row.ID] {
					allOn = false
					break
				}
			}
			for _, row := range rows {
				m.desired[row.ID] = !allOn
			}
		case "v":
			// Hiding the extra rows must not leave the cursor pointing past the
			// end of what is still on screen.
			if m.showAll && m.cursor >= len(m.detected) {
				m.cursor = max(0, len(m.detected)-1)
			}
			m.showAll = !m.showAll
		case "enter":
			return m, m.finish(false)
		case "esc", "q", "ctrl+c":
			return m, m.finish(true)
		}
	}
	return m, nil
}

// wizardEmptyMessage explains an empty list, and says how to see more when
// there is more to see.
func wizardEmptyMessage(detected, others int, showAll bool) string {
	if detected+others == 0 {
		return "No safely configurable clients are available."
	}
	if !showAll && detected == 0 && others > 0 {
		return "No clients detected. Press v to review manual opt-in clients."
	}
	return ""
}

func (m *wizardModel) View() string {
	if m.done {
		return ""
	}
	ui := m.ui
	lines := []string{string(ui.Bold(m.message))}

	if empty := wizardEmptyMessage(len(m.detected), len(m.others), m.showAll); empty != "" {
		lines = append(lines, string(ui.Dim("  "+empty)))
	}

	for index, row := range m.selectable() {
		if m.showAll && len(m.others) > 0 && index == len(m.detected) {
			lines = append(lines, string(ui.Dim("  Not detected (manual opt-in)")))
		}
		active := index == m.cursor
		on := m.desired[row.ID]

		box := ui.Plain(ui.Glyphs.Uncheck)
		if on {
			box = ui.Green(ui.Glyphs.Check)
		}
		pointer := ui.Plain(" ")
		label := ui.Plain(row.Name)
		if active {
			pointer = ui.Cyan(ui.Glyphs.Pointer)
			label = ui.Cyan(row.Name)
		}
		changed := ui.Plain("")
		if on != row.Current {
			if on {
				changed = ui.Yellow("  (will enable)")
			} else {
				changed = ui.Yellow("  (will disable)")
			}
		}
		lines = append(lines, string(ui.Line(pointer, " ", box, " ", label, changed)))
	}

	shortcuts := []string{"up/down move", "space toggle", "a all shown"}
	if len(m.others) > 0 {
		if m.showAll {
			shortcuts = append(shortcuts, "v hide undetected")
		} else {
			shortcuts = append(shortcuts, "v show undetected")
		}
	}
	shortcuts = append(shortcuts, "enter confirm", "esc/q cancel")
	lines = append(lines, "", string(ui.Dim(strings.Join(shortcuts, "  |  "))))
	return strings.Join(lines, "\n")
}
