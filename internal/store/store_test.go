package store

import (
	"errors"
	"path/filepath"
	"testing"
)

// openTest returns a store on a temporary database.
func openTest(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "sana.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// seed stores one meeting whose transcript contains the real failure case: the
// product "Fabrix" transcribed as "Fabrik".
func seed(t *testing.T, store *Store) {
	t.Helper()
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Platform review", CreatedMS: 1000, Status: "ready", WordCount: 20,
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	lines := []Line{
		{LineNo: 1, Speaker: "Julia", StartMS: 0, OriginalText: "do porownania miedzy Fabrik, a Northwind, a Lumen"},
		{LineNo: 2, Speaker: "Lael", StartMS: 5000, OriginalText: "the crawler work is separate from this"},
	}
	if err := store.PutTranscript("m1", lines); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
}

func TestEditAppliesAndIsSearchable(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do porownania miedzy Fabrik, a Northwind, a Lumen"
	corrected := "do porownania miedzy Fabrix, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, corrected, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	hits, err := store.Search("Fabrix", 10, 0)
	if err != nil {
		t.Fatalf("search corrected: %v", err)
	}
	if len(hits) != 1 || hits[0].LineNo != 1 {
		t.Fatalf("searching the correction should find line 1, got %+v", hits)
	}
	if hits[0].Text != corrected {
		t.Fatalf("hit should carry the corrected text, got %q", hits[0].Text)
	}

	// What was actually said stays reachable: the original column is still
	// indexed, just weighted far below the current text.
	spoken, err := store.Search("Fabrik", 10, 0)
	if err != nil {
		t.Fatalf("search original: %v", err)
	}
	if len(spoken) != 1 || spoken[0].LineNo != 1 {
		t.Fatalf("searching what was said should still find line 1, got %+v", spoken)
	}
}

func TestEditRejectsMismatchedText(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	_, err := store.EditLine("m1", 1, "a line that was never there", "anything", AuthorAgent)
	if !errors.Is(err, ErrLineMismatch) {
		t.Fatalf("expected ErrLineMismatch, got %v", err)
	}
	// The line must be untouched.
	hits, err := store.Search("Fabrik", 10, 0)
	if err != nil || len(hits) != 1 {
		t.Fatalf("original line should be intact, got %+v (%v)", hits, err)
	}
}

func TestRestoreReturnsTheOriginal(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do porownania miedzy Fabrik, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, "corrected", AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if err := store.RestoreLine("m1", 1); err != nil {
		t.Fatalf("restore: %v", err)
	}

	history, err := store.LineHistory("m1", 1)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(history) != 1 || history[0].State != EditReverted {
		t.Fatalf("the edit should survive as reverted history, got %+v", history)
	}
	if history[0].OriginalText != original {
		t.Fatalf("history must carry the original text, got %q", history[0].OriginalText)
	}
}

func TestCompleteTranscriptIsNotRefetched(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	needs, err := store.NeedsTranscript("m1")
	if err != nil {
		t.Fatalf("needs transcript: %v", err)
	}
	if needs {
		t.Fatal("a stored transcript must never be re-downloaded")
	}

	// Re-listing the meeting must not downgrade what we already hold.
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Platform review", CreatedMS: 1000, Status: "ready", WordCount: 20,
	}); err != nil {
		t.Fatalf("re-put meeting: %v", err)
	}
	needs, err = store.NeedsTranscript("m1")
	if err != nil {
		t.Fatalf("needs transcript after re-list: %v", err)
	}
	if needs {
		t.Fatal("re-listing a meeting must not mark its transcript for re-download")
	}
}

func TestEditsSurviveRedownloadWhenLinesShift(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do porownania miedzy Fabrik, a Northwind, a Lumen"
	corrected := "do porownania miedzy Fabrix, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, corrected, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	// A re-download in which an earlier line appeared, shifting the edited line
	// from 1 to 2. Matching by line number would corrupt the wrong line.
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Maria", StartMS: 0, OriginalText: "hello everyone, starting now"},
		{LineNo: 2, Speaker: "Julia", StartMS: 5000, OriginalText: original},
		{LineNo: 3, Speaker: "Lael", StartMS: 9000, OriginalText: "the crawler work is separate from this"},
	}); err != nil {
		t.Fatalf("re-download: %v", err)
	}

	hits, err := store.Search("Fabrix", 10, 0)
	if err != nil {
		t.Fatalf("search after re-download: %v", err)
	}
	if len(hits) != 1 || hits[0].LineNo != 2 {
		t.Fatalf("the correction should have followed its line to 2, got %+v", hits)
	}
}

func TestVanishedLineLeavesEditStaleNotApplied(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do porownania miedzy Fabrik, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, "corrected", AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	// A re-download in which the edited line is gone entirely.
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Lael", StartMS: 0, OriginalText: "something else entirely"},
	}); err != nil {
		t.Fatalf("re-download: %v", err)
	}

	history, err := store.LineHistory("m1", 0)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(history) != 1 || history[0].State != EditStale {
		t.Fatalf("an unmatched edit must be kept as stale, got %+v", history)
	}
	// It must not have been applied to the surviving line.
	hits, err := store.Search("corrected", 10, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("a stale edit must not be applied to another line, got %+v", hits)
	}
}
