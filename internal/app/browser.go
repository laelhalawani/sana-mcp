package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/statusview"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// The meeting browser: a list of cards, the actions for one meeting, the four
// documents it has, its sync details, the two filters, the status page and the
// keyboard help - all one screen, because they share a selection and a refresh.

// cardHeight is how many rows one meeting occupies: title, metadata, blank.
const cardHeight = 3

// statusFilters are the choices the f key offers. "all" is a surface
// affordance rather than a status, which is why it is added here and not to
// the store's vocabulary.
var statusFilters = append([]string{"all"}, store.MeetingStatuses...)

// meetingActions is what enter opens on a meeting.
var meetingActions = []struct {
	label string
	value string
}{
	{"Transcript", "transcript"},
	{"Summary", "summary"},
	{"Participants", "participants"},
	{"Recording", "recording"},
	{"Sync details", "sync"},
	{"Back to meetings", "back"},
}

var helpLines = []string{
	"up/down or j/k move; pgup/pgdn/home/end jump",
	"enter meeting actions; t transcript; s summary; p participants; o recording",
	"/ filter name; f filter status; c clear filters; r refresh; i status",
	"e edit a transcript line; h edit history",
	"esc menu; q quit",
}

// view is which of the browser's screens is showing.
type view string

const (
	viewList    view = "list"
	viewActions view = "actions"
	viewDetail  view = "detail"
	viewSync    view = "sync"
	viewStatus  view = "status"
	viewHelp    view = "help"
	viewEdit    view = "edit"
	viewHistory view = "history"
)

// backTo is where escape returns from a document.
type backTo string

const (
	backList    backTo = "list"
	backActions backTo = "actions"
)

type refreshMsg time.Time

// detailMsg carries a document that had to be fetched.
//
// request is which fetch it belongs to. A recording link takes up to thirty
// seconds and cannot be cancelled, so without it the answer to a request the
// user has already navigated away from lands on top of whatever they opened
// instead - leaving a recording URL under a transcript's footer, and the edit
// key pointing into a transcript that is no longer on screen.
type detailMsg struct {
	request int
	id      string
	title   string
	lines   []string
	target  int
}

type browser struct {
	ctx      context.Context
	app      *application
	ui       tui.UI
	quitting bool

	info     statusview.Info
	meetings []store.Meeting
	selected string
	listTop  int

	filter       string
	statusFilter string
	// filterInput and statusInput are non-nil while their prompt is open. A
	// pointer rather than a flag because "" is a legitimate filter value.
	filterInput *string
	statusInput *int

	view view
	// request counts document openings, so a fetch that finishes late can tell
	// whether it is still the one being waited for.
	request int
	// revision changes whenever the body does, which is what lets the wrapped
	// layout be kept rather than recomputed for every frame and every key.
	revision   int
	wrapCache  []string
	wrapWidth  int
	wrapSource int
	wrapView   view

	scroll   int
	title    string
	lines    []string
	loading  bool
	detailID string
	back     backTo
	action   int

	// transcript editing
	transcript []store.Line
	editLine   int
	editBuffer string
	confirm    string
	history    []store.Edit
	historyRow int

	failure string
	done    bool
}

// browse opens the meeting browser. It returns tui.ErrCancelled when the user
// asked to leave the program rather than the screen.
func (a *application) browse() error {
	model := &browser{ctx: a.ctx, app: a, ui: a.terminal.UI, view: viewList}
	model.refresh()

	program := tea.NewProgram(model,
		tea.WithContext(a.ctx),
		tea.WithInput(a.terminal.In),
		tea.WithOutput(a.terminal.Out),
	)
	final, err := program.Run()
	if err != nil {
		return err
	}
	if final.(*browser).quitting {
		return tui.ErrCancelled
	}
	return nil
}

func (b *browser) Init() tea.Cmd { return tickBrowser() }

func tickBrowser() tea.Cmd {
	return tea.Tick(time.Second, func(now time.Time) tea.Msg { return refreshMsg(now) })
}

// refresh reloads the status and the meeting list under the current filters,
// keeping the selection on the same meeting where it still exists.
func (b *browser) refresh() {
	b.info = statusview.Read(b.app.runtime.Paths)
	// The status and sync-detail bodies are built from what was just read.
	b.revision++
	meetings, _, err := b.app.store.ListMeetings(store.ListOptions{
		Page: 1, Limit: 1000, Query: b.filter, Status: b.statusFilter,
	})
	if err != nil {
		b.failure = err.Error()
		return
	}
	b.failure = ""
	b.meetings = meetings

	for _, meeting := range meetings {
		if meeting.MeetingID == b.selected {
			return
		}
	}
	b.selected = ""
	if len(meetings) > 0 {
		b.selected = meetings[0].MeetingID
	}
}

func (b *browser) selectedIndex() int {
	for index, meeting := range b.meetings {
		if meeting.MeetingID == b.selected {
			return index
		}
	}
	if len(b.meetings) == 0 {
		return -1
	}
	return 0
}

func (b *browser) meeting(id string) (store.Meeting, bool) {
	for _, meeting := range b.meetings {
		if meeting.MeetingID == id {
			return meeting, true
		}
	}
	return store.Meeting{}, false
}

// bodyRows is how many rows the body may use: everything but the title and the
// footer.
func (b *browser) bodyRows() int { return max(0, b.ui.Policy.AvailableRows()-2) }

func (b *browser) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		b.ui.Policy.Columns = msg.Width
		b.ui.Policy.Rows = msg.Height

	case refreshMsg:
		// A prompt that is taking typed input is not interrupted by a refresh:
		// the list moving under a half-typed filter is worse than stale counts.
		if b.filterInput == nil && b.statusInput == nil && !b.working() {
			b.refresh()
		}
		return b, tickBrowser()

	case detailMsg:
		// Still the document being waited for, and still on the screen that
		// asked for it: a fetch that lands after the user has gone back to the
		// actions menu would otherwise retitle it.
		if msg.request == b.request && b.view == viewDetail {
			b.title, b.lines, b.loading = msg.title, msg.lines, false
			b.scroll = msg.target
			b.revision++
		}

	case tea.KeyMsg:
		return b, b.key(msg)
	}
	return b, nil
}

// working is a screen the user is part-way through, where a refresh would
// destroy what they are looking at.
func (b *browser) working() bool {
	return b.view == viewEdit || b.view == viewHistory || b.confirm != ""
}

func (b *browser) quit() tea.Cmd {
	b.quitting, b.done = true, true
	return tea.Quit
}

func (b *browser) leave() tea.Cmd {
	b.done = true
	return tea.Quit
}

func (b *browser) key(key tea.KeyMsg) tea.Cmd {
	name := strings.ToLower(key.String())
	if name == "ctrl+c" {
		return b.quit()
	}
	switch {
	case b.confirm != "":
		return b.confirmKey(name)
	case b.filterInput != nil:
		return b.filterKey(key, name)
	case b.statusInput != nil:
		return b.statusFilterKey(name)
	case b.view == viewEdit:
		return b.editKey(key, name)
	case b.view == viewHistory:
		// The history screen owns r, which restores rather than refreshes, so
		// it is dispatched before the global shortcuts below.
		return b.historyKey(name)
	}

	// q, r, i and ? work from every screen, which is what the help promises.
	switch name {
	case "q":
		return b.quit()
	case "r":
		b.refresh()
		return nil
	case "i":
		b.refresh()
		b.view, b.scroll, b.revision = viewStatus, 0, b.revision+1
		return nil
	case "?":
		b.view, b.scroll, b.revision = viewHelp, 0, b.revision+1
		return nil
	}

	switch b.view {
	case viewActions:
		return b.actionsKey(name)
	case viewList:
		return b.listKey(name)
	default:
		return b.documentKey(name)
	}
}

func (b *browser) listKey(name string) tea.Cmd {
	switch name {
	case "esc":
		return b.leave()
	case "/":
		value := b.filter
		b.filterInput = &value
		return nil
	case "f":
		index := 0
		for position, status := range statusFilters {
			if status == b.statusFilter {
				index = position
			}
		}
		b.statusInput = &index
		return nil
	case "c":
		if b.filter == "" && b.statusFilter == "" {
			return nil
		}
		b.filter, b.statusFilter, b.listTop = "", "", 0
		b.refresh()
		return nil
	case "d":
		if b.selected != "" {
			b.openSync(b.selected, backList)
		}
		return nil
	case "enter":
		if b.selected == "" {
			return nil
		}
		meeting, _ := b.meeting(b.selected)
		b.request++
		b.view, b.scroll, b.action = viewActions, 0, 0
		b.title = meeting.Title
		b.detailID = b.selected
		return nil
	case "t", "s", "p":
		return b.openDocument(b.selected, name, backList)
	case "o":
		return b.openRecording(b.selected, backList)
	}
	return b.moveSelection(name)
}

// moveSelection walks the list, keeping the window over the selection.
func (b *browser) moveSelection(name string) tea.Cmd {
	if len(b.meetings) == 0 {
		return nil
	}
	index := b.selectedIndex()
	capacity := max(1, b.bodyRows()/cardHeight)
	next := index
	switch name {
	case "up", "k":
		next--
	case "down", "j":
		next++
	case "pgup":
		next -= capacity
		b.listTop = max(0, b.listTop-capacity)
	case "pgdown":
		next += capacity
		b.listTop = min(max(0, len(b.meetings)-capacity), b.listTop+capacity)
	case "home":
		next, b.listTop = 0, 0
	case "end":
		next = len(b.meetings) - 1
		b.listTop = max(0, len(b.meetings)-capacity)
	default:
		return nil
	}
	next = max(0, min(len(b.meetings)-1, next))
	b.listTop = max(0, min(b.listTop, max(0, len(b.meetings)-capacity)))
	if next < b.listTop {
		b.listTop = next
	}
	if next >= b.listTop+capacity {
		b.listTop = next - capacity + 1
	}
	b.selected = b.meetings[next].MeetingID
	return nil
}

func (b *browser) actionsKey(name string) tea.Cmd {
	switch name {
	case "esc":
		b.request++
		b.view, b.scroll = viewList, 0
		return nil
	case "t", "s", "p":
		return b.openDocument(b.detailID, name, backActions)
	case "o":
		return b.openRecording(b.detailID, backActions)
	case "up", "k":
		b.action = max(0, b.action-1)
		return nil
	case "down", "j":
		b.action = min(len(meetingActions)-1, b.action+1)
		return nil
	case "enter":
		switch meetingActions[b.action].value {
		case "back":
			b.view, b.scroll = viewList, 0
		case "recording":
			return b.openRecording(b.detailID, backActions)
		case "sync":
			b.openSync(b.detailID, backActions)
		case "transcript":
			return b.openDocument(b.detailID, "t", backActions)
		case "summary":
			return b.openDocument(b.detailID, "s", backActions)
		case "participants":
			return b.openDocument(b.detailID, "p", backActions)
		}
	}
	return nil
}

// documentKey handles the scrolling screens: a document, sync details, the
// status page and the help.
func (b *browser) documentKey(name string) tea.Cmd {
	if b.view == viewDetail || b.view == viewSync {
		switch name {
		case "t", "s", "p":
			return b.openDocument(b.detailID, name, b.back)
		case "o":
			return b.openRecording(b.detailID, b.back)
		case "e":
			if b.view == viewDetail && len(b.transcript) > 0 {
				return b.beginEdit()
			}
		case "h":
			if b.view == viewDetail && len(b.transcript) > 0 {
				b.openHistory()
				return nil
			}
		}
	}
	if name == "esc" {
		// The title belongs to whatever is on screen. Leaving a document has to
		// put the meeting's name back, or the actions menu is headed
		// "Recording".
		b.request++
		if (b.view == viewDetail || b.view == viewSync) && b.back == backActions {
			if meeting, found := b.meeting(b.detailID); found {
				b.title = meeting.Title
			}
			b.view, b.scroll = viewActions, 0
			return nil
		}
		b.view, b.scroll = viewList, 0
		return nil
	}
	// Scrolling counts the rows that are drawn, which is what wrapping produces
	// - not the stored lines, one of which can be a whole paragraph.
	return b.scrollBy(name, len(b.wrapped(b.body())))
}

func (b *browser) scrollBy(name string, total int) tea.Cmd {
	capacity := max(1, b.bodyRows())
	maximum := max(0, total-capacity)
	delta := 0
	switch name {
	case "up", "k":
		delta = -1
	case "down", "j":
		delta = 1
	case "pgup":
		delta = -capacity
	case "pgdown":
		delta = capacity
	case "home":
		b.scroll = 0
		return nil
	case "end":
		b.scroll = maximum
		return nil
	default:
		return nil
	}
	b.scroll = max(0, min(maximum, b.scroll+delta))
	return nil
}

func (b *browser) filterKey(key tea.KeyMsg, name string) tea.Cmd {
	switch name {
	case "enter":
		b.filter = strings.TrimSpace(*b.filterInput)
		b.filterInput = nil
		b.listTop = 0
		b.refresh()
	case "esc":
		b.filterInput = nil
	default:
		if value, changed := tui.Typed(*b.filterInput, key); changed {
			b.filterInput = &value
		}
	}
	return nil
}

func (b *browser) statusFilterKey(name string) tea.Cmd {
	switch name {
	case "enter":
		selected := statusFilters[*b.statusInput]
		if selected == "all" {
			selected = ""
		}
		b.statusFilter = selected
		b.statusInput = nil
		b.listTop = 0
		b.refresh()
	case "esc":
		b.statusInput = nil
	case "up", "k":
		next := tui.Wrap(*b.statusInput, -1, len(statusFilters))
		b.statusInput = &next
	case "down", "j":
		next := tui.Wrap(*b.statusInput, 1, len(statusFilters))
		b.statusInput = &next
	}
	return nil
}

// openDocument loads one of the stored documents. kind is the key that asked
// for it, so "t", "s" or "p".
func (b *browser) openDocument(id, kind string, back backTo) tea.Cmd {
	if id == "" {
		return nil
	}
	b.request++
	b.revision++
	b.detailID, b.back, b.scroll, b.loading = id, back, 0, false
	b.view = viewDetail
	b.transcript = nil

	// Read fresh rather than taken from the list cached by refresh(), which runs
	// on a tick and is skipped entirely while a prompt is open. The row carries
	// whether the transcript arrived, and a stale one makes both this screen and
	// the attendance screen claim a downloaded transcript was never fetched -
	// the false claim this whole change removes. The len() backstops below
	// cannot catch it for a meeting Sana returned empty, because there is
	// nothing in hand to outrank the row with.
	meeting, err := b.app.store.GetMeeting(id)
	if errors.Is(err, store.ErrNotFound) {
		b.title, b.lines = "Meeting", []string{"No meeting found with ID " + id + "."}
		return nil
	}
	if err != nil {
		// A database that could not be read is not a meeting that does not
		// exist. Saying the second while the daemon holds a write lock asserts
		// something false about the meeting, which is what every other branch
		// here stopped doing.
		b.title, b.lines = "Meeting", []string{err.Error()}
		return nil
	}
	b.title = meeting.Title

	switch kind {
	case "t":
		lines, err := b.app.store.Lines(id, 0, 0)
		if err != nil {
			b.lines = []string{err.Error()}
			return nil
		}
		// Whether it arrived is what the meeting row records. Sana returns an
		// empty transcript for a meeting with no speech, and counting lines
		// reports those as never downloaded - which is what the participants
		// screen stopped doing, so this one must not still say it.
		// Lines in hand outrank the cached row, which refresh() rewrites on a
		// tick and skips entirely while a prompt is open: a transcript that
		// landed since then would otherwise be read from the database and then
		// thrown away with "not downloaded yet". Attendance defends against the
		// same staleness the same way.
		if meeting.TranscriptState != store.TranscriptComplete && len(lines) == 0 {
			b.lines = []string{"Transcript is not downloaded yet."}
			return nil
		}
		if len(lines) == 0 {
			b.lines = []string{"This transcript has no lines."}
			return nil
		}
		b.transcript = lines
		b.lines = transcriptLines(lines)
	case "s":
		// Not yet fetched is not the same as unavailable: the summary document
		// is fetched after the transcript, so a stored meeting is without one
		// for a while during every sync.
		// Absent is reported as absent; unreadable is reported as the error it
		// is. Collapsing the second into "no summary is available" asserts
		// something false about the meeting, which is what the participants
		// branch below stopped doing.
		metadata, err := b.app.store.Summary(id)
		if errors.Is(err, store.ErrNotFound) {
			b.lines = []string{render.SummaryNotDownloaded}
			return nil
		}
		if err != nil {
			b.lines = []string{err.Error()}
			return nil
		}
		b.lines = strings.Split(strings.TrimRight(render.Summary(metadata, render.Styles{}), "\n"), "\n")
	case "p":
		// A meeting can have participants without a transcript, or a transcript
		// before its metadata arrives, so neither absence hides the other. Only
		// a missing document is tolerated though: an unreadable one must not
		// render as "none are recorded", which would assert something false
		// about the meeting rather than admit the row could not be parsed.
		participants, metadataErr := b.app.store.Participants(id)
		speakers, err := b.app.store.Speakers(id)
		if err != nil {
			b.lines = []string{err.Error()}
			return nil
		}
		// The transcript screen already says "not downloaded yet" rather than
		// claiming a meeting has no lines; this one says the same about both of
		// its groups. Whether the transcript arrived is what the meeting row
		// records, not something to infer from a line count - Sana returns an
		// empty transcript for a meeting with no speech, and that one is
		// downloaded. The row is the one openDocument already loaded.
		b.lines = strings.Split(strings.TrimRight(render.Attendance(
			participants, metadataErr, speakers,
			meeting.TranscriptState == store.TranscriptComplete, render.Styles{}), "\n"), "\n")
	}
	return nil
}

// transcriptLines renders the transcript, marking a corrected line so nobody
// mistakes an edit for what was said.
func transcriptLines(lines []store.Line) []string {
	rendered := make([]string, 0, len(lines))
	for _, line := range lines {
		text := render.TranscriptLine(line, true)
		if line.Text != line.OriginalText {
			text += " *"
		}
		rendered = append(rendered, text)
	}
	return rendered
}

// openRecording fetches the link live, because it expires within hours.
func (b *browser) openRecording(id string, back backTo) tea.Cmd {
	if id == "" {
		return nil
	}
	b.request++
	b.revision++
	b.detailID, b.back, b.scroll = id, back, 0
	b.view, b.loading = viewDetail, true
	b.title, b.lines = "Recording", []string{"Loading recording..."}
	b.transcript = nil

	request := b.request
	session, _ := sana.LoadSession(b.app.runtime.Paths.Session)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		link, err := sana.RecordingLink(ctx, session, id)
		switch {
		case err != nil:
			return detailMsg{request: request, id: id, title: "Recording",
				lines: []string{"Could not load the recording link: " + err.Error()}}
		case link == "":
			return detailMsg{request: request, id: id, title: "Recording",
				lines: []string{"No recording is available."}}
		}
		return detailMsg{request: request, id: id, title: "Recording",
			lines: []string{link, "", "This link expires after a few hours."}}
	}
}

func (b *browser) openSync(id string, back backTo) {
	b.request++
	b.revision++
	b.detailID, b.back, b.scroll = id, back, 0
	b.view = viewSync
}

// syncDetailLines explains where one meeting is in the sync, in the detail a
// person needs to tell "stuck" from "waiting its turn".
func (b *browser) syncDetailLines(id string) []string {
	meeting, found := b.meeting(id)
	if !found {
		return []string{"This meeting is no longer present in the current filter."}
	}
	lines := []string{
		"Status: " + meeting.Status,
		"Transcript: " + meeting.TranscriptState,
	}
	switch {
	case meeting.TranscriptState == store.TranscriptComplete:
		lines = append(lines, "This meeting is fully downloaded and available.")
	case meeting.Status != store.StatusReady:
		lines = append(lines,
			"Sana is still processing this meeting; it is not in the download queue yet.")
	default:
		lines = append(lines, "Queue: newest meetings are fetched first.")
	}
	if b.info.Status.LastError != "" {
		lines = append(lines, "Last sync error: "+b.info.Status.LastError)
	}
	return lines
}

// body is the lines the current screen scrolls through.
func (b *browser) body() []string {
	switch b.view {
	case viewSync:
		return b.syncDetailLines(b.detailID)
	case viewStatus:
		return b.statusLines()
	case viewHelp:
		return helpLines
	default:
		return b.lines
	}
}

func (b *browser) statusLines() []string {
	info := b.info
	if info.Expired {
		return []string{"Your Sana session has expired. Sign in again."}
	}
	if !info.SignedIn {
		return []string{"You are not signed in to Sana."}
	}
	if info.Unavailable != "" {
		// The counts were never read, so they are not reported. A zero from a
		// database that could not be opened tells someone with two hundred
		// meetings that they have none.
		return []string{"Background sync unavailable: " + info.Unavailable}
	}
	status := info.Status
	lines := []string{
		"Sana session: signed in; access is checked before every sync cycle.",
		"Sync: " + strings.ReplaceAll(status.Phase, "_", " "),
		fmt.Sprintf("Meetings ready: %d", status.Meetings),
	}
	if status.Remaining > 0 {
		lines = append(lines, fmt.Sprintf("Pending: %d", status.Remaining))
	}
	lines = append(lines, fmt.Sprintf("Transcripts stored: %d/%d",
		status.TranscriptsDone, status.TranscriptsTotal))
	if status.UpdatedMS > 0 {
		lines = append(lines, "Last completed sync: "+
			time.UnixMilli(status.UpdatedMS).Local().Format("2006-01-02 15:04:05"))
	}
	if info.HeartbeatMS > 0 {
		lines = append(lines, "Daemon heartbeat: "+
			time.UnixMilli(info.HeartbeatMS).Local().Format("2006-01-02 15:04:05"))
	}
	if status.LastError != "" {
		lines = append(lines, "Sync error: "+status.LastError)
	}
	if info.Unavailable != "" {
		lines = append(lines, "Background sync unavailable: "+info.Unavailable)
	}
	return lines
}
