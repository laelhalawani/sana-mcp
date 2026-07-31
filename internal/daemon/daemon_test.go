package daemon

import (
	"os"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// The daemon fetches a bounded batch per cycle, so a backfill must continue
// without waiting - but only while it is actually making progress. Looping on
// "work remains" alone is a hot loop against the API whenever the remaining
// work cannot succeed.
func TestBackfillingRequiresProgressNotPendingWork(t *testing.T) {
	downloading := func(done int) store.Status {
		return store.Status{
			Phase: store.PhaseDownloading, TranscriptsDone: done,
			TranscriptsTotal: 240, Remaining: 240 - done,
		}
	}

	if !backfilling(downloading(25), downloading(50)) {
		t.Error("a cycle that stored more transcripts should continue immediately")
	}
	if backfilling(downloading(25), downloading(25)) {
		t.Error("a cycle that stored nothing must wait, or it is a hot loop")
	}
	if backfilling(downloading(25), downloading(24)) {
		t.Error("a cycle that went backwards must wait")
	}

	done := store.Status{Phase: store.PhaseSynced, TranscriptsDone: 240, TranscriptsTotal: 240}
	if backfilling(downloading(239), done) {
		t.Error("a caught-up daemon must wait for the poll interval")
	}

	// Signed out or errored: there is nothing to backfill, and retrying without
	// a pause would hammer whatever is already failing.
	for _, phase := range []string{store.PhaseNeedsLogin, store.PhaseError, store.PhaseListing, store.PhaseIdle} {
		after := downloading(25)
		after.Phase = phase
		if backfilling(downloading(25), after) {
			t.Errorf("phase %q must not loop without waiting", phase)
		}
	}
}

func TestASignInDuringACycleIsNotMarkedExpired(t *testing.T) {
	// A cycle that started with the old cookie and is rejected must not record
	// that verdict against a session someone stored while it was running: every
	// screen would then call the fresh sign-in expired until the next cycle.
	paths := config.PathsUnder(t.TempDir())
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	server := &Server{runtime: &bootstrap.Runtime{Paths: paths}}

	write := func(cookie string) {
		t.Helper()
		if err := sana.SaveSession(paths.Session, &sana.Session{
			Cookies: map[string]string{sana.SessionCookie: cookie},
		}); err != nil {
			t.Fatal(err)
		}
	}

	if got := server.sessionCookie(); got != "" {
		t.Fatalf("no session yet, got %q", got)
	}
	write("old")
	before := server.sessionCookie()
	if before != "old" {
		t.Fatalf("cookie = %q", before)
	}
	// Somebody signs in while the cycle is in flight.
	write("new")
	if server.sessionCookie() == before {
		t.Fatal("a replaced session must be distinguishable from the one in use")
	}
}
