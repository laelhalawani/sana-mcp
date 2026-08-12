package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
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
		{LineNo: 1, Speaker: "Priya", StartMS: 0, OriginalText: "do zestawienia miedzy Fabrik, a Northwind, a Lumen"},
		{LineNo: 2, Speaker: "Dana", StartMS: 5000, OriginalText: "the crawler work is separate from this"},
	}
	if err := store.PutTranscript("m1", lines); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
}

func TestEditAppliesAndIsSearchable(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do zestawienia miedzy Fabrik, a Northwind, a Lumen"
	corrected := "do zestawienia miedzy Fabrix, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, corrected, 1, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	hits, err := store.Search("Fabrix", 10, 0, SortBest)
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
	spoken, err := store.Search("Fabrik", 10, 0, SortBest)
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

	_, err := store.EditLine("m1", 1, "a line that was never there", "anything", 1, AuthorAgent)
	if !errors.Is(err, ErrLineMismatch) {
		t.Fatalf("expected ErrLineMismatch, got %v", err)
	}
	// The line must be untouched.
	hits, err := store.Search("Fabrik", 10, 0, SortBest)
	if err != nil || len(hits) != 1 {
		t.Fatalf("original line should be intact, got %+v (%v)", hits, err)
	}
}

func TestRestoreReturnsTheOriginal(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	original := "do zestawienia miedzy Fabrik, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, "corrected", 1, AuthorUser); err != nil {
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

	original := "do zestawienia miedzy Fabrik, a Northwind, a Lumen"
	corrected := "do zestawienia miedzy Fabrix, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, corrected, 1, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	// A re-download in which an earlier line appeared, shifting the edited line
	// from 1 to 2. Matching by line number would corrupt the wrong line.
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Zara", StartMS: 0, OriginalText: "hello everyone, starting now"},
		{LineNo: 2, Speaker: "Priya", StartMS: 5000, OriginalText: original},
		{LineNo: 3, Speaker: "Dana", StartMS: 9000, OriginalText: "the crawler work is separate from this"},
	}); err != nil {
		t.Fatalf("re-download: %v", err)
	}

	hits, err := store.Search("Fabrix", 10, 0, SortBest)
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

	original := "do zestawienia miedzy Fabrik, a Northwind, a Lumen"
	if _, err := store.EditLine("m1", 1, original, "corrected", 1, AuthorUser); err != nil {
		t.Fatalf("edit: %v", err)
	}

	// A re-download in which the edited line is gone entirely.
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Dana", StartMS: 0, OriginalText: "something else entirely"},
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
	hits, err := store.Search("corrected", 10, 0, SortBest)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("a stale edit must not be applied to another line, got %+v", hits)
	}
}

// Re-listing a meeting must not reset what a transcript fetch established.
// The meeting list carries neither a word count nor a transcript state, so
// writing them from a list would empty every meeting on each sync cycle.
func TestRelistingPreservesWordCountAndTranscript(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	before, err := store.GetMeeting("m1")
	if err != nil {
		t.Fatalf("get meeting: %v", err)
	}
	if before.WordCount == 0 {
		t.Fatal("storing a transcript should record its word count")
	}
	if before.TranscriptState != TranscriptComplete {
		t.Fatalf("transcript should be complete, got %q", before.TranscriptState)
	}

	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Platform review", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("re-list: %v", err)
	}
	after, err := store.GetMeeting("m1")
	if err != nil {
		t.Fatalf("get meeting: %v", err)
	}
	if after.WordCount != before.WordCount {
		t.Fatalf("word count went %d -> %d on a re-list", before.WordCount, after.WordCount)
	}
	if after.TranscriptState != TranscriptComplete {
		t.Fatalf("transcript state was downgraded to %q on a re-list", after.TranscriptState)
	}
}

// A database written before the rowid alignment has arbitrary line_search
// rowids. Updating those by rowid would rewrite a different line's index entry,
// so the migration must rebuild the index - and must not touch corrections.
func TestMigrationRebuildsMisalignedSearchIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sana.db")

	// Build a v1-shaped database: index rows inserted with their own rowids,
	// deliberately offset from the transcript rowids.
	first, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	seed(t, first)
	if _, err := first.db.Exec(`DELETE FROM line_search`); err != nil {
		t.Fatalf("clear index: %v", err)
	}
	if _, err := first.db.Exec(
		`INSERT INTO line_search (rowid, meeting_id, line_no, text, original_text)
		 SELECT rowid + 1000, meeting_id, line_no, text, original_text FROM transcript_lines`,
	); err != nil {
		t.Fatalf("misalign index: %v", err)
	}
	if _, err := first.db.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatalf("set v1: %v", err)
	}
	first.Close()

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer migrated.Close()

	// Editing must now change the right line's index entry.
	original := "do zestawienia miedzy Fabrik, a Northwind, a Lumen"
	if _, err := migrated.EditLine("m1", 1, original, "corrected Fabrix line", 1, AuthorUser); err != nil {
		t.Fatalf("edit after migration: %v", err)
	}
	hits, err := migrated.Search("Fabrix", 10, 0, SortBest)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].LineNo != 1 {
		t.Fatalf("the correction should be searchable on line 1, got %+v", hits)
	}
	// The other line must be untouched by the rebuild.
	other, err := migrated.Search("crawler", 10, 0, SortBest)
	if err != nil {
		t.Fatalf("search other: %v", err)
	}
	if len(other) != 1 || other[0].LineNo != 2 {
		t.Fatalf("line 2 should still be indexed, got %+v", other)
	}
}

// Pragmas are per-connection, and database/sql hands out whichever pooled
// connection is free. Applying them once after Open left foreign keys off on
// every other connection, so this checks a connection other than the first.
func TestPragmasApplyToEveryPooledConnection(t *testing.T) {
	store := openTest(t)

	// Force several connections to exist at once, then check each reports the
	// settings the DSN asked for.
	var held []*sql.Conn
	for i := 0; i < 4; i++ {
		conn, err := store.db.Conn(context.Background())
		if err != nil {
			t.Fatalf("conn %d: %v", i, err)
		}
		held = append(held, conn)
	}
	for index, conn := range held {
		var foreignKeys int
		if err := conn.QueryRowContext(context.Background(), "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
			t.Fatalf("conn %d foreign_keys: %v", index, err)
		}
		if foreignKeys != 1 {
			t.Errorf("connection %d has foreign_keys off", index)
		}
		var journal string
		if err := conn.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&journal); err != nil {
			t.Fatalf("conn %d journal_mode: %v", index, err)
		}
		if !strings.EqualFold(journal, "wal") {
			t.Errorf("connection %d journal_mode = %q, want wal", index, journal)
		}
		conn.Close()
	}
}

// Search must return the same rows whichever sort is asked for, and the sorts
// must actually order by date rather than by relevance.
func TestSearchSortsAcrossMeetings(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "old", Title: "Older", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutMeeting(Meeting{
		MeetingID: "new", Title: "Newer", CreatedMS: 9000, Status: "ready",
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old", "new"} {
		if err := store.PutTranscript(id, []Line{
			{LineNo: 1, Speaker: "S", OriginalText: "shared keyword here"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, sort := range []string{SortBest, SortNewest, SortOldest} {
		hits, err := store.Search("keyword", 10, 0, sort)
		if err != nil {
			t.Fatalf("%s: %v", sort, err)
		}
		if len(hits) != 2 {
			t.Fatalf("%s returned %d hits, want 2", sort, len(hits))
		}
	}
	newest, _ := store.Search("keyword", 10, 0, SortNewest)
	if newest[0].MeetingID != "new" {
		t.Errorf("newest should lead with the newer meeting, got %s", newest[0].MeetingID)
	}
	oldest, _ := store.Search("keyword", 10, 0, SortOldest)
	if oldest[0].MeetingID != "old" {
		t.Errorf("oldest should lead with the older meeting, got %s", oldest[0].MeetingID)
	}
	// Paging must not lose or repeat rows.
	first, _ := store.Search("keyword", 1, 0, SortNewest)
	second, _ := store.Search("keyword", 1, 1, SortNewest)
	if len(first) != 1 || len(second) != 1 || first[0].MeetingID == second[0].MeetingID {
		t.Fatalf("paging returned %+v then %+v", first, second)
	}
}

func TestPagesNeverReportsZero(t *testing.T) {
	cases := []struct {
		limit, total, want int
	}{
		{25, 0, 1}, // an empty result still reads as page 1 of 1
		{25, 1, 1},
		{25, 25, 1},
		{25, 26, 2},
		{10, 240, 24},
		{0, 26, 2}, // an unset limit uses the default
	}
	for _, tc := range cases {
		got := ListOptions{Limit: tc.limit}.Pages(tc.total)
		if got != tc.want {
			t.Errorf("limit %d total %d: pages %d, want %d", tc.limit, tc.total, got, tc.want)
		}
	}
}

// TestEditReplacesEveryOccurrenceItWasToldAbout is the point of the count: a
// caller that has read the line and seen three says three, and gets all three.
func TestEditReplacesEveryOccurrenceItWasToldAbout(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	line := "Fabrik said Fabrik would ask Fabrik"
	if _, err := store.EditLine("m1", 1,
		"do zestawienia miedzy Fabrik, a Northwind, a Lumen", line, 1, AuthorUser); err != nil {
		t.Fatalf("seed the line: %v", err)
	}

	if _, err := store.EditLine("m1", 1, "Fabrik", "Fabrix", 3, AuthorAgent); err != nil {
		t.Fatalf("three occurrences, three replacements: %v", err)
	}
	lines, err := store.Lines("m1", 1, 1)
	if err != nil || len(lines) != 1 {
		t.Fatalf("read back: %v", err)
	}
	if lines[0].Text != "Fabrix said Fabrix would ask Fabrix" {
		t.Fatalf("text = %q", lines[0].Text)
	}
	// What Sana delivered is still what Sana delivered, however many edits ran.
	if !strings.Contains(lines[0].OriginalText, "do zestawienia") {
		t.Fatalf("the original was overwritten: %q", lines[0].OriginalText)
	}
}

// TestEditRefusesAFragmentThatOccursMoreOftenThanClaimed is the safety
// interlock: naming a count is how a caller says which text it has looked at.
func TestEditRefusesAFragmentThatOccursMoreOftenThanClaimed(t *testing.T) {
	store := openTest(t)
	seed(t, store)

	line := "Fabrik said Fabrik would ask Fabrik"
	if _, err := store.EditLine("m1", 1,
		"do zestawienia miedzy Fabrik, a Northwind, a Lumen", line, 1, AuthorUser); err != nil {
		t.Fatalf("seed the line: %v", err)
	}

	// Claiming one when there are three must change nothing at all - not even
	// the first.
	_, err := store.EditLine("m1", 1, "Fabrik", "Fabrix", 1, AuthorAgent)
	if !errors.Is(err, ErrLineMismatch) {
		t.Fatalf("expected ErrLineMismatch, got %v", err)
	}
	lines, err := store.Lines("m1", 1, 1)
	if err != nil || len(lines) != 1 {
		t.Fatalf("read back: %v", err)
	}
	if lines[0].Text != line {
		t.Fatalf("a refused edit changed the line: %q", lines[0].Text)
	}

	// And an empty fragment is refused rather than matching everywhere.
	if _, err := store.EditLine("m1", 1, "", "x", 1, AuthorAgent); err == nil {
		t.Fatal("an empty fragment must be refused")
	}
	if _, err := store.EditLine("m1", 1, "Fabrik", "x", 0, AuthorAgent); err == nil {
		t.Fatal("a count of zero must be refused")
	}
}

// Speakers is the transcript's own answer to who was in the meeting, which is a
// different question from the participant list Sana returns.
func TestSpeakersAreCountedAndOrderedByFirstAppearance(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	// The first speaker sorts alphabetically after the second, deliberately: with
	// names in alphabetical order this test would pass under either rule and
	// prove nothing about ordering.
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Zara Nolan", OriginalText: "Shall we start."},
		{LineNo: 2, Speaker: "Ines Duarte", OriginalText: "Yes."},
		{LineNo: 3, Speaker: "Zara Nolan", OriginalText: "Right."},
		{LineNo: 4, Speaker: "Zara Nolan", OriginalText: "So the plan is this."},
		// A blank speaker is not a person and must not become one.
		{LineNo: 5, Speaker: "", OriginalText: "inaudible"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}

	speakers, err := store.Speakers("m1")
	if err != nil {
		t.Fatalf("speakers: %v", err)
	}
	if len(speakers) != 2 {
		t.Fatalf("expected 2 speakers, got %d: %+v", len(speakers), speakers)
	}
	// First appearance, not alphabetical: the list should read like the meeting.
	if speakers[0].Name != "Zara Nolan" || speakers[1].Name != "Ines Duarte" {
		t.Fatalf("speakers are out of order: %+v", speakers)
	}
	if speakers[0].Lines != 3 || speakers[1].Lines != 1 {
		t.Fatalf("line counts are wrong: %+v", speakers)
	}
}

// A meeting can have participants and no transcript, so this must be empty
// rather than an error.
func TestSpeakersIsEmptyWithoutATranscript(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	speakers, err := store.Speakers("m1")
	if err != nil {
		t.Fatalf("a meeting with no transcript must not error: %v", err)
	}
	if len(speakers) != 0 {
		t.Fatalf("expected no speakers, got %+v", speakers)
	}
}

// SQLite's TRIM strips only ASCII spaces and its GROUP BY is byte-exact, so
// labels that differ by a tab, a non-breaking space, or a trailing space would
// otherwise come back as separate speakers with their counts split - or as an
// empty name that passed the blank guard.
func TestSpeakersFoldsLabelsThatDifferOnlyByWhitespace(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := store.PutTranscript("m1", []Line{
		{LineNo: 1, Speaker: "Dana Whitfield", OriginalText: "one"},
		{LineNo: 2, Speaker: "Dana Whitfield ", OriginalText: "two"},   // trailing space
		{LineNo: 3, Speaker: " Dana Whitfield", OriginalText: "three"}, // NBSP
		{LineNo: 4, Speaker: "\t", OriginalText: "four"},               // tab only
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}

	speakers, err := store.Speakers("m1")
	if err != nil {
		t.Fatalf("speakers: %v", err)
	}
	if len(speakers) != 1 {
		t.Fatalf("expected the three labels to fold into one speaker, got %+v", speakers)
	}
	if speakers[0].Name != "Dana Whitfield" {
		t.Fatalf("the folded name should be trimmed, got %q", speakers[0].Name)
	}
	if speakers[0].Lines != 3 {
		t.Fatalf("counts should be summed across the labels, got %d", speakers[0].Lines)
	}
}

// Metadata decodes the summary and the participants behind one error, so an
// unreadable summary used to discard a readable roster - and that has shipped:
// a field whose type changed upstream made eight meetings' summary JSON
// undecodable. Participants asks only for what it needs.
func TestParticipantsSurvivesAnUnreadableSummary(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1, Status: StatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES ('m1', '{ broken', '[{"displayName":"Dana Whitfield"}]')`); err != nil {
		t.Fatal(err)
	}

	// The summary reports its own corruption.
	if _, err := store.Summary("m1"); err == nil {
		t.Fatal("an unreadable summary should be reported")
	}
	// The roster is readable and must be returned.
	participants, err := store.Participants("m1")
	if err != nil {
		t.Fatalf("a readable roster must not be lost to an unreadable summary: %v", err)
	}
	if len(participants) != 1 || participants[0].DisplayName != "Dana Whitfield" {
		t.Fatalf("roster is wrong: %+v", participants)
	}
}

// An unreadable roster is still an error: only the coupling was wrong.
func TestParticipantsReportsItsOwnCorruption(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1, Status: StatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES ('m1', 'null', '{ broken')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Participants("m1"); err == nil {
		t.Fatal("an unreadable roster must be reported")
	}
}

// The coupling runs both ways: an unreadable roster used to take a readable
// summary down with it, exactly as an unreadable summary took the roster.
func TestSummarySurvivesAnUnreadableRoster(t *testing.T) {
	store := openTest(t)
	if err := store.PutMeeting(Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1, Status: StatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES ('m1', '{"summary":"we agreed the plan"}', '{ broken')`); err != nil {
		t.Fatal(err)
	}

	metadata, err := store.Summary("m1")
	if err != nil {
		t.Fatalf("a readable summary must not be lost to an unreadable roster: %v", err)
	}
	if metadata.Summary == nil || *metadata.Summary != "we agreed the plan" {
		t.Fatalf("summary is wrong: %+v", metadata)
	}
	// And an unreadable summary is still reported as one.
	if _, err := store.db.Exec(
		`UPDATE meeting_metadata SET summary_json = '{ broken' WHERE meeting_id = 'm1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Summary("m1"); err == nil {
		t.Fatal("an unreadable summary must be reported")
	}
}
