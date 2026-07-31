// Package localstate owns the directory this program keeps on disk: what is in
// it, whether this build can use it, and how to replace or remove it.
//
// It exists because an installer that writes client configuration before
// looking at the local state can leave a machine in a worse position than it
// found it. A previous implementation's database is not readable by this one,
// and the difference is only visible from here.
package localstate

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// owned is every name this build writes into the data root. Anything else in
// there was left by a different implementation.
//
// bin is on the list because the installer script puts the binary inside the
// data root. It is never quarantined: it is the program doing the quarantining.
var owned = map[string]bool{
	"bin":                true,
	"sana.db":            true,
	"sana.db-wal":        true,
	"sana.db-shm":        true,
	"session.json":       true,
	"config.toml":        true,
	"daemon.lock":        true,
	"daemon.pid":         true,
	"daemon.log":         true,
	"pending-login.json": true,
	journalName:          true,
}

const journalName = "incompatible-reset.json"

// Report is what Inspect found.
type Report struct {
	Root string
	// Present is whether there is any local state at all.
	Present bool
	// Usable is whether this build can open the database that is there. A fresh
	// machine is usable: there is nothing to be incompatible with.
	Usable bool
	// Reason is why it is not usable, in words for a person.
	Reason string
	// Foreign lists the entries in the root that this build does not own,
	// sorted. They are what a previous implementation left behind.
	Foreign []string
	// SessionPresent is whether a sign-in is stored. It survives a reset if it
	// is in a format this build can still read, which is why the warning says
	// sign-in "may" be needed again rather than promising either way.
	SessionPresent bool
}

// Inspect reads the data root without changing anything.
func Inspect(paths config.Paths) Report {
	report := Report{Root: paths.Root, Usable: true}

	entries, err := os.ReadDir(paths.Root)
	if errors.Is(err, os.ErrNotExist) {
		return report
	}
	if err != nil {
		report.Present = true
		report.Usable = false
		report.Reason = err.Error()
		return report
	}
	report.Present = true
	for _, entry := range entries {
		if !owned[entry.Name()] {
			report.Foreign = append(report.Foreign, entry.Name())
		}
	}
	sort.Strings(report.Foreign)

	if _, err := os.Stat(paths.Session); err == nil {
		report.SessionPresent = true
	}

	if _, err := os.Stat(paths.Database); errors.Is(err, os.ErrNotExist) {
		return report
	}
	database, err := store.Open(paths.Database)
	if err != nil {
		report.Usable = false
		report.Reason = err.Error()
		return report
	}
	database.Close()
	return report
}

// Incompatible reports whether the state has to be replaced before this build
// can sync.
func (r Report) Incompatible() bool { return r.Present && !r.Usable }

// journal records a reset in progress, so a run that dies between the move and
// the replacement can be undone by the next one.
type journal struct {
	State      string   `json:"state"` // quarantined | committed
	Root       string   `json:"root"`
	Quarantine string   `json:"quarantine"`
	Moved      []string `json:"moved"`
}

// Reset is a started replacement of the local state.
type Reset struct {
	paths   config.Paths
	file    string
	journal journal
}

// Quarantine is where the replaced state was put, so the caller can say so.
func (r *Reset) Quarantine() string { return r.journal.Quarantine }

func token() (string, error) {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// Begin moves the unusable state aside, leaving an empty root behind.
//
// Nothing is deleted here. The old state stays in a sibling directory until
// Commit, so a failure part-way through setup can put it back exactly.
func Begin(paths config.Paths) (*Reset, error) {
	if err := Recover(paths); err != nil {
		return nil, err
	}
	suffix, err := token()
	if err != nil {
		return nil, err
	}
	quarantine := filepath.Join(filepath.Dir(paths.Root),
		"."+filepath.Base(paths.Root)+"-incompatible-"+suffix)
	if _, err := os.Stat(quarantine); err == nil {
		return nil, fmt.Errorf("%s already exists", quarantine)
	}
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		return nil, err
	}
	if err := os.Mkdir(quarantine, 0o700); err != nil {
		return nil, err
	}

	reset := &Reset{
		paths: paths,
		file:  filepath.Join(paths.Root, journalName),
		journal: journal{
			State:      "quarantined",
			Root:       paths.Root,
			Quarantine: quarantine,
		},
	}
	if err := reset.write(); err != nil {
		os.Remove(quarantine)
		return nil, err
	}

	entries, err := os.ReadDir(paths.Root)
	if err != nil {
		return nil, reset.abort(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		// bin holds the running binary and the journal is how this is undone;
		// everything else goes, including state this build owns, because a
		// half-replaced root is worse than a replaced one.
		if name == "bin" || name == journalName {
			continue
		}
		if err := os.Rename(filepath.Join(paths.Root, name), filepath.Join(quarantine, name)); err != nil {
			return nil, reset.abort(err)
		}
		reset.journal.Moved = append(reset.journal.Moved, name)
		if err := reset.write(); err != nil {
			return nil, reset.abort(err)
		}
	}
	return reset, nil
}

func (r *Reset) write() error {
	payload, err := json.Marshal(r.journal)
	if err != nil {
		return err
	}
	return os.WriteFile(r.file, payload, 0o600)
}

// abort rolls back and reports the original failure, or both if the rollback
// also failed.
func (r *Reset) abort(cause error) error {
	if err := r.Rollback(); err != nil {
		return fmt.Errorf("%w (and the state could not be restored: %v)", cause, err)
	}
	return cause
}

// Commit accepts the replacement and deletes what was moved aside.
func (r *Reset) Commit() error {
	if err := os.RemoveAll(r.journal.Quarantine); err != nil {
		return err
	}
	return os.Remove(r.file)
}

// Rollback puts the original state back.
func (r *Reset) Rollback() error {
	for index := len(r.journal.Moved) - 1; index >= 0; index-- {
		name := r.journal.Moved[index]
		source := filepath.Join(r.journal.Quarantine, name)
		if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
			continue
		}
		// Whatever the fresh run wrote under this name is discarded: the
		// original is the thing being restored.
		if err := os.RemoveAll(filepath.Join(r.journal.Root, name)); err != nil {
			return err
		}
		if err := os.Rename(source, filepath.Join(r.journal.Root, name)); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(r.journal.Quarantine); err != nil {
		return err
	}
	return os.Remove(r.file)
}

// Recover undoes a reset that a previous run started and never finished.
//
// It is called before any new reset and at the start of the installer, so a
// machine is never left with its meetings in a hidden directory because a
// terminal was closed at the wrong moment.
func Recover(paths config.Paths) error {
	file := filepath.Join(paths.Root, journalName)
	payload, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var stored journal
	if err := json.Unmarshal(payload, &stored); err != nil {
		return fmt.Errorf("read %s: %w", file, err)
	}
	if stored.Root != paths.Root || !strings.Contains(stored.Quarantine, "-incompatible-") {
		return fmt.Errorf("%s does not describe this installation", file)
	}
	reset := &Reset{paths: paths, file: file, journal: stored}
	if stored.State == "committed" {
		return reset.Commit()
	}
	return reset.Rollback()
}
