// Package config owns the per-user paths and persisted settings shared by the
// daemon, every MCP process, the CLI, and the interactive application.
package config

import (
	"errors"
	"os"
	"path/filepath"
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

// Load reads the settings, falling back to defaults when none are stored yet.
func Load(paths Paths) (Config, error) {
	// Settings are not written until the user changes one, so a missing file is
	// the normal case rather than an error.
	if _, err := os.Stat(filepath.Join(paths.Root, "config.toml")); errors.Is(err, os.ErrNotExist) {
		return Default(), nil
	}
	return Default(), nil // TODO: decode config.toml once the settings screen exists
}
