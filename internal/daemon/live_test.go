package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// TestLiveSyncOnce runs a real sync cycle against Sana into a temporary
// database, using the session this machine is already signed in with. Skipped
// unless SANA_LIVE=1 so the normal suite stays offline.
//
// It never touches the real data directory: only the session is read from it.
func TestLiveSyncOnce(t *testing.T) {
	if os.Getenv("SANA_LIVE") != "1" {
		t.Skip("set SANA_LIVE=1 to sync against the real Sana API")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home: %v", err)
	}
	realSession := filepath.Join(home, ".sana-mcp", "session.json")
	if _, err := os.Stat(realSession); err != nil {
		t.Skipf("no stored session: %v", err)
	}

	root := t.TempDir()
	paths := config.PathsUnder(root)
	paths.Session = realSession // read-only: sync never writes the session
	runtime := &bootstrap.Runtime{Paths: paths, Config: config.Default()}

	server, err := Open(runtime)
	if err != nil {
		t.Fatalf("open daemon: %v", err)
	}
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := server.SyncOnce(ctx); err != nil {
		t.Fatalf("sync: %v", err)
	}

	status, err := server.store.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	t.Logf("phase=%s phase-label=%q meetings=%d/%d transcripts=%d/%d remaining=%d",
		status.Phase, status.Phase, status.Meetings, status.MeetingsTotal,
		status.TranscriptsDone, status.TranscriptsTotal, status.Remaining)

	if status.MeetingsTotal == 0 {
		t.Fatal("expected the meeting list to be discovered")
	}
	if status.TranscriptsDone == 0 {
		t.Fatal("expected at least one transcript to be stored")
	}

	// The stored transcripts must be searchable straight away: indexing is part
	// of storing a line, not a later pass.
	hits, err := server.store.Search("meeting", 5, 0, store.SortBest)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	t.Logf("search returned %d hits", len(hits))
	if len(hits) == 0 {
		t.Fatal("expected freshly synced transcripts to be searchable")
	}
	t.Logf("top hit: %s line %d: %.80s", hits[0].Title, hits[0].LineNo, hits[0].Text)

	// A second cycle must not re-download anything already stored.
	before := status.TranscriptsDone
	if err := server.SyncOnce(ctx); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	again, err := server.store.PendingTranscripts(1000)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	after, err := server.store.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	t.Logf("after second cycle: transcripts=%d (was %d), still pending=%d",
		after.TranscriptsDone, before, len(again))
	for _, id := range again {
		needs, err := server.store.NeedsTranscript(id)
		if err != nil {
			t.Fatalf("needs: %v", err)
		}
		if !needs {
			t.Fatalf("%s is pending but reports it needs no transcript", id)
		}
	}
}
