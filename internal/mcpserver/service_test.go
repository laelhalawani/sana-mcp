package mcpserver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"

	"strings"
	"testing"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	_ "modernc.org/sqlite"
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
		{LineNo: 1, Speaker: "Priya Raman", StartMS: 0, OriginalText: "do zestawienia miedzy Fabrik, a Northwind"},
		{LineNo: 2, Speaker: "Dana Whitfield", StartMS: 62000, OriginalText: "we should compare pricing next week"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	// m4 has lines whose row does not say complete. PutTranscript never produces
	// that pairing, so it is written directly: it is the window between the
	// daemon committing a transcript and this process reading the row, and
	// without a fixture for it the "lines in hand outrank the row" rule is
	// asserted in three comments and pinned by nothing.
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m4", Title: "Just landed",
		CreatedMS: time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC).UnixMilli(),
		Status:    "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := database.PutTranscript("m4", []store.Line{
		{LineNo: 1, Speaker: "Zara Nolan", StartMS: 0, OriginalText: "we just started"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	// m5 has a readable summary and an undecodable roster - the mirror of the
	// incident that shipped, where an upstream type change made eight meetings'
	// summary JSON undecodable. Written directly because PutMetadata cannot
	// produce it.
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m5", Title: "Half readable",
		CreatedMS: time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC).UnixMilli(),
		Status:    "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	database.Close()
	if err := setTranscriptState(paths.Database, "m4", "absent"); err != nil {
		t.Fatalf("reset transcript state: %v", err)
	}
	if err := writeMetadataJSON(paths.Database, "m5",
		`{"summary":"we agreed the plan"}`, `{ broken`); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	database, err = store.Open(paths.Database)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}

	// Workspace members, deliberately not the same people as the speakers: that
	// divergence is the normal case and what the participants tool must show.
	email := "marcus@example.com"
	// m2 has a transcript and deliberately no metadata document, which is the
	// state a meeting sits in between the daemon fetching the two.
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m2", Title: "Mid-sync meeting",
		CreatedMS: time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC).UnixMilli(),
		Status:    "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := database.PutTranscript("m2", []store.Line{
		{LineNo: 1, Speaker: "Marcus Oyelaran", StartMS: 0, OriginalText: "we can start"},
	}); err != nil {
		t.Fatalf("put transcript: %v", err)
	}
	// m3 is the state Sana produces for a meeting with no speech: the transcript
	// was fetched and is empty. 5 of 246 meetings on a real corpus look like it.
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m3", Title: "Silent meeting",
		CreatedMS: time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC).UnixMilli(),
		Status:    "ready",
	}); err != nil {
		t.Fatalf("put meeting: %v", err)
	}
	if err := database.PutTranscript("m3", nil); err != nil {
		t.Fatalf("put empty transcript: %v", err)
	}
	if err := database.PutMetadata("m1", sana.Metadata{}, []sana.Participant{
		{DisplayName: "Marcus Oyelaran", Email: &email, IsHost: true},
		{DisplayName: "Ines Duarte"},
	}); err != nil {
		t.Fatalf("put metadata: %v", err)
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
	if strings.Contains(text, "zestawienia") {
		t.Fatal("read with no selection must not dump the transcript")
	}
}

func TestReadRangeRendersNumberedLines(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "read", map[string]any{
		"meeting_id": "m1", "lines": []int{1, 2},
	})
	if !strings.Contains(text, "1 [0:00] Priya Raman:") {
		t.Fatalf("expected numbered line with timestamp, got %q", text)
	}
	if !strings.Contains(text, "2 [1:02] Dana Whitfield:") {
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
	original := "do zestawienia miedzy Fabrik, a Northwind"
	corrected := "do zestawienia miedzy Fabrix, a Northwind"

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

// The participants tool used to return only the workspace roster, presented as
// "attendees". On a real corpus 49% of meetings had no listed participant speak
// at all, so the two groups have to be separately labelled.
func TestParticipantsSeparatesMembersFromSpeakers(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "participants", map[string]any{"meeting_id": "m1"})

	for _, want := range []string{
		"Workspace members with access (2)",
		"Marcus Oyelaran <marcus@example.com> (host)",
		"Ines Duarte",
		"Speakers in the transcript (2)",
		"Priya Raman",
		"Dana Whitfield",
		"Neither list is attendance",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("participants output is missing %q:\n%s", want, text)
		}
	}
	// The bug that prompted this: an address must never be confusable with the
	// host marker, so it is always delimited.
	if strings.Contains(text, "marcus@example.com") &&
		!strings.Contains(text, "<marcus@example.com>") {
		t.Fatalf("an email must be delimited:\n%s", text)
	}
	// A speaker is not a member and must not be listed as one.
	members, _, _ := strings.Cut(text, "Speakers in the transcript")
	if strings.Contains(members, "Priya Raman") {
		t.Fatalf("a speaker leaked into the members group:\n%s", text)
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

// The transcript and the metadata document are fetched separately, so a meeting
// can have speakers before its participant list arrives. Answering "not found"
// then would hide a transcript that is sitting right there.
func TestParticipantsAnswersWithSpeakersWhenMetadataIsMissing(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "participants", map[string]any{"meeting_id": "m2"})

	if strings.Contains(text, "is stored locally") {
		t.Fatalf("a meeting with a transcript must not be reported missing, got %q", text)
	}
	if !strings.Contains(text, "Marcus Oyelaran") {
		t.Fatalf("the speakers should still be listed, got %q", text)
	}
	// Absent, not empty: a count here would tell the agent the meeting has no
	// members when the document simply has not arrived.
	if !strings.Contains(text, "Workspace members with access\n  Not downloaded yet.") {
		t.Fatalf("an unfetched member list should say so, got %q", text)
	}
	if strings.Contains(text, "Workspace members with access (0)") {
		t.Fatalf("an unfetched group must not claim a count, got %q", text)
	}
}

// A meeting that exists nowhere is still missing, and must say so rather than
// render two empty groups.
func TestParticipantsReportsAnUnknownMeetingAsMissing(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "participants", map[string]any{"meeting_id": "nope"})
	if !strings.Contains(text, "nope") {
		t.Fatalf("an unknown meeting should be named, got %q", text)
	}
	if strings.Contains(text, "Workspace members with access") {
		t.Fatalf("an unknown meeting must not render the groups, got %q", text)
	}
}

// summary made the same false claim participants did: a stored meeting whose
// summary document has not arrived is not a meeting that is missing, and
// sending an agent to `list` for an id `list` will show is a loop.
func TestSummaryDoesNotCallAStoredMeetingMissing(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "summary", map[string]any{"meeting_id": "m2"})

	if strings.Contains(text, "is stored locally") {
		t.Fatalf("m2 is stored and list shows it, got %q", text)
	}
	if !strings.Contains(text, "not been downloaded yet") {
		t.Fatalf("an absent summary should say so, got %q", text)
	}
	// A meeting that really is absent must still be reported as such.
	missing := call(t, session, "summary", map[string]any{"meeting_id": "nope"})
	if !strings.Contains(missing, "is stored locally") {
		t.Fatalf("an unknown meeting should still be missing, got %q", missing)
	}
}

// read must not infer download state from a line count. Sana returns an empty
// transcript for a meeting with no speech, and calling that "not stored yet"
// contradicts participants, which reports the same meeting as downloaded, and
// status, which counts it complete.
func TestReadDoesNotCallAnEmptyTranscriptMissing(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "read", map[string]any{"meeting_id": "m3"})

	if strings.Contains(text, "no transcript stored yet") {
		t.Fatalf("a downloaded transcript must not be reported as absent, got %q", text)
	}
	if !strings.Contains(text, "no lines") {
		t.Fatalf("an empty transcript should say it has no lines, got %q", text)
	}
	// participants must agree with it about the transcript. Only that group:
	// m3 has no metadata document, so its member group is legitimately absent.
	participants := call(t, session, "participants", map[string]any{"meeting_id": "m3"})
	_, speakerGroup, found := strings.Cut(participants, "Speakers in the transcript")
	if !found {
		t.Fatalf("no speaker group in:\n%s", participants)
	}
	if strings.Contains(speakerGroup, "Not downloaded yet") {
		t.Fatalf("participants calls m3's transcript absent while read does not:\n%s", participants)
	}
}

// The row and the line count are two statements against two read snapshots, so
// a transcript committed between them must not be counted and then denied.
func TestReadPrefersLinesInHandOverTheRow(t *testing.T) {
	session := newTestService(t)
	// m4 is the window itself: lines present, row still saying absent.
	text := call(t, session, "read", map[string]any{"meeting_id": "m4"})
	if strings.Contains(text, "no transcript stored yet") {
		t.Fatalf("a meeting with lines must never be reported as absent, got %q", text)
	}
	// A bare read answers with a header rather than the transcript, so what
	// proves it saw the lines is that it counted them. Asserted as the exact
	// fragment: "1 line" alone is satisfied by "1 lines" and by "11 lines".
	if !strings.Contains(text, ", 1 line.") {
		t.Fatalf("the line count should be reported, got %q", text)
	}
}

// setTranscriptState writes a state PutTranscript would never write, so the
// fixture can hold the row and the lines in disagreement.
func setTranscriptState(path, meetingID, state string) error {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer database.Close()
	_, err = database.Exec(
		`UPDATE meetings SET transcript_state = ? WHERE meeting_id = ?`, state, meetingID)
	return err
}

// summary must not lose a readable document to an unreadable roster. The two
// share one decode in store.Metadata, which is why store.Summary exists - and
// this surface is the one an agent uses.
func TestSummarySurvivesAnUnreadableRoster(t *testing.T) {
	session := newTestService(t)
	text := call(t, session, "summary", map[string]any{"meeting_id": "m5"})

	if strings.Contains(text, "stored participants") {
		t.Fatalf("summary failed on the roster's decode: %q", text)
	}
	if !strings.Contains(text, "we agreed the plan") {
		t.Fatalf("the readable summary should be rendered, got %q", text)
	}
	// The roster's own corruption is reported in its own group, and does not
	// take the speakers down with it - they come from the transcript.
	participants := call(t, session, "participants", map[string]any{"meeting_id": "m5"})
	if !strings.Contains(participants, "Could not be read") {
		t.Fatalf("the corrupt roster should say so, got %q", participants)
	}
	if !strings.Contains(participants, "Speakers in the transcript") {
		t.Fatalf("the speaker group must still render, got %q", participants)
	}
}

// writeMetadataJSON writes documents PutMetadata cannot produce, so a fixture
// can hold one readable blob beside an undecodable one.
func writeMetadataJSON(path, meetingID, summaryJSON, participantsJSON string) error {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer database.Close()
	_, err = database.Exec(
		`INSERT INTO meeting_metadata (meeting_id, summary_json, participants_json)
		 VALUES (?, ?, ?)`, meetingID, summaryJSON, participantsJSON)
	return err
}
