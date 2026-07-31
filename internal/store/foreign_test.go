package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

// TestOpenRefusesAForeignSchema is the freeze bug.
//
// The schema is applied with CREATE TABLE IF NOT EXISTS, which silently does
// nothing against a foreign table of the same name. Every later query then
// failed on a missing column, the status read swallowed the error, and the
// application showed "Syncing meetings 0/0" indefinitely.
func TestOpenRefusesAForeignSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sana.db")

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	// The previous implementation's meetings table: unversioned, and keyed on
	// id rather than meeting_id.
	if _, err := raw.Exec(
		`CREATE TABLE meetings (id TEXT PRIMARY KEY, name TEXT, created_at_ms INTEGER)`,
	); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	database, err := Open(path)
	if err == nil {
		database.Close()
		t.Fatal("a foreign database must not open")
	}
	if !errors.Is(err, ErrForeignSchema) {
		t.Fatalf("err = %v, want ErrForeignSchema", err)
	}
}

func TestOpenAcceptsItsOwnUnversionedSchema(t *testing.T) {
	// A database this build wrote and then failed to stamp is still ours: the
	// meetings table has the primary key we store meetings under.
	path := filepath.Join(t.TempDir(), "sana.db")

	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.db.Exec(`PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second, err := Open(path)
	if err != nil {
		t.Fatalf("our own schema must reopen: %v", err)
	}
	second.Close()
}
