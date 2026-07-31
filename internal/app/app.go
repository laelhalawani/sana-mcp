// Package app is the full-screen interactive application opened by a bare
// sana-mcp on a TTY.
//
// The screens and their keys follow the shipped TypeScript application, because
// people already know them. What is new is transcript correction: editing a
// line, seeing what was changed, and putting it back.
package app

import (
	"context"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// screen is one view of the application.
type screen int

const (
	screenMenu screen = iota
	screenMeetings
	screenTranscript
	screenSummary
	screenParticipants
	screenRecording
	screenSearch
	screenStatus
	screenAccount
	screenConfig
	screenEdit
	screenHistory
)

// Run opens the interactive application.
func Run(ctx context.Context, runtime *bootstrap.Runtime, version string) int {
	database, err := store.Open(runtime.Paths.Database)
	if err != nil {
		fmt.Println("sana-mcp:", err)
		return 1
	}
	defer database.Close()

	program := tea.NewProgram(
		newModel(ctx, runtime, database, version),
		tea.WithAltScreen(),
		tea.WithContext(ctx),
	)
	if _, err := program.Run(); err != nil {
		fmt.Println("sana-mcp:", err)
		return 1
	}
	return 0
}
