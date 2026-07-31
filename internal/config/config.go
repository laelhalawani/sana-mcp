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
	Models   string // lazily downloaded embedding model, when the dense channel is enabled
	Session  string // the signed-in Sana session
	Lock     string // daemon singleton lock
	Log      string // daemon log
}

// DefaultPaths resolves the per-user root. It does not create anything: a
// command that only reads must not bring the directory into existence.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, errors.New("cannot resolve the home directory")
	}
	root := filepath.Join(home, ".sana-mcp")
	return Paths{
		Root:     root,
		Database: filepath.Join(root, "sana.db"),
		Models:   filepath.Join(root, "models"),
		Session:  filepath.Join(root, "session.json"),
		Lock:     filepath.Join(root, "daemon.lock"),
		Log:      filepath.Join(root, "daemon.log"),
	}, nil
}

// Config is the complete persisted settings document.
type Config struct {
	Version int `toml:"version"`

	// SemanticSearch enables the dense channel. It is off by default: keyword
	// search answers most queries, and leaving it off means no model download
	// and no indexing pass at all.
	SemanticSearch bool `toml:"semantic_search"`

	// SyncIntervalMinutes is how often the daemon polls Sana for new meetings.
	SyncIntervalMinutes int `toml:"sync_interval_minutes"`
}

// Default is the configuration a fresh install starts from.
func Default() Config {
	return Config{
		Version:             currentVersion,
		SemanticSearch:      false,
		SyncIntervalMinutes: 15,
	}
}

// File is where settings are persisted.
func File(paths Paths) string { return filepath.Join(paths.Root, "config.toml") }

// Load reads the settings, falling back to defaults when none are stored yet.
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

// Save writes the settings atomically, so an interrupted write cannot leave a
// half-written file that then fails to parse.
func Save(paths Paths, settings Config) error {
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		return err
	}
	settings.Version = currentVersion
	payload, err := toml.Marshal(settings)
	if err != nil {
		return err
	}
	temporary := File(paths) + ".new"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, File(paths)); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}
