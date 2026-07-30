// Package bootstrap resolves the paths and configuration every entrypoint
// needs, so main.go, the CLI, the MCP server, and the interactive application
// all start from the same state.
package bootstrap

import (
	"os"

	"github.com/laelhalawani/sana-mcp/internal/config"
)

// Runtime is the shared startup state.
type Runtime struct {
	Paths      config.Paths
	Config     config.Config
	Executable string
}

// Open loads paths and configuration. It does not open the database and does
// not contact the daemon: the installer and help must work on a machine where
// neither is possible.
func Open() (*Runtime, error) {
	paths, err := config.DefaultPaths()
	if err != nil {
		return nil, err
	}
	settings, err := config.Load(paths)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		// A missing executable path only breaks autostart, and reporting it
		// here would block commands that never need it.
		executable = ""
	}
	return &Runtime{Paths: paths, Config: settings, Executable: executable}, nil
}
