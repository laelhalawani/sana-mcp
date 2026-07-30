// Package app is the full-screen interactive application opened by a bare
// sana-mcp on a TTY: meetings, transcripts, search, sync status, account, and
// configuration.
package app

import (
	"context"
	"fmt"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
)

// Run opens the interactive application.
func Run(ctx context.Context, runtime *bootstrap.Runtime, version string) int {
	fmt.Println("sana-mcp", version, "- interactive application not implemented yet")
	return 1 // TODO: bubbletea program, screens per docs/app-design.md
}
