package localstate

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/sana"
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

func TestProfileHandlesBothMarkerStyles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))

	// Exactly what an upgraded machine has: the older installer's fenced block
	// pointing at ~/.local/bin, and the current one's line.
	profile := filepath.Join(home, ".bashrc")
	content := "export EDITOR=vim\n\n" +
		profileOpen + "\nexport PATH='" + home + "/.local/bin':\"$PATH\"\n" + profileClose + "\n\n" +
		profileMarker + "\nexport PATH=\"" + home + "/.sana-mcp/bin:$PATH\"\nexport TAIL=1\n"
	if err := os.WriteFile(profile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	// An install takes out only the entry that points somewhere else, so the
	// freshly installed binary is not left shadowed by the one it replaced.
	if err := os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(home, ".local", "bin", binaryName())
	if err := os.WriteFile(old, []byte("old"), 0o700); err != nil {
		t.Fatal(err)
	}

	// An install replaces only the binary. The stale PATH entry is left alone:
	// it names a directory that no longer holds the program, which does
	// nothing, and removing it can take the command off PATH entirely when the
	// current entry went into a different startup file.
	superseded := Superseded(paths, filepath.Join(paths.Root, "bin", binaryName()))
	if len(superseded.Leftovers) != 1 || superseded.Leftovers[0].Kind != "binary" {
		t.Fatalf("superseded = %+v", superseded.Leftovers)
	}
	for _, removal := range RemoveSuperseded(superseded) {
		if removal.Err != nil {
			t.Fatalf("%s: %v", removal.Leftover.Path, removal.Err)
		}
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("the superseded binary was not removed")
	}

	// An uninstall takes out both entries.
	if err := stripProfile(profile); err != nil {
		t.Fatal(err)
	}
	final, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(final), "sana-mcp") {
		t.Fatalf("uninstall left an entry behind:\n%s", final)
	}
	if !strings.Contains(string(final), "export EDITOR=vim") {
		t.Fatalf("uninstall removed an unrelated line:\n%s", final)
	}
}

func TestSupersededLeavesTheCurrentInstallAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))

	current := filepath.Join(paths.Root, "bin", binaryName())
	if err := os.MkdirAll(filepath.Dir(current), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(current, []byte("new"), 0o700); err != nil {
		t.Fatal(err)
	}
	if plan := Superseded(paths, current); !plan.Empty() {
		t.Fatalf("nothing was superseded, got %+v", plan.Leftovers)
	}
}

func TestProfileKeepsEverythingBelowAnUnterminatedFence(t *testing.T) {
	// A close marker lost to a hand edit used to make the block run to the end
	// of the file, so a routine configure silently truncated the profile.
	lines := []string{
		"export EDITOR=vim",
		profileOpen,
		"export PATH='/home/u/.local/bin':\"$PATH\"",
		"export SECRET=1",
		"alias g=git",
	}
	kept, removed := profileEdit(lines, always)
	if len(removed) != 0 {
		t.Fatalf("an unterminated block must not be removed, got %q", removed)
	}
	if strings.Join(kept, "\n") != strings.Join(lines, "\n") {
		t.Fatalf("kept = %q, want the file unchanged", kept)
	}
}

func TestMarkerDoesNotReachPastTheLineItIntroduced(t *testing.T) {
	// The marker introduces exactly one line. A fence starting on the next line
	// used to leave the marker armed, so it ate the first sana-mcp-mentioning
	// line after the block - which was somebody else's.
	lines := []string{
		profileMarker,
		profileOpen,
		"export PATH='/home/u/.local/bin':\"$PATH\"",
		profileClose,
		"export SANAX=/opt/sana-mcp/thing",
		"alias g=git",
	}
	kept, _ := profileEdit(lines, always)
	joined := strings.Join(kept, "\n")
	if !strings.Contains(joined, "SANAX") {
		t.Fatalf("an unrelated line was removed:\n%s", joined)
	}
	if !strings.Contains(joined, "alias g=git") {
		t.Fatalf("kept = %q", kept)
	}
}

func TestUninstallListsDataLeftByAnInterruptedSetup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))
	foreignDatabase(t, paths.Database)

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	// The process died here, so the journal is gone from the caller's view but
	// the data is sitting in a sibling directory.
	if err := os.Remove(filepath.Join(paths.Root, journalName)); err != nil {
		t.Fatal(err)
	}

	plan := PlanUninstall(paths, "")
	found := false
	for _, leftover := range plan.Leftovers {
		if leftover.Path == reset.Quarantine() {
			found = true
		}
	}
	if !found {
		t.Fatalf("the abandoned data was not listed: %+v", plan.Leftovers)
	}
	for _, removal := range plan.Apply() {
		if removal.Err != nil {
			t.Fatalf("%s: %v", removal.Leftover.Path, removal.Err)
		}
	}
	if _, err := os.Stat(reset.Quarantine()); !os.IsNotExist(err) {
		t.Fatal("the abandoned data survived the uninstall")
	}
}

func TestResetKeepsAReadableSignIn(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)
	if err := os.WriteFile(paths.Session,
		[]byte(`{"cookies":{"sana-ai-session":"abc"},"email":"a@b.c"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	// The meetings are a cache and come back; the sign-in does not, and Commit
	// deletes the quarantine for good.
	session, err := sana.LoadSession(paths.Session)
	if err != nil {
		t.Fatal(err)
	}
	if !session.SignedIn() || session.Address() != "a@b.c" {
		t.Fatalf("the sign-in was not carried over: %+v", session)
	}
	if err := reset.Commit(); err != nil {
		t.Fatal(err)
	}
	if again, _ := sana.LoadSession(paths.Session); !again.SignedIn() {
		t.Fatal("the sign-in did not survive the commit")
	}
}

func TestUnterminatedFenceFollowedByARealBlockKeepsWhatIsBetween(t *testing.T) {
	// The close marker of the first block was lost to a hand edit. Without the
	// second-open check the later block's close swallowed everything between.
	lines := []string{
		profileOpen,
		"export PATH='/home/u/.local/bin':\"$PATH\"",
		"export MY_SECRET=1",
		"alias g=git",
		profileOpen,
		"export PATH='/home/u/.sana-mcp/bin':\"$PATH\"",
		profileClose,
	}
	kept, removed := profileEdit(lines, always)
	joined := strings.Join(kept, "\n")
	for _, want := range []string{"MY_SECRET", "alias g=git"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%q was removed:\n%s", want, joined)
		}
	}
	if len(removed) != 3 {
		t.Fatalf("only the terminated block is ours, removed = %q", removed)
	}
}

func TestAMarkerAboveAnotherMarkerIntroducesNothing(t *testing.T) {
	lines := []string{
		"export A=1",
		profileMarker,
		profileMarker,
		`export PATH="/home/u/.sana-mcp/bin:$PATH"`,
		"export B=2",
	}
	kept, _ := profileEdit(lines, always)
	joined := strings.Join(kept, "\n")
	if strings.Contains(joined, "sana-mcp") {
		t.Fatalf("the live PATH line was left behind:\n%s", joined)
	}
	for _, want := range []string{"export A=1", "export B=2"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%q was removed:\n%s", want, joined)
		}
	}
}

func TestCommitIsRecordedBeforeItDeletes(t *testing.T) {
	// A commit interrupted part-way used to look exactly like a replacement
	// that never finished, so the next run rolled it back - restoring whatever
	// survived of the old state on top of the new.
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)
	if err := os.WriteFile(paths.Session, []byte(`{"cookies":{"sana-ai-session":"OLD"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Database, []byte("fresh"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Session, []byte(`{"cookies":{"sana-ai-session":"NEW"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	// Commit writes its decision first, then starts deleting. Simulate dying
	// after the first removal.
	reset.journal.State = "committed"
	if err := reset.write(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(reset.Quarantine(), "sana.db")); err != nil {
		t.Fatal(err)
	}

	if err := Recover(paths); err != nil {
		t.Fatal(err)
	}
	database, err := os.ReadFile(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if string(database) != "fresh" {
		t.Fatalf("the new database was rolled back: %q", database)
	}
	session, err := os.ReadFile(paths.Session)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(session), "NEW") {
		t.Fatalf("the old session was restored over the new one: %s", session)
	}
	if _, err := os.Stat(reset.Quarantine()); !os.IsNotExist(err) {
		t.Fatal("recovery did not finish the commit")
	}
}

func TestAnUnreadableJournalDoesNotWedgeTheInstaller(t *testing.T) {
	paths := config.PathsUnder(t.TempDir())
	if err := os.MkdirAll(paths.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	// A crash inside the journal's own write leaves it truncated. Refusing to
	// continue meant configure could never run again, and the message never
	// named the file to delete.
	if err := os.WriteFile(filepath.Join(paths.Root, journalName), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Recover(paths); err != nil {
		t.Fatalf("a truncated journal with no data behind it must clear: %v", err)
	}
	if _, err := os.Stat(filepath.Join(paths.Root, journalName)); !os.IsNotExist(err) {
		t.Fatal("the unreadable journal was left in place")
	}
}

func TestSupersededOnlyLooksWhereInstallersWrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))

	// A binary somewhere this project never installs is not ours to delete.
	for _, directory := range installDirectories(paths) {
		if strings.HasSuffix(directory, "/usr/local/bin") || filepath.Base(directory) == "bin" &&
			filepath.Dir(directory) == home {
			t.Fatalf("installDirectories still guesses: %s", directory)
		}
	}
}

func TestPathHintIsSilentWhenTheCommandResolves(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))
	directory := filepath.Join(paths.Root, "bin")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(directory, binaryName())
	if err := os.WriteFile(installed, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// The install script exports the directory for its own use before running
	// the setup, so this process always finds it. What matters is the file the
	// user's next shell reads.
	t.Setenv("PATH", directory)
	t.Setenv("SHELL", "/bin/bash")

	// The entry went into .zshrc; a bash user will never see it.
	if err := os.WriteFile(filepath.Join(home, ".zshrc"),
		[]byte("export PATH=\""+directory+":$PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	hint := PathHint(paths)
	if hint == "" {
		t.Fatal("an entry in a file this shell does not read must still warn")
	}
	// $HOME, never a tilde: the line is meant to be pasted, and ~ does not
	// expand inside double quotes.
	if !strings.Contains(hint, "$HOME/.sana-mcp/bin") {
		t.Fatalf("the hint must be pasteable, got %q", hint)
	}
	if strings.Contains(hint, "~") {
		t.Fatalf("a tilde in double quotes makes a directory called ~: %q", hint)
	}

	// Once it is in the file bash reads, there is nothing to say.
	if err := os.WriteFile(filepath.Join(home, ".bashrc"),
		[]byte("export PATH=\""+directory+":$PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if hint := PathHint(paths); hint != "" {
		t.Fatalf("a reachable install needs no hint, got %q", hint)
	}
}

func TestCommitSurvivesAJournalItCannotUpdate(t *testing.T) {
	// The journal goes before the data: with no journal there is nothing a
	// later run can mistake for a replacement to undo. Deleting the data first
	// meant an interrupted commit was rolled back, restoring the old state over
	// the new one.
	paths := config.PathsUnder(t.TempDir())
	foreignDatabase(t, paths.Database)

	reset, err := Begin(paths)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Database, []byte("fresh"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reset.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.Root, journalName)); !os.IsNotExist(err) {
		t.Fatal("the journal outlived the commit")
	}
	// Whatever happened to the quarantine, a later run must not undo this.
	if err := Recover(paths); err != nil {
		t.Fatal(err)
	}
	database, err := os.ReadFile(paths.Database)
	if err != nil {
		t.Fatal(err)
	}
	if string(database) != "fresh" {
		t.Fatalf("a committed replacement was rolled back: %q", database)
	}
}

func TestPathHintDoesNotGuessWrong(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	paths := config.PathsUnder(filepath.Join(home, ".sana-mcp"))
	directory := filepath.Join(paths.Root, "bin")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, binaryName()), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(home, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	clear := func() {
		t.Helper()
		for _, name := range []string{".zshenv", ".zprofile", ".zshrc", ".bashrc",
			".bash_profile", ".bash_login", ".profile"} {
			os.Remove(filepath.Join(home, name))
		}
	}

	// zsh users are told to set PATH in .zshenv, so only reading .zshrc warned
	// people whose PATH plainly contained it.
	t.Setenv("SHELL", "/bin/zsh")
	clear()
	write(".zshenv", "export PATH=\""+directory+":$PATH\"\n")
	write(".zshrc", "alias g=git\n")
	if hint := PathHint(paths); hint != "" {
		t.Fatalf("a .zshenv entry is still an entry, got %q", hint)
	}

	// A commented-out line is not on anyone's PATH.
	t.Setenv("SHELL", "/bin/bash")
	clear()
	write(".bashrc", "# export PATH=\""+directory+":$PATH\"\n")
	if PathHint(paths) == "" {
		t.Fatal("a commented-out entry must not count")
	}

	// A different directory that merely contains this one as a substring.
	clear()
	write(".bashrc", "export PATH=\""+directory+"-old:$PATH\"\n")
	if PathHint(paths) == "" {
		t.Fatal("a different directory must not count")
	}

	// The real entry.
	clear()
	write(".bashrc", "export PATH=\""+directory+":$PATH\"\n")
	if hint := PathHint(paths); hint != "" {
		t.Fatalf("a real entry needs no hint, got %q", hint)
	}

	// The forms a hand-edited profile actually uses. Missing these warned
	// people whose PATH plainly contained the directory.
	for _, form := range []string{
		"export PATH=\"$HOME/.sana-mcp/bin:$PATH\"",
		"export PATH=\"${HOME}/.sana-mcp/bin:$PATH\"",
		"export PATH=\"~/.sana-mcp/bin:$PATH\"",
		"PATH=$PATH:$HOME/.sana-mcp/bin",
		"export PATH=\"$HOME/.sana-mcp/bin/:$PATH\"",
	} {
		clear()
		write(".bashrc", form+"\n")
		if hint := PathHint(paths); hint != "" {
			t.Fatalf("%q is an entry, got %q", form, hint)
		}
	}
}
