package daemon

import "os"

// terminate ends the daemon. Windows has no SIGTERM; the daemon's writes are
// transactional, so an abrupt end leaves the database consistent and the lock
// is released when the handle closes.
func terminate(process *os.Process) error { return process.Kill() }
