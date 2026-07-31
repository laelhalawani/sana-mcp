package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ListOptions filters and pages the meeting list.
type ListOptions struct {
	Page   int
	Limit  int
	Query  string // substring match on the title
	Sort   string // newest (default) | oldest
	Status string // ready | downloading | processing | retrying
	FromMS int64
	ToMS   int64
}

// ListMeetings returns one page of meetings and the total matching count.
func (s *Store) ListMeetings(options ListOptions) ([]Meeting, int, error) {
	if options.Page < 1 {
		options.Page = 1
	}
	if options.Limit < 1 {
		options.Limit = 25
	}
	where := []string{"1 = 1"}
	var args []any
	if options.Query != "" {
		where = append(where, "LOWER(title) LIKE ?")
		args = append(args, "%"+strings.ToLower(options.Query)+"%")
	}
	if options.Status != "" {
		where = append(where, "status = ?")
		args = append(args, options.Status)
	}
	if options.FromMS > 0 {
		where = append(where, "created_ms >= ?")
		args = append(args, options.FromMS)
	}
	if options.ToMS > 0 {
		where = append(where, "created_ms <= ?")
		args = append(args, options.ToMS)
	}
	clause := strings.Join(where, " AND ")

	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM meetings WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	order := "created_ms DESC"
	if options.Sort == "oldest" {
		order = "created_ms ASC"
	}
	pageArgs := append(append([]any{}, args...), options.Limit, (options.Page-1)*options.Limit)
	rows, err := s.db.Query(
		`SELECT meeting_id, title, created_ms, status, word_count, transcript_state
		   FROM meetings WHERE `+clause+`
		  ORDER BY `+order+`
		  LIMIT ? OFFSET ?`, pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var meetings []Meeting
	for rows.Next() {
		var meeting Meeting
		if err := rows.Scan(
			&meeting.MeetingID, &meeting.Title, &meeting.CreatedMS,
			&meeting.Status, &meeting.WordCount, &meeting.TranscriptState,
		); err != nil {
			return nil, 0, err
		}
		meetings = append(meetings, meeting)
	}
	return meetings, total, rows.Err()
}

// GetMeeting returns one meeting.
func (s *Store) GetMeeting(meetingID string) (Meeting, error) {
	var meeting Meeting
	err := s.db.QueryRow(
		`SELECT meeting_id, title, created_ms, status, word_count, transcript_state
		   FROM meetings WHERE meeting_id = ?`, meetingID,
	).Scan(
		&meeting.MeetingID, &meeting.Title, &meeting.CreatedMS,
		&meeting.Status, &meeting.WordCount, &meeting.TranscriptState,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Meeting{}, fmt.Errorf("%w: meeting %s", ErrNotFound, meetingID)
	}
	return meeting, err
}

// Lines returns a meeting's transcript. A range of [from, to] is 1-based and
// inclusive; zero values mean "from the start" and "to the end".
func (s *Store) Lines(meetingID string, from, to int) ([]Line, error) {
	query := `SELECT line_no, speaker, start_ms, text, original_text
	            FROM transcript_lines WHERE meeting_id = ?`
	args := []any{meetingID}
	if from > 0 {
		query += ` AND line_no >= ?`
		args = append(args, from)
	}
	if to > 0 {
		query += ` AND line_no <= ?`
		args = append(args, to)
	}
	query += ` ORDER BY line_no`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []Line
	for rows.Next() {
		var line Line
		if err := rows.Scan(
			&line.LineNo, &line.Speaker, &line.StartMS, &line.Text, &line.OriginalText,
		); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

// LineCount returns how many lines a meeting's transcript holds.
func (s *Store) LineCount(meetingID string) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM transcript_lines WHERE meeting_id = ?`, meetingID,
	).Scan(&count)
	return count, err
}

// PutMetadata stores a meeting's summary document and participants as the JSON
// the API returned. Storing the raw documents keeps sync simple and means a new
// field Sana adds is not lost before this program learns to render it.
func (s *Store) PutMetadata(meetingID, summaryJSON, participantsJSON string, wordCount int) error {
	_, err := s.db.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES (?, ?, ?)
		 ON CONFLICT(meeting_id) DO UPDATE SET
		   summary_json = excluded.summary_json,
		   participants_json = excluded.participants_json`,
		meetingID, summaryJSON, participantsJSON,
	)
	if err != nil {
		return err
	}
	if wordCount > 0 {
		_, err = s.db.Exec(
			`UPDATE meetings SET word_count = ? WHERE meeting_id = ?`, wordCount, meetingID)
	}
	return err
}

// Metadata returns the stored summary and participant documents.
func (s *Store) Metadata(meetingID string) (summaryJSON, participantsJSON string, err error) {
	err = s.db.QueryRow(
		`SELECT COALESCE(summary_json, ''), COALESCE(participants_json, '')
		   FROM meeting_metadata WHERE meeting_id = ?`, meetingID,
	).Scan(&summaryJSON, &participantsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", fmt.Errorf("%w: metadata for %s", ErrNotFound, meetingID)
	}
	return summaryJSON, participantsJSON, err
}

// NeedsMetadata reports whether a meeting's summary document is still missing.
func (s *Store) NeedsMetadata(meetingID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM meeting_metadata WHERE meeting_id = ?`, meetingID,
	).Scan(&count)
	return count == 0, err
}

// PendingMetadata returns ready meetings whose metadata has not been fetched.
func (s *Store) PendingMetadata(limit int) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT m.meeting_id FROM meetings m
		   LEFT JOIN meeting_metadata d ON d.meeting_id = m.meeting_id
		  WHERE m.status = 'ready' AND d.meeting_id IS NULL
		  ORDER BY m.created_ms DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// WordCount counts the words across a meeting's stored transcript. It is what
// the meeting list reports, so it follows corrections: an edited line counts as
// it now reads.
func (s *Store) WordCount(meetingID string) (int, error) {
	lines, err := s.Lines(meetingID, 0, 0)
	if err != nil {
		return 0, err
	}
	words := 0
	for _, line := range lines {
		words += len(strings.Fields(line.Text))
	}
	return words, nil
}
