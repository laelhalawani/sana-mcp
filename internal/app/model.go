package app

import (
	"context"
	"errors"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// menuItems pairs each label with the screen it opens, so the two cannot drift
// out of step the way a label list and an index switch did.
var menuItems = []struct {
	label  string
	target screen
}{
	{"Meetings", screenMeetings},
	{"Search transcripts", screenSearch},
	{"Sync status", screenStatus},
	{"Sana account", screenAccount},
	{"Configuration", screenConfig},
	{"Quit", screenQuit},
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
	metadata, participants, err := m.store.Metadata(m.current.MeetingID)
	if err != nil {
		m.detail = "Nothing stored for this meeting yet. It arrives with the next sync."
		return
	}
	switch kind {
	case screenSummary:
		m.detail = render.Summary(metadata, m.styles())
	case screenParticipants:
		m.detail = render.Participants(participants, m.styles())
	}
}

// loadRecording fetches the link live, because it expires within hours.
func (m model) loadRecording() tea.Cmd {
	meetingID := m.current.MeetingID
	session := m.session
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		link, err := sana.RecordingLink(ctx, session, meetingID)
		switch {
		case errors.Is(err, sana.ErrUnauthorized):
			return detailMsg("Sign in first: sana-mcp login")
		case err != nil:
			return detailMsg("Could not fetch the recording link: " + err.Error())
		case link == "":
			return detailMsg("This meeting has no recording.")
		}
		return detailMsg(link + "\n\nThis link expires after a few hours.")
	}
}

type detailMsg string

func (m model) runSearch() tea.Cmd {
	query := m.query
	database := m.store
	return func() tea.Msg {
		hits, err := database.Search(query, 50, 0, store.SortBest)
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

// styles gives the shared renderer this application's colours.
func (m model) styles() render.Styles {
	return render.Styles{
		Heading: func(text string) string { return render.Title.Render(text) },
		Dim:     func(text string) string { return render.Dim.Render(text) },
		Accent:  func(text string) string { return render.On.Render(text) },
	}
}
