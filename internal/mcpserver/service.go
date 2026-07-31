// Package mcpserver exposes the meeting_transcripts tool over stdio MCP.
//
// The agent-facing surface is one tool that dispatches on a tool name. That
// shape is a contract: see docs/tool-contract.md. Handlers are thin - open the
// store, read, render - so the MCP surface and the human CLI cannot drift.
package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	serverName         = "sana-mcp"
	toolName           = "meeting_transcripts"
	developmentVersion = "dev"
)

// Instructions tell a model what this server is for before it has called
// anything. Deliberately short: the tool description carries the detail, and a
// long preamble is paid for on every request.
const Instructions = `Your Sana.AI meeting transcripts, synced to this machine and searchable offline.

Call meeting_transcripts with a tool name and optional args, for example
meeting_transcripts("search", {"query": "pricing"}).

Start with "help" for the full argument schema, "status" for sync progress, or
"list" for recent meetings.`

// Service binds a runtime to an MCP server.
type Service struct {
	runtime *bootstrap.Runtime
	server  *mcp.Server
}

// New constructs the MCP service.
func New(runtime *bootstrap.Runtime, version string) (*Service, error) {
	if runtime == nil {
		return nil, errors.New("a runtime is required")
	}
	if version == "" {
		version = developmentVersion
	}
	server := mcp.NewServer(
		&mcp.Implementation{Name: serverName, Version: version},
		&mcp.ServerOptions{Instructions: Instructions},
	)
	service := &Service{runtime: runtime, server: server}
	service.registerTool()
	return service, nil
}

// Server returns the underlying SDK server.
func (s *Service) Server() *mcp.Server { return s.server }

// RunStdio serves MCP framing on stdin and stdout. The SDK is the only thing
// that writes to stdout; a stray byte there corrupts the protocol.
func (s *Service) RunStdio(ctx context.Context) error {
	return normalizeRunError(s.server.Run(ctx, &mcp.StdioTransport{}))
}

// normalizeRunError turns an ordinary disconnect into a clean exit.
//
// A client closing its end is how every MCP session ends, so it must not be
// reported as a failure. The SDK reports it as a wrapped "server is closing"
// error whose chain does not always carry io.EOF, so the text is checked too:
// exiting non-zero on a normal shutdown makes a harness log an error every
// time a session closes.
func normalizeRunError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	if strings.Contains(err.Error(), "EOF") || strings.Contains(err.Error(), "closing") {
		return nil
	}
	return err
}

// ServeStdio constructs and runs a service over stdin and stdout.
func ServeStdio(ctx context.Context, runtime *bootstrap.Runtime, version string) error {
	service, err := New(runtime, version)
	if err != nil {
		return err
	}
	return service.RunStdio(ctx)
}

// openStore opens the database for one call.
//
// The store is opened per call rather than held: an MCP process may sit idle
// for hours, and a held handle would keep a WAL file hot for no reason.
func (s *Service) openStore() (*store.Store, error) {
	database, err := store.Open(s.runtime.Paths.Database)
	if err != nil {
		return nil, fmt.Errorf("open local store: %w", err)
	}
	return database, nil
}
