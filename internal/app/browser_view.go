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
		return b.viewEdit(capacity)

	case b.view == viewHistory:
		return b.viewHistory(capacity)

	case b.view == viewStatus:
		body := b.window(b.statusLines(), capacity)
		if b.failure != "" {
			body = append(body, ui.Red(ui.Truncate("Refresh failed: "+b.failure, width)))
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

// window is the visible slice of a scrolling body, wrapped to the width.
//
// Wrapping rather than cutting is the difference between reading a summary and
// seeing its first eighty characters: these are paragraphs, and the terminal is
// the only place they are shown at all.
//
// The clamp is written back. Clamping a copy left the stored position past the
// end after a resize, so the first arrow key only brought it back in range and
// the screen did not move.
func (b *browser) window(lines []string, capacity int) []tui.Text {
	wrapped := b.wrapped(lines)
	b.scroll = max(0, min(max(0, len(wrapped)-capacity), b.scroll))
	end := min(len(wrapped), b.scroll+capacity)

	visible := make([]tui.Text, 0, max(0, end-b.scroll))
	for index := b.scroll; index < end; index++ {
		visible = append(visible, b.ui.Plain(wrapped[index]))
	}
	return visible
}

// wrapped is the body laid out for this width. Scrolling counts these rows, so
// end of document means the end of what is actually drawn.
//
// The result is kept until the width or the document changes: laying out a
// three-thousand-line transcript takes tens of milliseconds, and it was being
// done on every frame and again on every keypress.
func (b *browser) wrapped(lines []string) []string {
	width := b.ui.Policy.Width()
	// The view is part of the key. Screens share the revision counter, so a
	// cache keyed on that alone handed the keyboard help's rows to the meeting
	// list, which drew them under its own title.
	if b.wrapWidth == width && b.wrapSource == b.revision &&
		b.wrapView == b.view && b.wrapCache != nil {
		return b.wrapCache
	}
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		out = append(out, b.ui.Wrap(line, width)...)
	}
	b.wrapCache, b.wrapWidth, b.wrapSource, b.wrapView = out, width, b.revision, b.view
	return out
}

// tail keeps the last rows of a body that is not scrollable, so a prompt or an
// error appended to the end is never the part that gets clipped away.
func tail(body []tui.Text, capacity int) []tui.Text {
	if capacity <= 0 || len(body) <= capacity {
		return body
	}
	return body[len(body)-capacity:]
}

func (b *browser) viewList() string {
	ui := b.ui
	width := ui.Policy.Width()
	capacity := b.bodyRows()
	// At least one card whenever there is room for any body at all: a terminal
	// too short for three rows would otherwise draw an empty list under a
	// header that says how many meetings there are.
	cards := 0
	if capacity > 0 {
		cards = max(1, capacity/cardHeight)
	}

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
