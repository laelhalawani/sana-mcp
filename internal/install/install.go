// Package install registers the MCP server with the AI harnesses on this
// machine, and owns the settings flow shared by the installer and the
// interactive application.
//
// Detection and config writing are detect-harness's job. This package decides
// what to show, what to ask, and what to do with the answers.
package install

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	detectharness "github.com/sairaph/detect-harness"
)

// ServerName is the entry name written into every harness configuration.
const ServerName = "sana-mcp"

// ErrCancelled is returned when the user aborts an interactive flow.
var ErrCancelled = errors.New("cancelled")

// Harness is one detected AI client, in the shape the UI needs.
type Harness struct {
	ID   detectharness.ID
	Name string
	// State is present, absent, or unavailable. Unavailable stays distinct from
	// absent so a permission error is never reported as "not installed".
	State       detectharness.DetectionState
	Configured  bool
	ConfigPath  string
	ConfigError string
	ReloadHint  string
}

// Selectable reports whether the user may toggle this harness. An environment
// that could not be inspected is shown but cannot be chosen, because writing to
// it would be guesswork.
func (h Harness) Selectable() bool {
	return h.State != detectharness.Unavailable && h.ConfigError == ""
}

// StatusText renders the harness state for a person, in at most two words.
func (h Harness) StatusText() string {
	switch {
	case h.Configured:
		return "configured"
	case h.State == detectharness.Detected:
		return "detected"
	default:
		return "not detected"
	}
}

// Installer wraps detect-harness with this project's server definition.
type Installer struct {
	installer *detectharness.Installer
}

// NewInstaller builds an installer that registers this binary.
func NewInstaller(runtime *bootstrap.Runtime) (*Installer, error) {
	executable := runtime.Executable
	if executable == "" {
		resolved, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("resolve this binary: %w", err)
		}
		executable = resolved
	}
	// The registered command runs the MCP server explicitly rather than relying
	// on the bare-invocation fallback, so a harness that allocates a TTY still
	// gets a server rather than the interactive application.
	inner, err := detectharness.New(detectharness.StdioServer{
		Name:    ServerName,
		Command: executable,
		Args:    []string{"mcp"},
	})
	if err != nil {
		return nil, err
	}
	return &Installer{installer: inner}, nil
}

// Detect probes the machine and returns the harnesses worth showing, detected
// and configured ones first, then the rest alphabetically.
//
// Whether a harness is already configured is answered by planning the
// registration and seeing which harnesses report no work to do. Detecting a
// config file only proves the client exists, not that this server is in it.
func (i *Installer) Detect(ctx context.Context) []Harness {
	detections := i.installer.Detect(ctx)

	ids := make([]detectharness.ID, 0, len(detections))
	for _, detection := range detections {
		ids = append(ids, detection.ID)
	}
	registered := map[detectharness.ID]bool{}
	if plan := i.installer.Plan(ctx, ids, detectharness.Present, detectharness.PlanOptions{}); plan != nil {
		for _, change := range plan.Changes() {
			registered[change.HarnessID] = change.State == detectharness.ChangeNoop
		}
	}

	harnesses := make([]Harness, 0, len(detections))
	for _, detection := range detections {
		harnesses = append(harnesses, Harness{
			ID:          detection.ID,
			Name:        detection.Name,
			State:       detection.State,
			Configured:  registered[detection.ID],
			ConfigPath:  detection.ConfigPath,
			ConfigError: detection.ConfigError,
			ReloadHint:  detection.ReloadHint,
		})
	}
	sort.SliceStable(harnesses, func(a, b int) bool {
		left, right := harnesses[a], harnesses[b]
		if (left.State == detectharness.Detected) != (right.State == detectharness.Detected) {
			return left.State == detectharness.Detected
		}
		return left.Name < right.Name
	})
	return harnesses
}

// Apply registers or removes the server for the given harnesses.
func (i *Installer) Apply(ctx context.Context, ids []detectharness.ID, desired detectharness.DesiredState) []detectharness.Result {
	if len(ids) == 0 {
		return nil
	}
	return i.installer.Ensure(ctx, ids, desired, detectharness.PlanOptions{})
}
