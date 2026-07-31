package daemon

import (
	"os/exec"
	"syscall"
)

// detach starts the daemon in its own process group without a console, so it
// survives the shell that started it and never draws a window.
func detach(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | 0x08000000, // DETACHED_PROCESS
	}
}
