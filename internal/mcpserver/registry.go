package mcpserver

import (
	"fmt"
	"sort"
	"strings"
)

// tool is one entry of the agent-facing surface.
//
// The name, its argument shape, its one-line purpose, and its handler live in
// one row. They used to live in three hand-synced lists - the tool description
// prose, a schema map, and a handler map - and had drifted twice: the
// description advertised a search filter the handler ignored, and a meeting
// status nothing ever writes.
type tool struct {
	name    string
	args    string
	purpose string
	handler handlerFunc
	// writes marks the tools that change a transcript, which the description
	// groups separately because they carry a warning.
	writes bool
}

// tools is the single registry. Order here is the order a model reads.
//
// It is populated in init rather than in the declaration because helpText reads
// this slice and handleHelp calls helpText, which the compiler sees as an
// initialisation cycle when the handlers are named in the literal.
var tools []tool

func init() {
	tools = []tool{
		{"help", `{tool?}`, "this list, or one tool's schema", handleHelp, false},
		{"login", `{email} then {email, confirmation_code}`, "passwordless sign-in by email code", handleLogin, false},
		{"status", `{}`, "sync progress and coverage", withStore(handleStatus), false},
		{"list", `{page?, limit?, query?, sort?, filter?}`, "meetings: id, timestamp, title, status", withStore(handleList), false},
		{"read", `{meeting_id, full?, lines?, timestamps?}`, "transcript lines, all or a [start,end] range", withStore(handleRead), false},
		{"search", `{query, page?, limit?, sort?}`, "matching lines with meeting id and line number", withStore(handleSearch), false},
		{"summary", `{meeting_id}`, "summary, notes by topic, action items", withStore(handleSummary), false},
		{"participants", `{meeting_id}`, "attendees", withStore(handleParticipants), false},
		{"recording", `{meeting_id}`, "a temporary recording link, fetched live", handleRecording, false},
		{"edit_line", `{meeting_id, line, expected_text, new_text, occurrences?}`, "replace text within one line", withStore(handleEditLine), true},
		{"line_history", `{meeting_id, line?}`, "what was changed, original and current", withStore(handleLineHistory), true},
		{"restore_line", `{meeting_id, line}`, "put a line back to what Sana delivered", withStore(handleRestoreLine), true},
	}
	handlers = make(map[string]handlerFunc, len(tools))
	for _, entry := range tools {
		handlers[entry.name] = entry.handler
	}
	Description = buildDescription()
}

// handlers indexes the registry by name for dispatch.
var handlers map[string]handlerFunc

// schemaFor returns a tool's argument shape, and whether it is a known tool.
func schemaFor(name string) (string, bool) {
	for _, entry := range tools {
		if entry.name == name {
			return entry.args, true
		}
	}
	return "", false
}

// Description is what a model reads before choosing this tool. It is generated
// from the registry, so a tool cannot be added without appearing here.
var Description string

func buildDescription() string {
	var out strings.Builder
	out.WriteString("Read and search your Sana.AI meeting transcripts, synced locally.\n\n")
	out.WriteString("Pass a tool name and its args:\n\n")
	out.WriteString(toolTable(false))
	out.WriteString("\nTranscripts come from speech recognition and contain errors. " +
		"These correct them:\n\n")
	out.WriteString(toolTable(true))
	out.WriteString(`
edit_line replaces a fragment, not the whole line. expected_text is the text to
replace exactly as it currently reads; occurrences is how many times you expect
it to appear in that line, and defaults to 1. The edit only runs if the count
matches, so a fragment that also appears somewhere you have not looked fails
rather than changing both. Read the line first and count.

NEVER edit a transcript unless the user has explicitly asked for that specific
correction. Meetings are full of product names, company names and personal names
that look like misspellings and are not: "Zenolith", "Fabrix", "Vantik" are real.
A rare word being unfamiliar to you is not evidence that it is wrong. Ask first.`)
	return out.String()
}

// toolTable renders one group of the registry as an aligned block.
func toolTable(writes bool) string {
	nameWidth, argsWidth := 0, 0
	for _, entry := range tools {
		if entry.writes != writes {
			continue
		}
		nameWidth = max(nameWidth, len(entry.name))
		argsWidth = max(argsWidth, len(entry.args))
	}
	var out strings.Builder
	for _, entry := range tools {
		if entry.writes != writes {
			continue
		}
		fmt.Fprintf(&out, "  %-*s  %-*s  %s\n", nameWidth, entry.name, argsWidth, entry.args, entry.purpose)
	}
	return out.String()
}

// helpText renders the `help` tool's answer from the same registry.
func helpText(name string) string {
	if name != "" {
		schema, known := schemaFor(strings.ToLower(name))
		if !known {
			return fmt.Sprintf("Unknown tool %q.\n\n%s", name, helpText(""))
		}
		return fmt.Sprintf("%s\n  args: %s", name, schema)
	}
	names := make([]string, 0, len(tools))
	widest := 0
	for _, entry := range tools {
		names = append(names, entry.name)
		widest = max(widest, len(entry.name))
	}
	sort.Strings(names)

	var out strings.Builder
	out.WriteString("meeting_transcripts tools:\n")
	for _, name := range names {
		schema, _ := schemaFor(name)
		fmt.Fprintf(&out, "  %-*s %s\n", widest, name, schema)
	}
	return out.String()
}
