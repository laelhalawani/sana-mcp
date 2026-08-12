package cli

import (
	"bufio"
	"context"
	"errors"

	"fmt"
	"strconv"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/render"
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
		// An unreadable database is not something a person can guess their way
		// out of, and every command hits it, so the way out is printed here
		// rather than left to be discovered.
		if errors.Is(err, store.ErrForeignSchema) {
			fmt.Fprintf(options.Stderr,
				"Run sana-mcp install to replace it, or remove %s and sync again.\n",
				runtime.Paths.Root)
		}
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
	fmt.Fprintf(options.Stdout, "%s\n", render.StatusLabel(status))
	fmt.Fprint(options.Stdout, render.StatusLines(status))
	return 0
}

func runList(database *store.Store, command Command, options Options) int {
	query := strings.Join(command.Args, " ")
	meetings, total, err := database.ListMeetings(store.ListOptions{Query: query})
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
			render.Timestamp(meeting.CreatedMS),
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
	// Asked of the whole transcript, not of the range about to be read: a window
	// past the end returns nothing and would otherwise be reported as a meeting
	// whose transcript is empty, which is false and contradicts the MCP surface.
	// It also comes first, so the range query is not run to be thrown away.
	count, err := database.LineCount(meetingID)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if count == 0 {
		if meeting.TranscriptState != store.TranscriptComplete {
			fmt.Fprintf(options.Stdout, "%s has no transcript stored yet (status: %s).\n",
				meeting.Title, meeting.Status)
			return 0
		}
		fmt.Fprintf(options.Stdout, "%s has a transcript with no lines.\n", meeting.Title)
		return 0
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
		fmt.Fprintln(options.Stdout, render.TranscriptLine(line, true))
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
		fmt.Fprint(options.Stdout, render.NoMatches(query))
		return 0
	}
	fmt.Fprintf(options.Stdout, "%d results for %q\n\n", len(hits), query)
	fmt.Fprint(options.Stdout, render.SearchHits(hits))
	return 0
}

func runDocument(database *store.Store, command Command, options Options) int {
	if len(command.Args) == 0 {
		fmt.Fprintf(options.Stderr, "sana-mcp: %s needs a meeting id\n", command.Name)
		return 2
	}
	// These are rendered rather than dumped. The stored documents are the raw
	// JSON Sana returned, which is the right thing to keep but the wrong thing
	// to show a person at a terminal.
	if command.Name == "summary" {
		metadata, err := database.Summary(command.Args[0])
		if errors.Is(err, store.ErrNotFound) {
			if _, err := database.GetMeeting(command.Args[0]); err != nil {
				fmt.Fprintln(options.Stderr, "sana-mcp:", err)
				return 1
			}
			fmt.Fprintln(options.Stdout, render.SummaryNotDownloaded)
			return 0
		}
		if err != nil {
			fmt.Fprintln(options.Stderr, "sana-mcp:", err)
			return 1
		}
		fmt.Fprint(options.Stdout, render.Summary(metadata, render.Styles{}))
		return 0
	}
	// The roster is asked for on its own: sharing a decode with the summary
	// meant an unreadable summary discarded a readable roster and the speakers
	// with it.
	participants, metadataErr := database.Participants(command.Args[0])
	// A meeting that is not stored at all is the only "not found" here; a
	// document that has not arrived yet is reported as exactly that. The row
	// also carries whether the transcript was fetched, which is a fact to read
	// rather than infer from a line count - an empty transcript is downloaded.
	meeting, err := database.GetMeeting(command.Args[0])
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	speakers, err := database.Speakers(command.Args[0])
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	fmt.Fprint(options.Stdout, render.Attendance(participants, metadataErr,
		speakers, meeting.TranscriptState == store.TranscriptComplete, render.Styles{}))
	return 0
}

func runRecording(ctx context.Context, runtime *bootstrap.Runtime, command Command, options Options) int {
	if len(command.Args) == 0 {
		fmt.Fprintln(options.Stderr, "sana-mcp: recording needs a meeting id")
		return 2
	}
	session, err := sana.LoadSession(runtime.Paths.Session)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	link, err := sana.RecordingLink(ctx, session, command.Args[0])
	if errors.Is(err, sana.ErrUnauthorized) {
		fmt.Fprintln(options.Stderr, "sana-mcp: not signed in; run sana-mcp login")
		return 1
	}
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp:", err)
		return 1
	}
	if link == "" {
		fmt.Fprintln(options.Stdout, "This meeting has no recording.")
		return 0
	}
	fmt.Fprintln(options.Stdout, link)
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

	client := sana.New("", nil)
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
