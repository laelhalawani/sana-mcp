// Package install registers the MCP server with the AI harnesses on this
// machine, and owns the settings flow shared by the installer and the
// interactive application.
package install

import (
	"context"
	"fmt"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
)

// ServerName is the entry name written into every harness configuration.
const ServerName = "sana-mcp"

// Run executes configure, install, or uninstall.
func Run(ctx context.Context, runtime *bootstrap.Runtime, command cli.Command, options cli.Options) int {
	fmt.Fprintln(options.Stderr, "sana-mcp: configure is not implemented yet")
	return 1 // TODO: detect-harness + bubbletea installer per it-mcp/internal/install
}
