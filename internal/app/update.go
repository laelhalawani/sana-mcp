package app

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

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
		m.menuCursor = (m.menuCursor - 1 + len(menuItems)) % len(menuItems)
	case "down", "j":
		m.menuCursor = (m.menuCursor + 1) % len(menuItems)
	case "enter":
		switch m.menuCursor {
		case 0:
			m.screen = screenMeetings
			m.loadMeetings()
		case 1:
			m.screen = screenSearch
			m.searchTyped = true
			m.queryInput = ""
		case 2:
			m.screen = screenStatus
		case 3:
			m.screen = screenAccount
		case 4:
			m.screen = screenConfig
		case 5:
			return m, tea.Quit
		}
	case "q", "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
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
		case tea.KeyBackspace:
			if len(m.filterInput) > 0 {
				m.filterInput = m.filterInput[:len(m.filterInput)-1]
			}
		case tea.KeyRunes, tea.KeySpace:
			m.filterInput += string(key.Runes)
		}
		return m, nil
	}

	switch key.String() {
	case "up", "k":
		if len(m.meetings) > 0 {
			m.meetingCursor = (m.meetingCursor - 1 + len(m.meetings)) % len(m.meetings)
		}
	case "down", "j":
		if len(m.meetings) > 0 {
			m.meetingCursor = (m.meetingCursor + 1) % len(m.meetings)
		}
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
		// only five states and cycling is one key.
		states := []string{"", "ready", "processing", "downloading", "retrying"}
		for index, state := range states {
			if state == m.statusFilter {
				m.statusFilter = states[(index+1)%len(states)]
				break
			}
		}
		m.meetingPage = 1
		m.loadMeetings()
	case "t", "enter":
		if m.selectMeeting() {
			m.screen = screenTranscript
			m.loadLines()
		}
	case "s":
		if m.selectMeeting() {
			m.screen = screenSummary
			m.loadDetail(screenSummary)
		}
	case "p":
		if m.selectMeeting() {
			m.screen = screenParticipants
			m.loadDetail(screenParticipants)
		}
	case "o":
		if m.selectMeeting() {
			m.screen = screenRecording
			m.detail = "Fetching the recording link..."
			return m, m.loadRecording()
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
		m.screen = screenHistory
		m.loadHistory()
	case "s":
		m.screen = screenSummary
		m.loadDetail(screenSummary)
	case "p":
		m.screen = screenParticipants
		m.loadDetail(screenParticipants)
	case "o":
		m.screen = screenRecording
		m.detail = "Fetching the recording link..."
		return m, m.loadRecording()
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
	case "t":
		m.screen = screenTranscript
		m.loadLines()
	case "s":
		m.screen = screenSummary
		m.loadDetail(screenSummary)
	case "p":
		m.screen = screenParticipants
		m.loadDetail(screenParticipants)
	case "o":
		m.screen = screenRecording
		m.detail = "Fetching the recording link..."
		return m, m.loadRecording()
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
		case tea.KeyBackspace:
			if len(m.queryInput) > 0 {
				m.queryInput = m.queryInput[:len(m.queryInput)-1]
			}
		case tea.KeyCtrlC:
			return m, tea.Quit
		case tea.KeyRunes, tea.KeySpace:
			m.queryInput += string(key.Runes)
		}
		return m, nil
	}

	switch key.String() {
	case "up", "k":
		if len(m.hits) > 0 {
			m.hitCursor = (m.hitCursor - 1 + len(m.hits)) % len(m.hits)
		}
	case "down", "j":
		if len(m.hits) > 0 {
			m.hitCursor = (m.hitCursor + 1) % len(m.hits)
		}
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
	case tea.KeyBackspace:
		if len(m.editBuffer) > 0 {
			m.editBuffer = m.editBuffer[:len(m.editBuffer)-1]
			m.editDirty = true
		}
	case tea.KeyCtrlC:
		return m, tea.Quit
	case tea.KeyRunes, tea.KeySpace:
		m.editBuffer += string(key.Runes)
		m.editDirty = true
	}
	return m, nil
}

func (m model) historyKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "up", "k":
		if len(m.history) > 0 {
			m.historyCursor = (m.historyCursor - 1 + len(m.history)) % len(m.history)
		}
	case "down", "j":
		if len(m.history) > 0 {
			m.historyCursor = (m.historyCursor + 1) % len(m.history)
		}
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
	if answer != "y" {
		if action == "discard" {
			// Answering no to "discard changes?" returns to editing, which is
			// the only useful thing that answer can mean.
			return m, nil
		}
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
