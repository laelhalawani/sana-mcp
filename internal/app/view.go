package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/store"
)

func (m model) View() string {
	var body string
	switch m.screen {
	case screenMenu:
		body = m.viewMenu()
	case screenMeetings:
		body = m.viewMeetings()
	case screenTranscript:
		body = m.viewTranscript()
	case screenSummary, screenParticipants, screenRecording:
		body = m.viewDetail()
	case screenSearch:
		body = m.viewSearch()
	case screenStatus:
		body = m.viewStatus()
	case screenAccount:
		body = m.viewAccount()
	case screenConfig:
		body = m.viewConfig()
	case screenEdit:
		body = m.viewEdit()
	case screenHistory:
		body = m.viewHistory()
	}
	if m.confirming != "" {
		body += "\n" + m.viewConfirm()
	}
	if m.failure != "" {
		body += "\n" + styleError.Render("  "+m.failure)
	} else if m.message != "" {
		body += "\n" + styleOn.Render("  "+m.message)
	}
	return body
}

func footer(keys string) string {
	return "\n" + styleDim.Render("  "+keys)
}

func (m model) viewMenu() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("sana-mcp") + styleDim.Render("  "+m.version) + "\n\n")
	for index, item := range menuItems {
		pointer := "  "
		label := item
		if index == m.menuCursor {
			pointer = styleCursor.Render("> ")
			label = styleCursor.Render(item)
		}
		fmt.Fprintf(&out, "  %s%s\n", pointer, label)
	}
	out.WriteString("\n  " + styleDim.Render(m.status.Label()))
	return out.String() + footer("up/down navigate  enter select  q quit")
}

func (m model) viewMeetings() string {
	var out strings.Builder
	title := fmt.Sprintf("Meetings  %d", m.meetingTotal)
	if m.nameFilter != "" {
		title += fmt.Sprintf("  name: %q", m.nameFilter)
	}
	if m.statusFilter != "" {
		title += "  status: " + m.statusFilter
	}
	out.WriteString(styleTitle.Render(title) + "\n\n")

	if m.filtering {
		fmt.Fprintf(&out, "  Filter by name: %s\n\n", m.filterInput)
	}
	if len(m.meetings) == 0 {
		out.WriteString(styleDim.Render("  No meetings yet. Sync runs in the background.") + "\n")
	}
	for index, meeting := range m.meetings {
		pointer := "  "
		title := meeting.Title
		if index == m.meetingCursor {
			pointer = styleCursor.Render("> ")
			title = styleCursor.Render(title)
		}
		fmt.Fprintf(&out, "%s%s\n", pointer, title)
		fmt.Fprintf(&out, "    %s  %d words  %s\n",
			time.UnixMilli(meeting.CreatedMS).Format("2006-01-02 15:04"),
			meeting.WordCount,
			styleDim.Render(meeting.Status))
	}
	pages := 1
	if m.pageSize() > 0 {
		pages = (m.meetingTotal + m.pageSize() - 1) / m.pageSize()
	}
	fmt.Fprintf(&out, "\n  %s", styleDim.Render(fmt.Sprintf("page %d of %d", m.meetingPage, max(pages, 1))))
	return out.String() + footer(
		"enter/t transcript  s summary  p participants  o recording  / name  f status  PgUp/PgDn page  esc menu")
}

func (m model) viewTranscript() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render(m.current.Title) + "\n\n")
	visible := m.height - 6
	end := min(len(m.lines), m.offset+visible)
	for index := m.offset; index < end; index++ {
		line := m.lines[index]
		pointer := " "
		if index == m.lineCursor {
			pointer = styleCursor.Render(">")
		}
		text := line.Text
		// A corrected line is marked, so nobody mistakes an edit for what was
		// said. The original stays one keypress away under h.
		marker := ""
		if line.Text != line.OriginalText {
			marker = styleWarn.Render(" *")
		}
		fmt.Fprintf(&out, "%s %d [%s] %s: %s%s\n",
			pointer, line.LineNo, clock(line.StartMS), line.Speaker, text, marker)
	}
	return out.String() + footer(
		"up/down scroll  e edit line  h history  t/s/p/o switch  esc meetings  q quit")
}

func (m model) viewDetail() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render(m.current.Title) + "\n\n")
	out.WriteString(m.detail + "\n")
	return out.String() + footer("t transcript  s summary  p participants  o recording  esc meetings")
}

func (m model) viewSearch() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Search transcripts") + "\n\n")
	if m.searchTyped {
		fmt.Fprintf(&out, "  > %s\n", m.queryInput)
		return out.String() + footer("enter search  esc menu")
	}
	if m.searching {
		out.WriteString(styleDim.Render("  Searching...") + "\n")
		return out.String() + footer("esc edit query")
	}
	if len(m.hits) == 0 {
		fmt.Fprintf(&out, "  Nothing matched %q.\n\n", m.query)
		out.WriteString(styleDim.Render(
			"  Transcripts come from speech recognition, so a name may be spelled\n"+
				"  differently than you expect. Try a distinctive word from the same\n"+
				"  discussion instead.") + "\n")
		return out.String() + footer("esc edit query")
	}
	fmt.Fprintf(&out, "  %d results for %q\n\n", len(m.hits), m.query)
	visible := (m.height - 8) / 2
	start := max(0, m.hitCursor-visible+1)
	for index := start; index < min(len(m.hits), start+visible); index++ {
		hit := m.hits[index]
		pointer := "  "
		if index == m.hitCursor {
			pointer = styleCursor.Render("> ")
		}
		fmt.Fprintf(&out, "%s%s  %s  line %d\n", pointer,
			hit.Title, styleDim.Render(time.UnixMilli(hit.CreatedMS).Format("2006-01-02")), hit.LineNo)
		fmt.Fprintf(&out, "    %s\n", styleDim.Render(truncate(strings.TrimSpace(hit.Text), m.width-6)))
	}
	return out.String() + footer("up/down navigate  enter open at that line  esc edit query  q quit")
}

func (m model) viewStatus() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Sync status") + "\n\n")
	fmt.Fprintf(&out, "  %s\n\n", m.status.Label())
	fmt.Fprintf(&out, "  %s\n", progressBar(m.status.TranscriptsDone, m.status.TranscriptsTotal, 30))
	fmt.Fprintf(&out, "  transcripts   %d of %d\n", m.status.TranscriptsDone, m.status.TranscriptsTotal)
	fmt.Fprintf(&out, "  meetings      %d of %d\n", m.status.Meetings, m.status.MeetingsTotal)
	if m.status.Remaining > 0 {
		fmt.Fprintf(&out, "  remaining     %d\n", m.status.Remaining)
	}
	if m.status.LastError != "" {
		out.WriteString("  " + styleError.Render(m.status.LastError) + "\n")
	}
	return out.String() + footer("esc menu")
}

func (m model) viewAccount() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Sana account") + "\n\n")
	if m.session == nil || m.session.Cookies["sana-ai-session"] == "" {
		out.WriteString("  Not signed in.\n\n")
		out.WriteString(styleDim.Render("  Sign in with: sana-mcp login") + "\n")
		return out.String() + footer("esc menu")
	}
	fmt.Fprintf(&out, "  Signed in as %s\n", m.session.Email)
	fmt.Fprintf(&out, "  Workspace    %s\n", m.session.WorkspaceID)
	return out.String() + footer("esc menu")
}

func (m model) viewConfig() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Configuration") + "\n\n")
	fmt.Fprintf(&out, "  Data          %s\n", m.runtime.Paths.Root)
	fmt.Fprintf(&out, "  Sync every    %d minutes\n", m.runtime.Config.SyncIntervalMinutes)
	fmt.Fprintf(&out, "  Search        keyword (BM25)\n")
	out.WriteString("\n" + styleDim.Render("  Change which AI clients are connected: sana-mcp configure") + "\n")
	return out.String() + footer("esc menu")
}

func (m model) viewEdit() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Edit line "+fmt.Sprint(m.editLine)) + "\n\n")
	original := ""
	for _, line := range m.lines {
		if line.LineNo == m.editLine {
			original = line.OriginalText
			break
		}
	}
	out.WriteString(styleDim.Render("  As transcribed: "+original) + "\n\n")
	fmt.Fprintf(&out, "  %s\n", m.editBuffer)
	out.WriteString("\n" + styleWarn.Render(
		"  Transcripts contain real product and personal names that look like\n"+
			"  misspellings. Only correct what you know is wrong.") + "\n")
	return out.String() + footer("ctrl+s save  esc cancel")
}

func (m model) viewHistory() string {
	var out strings.Builder
	out.WriteString(styleTitle.Render("Edits in "+m.current.Title) + "\n\n")
	if len(m.history) == 0 {
		out.WriteString(styleDim.Render("  Nothing in this meeting has been changed.") + "\n")
		return out.String() + footer("esc transcript")
	}
	for index, edit := range m.history {
		pointer := "  "
		if index == m.historyCursor {
			pointer = styleCursor.Render("> ")
		}
		fmt.Fprintf(&out, "%sline %d  %s  %s  %s\n", pointer, edit.LineNo,
			time.UnixMilli(edit.EditedMS).Format("2006-01-02 15:04"),
			edit.Author, styleDim.Render(edit.State))
		fmt.Fprintf(&out, "    %s %s\n", styleDim.Render("original:"), truncate(edit.OriginalText, m.width-16))
		fmt.Fprintf(&out, "    %s  %s\n", styleDim.Render("current: "), truncate(edit.EditedText, m.width-16))
	}
	return out.String() + footer("up/down navigate  r restore original  esc transcript")
}

func (m model) viewConfirm() string {
	switch m.confirming {
	case "save":
		return styleWarn.Render("  Save this correction? [y/n]")
	case "discard":
		return styleWarn.Render("  Discard your changes? [y/n]")
	case "restore":
		if m.historyCursor < len(m.history) {
			return styleWarn.Render(fmt.Sprintf(
				"  Restore line %d to what Sana delivered? [y/n]", m.history[m.historyCursor].LineNo))
		}
	}
	return ""
}

func progressBar(done, total, width int) string {
	if total <= 0 {
		return "[" + strings.Repeat("-", width) + "]"
	}
	filled := done * width / total
	filled = max(0, min(width, filled))
	return "[" + strings.Repeat("#", filled) + strings.Repeat("-", width-filled) + "]"
}

func truncate(text string, width int) string {
	if width < 8 {
		width = 8
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	return string(runes[:width-1]) + "…"
}

var _ = store.PhaseSynced
