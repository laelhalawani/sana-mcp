package daemon

import (
	"os"
	"strconv"
	"strings"
)

// stopByPID ends the recorded process. Windows has no SIGTERM, so this is a
// kill: the daemon's writes are transactional, so an abrupt end leaves the
// database consistent, and the lock is released when the handle closes.
func stopByPID(path string) (bool, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
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
	if err := process.Kill(); err != nil {
		return false, err
	}
	return true, nil
}
