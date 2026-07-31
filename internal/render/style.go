package render

import "github.com/charmbracelet/lipgloss"

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
