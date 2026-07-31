package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Line is one transcript line as stored.
type Line struct {
	LineNo       int
	Speaker      string
	StartMS      int64
	Text         string // current: the correction if one applies, else the original
	OriginalText string // exactly as Sana delivered it
}

// Meeting is a meeting row.
type Meeting struct {
	MeetingID       string
	Title           string
	CreatedMS       int64
	Status          string
	WordCount       int
	TranscriptState string
}

// Meeting statuses, as the tool contract exposes them. These are the only
// values meetingStatus produces, so they are also the only ones worth
// filtering on.
const (
	StatusReady      = "ready"
	StatusProcessing = "processing"
	StatusRetrying   = "retrying"
)

// MeetingStatuses is the vocabulary, in the order a person cycles through it.
// "No filter" is a surface affordance and is not a status, so it is not here.
var MeetingStatuses = []string{StatusReady, StatusProcessing, StatusRetrying}

// Transcript states.
const (
	TranscriptComplete = "complete"
)

// PutMeetings records a page of the meeting list in one transaction.
//
// Writing them one at a time meant one autocommit transaction and one statement
// prepare per meeting: measured 16.8 ms for a 237-meeting page against 1.1 ms
// here, on every sync cycle.
func (s *Store) PutMeetings(meetings []Meeting) error {
	if len(meetings) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	statement, err := tx.Prepare(putMeetingSQL)
	if err != nil {
		return err
	}
	defer statement.Close()
	for _, meeting := range meetings {
		if _, err := statement.Exec(
			meeting.MeetingID, meeting.Title, meeting.CreatedMS, meeting.Status, meeting.WordCount,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// putMeetingSQL is shared by PutMeeting and PutMeetings so the conflict rules
// cannot diverge between the single and batch paths.
const putMeetingSQL = `INSERT INTO meetings (meeting_id, title, created_ms, status, word_count)
	 VALUES (?, ?, ?, ?, ?)
	 ON CONFLICT(meeting_id) DO UPDATE SET
	   title = excluded.title,
	   created_ms = excluded.created_ms,
	   status = excluded.status`

// PutMeeting inserts or updates a meeting row from the meeting list.
//
// Transcript state and word count are deliberately left alone. The list carries
// neither, so writing them here would reset what a transcript fetch already
// established: every sync cycle would mark stored transcripts as missing and
// report every meeting as empty.
func (s *Store) PutMeeting(m Meeting) error {
	_, err := s.db.Exec(putMeetingSQL,
		m.MeetingID, m.Title, m.CreatedMS, m.Status, m.WordCount)
	return err
}

// NeedsTranscript reports whether a transcript should be fetched. A complete
// transcript is never re-downloaded: Sana does not change one after processing,
// and re-fetching would risk the corrections stored against it.
func (s *Store) NeedsTranscript(meetingID string) (bool, error) {
	var state string
	err := s.db.QueryRow(
		`SELECT transcript_state FROM meetings WHERE meeting_id = ?`, meetingID,
	).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("%w: meeting %s", ErrNotFound, meetingID)
	}
	if err != nil {
		return false, err
	}
	return state != TranscriptComplete, nil
}

// PutTranscript stores a full transcript and marks it complete. Any corrections
// recorded against this meeting are re-applied by content, so a re-download
// never silently discards them: see ReapplyEdits.
func (s *Store) PutTranscript(meetingID string, lines []Line) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// The index rows go first, addressed through the transcript rowids that are
	// about to disappear. Deleting them by meeting_id instead would scan every
	// indexed line in the database - 33 ms per transcript, inside this write
	// transaction, on a real corpus.
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

	for _, line := range lines {
		result, err := insertLine.Exec(
			meetingID, line.LineNo, line.Speaker, line.StartMS, line.OriginalText, line.OriginalText,
		)
		if err != nil {
			return err
		}
		// The search row takes its transcript line's rowid. Without this the
		// index can only be addressed by its UNINDEXED columns, which means a
		// full scan for every later correction.
		rowID, err := result.LastInsertId()
		if err != nil {
			return err
		}
		if _, err := insertSearch.Exec(
			rowID, meetingID, line.LineNo, line.OriginalText, line.OriginalText,
		); err != nil {
			return err
		}
	}
	// The word count is recorded here rather than waiting for the summary
	// document, so the meeting list reports a real size as soon as the
	// transcript lands.
	words := 0
	for _, line := range lines {
		words += len(strings.Fields(line.OriginalText))
	}
	if _, err := tx.Exec(
		`UPDATE meetings SET transcript_state = ?, fetched_ms = ?, word_count = ?
		  WHERE meeting_id = ?`,
		TranscriptComplete, time.Now().UnixMilli(), words, meetingID,
	); err != nil {
		return err
	}
	if err := reapplyEdits(tx, meetingID); err != nil {
		return err
	}
	return tx.Commit()
}

// reapplyEdits re-attaches corrections to a freshly downloaded transcript.
//
// Lines are matched by the hash of their original text, not by line number,
// because re-transcription can shift line boundaries. An edit whose line cannot
// be found is marked stale and kept: it stays visible in history with both its
// texts, so the user can re-apply it by hand. It is never dropped, and never
// applied to a line it does not belong to.
func reapplyEdits(tx *sql.Tx, meetingID string) error {
	rows, err := tx.Query(
		`SELECT edit_id, line_no, original_sha256, edited_text
		   FROM line_edits
		  WHERE meeting_id = ? AND state IN (?, ?)
		  ORDER BY edit_id`,
		meetingID, EditApplied, EditStale,
	)
	if err != nil {
		return err
	}
	type pending struct {
		editID int64
		lineNo int
		hash   string
		text   string
	}
	var edits []pending
	for rows.Next() {
		var edit pending
		if err := rows.Scan(&edit.editID, &edit.lineNo, &edit.hash, &edit.text); err != nil {
			rows.Close()
			return err
		}
		edits = append(edits, edit)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, edit := range edits {
		lineNo, found, err := findLineByHash(tx, meetingID, edit.lineNo, edit.hash)
		if err != nil {
			return err
		}
		if !found {
			if _, err := tx.Exec(
				`UPDATE line_edits SET state = ? WHERE edit_id = ?`, EditStale, edit.editID,
			); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(
			`UPDATE line_edits SET state = ?, line_no = ? WHERE edit_id = ?`,
			EditApplied, lineNo, edit.editID,
		); err != nil {
			return err
		}
		if err := setLineText(tx, meetingID, lineNo, edit.text); err != nil {
			return err
		}
	}
	return nil
}

// findLineByHash looks for the line an edit belongs to: first where it used to
// be, then anywhere in the meeting.
func findLineByHash(tx *sql.Tx, meetingID string, preferred int, hash string) (int, bool, error) {
	var original string
	err := tx.QueryRow(
		`SELECT original_text FROM transcript_lines WHERE meeting_id = ? AND line_no = ?`,
		meetingID, preferred,
	).Scan(&original)
	if err == nil && hashText(original) == hash {
		return preferred, true, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}

	rows, err := tx.Query(
		`SELECT line_no, original_text FROM transcript_lines WHERE meeting_id = ? ORDER BY line_no`,
		meetingID,
	)
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var lineNo int
		var text string
		if err := rows.Scan(&lineNo, &text); err != nil {
			return 0, false, err
		}
		if hashText(text) == hash {
			return lineNo, true, nil
		}
	}
	return 0, false, rows.Err()
}
