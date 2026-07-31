// Package sana talks to Sana.AI: sign-in, the meeting list, transcripts,
// meeting metadata, and participants.
//
// The remote surface is tRPC under /x-api/trpc. Queries put their input in a
// url-encoded `input` query parameter and mutations post it as a JSON body;
// both answer with a {"result":{"data":...}} envelope. Nothing outside this
// package should know that.
package sana

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultBaseURL is the Sana origin. SANA_BASE_URL overrides it for testing
// against a fake server.
const DefaultBaseURL = "https://sana.ai"

// SessionCookie is the name of the cookie that carries the signed-in session.
const SessionCookie = "sana-ai-session"

// ErrUnauthorized means the stored session is absent, expired, or rejected. It
// is the one error the daemon must translate into "sign in required" rather
// than retrying.
var ErrUnauthorized = errors.New("sana session is not valid; sign in again")

// Client is an authenticated Sana client.
type Client struct {
	baseURL string
	http    *http.Client
	session *Session
	// workspaceID is sent with every data call. Sana rejects them without it,
	// so it is taken from the stored session and refreshed by Me.
	workspaceID string
}

// New builds a client for a session. A nil session is allowed: sign-in starts
// without one.
func New(baseURL string, session *Session) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	workspaceID := ""
	if session != nil {
		workspaceID = session.WorkspaceID
	}
	return &Client{
		baseURL:     strings.TrimRight(baseURL, "/"),
		session:     session,
		workspaceID: workspaceID,
		http: &http.Client{
			Timeout: 60 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				// Credentials must never follow a redirect off the configured
				// origin, so cross-origin hops are refused rather than trusted.
				if req.URL.Host != via[0].URL.Host {
					return fmt.Errorf("refusing cross-origin redirect to %s", req.URL.Host)
				}
				return nil
			},
		},
	}
}

// Session is the persisted sign-in state.
type Session struct {
	Cookies     map[string]string `json:"cookies"`
	UserID      string            `json:"userId"`
	WorkspaceID string            `json:"workspaceId"`
	Email       string            `json:"email"`
}

// HasCookie reports whether a session cookie is present.
func (c *Client) HasCookie() bool {
	return c.session != nil && c.session.Cookies[SessionCookie] != ""
}

func (c *Client) request(ctx context.Context, method, endpoint string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("user-agent", "sana-mcp")
	if c.workspaceID != "" {
		request.Header.Set("sana-ai-workspace-id", c.workspaceID)
	}
	if c.session != nil {
		for name, value := range c.session.Cookies {
			request.AddCookie(&http.Cookie{Name: name, Value: value})
		}
	}
	return request, nil
}

// trpcQuery calls a tRPC query procedure and decodes result.data into out.
func (c *Client) trpcQuery(ctx context.Context, procedure string, input any, out any) error {
	endpoint := c.baseURL + "/x-api/trpc/" + procedure
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		endpoint += "?input=" + url.QueryEscape(string(encoded))
	}
	request, err := c.request(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	return c.do(request, procedure, out)
}

func (c *Client) do(request *http.Request, procedure string, out any) error {
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("%s: %w", procedure, err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%s: %w", procedure, ErrUnauthorized)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%s: sana returned %s", procedure, response.Status)
	}

	// The body is read whole: these responses are small, and a streaming decode
	// would make a truncated body look like a schema mismatch.
	payload, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("%s: %w", procedure, err)
	}
	var envelope struct {
		Result struct {
			Data json.RawMessage `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("%s: response was not JSON: %w", procedure, err)
	}
	if len(envelope.Result.Data) == 0 {
		return fmt.Errorf("%s: response carried no result.data envelope", procedure)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(envelope.Result.Data, out); err != nil {
		return fmt.Errorf("%s: unexpected response shape: %w", procedure, err)
	}
	return nil
}

// User is the signed-in identity.
type User struct {
	ID                  string `json:"id"`
	Email               string `json:"email"`
	LastUsedWorkspaceID string `json:"lastUsedWorkspaceId"`
	// WorkspaceID is the workspace this client will route to. It is resolved by
	// Me rather than sent by Sana under this name.
	WorkspaceID string `json:"-"`
}

// Me returns the signed-in user, and is the cheapest way to test a session.
//
// The active workspace wins when Sana supplies one; the user's last-used
// workspace is the routing identity when it does not. A session with neither is
// unusable, because every data call needs a workspace.
func (c *Client) Me(ctx context.Context) (User, error) {
	var payload struct {
		User      User `json:"user"`
		Workspace *struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	if err := c.trpcQuery(ctx, "user.me", nil, &payload); err != nil {
		return User{}, err
	}
	user := payload.User
	switch {
	case payload.Workspace != nil && payload.Workspace.ID != "":
		user.WorkspaceID = payload.Workspace.ID
	case user.LastUsedWorkspaceID != "":
		user.WorkspaceID = user.LastUsedWorkspaceID
	default:
		return User{}, errors.New("user.me: sana did not report a usable workspace")
	}
	c.workspaceID = user.WorkspaceID
	return user, nil
}

// MeetingSummary is one row of the meeting list.
type MeetingSummary struct {
	ID              string  `json:"id"`
	ExternalID      *string `json:"externalId"`
	Name            string  `json:"name"`
	CreatedAtMS     float64 `json:"createdAtEpochMs"`
	Source          string  `json:"source"`
	ProcessingPhase *string `json:"processingPhase"`
}

// ListMeetings returns one page of meetings, newest first, plus the cursor for
// the next page.
func (c *Client) ListMeetings(ctx context.Context, cursor *float64) ([]MeetingSummary, *float64, error) {
	input := map[string]any{
		"assetSourceTypes": []string{"sana-ai:meeting"},
		"direction":        "forward",
	}
	if cursor != nil {
		input["cursor"] = *cursor
	}
	var page struct {
		Assets     []MeetingSummary `json:"assets"`
		NextCursor *float64         `json:"nextCursor"`
	}
	if err := c.trpcQuery(ctx, "asset.listRecent", input, &page); err != nil {
		return nil, nil, err
	}
	return page.Assets, page.NextCursor, nil
}

// WalkMeetings walks pages newest-first until onPage returns false or the
// server runs out. The daemon uses the early stop once it reaches meetings it
// already holds.
func (c *Client) WalkMeetings(ctx context.Context, onPage func([]MeetingSummary) bool) error {
	var cursor *float64
	seen := map[float64]bool{}
	for guard := 0; guard < 5000; guard++ {
		assets, next, err := c.ListMeetings(ctx, cursor)
		if err != nil {
			return err
		}
		if !onPage(assets) {
			return nil
		}
		if len(assets) == 0 || next == nil {
			return nil
		}
		if seen[*next] {
			return errors.New("asset.listRecent: pagination cursor repeated")
		}
		seen[*next] = true
		cursor = next
	}
	return errors.New("asset.listRecent: pagination exceeded its safety bound")
}

// Word is one transcribed word with its timing.
type Word struct {
	Text           string  `json:"text"`
	StartTimestamp float64 `json:"start_timestamp"`
	EndTimestamp   float64 `json:"end_timestamp"`
}

// Segment is one speaker turn.
type Segment struct {
	Language string `json:"language"`
	Speaker  string `json:"speaker"`
	Words    []Word `json:"words"`
}

// Transcript returns the segments of a meeting's transcript.
func (c *Client) Transcript(ctx context.Context, assetID string) ([]Segment, error) {
	var segments []Segment
	if err := c.trpcQuery(ctx, "meeting.getTranscription", map[string]any{"assetId": assetID}, &segments); err != nil {
		return nil, err
	}
	return segments, nil
}

// NoteGroup is one topic of the meeting notes.
type NoteGroup struct {
	Topic string   `json:"topic"`
	Notes []string `json:"notes"`
}

// ActionItem is one action recorded for a meeting.
type ActionItem struct {
	AssignedTo *string `json:"assignedTo"`
	Action     string  `json:"action"`
	DueDate    *string `json:"dueDate"`
}

// Metadata is the rich per-meeting document: summary, notes, actions, and the
// recording links.
type Metadata struct {
	Summary              *string      `json:"summary"`
	SummaryShort         *string      `json:"summaryShort"`
	Notes                []NoteGroup  `json:"notes"`
	ActionItems          []ActionItem `json:"actionItems"`
	RecordingURL         *string      `json:"recordingUrl"`
	FallbackRecordingURL *string      `json:"fallbackRecordingUrl"`
}

// Meeting returns a meeting's metadata.
func (c *Client) Meeting(ctx context.Context, assetID string) (Metadata, error) {
	var metadata Metadata
	if err := c.trpcQuery(ctx, "meeting.getById", map[string]any{"assetId": assetID}, &metadata); err != nil {
		return Metadata{}, err
	}
	return metadata, nil
}

// Participant is one attendee.
type Participant struct {
	ID          string  `json:"id"`
	Email       *string `json:"email"`
	DisplayName string  `json:"displayName"`
	IsHost      bool    `json:"isHost"`
}

// Participants returns a meeting's attendees.
func (c *Client) Participants(ctx context.Context, assetID string) ([]Participant, error) {
	var participants []Participant
	err := c.trpcQuery(ctx, "meeting.getMeetingParticipants", map[string]any{"assetId": assetID}, &participants)
	if err != nil {
		return nil, err
	}
	return participants, nil
}
