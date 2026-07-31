package app

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// Transcript correction.
//
// A transcript is what speech recognition heard, and it garbles exactly the
// words that matter most: product names, company names, people. Correcting a
// line makes it findable again.
//
// The warning on the edit screen is not decoration. A name that looks
// misspelled is very often real, and a correction that "fixes" it destroys the
// only record of what was said. Nothing is written without an explicit y.

// editWarning is shown on every edit, every time.
const editWarning = "Transcripts contain real product and personal names that look like " +
	"misspellings. Only change what you know is wrong."

// beginEdit opens the editor on the line under the scroll position.
func (b *browser) beginEdit() tea.Cmd {
	line, found := b.lineAtScroll()
	if !found {
		return nil
	}
	b.view = viewEdit
	b.editLine = line.LineNo
	b.editBuffer = line.Text
	b.confirm = ""
	return nil
}

// lineAtScroll is the transcript line the top of the visible body is showing.
// The document view scrolls rather than carrying a cursor, so the line being
// read is the one being offered for editing.
func (b *browser) lineAtScroll() (store.Line, bool) {
	if len(b.transcript) == 0 {
		return store.Line{}, false
	}
	index := max(0, min(len(b.transcript)-1, b.scroll))
	return b.transcript[index], true
}

func (b *browser) originalText(lineNo int) string {
	for _, line := range b.transcript {
		if line.LineNo == lineNo {
			return line.OriginalText
		}
	}
	return ""
}

func (b *browser) currentText(lineNo int) string {
	for _, line := range b.transcript {
		if line.LineNo == lineNo {
			return line.Text
		}
	}
	return ""
}

func (b *browser) editKey(key tea.KeyMsg, name string) tea.Cmd {
	switch name {
	case "ctrl+s":
		if strings.TrimSpace(b.editBuffer) == "" {
			b.failure = "A line cannot be emptied. Press esc to leave it unchanged."
			return nil
		}
		b.confirm = "save"
	case "esc":
		// Leaving with unsaved changes asks first: the whole point of the
		// screen is that nothing is written by accident, and that cuts both
		// ways.
		if b.editBuffer != b.currentText(b.editLine) {
			b.confirm = "discard"
			return nil
		}
		b.view = viewDetail
	default:
		if value, changed := tui.Typed(b.editBuffer, key); changed {
			b.editBuffer = value
			b.failure = ""
		}
	}
	return nil
}

func (b *browser) openHistory() {
	edits, err := b.app.store.LineHistory(b.detailID, 0)
	if err != nil {
		b.failure = err.Error()
		return
	}
	b.history, b.historyRow = edits, 0
	b.view = viewHistory
}

func (b *browser) historyKey(name string) tea.Cmd {
	switch name {
	case "q":
		return b.quit()
	case "esc":
		b.view = viewDetail
	case "up", "k":
		b.historyRow = tui.Wrap(b.historyRow, -1, len(b.history))
	case "down", "j":
		b.historyRow = tui.Wrap(b.historyRow, 1, len(b.history))
	case "r":
		if b.historyRow < len(b.history) {
			b.confirm = "restore"
		}
	}
	return nil
}

// confirmKey answers a pending y/n. Anything that is not y is no.
func (b *browser) confirmKey(name string) tea.Cmd {
	pending := b.confirm
	if name != "y" && name != "n" && name != "esc" {
		return nil
	}
	b.confirm = ""
	if name != "y" {
		return nil
	}

	switch pending {
	case "save":
		_, err := b.app.store.EditLine(
			b.detailID, b.editLine, b.originalText(b.editLine), b.editBuffer, store.AuthorUser)
		if err != nil {
			b.failure = err.Error()
			return nil
		}
		b.reloadTranscript()
		b.view = viewDetail
	case "discard":
		b.view = viewDetail
	case "restore":
		edit := b.history[b.historyRow]
		if err := b.app.store.RestoreLine(edit.MeetingID, edit.LineNo); err != nil {
			b.failure = err.Error()
			return nil
		}
		b.reloadTranscript()
		b.openHistory()
	}
	return nil
}

// reloadTranscript rereads the lines so the marker and the text on screen are
// what is now stored.
func (b *browser) reloadTranscript() {
	lines, err := b.app.store.Lines(b.detailID, 0, 0)
	if err != nil {
		b.failure = err.Error()
		return
	}
	b.transcript = lines
	b.lines = transcriptLines(lines)
}

func (b *browser) viewEdit() string {
	ui := b.ui
	width := ui.Policy.Width()

	body := []tui.Text{ui.Dim("As transcribed: " + b.originalText(b.editLine))}
	body = append(body, "")
	for _, line := range ui.Wrap(b.editBuffer, width) {
		body = append(body, ui.Cyan(line))
	}
	body = append(body, "")
	for _, line := range ui.Wrap(editWarning, width) {
		body = append(body, ui.Yellow(line))
	}
	if b.failure != "" {
		body = append(body, "", ui.Red(ui.Truncate(b.failure, width)))
	}
	if b.confirm != "" {
		body = append(body, "", ui.Yellow(b.confirmQuestion()))
	}
	return ui.Screen(fmt.Sprintf("Edit line %d", b.editLine), body, "ctrl+s save  esc cancel")
}

func (b *browser) viewHistory() string {
	ui := b.ui
	width := ui.Policy.Width()

	var body []tui.Text
	if len(b.history) == 0 {
		body = append(body, ui.Dim("Nothing in this meeting has been changed."))
	}
	for index, edit := range b.history {
		pointer := " "
		if index == b.historyRow {
			pointer = ui.Glyphs.Pointer
		}
		body = append(body,
			ui.Plain(fmt.Sprintf("%s line %d  %s  %s  %s",
				pointer, edit.LineNo, render.Timestamp(edit.EditedMS), edit.Author, edit.State)),
			ui.Line("    ", ui.Dim("as transcribed:"), " ",
				ui.Truncate(edit.OriginalText, max(1, width-20))),
			ui.Line("    ", ui.Dim("now reads:     "), " ",
				ui.Truncate(edit.EditedText, max(1, width-20))),
			"",
		)
	}
	if b.confirm != "" {
		body = append(body, ui.Yellow(b.confirmQuestion()))
	}
	return ui.Screen("Edits in "+b.title, body,
		"up/down navigate  r restore what Sana delivered  esc transcript")
}

func (b *browser) confirmQuestion() string {
	switch b.confirm {
	case "save":
		return "Save this correction? [y/n]"
	case "discard":
		return "Discard your changes? [y/n]"
	case "restore":
		if b.historyRow < len(b.history) {
			return fmt.Sprintf("Restore line %d to what Sana delivered? [y/n]",
				b.history[b.historyRow].LineNo)
		}
	}
	return ""
}
