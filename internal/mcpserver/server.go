// Package mcpserver exposes the meeting_transcripts tool over stdio MCP.
//
// The agent-facing surface is one tool that dispatches on a tool name, and it
// is a contract: see docs/tool-contract.md. Do not change argument or response
// shapes without updating that document and its tests.
package mcpserver

import (
	"context"
	"errors"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
)

// ServeStdio runs the MCP server on stdin/stdout until the context is done.
func ServeStdio(ctx context.Context, runtime *bootstrap.Runtime, version string) error {
	return errors.New("MCP server not implemented yet") // TODO: modelcontextprotocol/go-sdk
}
