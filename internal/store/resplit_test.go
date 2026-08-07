package store

import (
	"strings"
	"testing"
)

// splitAtSentences is a stand-in splitter for the migration tests: it breaks
// after every ". " and reports true byte offsets. The migration must be correct
// for any pure splitter, so testing it against a trivial one keeps these tests
// about the remapping rather than about the production rule.
func splitAtSentences(text string) []Chunk {
	var chunks []Chunk
	start := 0
	for index := 0; index+1 < len(text); index++ {
		if text[index] == '.' && text[index+1] == ' ' {
			chunks = append(chunks, Chunk{Text: text[start : index+1], Start: start})
			start = index + 2
		}
	}
	if start < len(text) {
		chunks = append(chunks, Chunk{Text: text[start:], Start: start})
	}
	return chunks
}

func TestChangedSpanFindsWhatTheCorrectionTouched(t *testing.T) {
	for _, testCase := range []struct {
		name             string
		original, edited string
		wantStart        int
		wantEnd          int
		wantOK           bool
	}{
		{"one word", "we use Fabrics here", "we use Fabrix here", 12, 14, true},
		// The shared prefix runs past the word boundary, so the span does not
		// start where the differing word does. Where it lands does not matter as
		// long as putting the replacement back rebuilds the text, which is
		// asserted below for every case.
		{"longer replacement", "in Fabrik", "in Fabrix PIM", 8, 9, true},
		{"identical is not a correction", "same", "same", 0, 0, false},
		{"insertion at the end", "abc", "abcdef", 3, 3, true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			start, end, ok := changedSpan(testCase.original, testCase.edited)
			if ok != testCase.wantOK {
				t.Fatalf("ok = %v, want %v", ok, testCase.wantOK)
			}
			if !ok {
				return
			}
			if start != testCase.wantStart || end != testCase.wantEnd {
				t.Fatalf("span = [%d,%d), want [%d,%d)",
					start, end, testCase.wantStart, testCase.wantEnd)
			}
			// Whatever the span is, putting the replacement back must rebuild
			// the edited text exactly. This is the property the migration
			// depends on, and it holds regardless of where the boundaries fell.
			replacement := testCase.edited[start : len(testCase.edited)-(len(testCase.original)-end)]
			rebuilt := testCase.original[:start] + replacement + testCase.original[end:]
			if rebuilt != testCase.edited {
				t.Fatalf("rebuilt %q, want %q", rebuilt, testCase.edited)
			}
		})
	}
}

func TestNarrowEditPicksTheChunkThatChanged(t *testing.T) {
	original := "First we sync. Then we use Fabrics for products. That is all."
	edited := "First we sync. Then we use Fabrix for products. That is all."
	chunks := splitAtSentences(original)
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}

	index, narrowed, ok := narrowEdit(
		storedEdit{Original: original, Edited: edited}, chunks)
	if !ok {
		t.Fatal("a correction inside one chunk should be placeable")
	}
	if index != 1 {
		t.Fatalf("correction is in chunk 1, got %d", index)
	}
	if narrowed != "Then we use Fabrix for products." {
		t.Fatalf("narrowed text is %q", narrowed)
	}
}

func TestNarrowEditRefusesToStraddleAChunkBoundary(t *testing.T) {
	original := "First we sync. Then we use Fabrics."
	// A correction that rewrites across the boundary cannot be expressed as an
	// edit to a single line, so it must be refused rather than guessed at.
	edited := "First we synced. Then we used Fabrix."
	chunks := splitAtSentences(original)

	if _, _, ok := narrowEdit(storedEdit{Original: original, Edited: edited}, chunks); ok {
		t.Fatal("a correction spanning two chunks must not be placed on one line")
	}
}

func TestResplitRenumbersAndCarriesCorrectionsAcross(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Walkthrough", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	long := "First we sync. Then we use Fabrics for products. That is all."
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Ines", StartMS: 0, OriginalText: "Yeah."},
		{LineNo: 2, Speaker: "Dana", StartMS: 5000, OriginalText: long},
		{LineNo: 3, Speaker: "Ines", StartMS: 9000, OriginalText: "Got it."},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	// A correction recorded against the long line, before it is split.
	if _, err := store.EditLine("m1", 2, "Fabrics", "Fabrix", 1, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	if err := resplitTranscripts(store.db, splitAtSentences); err != nil {
		t.Fatalf("resplit: %v", err)
	}

	lines, err := store.Lines("m1", 0, 0)
	if err != nil {
		t.Fatalf("lines: %v", err)
	}
	// One line became three, so the meeting runs 1..5 and "Got it." moved from
	// line 3 to line 5.
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines after the split, got %d", len(lines))
	}
	for index, line := range lines {
		if line.LineNo != index+1 {
			t.Fatalf("line numbers must be contiguous from 1, got %d at index %d",
				line.LineNo, index)
		}
	}
	if lines[4].Text != "Got it." {
		t.Fatalf("the line after the split should be %q, got %q", "Got it.", lines[4].Text)
	}
	// Every chunk of a segment keeps that segment's speaker and start time.
	for _, index := range []int{1, 2, 3} {
		if lines[index].Speaker != "Dana" || lines[index].StartMS != 5000 {
			t.Fatalf("chunk %d lost its speaker or timestamp: %+v", index, lines[index])
		}
	}

	// The correction followed its text onto the new line, and narrowed to it.
	if lines[2].Text != "Then we use Fabrix for products." {
		t.Fatalf("the corrected chunk reads %q", lines[2].Text)
	}
	if lines[2].OriginalText != "Then we use Fabrics for products." {
		t.Fatalf("the chunk's original should be what Sana delivered, got %q",
			lines[2].OriginalText)
	}

	history, err := store.LineHistory("m1", 0)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("expected the one correction to survive, got %d", len(history))
	}
	if history[0].State != EditApplied {
		t.Fatalf("the correction should still be applied, got %q", history[0].State)
	}
	if history[0].LineNo != 3 {
		t.Fatalf("the correction should now name line 3, got %d", history[0].LineNo)
	}

	// The search index was rebuilt with it: the corrected word is findable and
	// points at the new line number.
	hits, err := store.Search("Fabrix", 10, 0, SortBest)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].LineNo != 3 {
		t.Fatalf("search should find the correction on line 3, got %+v", hits)
	}
	if !strings.Contains(hits[0].Text, "Fabrix") {
		t.Fatalf("hit should carry the corrected text, got %q", hits[0].Text)
	}
}

func TestResplitIsIdempotent(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Walkthrough", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Dana", StartMS: 0,
			OriginalText: "First we sync. Then we use Fabrix. That is all."},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}

	if err := resplitTranscripts(store.db, splitAtSentences); err != nil {
		t.Fatalf("first resplit: %v", err)
	}
	first, err := store.Lines("m1", 0, 0)
	if err != nil {
		t.Fatalf("lines: %v", err)
	}
	if err := resplitTranscripts(store.db, splitAtSentences); err != nil {
		t.Fatalf("second resplit: %v", err)
	}
	second, err := store.Lines("m1", 0, 0)
	if err != nil {
		t.Fatalf("lines: %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("a second run changed the line count: %d then %d", len(first), len(second))
	}
	for index := range first {
		if first[index].Text != second[index].Text {
			t.Fatalf("a second run changed line %d: %q then %q",
				index+1, first[index].Text, second[index].Text)
		}
	}
}
