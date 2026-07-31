package sana

import (
	"encoding/json"
	"errors"
	"os"

	"github.com/laelhalawani/sana-mcp/internal/fsx"
)

// LoadSession reads the persisted session. A missing file is not an error: it
// simply means nobody has signed in yet.
func LoadSession(path string) (*Session, error) {
	payload, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(payload, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

// SaveSession writes the session atomically and privately. It carries the
// cookie that grants access to a person's meetings, so it is written 0600 and
// replaced by rename rather than truncated in place.
func SaveSession(path string, session *Session) error {
	payload, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, payload, 0o600)
}

// SignedIn reports whether this session can authenticate. A nil session is not
// signed in, which lets every caller ask the same question the same way instead
// of spelling out the nil-and-cookie check themselves.
func (s *Session) SignedIn() bool {
	return s != nil && s.Cookies[SessionCookie] != ""
}

// SessionFrom captures the client's current cookies and identity for storage.
func SessionFrom(client *Client, user User) *Session {
	return &Session{
		Cookies:     client.Cookies(),
		UserID:      user.ID,
		WorkspaceID: user.WorkspaceID,
		Email:       user.Email,
	}
}
