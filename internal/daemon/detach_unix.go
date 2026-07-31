//go:build !windows

package daemon

import (
	"os/exec"
	"syscall"
)

// detach puts the daemon in its own session, so it survives the terminal that
// started it closing and does not receive that terminal's signals.
func detach(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
