package render

import (
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

func ptr(s string) *string { return &s }

// The three surfaces had drifted on exactly these two cases before the layout
// was shared, so they are pinned here.
func TestSummaryTreatsWhitespaceOnlyAsEmpty(t *testing.T) {
	out := Summary(sana.Metadata{Summary: ptr("   \n  ")}, Styles{})
	if !strings.Contains(out, "no summary yet") {
		t.Fatalf("a whitespace-only summary should count as absent, got %q", out)
	}
}

func TestParticipantWithoutEmailHasNoGap(t *testing.T) {
	out := Participants([]sana.Participant{
		{DisplayName: "Maria", Email: ptr("")},
		{DisplayName: "Lael", Email: ptr("lael@lumen.com"), IsHost: true},
	}, Styles{})
	if strings.Contains(out, "Maria  \n") || strings.Contains(out, "Maria   ") {
		t.Fatalf("an empty email must not print a gap, got %q", out)
	}
	if !strings.Contains(out, "Lael  lael@lumen.com  (host)") {
		t.Fatalf("expected the full participant line, got %q", out)
	}
}

func TestSummaryRendersNotesAndActions(t *testing.T) {
	out := Summary(sana.Metadata{
		Summary: ptr("We compared vendors."),
		Notes:   []sana.NoteGroup{{Topic: "Vendors", Notes: []string{"Fabrix ruled out"}}},
		ActionItems: []sana.ActionItem{
			{AssignedTo: ptr("Julia"), Action: "scale to 500 products", DueDate: ptr("2026-08-01")},
			{Action: "unassigned work"},
		},
	}, Styles{})
	for _, want := range []string{
		"We compared vendors.", "Vendors", "  - Fabrix ruled out",
		"Action items", "  - Julia: scale to 500 products (due 2026-08-01)",
		"  - unassigned work",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestStylesAreOptional(t *testing.T) {
	upper := func(s string) string { return strings.ToUpper(s) }
	out := Summary(sana.Metadata{Notes: []sana.NoteGroup{{Topic: "topic", Notes: []string{"n"}}}},
		Styles{Heading: upper})
	if !strings.Contains(out, "TOPIC") {
		t.Fatalf("the heading style should apply, got %q", out)
	}
}

// A long meeting must not report 125:03 as 5:03.
func TestClockCarriesHours(t *testing.T) {
	cases := map[int64]string{0: "0:00", 62_000: "1:02", 3_600_000: "1:00:00", 7_505_000: "2:05:05"}
	for ms, want := range cases {
		if got := Clock(ms); got != want {
			t.Errorf("Clock(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestProgressBarKeepsItsFrameWhenTotalIsUnknown(t *testing.T) {
	bar := ProgressBar(0, 0, 4)
	if bar != "[----]" {
		t.Fatalf("an unknown total should still be framed, got %q", bar)
	}
	if got := ProgressBar(2, 4, 4); got != "[##--]" {
		t.Fatalf("half progress = %q", got)
	}
	if got := ProgressBar(9, 4, 4); got != "[####]" {
		t.Fatalf("overflow must clamp, got %q", got)
	}
}

func TestStatusLinesReportCoverage(t *testing.T) {
	out := StatusLines(store.Status{
		Meetings: 77, MeetingsTotal: 240,
		TranscriptsDone: 77, TranscriptsTotal: 240, Remaining: 163,
	})
	for _, want := range []string{"meetings      77 of 240", "transcripts   77 of 240", "remaining     163"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}
