package app

import (
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/statusview"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

func testUI() tui.UI {
	return tui.New(tui.Policy{
		Interactive: true, Control: true, Color: true, Unicode: true,
		Columns: 80, Rows: 24,
	})
}

func TestSearchIsOfferedOnceThereIsAListToSearch(t *testing.T) {
	// A pending transcript is the normal state of a working install. Hiding
	// search for it took the feature away almost permanently.
	pending := statusview.Info{SignedIn: true, Status: store.Status{
		MeetingsTotal: 246, Meetings: 245, TranscriptsTotal: 246, TranscriptsDone: 245,
		Remaining: 1, Phase: store.PhaseDownloading,
	}}
	if pending.Preparing() {
		t.Fatal("a pending transcript is not a missing meeting list")
	}

	// Mid-cycle listing with meetings already stored is still browsable.
	listing := statusview.Info{SignedIn: true, Status: store.Status{
		MeetingsTotal: 246, Phase: store.PhaseListing,
	}}
	if listing.Preparing() {
		t.Fatal("re-listing an existing cache is not preparing")
	}

	empty := statusview.Info{SignedIn: true, Status: store.Status{Phase: store.PhaseListing}}
	if !empty.Preparing() {
		t.Fatal("no meetings at all is exactly what preparing means")
	}
	if (statusview.Info{}).Preparing() {
		t.Fatal("signed out is not preparing")
	}
}

func TestMenuFollowsTheSessionAndTheCache(t *testing.T) {
	labels := func(items []choice) string {
		var names []string
		for _, item := range items {
			names = append(names, item.label)
		}
		return strings.Join(names, "|")
	}
	if got := labels(signedOutChoices(false)); got != "Sign in to Sana|Configure AI clients|Quit" {
		t.Fatalf("signed out menu = %q", got)
	}
	if got := labels(signedOutChoices(true)); !strings.HasPrefix(got, "Sign in again (session expired)") {
		t.Fatalf("an expired session must say so, got %q", got)
	}
	if got := labels(signedInChoices(false)); !strings.Contains(got, "Search transcripts") {
		t.Fatalf("search must be offered, got %q", got)
	}
	if got := labels(signedInChoices(true)); strings.Contains(got, "Search transcripts") {
		t.Fatalf("search must wait for a cache, got %q", got)
	}
}

func TestMeetingCardIsThreeRowsWithARailWhenSelected(t *testing.T) {
	ui := testUI()
	meeting := store.Meeting{
		MeetingID: "m1", Title: "Weekly product review", CreatedMS: 1_700_000_000_000,
		Status: store.StatusReady, WordCount: 1200, TranscriptState: store.TranscriptComplete,
	}

	card := meetingCard(meeting, true, 79, ui)
	if len(card) != cardHeight {
		t.Fatalf("a card is %d rows, got %d", cardHeight, len(card))
	}
	if !strings.Contains(string(card[0]), ui.Glyphs.Pointer) {
		t.Fatalf("the selected card needs a pointer: %q", card[0])
	}
	if !strings.Contains(string(card[1]), ui.Glyphs.Rail) {
		t.Fatalf("the selected card needs a rail: %q", card[1])
	}
	if card[2] != "" {
		t.Fatalf("a card ends with a blank row, got %q", card[2])
	}

	unselected := meetingCard(meeting, false, 79, ui)
	if strings.Contains(string(unselected[0]), ui.Glyphs.Pointer) {
		t.Fatalf("an unselected card must not point: %q", unselected[0])
	}
}

func TestMeetingCardShedsMetadataRatherThanOverflowing(t *testing.T) {
	ui := testUI()
	meeting := store.Meeting{
		Title: "A meeting", CreatedMS: 1_700_000_000_000,
		Status: store.StatusReady, WordCount: 1200, TranscriptState: store.TranscriptComplete,
	}
	// Narrow enough that the date and the word count cannot both fit; the
	// status is what a person actually needs and must survive.
	card := meetingCard(meeting, false, 12, ui)
	if !strings.Contains(string(card[1]), "Ready") {
		t.Fatalf("the status was dropped instead of the word count: %q", card[1])
	}
}

func TestDisplayStatusSeparatesWaitingOnUsFromWaitingOnSana(t *testing.T) {
	ready := store.Meeting{Status: store.StatusReady, TranscriptState: store.TranscriptComplete}
	if got := displayStatus(ready); got != store.StatusReady {
		t.Fatalf("displayStatus = %q", got)
	}
	pending := store.Meeting{Status: store.StatusReady, TranscriptState: "absent"}
	if got := displayStatus(pending); got != statusDownloading {
		t.Fatalf("a stored meeting with no transcript is downloading, got %q", got)
	}
	processing := store.Meeting{Status: store.StatusProcessing, TranscriptState: "absent"}
	if got := displayStatus(processing); got != store.StatusProcessing {
		t.Fatalf("Sana is still working on this one, got %q", got)
	}
}

func TestQueryTermsAreUniqueAndLongestFirst(t *testing.T) {
	// Longest first, so "meeting" is highlighted before the "meet" inside it.
	got := queryTerms("meet meeting Meet notes")
	want := "meeting|notes|meet"
	if strings.Join(got, "|") != want {
		t.Fatalf("queryTerms = %q, want %q", got, want)
	}
	if len(queryTerms("")) != 0 {
		t.Fatal("an empty query has no terms")
	}
}

func TestHighlightMarksEveryMatchAndNothingElse(t *testing.T) {
	ui := testUI()
	pattern := literalPattern(queryTerms("fabrix"))
	got := string(highlight(ui, "The Fabrix pipeline and fabrix again", pattern))
	if strings.Count(got, "\x1b[33m") != 2 {
		t.Fatalf("both matches should be highlighted, got %q", got)
	}
	if !strings.Contains(got, "pipeline") {
		t.Fatalf("the surrounding text was lost: %q", got)
	}
	if got := string(highlight(ui, "unchanged", nil)); got != "unchanged" {
		t.Fatalf("no terms means no markup, got %q", got)
	}
}

func TestSnippetCentresTheMatch(t *testing.T) {
	long := strings.Repeat("filler ", 40) + "Fabrix" + strings.Repeat(" filler", 40)
	got := snippetAround(long, "Fabrix", 20)
	if !strings.Contains(got, "Fabrix") {
		t.Fatalf("the match fell out of the snippet: %q", got)
	}
	if !strings.HasPrefix(got, "...") || !strings.HasSuffix(got, "...") {
		t.Fatalf("a trimmed snippet must say so: %q", got)
	}
	// No match: the head of the line, with whitespace collapsed to one space so
	// a wrapped transcript line does not become a wall of gaps.
	if got := snippetAround("one\n two   three", "absent", 80); got != "one two three" {
		t.Fatalf("snippet = %q", got)
	}
}
