package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"io"

	"strings"
	"testing"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// newTestService seeds a store with one meeting whose transcript carries the
// real failure case, and returns an MCP session speaking to it over an
// in-memory transport - the same code path a client uses.
func newTestService(t *testing.T) *mcp.ClientSession {
	t.Helper()
	root := t.TempDir()
	paths := config.PathsUnder(root)
	database, err := store.Open(paths.Database)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m1", Title: "Platform review",
		CreatedMS: time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC).UnixMilli(),
		Status:    "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := database.PutTranscript("m1", []store.Line{
		{LineNo: 1, Speaker: "Julia", StartMS: 0, OriginalText: "do porownania miedzy Fabrik, a Northwind"},
		{LineNo: 2, Speaker: "Lael", StartMS: 62000, OriginalText: "we should compare pricing next week"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	database.Close()

	service, err := New(&bootstrap.Runtime{Paths: paths, Config: config.Default()}, "test")
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	go service.Server().Run(context.Background(), serverTransport)

	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

// call invokes meeting_transcripts and returns its text.
func call(t *testing.T, session *mcp.ClientSession, tool string, args map[string]any) string {
	t.Helper()
	arguments := map[string]any{"tool": tool}
	if args != nil {
		arguments["args"] = args
	}
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: toolName, Arguments: arguments,
	})
	if err != nil {
		t.Fatalf("call %s: %v", tool, err)
	}
	var out strings.Builder
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			out.WriteString(text.Text)
		}
	}
	return out.String()
}

func TestToolIsRegisteredWithItsContract(t *testing.T) {
	session := newTestService(t)
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(tools.Tools) != 1 || tools.Tools[0].Name != toolName {
		t.Fatalf("expected exactly the %s tool, got %+v", toolName, tools.Tools)
	}
	// The warning about not editing without permission is part of the contract:
	// it is the only thing standing between a confident model and a corrupted
	// transcript, so its absence is a test failure.
	description := tools.Tools[0].Description
	for _, required := range []string{"NEVER edit", "Zenolith", "edit_line", "line_history", "restore_line"} {
		if !strings.Contains(description, required) {
			t.Errorf("tool description is missing %q", required)
		}
	}
}

func TestHelpListsEveryTool(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "help", nil)
	for _, entry := range tools {
		if !strings.Contains(text, entry.name) {
			t.Errorf("help does not mention %q", entry.name)
		}
	}
}

func TestReadReportsSizeBeforeDumping(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "read", map[string]any{"meeting_id": "m1"})
	if !strings.Contains(text, "2 lines") {
		t.Fatalf("read with no selection should report the line count, got %q", text)
	}
	if strings.Contains(text, "porownania") {
		t.Fatal("read with no selection must not dump the transcript")
	}
}

func TestReadRangeRendersNumberedLines(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "read", map[string]any{
		"meeting_id": "m1", "lines": []int{1, 2},
	})
	if !strings.Contains(text, "1 [0:00] Julia:") {
		t.Fatalf("expected numbered line with timestamp, got %q", text)
	}
	if !strings.Contains(text, "2 [1:02] Lael:") {
		t.Fatalf("expected the second line at 1:02, got %q", text)
	}
}

func TestEditRequiresTheCurrentText(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "edit_line", map[string]any{
		"meeting_id": "m1", "line": 1,
		"expected_text": "something the line does not say",
		"new_text":      "anything",
	})
	if !strings.Contains(text, "does not contain that text") {
		t.Fatalf("a mismatched edit must be refused, got %q", text)
	}
	// And the line must be untouched.
	after := call(t, session, "read", map[string]any{"meeting_id": "m1", "lines": []int{1, 1}})
	if !strings.Contains(after, "Fabrik") {
		t.Fatalf("the line should be unchanged, got %q", after)
	}
}

func TestEditReplacesAFragmentAndCountsIt(t *testing.T) {
	session := newTestService(t)

	// A fragment, not the whole line: the rest of the line is left alone and
	// never has to be sent.
	text := call(t, session, "edit_line", map[string]any{
		"meeting_id": "m1", "line": 1,
		"expected_text": "Fabrik", "new_text": "Fabrix",
	})
	if !strings.Contains(text, "corrected") {
		t.Fatalf("a single-occurrence fragment edit should apply, got %q", text)
	}
	after := call(t, session, "read", map[string]any{"meeting_id": "m1", "lines": []int{1, 1}})
	if !strings.Contains(after, "Fabrix") || strings.Contains(after, "Fabrik") {
		t.Fatalf("the fragment was not replaced: %q", after)
	}
	// The rest of the line survived.
	if !strings.Contains(after, "Northwind") {
		t.Fatalf("the rest of the line was lost: %q", after)
	}
}

func TestEditRefusesWhenTheCountIsWrong(t *testing.T) {
	session := newTestService(t)

	// "a" occurs many times in the seeded line. Claiming one is a claim to have
	// looked at one, and the edit must not touch the others.
	text := call(t, session, "edit_line", map[string]any{
		"meeting_id": "m1", "line": 1,
		"expected_text": "a", "new_text": "X", "occurrences": 1,
	})
	if !strings.Contains(text, "does not contain that text") {
		t.Fatalf("a wrong count must be refused, got %q", text)
	}
	// The count found is withheld on purpose: given it, the obvious next move
	// is to retry with that number and replace text nobody has read.
	for _, leak := range []string{" 2 ", " 3 ", " 4 ", " 5 ", "found", "actually contains"} {
		if strings.Contains(text, leak) {
			t.Errorf("the message leaks the real count via %q: %s", leak, text)
		}
	}
	after := call(t, session, "read", map[string]any{"meeting_id": "m1", "lines": []int{1, 1}})
	if !strings.Contains(after, "Fabrik") {
		t.Fatalf("the line should be unchanged, got %q", after)
	}
}

func TestEditThenHistoryThenRestore(t *testing.T) {
	session := newTestService(t)
	original := "do porownania miedzy Fabrik, a Northwind"
	corrected := "do porownania miedzy Fabrix, a Northwind"

	edited := call(t, session, "edit_line", map[string]any{
		"meeting_id": "m1", "line": 1,
		"expected_text": original, "new_text": corrected,
	})
	if !strings.Contains(edited, "Line 1 corrected") {
		t.Fatalf("edit should confirm, got %q", edited)
	}

	// The correction is searchable straight away.
	found := call(t, session, "search", map[string]any{"query": "Fabrix"})
	if !strings.Contains(found, "line 1") {
		t.Fatalf("the corrected text should be searchable, got %q", found)
	}

	history := call(t, session, "line_history", map[string]any{"meeting_id": "m1"})
	if !strings.Contains(history, original) || !strings.Contains(history, corrected) {
		t.Fatalf("history must carry both texts, got %q", history)
	}

	restored := call(t, session, "restore_line", map[string]any{"meeting_id": "m1", "line": 1})
	if !strings.Contains(restored, "Fabrik") {
		t.Fatalf("restore should return the original, got %q", restored)
	}
}

func TestSearchMissExplainsASRErrors(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "search", map[string]any{"query": "zzzznotpresent"})
	if !strings.Contains(text, "speech recognition") {
		t.Fatalf("an empty search should explain why a name may be spelled differently, got %q", text)
	}
}

func TestListRendersMeetings(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "list", nil)
	if !strings.Contains(text, "m1") || !strings.Contains(text, "Platform review") {
		t.Fatalf("list should show the meeting, got %q", text)
	}
}

func TestUnknownToolFallsBackToHelp(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "nonsense", nil)
	if !strings.Contains(text, "Unknown tool") || !strings.Contains(text, "search") {
		t.Fatalf("an unknown tool should say so and list the real ones, got %q", text)
	}
}

func TestStatusReportsPhase(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "status", nil)
	if !strings.Contains(text, "meetings") || !strings.Contains(text, "transcripts") {
		t.Fatalf("status should report coverage, got %q", text)
	}
}

// A client closing its end is how every MCP session ends. Reporting that as a
// failure makes a harness log an error each time a session closes.
func TestNormalDisconnectIsNotAnError(t *testing.T) {
	for _, err := range []error{
		io.EOF,
		context.Canceled,
		errors.New("server is closing: EOF"),
		fmt.Errorf("wrapped: %w", io.EOF),
	} {
		if got := normalizeRunError(err); got != nil {
			t.Errorf("%v should be a clean shutdown, got %v", err, got)
		}
	}
	real := errors.New("permission denied")
	if normalizeRunError(real) == nil {
		t.Error("a real failure must still be reported")
	}
}

// The description and the help text are generated from one registry, so a tool
// cannot exist without being documented, and the two cannot drift the way three
// hand-synced lists did.
func TestDescriptionCoversEveryTool(t *testing.T) {
	for _, entry := range tools {
		if !strings.Contains(Description, entry.name) {
			t.Errorf("the tool description omits %q", entry.name)
		}
		if !strings.Contains(Description, entry.args) {
			t.Errorf("the tool description omits the args of %q", entry.name)
		}
	}
	if strings.Contains(Description, "filter?}    matching") {
		t.Error("search must not advertise a filter argument it does not accept")
	}
	if handlers == nil || len(handlers) != len(tools) {
		t.Fatalf("registry and dispatch disagree: %d tools, %d handlers", len(tools), len(handlers))
	}
}
