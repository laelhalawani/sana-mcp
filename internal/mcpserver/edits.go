package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/fsx"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// handleEditLine corrects one transcript line.
//
// expected_text is the fragment to replace, not the whole line, and occurrences
// says how many times it is expected to appear. That count is what stops a
// model editing text it has not looked at: a fragment that occurs somewhere
// else in the line fails the edit rather than quietly changing both places.
func handleEditLine(_ context.Context, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID    string `json:"meeting_id"`
		Line         int    `json:"line"`
		ExpectedText string `json:"expected_text"`
		NewText      string `json:"new_text"`
		Occurrences  *int   `json:"occurrences"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" || args.Line < 1 {
		return "", errors.New("meeting_id and a 1-based line are required")
	}
	if args.ExpectedText == "" {
		return "", errors.New(
			"expected_text is required: the text to replace, exactly as it currently reads, " +
				"which read {meeting_id, lines: [n, n]} will show you")
	}
	if args.NewText == "" {
		return "", errors.New("new_text is required; to undo a correction use restore_line")
	}
	occurrences := 1
	if args.Occurrences != nil {
		occurrences = *args.Occurrences
	}

	edit, err := database.EditLine(
		args.MeetingID, args.Line, args.ExpectedText, args.NewText, occurrences, store.AuthorAgent)
	if err != nil {
		if errors.Is(err, store.ErrLineMismatch) {
			// The number found is deliberately withheld. Told what it was, the
			// obvious next move is to retry with that number - which replaces
			// occurrences nobody has looked at, and is exactly what this check
			// exists to prevent.
			return "", fmt.Errorf(
				"line %d does not contain that text %d time(s), so nothing was changed. "+
					"Read it with read {meeting_id: %q, lines: [%d, %d]} and decide from what it "+
					"actually says before editing again",
				args.Line, occurrences, args.MeetingID, args.Line, args.Line)
		}
		return "", notFoundHint(err, args.MeetingID)
	}
	return fmt.Sprintf(
		"Line %d corrected.\n  was: %s\n  now: %s\n\nThe original is kept; "+
			"restore_line {meeting_id, line: %d} puts it back.",
		edit.LineNo, edit.OriginalText, edit.EditedText, edit.LineNo), nil
}

func handleLineHistory(_ context.Context, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID string `json:"meeting_id"`
		Line      int    `json:"line"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" {
		return "", errors.New("meeting_id is required")
	}
	edits, err := database.LineHistory(args.MeetingID, args.Line)
	if err != nil {
		return "", err
	}
	if len(edits) == 0 {
		if args.Line > 0 {
			return fmt.Sprintf("Line %d has never been changed.", args.Line), nil
		}
		return "No lines in this meeting have been changed.", nil
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%d change(s)\n\n", len(edits))
	for _, edit := range edits {
		fmt.Fprintf(&out, "line %d  %s  by %s  [%s]\n  original: %s\n  changed:  %s\n\n",
			edit.LineNo,
			render.Timestamp(edit.EditedMS),
			edit.Author, edit.State, edit.OriginalText, edit.EditedText)
	}
	if args.Line == 0 {
		out.WriteString("Undo one with restore_line {meeting_id, line}.\n")
	}
	return out.String(), nil
}

func handleRestoreLine(_ context.Context, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID string `json:"meeting_id"`
		Line      int    `json:"line"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" || args.Line < 1 {
		return "", errors.New("meeting_id and a 1-based line are required")
	}
	if err := database.RestoreLine(args.MeetingID, args.Line); err != nil {
		return "", notFoundHint(err, args.MeetingID)
	}
	lines, err := database.Lines(args.MeetingID, args.Line, args.Line)
	if err != nil {
		return "", err
	}
	if len(lines) == 0 {
		return fmt.Sprintf("Line %d restored.", args.Line), nil
	}
	return fmt.Sprintf("Line %d restored to what Sana delivered:\n  %s",
		args.Line, lines[0].Text), nil
}

// Pending sign-in state is written between the two login calls, which may be
// made by different processes. It holds no secret: the CSRF token is useless
// without the emailed code.

func savePending(path string, pending sana.PendingSignIn) error {
	payload, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, payload, 0o600)
}

func loadPending(path string) (sana.PendingSignIn, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return sana.PendingSignIn{}, errors.New(
			"no pending sign-in; call login with just the email first")
	}
	var pending sana.PendingSignIn
	if err := json.Unmarshal(payload, &pending); err != nil {
		return sana.PendingSignIn{}, err
	}
	return pending, nil
}

func clearPending(path string) { os.Remove(path) }
