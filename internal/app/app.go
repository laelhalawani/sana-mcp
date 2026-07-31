// Package app is the interactive application opened by a bare sana-mcp on a
// terminal.
//
// It is a loop of prompts rather than one program that owns the screen: the
// menu settles into scrollback, and each screen takes the terminal only while
// it is open. That is how the shipped TypeScript application behaved, and the
// keys and wording here follow it, because people already know them.
//
// What is new is transcript correction: editing a line, seeing what was
// changed, and putting it back.
package app

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/laelhalawani/sana-mcp/internal/bootstrap"
	"github.com/laelhalawani/sana-mcp/internal/cli"
	"github.com/laelhalawani/sana-mcp/internal/daemon"
	"github.com/laelhalawani/sana-mcp/internal/install"
	"github.com/laelhalawani/sana-mcp/internal/sana"
	"github.com/laelhalawani/sana-mcp/internal/statusview"
	"github.com/laelhalawani/sana-mcp/internal/store"
	"github.com/laelhalawani/sana-mcp/internal/tui"
)

// choice is a menu entry. The label and what it opens live together, so a list
// and an index switch cannot drift apart.
type choice struct {
	label  string
	action string
}

// signedOutChoices is the menu with no session: there is nothing to browse.
func signedOutChoices(expired bool) []choice {
	label := "Sign in to Sana"
	if expired {
		label = "Sign in again (session expired)"
	}
	return []choice{
		{label, "login"},
		{"Configure AI clients", "configure"},
		{"Quit", "quit"},
	}
}

// signedInChoices is the full menu. Search is left out only while there is no
// meeting list yet: searching an index that does not exist answers the wrong
// question, but a pending transcript or two is the normal state of a working
// install and must not take the option away.
func signedInChoices(preparing bool) []choice {
	meetings := "Meetings"
	if preparing {
		meetings = "Meetings (syncing)"
	}
	items := []choice{{meetings, "list"}}
	if !preparing {
		items = append(items, choice{"Search transcripts", "search"})
	}
	return append(items,
		choice{"Sync status", "status"},
		choice{"Sana account", "account"},
		choice{"Configuration", "configure"},
		choice{"Quit", "quit"},
	)
}

// application is one run of the interactive program.
type application struct {
	ctx      context.Context
	runtime  *bootstrap.Runtime
	terminal tui.Terminal
	store    *store.Store
	version  string
}

// Run opens the interactive application.
func Run(ctx context.Context, runtime *bootstrap.Runtime, version string) int {
	terminal := tui.Open(os.Stdin, os.Stdout)
	if !terminal.Policy.Interactive {
		fmt.Fprintln(os.Stderr, "Run sana-mcp in an interactive terminal.")
		return 1
	}

	daemon.EnsureRunning(runtime)

	database, err := store.Open(runtime.Paths.Database)
	if err != nil {
		terminal.Print(terminal.UI.Red("sana-mcp: "), err.Error())
		if errors.Is(err, store.ErrForeignSchema) {
			terminal.Print("Run ", terminal.UI.Bold("sana-mcp install"),
				" to replace it, or remove ", runtime.Paths.Root, " and sync again.")
		}
		return 1
	}
	defer database.Close()

	app := &application{
		ctx: ctx, runtime: runtime, terminal: terminal,
		store: database, version: version,
	}
	return app.loop()
}

func (a *application) loop() int {
	for {
		info := statusview.Read(a.runtime.Paths)
		// A lapsed session still has meetings behind it, so the full menu stays:
		// what was downloaded is readable, and Sana account is how to sign in
		// again. Only the total absence of a session takes it away.
		items := signedOutChoices(false)
		switch {
		case info.Expired:
			items = signedInChoices(info.Preparing())
			items[len(items)-3] = choice{"Sana account (session expired)", "account"}
		case info.SignedIn:
			items = signedInChoices(info.Preparing())
		}
		labels := make([]string, 0, len(items))
		for _, item := range items {
			labels = append(labels, item.label)
		}

		index, err := a.terminal.Select(a.ctx, "What would you like to do?", labels)
		if err != nil {
			return 0
		}
		if quit := a.dispatch(items[index].action); quit {
			return 0
		}
	}
}

// dispatch runs one menu action and reports whether the program should end.
func (a *application) dispatch(action string) bool {
	switch action {
	case "quit":
		return true
	case "list":
		return a.browse() == tui.ErrCancelled
	case "search":
		return a.search() == tui.ErrCancelled
	case "status":
		result, err := statusview.Run(a.ctx, a.terminal, statusview.ModeStatus,
			func() statusview.Info { return statusview.Read(a.runtime.Paths) }, nil)
		return err == nil && result == statusview.ActionQuit
	case "account":
		return a.account()
	case "configure":
		a.configure()
	}
	return false
}

// account shows the session and offers to sign in again. Signing in from here
// is the whole point of the screen: telling someone to quit and run another
// command is not an account screen.
func (a *application) account() bool {
	session, _ := sana.LoadSession(a.runtime.Paths.Session)
	state := "not signed in"
	signIn := "Sign in"
	if session.SignedIn() {
		state = "signed in as " + session.Address()
		signIn = "Sign in again"
	}
	index, err := a.terminal.Select(a.ctx, "Sana account - "+state,
		[]string{"Back", signIn})
	if err != nil || index == 0 {
		return false
	}
	a.signIn()
	return false
}

// signIn runs the emailed-code flow.
func (a *application) signIn() {
	ui := a.terminal.UI

	email, err := a.terminal.Input(a.ctx, "Email for your Sana account")
	if err != nil || email == "" {
		return
	}
	client := sana.New("", nil)
	pending, err := client.RequestSignInCode(a.ctx, email)
	if err != nil {
		a.terminal.Print(ui.Red("Sign-in is unavailable: "), err.Error())
		return
	}
	a.terminal.Print("We emailed a 6-digit code to ", email, ".")

	code, err := a.terminal.Input(a.ctx, "6-digit code")
	if err != nil || code == "" {
		a.terminal.Print("Sign-in paused. Choose Sana account when you are ready.")
		return
	}
	user, err := client.SubmitSignInCode(a.ctx, pending, code)
	if err != nil {
		a.terminal.Print(ui.Red("Sign-in did not complete: "), err.Error())
		return
	}
	if err := sana.SaveSession(a.runtime.Paths.Session, sana.SessionFrom(client, user)); err != nil {
		a.terminal.Print(ui.Red("Signed in, but the session could not be saved: "), err.Error())
		return
	}
	// The daemon reads the session at the start of each cycle, so a new one is
	// picked up on its own - but a needs_login it recorded against the old
	// session stays until then, and that is what the screens read.
	if err := a.store.ResumeAfterSignIn(); err != nil {
		a.terminal.Print(ui.Yellow("Signed in, but the sync state could not be cleared: "),
			err.Error())
	}
	a.terminal.Print("Signed in as ", user.Email, ".")
	a.terminal.Print("Your meetings are syncing in the background.")
	daemon.EnsureRunning(a.runtime)
}

// configure shows where things are, and opens the client configurer.
func (a *application) configure() {
	ui := a.terminal.UI
	a.terminal.Blank()
	a.terminal.Print(ui.Bold("Configuration"))
	a.terminal.Print("Data          ", a.runtime.Paths.Root)
	a.terminal.Print("Sync every    ", fmt.Sprint(a.runtime.Config.SyncIntervalMinutes), " minutes")
	a.terminal.Print("Search        keyword (BM25)")
	a.terminal.Blank()

	index, err := a.terminal.Select(a.ctx, "Configuration",
		[]string{"Back", "Change which AI clients are connected"})
	if err != nil || index == 0 {
		return
	}
	// The configurer is the installer's own screen. Calling it rather than
	// telling the user to quit and run `sana-mcp configure` is the difference
	// between a menu entry and a sign pointing elsewhere.
	install.Run(a.ctx, a.runtime, cli.Command{Name: "configure"}, cli.Options{
		Version: a.version,
		Stdin:   a.terminal.In,
		Stdout:  a.terminal.Out,
		Stderr:  os.Stderr,
	})
}
