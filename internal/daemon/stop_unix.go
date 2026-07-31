//go:build !windows

package daemon

import (
	"os"
	"syscall"
)

// terminate asks the daemon to shut down. SIGTERM is what it installs a handler
// for, so the current write finishes and the lock is released cleanly.
func terminate(process *os.Process) error { return process.Signal(syscall.SIGTERM) }
