// Package render lays out domain values as text.
//
// The CLI, the MCP server, and the interactive application all show the same
// things - a summary document, a participant list, sync progress, a transcript
// timestamp - and each used to carry its own copy of the layout. The copies had
// already drifted: one tested a summary for emptiness after trimming and
// another did not, one printed a stray gap for a participant with no email.
//
// Colour is the only real difference between the surfaces, so it is passed in.
// A zero Styles renders plain text, which is what the CLI and the MCP server
// want; the application supplies its lipgloss functions.
package render

import (
	"fmt"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// NoMatchHint explains an empty search result. Transcripts come from speech
// recognition, so the most likely reason a name is not found is that it was not
// heard the way the user spells it.
const NoMatchHint = "Transcripts come from speech recognition, so a name may be spelled " +
	"differently than you expect. Try a distinctive word from the same discussion instead."

// Styles carries the optional decoration a surface wants. A nil function means
// "leave the text alone", so the zero value renders plain.
type Styles struct {
	Heading func(string) string
	Dim     func(string) string
	Accent  func(string) string
}

func (s Styles) heading(text string) string { return apply(s.Heading, text) }
func (s Styles) dim(text string) string     { return apply(s.Dim, text) }
func (s Styles) accent(text string) string  { return apply(s.Accent, text) }

func apply(style func(string) string, text string) string {
	if style == nil {
		return text
	}
	return style(text)
}

// Summary lays out a meeting's summary document: the summary itself, then notes
// grouped by topic, then action items as "assignee: action (due date)".
func Summary(metadata sana.Metadata, styles Styles) string {
	var out strings.Builder
	if metadata.Summary != nil && strings.TrimSpace(*metadata.Summary) != "" {
		out.WriteString(strings.TrimSpace(*metadata.Summary) + "\n\n")
	}
	for _, group := range metadata.Notes {
		out.WriteString(styles.heading(group.Topic) + "\n")
		for _, note := range group.Notes {
			fmt.Fprintf(&out, "  - %s\n", note)
		}
		out.WriteString("\n")
	}
	if len(metadata.ActionItems) > 0 {
		out.WriteString(styles.heading("Action items") + "\n")
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
		return "This meeting has no summary yet.\n"
	}
	return out.String()
}

// Participants lists attendees. An absent email prints nothing rather than a
// gap, which one of the three previous copies got wrong.
func Participants(participants []sana.Participant, styles Styles) string {
	if len(participants) == 0 {
		return "No participants are recorded for this meeting.\n"
	}
	var out strings.Builder
	for _, participant := range participants {
		email := ""
		if participant.Email != nil && *participant.Email != "" {
			email = "  " + styles.dim(*participant.Email)
		}
		host := ""
		if participant.IsHost {
			host = "  " + styles.accent("(host)")
		}
		fmt.Fprintf(&out, "%s%s%s\n", participant.DisplayName, email, host)
	}
	return out.String()
}

// StatusLines reports sync coverage. The label column is aligned here once, so
// the three surfaces cannot drift apart by a space.
func StatusLines(status store.Status) string {
	var out strings.Builder
	fmt.Fprintf(&out, "meetings      %d of %d downloaded\n", status.Meetings, status.MeetingsTotal)
	fmt.Fprintf(&out, "transcripts   %d of %d\n", status.TranscriptsDone, status.TranscriptsTotal)
	if status.Remaining > 0 {
		fmt.Fprintf(&out, "remaining     %d\n", status.Remaining)
	}
	if status.LastError != "" {
		fmt.Fprintf(&out, "last error    %s\n", status.LastError)
	}
	return out.String()
}

// ProgressBar draws a fixed-width bar. An unknown total renders as an empty
// bar rather than a full one, and keeps its frame so the layout does not jump
// when the first count arrives.
func ProgressBar(done, total, width int) string {
	if total <= 0 {
		return "[" + strings.Repeat("-", width) + "]"
	}
	filled := done * width / total
	filled = max(0, min(width, filled))
	return "[" + strings.Repeat("#", filled) + strings.Repeat("-", width-filled) + "]"
}

// Clock formats a position within a meeting. Hours are carried into the minutes
// field rather than truncated, so a two-hour meeting reads 1:05:03 and not 5:03.
func Clock(ms int64) string {
	seconds := ms / 1000
	if hours := seconds / 3600; hours > 0 {
		return fmt.Sprintf("%d:%02d:%02d", hours, (seconds%3600)/60, seconds%60)
	}
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

// Timestamp formats a meeting's date and time.
func Timestamp(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02 15:04") }

// Date formats a meeting's date alone.
func Date(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") }

// Truncate shortens text to width, marking that it was cut.
func Truncate(text string, width int) string {
	if width < 8 {
		width = 8
	}
	runes := []rune(text)
	if len(runes) <= width {
		return text
	}
	return string(runes[:width-1]) + "…"
}
