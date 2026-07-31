package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// newTestModel builds an application over a seeded temporary store.
func newTestModel(t *testing.T) model {
	t.Helper()
	root := t.TempDir()
	paths := config.Paths{Root: root, Database: filepath.Join(root, "sana.db")}
	database, err := store.Open(paths.Database)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m1", Title: "Platform review", CreatedMS: 1_700_000_000_000, Status: "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := database.PutTranscript("m1", []store.Line{
		{LineNo: 1, Speaker: "Priya", OriginalText: "do zestawienia miedzy Fabrik, a Northwind"},
		{LineNo: 2, Speaker: "Dana", StartMS: 62000, OriginalText: "we compare pricing next week"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	return newModel(context.Background(), &bootstrap.Runtime{Paths: paths, Config: config.Default()},
		database, "test")
}

func press(m model, key string) model {
	var message tea.KeyMsg
	switch key {
	case "enter":
		message = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		message = tea.KeyMsg{Type: tea.KeyEsc}
	case "ctrl+s":
		message = tea.KeyMsg{Type: tea.KeyCtrlS}
	case "backspace":
		message = tea.KeyMsg{Type: tea.KeyBackspace}
	default:
		message = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
	}
	next, _ := m.Update(message)
	return next.(model)
}

func TestMenuOpensMeetings(t *testing.T) {
	m := press(newTestModel(t), "enter")
	if m.screen != screenMeetings {
		t.Fatalf("expected the meetings screen, got %v", m.screen)
	}
	if len(m.meetings) != 1 {
		t.Fatalf("expected one meeting, got %d", len(m.meetings))
	}
	if !strings.Contains(m.View(), "Platform review") {
		t.Fatal("the meeting should be listed")
	}
}

func TestTranscriptShowsNumberedLines(t *testing.T) {
	m := press(press(newTestModel(t), "enter"), "t")
	if m.screen != screenTranscript {
		t.Fatalf("expected the transcript screen, got %v", m.screen)
	}
	view := m.View()
	if !strings.Contains(view, "1 [0:00] Priya:") || !strings.Contains(view, "2 [1:02] Dana:") {
		t.Fatalf("transcript should be numbered with timestamps, got:\n%s", view)
	}
}

// Editing must be a deliberate act: ctrl+s asks before writing, and esc with
// unsaved changes asks before throwing them away.
func TestEditRequiresConfirmationAndMarksTheLine(t *testing.T) {
	m := press(press(newTestModel(t), "enter"), "t")
	m = press(m, "e")
	if m.screen != screenEdit {
		t.Fatalf("e should open the editor, got %v", m.screen)
	}
	m = press(m, "X")
	if !m.editDirty {
		t.Fatal("typing should mark the buffer dirty")
	}
	m = press(m, "ctrl+s")
	if m.confirming != "save" {
		t.Fatalf("ctrl+s should ask before saving, got %q", m.confirming)
	}
	if !strings.Contains(m.View(), "Save this correction? [y/n]") {
		t.Fatal("the save confirmation should be visible")
	}
	m = press(m, "y")
	if m.screen != screenTranscript {
		t.Fatalf("saving should return to the transcript, got %v", m.screen)
	}
	// A corrected line is marked so an edit is never mistaken for what was said.
	if !strings.Contains(m.View(), "*") {
		t.Fatal("a corrected line should be marked")
	}
}

func TestEscapeWithUnsavedChangesAsksFirst(t *testing.T) {
	m := press(press(newTestModel(t), "enter"), "t")
	m = press(m, "e")
	m = press(m, "Z")
	m = press(m, "esc")
	if m.confirming != "discard" {
		t.Fatalf("esc with unsaved changes should ask, got %q", m.confirming)
	}
	m = press(m, "n")
	if m.screen != screenEdit {
		t.Fatalf("answering no should keep editing, got %v", m.screen)
	}
}

func TestHistoryListsAndRestores(t *testing.T) {
	m := press(press(newTestModel(t), "enter"), "t")
	m = press(m, "e")
	m = press(m, "!")
	m = press(m, "ctrl+s")
	m = press(m, "y")

	m = press(m, "h")
	if m.screen != screenHistory {
		t.Fatalf("h should open history, got %v", m.screen)
	}
	if len(m.history) != 1 {
		t.Fatalf("expected one recorded edit, got %d", len(m.history))
	}
	view := m.View()
	if !strings.Contains(view, "original:") || !strings.Contains(view, "current:") {
		t.Fatalf("history should show both texts, got:\n%s", view)
	}

	m = press(m, "r")
	if m.confirming != "restore" {
		t.Fatalf("r should ask before restoring, got %q", m.confirming)
	}
	m = press(m, "y")
	lines, err := m.store.Lines("m1", 1, 1)
	if err != nil {
		t.Fatalf("lines: %v", err)
	}
	if lines[0].Text != lines[0].OriginalText {
		t.Fatalf("restore should return the original, got %q", lines[0].Text)
	}
}

func TestSearchOpensTheMatchingLine(t *testing.T) {
	m := newTestModel(t)
	m.screen = screenSearch
	m.searchTyped = true
	for _, r := range "pricing" {
		m = press(m, string(r))
	}
	m = press(m, "enter")
	// The search command runs asynchronously; drive it directly.
	hits, err := m.store.Search("pricing", 10, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	next, _ := m.Update(searchMsg(hits))
	m = next.(model)
	if len(m.hits) == 0 {
		t.Fatal("expected a hit for pricing")
	}
	m = press(m, "enter")
	if m.screen != screenTranscript {
		t.Fatalf("opening a hit should show the transcript, got %v", m.screen)
	}
	if m.lines[m.lineCursor].LineNo != 2 {
		t.Fatalf("should open at the matching line 2, got %d", m.lines[m.lineCursor].LineNo)
	}
}
