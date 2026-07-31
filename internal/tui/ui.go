package tui

import (
	"fmt"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/render"
)

// Gutter is the one indent unit every row uses.
const Gutter = "  "

// Text is display text this package produced: already sanitised, and possibly
// carrying colour sequences.
//
// The distinction matters. Composition sanitises whatever it is handed, which
// would strip the escape bytes back out of styled text; a separate type is what
// lets Line tell "the UI made this" from "this came from a meeting title".
type Text string

// UI styles and composes text under one policy.
//
// Colours are the eight basic SGR attributes rather than a 256-colour palette:
// the terminal's own theme picks the hue, which is what keeps the output
// legible on a light background. When the policy says no colour, nothing emits
// escape bytes at all.
type UI struct {
	Policy           Policy
	Glyphs           Glyphs
	SpinnerFrames    []string
	TruncationMarker string
	OverflowMarker   string
}

func New(policy Policy) UI {
	ui := UI{
		Policy:           policy,
		Glyphs:           policy.Glyphs(),
		SpinnerFrames:    policy.SpinnerFrames(),
		TruncationMarker: "...",
		OverflowMarker:   ".",
	}
	if policy.Unicode {
		ui.TruncationMarker = "…"
		ui.OverflowMarker = "…"
	}
	return ui
}

// Plain sanitises without styling.
func (u UI) Plain(value string) Text { return Text(render.Sanitize(value)) }

func (u UI) style(open int, value string) Text {
	text := render.Sanitize(value)
	if !u.Policy.Color {
		return Text(text)
	}
	return Text(fmt.Sprintf("\x1b[%dm%s\x1b[0m", open, text))
}

func (u UI) Dim(value string) Text    { return u.style(2, value) }
func (u UI) Bold(value string) Text   { return u.style(1, value) }
func (u UI) Green(value string) Text  { return u.style(32, value) }
func (u UI) Yellow(value string) Text { return u.style(33, value) }
func (u UI) Red(value string) Text    { return u.style(31, value) }
func (u UI) Cyan(value string) Text   { return u.style(36, value) }

// Colour returns one of the six styling functions by name, for the screens that
// pick a colour from state rather than writing it in.
func (u UI) Colour(name string) func(string) Text {
	switch name {
	case "bold":
		return u.Bold
	case "green":
		return u.Green
	case "yellow":
		return u.Yellow
	case "red":
		return u.Red
	case "cyan":
		return u.Cyan
	default:
		return u.Dim
	}
}

// Line concatenates parts. A Text part is already ours and passes through; a
// string is untrusted and is sanitised.
func (u UI) Line(parts ...any) Text {
	var out strings.Builder
	for _, part := range parts {
		switch value := part.(type) {
		case Text:
			out.WriteString(string(value))
		case string:
			out.WriteString(render.Sanitize(value))
		default:
			out.WriteString(render.Sanitize(fmt.Sprint(value)))
		}
	}
	return Text(out.String())
}

// ApplyState is the outcome of one client registration.
type ApplyState string

const (
	ApplyOK      ApplyState = "ok"
	ApplyNoop    ApplyState = "noop"
	ApplySkipped ApplyState = "skipped"
	ApplyFailed  ApplyState = "failed"
)

// StatusGlyph is the mark for one settled outcome. Enabling separates a
// registration from a removal, which is why a successful removal is a yellow
// minus and not a green tick.
func (u UI) StatusGlyph(state ApplyState, enabling bool) Text {
	switch state {
	case ApplyOK:
		if enabling {
			return u.Green(u.Glyphs.OK)
		}
		return u.Yellow(u.Glyphs.Disable)
	case ApplyNoop:
		return u.Dim(u.Glyphs.Noop)
	case ApplyFailed:
		return u.Red(u.Glyphs.Fail)
	default:
		return u.Dim(u.Glyphs.Skip)
	}
}

// Header is a bold title, optionally followed by a dim subtitle.
func (u UI) Header(title string, subtitle ...string) []Text {
	output := []Text{u.Bold(title)}
	for _, line := range subtitle {
		output = append(output, u.Dim(line))
	}
	return output
}

// Row is the standard settled line: gutter, glyph, label, optional detail after
// a colon, optional parenthesised hint.
func (u UI) Row(glyph Text, label string, detail, hint string) Text {
	parts := []any{Text(Gutter), glyph, " ", label}
	if detail != "" {
		parts = append(parts, ": ", u.Dim(detail))
	}
	if hint != "" {
		parts = append(parts, "  ", u.Dim("("+render.Sanitize(hint)+")"))
	}
	return u.Line(parts...)
}

// KeyHint bolds the key and leaves the action plain.
func (u UI) KeyHint(key, action string) Text {
	return u.Line(u.Bold(key), " ", action)
}

// Footer is a blank line then the dimmed hints, joined by two spaces, a pipe
// and two spaces.
func (u UI) Footer(hints ...string) []Text {
	safe := make([]string, 0, len(hints))
	for _, hint := range hints {
		safe = append(safe, render.Sanitize(hint))
	}
	return []Text{"", u.Dim(strings.Join(safe, "  |  "))}
}

// Frame joins a header, a blank line, a body and an optional footer. It does
// not pad or clip: the screens that own the whole terminal do that themselves
// in Screen.
func (u UI) Frame(header, body, footer []Text) []Text {
	output := make([]Text, 0, len(header)+1+len(body)+len(footer))
	output = append(output, header...)
	output = append(output, "")
	output = append(output, body...)
	output = append(output, footer...)
	return output
}

func (u UI) Truncate(value string, width int) string {
	return render.Truncate(value, width, u.TruncationMarker)
}

func (u UI) Wrap(value string, width int) []string {
	return render.Wrap(value, width, u.OverflowMarker)
}

// Spinner is the frame for an index, wrapping.
func (u UI) Spinner(frame int) string {
	index := frame % len(u.SpinnerFrames)
	if index < 0 {
		index += len(u.SpinnerFrames)
	}
	return u.SpinnerFrames[index]
}

// SettledRow renders a finished step: its outcome glyph, a label and a detail.
func (u UI) SettledRow(row render.DisplayRow, width int, state ApplyState, enabling bool) Text {
	row.Marker = ""
	return u.Line(u.StatusGlyph(state, enabling), render.Row(row, width, u.TruncationMarker))
}

// LiveRow renders a step still running, with the spinner in the glyph column.
func (u UI) LiveRow(row render.DisplayRow, width int, frame int) Text {
	row.Marker = u.Spinner(frame)
	return Text(render.Row(row, width, u.TruncationMarker))
}

// AdaptiveFooter returns the first candidate that fits. Callers list them
// longest first, so a narrow terminal drops the least useful hints instead of
// overflowing the line.
func (u UI) AdaptiveFooter(width int, candidates ...string) string {
	for _, candidate := range candidates {
		if render.DisplayWidth(candidate) <= width {
			return candidate
		}
	}
	if len(candidates) > 0 {
		return candidates[len(candidates)-1]
	}
	return ""
}

// Screen lays out a full-height region: the bold title, the body clipped to
// what fits, blank padding, and the footer pinned to the last row.
//
// The padding is the point. Without it the footer floats directly under the
// last line of content, and the screen jumps every time the content grows.
func (u UI) Screen(title string, body []Text, footer string) string {
	width := u.Policy.Width()
	rows := u.Policy.AvailableRows()

	rendered := []Text{u.Bold(u.Truncate(title, width))}
	capacity := max(0, rows-2)
	for index, line := range body {
		if index >= capacity {
			break
		}
		rendered = append(rendered, line)
	}
	for len(rendered) < max(1, rows-1) {
		rendered = append(rendered, "")
	}
	if rows >= 2 {
		rendered = append(rendered, u.Dim(u.Truncate(footer, width)))
	}
	if len(rendered) > rows {
		rendered = rendered[:rows]
	}

	lines := make([]string, 0, len(rendered))
	for _, line := range rendered {
		// A styled line was already truncated by whoever styled it; truncating
		// again would cut through the escape bytes.
		if strings.Contains(string(line), "\x1b[") {
			lines = append(lines, string(line))
			continue
		}
		lines = append(lines, u.Truncate(string(line), width))
	}
	return strings.Join(lines, "\n")
}
