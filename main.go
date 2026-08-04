// Command sana-mcp syncs Sana.AI meeting transcripts to this machine and serves
// them to AI agents over MCP, to a person through an interactive application,
// and to scripts through a CLI.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/laelhalawani/sana-mcp/internal/app"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/daemon"
	"github.com/laelhalawani/sana-mcp/internal/install"
	"github.com/laelhalawani/sana-mcp/internal/mcpserver"
	"golang.org/x/term"
)

// version is replaced at build time with -ldflags.
var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:]))
}

func run(ctx context.Context, args []string) int {
	options := cli.Options{
		Version: version,
		Stdin:   os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr,
	}
	command, err := cli.Parse(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		if errors.Is(err, cli.ErrUsage) {
			fmt.Fprint(os.Stderr, "\n", cli.Usage)
		}
		return 2
	}

	// Help and version must work even when the home directory is unwritable,
	// so they run before any state is loaded.
	if command.Name == "help" || command.Name == "version" {
		return cli.Run(ctx, nil, command, options)
	}

	runtime, err := bootstrap.Open()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		return 1
	}

	switch command.Name {
	case "app":
		// A bare invocation means the interactive application on a terminal and
		// the MCP server without one, so an AI client that runs the binary with
		// no arguments still gets a working server.
		if isInteractive() {
			return app.Run(ctx, runtime, version)
		}
		return serveMCP(ctx, runtime)
	case "mcp":
		return serveMCP(ctx, runtime)
	case "daemon":
		return runDaemon(ctx, runtime, command, options)
	case "configure", "install", "uninstall":
		return install.Run(ctx, runtime, command, options)
	default:
		return cli.Run(ctx, runtime, command, options)
	}
}

func serveMCP(ctx context.Context, runtime *bootstrap.Runtime) int {
	if err := mcpserver.ServeStdio(ctx, runtime, version); err != nil {
		// stdout carries MCP framing, so diagnostics must go to stderr.
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		return 1
	}
	return 0
}

func runDaemon(ctx context.Context, runtime *bootstrap.Runtime, command cli.Command, options cli.Options) int {
	if command.Stop {
		return stopDaemon(ctx, runtime, options)
	}
	server, err := daemon.Open(runtime)
	if err != nil {
		if errors.Is(err, daemon.ErrAlreadyRunning) {
			// Losing the autostart race is the expected outcome when two
			// clients start at once, not a failure: the winner syncs for both.
			if !command.Detach {
				fmt.Fprintln(os.Stderr, "sana-mcp: a sync daemon is already running")
			}
			return 0
		}
		// A detached daemon has no stderr and no caller left to read it, so the
		// log is the only place this can be said. Without it a Mac that cannot
		// start its daemon reports "0/0" forever with no evidence anywhere.
		if command.Detach {
			daemon.NoteStartupFailure(runtime.Paths, err)
		}
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		return 1
	}
	defer server.Close()

	if err := server.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		return 1
	}
	return 0
}

func stopDaemon(ctx context.Context, runtime *bootstrap.Runtime, options cli.Options) int {
	stopped, err := daemon.Stop(ctx, runtime)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sana-mcp:", err)
		return 1
	}
	if !stopped {
		fmt.Fprintln(options.Stdout, "No sync daemon is running.")
		return 0
	}
	fmt.Fprintln(options.Stdout, "Stopped the sync daemon.")
	return 0
}

// isInteractive reports whether both stdin and stdout are terminals, which is
// what the full-screen application requires.
func isInteractive() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}
