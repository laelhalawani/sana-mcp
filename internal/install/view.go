package install

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/laelhalawani/sana-mcp/internal/localstate"
	"github.com/laelhalawani/sana-mcp/internal/render"
	detectharness "github.com/sairaph/detect-harness"
)

// Every screen is header, one section line, the content, and a footer. Keeping
// that shape is what makes the steps read as one program rather than a sequence
// of unrelated questions.

func (m *model) View() string {
	switch m.step {
	case stepDetecting:
		return section(header(), "") + "  " + m.spinner() + " Initialising, looking for AI clients...\n"
	case stepReplace:
		return m.viewReplace()
	case stepHarnesses:
		return m.viewHarnesses()
	case stepApplying:
		return section(header(), "") + "  " + m.spinner() + " Registering...\n"
	case stepSignIn:
		return m.viewSignIn()
	case stepEmail, stepCode:
		return m.viewInput()
	case stepSyncing:
		return m.viewSyncing()
	case stepPlan:
		return m.viewPlan()
	case stepRemoving:
		return section(uninstallHeader(), "") + "  " + m.spinner() + " Removing...\n"
	}
	if m.step == stepDone && m.removals != nil {
		return m.viewRemoved()
	}
	return m.viewDone()
}

// section writes a header and, when there is one, the line naming what this
// screen is for. One shape helper, so no screen hand-rolls its own spacing.
func section(head, title string) string {
	if title == "" {
		return head + "\n\n"
	}
	return head + "\n\n  " + title + "\n\n"
}

// choices renders a short action list with the cursor on one of them.
//
// A cursor and nothing else: the filled dot means "this is the stored value" in
// a settings list, and putting one beside Cancel says the opposite of what the
// row does.
func choices(cursor int, options ...string) string {
	var out strings.Builder
	for index, option := range options {
		pointer := " "
		if index == cursor {
			pointer = styleCursor.Render(">")
		}
		fmt.Fprintf(&out, " %s %s\n", pointer, option)
	}
	return out.String()
}

func footer(hints string) string {
	return "\n" + styleFooter.Render("  "+hints)
}

// wrapAt breaks a message so it does not run off the screen. The installer
// prints into whatever width the terminal has; nothing here measures it, so a
// conservative fixed width is what keeps a long path on the page.
func wrapAt(text string, width int) []string {
	return render.Wrap(text, width, "...")
}

// shortPath writes a path the way a person would say it. An absolute path under
// the home directory is most of a line of noise before the part that matters.
func shortPath(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	// Anywhere in the string, not just at the start: the PATH hint is a whole
	// shell command with the directory inside it.
	return strings.ReplaceAll(path, home+string(filepath.Separator),
		"~"+string(filepath.Separator))
}

func (m *model) viewReplace() string {
	var out strings.Builder
	out.WriteString(section(header(), "Existing Sana data — replace it? This version cannot read it."))
	out.WriteString(choices(m.choice, "Replace and continue", "Cancel"))
	out.WriteString("\n" + styleDim.Render(
		"  Your meetings are downloaded again, and you may need to sign in.\n"+
			"  Nothing is deleted until setup finishes."))
	return out.String() + "\n" + footer("↑↓ move · enter select · esc cancel")
}

func (m *model) viewHarnesses() string {
	var out strings.Builder
	out.WriteString(section(header(), "AI clients — which should be able to read your meetings?"))

	indices := m.visible()
	if len(indices) == 0 {
		out.WriteString(styleDim.Render(
			"  No AI clients detected. Install one, then run\n  `sana-mcp configure`.\n"))
	}
	for _, index := range indices {
		harness := m.harnesses[index]
		cursor := " "
		if index == m.cursor && harness.Selectable() {
			cursor = styleCursor.Render(">")
		}
		mark := styleOff.Render("○")
		if !harness.Selectable() {
			mark = styleDim.Render("·")
		} else if m.selected[harness.ID] {
			mark = styleOn.Render("●")
		}
		line := fmt.Sprintf("%-22s %s", harness.Name, styleDim.Render(harness.StatusText()))
		if !harness.Selectable() {
			line = styleDim.Render(fmt.Sprintf("%-22s ", harness.Name)) +
				styleHint.Render(harness.StatusText())
		}
		fmt.Fprintf(&out, " %s %s %s\n", cursor, mark, line)
	}

	hidden := len(m.harnesses) - len(indices)
	if hidden > 0 && !m.showAll {
		out.WriteString("\n" + styleDim.Render(
			fmt.Sprintf("  press v to show %d client(s) that are not installed", hidden)))
	} else if m.showAll {
		out.WriteString("\n" + styleDim.Render("  press v to hide clients that are not installed"))
	}
	if m.message != "" {
		out.WriteString("\n\n  " + m.message)
	}
	return out.String() + "\n" + footer(
		"↑↓ move · space toggle · a all/none · v show all · enter continue · q cancel")
}

func (m *model) viewSignIn() string {
	var out strings.Builder
	out.WriteString(section(header(), "Sana account — sign in now to start syncing?"))
	out.WriteString(choices(m.choice, "Sign in", "Skip for now"))
	if m.message != "" {
		out.WriteString("\n" + styleError.Render("  "+m.message) + "\n")
	}
	return out.String() + footer("↑↓ move · enter select · esc skip")
}

func (m *model) viewInput() string {
	title := "Sana account — your email address"
	if m.step == stepCode {
		title = "Sana account — the 6-digit code we emailed you"
	}
	var out strings.Builder
	out.WriteString(section(header(), title))
	if m.step == stepCode {
		out.WriteString(styleDim.Render("  Sent to "+m.email) + "\n\n")
	}
	fmt.Fprintf(&out, "  %s_\n", m.input)
	if m.message != "" {
		out.WriteString("\n" + styleError.Render("  "+m.message) + "\n")
	}
	return out.String() + footer("enter confirm · esc skip")
}

func (m *model) viewSyncing() string {
	var out strings.Builder
	out.WriteString(section(header(), "Meetings — syncing"))

	status := m.status.Status
	if bar := render.ProgressBar(status.Meetings, status.MeetingsTotal, 24); bar != "" {
		fmt.Fprintf(&out, "  %s %d/%d\n\n", bar, status.Meetings, status.MeetingsTotal)
	} else {
		out.WriteString("  " + m.spinner() + " Finding your meetings...\n\n")
	}
	fmt.Fprintf(&out, "  %-22s %d\n", "Meetings ready", status.Meetings)
	fmt.Fprintf(&out, "  %-22s %d\n", "Transcripts stored", status.TranscriptsDone)
	if status.Remaining > 0 {
		fmt.Fprintf(&out, "  %-22s %d\n", "Pending", status.Remaining)
	}
	if m.status.Unavailable != "" {
		out.WriteString("\n" + styleError.Render("  "+m.status.Unavailable) + "\n")
	} else if status.LastError != "" {
		out.WriteString("\n" + styleHint.Render("  "+status.LastError) + "\n")
	}
	out.WriteString("\n" + styleDim.Render("  Sync continues in the background after you finish."))
	return out.String() + "\n" + footer("enter to finish")
}

func (m *model) viewDone() string {
	var out strings.Builder
	out.WriteString(section(header(), ""))

	if m.failure != "" {
		out.WriteString(styleError.Render("  "+m.failure) + "\n\n")
	}
	if m.warning != "" {
		for _, line := range wrapAt(shortPath(m.warning), 76) {
			out.WriteString(styleHint.Render("  "+line) + "\n")
		}
		out.WriteString("\n")
	}
	fmt.Fprintf(&out, "  %-22s %d connected\n", "AI clients", m.connected())
	if m.signedIn {
		fmt.Fprintf(&out, "  %-22s %s\n", "Sana account", m.email)
	} else {
		fmt.Fprintf(&out, "  %-22s %s\n", "Sana account", styleHint.Render("not signed in"))
	}
	// Sync cannot be continuing when there is no session to sync with. Saying
	// so anyway is how the summary ended up promising work that was never
	// going to happen.
	switch {
	case !m.signedIn:
		fmt.Fprintf(&out, "  %-22s %s\n", "Meetings", styleDim.Render("waiting for sign-in"))
	case m.status.Status.Complete():
		fmt.Fprintf(&out, "  %-22s %s\n", "Meetings", "up to date")
	default:
		fmt.Fprintf(&out, "  %-22s %s\n", "Meetings", "syncing in the background")
	}

	// Every client, not just the failures. A registration removed at the user's
	// request produced no line at all, so the one outcome they had just chosen
	// was the one they could not see.
	if len(m.results) > 0 {
		out.WriteString("\n")
	}
	for _, result := range m.results {
		enabling := result.Desired == detectharness.Present
		summary := summarise(result, enabling)
		if result.State == detectharness.ApplyFailed || result.State == detectharness.ApplyConflict {
			summary = styleError.Render(summary)
		}
		fmt.Fprintf(&out, "  %-22s %s\n", result.Name, summary)
	}
	// What this install replaced, so nobody is left wondering where the old
	// copy went or why the command still resolved to it.
	for _, removal := range m.superseded {
		label, path := "Older version", shortPath(removal.Leftover.Path)
		if removal.Leftover.Kind == "profile" {
			label = "Older PATH entry"
		}
		if removal.Err != nil {
			fmt.Fprintf(&out, "  %-22s %s\n", label,
				styleError.Render(path+": "+removal.Err.Error()))
			continue
		}
		fmt.Fprintf(&out, "  %-22s %s\n", label, styleDim.Render("removed from "+path))
	}

	if hints := m.reloadHints(); len(hints) > 0 {
		out.WriteString("\n  Restart the affected clients so they pick up the change:\n")
		for _, hint := range hints {
			fmt.Fprintf(&out, "  %-22s %s\n", hint.client, styleDim.Render(hint.action))
		}
	}

	if m.unreachable != "" {
		out.WriteString("\n" + styleHint.Render("  sana-mcp is not on your PATH yet.") + "\n")
		// Not shortened: this line is meant to be pasted, and a tilde inside
		// double quotes is not a home directory.
		out.WriteString(styleDim.Render("  Add this to your shell profile, or open a new terminal:\n    "+
			m.unreachable) + "\n")
	}

	next := "  Run `sana-mcp` to browse your meetings,"
	if !m.signedIn {
		next = "  Run `sana-mcp login` to sign in,"
	}
	out.WriteString("\n" + styleDim.Render(next+
		"\n  or `sana-mcp configure` to change any of this later."))
	return out.String() + "\n" + footer("enter to finish")
}

// --- uninstall ---------------------------------------------------------------

func (m *model) viewPlan() string {
	var out strings.Builder
	out.WriteString(section(uninstallHeader(), "This removes:"))

	if len(m.harnesses) > 0 {
		names := make([]string, 0, len(m.harnesses))
		for _, harness := range m.harnesses {
			names = append(names, harness.Name)
		}
		fmt.Fprintf(&out, "  %-22s %s\n", "AI clients", styleDim.Render(strings.Join(names, ", ")))
	}
	for _, leftover := range m.plan.Leftovers {
		fmt.Fprintf(&out, "  %-22s %s\n", leftoverLabel(leftover), styleDim.Render(shortPath(leftover.Path)))
	}
	out.WriteString("\n")
	out.WriteString(choices(m.choice, "Remove everything", "Cancel"))
	return out.String() + footer("↑↓ move · enter select · esc cancel")
}

func leftoverLabel(leftover localstate.Leftover) string {
	switch leftover.Kind {
	case "data":
		return "Meetings and sign-in"
	case "binary":
		if leftover.Self {
			return "This program"
		}
		return "Installed program"
	default:
		return "Shell PATH entry"
	}
}

func (m *model) confirmUninstall(choice int) tea.Cmd {
	if choice != 0 {
		m.cancel = true
		return tea.Quit
	}
	m.step = stepRemoving
	plan, registered := m.plan, m.registered
	paths, self := m.runtime.Paths, m.self
	return tea.Batch(spin(), func() tea.Msg {
		stopped := localstate.StopDaemons(m.ctx, paths, self)
		results := m.installer.Apply(m.ctx, registered, detectharness.Absent)
		return removedMsg{stopped: stopped, results: results, removals: plan.Apply()}
	})
}

func (m *model) viewRemoved() string {
	var out strings.Builder
	out.WriteString(section(uninstallHeader(), ""))

	for _, line := range m.stopped {
		out.WriteString("  " + styleDim.Render(line) + "\n")
	}
	for _, result := range m.results {
		summary := summarise(result, false)
		if result.State == detectharness.ApplyFailed || result.State == detectharness.ApplyConflict {
			summary = styleError.Render(summary)
		}
		fmt.Fprintf(&out, "  %-22s %s\n", result.Name, summary)
	}
	failures := 0
	for _, result := range m.results {
		if result.State == detectharness.ApplyFailed || result.State == detectharness.ApplyConflict {
			failures++
		}
	}
	for _, removal := range m.removals {
		label := leftoverLabel(removal.Leftover)
		switch {
		case removal.Deferred:
			// Windows cannot unlink a running image and nothing here runs after
			// this process to finish it, so it is named for the user to delete
			// rather than promised away.
			fmt.Fprintf(&out, "  %-22s %s\n", label,
				styleHint.Render("still running; delete "+shortPath(removal.Leftover.Path)))
		case removal.Err != nil:
			failures++
			fmt.Fprintf(&out, "  %-22s %s\n", label, styleError.Render(removal.Err.Error()))
		default:
			fmt.Fprintf(&out, "  %-22s %s\n", label, "removed")
		}
	}

	out.WriteString("\n")
	if failures > 0 {
		out.WriteString(styleError.Render("  Some of it could not be removed; see above.") + "\n")
	} else if remaining := localstate.StillOnPath(m.removals); remaining != "" {
		out.WriteString(styleHint.Render("  Another sana-mcp is still on your PATH:") + "\n")
		out.WriteString("    " + styleDim.Render(shortPath(remaining)) + "\n")
	} else if entry := localstate.PathLeftBehind(m.runtime.Paths); entry != "" {
		// The Windows PATH entry is in the registry, not in a file this program
		// edits, so it is named rather than claimed to be gone.
		out.WriteString(styleHint.Render("  One thing is left: your PATH still lists") + "\n")
		out.WriteString("    " + styleDim.Render(entry) + "\n")
		out.WriteString(styleDim.Render(
			"  Remove it under System Properties > Environment Variables.") + "\n")
	} else {
		out.WriteString(styleDim.Render("  Open a new terminal to clear it from your PATH.") + "\n")
	}
	return out.String() + footer("enter to finish")
}
