package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Updating in place.
//
// The install scripts already know how to replace a running binary on each
// platform - stopping the daemon first, downloading beside the target, and
// swapping only once the bytes are on disk. Reimplementing that here would mean
// two implementations of the delicate part, which would drift. So `update`
// fetches the same script the install one-liner uses and runs it.
//
// The script is downloaded to a file and then run, rather than piped straight
// into a shell. Piping means a truncated download is executed as far as it got,
// and it makes a download failure look like a script failure. On disk, a failed
// download is reported as one and nothing runs.

// installScriptBase is where the release publishes the installers.
//
// SANA_INSTALL_BASE_URL overrides it, matching SANA_BASE_URL in the sana
// package. Without an override a test of this command downloads and runs the
// real installer against the machine running the test, which is not a thing a
// test may do - found the hard way.
const installScriptBase = "https://github.com/laelhalawani/sana-mcp/releases/latest/download/"

func installScriptURL(name string) string {
	base := os.Getenv("SANA_INSTALL_BASE_URL")
	if base == "" {
		base = installScriptBase
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return base + name
}

// runUpdate downloads the current install script for this platform and runs it.
func runUpdate(ctx context.Context, options Options) int {
	script := "install.sh"
	if runtime.GOOS == "windows" {
		script = "install.ps1"
	}
	url := installScriptURL(script)

	fmt.Fprintf(options.Stdout, "Fetching the latest installer from %s\n", url)
	path, err := downloadScript(ctx, url, script)
	if err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp: could not download the installer:", err)
		return 1
	}
	// The script is this process's replacement arriving; it is not wanted after
	// it has run, whether it succeeded or not. The directory goes with it, or
	// every update leaves one behind.
	defer os.RemoveAll(filepath.Dir(path))

	command := updateCommand(ctx, path)
	// The installer is interactive at the end - it offers to configure AI
	// clients - so it inherits this terminal rather than having its output
	// captured. Capturing it would hang on a prompt nobody can see.
	command.Stdin = options.Stdin
	command.Stdout = options.Stdout
	command.Stderr = options.Stderr
	if err := command.Run(); err != nil {
		fmt.Fprintln(options.Stderr, "sana-mcp: the installer did not complete:", err)
		return 1
	}
	return 0
}

// updateCommand is how each platform runs its installer.
func updateCommand(ctx context.Context, path string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		// -ExecutionPolicy Bypass because the file was just downloaded, and the
		// machine's policy is about scripts the user did not ask for. This one
		// was asked for by name.
		return exec.CommandContext(ctx, "powershell", "-NoProfile",
			"-ExecutionPolicy", "Bypass", "-File", path)
	}
	return exec.CommandContext(ctx, "sh", path)
}

// downloadScript writes the installer to a temporary file and returns its path.
func downloadScript(ctx context.Context, url, name string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 60 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("%s returned %s", url, response.Status)
	}

	directory, err := os.MkdirTemp("", "sana-mcp-update-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		os.RemoveAll(directory)
		return "", err
	}
	// An installer is small; the limit is there so a wrong URL answering with
	// something enormous cannot fill the disk.
	if _, err := io.Copy(file, io.LimitReader(response.Body, 4<<20)); err != nil {
		file.Close()
		os.RemoveAll(directory)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.RemoveAll(directory)
		return "", err
	}
	if info, err := os.Stat(path); err != nil || info.Size() == 0 {
		os.RemoveAll(directory)
		return "", fmt.Errorf("%s was empty", url)
	}
	return path, nil
}
