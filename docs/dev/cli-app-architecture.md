# CLI App Architecture

How `sana-mcp` is split into three faces of one binary: an interactive CLI
app (bare invocation), an MCP server, and a client configurer/installer. This
document is the implementation plan for making bare `sana-mcp` launch the
interactive app instead of the configurer wizard.

## Problem

Today `src/cli.ts`'s default `[tool] [json]` action treats a bare invocation
(no tool, no flags) as a signal to run `runInstall()` - the client-configurer
wizard. That is wrong. Bare `sana-mcp` should launch a full interactive app
(a main menu over search / list / status / read / summary / participants /
recording / sign-in / configure-clients / quit). Configuring clients must be a
separate, explicit command.

## Command surface (disambiguated)

| Invocation | tool positional | meaningful flags | TTY | Route |
|---|---|---|---|---|
| `sana-mcp` | none | none | in+out TTY | `runApp()` (interactive app) |
| `sana-mcp` | none | none | not a TTY | print bare-hint, exit 0 |
| `sana-mcp help` / `status` / `list '{...}'` / `read --id ...` | present | any | any | one-shot `sana(tool, args)` (unchanged) |
| `sana-mcp --limit 5` (flags, no tool) | none | present | any | one-shot `sana("help", args)` (unchanged legacy behavior) |
| `sana-mcp install` / `config` / `configure` | subcommand | `--dry-run --yes --name` | any | `runInstall(opts)` |
| `sana-mcp uninstall` | subcommand | `--dry-run --yes --name` | any | `runUninstall(opts)` |
| `sana-mcp mcp` | subcommand | - | any | `runMcp()` (unchanged) |
| `sana-mcp daemon` | subcommand | - | any | `runDaemon()` (unchanged) |
| `sana-mcp --help` / `--version` | - | - | any | commander built-ins |

"Meaningful flags" = `--email --code --id --limit --query --no-timestamps`
(the set already checked by the current `bareInvocation` predicate).

Naming decision: keep `install` as the canonical configurer command (it matches
the installer scripts and the README) and add `config` and `configure` as
aliases via commander's `.aliases([...])`. The interactive app also exposes the
same wizard as a menu entry ("Configure AI clients"). There is no longer any
path by which a bare invocation reaches the wizard.

### Routing logic for `src/cli.ts`

Commander matches the named subcommands (`daemon`, `install`, `uninstall`,
`mcp`) before the default `[tool] [json]` action, so those are untouched. Only
the default action changes. Replace the current `bareInvocation -> runInstall`
block with:

```
const bareApp =
  !tool && !json &&
  !opts.email && !opts.code && !opts.id &&
  !opts.limit && !opts.query && opts.timestamps !== false;

if (bareApp) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runApp } = await import("./app/app.js");
    await runApp();
    process.exit(0);
  }
  // Non-interactive (piped/redirected): never block on a prompt.
  console.log(bareHint());   // short usage: run in a terminal for the app,
  process.exit(0);           // or `sana-mcp help` / `sana-mcp <tool>`.
}
```

Everything after this block (JSON parse, flag mapping, `sana(tool ?? "help",
args)`) stays exactly as it is, so `sana-mcp help`, `sana-mcp status`,
`sana-mcp list`, `sana-mcp read --id ...`, and pipe usage are unaffected.

`bareHint()` is a small local function that prints one or two lines: what the
app is, that it needs a terminal, and that `sana-mcp help` lists the scripting
tools.

## The interactive app

New module `src/app/app.ts` exporting `runApp(): Promise<void>`. It owns a
main-menu loop and delegates each action to a feature screen. Screens live in
`src/app/screens/` and share human-facing formatting from `src/app/render.ts`.

### Module boundary (critical)

The app MUST NOT reuse the LLM-facing string dispatcher (`sana(tool, args)` in
`src/tools/dispatch.ts`) for presentation. That dispatcher exists to hand
markdown-ish strings to an agent; parsing those strings back for a human UI (as
`install.ts`'s `maybeLogin()` currently does with a regex on the status string)
is the anti-pattern to avoid.

Instead the app reads structured data directly:

- Reads/queries: `SanaStore` already returns typed rows - `listMeetings`,
  `countMeetings`, `getMeeting`, `getTranscript`, `getMetadata`, `searchLines`,
  `countLineMatches`, `getSyncState`, `countMeetings/Transcripts/Embedded`. The
  screens call these and format the rows themselves in `src/app/render.ts`
  (tables, transcript lines via `src/sana/transcript.ts`'s `transcriptLines` /
  `renderLines`, which are already string-free at the data layer).
- Session/sync state: `src/app/session.ts` (new) exposes
  `getAppState(): { loggedIn: boolean; expired: boolean; syncBlocking: boolean;
  sync: SyncState }`, computed from `SanaClient.load().hasAuthCookie()` plus
  `store.getSyncState()` (`phase === "needs_login"`, `blocking === 1`). No
  string matching.
- Login: extract the login side-effects (request code, verify code, stamp the
  catch-up sync, `ensureDaemonRunning`) out of `dispatch.ts`'s `handleLogin`
  into a structured `src/sana/auth.ts` with `requestCode(email, workspaceId?)`
  and `verifyCode(email, code)` returning typed results. Both the app's login
  screen and `dispatch.ts`'s `handleLogin` call this core; `handleLogin` keeps
  producing its agent strings from the typed result. (Refactoring the string
  layer is a separate agent's concern - this doc only fixes the boundary so the
  app never round-trips through strings.)

So the dependency direction is: `app/*` -> `store/db`, `sana/client`,
`sana/auth`, `sana/transcript`, `install/install`. The app never imports
`tools/dispatch`.

### Menu entries and routing

Rendered with `@inquirer/prompts` `select` (already a dependency). Each entry
maps to a screen function `run(store, client): Promise<void>` that prints its
output and returns to the loop:

| Menu label | Screen module | Data source | Gated during blocking sync |
|---|---|---|---|
| Search transcripts | `screens/search.ts` | `store.searchLines` / semantic | yes |
| List meetings | `screens/list.ts` | `store.listMeetings` | yes |
| Sync status | `screens/status.ts` | `store.getSyncState` + counts | no (always) |
| Read a transcript | `screens/read.ts` | `store.getTranscript` | yes |
| Meeting summary | `screens/summary.ts` | `store.getMetadata` | yes |
| Participants | `screens/participants.ts` | `store.getMetadata` | yes |
| Recording link | `screens/recording.ts` | `client.getMeetingById` (network) | yes |
| Sign in / account | `screens/login.ts` | `sana/auth.ts` | no |
| Configure AI clients | `install/install.ts` `runInstall({ fromApp:true })` | - | no |
| Quit | - | - | - |

`read`, `summary`, `participants`, and `recording` take a meeting id. In the
app the id is chosen interactively: the screen first shows a `select` of recent
meetings (from `store.listMeetings`) so the human never has to paste an id,
falling back to a text `input` for older meetings or a direct id.

"Configure AI clients" reuses the existing wizard. Add a `fromApp?: boolean`
option to `runInstall` so, when launched from the menu, it skips the trailing
`maybeLogin()` prompt and the "Run sana-mcp anytime..." closing text (the app
already has a dedicated login screen and owns the outer loop).

## Main-menu state machine

`runApp()` recomputes `getAppState()` at the top of every loop iteration, so the
menu reflects login and sync state live (e.g. after a background sync finishes,
gated entries unlock without restarting the app).

```
START
  guard: if not (stdin.isTTY && stdout.isTTY) -> print bare-hint, return
  loop:
    state = getAppState()

    if !state.loggedIn || state.expired:
        # LOGGED_OUT: minimal menu
        choice = select { "Sign in to Sana", "Configure AI clients", "Quit" }
        Sign in            -> screens/login.run(); continue   # re-evaluate state
        Configure AI clients -> runInstall({fromApp:true}); continue
        Quit               -> break

    else:
        # LOGGED_IN: full menu. Data entries carry a gated flag when
        # state.syncBlocking is true; they render dimmed with a
        # "(syncing...)" suffix but stay selectable.
        choice = select(fullMenu(state.syncBlocking))
        Quit               -> break
        Sync status        -> screens/status.run(store); continue   # never gated
        Sign in / account  -> screens/login.run(); continue
        Configure clients  -> runInstall({fromApp:true}); continue
        <data screen>:
            if state.syncBlocking:
                print friendly blocked message (mirror syncBlockedMessage:
                "Sync in progress (N left, ~M min). Meeting data unlocks when it
                finishes - pick Sync status to watch progress.")
                continue
            else:
                screens/<x>.run(store, client); continue

  cleanup: store.close(); return   # caller does process.exit(0)
```

State summary:

- BOOT / non-TTY guard - refuses to launch an interactive prompt without a
  terminal (defense in depth; `cli.ts` already short-circuits this path).
- LOGGED_OUT - offers sign-in first (plus configure and quit). This is the
  "offer login first" behavior; after a successful login the loop re-evaluates
  and drops into the full menu.
- LOGGED_IN (normal) - full menu, all screens live.
- LOGGED_IN + syncBlocking - a flavor of the full menu: `status`, `login`,
  `configure`, and `quit` stay available; the seven data screens are gated with
  a friendly message pointing at Sync status. Because the loop recomputes state
  each turn, the gate clears automatically once the daemon clears `blocking`.
- QUIT - exit loop, `store.close()`, return to `cli.ts` which calls
  `process.exit(0)`.

Cancelling any `select`/`input` (Esc / Ctrl-C) inside a screen returns to the
menu; cancelling the top-level menu is equivalent to Quit.

## Non-interactive detection

Two layers, matching the existing pattern in `install.ts` (which already guards
`process.stdin.isTTY`):

1. `cli.ts` bare path checks `process.stdin.isTTY && process.stdout.isTTY`
   before importing the app. If either is false (piped, redirected, CI), it
   prints `bareHint()` and exits 0 - it never opens a prompt that would hang.
2. `runApp()` re-checks the same guard at entry and returns immediately with the
   hint if somehow reached without a TTY.

This keeps `sana-mcp | cat`, cron, and `$(sana-mcp)` safe while preserving the
one-shot tool path (`sana-mcp <tool>`), which is designed for pipes and is
unaffected.

## File list

New:

- `src/app/app.ts` - `runApp()`, the main-menu loop / state machine.
- `src/app/session.ts` - `getAppState()` structured login+sync state.
- `src/app/render.ts` - human formatting (meeting tables, transcript lines,
  status) from structured rows.
- `src/app/screens/search.ts`, `list.ts`, `status.ts`, `read.ts`, `summary.ts`,
  `participants.ts`, `recording.ts`, `login.ts` - one screen per action.
- `src/sana/auth.ts` - structured login core (`requestCode`, `verifyCode`,
  `startCatchupSync`) shared by the app and `dispatch.ts`.

Modified:

- `src/cli.ts` - replace `bareInvocation -> runInstall` with the `bareApp`
  routing above; add `.aliases(["config","configure"])` to the `install`
  command.
- `src/install/install.ts` - add `fromApp?: boolean` to `InstallOpts` /
  `runInstall` to skip `maybeLogin()` and the closing hint when invoked from the
  app menu.
- `src/tools/dispatch.ts` - (separate agent's concern; optional) refactor
  `handleLogin` to call `src/sana/auth.ts` so the login side-effects have one
  home. The string output of `dispatch.ts` is otherwise unchanged.

Unchanged: `src/mcp.ts`, `src/daemon-main.ts`, `src/sync/*`, `src/store/db.ts`,
`src/tools/help.ts`, `src/install/wizard-prompt.ts`.
