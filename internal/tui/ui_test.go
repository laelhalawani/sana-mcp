package tui

import (
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/render"
)

func colourPolicy() Policy {
	return Policy{
		Interactive: true, Control: true, Color: true, Unicode: true,
		Columns: 80, Rows: 24,
	}
}

func plainPolicy() Policy {
	return Policy{
		Interactive: true, Control: true, Columns: 80, Rows: 24,
	}
}

func TestColourIsSuppressedWhenThePolicySaysSo(t *testing.T) {
	if got := string(New(colourPolicy()).Green("ok")); got != "\x1b[32mok\x1b[0m" {
		t.Fatalf("Green = %q", got)
	}
	// No colour must mean no escape bytes at all, not a reset pair around the
	// text: a log file or a piped stdout should hold plain text.
	if got := string(New(plainPolicy()).Green("ok")); got != "ok" {
		t.Fatalf("Green without colour = %q", got)
	}
}

func TestGlyphsAndSpinnerDegradeTogether(t *testing.T) {
	unicode := New(colourPolicy())
	ascii := New(plainPolicy())

	if unicode.Glyphs.OK != "✔" || ascii.Glyphs.OK != "+" {
		t.Fatalf("glyph sets did not switch: %q / %q", unicode.Glyphs.OK, ascii.Glyphs.OK)
	}
	if len(unicode.SpinnerFrames) != 10 || len(ascii.SpinnerFrames) != 4 {
		t.Fatalf("spinner sets did not switch: %d / %d",
			len(unicode.SpinnerFrames), len(ascii.SpinnerFrames))
	}
	if unicode.TruncationMarker != "…" || ascii.TruncationMarker != "..." {
		t.Fatalf("truncation markers did not switch")
	}
	// A negative frame index must still land on a frame; the status screen
	// counts up forever and an int can wrap.
	if got := ascii.Spinner(-1); got == "" {
		t.Fatal("a negative frame produced no spinner")
	}
}

func TestLinePassesOurTextThroughAndSanitisesTheRest(t *testing.T) {
	ui := New(colourPolicy())
	got := string(ui.Line(ui.Green("ok"), " ", "meeting\x1b[31m title"))
	if !strings.Contains(got, "\x1b[32mok\x1b[0m") {
		t.Fatalf("styled text was mangled: %q", got)
	}
	if strings.Contains(got, "\x1b[31m") {
		t.Fatalf("untrusted text kept its escape sequence: %q", got)
	}
}

func TestFooterJoinsWithTheSeparatorTheOriginalUses(t *testing.T) {
	ui := New(plainPolicy())
	lines := ui.Footer("a", "b", "c")
	if len(lines) != 2 || lines[0] != "" {
		t.Fatalf("a footer is a blank line then the hints, got %q", lines)
	}
	if string(lines[1]) != "a  |  b  |  c" {
		t.Fatalf("footer = %q", lines[1])
	}
}

func TestStatusGlyphSeparatesRegistrationFromRemoval(t *testing.T) {
	ui := New(plainPolicy())
	if got := string(ui.StatusGlyph(ApplyOK, true)); got != ui.Glyphs.OK {
		t.Fatalf("a registration is a tick, got %q", got)
	}
	if got := string(ui.StatusGlyph(ApplyOK, false)); got != ui.Glyphs.Disable {
		t.Fatalf("a removal is a minus, got %q", got)
	}
	if got := string(ui.StatusGlyph(ApplyFailed, true)); got != ui.Glyphs.Fail {
		t.Fatalf("a failure is a cross, got %q", got)
	}
}

func TestRowPutsDetailAndHintInTheirPlaces(t *testing.T) {
	ui := New(plainPolicy())
	got := string(ui.Row(ui.StatusGlyph(ApplyOK, true), "Claude Code", "registered", "restart it"))
	if got != "  + Claude Code: registered  (restart it)" {
		t.Fatalf("Row = %q", got)
	}
}

func TestScreenPinsTheFooterToTheLastRow(t *testing.T) {
	policy := plainPolicy()
	policy.Rows = 6
	ui := New(policy)

	rendered := ui.Screen("Title", []Text{"one", "two"}, "esc back")
	lines := strings.Split(rendered, "\n")
	if len(lines) != 6 {
		t.Fatalf("a six-row screen must render six lines, got %d: %q", len(lines), lines)
	}
	if lines[0] != "Title" || lines[1] != "one" || lines[2] != "two" {
		t.Fatalf("body was not laid out: %q", lines)
	}
	if lines[3] != "" || lines[4] != "" {
		t.Fatalf("the gap before the footer was not padded: %q", lines)
	}
	if lines[5] != "esc back" {
		t.Fatalf("footer = %q", lines[5])
	}
}

func TestScreenClipsBodyToWhatFits(t *testing.T) {
	policy := plainPolicy()
	policy.Rows = 4
	ui := New(policy)

	lines := strings.Split(ui.Screen("Title", []Text{"1", "2", "3", "4", "5"}, "f"), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected four rows, got %q", lines)
	}
	if lines[len(lines)-1] != "f" {
		t.Fatalf("the footer must survive a full body, got %q", lines)
	}
}

func TestScreenCutsStyledLinesWithoutBreakingThem(t *testing.T) {
	policy := colourPolicy()
	policy.Columns = 12
	policy.Rows = 5
	ui := New(policy)

	lines := strings.Split(ui.Screen("T", []Text{ui.Green("a very long styled line")}, "f"), "\n")
	if render.StyledWidth(lines[1]) > policy.Width() {
		t.Fatalf("a styled line overflowed: %q", lines[1])
	}
	// Cut through the escape bytes and the colour runs on down the screen.
	if !strings.HasSuffix(lines[1], "\x1b[0m") {
		t.Fatalf("a styled line lost its reset: %q", lines[1])
	}
}

func TestAdaptiveFooterTakesTheFirstThatFits(t *testing.T) {
	ui := New(plainPolicy())
	got := ui.AdaptiveFooter(10, "a very long footer indeed", "shorter", "q")
	if got != "shorter" {
		t.Fatalf("AdaptiveFooter = %q", got)
	}
	// Nothing fits: the shortest is still better than an empty footer.
	if got := ui.AdaptiveFooter(1, "aaa", "bb"); got != "bb" {
		t.Fatalf("AdaptiveFooter with no fit = %q", got)
	}
}

func TestWidthLeavesOneColumnFree(t *testing.T) {
	// A line exactly as wide as the terminal soft-wraps into a second row,
	// which pushes the footer off the bottom of every screen.
	if got := (Policy{Columns: 80}).Width(); got != 79 {
		t.Fatalf("Width = %d", got)
	}
	if got := (Policy{Columns: 0}).Width(); got != 1 {
		t.Fatalf("an unknown width must still be usable, got %d", got)
	}
}

func TestWrapMovesTheCursorAndSurvivesAnEmptyList(t *testing.T) {
	if got := Wrap(0, -1, 3); got != 2 {
		t.Fatalf("moving up from the top wraps to the end, got %d", got)
	}
	if got := Wrap(2, 1, 3); got != 0 {
		t.Fatalf("moving down from the end wraps to the top, got %d", got)
	}
	if got := Wrap(0, 1, 0); got != 0 {
		t.Fatalf("an empty list must not divide by zero, got %d", got)
	}
}

func TestScreenNeverExceedsTheWidth(t *testing.T) {
	// Styled rows used to escape clipping entirely, so a coloured prompt or a
	// long error overflowed, the terminal soft-wrapped it into an extra row,
	// and the footer scrolled off the bottom. Each new styled row was a fresh
	// chance to do it, so the rule is enforced here rather than per caller.
	for _, columns := range []int{2, 4, 8, 12, 24, 40, 80} {
		policy := colourPolicy()
		policy.Columns = columns
		policy.Rows = 8
		ui := New(policy)

		body := []Text{
			ui.Yellow("Restore line 1 to what Sana delivered? [y/n]"),
			ui.Dim("Nothing in this meeting has been changed."),
			ui.Red("some very long failure message that will not fit at all"),
			ui.Line("    ", ui.Dim("as transcribed:"), " ", "a fairly long original line"),
			"plain text that is also much too long for a narrow terminal",
		}
		rendered := ui.Screen("A title that is itself too long to fit", body,
			"up/down navigate  r restore what Sana delivered  esc transcript")

		for index, line := range strings.Split(rendered, "\n") {
			if got := render.StyledWidth(line); got > ui.Policy.Width() {
				t.Errorf("columns=%d row %d is %d wide, limit %d: %q",
					columns, index, got, ui.Policy.Width(), line)
			}
		}
	}
}

func TestTruncatedStyledTextClosesItsStyle(t *testing.T) {
	ui := New(colourPolicy())
	cut := render.TruncateStyled(string(ui.Red("a long red sentence")), 8, "…")
	if !strings.HasSuffix(cut, "\x1b[0m") {
		t.Fatalf("a cut style must be closed, or it bleeds down the screen: %q", cut)
	}
	if render.StyledWidth(cut) > 8 {
		t.Fatalf("cut to %d columns, limit 8: %q", render.StyledWidth(cut), cut)
	}
	if !strings.Contains(cut, "\x1b[31m") {
		t.Fatalf("the style itself was lost: %q", cut)
	}
}
