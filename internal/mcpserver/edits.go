package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// handleEditLine corrects one transcript line.
//
// expected_text must equal the line as it currently reads. That is not
// ceremony: it is what stops a model editing a line it misread, or one whose
// number shifted since it last looked.
func handleEditLine(_ context.Context, service *Service, raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID    string `json:"meeting_id"`
		Line         int    `json:"line"`
		ExpectedText string `json:"expected_text"`
		NewText      string `json:"new_text"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" || args.Line < 1 {
		return "", errors.New("meeting_id and a 1-based line are required")
	}
	if args.ExpectedText == "" {
		return "", errors.New(
			"expected_text is required: pass the line exactly as it currently reads, " +
				"which read {meeting_id, lines: [n, n]} will show you")
	}
	if args.NewText == "" {
		return "", errors.New("new_text is required; to undo a correction use restore_line")
	}

	database, err := service.openStore()
	if err != nil {
		return "", err
	}
	defer database.Close()

	edit, err := database.EditLine(
		args.MeetingID, args.Line, args.ExpectedText, args.NewText, store.AuthorAgent)
	if err != nil {
		if errors.Is(err, store.ErrLineMismatch) {
			return "", fmt.Errorf(
				"line %d does not read what you expected, so nothing was changed. "+
					"Read it with read {meeting_id: %q, lines: [%d, %d]} and try again",
				args.Line, args.MeetingID, args.Line, args.Line)
		}
		return "", notFoundHint(err, args.MeetingID)
	}
	return fmt.Sprintf(
		"Line %d corrected.\n  was: %s\n  now: %s\n\nThe original is kept; "+
			"restore_line {meeting_id, line: %d} puts it back.",
		edit.LineNo, edit.OriginalText, edit.EditedText, edit.LineNo), nil
}

func handleLineHistory(_ context.Context, service *Service, raw json.RawMessage) (string, error) {
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
	database, err := service.openStore()
	if err != nil {
		return "", err
	}
	defer database.Close()

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
			time.UnixMilli(edit.EditedMS).Format("2006-01-02 15:04"),
			edit.Author, edit.State, edit.OriginalText, edit.EditedText)
	}
	if args.Line == 0 {
		out.WriteString("Undo one with restore_line {meeting_id, line}.\n")
	}
	return out.String(), nil
}

func handleRestoreLine(_ context.Context, service *Service, raw json.RawMessage) (string, error) {
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
	database, err := service.openStore()
	if err != nil {
		return "", err
	}
	defer database.Close()

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

// Pending sign-in state lives beside the session so the two login calls can be
// made by different processes. It holds no secret: the CSRF token is useless
// without the emailed code.
func pendingPath(root string) string { return filepath.Join(root, "pending-login.json") }

func savePending(root string, pending sana.PendingSignIn) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return os.WriteFile(pendingPath(root), payload, 0o600)
}

func loadPending(root string) (sana.PendingSignIn, error) {
	payload, err := os.ReadFile(pendingPath(root))
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

func clearPending(root string) { os.Remove(pendingPath(root)) }
