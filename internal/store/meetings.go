package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/sana"
)

// ListOptions filters and pages the meeting list.
type ListOptions struct {
	Page   int
	Limit  int
	Query  string // substring match on the title
	Sort   string // newest (default) | oldest
	Status string // one of store.MeetingStatuses; empty means no filter
	FromMS int64
	ToMS   int64
}

// DefaultPageSize is how many meetings a page holds when the caller does not say.
const DefaultPageSize = 25

// Normalize fills in the paging defaults and reports them back, so a caller
// rendering "page X of Y" uses the same numbers the query did rather than
// restating the rules.
func (o *ListOptions) Normalize() {
	if o.Page < 1 {
		o.Page = 1
	}
	if o.Limit < 1 {
		o.Limit = DefaultPageSize
	}
}

// Pages reports how many pages of this size a total spans, at least one so an
// empty result still reads as "page 1 of 1". It lives beside Normalize so a
// caller rendering "page X of Y" uses the same numbers the query did.
func (o ListOptions) Pages(total int) int {
	o.Normalize()
	if pages := (total + o.Limit - 1) / o.Limit; pages > 1 {
		return pages
	}
	return 1
}

// ListMeetings returns one page of meetings and the total matching count.
func (s *Store) ListMeetings(options ListOptions) ([]Meeting, int, error) {
	options.Normalize()
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

// PutMetadata stores a meeting's summary document and participants.
//
// They are persisted as the JSON Sana returned, so a field Sana adds is not
// lost before this program learns to render it - but that is a fact about the
// column, not something a caller should handle. Marshalling happens here so
// three surfaces do not each unmarshal and each fail differently on an empty
// document.
func (s *Store) PutMetadata(meetingID string, metadata sana.Metadata, participants []sana.Participant) error {
	summaryJSON, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	participantsJSON, err := json.Marshal(participants)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES (?, ?, ?)
		 ON CONFLICT(meeting_id) DO UPDATE SET
		   summary_json = excluded.summary_json,
		   participants_json = excluded.participants_json`,
		meetingID, string(summaryJSON), string(participantsJSON),
	)
	return err
}

// Metadata returns a meeting's stored summary document and participants.
func (s *Store) Metadata(meetingID string) (sana.Metadata, []sana.Participant, error) {
	var summaryJSON, participantsJSON string
	err := s.db.QueryRow(
		`SELECT COALESCE(summary_json, ''), COALESCE(participants_json, '')
		   FROM meeting_metadata WHERE meeting_id = ?`, meetingID,
	).Scan(&summaryJSON, &participantsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return sana.Metadata{}, nil, fmt.Errorf("%w: metadata for %s", ErrNotFound, meetingID)
	}
	if err != nil {
		return sana.Metadata{}, nil, err
	}
	var metadata sana.Metadata
	if summaryJSON != "" {
		if err := json.Unmarshal([]byte(summaryJSON), &metadata); err != nil {
			return sana.Metadata{}, nil, fmt.Errorf("stored summary for %s: %w", meetingID, err)
		}
	}
	var participants []sana.Participant
	if participantsJSON != "" {
		if err := json.Unmarshal([]byte(participantsJSON), &participants); err != nil {
			return sana.Metadata{}, nil, fmt.Errorf("stored participants for %s: %w", meetingID, err)
		}
	}
	return metadata, participants, nil
}

// PendingMetadata returns ready meetings whose metadata has not been fetched.
func (s *Store) PendingMetadata(limit int) ([]string, error) {
	return s.meetingIDs(
		`SELECT m.meeting_id FROM meetings m
		   LEFT JOIN meeting_metadata d ON d.meeting_id = m.meeting_id
		  WHERE m.status = 'ready' AND d.meeting_id IS NULL
		  ORDER BY m.created_ms DESC LIMIT ?`, limit)
}
