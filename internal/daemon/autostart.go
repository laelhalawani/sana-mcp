package daemon

import (
	"os/exec"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
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
func EnsureRunning(runtime *bootstrap.Runtime) {
	if runtime == nil || runtime.Executable == "" {
		return
	}
	session, err := sana.LoadSession(runtime.Paths.Session)
	if err != nil || !session.SignedIn() {
		return
	}
	if running(runtime) {
		return
	}
	command := exec.Command(runtime.Executable, "daemon", "--detach")
	detach(command)
	if err := command.Start(); err != nil {
		return
	}
	// The child is not waited on: it outlives this process by design. Releasing
	// it avoids leaving a zombie for the parent's lifetime.
	go command.Process.Release()
}

// running reports whether a daemon holds the lock.
func running(runtime *bootstrap.Runtime) bool {
	lock := newLock(runtime.Paths.Lock)
	held, err := lock.TryLock()
	if err != nil {
		// Unable to tell; assume one is running rather than start a second.
		return true
	}
	if held {
		lock.Unlock()
		return false
	}
	return true
}
