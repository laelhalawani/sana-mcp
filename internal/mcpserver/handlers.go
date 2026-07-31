package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// schemas is the per-tool argument documentation `help` renders.
var schemas = map[string]string{
	"help":         `{tool?: string}`,
	"login":        `{email: string, confirmation_code?: string}  - call with email first, then with the code`,
	"status":       `{}`,
	"list":         `{page?: int=1, limit?: int=25, query?: string, sort?: "newest"|"oldest", filter?: {status?: "ready"|"processing"|"retrying", date?: {from?: string, to?: string}}}`,
	"read":         `{meeting_id: string, full?: bool, lines?: [start:int, end:int], timestamps?: bool=true}`,
	"search":       `{query: string, page?: int=1, limit?: int=10, sort?: "best"|"newest"|"oldest"}`,
	"summary":      `{meeting_id: string}`,
	"participants": `{meeting_id: string}`,
	"recording":    `{meeting_id: string}  - fetched live from Sana; the link expires after a few hours`,
	"edit_line":    `{meeting_id: string, line: int, expected_text: string, new_text: string}  - expected_text must equal the line as it currently reads`,
	"line_history": `{meeting_id: string, line?: int}`,
	"restore_line": `{meeting_id: string, line: int}`,
}

func helpText(tool string) string {
	if tool != "" {
		if schema, known := schemas[strings.ToLower(tool)]; known {
			return fmt.Sprintf("%s\n  args: %s", tool, schema)
		}
		return fmt.Sprintf("Unknown tool %q.\n\n%s", tool, helpText(""))
	}
	names := make([]string, 0, len(schemas))
	for name := range schemas {
		names = append(names, name)
	}
	sort.Strings(names)
	var out strings.Builder
	out.WriteString("meeting_transcripts tools:\n")
	for _, name := range names {
		fmt.Fprintf(&out, "  %-13s %s\n", name, schemas[name])
	}
	return out.String()
}

func handleHelp(_ context.Context, _ *Service, raw json.RawMessage) (string, error) {
	var args struct {
		Tool string `json:"tool"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	return helpText(args.Tool), nil
}

func handleStatus(_ context.Context, service *Service, database *store.Store, _ json.RawMessage) (string, error) {
	status, err := database.Status()
	if err != nil {
		return "", err
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%s\n", status.Label())
	out.WriteString(render.StatusLines(status))
	if status.Phase == store.PhaseNeedsLogin {
		out.WriteString("\nSign in with meeting_transcripts(\"login\", {\"email\": \"you@example.com\"}).\n")
	}
	return out.String(), nil
}

// dateMS accepts an ISO date (YYYY-MM-DD) or epoch milliseconds.
func dateMS(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		return parsed.UnixMilli(), nil
	}
	var epoch int64
	if _, err := fmt.Sscanf(value, "%d", &epoch); err == nil && epoch > 0 {
		return epoch, nil
	}
	return 0, fmt.Errorf("date %q is neither YYYY-MM-DD nor epoch milliseconds", value)
}

type dateFilter struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func handleList(_ context.Context, service *Service, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		Page   int    `json:"page"`
		Limit  int    `json:"limit"`
		Query  string `json:"query"`
		Sort   string `json:"sort"`
		Filter struct {
			Status string      `json:"status"`
			Date   *dateFilter `json:"date"`
		} `json:"filter"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	options := store.ListOptions{
		Page: args.Page, Limit: args.Limit, Query: args.Query,
		Sort: args.Sort, Status: args.Filter.Status,
	}
	options.Normalize()
	if args.Filter.Date != nil {
		from, err := dateMS(args.Filter.Date.From)
		if err != nil {
			return "", err
		}
		to, err := dateMS(args.Filter.Date.To)
		if err != nil {
			return "", err
		}
		options.FromMS, options.ToMS = from, to
	}

	meetings, total, err := database.ListMeetings(options)
	if err != nil {
		return "", err
	}
	if len(meetings) == 0 {
		return "No meetings match. Try meeting_transcripts(\"status\") to see whether sync has run.", nil
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%d meetings, page %d of %d\n\n",
		total, options.Page, (total+options.Limit-1)/options.Limit)
	for _, meeting := range meetings {
		fmt.Fprintf(&out, "%s  %s  %s  %s\n",
			meeting.MeetingID,
			render.Timestamp(meeting.CreatedMS),
			meeting.Status,
			meeting.Title)
	}
	return out.String(), nil
}

func handleRead(_ context.Context, service *Service, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID  string `json:"meeting_id"`
		Full       bool   `json:"full"`
		Lines      []int  `json:"lines"`
		Timestamps *bool  `json:"timestamps"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" {
		return "", errors.New("meeting_id is required")
	}
	meeting, err := database.GetMeeting(args.MeetingID)
	if err != nil {
		return "", notFoundHint(err, args.MeetingID)
	}
	count, err := database.LineCount(args.MeetingID)
	if err != nil {
		return "", err
	}
	if count == 0 {
		return fmt.Sprintf(
			"%s has no transcript stored yet (status: %s). Check meeting_transcripts(\"status\").",
			meeting.Title, meeting.Status), nil
	}

	from, to := 0, 0
	switch {
	case len(args.Lines) == 2:
		from, to = args.Lines[0], args.Lines[1]
		if from < 1 || to < from {
			return "", fmt.Errorf("lines must be [start, end] with 1 <= start <= end; got %v", args.Lines)
		}
	case args.Full:
		// everything
	default:
		// Neither a range nor full: report the size and the options rather than
		// dumping a transcript nobody asked for.
		return fmt.Sprintf(
			"%s\n%s, %d lines.\n\nRead it with lines: [1, %d] for a range, or full: true for everything.",
			meeting.Title,
			render.Timestamp(meeting.CreatedMS),
			count, min(count, 50)), nil
	}

	lines, err := database.Lines(args.MeetingID, from, to)
	if err != nil {
		return "", err
	}
	timestamps := args.Timestamps == nil || *args.Timestamps
	var out strings.Builder
	fmt.Fprintf(&out, "%s\n", meeting.Title)
	for _, line := range lines {
		if timestamps {
			fmt.Fprintf(&out, "%d [%s] %s: %s\n",
				line.LineNo, render.Clock(line.StartMS), line.Speaker, line.Text)
			continue
		}
		fmt.Fprintf(&out, "%d %s: %s\n", line.LineNo, line.Speaker, line.Text)
	}
	return out.String(), nil
}

func handleSearch(_ context.Context, service *Service, database *store.Store, raw json.RawMessage) (string, error) {
	var args struct {
		Query string `json:"query"`
		Page  int    `json:"page"`
		Limit int    `json:"limit"`
		Sort  string `json:"sort"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Query) == "" {
		return "", errors.New("query is required")
	}
	if args.Page < 1 {
		args.Page = 1
	}
	if args.Limit < 1 {
		args.Limit = 10
	}
	hits, err := database.Search(args.Query, args.Limit, (args.Page-1)*args.Limit, args.Sort)
	if err != nil {
		return "", err
	}
	if len(hits) == 0 {
		return fmt.Sprintf("Nothing matched %q.\n\n%s", args.Query, render.NoMatchHint), nil
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%d results for %q\n\n", len(hits), args.Query)
	for _, hit := range hits {
		fmt.Fprintf(&out, "%s  line %d  %s\n  %s\n",
			hit.MeetingID, hit.LineNo,
			render.Date(hit.CreatedMS),
			strings.TrimSpace(hit.Text))
	}
	out.WriteString("\nRead around a hit with read {meeting_id, lines: [n-5, n+5]}.\n")
	return out.String(), nil
}

func handleSummary(_ context.Context, service *Service, database *store.Store, raw json.RawMessage) (string, error) {
	meetingID, err := meetingArg(raw)
	if err != nil {
		return "", err
	}
	metadata, _, err := database.Metadata(meetingID)
	if err != nil {
		return "", notFoundHint(err, meetingID)
	}
	return render.Summary(metadata, render.Styles{}), nil
}

func handleParticipants(_ context.Context, service *Service, database *store.Store, raw json.RawMessage) (string, error) {
	meetingID, err := meetingArg(raw)
	if err != nil {
		return "", err
	}
	_, participants, err := database.Metadata(meetingID)
	if err != nil {
		return "", notFoundHint(err, meetingID)
	}
	return render.Participants(participants, render.Styles{}), nil
}

// handleRecording fetches the link live: it expires after a few hours, so a
// stored one would usually be dead.
func handleRecording(ctx context.Context, service *Service, raw json.RawMessage) (string, error) {
	meetingID, err := meetingArg(raw)
	if err != nil {
		return "", err
	}
	session, err := sana.LoadSession(service.runtime.Paths.Session)
	if err != nil {
		return "", err
	}
	if !session.SignedIn() {
		return "", errors.New(
			"not signed in; call meeting_transcripts(\"login\", {\"email\": \"you@example.com\"})")
	}
	client := sana.New("", session)
	metadata, err := client.Meeting(ctx, meetingID)
	if err != nil {
		return "", err
	}
	link := metadata.Recording()
	if link == "" {
		return "This meeting has no recording.", nil
	}
	return link + "\n\nThis link expires after a few hours.", nil
}

func handleLogin(ctx context.Context, service *Service, raw json.RawMessage) (string, error) {
	var args struct {
		Email string `json:"email"`
		Code  string `json:"confirmation_code"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Email) == "" {
		return "", errors.New("email is required")
	}
	client := sana.New("", nil)

	if args.Code == "" {
		pending, err := client.RequestSignInCode(ctx, args.Email)
		if err != nil {
			return "", err
		}
		if err := savePending(service.runtime.Paths.Root, pending); err != nil {
			return "", err
		}
		return fmt.Sprintf(
			"A sign-in code has been emailed to %s.\n\nCall meeting_transcripts(\"login\", "+
				"{\"email\": %q, \"confirmation_code\": \"123456\"}) with the code.",
			pending.Email, pending.Email), nil
	}

	pending, err := loadPending(service.runtime.Paths.Root)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(pending.Email, sana.NormalizeEmail(args.Email)) {
		return "", errors.New(
			"no pending sign-in for that address; call login with just the email first")
	}
	user, err := client.SubmitSignInCode(ctx, pending, args.Code)
	if err != nil {
		return "", err
	}
	if err := sana.SaveSession(service.runtime.Paths.Session, sana.SessionFrom(client, user)); err != nil {
		return "", err
	}
	clearPending(service.runtime.Paths.Root)
	return fmt.Sprintf(
		"Signed in as %s.\n\nSync starts in the background; check meeting_transcripts(\"status\").",
		user.Email), nil
}

func meetingArg(raw json.RawMessage) (string, error) {
	var args struct {
		MeetingID string `json:"meeting_id"`
	}
	if err := decode(raw, &args); err != nil {
		return "", err
	}
	if args.MeetingID == "" {
		return "", errors.New("meeting_id is required")
	}
	return args.MeetingID, nil
}

func notFoundHint(err error, meetingID string) error {
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf(
			"no meeting %s is stored locally; find its id with meeting_transcripts(\"list\")", meetingID)
	}
	return err
}
