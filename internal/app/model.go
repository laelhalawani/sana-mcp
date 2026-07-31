package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

var (
	styleTitle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("81"))
	styleDim    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	styleCursor = lipgloss.NewStyle().Foreground(lipgloss.Color("81"))
	styleOn     = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	styleError  = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	styleWarn   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
)

var menuItems = []string{
	"Meetings",
	"Search transcripts",
	"Sync status",
	"Sana account",
	"Configuration",
	"Quit",
}

type model struct {
	ctx     context.Context
	runtime *bootstrap.Runtime
	store   *store.Store
	version string

	screen screen
	width  int
	height int

	menuCursor int

	// meetings list
	meetings      []store.Meeting
	meetingCursor int
	meetingPage   int
	meetingTotal  int
	nameFilter    string
	statusFilter  string
	filtering     bool
	filterInput   string

	// transcript / detail views
	current    store.Meeting
	lines      []store.Line
	lineCursor int
	offset     int
	detail     string

	// search
	query       string
	queryInput  string
	hits        []store.Hit
	hitCursor   int
	searching   bool
	searchTyped bool

	// editing
	editBuffer string
	editLine   int
	editDirty  bool
	confirming string // "" | "save" | "discard" | "restore"

	// history
	history       []store.Edit
	historyCursor int

	status  store.Status
	session *sana.Session
	message string
	failure string
}

func newModel(ctx context.Context, runtime *bootstrap.Runtime, database *store.Store, version string) model {
	session, _ := sana.LoadSession(runtime.Paths.Session)
	return model{
		ctx: ctx, runtime: runtime, store: database, version: version,
		screen: screenMenu, meetingPage: 1, session: session,
		width: 100, height: 30,
	}
}

type refreshMsg struct{}
type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m model) Init() tea.Cmd { return tea.Batch(tick(), m.loadStatus()) }

func (m model) loadStatus() tea.Cmd {
	return func() tea.Msg {
		status, err := m.store.Status()
		if err != nil {
			return nil
		}
		return status
	}
}

func (m *model) loadMeetings() {
	meetings, total, err := m.store.ListMeetings(store.ListOptions{
		Page: m.meetingPage, Limit: m.pageSize(),
		Query: m.nameFilter, Status: m.statusFilter,
	})
	if err != nil {
		m.failure = err.Error()
		return
	}
	m.meetings, m.meetingTotal = meetings, total
	if m.meetingCursor >= len(meetings) {
		m.meetingCursor = max(0, len(meetings)-1)
	}
}

func (m *model) loadLines() {
	lines, err := m.store.Lines(m.current.MeetingID, 0, 0)
	if err != nil {
		m.failure = err.Error()
		return
	}
	m.lines = lines
	m.lineCursor, m.offset = 0, 0
}

func (m *model) loadHistory() {
	edits, err := m.store.LineHistory(m.current.MeetingID, 0)
	if err != nil {
		m.failure = err.Error()
		return
	}
	m.history = edits
	m.historyCursor = 0
}

func (m *model) loadDetail(kind screen) {
	summaryJSON, participantsJSON, err := m.store.Metadata(m.current.MeetingID)
	if err != nil {
		m.detail = "Nothing stored for this meeting yet. It arrives with the next sync."
		return
	}
	switch kind {
	case screenSummary:
		var metadata sana.Metadata
		if err := json.Unmarshal([]byte(summaryJSON), &metadata); err != nil {
			m.detail = err.Error()
			return
		}
		m.detail = renderSummary(metadata)
	case screenParticipants:
		var participants []sana.Participant
		if err := json.Unmarshal([]byte(participantsJSON), &participants); err != nil {
			m.detail = err.Error()
			return
		}
		m.detail = renderParticipants(participants)
	}
}

// loadRecording fetches the link live, because it expires within hours.
func (m model) loadRecording() tea.Cmd {
	meetingID := m.current.MeetingID
	session := m.session
	return func() tea.Msg {
		if session == nil || session.Cookies[sana.SessionCookie] == "" {
			return detailMsg("Sign in first: sana-mcp login")
		}
		client := sana.New(os.Getenv("SANA_BASE_URL"), session)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		metadata, err := client.Meeting(ctx, meetingID)
		if err != nil {
			return detailMsg("Could not fetch the recording link: " + err.Error())
		}
		for _, candidate := range []*string{metadata.RecordingURL, metadata.FallbackRecordingURL} {
			if candidate != nil && *candidate != "" {
				return detailMsg(*candidate + "\n\nThis link expires after a few hours.")
			}
		}
		return detailMsg("This meeting has no recording.")
	}
}

type detailMsg string

func (m model) runSearch() tea.Cmd {
	query := m.query
	database := m.store
	return func() tea.Msg {
		hits, err := database.Search(query, 50, 0)
		if err != nil {
			return detailMsg(err.Error())
		}
		return searchMsg(hits)
	}
}

type searchMsg []store.Hit

// pageSize is how many meetings fit on screen. Each meeting occupies two rows
// - title, then date and status - so the available height is halved.
func (m model) pageSize() int {
	size := (m.height - 8) / 2
	if size < 3 {
		return 3
	}
	if size > 25 {
		return 25
	}
	return size
}

func renderSummary(metadata sana.Metadata) string {
	var out strings.Builder
	if metadata.Summary != nil && strings.TrimSpace(*metadata.Summary) != "" {
		out.WriteString(strings.TrimSpace(*metadata.Summary) + "\n\n")
	}
	for _, group := range metadata.Notes {
		out.WriteString(styleTitle.Render(group.Topic) + "\n")
		for _, note := range group.Notes {
			out.WriteString("  - " + note + "\n")
		}
		out.WriteString("\n")
	}
	if len(metadata.ActionItems) > 0 {
		out.WriteString(styleTitle.Render("Action items") + "\n")
		for _, item := range metadata.ActionItems {
			assignee := ""
			if item.AssignedTo != nil && *item.AssignedTo != "" {
				assignee = *item.AssignedTo + ": "
			}
			due := ""
			if item.DueDate != nil && *item.DueDate != "" {
				due = " (due " + *item.DueDate + ")"
			}
			fmt.Fprintf(&out, "  - %s%s%s\n", assignee, item.Action, due)
		}
	}
	if out.Len() == 0 {
		return "This meeting has no summary yet."
	}
	return out.String()
}

func renderParticipants(participants []sana.Participant) string {
	if len(participants) == 0 {
		return "No participants are recorded for this meeting."
	}
	var out strings.Builder
	for _, participant := range participants {
		email := ""
		if participant.Email != nil && *participant.Email != "" {
			email = "  " + styleDim.Render(*participant.Email)
		}
		host := ""
		if participant.IsHost {
			host = "  " + styleOn.Render("(host)")
		}
		fmt.Fprintf(&out, "%s%s%s\n", participant.DisplayName, email, host)
	}
	return out.String()
}

func clock(ms int64) string {
	seconds := ms / 1000
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
