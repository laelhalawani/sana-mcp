package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Description is what a model reads before choosing this tool. It names every
// sub-tool, because a model that cannot see the list will guess.
const Description = `Read and search your Sana.AI meeting transcripts, synced locally.

Pass a tool name and its args:

  help          {tool?}                                   this list, or one tool's schema
  login         {email} then {email, confirmation_code}   passwordless sign-in by email code
  status        {}                                        sync progress and coverage
  list          {page?, limit?, query?, sort?, filter?}   meetings: id, timestamp, title, status
  read          {meeting_id, full?, lines?, timestamps?}  transcript lines, all or a [start,end] range
  search        {query, page?, limit?, sort?, filter?}    matching lines with meeting id and line number
  summary       {meeting_id}                              summary, notes by topic, action items
  participants  {meeting_id}                              attendees
  recording     {meeting_id}                              a temporary recording link, fetched live

Transcripts come from speech recognition and contain errors. These correct them:

  edit_line     {meeting_id, line, expected_text, new_text}   replace one line
  line_history  {meeting_id, line?}                           what was changed, original and current
  restore_line  {meeting_id, line}                            put a line back to what Sana delivered

NEVER edit a transcript unless the user has explicitly asked for that specific
correction. Meetings are full of product names, company names and personal names
that look like misspellings and are not: "Zenolith", "Fabrix", "Vantik" are real.
A rare word being unfamiliar to you is not evidence that it is wrong. Ask first.`

// toolInput is the one argument shape every call uses.
//
// Args is a map rather than json.RawMessage because the SDK derives the tool's
// JSON schema from these types, and a []byte is described as an array - which
// makes every well-formed object call fail validation.
type toolInput struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args,omitempty"`
}

func (s *Service) registerTool() {
	mcp.AddTool(s.server, &mcp.Tool{
		Name:        toolName,
		Description: Description,
	}, s.dispatch)
}

// dispatch routes one call to its handler.
func (s *Service) dispatch(ctx context.Context, _ *mcp.CallToolRequest, input toolInput) (*mcp.CallToolResult, any, error) {
	name := strings.TrimSpace(strings.ToLower(input.Tool))
	if name == "" {
		return textResult(helpText("")), nil, nil
	}
	handler, known := handlers[name]
	if !known {
		return textResult(fmt.Sprintf(
			"Unknown tool %q.\n\n%s", input.Tool, helpText(""))), nil, nil
	}
	var raw json.RawMessage
	if len(input.Args) > 0 {
		encoded, err := json.Marshal(input.Args)
		if err != nil {
			return textResult(fmt.Sprintf("args could not be read: %v", err)), nil, nil
		}
		raw = encoded
	}
	text, err := handler(ctx, s, raw)
	if err != nil {
		// A failure is reported to the model as text with a next step, not as a
		// protocol error: the model can act on the former.
		return textResult(err.Error()), nil, nil
	}
	return textResult(text), nil, nil
}

type handlerFunc func(context.Context, *Service, json.RawMessage) (string, error)

var handlers map[string]handlerFunc

func init() {
	// Assigned in init because the handlers refer to helpText, which reads this
	// map: a direct initialisation would be a cycle.
	handlers = map[string]handlerFunc{
		"help":         handleHelp,
		"status":       handleStatus,
		"list":         handleList,
		"read":         handleRead,
		"search":       handleSearch,
		"summary":      handleSummary,
		"participants": handleParticipants,
		"recording":    handleRecording,
		"login":        handleLogin,
		"edit_line":    handleEditLine,
		"line_history": handleLineHistory,
		"restore_line": handleRestoreLine,
	}
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}
}

// decode unpacks a handler's arguments. Absent args are an empty object, so a
// tool with only optional arguments can be called with none.
func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("args were not valid for this tool: %v", err)
	}
	return nil
}
