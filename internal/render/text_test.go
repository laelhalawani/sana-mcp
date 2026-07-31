package render

import (
	"strings"
	"testing"
)

func TestSanitizeMakesUntrustedTextInert(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"strips a CSI sequence", "safe\x1b[31mred\x1b[0m", "safered"},
		{"folds a newline to one space", "one\ntwo", "one two"},
		{"does not double a space", "one \ntwo", "one two"},
		{"drops control characters", "a\x00b\x07c", "abc"},
		{"drops bidi overrides", "meeting‮gnitem", "meetinggnitem"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := Sanitize(test.input); got != test.want {
				t.Fatalf("Sanitize(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestSanitizeLeavesNoEscapeBytes(t *testing.T) {
	for _, input := range []string{
		"\x1b]0;title\x07text",
		"\x1bPsomething\x1b\\text",
		"\x9b31mtext",
		"\x1b[2J\x1b[Htext",
	} {
		got := Sanitize(input)
		if strings.ContainsAny(got, "\x1b\x9b\x07") {
			t.Fatalf("Sanitize(%q) left a control sequence: %q", input, got)
		}
	}
}

func TestDisplayWidthCountsColumnsNotRunes(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"plain", 5},
		{"日本語", 6},                  // three wide runes
		{"é", 1},                   // a combining acute adds no column
		{"\U0001f600", 2},           // grinning face
		{"\U0001f1f5\U0001f1f1", 2}, // a regional-indicator pair is one flag
	}
	for _, test := range cases {
		if got := DisplayWidth(test.value); got != test.want {
			t.Errorf("DisplayWidth(%q) = %d, want %d", test.value, got, test.want)
		}
	}
}

func TestTruncateCutsByWidth(t *testing.T) {
	if got := Truncate("abcdef", 10, "…"); got != "abcdef" {
		t.Fatalf("text that fits must be untouched, got %q", got)
	}
	if got := Truncate("abcdef", 4, "…"); got != "abc…" {
		t.Fatalf("Truncate = %q, want %q", got, "abc…")
	}
	if got := Truncate("日本語です", 5, "…"); got != "日本…" {
		t.Fatalf("wide runes must be measured in columns, got %q", got)
	}
	if got := Truncate("abcdef", 2, "..."); got != ".." {
		t.Fatalf("a marker wider than the space left is itself cut, got %q", got)
	}
	if got := Truncate("abc", 0, "…"); got != "" {
		t.Fatalf("no width means no output, got %q", got)
	}
}

func TestWrapKeepsBlankLinesAndBreaksLongWords(t *testing.T) {
	got := Wrap("one two three", 7, "…")
	want := []string{"one two", "three"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Wrap = %q, want %q", got, want)
	}

	got = Wrap("first\n\nsecond", 10, "…")
	want = []string{"first", "", "second"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("blank lines must survive, got %q", got)
	}

	got = Wrap("supercalifragilistic", 6, "…")
	for _, line := range got {
		if DisplayWidth(line) > 6 {
			t.Fatalf("a hard-broken word overflowed: %q", got)
		}
	}
	if strings.Join(got, "") != "supercalifragilistic" {
		t.Fatalf("a hard break must not lose text, got %q", got)
	}
}

func TestRowPutsTheDetailAfterAColon(t *testing.T) {
	got := Row(DisplayRow{Marker: "+", Label: "Claude Code", Detail: "registered"}, 40, "…")
	if got != "+ Claude Code: registered" {
		t.Fatalf("Row = %q", got)
	}
	if got := Row(DisplayRow{Marker: "+", Label: "Claude Code"}, 40, "…"); got != "+ Claude Code" {
		t.Fatalf("an absent detail must not print a colon, got %q", got)
	}
}

func TestTruncateStyledNeverExceedsTheWidth(t *testing.T) {
	styled := "\x1b[2msome long dim text\x1b[0m"
	for _, width := range []int{1, 2, 3, 4, 8, 12, 40} {
		for _, marker := range []string{"…", "..."} {
			cut := TruncateStyled(styled, width, marker)
			if got := StyledWidth(cut); got > width {
				t.Errorf("width %d marker %q: cut to %d columns: %q", width, marker, got, cut)
			}
		}
	}
	// The whole marker used to be appended even when there was no room for it,
	// so a row came out wider than the width it had just been cut to.
	if got := StyledWidth(TruncateStyled(styled, 2, "...")); got > 2 {
		t.Fatalf("a marker wider than the width must itself be cut, got %d columns", got)
	}
}

func TestTruncateStyledKeepsSequencesIntact(t *testing.T) {
	value := "\x1b[1m\x1b[31mbold red text that is far too long\x1b[0m"
	cut := TruncateStyled(value, 10, "…")
	if strings.Count(cut, "\x1b[") < 3 {
		t.Fatalf("the opening sequences were lost: %q", cut)
	}
	if !strings.HasSuffix(cut, "\x1b[0m") {
		t.Fatalf("the style was left open: %q", cut)
	}
	// Text with no styling at all takes the plain path.
	if got := TruncateStyled("plain and long", 6, "…"); got != "plain…" {
		t.Fatalf("TruncateStyled = %q", got)
	}
}

func TestWrapDoesNotInventABlankRow(t *testing.T) {
	// A trailing space run flushed the line and left the builder empty, so an
	// unconditional final append added a row that is not there - and inflated
	// the row count a scroll limit is computed from.
	if got := Wrap("abc ", 3, "…"); len(got) != 1 || got[0] != "abc" {
		t.Fatalf("Wrap = %q, want [abc]", got)
	}
	if got := Wrap("", 3, "…"); len(got) != 1 || got[0] != "" {
		t.Fatalf("an empty line is still one row, got %q", got)
	}
	if got := Wrap("a\n\nb", 3, "…"); len(got) != 3 {
		t.Fatalf("blank lines must survive, got %q", got)
	}
}

func TestTruncateStyledKeepsGraphemesWhole(t *testing.T) {
	family := "\U0001f468‍\U0001f469‍\U0001f467"
	value := "\x1b[31m" + family + " and more text here\x1b[0m"
	// Measuring rune by rune counted each part of the sequence separately and
	// cut it in half, leaving a dangling zero-width joiner.
	cut := TruncateStyled(value, 4, "…")
	if strings.Contains(cut, "‍") && !strings.Contains(cut, family) {
		t.Fatalf("a ZWJ sequence was cut in half: %q", cut)
	}
	if got := StyledWidth(TruncateStyled(value, 20, "…")); got > 20 {
		t.Fatalf("cut to %d columns, limit 20", got)
	}
}
