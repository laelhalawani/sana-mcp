// Package config owns the per-user paths and persisted settings shared by the
// daemon, every MCP process, the CLI, and the interactive application.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

const currentVersion = 1

// Paths are the on-disk locations this program owns. Everything lives under a
// single directory so that uninstalling is one removal.
type Paths struct {
	Root     string // ~/.sana-mcp
	Database string // the SQLite store: meetings, transcripts, edits, indexes
	Session  string // the signed-in Sana session
	Lock     string // daemon singleton lock
	PID      string // the running daemon's process id
	Log      string // daemon log
	Pending  string // a sign-in awaiting its emailed code
}

// DefaultPaths resolves the per-user root. It does not create anything: a
// command that only reads must not bring the directory into existence.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, errors.New("cannot resolve the home directory")
	}
	return PathsUnder(filepath.Join(home, ".sana-mcp")), nil
}

// PathsUnder derives every path from a root.
//
// It exists so that no caller assembles a Paths field by field: one that misses
// a field yields an empty path, and the failure surfaces far from the mistake
// as a write to "".
func PathsUnder(root string) Paths {
	return Paths{
		Root:     root,
		Database: filepath.Join(root, "sana.db"),
		Session:  filepath.Join(root, "session.json"),
		Lock:     filepath.Join(root, "daemon.lock"),
		PID:      filepath.Join(root, "daemon.pid"),
		Log:      filepath.Join(root, "daemon.log"),
		Pending:  filepath.Join(root, "pending-login.json"),
	}
}

// Config is the complete persisted settings document.
type Config struct {
	Version int `toml:"version"`

	// SyncIntervalMinutes is how often the daemon polls Sana for new meetings.
	SyncIntervalMinutes int `toml:"sync_interval_minutes"`
}

// Default is the configuration a fresh install starts from.
func Default() Config {
	return Config{
		Version:             currentVersion,
		SyncIntervalMinutes: 15,
	}
}

// File is where settings are persisted.
func File(paths Paths) string { return filepath.Join(paths.Root, "config.toml") }

// Load reads the settings, falling back to defaults when none are stored yet.
// Nothing writes this file: it exists so a person can change the sync interval
// by hand, which is the only setting worth changing today.
//
// A malformed file is reported rather than silently replaced with defaults: a
// person who edited it by hand should be told, not have their file ignored.
func Load(paths Paths) (Config, error) {
	payload, err := os.ReadFile(File(paths))
	if errors.Is(err, os.ErrNotExist) {
		// Settings are not written until one is changed, so absence is normal.
		return Default(), nil
	}
	if err != nil {
		return Config{}, err
	}
	settings := Default()
	if err := toml.Unmarshal(payload, &settings); err != nil {
		return Config{}, fmt.Errorf("read %s: %w", File(paths), err)
	}
	if settings.SyncIntervalMinutes <= 0 {
		settings.SyncIntervalMinutes = Default().SyncIntervalMinutes
	}
	settings.Version = currentVersion
	return settings, nil
}
