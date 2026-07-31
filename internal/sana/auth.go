package sana

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ErrNoPendingSignIn means SubmitSignInCode was called without a matching
// RequestSignInCode, so there is no CSRF token to submit the code with.
var ErrNoPendingSignIn = errors.New("no pending sign-in for this email; request a code first")

// ErrSignInRejected means Sana refused the code.
var ErrSignInRejected = errors.New("sana rejected this sign-in code")

// PendingSignIn is what the caller must carry between the two sign-in steps.
// It holds no secret beyond the CSRF token, which is useless without the
// emailed code.
type PendingSignIn struct {
	Email     string `json:"email"`
	CSRFToken string `json:"csrfToken"`
}

// NormalizeEmail trims and lowercases an address so that the two sign-in steps
// agree about who is signing in.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// RequestSignInCode asks Sana to email a sign-in code. It returns the pending
// challenge, which SubmitSignInCode needs.
func (c *Client) RequestSignInCode(ctx context.Context, email string) (PendingSignIn, error) {
	normalized := NormalizeEmail(email)
	if normalized == "" || !strings.Contains(normalized, "@") {
		return PendingSignIn{}, errors.New("a valid email address is required")
	}

	csrfToken, err := c.csrfToken(ctx)
	if err != nil {
		return PendingSignIn{}, err
	}

	body := map[string]string{"email": normalized}
	if c.workspaceID != "" {
		body["loginViaWorkspaceId"] = c.workspaceID
	}
	if err := c.trpcMutation(ctx, "user.sendSignInLink", body, nil); err != nil {
		return PendingSignIn{}, err
	}
	return PendingSignIn{Email: normalized, CSRFToken: csrfToken}, nil
}

// SubmitSignInCode exchanges the emailed code for a session.
//
// The existing session cookie is cleared first, so a code that Sana refuses
// cannot leave the caller believing the old session is the new one: a valid
// sign-in is proven by a *newly issued* cookie plus an identity that matches the
// address the code was sent to.
func (c *Client) SubmitSignInCode(ctx context.Context, pending PendingSignIn, code string) (User, error) {
	normalized := NormalizeEmail(pending.Email)
	if pending.CSRFToken == "" || normalized == "" {
		return User{}, ErrNoPendingSignIn
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return User{}, errors.New("a sign-in code is required")
	}

	c.clearAuthCookie()

	endpoint, err := url.Parse(c.baseURL + "/x-api/auth/magic-link")
	if err != nil {
		return User{}, err
	}
	query := endpoint.Query()
	query.Set("email", normalized)
	query.Set("csrfToken", pending.CSRFToken)
	query.Set("code", code)
	endpoint.RawQuery = query.Encode()

	request, err := c.request(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return User{}, err
	}
	request.Header.Set("accept", "text/html,application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return User{}, fmt.Errorf("auth.magic-link: %w", err)
	}
	io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	response.Body.Close()

	if !c.hasAuthCookie() {
		return User{}, ErrSignInRejected
	}
	user, err := c.Me(ctx)
	if err != nil {
		return User{}, err
	}
	if NormalizeEmail(user.Email) != normalized {
		return User{}, fmt.Errorf("%w: session belongs to a different account", ErrSignInRejected)
	}
	return user, nil
}

// csrfToken fetches the token the sign-in link exchange requires.
func (c *Client) csrfToken(ctx context.Context) (string, error) {
	request, err := c.request(ctx, http.MethodGet, c.baseURL+"/x-api/auth/csrf-token", nil)
	if err != nil {
		return "", err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("auth.csrf-token: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("auth.csrf-token: sana returned %s", response.Status)
	}
	var payload struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return "", fmt.Errorf("auth.csrf-token: %w", err)
	}
	if payload.CSRFToken == "" {
		return "", errors.New("auth.csrf-token: sana returned no token")
	}
	return payload.CSRFToken, nil
}

// clearAuthCookie expires the session cookie in the jar.
func (c *Client) clearAuthCookie() {
	base, err := url.Parse(c.baseURL)
	if err != nil {
		return
	}
	c.http.Jar.SetCookies(base, []*http.Cookie{{
		Name: SessionCookie, Value: "", Path: "/", MaxAge: -1,
	}})
}

// trpcMutation posts input to a tRPC procedure. out may be nil when the
// response carries nothing the caller needs.
func (c *Client) trpcMutation(ctx context.Context, procedure string, input any, out any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := c.request(ctx, http.MethodPost, c.baseURL+"/x-api/trpc/"+procedure, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	return c.do(request, procedure, out)
}
