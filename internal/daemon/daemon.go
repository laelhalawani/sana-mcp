// Package daemon owns the background sync with Sana: fetching new meetings and
// transcripts, and keeping the search indexes current.
//
// Unlike interactive-terminal-mcp, this daemon holds no kernel objects that
// outlive it. The SQLite database is the shared state, so readers (the MCP
// server, the CLI, the interactive application) open it directly instead of
// talking to the daemon over a socket. The daemon needs only to be a single
// writer, which a file lock provides.
package daemon

import (
	"context"
	"errors"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
)

// ErrAlreadyRunning is returned by Open when another daemon holds the lock.
var ErrAlreadyRunning = errors.New("a sync daemon is already running")

// Server is a running sync daemon.
type Server struct {
	runtime *bootstrap.Runtime
}

// Open acquires the singleton lock and prepares the store.
func Open(runtime *bootstrap.Runtime) (*Server, error) {
	return &Server{runtime: runtime}, nil // TODO: flock + store
}

// Serve runs sync cycles until the context is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	<-ctx.Done()
	return nil // TODO: sync loop
}

// Close releases the lock and the store.
func (s *Server) Close() {}

// Stop asks a running daemon to exit, reporting whether one was running.
func Stop(ctx context.Context, runtime *bootstrap.Runtime) (bool, error) {
	return false, nil // TODO: signal the lock holder
}
