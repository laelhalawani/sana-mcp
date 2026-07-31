// Package tui holds what the two terminal surfaces share and nothing else
// needs: the colour palette, and the small interaction primitives.
//
// It is separate from internal/render because render lays out domain values as
// text for every surface, including the CLI and the MCP server - neither of
// which has a terminal. Putting keystroke handling and lipgloss there dragged a
// TUI framework into the dependencies of a stdio server.
package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The palette both terminal surfaces share. The installer and the interactive
// application are seen minutes apart, and each used to carry its own copy of
// these six declarations, so tuning a colour changed only one of them.
var (
	Title  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("81"))
	Dim    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	Cursor = lipgloss.NewStyle().Foreground(lipgloss.Color("81"))
	On     = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	Failed = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	Warn   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
)

// Wrap moves a cursor within a list, wrapping at both ends. An empty list
// leaves the cursor at zero rather than dividing by it.
func Wrap(cursor, delta, length int) int {
	if length == 0 {
		return 0
	}
	return (cursor + delta + length) % length
}

// Typed applies one keystroke to a text buffer, reporting whether it changed.
// Backspace on an empty buffer is not a change, which is what lets the editor
// tell "typed then deleted" from "never touched".
func Typed(buffer string, key tea.KeyMsg) (string, bool) {
	switch key.Type {
	case tea.KeyBackspace:
		if buffer == "" {
			return buffer, false
		}
		return buffer[:len(buffer)-1], true
	case tea.KeyRunes, tea.KeySpace:
		return buffer + string(key.Runes), true
	}
	return buffer, false
}
