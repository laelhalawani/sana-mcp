// Package store owns the SQLite database: meetings, transcript lines, the
// corrections made to them, the search indexes, and the sync state.
//
// The database is the only shared state in this program. The daemon is its
// single writer; the MCP server, the CLI, and the interactive application open
// it directly and read. WAL mode is what makes that safe, so it is set on every
// connection rather than assumed.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// schemaVersion is bumped whenever migrate needs to do more work. Every
// migration must preserve line_edits: corrections are user-owned data, not
// cache, and cannot be rebuilt by re-syncing.
const schemaVersion = 2

// Store is an open database.
type Store struct {
	db *sql.DB
}

// Open opens (and creates, if needed) the database at path and brings the
// schema up to date.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	// _txlock=immediate makes write transactions take the write lock up front,
	// so a busy writer fails fast instead of deadlocking mid-transaction.
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  status       TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 0,
  -- transcript_state is what makes "never re-download a stored transcript"
  -- decidable: only 'complete' transcripts are skipped on a later sync.
  transcript_state TEXT NOT NULL DEFAULT 'absent',  -- absent | partial | complete
  fetched_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS meetings_by_date ON meetings(created_ms DESC);

-- The summary document and participants are stored as the JSON Sana returned.
-- Keeping the raw documents means a field Sana adds is not lost before this
-- program learns to render it.
CREATE TABLE IF NOT EXISTS meeting_metadata (
  meeting_id        TEXT PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  summary_json      TEXT,
  participants_json TEXT
);

CREATE TABLE IF NOT EXISTS transcript_lines (
  meeting_id    TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  speaker       TEXT NOT NULL,
  start_ms      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  original_text TEXT NOT NULL,
  PRIMARY KEY (meeting_id, line_no)
);

CREATE TABLE IF NOT EXISTS line_edits (
  edit_id         INTEGER PRIMARY KEY,
  meeting_id      TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  original_sha256 TEXT NOT NULL,
  original_text   TEXT NOT NULL,
  edited_text     TEXT NOT NULL,
  edited_ms       INTEGER NOT NULL,
  author          TEXT NOT NULL,
  state           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS line_edits_by_line ON line_edits(meeting_id, line_no, edit_id DESC);
CREATE INDEX IF NOT EXISTS line_edits_by_hash ON line_edits(meeting_id, original_sha256);

CREATE VIRTUAL TABLE IF NOT EXISTS line_search USING fts5(
  meeting_id UNINDEXED,
  line_no UNINDEXED,
  text,
  original_text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS sync_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  phase             TEXT NOT NULL DEFAULT 'idle',
  meetings_total    INTEGER,
  transcripts_done  INTEGER,
  transcripts_total INTEGER,
  retrying          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_ms        INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_state (id) VALUES (1);
`

func (s *Store) migrate() error {
	var current int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if current > schemaVersion {
		return fmt.Errorf(
			"database schema is version %d but this build understands %d; upgrade sana-mcp",
			current, schemaVersion,
		)
	}
	if current == schemaVersion {
		return nil
	}
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	// Version 2 aligns each line_search row's rowid with its transcript_lines
	// row, so corrections can update the index by rowid instead of scanning
	// every indexed line. A database written by version 1 has arbitrary index
	// rowids, and updating those by rowid would rewrite the wrong line's index
	// entry - so the index is rebuilt rather than trusted.
	//
	// Only the index is rebuilt. Transcript text and corrections are untouched:
	// line_edits is user-owned data that no re-sync can recover.
	if current < 2 {
		if err := rebuildSearchIndex(s.db); err != nil {
			return fmt.Errorf("rebuild search index: %w", err)
		}
	}
	if _, err := s.db.Exec(fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("record schema version: %w", err)
	}
	return nil
}

// rebuildSearchIndex repopulates line_search from transcript_lines, giving each
// index row the rowid of the line it describes.
func rebuildSearchIndex(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM line_search`); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO line_search (rowid, meeting_id, line_no, text, original_text)
		 SELECT rowid, meeting_id, line_no, text, original_text FROM transcript_lines`,
	); err != nil {
		return err
	}
	return tx.Commit()
}

// ErrNotFound is returned when a meeting or line does not exist locally.
var ErrNotFound = errors.New("not found")
