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
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// Count renders a quantity with its noun made singular or plural, so no surface
// has to say "1 lines".
func Count(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// SummaryNotDownloaded is what every surface says when a meeting's summary
// document has not arrived yet, which is not the same as it having none. It
// lives here because the CLI, the MCP server and the application all say it,
// and three copies of a sentence is how they drifted apart last time.
const SummaryNotDownloaded = "The summary for this meeting has not been downloaded yet."

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
			if item.DueDate.Set() {
				due = " (due " + item.DueDate.String() + ")"
			}
			fmt.Fprintf(&out, "  - %s%s%s\n", assignee, item.Action, due)
		}
	}
	if out.Len() == 0 {
		return "This meeting has no summary.\n"
	}
	return out.String()
}

// Attendance lays out who a meeting involved, as two separately labelled
// groups, because the two answers come from different places and neither one is
// attendance.
//
// Sana's participant endpoint returns the workspace members with access to the
// meeting, which is a small fixed roster rather than who turned up: measured
// across 241 meetings, 49% had no listed participant speak at all, and the whole
// corpus held 138 distinct speakers against 12 distinct participant names. The
// speakers come from the transcript's own diarization. Reporting either alone as
// "attendees" is what this replaces; merging them would invent a third thing
// neither source supports.
//
// membersErr is whatever reading the roster returned, and transcriptFetched
// whether the transcript arrived. They exist because "empty", "not downloaded
// yet" and "stored but unreadable" are three different answers and only the
// first is "none" - mid-sync, reporting the second as the first tells an agent
// a meeting had no members when nothing had arrived.
func Attendance(
	participants []sana.Participant, membersErr error,
	speakers []store.Speaker, transcriptFetched bool, styles Styles,
) string {
	var out strings.Builder

	// A non-empty list is itself proof its source arrived, so the flags only
	// decide anything when a list is empty. Consulting them regardless let a
	// caller with a stale flag print "Not downloaded yet" directly above the
	// rows it had just been handed.
	membersHere := membersErr == nil || len(participants) > 0
	speakersHere := transcriptFetched || len(speakers) > 0
	shown := shownSpeakers(speakers)

	out.WriteString(styles.heading(
		groupHeading("Workspace members with access", len(participants), membersHere)) + "\n")
	switch {
	case !membersHere && !errors.Is(membersErr, store.ErrNotFound):
		// Stored but undecodable is a third thing, and saying either of the
		// others about it is false. It must not take the speakers down with it:
		// they come from the transcript, which is intact.
		out.WriteString("  Could not be read: " + styles.dim("the stored document is corrupt") + "\n")
	case !membersHere:
		out.WriteString("  Not downloaded yet.\n")
	case len(participants) == 0:
		out.WriteString("  None are recorded for this meeting.\n")
	}
	for _, participant := range participants {
		out.WriteString("  " + participantLine(participant, styles) + "\n")
	}

	out.WriteString("\n" + styles.heading(
		groupHeading("Speakers in the transcript", len(shown), speakersHere)) + "\n")
	switch {
	case !speakersHere:
		out.WriteString("  Not downloaded yet.\n")
	case len(shown) == 0:
		// The transcript is here and still names nobody, which is what
		// diarization producing no labels looks like. Saying "not downloaded"
		// would be false; saying "none" without knowing would be too.
		out.WriteString("  None are named in this transcript.\n")
	}
	// The name column is padded so the counts line up, which is what makes the
	// difference between someone who presented and someone who said one word
	// legible at a glance.
	//
	// Padded by display width rather than by %-*s. Go pads that by runes, which
	// is right for an accented Latin name - "Łukasz" is more bytes than runes
	// but one column per rune - and wrong wherever a rune is not one column: a
	// CJK name is two columns per rune, and a combining accent is zero.
	width := 0
	for _, speaker := range shown {
		if n := DisplayWidth(speaker.name); n > width {
			width = n
		}
	}
	for _, speaker := range shown {
		padding := strings.Repeat(" ", max(0, width-DisplayWidth(speaker.name)))
		fmt.Fprintf(&out, "  %s%s  %s\n", speaker.name, padding,
			styles.dim(Count(speaker.lines, "line")))
	}

	out.WriteString("\nNeither list is attendance: a member with access may not have attended, " +
		"and someone who attended without speaking never appears as a speaker.\n")
	return out.String()
}

// shownSpeaker is one speaker row as it will be printed.
type shownSpeaker struct {
	name  string
	lines int
}

// shownSpeakers resolves each label to what the row will actually say, and
// folds the ones that come out the same.
//
// Scrubbed exactly as a member name is. Both groups go into one document, so
// its conventions are document-wide: the angle brackets mean "this is an
// address" and "(host)" is a claim about a person, wherever either appears. A
// diarization label of "Mallory <ceo@corp.example>" would otherwise read as an
// address two lines under a member rendered in exactly that form, and one of
// "Zara Nolan (host)" would answer "who hosted?" with a marker no host flag
// backs. Two groups under one convention need one rule.
//
// The fold repeats what the store already did, because it can now see more. The
// store folds what TrimSpace can see; sanitising removes format characters it
// keeps, so two labels differing only by an invisible mark arrive distinct and
// would render as two identical rows with the count split between them - the
// failure the store's fold exists to prevent, one layer later.
func shownSpeakers(speakers []store.Speaker) []shownSpeaker {
	shown := make([]shownSpeaker, 0, len(speakers))
	at := map[string]int{}
	for _, speaker := range speakers {
		name := scrubbed(speaker.Name)
		if name == "" {
			name = "Unnamed speaker"
		}
		if index, folded := at[name]; folded {
			shown[index].lines += speaker.Lines
			continue
		}
		at[name] = len(shown)
		shown = append(shown, shownSpeaker{name: name, lines: speaker.Lines})
	}
	return shown
}

// groupHeading titles one of the two lists. A count is only printed for a source that
// has actually been downloaded: "(0)" beside "Not downloaded yet" reads to
// anything parsing the heading as "this meeting has no members", which is the
// claim the fetched flags exist to avoid making.
func groupHeading(label string, count int, fetched bool) string {
	if !fetched {
		return label
	}
	return fmt.Sprintf("%s (%d)", label, count)
}

// bracketless removes the delimiters that identify an address, so nothing
// rendered inside a participant line can forge or truncate one.
var bracketless = strings.NewReplacer("<", "", ">", "")

// scrubbed is the one pipeline every identity field goes through: the two names
// and the address. Spelling it out at each call site is how they drift, which
// is the drift this package exists to prevent.
//
// It is deliberately short. These names come from the workspace's own directory
// and from Sana's diarization, not from anywhere adversarial, so this defends
// against malformed data rather than against someone trying to forge a field.
func scrubbed(text string) string {
	return collapsed(Sanitize(bracketless.Replace(text)))
}

// collapsed trims a name and reduces every internal whitespace run to one
// space. The speaker rows separate the name from its count with a run of
// spaces, so a name containing one of its own mis-splits a naive parser - and
// removing a marker from the middle of a name leaves a double space behind.
func collapsed(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// participantLine renders one workspace member unambiguously.
//
// The email is wrapped in angle brackets so it identifies itself. Both it and
// the host marker are optional and used to be separated by the same two spaces,
// which gave the line six possible shapes - and a host with no email put
// "(host)" exactly where a parser expects an address. An absent name falls back
// to the email and then to a placeholder, so no line is ever blank; that
// fallback existed in the original implementation and was lost in the rewrite.
func participantLine(participant sana.Participant, styles Styles) string {
	// Both fields go through the same scrub, because the document's conventions
	// are document-wide: an address is delimited and "(host)" is a claim
	// wherever either appears, so an address of "roy@example.com (host)" would
	// otherwise put a marker no host flag backs into the output.
	//
	// Sanitised and trimmed before the emptiness test, not after. A name that is
	// only whitespace, or only characters that sanitise away, would otherwise
	// pass "not empty", skip the fallback and render as the blank line this
	// function exists to prevent - and a name carrying a newline would break the
	// one-line-per-participant shape that delimiting the address guarantees.
	// The brackets are stripped from both sides, not just the name. An address
	// carrying its own would close the field early, and a consumer taking the
	// first delimited run gets a truncated address - the same hazard the name
	// is stripped for, from the other direction.
	email := ""
	if participant.Email != nil {
		email = scrubbed(*participant.Email)
	}
	// Angle brackets are what make the address self-identifying, so a display
	// name is not allowed to contain them, nor the host marker.
	// "Roy <roy@elsewhere.example>" would otherwise render two bracketed fields
	// and hand a parser the wrong address, and a name ending "(host)" would be
	// indistinguishable from a real one - the two-space hazard in two new
	// shapes.
	name := scrubbed(participant.DisplayName)
	fields := []string{}
	switch {
	case name != "":
		fields = append(fields, name)
		if email != "" {
			fields = append(fields, styles.dim("<"+email+">"))
		}
	case email != "":
		// No name: the address is the only identity there is, so it becomes the
		// name rather than being printed after an empty one.
		fields = append(fields, styles.dim("<"+email+">"))
	default:
		fields = append(fields, "Unnamed participant")
	}
	if participant.IsHost {
		fields = append(fields, styles.accent("(host)"))
	}
	return strings.Join(fields, " ")
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

// TranscriptLine formats one line the way every surface prints it. This is the
// most-read output of the program and the shape an agent parses, so it has one
// definition.
func TranscriptLine(line store.Line, timestamps bool) string {
	if timestamps {
		return fmt.Sprintf("%d [%s] %s: %s", line.LineNo, Clock(line.StartMS), line.Speaker, line.Text)
	}
	return fmt.Sprintf("%d %s: %s", line.LineNo, line.Speaker, line.Text)
}

// SearchHits lists matches with the meeting and line to read next.
func SearchHits(hits []store.Hit) string {
	var out strings.Builder
	for _, hit := range hits {
		fmt.Fprintf(&out, "%s  line %d  %s\n  %s\n",
			hit.MeetingID, hit.LineNo, Date(hit.CreatedMS), strings.TrimSpace(hit.Text))
	}
	return out.String()
}

// NoMatches explains an empty result, including why a name may be spelled
// differently than the user expects.
func NoMatches(query string) string {
	return fmt.Sprintf("Nothing matched %q.\n\n%s\n", query, NoMatchHint)
}

// StatusLabel renders a sync phase for a person. It lives here rather than on
// store.Status because it is phrasing, and every surface that shows it already
// renders the numbers through StatusLines.
func StatusLabel(status store.Status) string {
	switch status.Phase {
	case store.PhaseIdle:
		return "Waiting to start"
	case store.PhaseListing:
		return "Discovering meetings"
	case store.PhaseDownloading:
		return "Syncing meetings"
	case store.PhaseSynced:
		if status.Remaining == 0 {
			return "Up to date"
		}
		return "Syncing meetings"
	case store.PhaseNeedsLogin:
		return "Sign in required"
	case store.PhaseError:
		return "Sync needs attention"
	}
	return "Syncing meetings"
}

// ProgressBar draws a fixed-width bar. An unknown total renders as nothing at
// all: a frame with no fill reads as "zero of zero done", which is the one
// thing a bar must never say while the first count is still being fetched.
func ProgressBar(done, total, width int) string {
	if total <= 0 || width < 8 {
		return ""
	}
	filled := max(0, min(width, done*width/total))
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
