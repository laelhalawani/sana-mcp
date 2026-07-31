package store

import (
	"context"
	"database/sql"
	"time"
)

// Sync phases. These are the states the daemon moves through, and every
// surface - installer, TUI, CLI, MCP - renders the same set.
const (
	PhaseIdle        = "idle"        // never synced
	PhaseListing     = "listing"     // fetching the meeting list
	PhaseDownloading = "downloading" // fetching transcripts
	PhaseSynced      = "synced"      // caught up
	PhaseNeedsLogin  = "needs_login" // session absent or expired
	PhaseError       = "error"       // sync needs attention
)

// Status is one consistent view of sync progress. Every field is read in a
// single transaction, so the numbers cannot disagree with each other.
type Status struct {
	Phase            string
	Meetings         int // fully downloaded, transcript and all
	MeetingsTotal    int // discovered from Sana, including still-processing rows
	TranscriptsDone  int
	TranscriptsTotal int
	Remaining        int
	LastError        string
}

// Complete reports whether there is nothing left to fetch.
func (s Status) Complete() bool {
	return s.Phase == PhaseSynced && s.Remaining == 0
}

// Status reads one consistent snapshot of sync progress.
func (s *Store) Status() (Status, error) {
	// One transaction, so the counts below cannot disagree with each other, and
	// explicitly read-only: the DSN sets _txlock=immediate, which makes a plain
	// Begin take the write lock even for a pure read. Status is the most
	// frequently called query in the program - once a second from the
	// application, more from the installer - so it must not contend with the
	// sync it is reporting on.
	//
	// BeginTx with a nil context blocks forever rather than failing, which is
	// how that was first found; context.Background() is explicit here.
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Status{}, err
	}
	defer tx.Rollback()

	var status Status
	var lastError sql.NullString
	err = tx.QueryRow(
		`SELECT phase, last_error FROM sync_state WHERE id = 1`,
	).Scan(&status.Phase, &lastError)
	if err != nil {
		return Status{}, err
	}
	if lastError.Valid {
		status.LastError = lastError.String
	}

	if err := tx.QueryRow(`SELECT COUNT(*) FROM meetings`).Scan(&status.MeetingsTotal); err != nil {
		return Status{}, err
	}
	if err := tx.QueryRow(
		`SELECT COUNT(*) FROM meetings WHERE transcript_state = ?`, TranscriptComplete,
	).Scan(&status.Meetings); err != nil {
		return Status{}, err
	}
	// Only meetings Sana has finished processing can supply a transcript, so
	// they are the honest denominator: a meeting still processing upstream is
	// not something this program is waiting on.
	if err := tx.QueryRow(
		`SELECT COUNT(*) FROM meetings WHERE status = 'ready'`,
	).Scan(&status.TranscriptsTotal); err != nil {
		return Status{}, err
	}
	if err := tx.QueryRow(
		`SELECT COUNT(*) FROM meetings WHERE status = 'ready' AND transcript_state = ?`,
		TranscriptComplete,
	).Scan(&status.TranscriptsDone); err != nil {
		return Status{}, err
	}
	status.Remaining = status.TranscriptsTotal - status.TranscriptsDone
	if status.Remaining < 0 {
		status.Remaining = 0
	}
	return status, nil
}

// SetPhase records the current phase, clearing any previous error.
func (s *Store) SetPhase(phase string) error {
	_, err := s.db.Exec(
		`UPDATE sync_state SET phase = ?, last_error = NULL, updated_ms = ? WHERE id = 1`,
		phase, time.Now().UnixMilli(),
	)
	return err
}

// SetError records a failure and moves to the error phase.
func (s *Store) SetError(message string) error {
	_, err := s.db.Exec(
		`UPDATE sync_state SET phase = ?, last_error = ?, updated_ms = ? WHERE id = 1`,
		PhaseError, message, time.Now().UnixMilli(),
	)
	return err
}

// PendingTranscripts returns the meetings whose transcripts still need
// fetching, newest first, so a person sees recent meetings appear soonest.
func (s *Store) PendingTranscripts(limit int) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT meeting_id FROM meetings
		  WHERE status = 'ready' AND transcript_state != ?
		  ORDER BY created_ms DESC
		  LIMIT ?`,
		TranscriptComplete, limit,
	)
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
