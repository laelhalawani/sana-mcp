package daemon

import (
	"testing"

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
