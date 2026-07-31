package install

import (
	"context"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/daemon"
)

// syncNow runs sync cycles in the foreground until nothing is left, so the
// installer's progress view has something real to report.
//
// It stops after a bounded time: a first sync of hundreds of meetings should
// not hold the installer open indefinitely, and the daemon finishes the rest.
func syncNow(runtime *bootstrap.Runtime) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	server, err := daemon.Open(runtime)
	if err != nil {
		// A daemon already running is doing this work already, which is the
		// normal case on a reinstall.
		return
	}
	defer server.Close()

	for {
		if err := server.SyncOnce(ctx); err != nil {
			return
		}
		status, err := server.Status()
		if err != nil || status.Complete() || ctx.Err() != nil {
			return
		}
	}
}
