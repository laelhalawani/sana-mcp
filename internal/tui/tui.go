package tui

import (
	tea "github.com/charmbracelet/bubbletea"
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
		runes := []rune(buffer)
		return string(runes[:len(runes)-1]), true
	case tea.KeyRunes, tea.KeySpace:
		return buffer + string(key.Runes), true
	}
	return buffer, false
}
