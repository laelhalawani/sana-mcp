package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReturnsDefaultsWhenNothingIsStored(t *testing.T) {
	settings, err := Load(PathsUnder(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if settings.SyncIntervalMinutes != Default().SyncIntervalMinutes {
		t.Fatalf("expected the default interval, got %d", settings.SyncIntervalMinutes)
	}
}

// The file is hand-edited rather than written by this program, so a person's
// change to the interval has to be picked up.
func TestLoadReadsAHandEditedFile(t *testing.T) {
	paths := PathsUnder(t.TempDir())
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(File(paths), []byte("sync_interval_minutes = 45\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := Load(paths)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if settings.SyncIntervalMinutes != 45 {
		t.Fatalf("expected the edited interval, got %d", settings.SyncIntervalMinutes)
	}
}

// A malformed file is reported rather than silently replaced with defaults: a
// person who edited it by hand should be told.
func TestMalformedConfigIsReported(t *testing.T) {
	paths := PathsUnder(t.TempDir())
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(File(paths), []byte("this is not = = toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(paths); err == nil {
		t.Fatal("expected a malformed config to be reported")
	}
}

// A nonsensical interval must not make the daemon spin.
func TestZeroIntervalFallsBackToTheDefault(t *testing.T) {
	paths := PathsUnder(t.TempDir())
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(File(paths), []byte("sync_interval_minutes = 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := Load(paths)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if settings.SyncIntervalMinutes != Default().SyncIntervalMinutes {
		t.Fatalf("a zero interval should fall back, got %d", settings.SyncIntervalMinutes)
	}
}

// Every path must come from the root, so a caller cannot assemble one that
// silently misses a field and writes to "".
func TestPathsUnderFillsEveryField(t *testing.T) {
	paths := PathsUnder("/tmp/example")
	for name, value := range map[string]string{
		"Root": paths.Root, "Database": paths.Database, "Session": paths.Session,
		"Lock": paths.Lock, "PID": paths.PID, "Log": paths.Log, "Pending": paths.Pending,
	} {
		if value == "" {
			t.Errorf("%s is empty", name)
		}
		if name != "Root" && filepath.Dir(value) != "/tmp/example" {
			t.Errorf("%s = %q, want it under the root", name, value)
		}
	}
}
