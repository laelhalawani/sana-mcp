package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrLineMismatch is returned when the fragment supplied with an edit does not
// occur in the line exactly as many times as the caller said it would.
//
// It is the compare-and-swap failing. The count is deliberately not part of the
// error: told "there were 3", a caller will simply retry with 3 and replace two
// occurrences it has never looked at. The only safe next step is to read the
// line, which is what the message asks for.
var ErrLineMismatch = errors.New("the fragment does not occur in the line the number of times given")

// Edit states.
const (
	EditApplied    = "applied"    // the current text of its line
	EditSuperseded = "superseded" // replaced by a later edit
	EditReverted   = "reverted"   // undone, line back to its original
	EditStale      = "stale"      // its line vanished in a re-download; kept for the user
)

// Authors.
const (
	AuthorUser  = "user"
	AuthorAgent = "agent"
)

// Edit is one recorded correction.
type Edit struct {
	EditID       int64
	MeetingID    string
	LineNo       int
	OriginalText string
	EditedText   string
	EditedMS     int64
	Author       string
	State        string
}

func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// EditLine replaces occurrences of a fragment within one line, addressed by
// meeting and 1-based line number.
//
// fragment is matched against the line as it currently reads, and must occur
// exactly occurrences times. That count is the whole safety mechanism: naming
// how many matches are expected is how a caller says which text it has actually
// looked at, so a fragment that turns out to appear somewhere else in the line
// stops the edit instead of silently changing a second place.
//
// Passing the whole line as the fragment with a count of one is the
// replace-the-line case, which is what the interactive editor does.
//
// The original text Sana delivered is never overwritten.
func (s *Store) EditLine(
	meetingID string, lineNo int, fragment, replacement string, occurrences int, author string,
) (Edit, error) {
	if fragment == "" {
		return Edit{}, errors.New("a fragment to replace is required")
	}
	if occurrences < 1 {
		return Edit{}, errors.New("occurrences must be at least 1")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return Edit{}, err
	}
	defer tx.Rollback()

	var current, original string
	err = tx.QueryRow(
		`SELECT text, original_text FROM transcript_lines WHERE meeting_id = ? AND line_no = ?`,
		meetingID, lineNo,
	).Scan(&current, &original)
	if errors.Is(err, sql.ErrNoRows) {
		return Edit{}, fmt.Errorf("%w: %s line %d", ErrNotFound, meetingID, lineNo)
	}
	if err != nil {
		return Edit{}, err
	}
	if strings.Count(current, fragment) != occurrences {
		return Edit{}, fmt.Errorf("%w: %s line %d", ErrLineMismatch, meetingID, lineNo)
	}
	replaced := strings.Replace(current, fragment, replacement, occurrences)
	if replaced == current {
		return Edit{}, errors.New("the replacement is identical to the current line")
	}
	replacement = replaced

	now := time.Now().UnixMilli()
	if _, err := tx.Exec(
		`UPDATE line_edits SET state = ? WHERE meeting_id = ? AND line_no = ? AND state = ?`,
		EditSuperseded, meetingID, lineNo, EditApplied,
	); err != nil {
		return Edit{}, err
	}
	result, err := tx.Exec(
		`INSERT INTO line_edits
		   (meeting_id, line_no, original_sha256, original_text, edited_text, edited_ms, author, state)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		meetingID, lineNo, hashText(original), original, replacement, now, author, EditApplied,
	)
	if err != nil {
		return Edit{}, err
	}
	editID, err := result.LastInsertId()
	if err != nil {
		return Edit{}, err
	}
	if err := setLineText(tx, meetingID, lineNo, replacement); err != nil {
		return Edit{}, err
	}
	if err := tx.Commit(); err != nil {
		return Edit{}, err
	}
	return Edit{
		EditID: editID, MeetingID: meetingID, LineNo: lineNo,
		OriginalText: original, EditedText: replacement,
		EditedMS: now, Author: author, State: EditApplied,
	}, nil
}

// RestoreLine returns a line to the text Sana delivered.
func (s *Store) RestoreLine(meetingID string, lineNo int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var original string
	err = tx.QueryRow(
		`SELECT original_text FROM transcript_lines WHERE meeting_id = ? AND line_no = ?`,
		meetingID, lineNo,
	).Scan(&original)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: %s line %d", ErrNotFound, meetingID, lineNo)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`UPDATE line_edits SET state = ? WHERE meeting_id = ? AND line_no = ? AND state = ?`,
		EditReverted, meetingID, lineNo, EditApplied,
	); err != nil {
		return err
	}
	if err := setLineText(tx, meetingID, lineNo, original); err != nil {
		return err
	}
	return tx.Commit()
}

// LineHistory returns every recorded edit for a meeting, newest first. With
// lineNo > 0 it is narrowed to a single line.
func (s *Store) LineHistory(meetingID string, lineNo int) ([]Edit, error) {
	query := `SELECT edit_id, meeting_id, line_no, original_text, edited_text, edited_ms, author, state
	            FROM line_edits WHERE meeting_id = ?`
	args := []any{meetingID}
	if lineNo > 0 {
		query += ` AND line_no = ?`
		args = append(args, lineNo)
	}
	query += ` ORDER BY edit_id DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var edits []Edit
	for rows.Next() {
		var edit Edit
		if err := rows.Scan(
			&edit.EditID, &edit.MeetingID, &edit.LineNo, &edit.OriginalText,
			&edit.EditedText, &edit.EditedMS, &edit.Author, &edit.State,
		); err != nil {
			return nil, err
		}
		edits = append(edits, edit)
	}
	return edits, rows.Err()
}

// setLineText writes the current text of a line and keeps the search index in
// step.
//
// The index row is updated by rowid, which is what makes this cheap.
// `meeting_id` and `line_no` are UNINDEXED FTS5 columns, so a WHERE over them
// is a linear scan of every indexed line in the database - measured at 33 ms
// against a real corpus, versus 13 microseconds by rowid. Every saved
// correction paid that, and a re-download paid it once per re-applied edit.
//
// line_search rows are inserted with the rowid of their transcript_lines row
// (see PutTranscript), so the two stay addressable by the same key.
func setLineText(tx *sql.Tx, meetingID string, lineNo int, text string) error {
	var rowID int64
	var original string
	if err := tx.QueryRow(
		`SELECT rowid, original_text FROM transcript_lines WHERE meeting_id = ? AND line_no = ?`,
		meetingID, lineNo,
	).Scan(&rowID, &original); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`UPDATE transcript_lines SET text = ? WHERE rowid = ?`, text, rowID,
	); err != nil {
		return err
	}
	// An ordinary contentless-free FTS5 table accepts UPDATE by rowid; this is
	// not an external-content table, so no delete-and-reinsert is needed.
	_, err := tx.Exec(
		`UPDATE line_search SET text = ?, original_text = ? WHERE rowid = ?`,
		text, original, rowID,
	)
	return err
}
