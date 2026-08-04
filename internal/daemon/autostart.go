package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/sana"
)

// EnsureRunning starts the sync daemon if one is not already running.
//
// Every surface calls this on the way up, because sync is what makes the local
// store worth reading and nobody should have to remember to start it. Without
// it, meetings only arrive during an install: the flag, the "already running"
// branch, and the comments about autostart all existed with no caller.
//
// Starting is best-effort and never blocks the caller. A machine that is not
// signed in has nothing to sync, and losing the race to another process is the
// expected outcome when a client and the application start together - the
// winner syncs for both, and the loser exits quietly.
//
// What it is not allowed to be is silent. Every branch here that stops a daemon
// from starting used to return with no trace, and the result is a machine that
// reports "0/0" forever with no error anywhere on any screen, because a sync
// that never began cannot record a sync error. That is indistinguishable from a
// hung download and impossible to diagnose remotely. So every abnormal reason
// is written to the daemon log, which is the one file that outlives the process
// that noticed.
func EnsureRunning(runtime *bootstrap.Runtime) {
	if runtime == nil {
		return
	}
	if runtime.Executable == "" {
		note(runtime.Paths, "not starting a daemon: this program cannot resolve its own path")
		return
	}
	session, err := sana.LoadSession(runtime.Paths.Session)
	if err != nil {
		note(runtime.Paths, "not starting a daemon: the stored session could not be read: %v", err)
		return
	}
	// Nothing to sync is the normal state before sign-in, not a fault.
	if !session.SignedIn() {
		return
	}
	// The lock lives in the data root, and probing for it does not create the
	// directory. A missing root therefore made the probe fail, which counted as
	// "cannot tell" and stopped the daemon starting - on exactly the fresh
	// install that most needs one.
	if err := os.MkdirAll(runtime.Paths.Root, 0o700); err != nil {
		note(runtime.Paths, "not starting a daemon: %s is not usable: %v", runtime.Paths.Root, err)
		return
	}
	running, err := daemonRunning(runtime.Paths.Lock)
	if err != nil {
		// Unable to tell means assume one is running, rather than start a
		// second writer against the same database.
		note(runtime.Paths, "not starting a daemon: cannot tell whether one holds %s: %v",
			runtime.Paths.Lock, err)
		return
	}
	if running {
		return
	}
	command := exec.Command(runtime.Executable, "daemon", "--detach")
	detach(command)
	if err := command.Start(); err != nil {
		note(runtime.Paths, "not starting a daemon: %s could not be run: %v",
			runtime.Executable, err)
		return
	}
	// The child is not waited on: it outlives this process by design. Releasing
	// it avoids leaving a zombie for the parent's lifetime.
	go command.Process.Release()
}

// NoteStartupFailure records that a daemon process failed before it could open
// its own log.
//
// Open acquires the lock, the database and the log in that order, so anything
// that fails on the way there has nowhere to report to: a detached daemon's
// stderr is /dev/null, and the caller has already exited. This is the only
// record such a failure leaves.
func NoteStartupFailure(paths config.Paths, err error) {
	note(paths, "daemon failed to start: %v", err)
}

// note appends one line to the daemon log, creating it if needed. It reports
// nothing: it is called on paths that are already failing, and a failure to
// record a failure has nowhere left to go.
func note(paths config.Paths, format string, args ...any) {
	if paths.Log == "" {
		return
	}
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s %s\n",
		time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
