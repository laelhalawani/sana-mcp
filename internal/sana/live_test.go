package sana

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLiveAgainstStoredSession exercises the real Sana API using the session
// this machine is already signed in with. It is skipped unless SANA_LIVE=1, so
// the normal suite stays offline and deterministic.
//
// It is read-only: it lists meetings and reads one, and writes nothing.
func TestLiveAgainstStoredSession(t *testing.T) {
	if os.Getenv("SANA_LIVE") != "1" {
		t.Skip("set SANA_LIVE=1 to run against the real Sana API")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home: %v", err)
	}
	payload, err := os.ReadFile(filepath.Join(home, ".sana-mcp", "session.json"))
	if err != nil {
		t.Skipf("no stored session: %v", err)
	}
	var session Session
	if err := json.Unmarshal(payload, &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	client := New(os.Getenv("SANA_BASE_URL"), &session)
	if !client.HasCookie() {
		t.Skip("stored session carries no cookie")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	user, err := client.Me(ctx)
	if err != nil {
		t.Fatalf("user.me: %v", err)
	}
	t.Logf("signed in as %s (workspace %s)", user.Email, user.WorkspaceID)

	meetings, next, err := client.ListMeetings(ctx, nil)
	if err != nil {
		t.Fatalf("asset.listRecent: %v", err)
	}
	if len(meetings) == 0 {
		t.Fatal("expected at least one meeting")
	}
	t.Logf("listed %d meetings, nextCursor=%v", len(meetings), next)
	first := meetings[0]
	if first.ID == "" || first.Name == "" || first.CreatedAtMS == 0 {
		t.Fatalf("meeting summary is missing required fields: %+v", first)
	}
	t.Logf("newest: %q id=%s created=%s phase=%v",
		first.Name, first.ID,
		time.UnixMilli(int64(first.CreatedAtMS)).Format(time.RFC3339),
		derefString(first.ProcessingPhase))

	segments, err := client.Transcript(ctx, first.ID)
	if err != nil {
		t.Fatalf("meeting.getTranscription: %v", err)
	}
	words := 0
	for _, segment := range segments {
		words += len(segment.Words)
	}
	t.Logf("transcript: %d segments, %d words", len(segments), words)
	if len(segments) > 0 && segments[0].Speaker == "" {
		t.Fatal("segment is missing its speaker")
	}

	metadata, err := client.Meeting(ctx, first.ID)
	if err != nil {
		t.Fatalf("meeting.getById: %v", err)
	}
	t.Logf("metadata: summary=%v notes=%d actions=%d recording=%v",
		metadata.Summary != nil, len(metadata.Notes), len(metadata.ActionItems),
		metadata.RecordingURL != nil || metadata.FallbackRecordingURL != nil)

	participants, err := client.Participants(ctx, first.ID)
	if err != nil {
		t.Fatalf("meeting.getMeetingParticipants: %v", err)
	}
	t.Logf("participants: %d", len(participants))
}

func derefString(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}
