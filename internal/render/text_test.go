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
