package localstate

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/store"
	_ "modernc.org/sqlite"
)

// foreignDatabase writes a database with someone else's meetings table: the
// exact shape the previous implementation left behind.
func foreignDatabase(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(
		`CREATE TABLE meetings (id TEXT PRIMARY KEY, name TEXT, created_at_ms INTEGER)`,
	); err != nil {
		t.Fatal(err)
	}
}

func TestInspectAcceptsAFreshMachine(t *testing.T) {
	paths := config.PathsUnder(filepath.Join(t.TempDir(), ".sana-mcp"))
	report := Inspect(paths)
	if report.Present {
		t.Fatal("an empty root should not be reported as present")
	}
	if report.Incompatible() {
		t.Fatal("nothing on disk cannot be incompatible")
	}
}

func TestInspectRefusesAForeignDatabase(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)
	if err := os.WriteFile(filepath.Join(paths.Root, "session.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(paths.Root, "models"), 0o700); err != nil {
		t.Fatal(err)
	}

	report := Inspect(paths)
	if !report.Incompatible() {
		t.Fatalf("a foreign database must be reported: %+v", report)
	}
	if !strings.Contains(report.Reason, "different version") {
		t.Fatalf("the reason must be readable, got %q", report.Reason)
	}
	if !report.SessionPresent {
		t.Fatal("a stored session must be noticed")
	}
	if len(report.Foreign) != 1 || report.Foreign[0] != "models" {
		t.Fatalf("foreign entries = %q", report.Foreign)
	}
}

func TestResetQuarantinesAndCommits(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)
	binary := filepath.Join(paths.Root, "bin", "sana-mcp")
	if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Database); !os.IsNotExist(err) {
		t.Fatal("the old database should have been moved aside")
	}
	// The running binary lives inside the data root and must survive: it is
	// the program doing the replacing.
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("the binary was moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(reset.Quarantine(), "sana.db")); err != nil {
		t.Fatalf("the old database is not in the quarantine: %v", err)
	}

	// The fresh root must now be usable by this build.
	database, err := store.Open(paths.Database)
	if err != nil {
		t.Fatalf("a replaced root must open cleanly: %v", err)
	}
	database.Close()

	if err := reset.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(reset.Quarantine()); !os.IsNotExist(err) {
		t.Fatal("commit should have deleted the quarantine")
	}
	if _, err := os.Stat(filepath.Join(paths.Root, journalName)); !os.IsNotExist(err) {
		t.Fatal("commit should have removed the journal")
	}
}

func TestRollbackPutsTheOriginalBack(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)
	before, err := os.ReadFile(paths.Database)
	if err != nil {
		t.Fatal(err)
	}

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	// Something the fresh setup wrote, which must not survive the rollback.
	if err := os.WriteFile(paths.Database, []byte("fresh"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reset.Rollback(); err != nil {
		t.Fatal(err)
	}

	after, err := os.ReadFile(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("rollback did not restore the original database")
	}
	if _, err := os.Stat(reset.Quarantine()); !os.IsNotExist(err) {
		t.Fatal("rollback should have removed the quarantine")
	}
}

func TestRecoverUndoesAnInterruptedReset(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)

	if _, err := Begin(paths); err != nil {
		t.Fatal(err)
	}
	// The process dies here: the journal and the quarantine are all that is
	// left to work from.
	if err := Recover(paths); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Database); err != nil {
		t.Fatalf("recovery did not restore the database: %v", err)
	}
	if !Inspect(paths).Incompatible() {
		t.Fatal("recovery should have restored the original, incompatible state")
	}
	// A second recovery with no journal is not an error.
	if err := Recover(paths); err != nil {
		t.Fatal(err)
	}
}

func TestPlanUninstallStaysInsideThisHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))

	if err := os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	previous := filepath.Join(home, ".local", "bin", binaryName())
	if err := os.WriteFile(previous, []byte("old"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".bashrc"),
		[]byte("export A=1\n"+profileMarker+"\nexport PATH=\"$HOME/.sana-mcp/bin:$PATH\"\nexport B=2\n"),
		0o600); err != nil {
		t.Fatal(err)
	}

	plan := PlanUninstall(paths, "")
	kinds := map[string]int{}
	for _, leftover := range plan.Leftovers {
		kinds[leftover.Kind]++
		if !strings.HasPrefix(leftover.Path, home) {
			t.Fatalf("uninstall reached outside this home: %s", leftover.Path)
		}
	}
	if kinds["data"] != 1 || kinds["binary"] != 1 || kinds["profile"] != 1 {
		t.Fatalf("plan = %+v", plan.Leftovers)
	}

	for _, removal := range plan.Apply() {
		if removal.Err != nil {
			t.Fatalf("%s: %v", removal.Leftover.Path, removal.Err)
		}
	}
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Fatal("the previous binary was not removed")
	}
	if _, err := os.Stat(paths.Root); !os.IsNotExist(err) {
		t.Fatal("the data root was not removed")
	}
	rc, err := os.ReadFile(filepath.Join(home, ".bashrc"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rc), "sana-mcp") {
		t.Fatalf("the PATH line was left behind: %q", rc)
	}
	// Only the two lines it added: the user's own settings stay.
	if !strings.Contains(string(rc), "export A=1") || !strings.Contains(string(rc), "export B=2") {
		t.Fatalf("unrelated lines were removed: %q", rc)
	}
}
