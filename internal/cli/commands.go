package cli

import (
	"bufio"
	"context"
	"encoding/json"

	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
)

// run executes a one-shot command against the local store.
func run(ctx context.Context, runtime *bootstrap.Runtime, command Command, options Options) int {
	switch command.Name {
	case "login":
		return runLogin(ctx, runtime, command, options)
	}

	database, err := store.Open(runtime.Paths.Database)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	defer database.Close()

	switch command.Name {
	case "status":
		return runStatus(database, options)
	case "list":
		return runList(database, command, options)
	case "read":
		return runRead(database, command, options)
	case "search":
		return runSearch(database, command, options)
	case "summary", "participants":
		return runDocument(database, command, options)
	case "recording":
		return runRecording(ctx, runtime, command, options)
	}
	fmt.Fprintf(options.Stderr, "sana-mcp: %s is not a command\n", command.Name)
	return 2
}

func runStatus(database *store.Store, options Options) int {
	status, err := database.Status()
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprintf(options.Stdout, "%s\n", status.Label())
	fmt.Fprintf(options.Stdout, "meetings      %d of %d downloaded\n", status.Meetings, status.MeetingsTotal)
	fmt.Fprintf(options.Stdout, "transcripts   %d of %d\n", status.TranscriptsDone, status.TranscriptsTotal)
	if status.Remaining > 0 {
		fmt.Fprintf(options.Stdout, "remaining     %d\n", status.Remaining)
	}
	if status.LastError != "" {
		fmt.Fprintf(options.Stdout, "last error    %s\n", status.LastError)
	}
	return 0
}

func runList(database *store.Store, command Command, options Options) int {
	query := strings.Join(command.Args, " ")
	meetings, total, err := database.ListMeetings(store.ListOptions{Limit: 25, Query: query})
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if len(meetings) == 0 {
		fmt.Fprintln(options.Stdout, "No meetings yet. Run sana-mcp status to see whether sync has run.")
		return 0
	}
	fmt.Fprintf(options.Stdout, "%d meetings\n\n", total)
	for _, meeting := range meetings {
		fmt.Fprintf(options.Stdout, "%s  %s  %6d words  %-10s  %s\n",
			meeting.MeetingID,
			time.UnixMilli(meeting.CreatedMS).Format("2006-01-02 15:04"),
			meeting.WordCount, meeting.Status, meeting.Title)
	}
	return 0
}

func runRead(database *store.Store, command Command, options Options) int {
	if len(command.Args) == 0 {
		fmt.Fprintln(options.Stderr, "sana-mcp: read needs a meeting id (see sana-mcp list)")
		return 2
	}
	meetingID := command.Args[0]
	meeting, err := database.GetMeeting(meetingID)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	from, to := 0, 0
	if len(command.Args) >= 3 {
		from, _ = strconv.Atoi(command.Args[1])
		to, _ = strconv.Atoi(command.Args[2])
	}
	lines, err := database.Lines(meetingID, from, to)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprintf(options.Stdout, "%s\n", meeting.Title)
	for _, line := range lines {
		fmt.Fprintf(options.Stdout, "%d [%s] %s: %s\n",
			line.LineNo, clock(line.StartMS), line.Speaker, line.Text)
	}
	return 0
}

func runSearch(database *store.Store, command Command, options Options) int {
	query := strings.Join(command.Args, " ")
	if strings.TrimSpace(query) == "" {
		fmt.Fprintln(options.Stderr, "sana-mcp: search needs a query")
		return 2
	}
	hits, err := database.Search(query, 20, 0, store.SortBest)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if len(hits) == 0 {
		fmt.Fprintf(options.Stdout,
			"Nothing matched %q.\n\nTranscripts come from speech recognition, so a name may be\n"+
				"spelled differently than you expect. Try a distinctive word from the\n"+
				"same discussion instead.\n", query)
		return 0
	}
	fmt.Fprintf(options.Stdout, "%d results for %q\n\n", len(hits), query)
	for _, hit := range hits {
		fmt.Fprintf(options.Stdout, "%s  line %d  %s\n  %s\n",
			hit.MeetingID, hit.LineNo,
			time.UnixMilli(hit.CreatedMS).Format("2006-01-02"),
			strings.TrimSpace(hit.Text))
	}
	return 0
}

func runDocument(database *store.Store, command Command, options Options) int {
	if len(command.Args) == 0 {
		fmt.Fprintf(options.Stderr, "sana-mcp: %s needs a meeting id\n", command.Name)
		return 2
	}
	summaryJSON, participantsJSON, err := database.Metadata(command.Args[0])
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	// These are rendered rather than dumped. The stored documents are the raw
	// JSON Sana returned, which is the right thing to keep but the wrong thing
	// to show a person at a terminal.
	if command.Name == "summary" {
		var metadata sana.Metadata
		if err := json.Unmarshal([]byte(summaryJSON), &metadata); err != nil {
			fmt.Fprintln(options.Stderr, "sana-mcp:", err)
			return 1
		}
		fmt.Fprint(options.Stdout, renderSummary(metadata))
		return 0
	}
	var participants []sana.Participant
	if err := json.Unmarshal([]byte(participantsJSON), &participants); err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprint(options.Stdout, renderParticipants(participants))
	return 0
}

// renderSummary lays out a meeting's summary document as plain text.
func renderSummary(metadata sana.Metadata) string {
	var out strings.Builder
	if metadata.Summary != nil && strings.TrimSpace(*metadata.Summary) != "" {
		out.WriteString(strings.TrimSpace(*metadata.Summary) + "\n\n")
	}
	for _, group := range metadata.Notes {
		fmt.Fprintf(&out, "%s\n", group.Topic)
		for _, note := range group.Notes {
			fmt.Fprintf(&out, "  - %s\n", note)
		}
		out.WriteString("\n")
	}
	if len(metadata.ActionItems) > 0 {
		out.WriteString("Action items\n")
		for _, item := range metadata.ActionItems {
			assignee := ""
			if item.AssignedTo != nil && *item.AssignedTo != "" {
				assignee = *item.AssignedTo + ": "
			}
			due := ""
			if item.DueDate != nil && *item.DueDate != "" {
				due = " (due " + *item.DueDate + ")"
			}
			fmt.Fprintf(&out, "  - %s%s%s\n", assignee, item.Action, due)
		}
	}
	if out.Len() == 0 {
		return "This meeting has no summary yet.\n"
	}
	return out.String()
}

// renderParticipants lists attendees as plain text.
func renderParticipants(participants []sana.Participant) string {
	if len(participants) == 0 {
		return "No participants are recorded for this meeting.\n"
	}
	var out strings.Builder
	for _, participant := range participants {
		email := ""
		if participant.Email != nil && *participant.Email != "" {
			email = "  " + *participant.Email
		}
		host := ""
		if participant.IsHost {
			host = "  (host)"
		}
		fmt.Fprintf(&out, "%s%s%s\n", participant.DisplayName, email, host)
	}
	return out.String()
}

func runRecording(ctx context.Context, runtime *bootstrap.Runtime, command Command, options Options) int {
	if len(command.Args) == 0 {
		fmt.Fprintln(options.Stderr, "sana-mcp: recording needs a meeting id")
		return 2
	}
	session, err := sana.LoadSession(runtime.Paths.Session)
	if err != nil || session == nil || session.Cookies[sana.SessionCookie] == "" {
		fmt.Fprintln(options.Stderr, "sana-mcp: not signed in; run sana-mcp login")
		return 1
	}
	client := sana.New(os.Getenv("SANA_BASE_URL"), session)
	metadata, err := client.Meeting(ctx, command.Args[0])
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	for _, candidate := range []*string{metadata.RecordingURL, metadata.FallbackRecordingURL} {
		if candidate != nil && *candidate != "" {
			fmt.Fprintln(options.Stdout, *candidate)
			return 0
		}
	}
	fmt.Fprintln(options.Stdout, "This meeting has no recording.")
	return 0
}

// runLogin walks the two-step passwordless sign-in.
func runLogin(ctx context.Context, runtime *bootstrap.Runtime, command Command, options Options) int {
	reader := bufio.NewReader(options.Stdin)
	email := ""
	if len(command.Args) > 0 {
		email = command.Args[0]
	}
	if email == "" {
		fmt.Fprint(options.Stdout, "Email: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			return 1
		}
		email = strings.TrimSpace(line)
	}
	if email == "" {
		fmt.Fprintln(options.Stderr, "sana-mcp: an email address is required")
		return 2
	}

	client := sana.New(os.Getenv("SANA_BASE_URL"), nil)
	pending, err := client.RequestSignInCode(ctx, email)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprintf(options.Stdout, "A sign-in code was emailed to %s.\n", pending.Email)
	fmt.Fprint(options.Stdout, "Code: ")
	line, err := reader.ReadString('\n')
	if err != nil {
		return 1
	}
	user, err := client.SubmitSignInCode(ctx, pending, strings.TrimSpace(line))
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if err := sana.SaveSession(runtime.Paths.Session, sana.SessionFrom(client, user)); err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprintf(options.Stdout, "Signed in as %s.\nSync starts with the daemon; check sana-mcp status.\n", user.Email)
	return 0
}

func clock(ms int64) string {
	seconds := ms / 1000
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}
