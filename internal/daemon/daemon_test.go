package daemon

import (
	"os"
	"strings"
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

// TestLinesFromSplitsALongTurnAndTimesEachPiece covers the one thing the
// download path can do that the stored-data migration cannot: give every piece
// of a long speaker turn the timestamp of the word it actually starts on. The
// per-word timings exist only here, so a regression is invisible until someone
// clicks a line in the recording and lands in the wrong place.
func TestLinesFromSplitsALongTurnAndTimesEachPiece(t *testing.T) {
	// One uninterrupted turn, long enough to be split, with a word every second.
	var words []sana.Word
	at := 0.0
	for range 400 {
		for _, text := range []string{"So", "then", "we", "import", "the", "products."} {
			words = append(words, sana.Word{Text: text, StartTimestamp: at})
			at++
		}
	}
	lines := linesFrom([]sana.Segment{
		{Speaker: "Ines", Words: []sana.Word{{Text: "Yeah.", StartTimestamp: 0}}},
		{Speaker: "Dana", Words: words},
	})

	if len(lines) < 4 {
		t.Fatalf("a long turn should become several lines, got %d", len(lines))
	}
	// Line numbers stay contiguous across the split, not per segment.
	for index, line := range lines {
		if line.LineNo != index+1 {
			t.Fatalf("line %d is numbered %d", index+1, line.LineNo)
		}
	}
	if lines[0].Speaker != "Ines" || lines[1].Speaker != "Dana" {
		t.Fatalf("speakers did not survive the split: %+v", lines[:2])
	}
	// Every piece of the long turn carries its own increasing start time. The
	// old code gave the whole turn one timestamp, so this is the regression
	// that matters.
	previous := int64(-1)
	for _, line := range lines[1:] {
		if line.StartMS <= previous {
			t.Fatalf("timestamps must advance across pieces, got %d after %d",
				line.StartMS, previous)
		}
		previous = line.StartMS
	}
	if lines[1].StartMS != 0 {
		t.Fatalf("the first piece should start where the turn does, got %d", lines[1].StartMS)
	}
}

// TestEnsureRunningRecordsWhyItDidNotStart covers the failure that is
// impossible to diagnose remotely: no daemon, so no sync, so no sync error, so
// every screen reports 0/0 with nothing wrong. Each branch that declines to
// start one has to leave a trace.
func TestEnsureRunningRecordsWhyItDidNotStart(t *testing.T) {
	signedIn := []byte(`{"cookies":{"` + sana.SessionCookie + `":"abc"},"email":"a@b.c"}`)

	for _, testCase := range []struct {
		name       string
		executable string
		want       string
	}{
		{"own path unknown", "", "cannot resolve its own path"},
		{"binary is gone", "/nonexistent/sana-mcp", "could not be run"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			paths := config.PathsUnder(t.TempDir())
			if err := os.MkdirAll(paths.Root, 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.WriteFile(paths.Session, signedIn, 0o600); err != nil {
				t.Fatalf("write session: %v", err)
			}

			EnsureRunning(&bootstrap.Runtime{Paths: paths, Executable: testCase.executable})

			log, err := os.ReadFile(paths.Log)
			if err != nil {
				t.Fatalf("nothing was recorded, so the failure is invisible: %v", err)
			}
			if !strings.Contains(string(log), testCase.want) {
				t.Fatalf("log does not say why: %q", log)
			}
		})
	}
}

// A machine nobody has signed in on yet has nothing to sync. That is the normal
// state, not a fault, and must not fill the log on every command.
func TestEnsureRunningSaysNothingWhenNobodyHasSignedIn(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	EnsureRunning(&bootstrap.Runtime{Paths: paths, Executable: "/nonexistent/sana-mcp"})
	if _, err := os.Stat(paths.Log); !os.IsNotExist(err) {
		log, _ := os.ReadFile(paths.Log)
		t.Fatalf("no sign-in should be quiet, but the log says: %q", log)
	}
}
