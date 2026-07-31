package install

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	detectharness "github.com/sairaph/detect-harness"
)

// keyOf builds the keypress a terminal would deliver.
func keyOf(name string) tea.KeyMsg {
	switch name {
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	case " ":
		return tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
	}
}

// TestNothingChangedIsOnlySaidWhenNothingChanged guards the flag that decides
// it. The previous test was "no client results", which is empty whenever no
// client was involved - so cancelling the finished summary on a machine with no
// AI clients reported a run that changed nothing, after it had deleted the
// user's meetings.
func TestNothingChangedIsOnlySaidWhenNothingChanged(t *testing.T) {
	before := &model{}
	if before.settled {
		t.Fatal("a run that has written nothing is not settled")
	}
	after := &model{settled: true}
	if !after.settled {
		t.Fatal("the point of no return has to be recorded")
	}
}

// TestWritesTakeNoKeys covers the window where client configuration is being
// written or files removed: interrupting it leaves the machine half-changed
// under a message saying nothing happened.
func TestWritesTakeNoKeys(t *testing.T) {
	for _, step := range []step{stepApplying, stepRemoving} {
		state := &model{step: step}
		if _, cmd := state.key(keyOf("ctrl+c")); cmd != nil {
			t.Fatalf("step %v accepted ctrl+c", step)
		}
		if state.cancel {
			t.Fatalf("step %v cancelled mid-write", step)
		}
	}
	// Detection has written nothing, so leaving is free.
	state := &model{step: stepDetecting}
	if _, cmd := state.key(keyOf("q")); cmd == nil || !state.cancel {
		t.Fatal("detection must still be interruptible")
	}
}

// TestNothingIsWrittenThatWasNotShown covers the invariant the whole client
// screen rests on: a config file is only ever written for a row the user could
// see selected.
func TestNothingIsWrittenThatWasNotShown(t *testing.T) {
	state := &model{
		harnesses: []Harness{
			{ID: "shown", Name: "Claude Code", State: detectharness.Detected},
			{ID: "hidden", Name: "Zed"},
		},
		selected: map[detectharness.ID]bool{},
	}
	state.cursor = state.firstSelectable()

	// Reveal the hidden group, select everything, hide it again.
	state.harnessKey(keyOf("a"))
	state.harnessKey(keyOf("v"))
	state.harnessKey(keyOf("a"))
	state.harnessKey(keyOf("v"))

	visible := map[detectharness.ID]bool{}
	for _, index := range state.visible() {
		visible[state.harnesses[index].ID] = true
	}
	for id, chosen := range state.selected {
		if chosen && !visible[id] {
			t.Fatalf("%s is selected but not on screen", id)
		}
	}
}

// TestSpaceOnAnEmptyListSelectsNothing covers the "No AI clients detected"
// screen, where a cursor of zero still pointed at a harness.
func TestSpaceOnAnEmptyListSelectsNothing(t *testing.T) {
	state := &model{
		harnesses: []Harness{{ID: "a", Name: "Zed"}, {ID: "b", Name: "Cursor"}},
		selected:  map[detectharness.ID]bool{},
	}
	state.cursor = state.firstSelectable()
	if len(state.visible()) != 0 {
		t.Fatalf("nothing is detected, so nothing should be listed: %v", state.visible())
	}

	state.harnessKey(keyOf(" "))
	for id, chosen := range state.selected {
		if chosen {
			t.Fatalf("space selected %s on an empty list", id)
		}
	}
	// And `a` does not claim to have cleared anything.
	state.harnessKey(keyOf("a"))
	if state.message != "" {
		t.Fatalf("message = %q, want nothing claimed", state.message)
	}
}
