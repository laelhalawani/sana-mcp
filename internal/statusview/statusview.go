// Package statusview is the sync status screen.
//
// It is one implementation with two modes because the installer and the
// application show the same thing at different moments: the installer watches
// the first sync finish, the application checks in on a later one. Two copies
// drifted apart in the previous implementation.
package statusview

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/laelhalawani/sana-mcp/internal/config"
	"github.com/laelhalawani/sana-mcp/internal/render"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// Info is everything the screen shows, gathered in one pass.
type Info struct {
	Status   store.Status
	SignedIn bool
	// Expired separates "you were signed in and the session lapsed" from "you
	// never signed in", because only one of them is a surprise.
	Expired bool
	// Unavailable is why background sync cannot run at all. It is the loud
	// case: an unreadable database belongs here rather than being swallowed
	// into a progress bar that never moves.
	Unavailable string
	// HeartbeatMS is when the daemon last touched its pid file.
	HeartbeatMS int64
}

// Read gathers the status from disk. It never returns an error: every failure
// it can have is something the screen must show rather than something the
// caller can fix.
func Read(paths config.Paths) Info {
	info := Info{}

	session, err := sana.LoadSession(paths.Session)
	if err == nil {
		info.SignedIn = session.SignedIn()
	}

	database, err := store.Open(paths.Database)
	if err != nil {
		if errors.Is(err, store.ErrForeignSchema) {
			info.Unavailable = err.Error() +
				". Run `sana-mcp install` to replace it, or remove ~/.sana-mcp and sync again."
		} else {
			info.Unavailable = err.Error()
		}
		return info
	}
	defer database.Close()

	status, err := database.Status()
	if err != nil {
		info.Unavailable = err.Error()
		return info
	}
	info.Status = status

	if stat, err := os.Stat(paths.PID); err == nil {
		info.HeartbeatMS = stat.ModTime().UnixMilli()
	}
	return info
}

// authProblem reports whether the sync numbers are meaningless because there is
// no session to sync with. When it is true the counts are suppressed: a stale
// "12 of 300" beside "sign in required" reads as progress that is still
// happening.
func (i Info) authProblem() bool { return !i.SignedIn }

// Preparing reports that there is not yet a meeting list to browse.
//
// It is exactly "nothing has been listed", and nothing more. A pending
// transcript is the normal state of a working install, and the listing phase
// comes round on every cycle - keying off either of those hides a perfectly
// good list of meetings behind a progress screen.
func (i Info) Preparing() bool { return i.SignedIn && i.Status.MeetingsTotal == 0 }

func (i Info) complete() bool { return !i.authProblem() && i.Status.Complete() }

func (i Info) attention() bool {
	return i.authProblem() || i.Status.LastError != "" || i.Unavailable != ""
}

// phaseLabel names what is happening now, in the words the previous
// implementation used.
func (i Info) phaseLabel() string {
	if !i.SignedIn {
		if i.Expired {
			return "Sana session expired"
		}
		return "Sign in required"
	}
	if i.Status.Phase == store.PhaseSynced && i.Status.Remaining == 0 {
		return "Up to date"
	}
	switch i.Status.Phase {
	case store.PhaseListing:
		return "Discovering meetings"
	case store.PhaseNeedsLogin:
		return "Sign in required"
	case store.PhaseError:
		return "Sync needs attention"
	}
	return "Syncing meetings"
}

// Mode is which of the two screens this is.
type Mode string

const (
	// ModeStatus is the application's own screen: it reports and offers to
	// refresh, and q leaves the program.
	ModeStatus Mode = "status"
	// ModeSetup is the last screen of the installer: it also confirms what the
	// installer just did, and only Enter leaves it.
	ModeSetup Mode = "setup"
)

// Setup is the installer's extra context: what it connected, and whether it
// signed in. It is nil in ModeStatus.
type Setup struct {
	ConnectedClients int
	SignedIn         bool
}

// Action is how the user left the screen.
type Action string

const (
	ActionBack Action = "back"
	ActionQuit Action = "quit"
)

type refreshMsg time.Time

type model struct {
	ui      tui.UI
	mode    Mode
	setup   *Setup
	read    func() Info
	info    Info
	frame   int
	updated time.Time
	action  Action
	done    bool
}

func (m *model) Init() tea.Cmd { return tick() }

func tick() tea.Cmd {
	// One second. The spinner turns at the rate the numbers change, so a frame
	// that moves means work happened rather than that a timer fired.
	return tea.Tick(time.Second, func(now time.Time) tea.Msg { return refreshMsg(now) })
}

func (m *model) refresh() {
	m.info = m.read()
	m.updated = time.Now()
}

func (m *model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.ui.Policy.Columns = msg.Width
		m.ui.Policy.Rows = msg.Height

	case refreshMsg:
		m.frame++
		m.refresh()
		return m, tick()

	case tea.KeyMsg:
		switch strings.ToLower(msg.String()) {
		case "ctrl+c":
			m.done, m.action = true, ActionQuit
			return m, tea.Quit
		case "enter", "esc":
			m.done, m.action = true, ActionBack
			return m, tea.Quit
		case "q":
			if m.mode == ModeStatus {
				m.done, m.action = true, ActionQuit
				return m, tea.Quit
			}
		case "r":
			m.refresh()
		}
	}
	return m, nil
}

func (m *model) View() string {
	if m.done {
		return ""
	}
	ui := m.ui
	width := ui.Policy.Width()
	info := m.info

	glyph := ui.Spinner(m.frame)
	switch {
	case info.complete():
		glyph = ui.Glyphs.OK
	case info.attention():
		glyph = ui.Glyphs.Fail
	}
	phaseLine := ui.Truncate(glyph+" "+info.phaseLabel(), width)
	colour := ui.Cyan
	switch {
	case info.complete():
		colour = ui.Green
	case info.attention():
		colour = ui.Red
	}
	body := []tui.Text{colour(phaseLine)}

	if m.mode == ModeSetup && m.setup != nil {
		signedIn := m.setup.SignedIn && info.SignedIn
		account := ui.Yellow
		accountGlyph, accountText := ui.Glyphs.Pending, info.phaseLabel()
		if signedIn {
			account = ui.Green
			accountGlyph, accountText = ui.Glyphs.OK, "signed in"
		}
		body = append(body,
			"",
			ui.Green(ui.Truncate(fmt.Sprintf("%s AI clients  %d connected",
				ui.Glyphs.OK, m.setup.ConnectedClients), width)),
			account(ui.Truncate(fmt.Sprintf("%s Sana account  %s", accountGlyph, accountText), width)),
		)
	}

	if !info.authProblem() {
		status := info.Status
		body = append(body, tui.Text(fmt.Sprintf("  Meetings ready     %d", status.Meetings)))
		if status.Remaining > 0 {
			body = append(body, tui.Text(fmt.Sprintf("  Pending            %d", status.Remaining)))
		}
		body = append(body, tui.Text(fmt.Sprintf("  Transcripts stored %d", status.TranscriptsDone)))
		if bar := render.ProgressBar(status.Meetings, status.MeetingsTotal, min(24, width-4)); bar != "" {
			body = append(body, ui.Cyan(ui.Truncate("  "+bar, width)))
		}
	}

	if m.mode == ModeStatus {
		switch {
		case !info.SignedIn && info.Expired:
			body = append(body, "", "Your Sana session has expired. Sign in again.")
		case !info.SignedIn:
			body = append(body, "", "You are not signed in to Sana.")
		default:
			body = append(body, "",
				"Sana session: signed in; access is checked before every sync cycle.")
		}
		if info.SignedIn && info.Status.UpdatedMS > 0 {
			body = append(body, tui.Text("Last completed sync: "+localTime(info.Status.UpdatedMS)))
		}
		if info.SignedIn && info.HeartbeatMS > 0 {
			body = append(body, tui.Text("Daemon heartbeat: "+localTime(info.HeartbeatMS)))
		}
	}

	if info.Status.LastError != "" {
		body = append(body, "", ui.Plain("Sync error: "+info.Status.LastError))
	}
	if info.Unavailable != "" {
		body = append(body, "", ui.Plain("Background sync unavailable: "+info.Unavailable))
	}
	if m.mode == ModeStatus {
		body = append(body, "",
			ui.Dim(ui.Truncate("Updated "+m.updated.Format("15:04:05"), width)))
	}

	title := "Sync status"
	footer := "auto-refreshing  r refresh  Enter/Esc menu  q quit"
	if m.mode == ModeSetup {
		title = "sana-mcp setup"
		footer = "Enter finish setup - sync continues in the background"
	}
	return ui.Screen(title, body, footer)
}

func localTime(ms int64) string {
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04:05")
}

// Run shows the screen until the user leaves it.
func Run(
	ctx context.Context,
	terminal tui.Terminal,
	mode Mode,
	read func() Info,
	setup *Setup,
) (Action, error) {
	initial := &model{ui: terminal.UI, mode: mode, setup: setup, read: read}
	initial.refresh()

	program := tea.NewProgram(
		initial,
		tea.WithContext(ctx),
		tea.WithInput(terminal.In),
		tea.WithOutput(terminal.Out),
	)
	final, err := program.Run()
	if err != nil {
		return ActionQuit, err
	}
	return final.(*model).action, nil
}
