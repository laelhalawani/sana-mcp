package app

import (
	"fmt"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// meetingCard is one meeting: a pointer and its title, a rail and its metadata,
// then a blank row. Three rows always, so the list does not reflow as titles
// change length.
func meetingCard(meeting store.Meeting, selected bool, width int, ui tui.UI) []tui.Text {
	pointer, rail := " ", " "
	if selected {
		pointer, rail = ui.Glyphs.Pointer, ui.Glyphs.Rail
	}
	if width <= 2 {
		padding := strings.Repeat(" ", max(0, width-1))
		if selected {
			return []tui.Text{
				ui.Line(ui.Cyan(pointer), padding),
				ui.Line(ui.Cyan(rail), padding),
				"",
			}
		}
		return []tui.Text{ui.Line(pointer, padding), ui.Line(rail, padding), ""}
	}

	contentWidth := width - 2
	title := ui.Truncate(meeting.Title, contentWidth)
	titleText := ui.Plain(title)
	pointerText := ui.Plain(pointer)
	railText := ui.Plain(rail)
	if selected {
		titleText = ui.Bold(title)
		pointerText = ui.Cyan(pointer)
		railText = ui.Cyan(rail)
	}

	status := statusLabel(displayStatus(meeting))
	date := render.Timestamp(meeting.CreatedMS)
	words := fmt.Sprintf("%d words", meeting.WordCount)
	if meeting.WordCount == 1 {
		words = "1 word"
	}
	// The metadata sheds what does not fit, cheapest first, rather than being
	// truncated mid-word.
	metadata := []string{date, words, status}
	if render.DisplayWidth(strings.Join(metadata, "  ")) > contentWidth {
		metadata = []string{date, status}
	}
	if render.DisplayWidth(strings.Join(metadata, "  ")) > contentWidth {
		metadata = []string{status}
	}
	preceding := ""
	if len(metadata) > 1 {
		preceding = strings.Join(metadata[:len(metadata)-1], "  ") + "  "
	}
	visibleStatus := ui.Truncate(status, max(0, contentWidth-render.DisplayWidth(preceding)))

	styled := ui.Yellow(visibleStatus)
	switch displayStatus(meeting) {
	case store.StatusReady:
		styled = ui.Green(visibleStatus)
	case statusDownloading:
		styled = ui.Cyan(visibleStatus)
	}
	return []tui.Text{
		ui.Line(pointerText, " ", titleText),
		ui.Line(railText, " ", preceding, styled),
		"",
	}
}

// statusDownloading is a display state, not a stored one: Sana has finished
// with the meeting and this program has not fetched the transcript yet. It
// tells "waiting on Sana" apart from "waiting on us", which is the first thing
// anyone asks about a meeting that is not readable.
const statusDownloading = "downloading"

func displayStatus(meeting store.Meeting) string {
	if meeting.Status == store.StatusReady && meeting.TranscriptState != store.TranscriptComplete {
		return statusDownloading
	}
	return meeting.Status
}

// statusLabel capitalises a meeting status for display.
func statusLabel(status string) string {
	if status == "" {
		return "Unknown"
	}
	return strings.ToUpper(status[:1]) + status[1:]
}

func (b *browser) View() string {
	if b.done {
		return ""
	}
	ui := b.ui
	width := ui.Policy.Width()
	capacity := b.bodyRows()

	switch {
	case b.filterInput != nil:
		header := "Filter meetings"
		body := []tui.Text{
			ui.Plain("Type part of a meeting title"),
			ui.Line("/ ", *b.filterInput),
		}
		if capacity == 0 {
			header = "Filter: " + *b.filterInput
		}
		if capacity == 1 {
			body = body[1:]
		}
		return ui.Screen(header, body, "enter apply  esc cancel")

	case b.statusInput != nil:
		selected := *b.statusInput
		top := max(0, min(selected-max(0, capacity-1), max(0, len(statusFilters)-capacity)))
		var body []tui.Text
		for index := top; index < min(len(statusFilters), top+capacity); index++ {
			pointer := " "
			if index == selected {
				pointer = ui.Glyphs.Pointer
			}
			label := statusFilters[index]
			if label == "all" {
				label = "All statuses"
			}
			body = append(body, ui.Plain(pointer+" "+label))
		}
		return ui.Screen(
			fmt.Sprintf("Filter meetings by status (%d/%d)", selected+1, len(statusFilters)),
			body, "up/down choose  enter apply  esc cancel")

	case b.view == viewEdit:
		return b.viewEdit()

	case b.view == viewHistory:
		return b.viewHistory()

	case b.view == viewStatus:
		body := b.window(b.statusLines(), capacity)
		if b.failure != "" {
			body = append(body, ui.Red("Refresh failed: "+b.failure))
		}
		return ui.Screen("Sync status", body, ui.AdaptiveFooter(width,
			"auto-refreshing  r refresh  esc meetings  q quit",
			"r refresh  esc meetings  q quit",
			"r refresh  esc back  q quit",
			"esc back  q quit",
			"esc back",
			"q"))

	case b.view == viewHelp:
		return ui.Screen("Keyboard help", b.window(helpLines, capacity),
			ui.AdaptiveFooter(width,
				"up/down scroll  esc meetings  q quit",
				"up/down scroll  esc back",
				"esc back  q quit",
				"esc back",
				"q"))

	case b.view == viewActions:
		top := max(0, min(b.action-max(0, capacity-1), max(0, len(meetingActions)-capacity)))
		var body []tui.Text
		for index := top; index < min(len(meetingActions), top+capacity); index++ {
			pointer := " "
			if index == b.action {
				pointer = ui.Glyphs.Pointer
			}
			body = append(body, ui.Plain(pointer+" "+meetingActions[index].label))
		}
		return ui.Screen(b.title, body, ui.AdaptiveFooter(width,
			"up/down choose  enter open  t transcript  s summary  p participants  o recording  esc meetings",
			"up/down choose  enter open  t/s/p/o open  esc meetings",
			"enter open  t/s/p/o open  esc back",
			"enter open  esc back",
			"esc back",
			"q"))

	case b.view == viewSync:
		meeting, _ := b.meeting(b.detailID)
		name := meeting.Title
		if name == "" {
			name = b.detailID
		}
		return ui.Screen("Sync details | "+name,
			b.window(b.syncDetailLines(b.detailID), capacity),
			ui.AdaptiveFooter(width,
				"auto-refreshing  pgup/pgdn page  t/s/p/o switch  esc "+string(b.back)+"  q quit",
				"pgup/pgdn page  t/s/p/o switch  esc "+string(b.back),
				"t/s/p/o switch  esc "+string(b.back),
				"esc "+string(b.back)+"  q quit",
				"esc back",
				"q"))

	case b.view == viewDetail:
		header := b.title
		if b.loading {
			header = "Loading: " + b.title
		}
		back := "meetings"
		if b.back == backActions {
			back = "actions"
		}
		footers := []string{
			"up/down scroll  pgup/pgdn page  t/s/p/o switch  esc " + back + "  q quit",
			"pgup/pgdn page  t/s/p/o switch  esc " + back,
			"t/s/p/o switch  esc " + back,
			"esc " + back + "  q quit",
			"esc back",
			"q",
		}
		if len(b.transcript) > 0 {
			footers = append([]string{
				"up/down scroll  e edit line  h history  t/s/p/o switch  esc " + back + "  q quit",
			}, footers...)
		}
		return ui.Screen(header, b.window(b.lines, capacity), ui.AdaptiveFooter(width, footers...))
	}

	return b.viewList()
}

// window is the visible slice of a scrolling body, clamped to what exists.
func (b *browser) window(lines []string, capacity int) []tui.Text {
	maximum := max(0, len(lines)-capacity)
	scroll := max(0, min(maximum, b.scroll))
	end := min(len(lines), scroll+capacity)

	visible := make([]tui.Text, 0, max(0, end-scroll))
	for index := scroll; index < end; index++ {
		visible = append(visible, b.ui.Plain(lines[index]))
	}
	return visible
}

func (b *browser) viewList() string {
	ui := b.ui
	width := ui.Policy.Width()
	capacity := b.bodyRows()
	cards := max(0, capacity/cardHeight)

	// Before the first listing there is nothing to draw a list of, and an empty
	// list would read as "you have no meetings".
	if b.info.Preparing() {
		return ui.Screen("sana-mcp | preparing meeting cache",
			b.window(b.statusLines(), capacity),
			"auto-refreshing  r refresh  i status  esc menu  q quit")
	}

	header := fmt.Sprintf("Meetings | %d ready", b.info.Status.Meetings)
	if b.info.Status.Remaining > 0 {
		header += fmt.Sprintf(" | %d syncing", b.info.Status.Remaining)
	}
	if b.filter != "" {
		header += " | name: " + b.filter
	}
	if b.statusFilter != "" {
		header += " | status: " + b.statusFilter
	}

	index := b.selectedIndex()
	top := max(0, min(b.listTop, max(0, len(b.meetings)-cards)))
	if cards > 0 && index >= 0 {
		if index < top {
			top = index
		}
		if index >= top+cards {
			top = index - cards + 1
		}
	}

	var body []tui.Text
	for position := top; position < min(len(b.meetings), top+cards); position++ {
		meeting := b.meetings[position]
		body = append(body, meetingCard(meeting, meeting.MeetingID == b.selected, width, ui)...)
	}
	if len(body) == 0 && capacity > 0 {
		message := "No ready or syncing meetings found."
		if b.filter != "" || b.statusFilter != "" {
			message = "No meetings match the current filters. Press / or f to edit, or c to clear."
		}
		if b.failure != "" {
			message = "Could not read meetings: " + b.failure
		}
		body = []tui.Text{ui.Plain(message)}
	}

	return ui.Screen(header, body, ui.AdaptiveFooter(width,
		"Enter actions  t transcript  s summary  p participants  o recording  PgUp/PgDn page  / name filter  f status filter",
		"Enter actions  t/s/p/o open  PgUp/PgDn page  / name  f status",
		"Enter actions  t/s/p/o open  PgUp/PgDn page",
		"Enter actions  up/down move",
		"Enter open  up/down move",
		"Enter open",
		"q"))
}
