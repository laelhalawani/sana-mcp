package sana

import "testing"

func TestSessionAccessorsSurviveNoSession(t *testing.T) {
	// LoadSession returns a nil session for a machine that has never signed
	// in, which is every machine on its first run.
	var absent *Session
	if absent.SignedIn() {
		t.Fatal("a missing session is not signed in")
	}
	if got := absent.Address(); got != "" {
		t.Fatalf("Address = %q, want empty", got)
	}
	present := &Session{Cookies: map[string]string{SessionCookie: "x"}, Email: "a@b.c"}
	if !present.SignedIn() || present.Address() != "a@b.c" {
		t.Fatal("a stored session must report itself")
	}
}
