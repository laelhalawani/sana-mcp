package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/laelhalawani/sana-mcp/internal/store"
)

// read asks whether a transcript exists, which is a question about the whole
// transcript and not about the range just requested. Keying the answer off the
// range made a window past the end report a meeting whose transcript is empty -
// false, and the opposite of what the MCP surface says about the same meeting.
func TestReadRangePastTheEndDoesNotClaimAnEmptyTranscript(t *testing.T) {
	database, err := store.Open(filepath.Join(t.TempDir(), "sana.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.PutMeeting(store.Meeting{
		MeetingID: "m1", Title: "Review", CreatedMS: 1, Status: store.StatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.PutTranscript("m1", []store.Line{
		{LineNo: 1, Speaker: "Zara Nolan", OriginalText: "we started"},
	}); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	code := runDocumentRead(database, []string{"m1", "500", "600"}, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if strings.Contains(out.String(), "no lines") {
		t.Fatalf("a range past the end is not an empty transcript, got %q", out.String())
	}
	if !strings.Contains(out.String(), "Review") {
		t.Fatalf("the title should still be printed, got %q", out.String())
	}
}

// runDocumentRead drives the read command with the options the CLI builds.
func runDocumentRead(database *store.Store, args []string, out, errOut *bytes.Buffer) int {
	return runRead(database, Command{Name: "read", Args: args},
		Options{Stdout: out, Stderr: errOut})
}
