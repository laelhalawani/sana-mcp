package app

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// wrap moves a cursor within a list, wrapping at both ends. An empty list
// leaves the cursor at zero rather than dividing by it.
func wrap(cursor, delta, length int) int {
	if length == 0 {
		return 0
	}
	return (cursor + delta + length) % length
}

// typed applies one keystroke to a text buffer, reporting whether it changed.
// Backspace on an empty buffer is not a change, which is what lets the editor
// tell "typed then deleted" from "never touched".
func typed(buffer string, key tea.KeyMsg) (string, bool) {
	switch key.Type {
	case tea.KeyBackspace:
		if buffer == "" {
			return buffer, false
		}
		return buffer[:len(buffer)-1], true
	case tea.KeyRunes, tea.KeySpace:
		return buffer + string(key.Runes), true
	}
	return buffer, false
}

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil
	case tickMsg:
		return m, tea.Batch(tick(), m.loadStatus())
	case store.Status:
		m.status = msg
		return m, nil
	case detailMsg:
		m.detail = string(msg)
		return m, nil
	case searchMsg:
		m.hits = msg
		m.searching = false
		m.hitCursor = 0
		return m, nil
	case tea.KeyMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m model) key(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	// A confirmation owns the keyboard until it is answered, so a stray key
	// cannot save or discard by accident.
	if m.confirming != "" {
		return m.confirm(key)
	}
	switch m.screen {
	case screenMenu:
		return m.menuKey(key)
	case screenMeetings:
		return m.meetingsKey(key)
	case screenTranscript:
		return m.transcriptKey(key)
	case screenSummary, screenParticipants, screenRecording:
		return m.detailKey(key)
	case screenSearch:
		return m.searchKey(key)
	case screenStatus, screenAccount, screenConfig:
		if key.String() == "esc" || key.String() == "q" {
			m.screen = screenMenu
		}
		if key.String() == "ctrl+c" {
			return m, tea.Quit
		}
		return m, nil
	case screenEdit:
		return m.editKey(key)
	case screenHistory:
		return m.historyKey(key)
	}
	return m, nil
}

func (m model) menuKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "up", "k":
		m.menuCursor = wrap(m.menuCursor, -1, len(menuItems))
	case "down", "j":
		m.menuCursor = wrap(m.menuCursor, 1, len(menuItems))
	case "enter":
		target := menuItems[m.menuCursor].target
		if target == screenQuit {
			return m, tea.Quit
		}
		return m, m.open(target)
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

// open switches to a screen and loads whatever it needs. Every entry point -
// the menu, the meetings list, the detail views - goes through here so the
// "set screen then call its loader" pairing exists once.
func (m *model) open(target screen) tea.Cmd {
	m.screen = target
	switch target {
	case screenMeetings:
		m.loadMeetings()
	case screenTranscript:
		m.loadLines()
	case screenSummary, screenParticipants:
		m.loadDetail(target)
	case screenSearch:
		m.searchTyped = true
		m.queryInput = ""
	case screenHistory:
		m.loadHistory()
	case screenRecording:
		m.detail = "Fetching the recording link..."
		return m.loadRecording()
	}
	return nil
}

// meetingViews maps the per-meeting keys shared by the meetings list, the
// transcript, and the detail screens.
var meetingViews = map[string]screen{
	"t": screenTranscript,
	"s": screenSummary,
	"p": screenParticipants,
	"o": screenRecording,
}

func (m model) meetingsKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.filtering {
		switch key.Type {
		case tea.KeyEnter:
			m.nameFilter = strings.TrimSpace(m.filterInput)
			m.filtering = false
			m.meetingPage = 1
			m.loadMeetings()
		case tea.KeyEsc:
			m.filtering = false
			m.filterInput = ""
		default:
			m.filterInput, _ = typed(m.filterInput, key)
		}
		return m, nil
	}

	switch key.String() {
	case "up", "k":
		m.meetingCursor = wrap(m.meetingCursor, -1, len(m.meetings))
	case "down", "j":
		m.meetingCursor = wrap(m.meetingCursor, 1, len(m.meetings))
	case "pgdown", "right":
		if m.meetingPage*m.pageSize() < m.meetingTotal {
			m.meetingPage++
			m.meetingCursor = 0
			m.loadMeetings()
		}
	case "pgup", "left":
		if m.meetingPage > 1 {
			m.meetingPage--
			m.meetingCursor = 0
			m.loadMeetings()
		}
	case "/":
		m.filtering = true
		m.filterInput = m.nameFilter
	case "f":
		// Cycle the status filter rather than opening another prompt: there are
		// only a few states and cycling is one key. The list comes from the
		// store so the filter cannot offer a status nothing ever writes.
		// The empty first entry is this screen's "no filter"; the rest is the
		// store's vocabulary.
		cycle := append([]string{""}, store.MeetingStatuses...)
		for index, state := range cycle {
			if state == m.statusFilter {
				m.statusFilter = cycle[(index+1)%len(cycle)]
				break
			}
		}
		m.meetingPage = 1
		m.loadMeetings()
	case "t", "enter", "s", "p", "o":
		name := key.String()
		if name == "enter" {
			name = "t"
		}
		if m.selectMeeting() {
			return m, m.open(meetingViews[name])
		}
	case "esc":
		m.screen = screenMenu
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m *model) selectMeeting() bool {
	if m.meetingCursor >= len(m.meetings) {
		return false
	}
	m.current = m.meetings[m.meetingCursor]
	return true
}

func (m model) transcriptKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	visible := m.height - 6
	switch key.String() {
	case "up", "k":
		if m.lineCursor > 0 {
			m.lineCursor--
		}
		if m.lineCursor < m.offset {
			m.offset = m.lineCursor
		}
	case "down", "j":
		if m.lineCursor < len(m.lines)-1 {
			m.lineCursor++
		}
		if m.lineCursor >= m.offset+visible {
			m.offset = m.lineCursor - visible + 1
		}
	case "pgdown":
		m.lineCursor = min(len(m.lines)-1, m.lineCursor+visible)
		m.offset = max(0, m.lineCursor-visible+1)
	case "pgup":
		m.lineCursor = max(0, m.lineCursor-visible)
		m.offset = max(0, min(m.offset-visible, m.lineCursor))
	case "e", "enter":
		if m.lineCursor < len(m.lines) {
			m.editBuffer = m.lines[m.lineCursor].Text
			m.editLine = m.lines[m.lineCursor].LineNo
			m.editDirty = false
			m.screen = screenEdit
		}
	case "h":
		return m, m.open(screenHistory)
	case "s", "p", "o":
		return m, m.open(meetingViews[key.String()])
	case "esc":
		m.screen = screenMeetings
		m.message = ""
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m model) detailKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "t", "s", "p", "o":
		return m, m.open(meetingViews[key.String()])
	case "esc":
		m.screen = screenMeetings
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m model) searchKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.searchTyped {
		switch key.Type {
		case tea.KeyEnter:
			m.query = strings.TrimSpace(m.queryInput)
			if m.query == "" {
				return m, nil
			}
			m.searchTyped = false
			m.searching = true
			return m, m.runSearch()
		case tea.KeyEsc:
			m.screen = screenMenu
		case tea.KeyCtrlC:
			return m, tea.Quit
		default:
			m.queryInput, _ = typed(m.queryInput, key)
		}
		return m, nil
	}

	switch key.String() {
	case "up", "k":
		m.hitCursor = wrap(m.hitCursor, -1, len(m.hits))
	case "down", "j":
		m.hitCursor = wrap(m.hitCursor, 1, len(m.hits))
	case "enter":
		if m.hitCursor < len(m.hits) {
			hit := m.hits[m.hitCursor]
			meeting, err := m.store.GetMeeting(hit.MeetingID)
			if err == nil {
				m.current = meeting
				m.screen = screenTranscript
				m.loadLines()
				// Open on the matching line rather than at the top, which is
				// the only reason someone opened a search hit.
				for index, line := range m.lines {
					if line.LineNo == hit.LineNo {
						m.lineCursor = index
						m.offset = max(0, index-3)
						break
					}
				}
			}
		}
	case "esc":
		m.searchTyped = true
		m.queryInput = m.query
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m model) editKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.Type {
	case tea.KeyCtrlS:
		m.confirming = "save"
		return m, nil
	case tea.KeyEsc:
		if m.editDirty {
			m.confirming = "discard"
			return m, nil
		}
		m.screen = screenTranscript
		return m, nil
	case tea.KeyCtrlC:
		return m, tea.Quit
	default:
		buffer, changed := typed(m.editBuffer, key)
		m.editBuffer = buffer
		m.editDirty = m.editDirty || changed
	}
	return m, nil
}

func (m model) historyKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "up", "k":
		m.historyCursor = wrap(m.historyCursor, -1, len(m.history))
	case "down", "j":
		m.historyCursor = wrap(m.historyCursor, 1, len(m.history))
	case "r":
		if m.historyCursor < len(m.history) {
			m.confirming = "restore"
		}
	case "esc":
		m.screen = screenTranscript
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

// confirm answers a y/n prompt.
func (m model) confirm(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	answer := strings.ToLower(key.String())
	if answer != "y" && answer != "n" && key.Type != tea.KeyEsc {
		return m, nil
	}
	action := m.confirming
	m.confirming = ""
	// Answering no always returns to where the question was asked from: for
	// "discard changes?" that means back to editing, which is the only useful
	// thing that answer can mean.
	if answer != "y" {
		return m, nil
	}

	switch action {
	case "save":
		original := ""
		for _, line := range m.lines {
			if line.LineNo == m.editLine {
				original = line.Text
				break
			}
		}
		_, err := m.store.EditLine(
			m.current.MeetingID, m.editLine, original, m.editBuffer, store.AuthorUser)
		if err != nil {
			m.failure = err.Error()
			return m, nil
		}
		m.failure = ""
		m.message = "Line saved. The original is kept; press h for history."
		m.editDirty = false
		m.screen = screenTranscript
		m.loadLines()
	case "discard":
		m.editDirty = false
		m.screen = screenTranscript
	case "restore":
		edit := m.history[m.historyCursor]
		if err := m.store.RestoreLine(edit.MeetingID, edit.LineNo); err != nil {
			m.failure = err.Error()
			return m, nil
		}
		m.failure = ""
		m.message = "Line restored to what Sana delivered."
		m.loadHistory()
		m.loadLines()
	}
	return m, nil
}
