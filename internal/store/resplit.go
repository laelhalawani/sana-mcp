package store

import (
	"database/sql"
	"fmt"
)

// Resplitting long transcript lines.
//
// One Sana segment is one speaker turn, and a speaker turn is however long
// somebody talked without being interrupted. Measured against a real corpus the
// median line is 13 characters and the longest is 25,456: conversation is short
// turns, a screen-share walkthrough is one enormous turn.
//
// A line is the unit everything else addresses. Search returns one, `read`
// numbers them, and a correction names one and replaces a fragment inside it.
// All three degrade badly at 25,000 characters: a search hit prints an essay,
// and counting how many times a word occurs in a line that long is exactly the
// judgement the occurrences guard exists to catch.
//
// So stored lines are re-split in place. The splitter is a pure function of the
// text (see split.go), which is what makes this safe to run over stored data:
// re-running it on original_text reproduces the boundaries a fresh download
// would produce, so nothing has to be re-fetched from Sana.

// Chunk is one piece of a split line, with the byte offset it began at in the
// source text.
//
// The offset is what makes correction remapping exact. Without it a chunk can
// only be located by searching for its text, which picks the wrong one whenever
// a speaker repeats themselves - and repetition is the norm in speech.
type Chunk struct {
	Text  string
	Start int
}

// resplitTranscripts rewrites every stored transcript so no line exceeds what
// split allows. It is idempotent: a line that splits into one chunk is left
// exactly as it was, so a second run changes nothing.
//
// Meetings are done one transaction each rather than all in one. A single
// transaction over a real corpus rewrites 77,000 rows and holds the write lock
// for the duration; per-meeting keeps each one short and means a failure
// halfway leaves the meetings already done correctly split rather than rolling
// the whole corpus back.
func resplitTranscripts(db *sql.DB, split func(string) []Chunk) error {
	rows, err := db.Query(`SELECT DISTINCT meeting_id FROM transcript_lines ORDER BY meeting_id`)
	if err != nil {
		return err
	}
	var meetings []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		meetings = append(meetings, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, meetingID := range meetings {
		if err := resplitMeeting(db, meetingID, split); err != nil {
			return fmt.Errorf("resplit %s: %w", meetingID, err)
		}
	}
	return nil
}

// storedLine is a transcript row as it stands before the split.
type storedLine struct {
	LineNo   int
	Speaker  string
	StartMS  int64
	Original string
}

// placement records where one old line's text ended up: the new line numbers
// its chunks were given, and the chunks themselves.
type placement struct {
	chunks []Chunk
	first  int // new line number of chunk 0; the rest follow consecutively
}

func resplitMeeting(db *sql.DB, meetingID string, split func(string) []Chunk) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.Query(
		`SELECT line_no, speaker, start_ms, original_text
		   FROM transcript_lines WHERE meeting_id = ? ORDER BY line_no`,
		meetingID,
	)
	if err != nil {
		return err
	}
	var stored []storedLine
	for rows.Next() {
		var line storedLine
		if err := rows.Scan(&line.LineNo, &line.Speaker, &line.StartMS, &line.Original); err != nil {
			rows.Close()
			return err
		}
		stored = append(stored, line)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Split everything first, so a meeting that needs no change costs one read
	// and no write at all.
	places := make(map[int]placement, len(stored))
	next := 1
	changed := false
	for _, line := range stored {
		chunks := split(line.Original)
		if len(chunks) == 0 {
			// A line that is empty or all spaces has nothing to split. It keeps
			// its place: dropping it would renumber the meeting for no reason.
			chunks = []Chunk{{Text: line.Original, Start: 0}}
		}
		if len(chunks) > 1 {
			changed = true
		}
		places[line.LineNo] = placement{chunks: chunks, first: next}
		next += len(chunks)
	}
	if !changed {
		return nil
	}

	// Corrections are read before the lines they point at are destroyed, and
	// re-attached afterwards. They are user-owned data that no re-sync can
	// recover, so they are never simply dropped.
	edits, err := loadEdits(tx, meetingID)
	if err != nil {
		return err
	}

	if _, err := tx.Exec(
		`DELETE FROM line_search
		  WHERE rowid IN (SELECT rowid FROM transcript_lines WHERE meeting_id = ?)`,
		meetingID,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM transcript_lines WHERE meeting_id = ?`, meetingID); err != nil {
		return err
	}

	insertLine, err := tx.Prepare(
		`INSERT INTO transcript_lines (meeting_id, line_no, speaker, start_ms, text, original_text)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer insertLine.Close()
	insertSearch, err := tx.Prepare(
		`INSERT INTO line_search (rowid, meeting_id, line_no, text, original_text)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer insertSearch.Close()

	for _, line := range stored {
		place := places[line.LineNo]
		for index, piece := range place.chunks {
			lineNo := place.first + index
			// Every chunk of a segment carries that segment's start time. The
			// per-word timestamps that would give each chunk its own are only
			// available at download, and these lines were downloaded long ago;
			// new transcripts get real per-chunk times from linesFrom.
			result, err := insertLine.Exec(
				meetingID, lineNo, line.Speaker, line.StartMS, piece.Text, piece.Text,
			)
			if err != nil {
				return err
			}
			rowID, err := result.LastInsertId()
			if err != nil {
				return err
			}
			if _, err := insertSearch.Exec(
				rowID, meetingID, lineNo, piece.Text, piece.Text,
			); err != nil {
				return err
			}
		}
	}

	if err := remapEdits(tx, meetingID, edits, places); err != nil {
		return err
	}
	return tx.Commit()
}

// storedEdit is a recorded correction as it stands before the split.
type storedEdit struct {
	EditID   int64
	LineNo   int
	Original string
	Edited   string
	State    string
}

func loadEdits(tx *sql.Tx, meetingID string) ([]storedEdit, error) {
	rows, err := tx.Query(
		`SELECT edit_id, line_no, original_text, edited_text, state
		   FROM line_edits WHERE meeting_id = ? ORDER BY edit_id`,
		meetingID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var edits []storedEdit
	for rows.Next() {
		var edit storedEdit
		if err := rows.Scan(
			&edit.EditID, &edit.LineNo, &edit.Original, &edit.Edited, &edit.State,
		); err != nil {
			return nil, err
		}
		edits = append(edits, edit)
	}
	return edits, rows.Err()
}

// remapEdits re-points corrections at the lines their text now lives on.
//
// A correction records the whole line as it was and the whole line as it reads
// now. After a split neither is a line any more, so both have to be narrowed to
// the chunk that actually changed. The changed span is found by trimming the
// common prefix and suffix - the two texts differ only where the correction
// touched them - and the chunk containing that span becomes the edit's new
// line.
//
// A correction whose changed span straddles a chunk boundary cannot be
// expressed as an edit to one line, so it is marked stale rather than guessed
// at. Stale keeps it visible in history with both its texts, which is how the
// user re-applies it by hand. Nothing is discarded and nothing is applied to a
// line it does not belong to.
func remapEdits(
	tx *sql.Tx, meetingID string, edits []storedEdit, places map[int]placement,
) error {
	for _, edit := range edits {
		place, ok := places[edit.LineNo]
		if !ok {
			// The line this correction named is gone entirely.
			if err := markStale(tx, edit); err != nil {
				return err
			}
			continue
		}
		// An unsplit line keeps its text, so the correction only moves.
		if len(place.chunks) == 1 {
			if err := repointEdit(tx, meetingID, edit, place.first,
				place.chunks[0].Text, edit.Edited); err != nil {
				return err
			}
			continue
		}

		index, narrowed, ok := narrowEdit(edit, place.chunks)
		if !ok {
			if err := markStale(tx, edit); err != nil {
				return err
			}
			continue
		}
		if err := repointEdit(tx, meetingID, edit, place.first+index,
			place.chunks[index].Text, narrowed); err != nil {
			return err
		}
	}
	return nil
}

// narrowEdit finds which chunk a correction changed, and what that chunk reads
// as once the correction is applied to it.
func narrowEdit(edit storedEdit, chunks []Chunk) (int, string, bool) {
	start, end, ok := changedSpan(edit.Original, edit.Edited)
	if !ok {
		return 0, "", false
	}
	for index, piece := range chunks {
		from := piece.Start
		to := piece.Start + len(piece.Text)
		if start < from || end > to {
			continue
		}
		// The span sits wholly inside this chunk, so the correction applies to
		// it and to nothing else.
		replacement := edit.Edited[start : len(edit.Edited)-(len(edit.Original)-end)]
		return index, piece.Text[:start-from] + replacement + piece.Text[end-from:], true
	}
	return 0, "", false
}

// changedSpan is the half-open byte range of original that edited replaced. It
// reports false when the two are identical, which is not a correction at all.
func changedSpan(original, edited string) (int, int, bool) {
	if original == edited {
		return 0, 0, false
	}
	prefix := 0
	for prefix < len(original) && prefix < len(edited) && original[prefix] == edited[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(original)-prefix && suffix < len(edited)-prefix &&
		original[len(original)-1-suffix] == edited[len(edited)-1-suffix] {
		suffix++
	}
	return prefix, len(original) - suffix, true
}

// markStale records that a correction could not be re-attached to a line.
//
// Only a live correction becomes stale. A superseded or reverted row is already
// history, and overwriting its state would misreport what happened to it -
// history exists to say what the user did, so the migration must not rewrite
// it.
func markStale(tx *sql.Tx, edit storedEdit) error {
	if edit.State != EditApplied && edit.State != EditStale {
		return nil
	}
	_, err := tx.Exec(`UPDATE line_edits SET state = ? WHERE edit_id = ?`, EditStale, edit.EditID)
	return err
}

// repointEdit moves a correction onto its new line, narrowing both of its texts
// to that line, and writes the corrected text back if the correction is the one
// currently in force.
func repointEdit(
	tx *sql.Tx, meetingID string, edit storedEdit, lineNo int, original, edited string,
) error {
	if _, err := tx.Exec(
		`UPDATE line_edits
		    SET line_no = ?, original_text = ?, original_sha256 = ?, edited_text = ?
		  WHERE edit_id = ?`,
		lineNo, original, hashText(original), edited, edit.EditID,
	); err != nil {
		return err
	}
	// Only the correction in force owns its line's current text. Superseded and
	// reverted rows are history: rewriting the line from them would resurrect a
	// correction the user already took back.
	if edit.State != EditApplied {
		return nil
	}
	return setLineText(tx, meetingID, lineNo, edited)
}
