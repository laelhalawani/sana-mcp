package daemon

import (
	"os"
	"strconv"
	"strings"
)

// stopByPID asks the recorded process to shut down.
//
// Reading and validating the pid is identical on every platform; only the way a
// process is asked to stop differs, which is what the per-platform terminate
// functions provide.
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
	if err := terminate(process); err != nil {
		return false, err
	}
	return true, nil
}
