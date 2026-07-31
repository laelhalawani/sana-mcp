package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

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
		// helpText already words this, and it is one agent-facing sentence.
		return textResult(helpText(input.Tool)), nil, nil
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

// storeHandler is a handler that needs the local database. withStore opens and
// closes it, so nine handlers do not each repeat that and none can forget the
// close.
type storeHandler func(context.Context, *store.Store, json.RawMessage) (string, error)

func withStore(handler storeHandler) handlerFunc {
	return func(ctx context.Context, service *Service, raw json.RawMessage) (string, error) {
		database, err := service.openStore()
		if err != nil {
			return "", err
		}
		defer database.Close()
		return handler(ctx, database, raw)
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
