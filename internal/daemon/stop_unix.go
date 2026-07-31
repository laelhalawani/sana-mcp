//go:build !windows

package daemon

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// stopByPID asks the recorded process to shut down. SIGTERM is what the daemon
// installs a handler for, so the sync finishes its current write and the lock is
// released cleanly.
func stopByPID(path string) (bool, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		// The lock is held but no pid was recorded: report that something is
		// running rather than claiming success for a stop that did not happen.
		return false, errNoRecordedPID
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(payload)))
	if err != nil || pid <= 0 {
		return false, errNoRecordedPID
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false, err
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		return false, err
	}
	return true, nil
}
