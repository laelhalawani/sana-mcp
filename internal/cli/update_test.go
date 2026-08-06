package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateIsAKnownCommand(t *testing.T) {
	command, err := Parse([]string{"update"})
	if err != nil {
		t.Fatalf("update must parse: %v", err)
	}
	if command.Name != "update" {
		t.Fatalf("parsed as %q", command.Name)
	}
	if !strings.Contains(Usage, "sana-mcp update") {
		t.Fatal("update must be in the usage text; it is the only place the command set is written out")
	}
}

// Updating must work without local state. A machine whose database this build
// cannot open is one of the reasons to be updating, so requiring a runtime
// would refuse exactly when it is needed.
func TestUpdateDoesNotNeedARuntime(t *testing.T) {
	// A URL that cannot resolve, so nothing is installed by the test. What is
	// being asserted is which branch it takes: "needs local state" would mean
	// the command never ran at all.
	// Point at a port nothing listens on, so the real installer is never
	// fetched and never run against the machine running the test.
	t.Setenv("SANA_INSTALL_BASE_URL", "http://127.0.0.1:1/")
	var out, errOut bytes.Buffer
	code := Run(context.Background(), nil, Command{Name: "update"}, Options{
		Stdout: &out, Stderr: &errOut,
	})
	if code == 0 {
		t.Fatal("an unreachable installer must fail")
	}
	if strings.Contains(errOut.String(), "needs local state") {
		t.Fatalf("update was refused for want of a runtime: %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "could not download") {
		t.Fatalf("the failure should name the download: %q", errOut.String())
	}
}

func TestDownloadScriptRejectsAnEmptyOrMissingScript(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"not found", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}},
		{"empty body", func(w http.ResponseWriter, r *http.Request) {}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(testCase.handler)
			defer server.Close()
			// A truncated or missing installer must never be handed to a shell.
			if _, err := downloadScript(
				context.Background(), server.URL, "install.sh"); err == nil {
				t.Fatal("expected an error rather than a script to run")
			}
		})
	}
}

func TestDownloadScriptWritesAnExecutableFile(t *testing.T) {
	const body = "#!/bin/sh\necho installed\n"
	server := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(body))
		}))
	defer server.Close()

	path, err := downloadScript(context.Background(), server.URL, "install.sh")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(path))

	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(stored) != body {
		t.Fatalf("script was altered in transit: %q", stored)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("the installer must be executable, mode is %v", info.Mode().Perm())
	}
}
