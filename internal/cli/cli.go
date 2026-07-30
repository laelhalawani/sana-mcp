// Package cli parses the command line and runs the one-shot commands. It holds
// no state of its own: everything it needs arrives through bootstrap.Runtime.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
)

// ErrUsage marks a parse failure that should print the usage text.
var ErrUsage = errors.New("usage")

// Usage is the help text, and the only place the command set is written out
// for a person.
const Usage = `sana-mcp - your Sana.AI meeting transcripts, on this machine.

  sana-mcp                    interactive application (or MCP server without a terminal)
  sana-mcp mcp                stdio MCP server, always
  sana-mcp configure          add or remove sana-mcp from your AI clients
  sana-mcp daemon [--stop]    the background sync daemon

  sana-mcp login [email]      sign in to Sana
  sana-mcp status             sync progress and coverage
  sana-mcp list               meetings, newest first
  sana-mcp read <id>          a transcript
  sana-mcp search <query>     search across transcripts
  sana-mcp summary <id>       summary, notes, and action items
  sana-mcp participants <id>  who attended
  sana-mcp recording <id>     a temporary recording link

  sana-mcp help               this text
  sana-mcp version            the installed version
`

// Options carries process-level values the commands must not reach for
// themselves, so that tests can supply their own.
type Options struct {
	Version    string
	Executable string
	Stdin      io.Reader
	Stdout     io.Writer
	Stderr     io.Writer
}

// Command is a parsed invocation. Name is always set; the rest is per-command.
type Command struct {
	Name string
	Args []string

	// daemon
	Stop   bool
	Detach bool
}

// Parse turns an argument vector into a Command. An empty vector is the
// interactive application, which is what a bare `sana-mcp` means.
func Parse(args []string) (Command, error) {
	if len(args) == 0 {
		return Command{Name: "app"}, nil
	}

	command := Command{Name: args[0], Args: args[1:]}
	switch command.Name {
	case "app", "mcp", "configure", "install", "uninstall",
		"login", "status", "list", "read", "search", "summary",
		"participants", "recording", "help", "version":
		return command, nil
	case "daemon":
		for _, argument := range command.Args {
			switch argument {
			case "--stop":
				command.Stop = true
			case "--detach":
				command.Detach = true
			default:
				return Command{}, fmt.Errorf("%w: unknown daemon flag %q", ErrUsage, argument)
			}
		}
		return command, nil
	default:
		return Command{}, fmt.Errorf("%w: unknown command %q", ErrUsage, command.Name)
	}
}

// Run executes a one-shot command. runtime is nil for help and version, which
// must work before any state is loaded.
func Run(ctx context.Context, runtime *bootstrap.Runtime, command Command, options Options) int {
	switch command.Name {
	case "help":
		fmt.Fprint(options.Stdout, Usage)
		return 0
	case "version":
		fmt.Fprintln(options.Stdout, options.Version)
		return 0
	}
	fmt.Fprintf(options.Stderr, "sana-mcp: %s is not implemented yet\n", command.Name)
	return 1
}
