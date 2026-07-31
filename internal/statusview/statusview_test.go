package statusview

import (
	"database/sql"

	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
	_ "modernc.org/sqlite"
)

func testUI() tui.UI {
	return tui.New(tui.Policy{
		Interactive: true, Control: true, Color: true, Unicode: true,
		Columns: 80, Rows: 24,
	})
}

func screenFor(info Info, mode Mode, setup *Setup) string {
	screen := &model{ui: testUI(), mode: mode, setup: setup,
		read: func() Info { return info }, info: info}
	return screen.View()
}

// TestUnreadableStateIsSaidOutLoud is the twenty-minute freeze.
//
// The sync status swallowed the read error and rendered its zero value, so the
// screen showed "Syncing meetings" over an empty bar for as long as anyone was
// willing to wait.
func TestUnreadableStateIsSaidOutLoud(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	raw, err := sql.Open("sqlite", paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	raw.Close()

	info := Read(paths)
	if info.Unavailable == "" {
		t.Fatal("an unreadable database must be reported")
	}
	if !info.attention() {
		t.Fatal("an unreadable database needs attention")
	}
	if !strings.Contains(info.Unavailable, "sana-mcp install") {
		t.Fatalf("the way out must be part of the message, got %q", info.Unavailable)
	}

	screen := screenFor(info, ModeStatus, nil)
	if !strings.Contains(screen, "Background sync unavailable") {
		t.Fatalf("the screen must say what is wrong:\n%s", screen)
	}
	if strings.Contains(screen, "[---") {
		t.Fatalf("no bar may be drawn for a total nobody knows:\n%s", screen)
	}
}

func TestCountsAreSuppressedWithoutASession(t *testing.T) {
	// Stale counts beside "sign in required" read as progress still happening.
	info := Info{Status: store.Status{Meetings: 12, MeetingsTotal: 300}}
	screen := screenFor(info, ModeStatus, nil)
	if strings.Contains(screen, "Meetings ready") {
		t.Fatalf("counts must be suppressed:\n%s", screen)
	}
	if !strings.Contains(screen, "Sign in required") {
		t.Fatalf("the screen must say why:\n%s", screen)
	}
	if !strings.Contains(screen, "You are not signed in to Sana.") {
		t.Fatalf("and say it in full:\n%s", screen)
	}

	expired := Info{Expired: true}
	if !strings.Contains(screenFor(expired, ModeStatus, nil), "Sana session expired") {
		t.Fatal("an expired session is a different thing from never signing in")
	}
}

func TestSetupModeConfirmsWhatTheInstallerDid(t *testing.T) {
	info := Info{SignedIn: true, Status: store.Status{
		Phase: store.PhaseSynced, Meetings: 240, MeetingsTotal: 240,
		TranscriptsDone: 240, TranscriptsTotal: 240,
	}}
	screen := screenFor(info, ModeSetup, &Setup{ConnectedClients: 3, SignedIn: true})

	for _, want := range []string{
		"sana-mcp setup",
		"AI clients  3 connected",
		"Sana account  signed in",
		"Up to date",
		"Enter finish setup - sync continues in the background",
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("missing %q in:\n%s", want, screen)
		}
	}
	// q is the application's key, not the installer's: the installer ends on
	// Enter, and quitting mid-setup is not an outcome it offers.
	if strings.Contains(screen, "q quit") {
		t.Errorf("setup must not offer quit:\n%s", screen)
	}
}

func TestStatusModeReportsTheDaemonAndTheLastSync(t *testing.T) {
	info := Info{SignedIn: true, HeartbeatMS: 1_700_000_000_000, Status: store.Status{
		Phase: store.PhaseDownloading, Meetings: 100, MeetingsTotal: 240,
		TranscriptsDone: 100, TranscriptsTotal: 240, Remaining: 140,
		UpdatedMS: 1_700_000_000_000,
	}}
	screen := screenFor(info, ModeStatus, nil)

	for _, want := range []string{
		"Sync status", "Syncing meetings",
		"Meetings ready     100", "Pending            140", "Transcripts stored 100",
		"Last completed sync:", "Daemon heartbeat:",
		"auto-refreshing  r refresh  Enter/Esc menu  q quit",
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("missing %q in:\n%s", want, screen)
		}
	}
	if !strings.Contains(screen, "[#") {
		t.Errorf("a known total should draw a bar:\n%s", screen)
	}
}
