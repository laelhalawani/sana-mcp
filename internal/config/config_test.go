package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadReturnsDefaultsWhenNothingIsStored(t *testing.T) {
	paths := Paths{Root: t.TempDir()}
	settings, err := Load(paths)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if settings.SyncIntervalMinutes != Default().SyncIntervalMinutes {
		t.Fatalf("expected the default interval, got %d", settings.SyncIntervalMinutes)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	paths := Paths{Root: t.TempDir()}
	settings := Default()
	settings.SyncIntervalMinutes = 45
	settings.SemanticSearch = true
	if err := Save(paths, settings); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := Load(paths)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.SyncIntervalMinutes != 45 || !loaded.SemanticSearch {
		t.Fatalf("settings did not round-trip: %+v", loaded)
	}
}

// A hand-edited file that no longer parses must be reported, not silently
// replaced with defaults.
func TestMalformedConfigIsReported(t *testing.T) {
	paths := Paths{Root: t.TempDir()}
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.Root, "config.toml"),
		[]byte("this is not = = toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(paths); err == nil {
		t.Fatal("expected a malformed config to be reported")
	}
}

// A nonsensical interval must not make the daemon spin.
func TestZeroIntervalFallsBackToTheDefault(t *testing.T) {
	paths := Paths{Root: t.TempDir()}
	settings := Default()
	settings.SyncIntervalMinutes = 0
	if err := Save(paths, settings); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := Load(paths)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.SyncIntervalMinutes != Default().SyncIntervalMinutes {
		t.Fatalf("a zero interval should fall back, got %d", loaded.SyncIntervalMinutes)
	}
}
