---
status: superseded
scope: former app-shell and CLI implementation sketch
last_verified: 2026-07-24
superseded_by: remediation-plan.md
---

# Analysis: app shell + CLI routing (de-risk)

Read-only analysis for a downstream dev implementing the interactive `sana-mcp`
app shell (`src/app/app.ts` `runApp()`, `src/app/session.ts`) and the `src/cli.ts`
bare-invocation routing. Goal: a clean implementation with no smells. All
punctuation is hyphens only.

Scope confirmed against the current tree:

- `src/sana/auth.ts` ALREADY EXISTS with `requestCode(client,email,ws?)` and
  `verifyCode(client,store,email,code)`. `verifyCode` already does
  `submitSignInCode + save + resetFailures + updateSyncState({blocking:1,
  catchup_epoch_ms}) + ensureDaemonRunning`. The login screen must call these,
  NOT re-implement the side-effects and NOT go through `sana("login", ...)`.
- `src/core/status.ts` ALREADY EXPORTS `sessionInfo(client,s)`,
  `sessionUsable`, `isBlocking(s)`, and `computeStatus(client,store)`.
  `getAppState()` must reuse these, not restate the predicates.
- `@inquirer/prompts` 8.5.2, `@inquirer/core` 11.x, `@inquirer/ansi` 2.x are
  installed. `select` and `Separator` are exported from `@inquirer/prompts`.
  `ExitPromptError` is exported from `@inquirer/core` only (NOT re-exported by
  `@inquirer/prompts`) - import it from `@inquirer/core`.

---

## 1. The exact `src/cli.ts` edit

Only the default `[tool] [json]` action changes, plus one alias line. Commander
matches the named subcommands (`daemon`, `install`, `uninstall`, `mcp`) before
the default action, so those are untouched. `--help` / `--version` remain
commander built-ins.

### 1a. Add aliases to the `install` command (optional, per architecture doc)

In the `program.command("install")` chain, after `.description(...)`:

```ts
  .aliases(["config", "configure"])
```

Nothing else in that command changes. (Skip if the team does not want the
aliases; it does not affect routing.)

### 1b. Replace the bare block in the default action

Replace the current lines (the `bareInvocation` const through its
`if (bareInvocation) { ... }` block, currently lines 68-82) with:

```ts
    // Bare `sana-mcp` (no tool, no meaningful flags) launches the interactive app.
    const bareApp =
      !tool &&
      !json &&
      !opts.email &&
      !opts.code &&
      !opts.id &&
      !opts.limit &&
      !opts.query &&
      opts.timestamps !== false;

    if (bareApp) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const { runApp } = await import("./app/app.js");
        await runApp();
        process.exit(0);
      }
      // Non-interactive (piped / redirected / CI): never open a prompt that hangs.
      console.log(bareHint());
      process.exit(0);
    }
```

Everything after this block (the `json` parse, the flag mapping into `args`, and
`const out = await sana(tool ?? "help", args)`) stays byte-for-byte identical.

Add one small local helper near the top of the file (module scope):

```ts
function bareHint(): string {
  return [
    "sana-mcp is an interactive app - run it in a terminal to browse your meetings.",
    "For scripting, run `sana-mcp help` to see the one-shot tools (status, list, read, search).",
  ].join("\n");
}
```

### 1c. Why nothing else breaks

- The predicate is the SAME shape already in production (`bareInvocation`), just
  renamed and re-targeted, so its flag coverage is unchanged. `opts.timestamps
  !== false` is correct: commander sets `opts.timestamps === false` only when
  `--no-timestamps` is passed; otherwise it is `undefined`.
- `sana-mcp help` / `status` / `list '{...}'` -> `tool` is truthy -> `bareApp`
  false -> falls through to the unchanged one-shot path.
- `sana-mcp read --id X` -> `opts.id` set -> `bareApp` false -> one-shot.
- `sana-mcp --limit 5` (flags, no tool) -> `opts.limit` set -> `bareApp` false
  -> unchanged legacy `sana("help", args)` behavior.
- `sana-mcp | cat`, `$(sana-mcp)`, cron -> `bareApp` true but not a TTY ->
  prints `bareHint()`, exit 0. Never opens a prompt.
- Subcommands are matched by commander before the default action fires, so
  `install` / `uninstall` / `mcp` / `daemon` are untouched.
- The dynamic `import("./app/app.js")` matches the existing `.js`-suffixed
  dynamic-import convention used for `install`, `mcp`, `daemon`.

---

## 2. `runApp()` state machine

### 2a. Navigation model: call-stack-as-nav-stack (recommended)

Do NOT build an explicit nav-stack data structure. `@inquirer` `select`/`input`
resolve exactly once, which maps cleanly onto async function calls: the JS call
stack IS the nav stack.

- The top menu is a `while (true)` loop. Each iteration: recompute state, render
  one `select`, `await` the chosen screen function, then loop (that return is the
  "pop back to menu").
- Drill-ins nest as awaited calls: `list.run()` internally awaits
  `meetingActions.run()` which internally awaits `read.run()`. Returning from
  `read` pops to `actions`; returning from `actions` pops to `list`; returning
  from `list` pops to the menu. No bookkeeping.
- A SEARCH hit opening READ is just `search.run()` awaiting `read.run(...,
  {initialLine})`; READ returning pops back into SEARCH (its own frame), which is
  exactly the desired behavior (Esc from READ returns to SEARCH, not to the
  meeting ACTIONS submenu).
- LIST preserving its filter/sort/page across a round-trip into ACTIONS is
  local state in the LIST frame (it is still on the stack while ACTIONS runs), so
  it survives for free.

Breadcrumbs (the header line 2 in cli-feature-screens 0.2) are threaded as a
`crumbs: string[]` parameter passed down the call chain, each screen appending
its own crumb for its header render. This carries the nav path without a
separate stack object.

Recommendation rationale: an explicit stack of screen descriptors plus a
dispatch switch would duplicate what the language already gives you and invites
desync bugs (stack vs actual awaited call). The only thing an explicit stack
would buy - arbitrary non-adjacent jumps - is not in the design. Use the call
stack.

### 2b. Store and client lifecycle

- `SanaStore`: ONE instance for the whole app. Open at the top of `runApp`,
  pass it into every screen, `close()` it once in a `finally` when the loop
  exits (covers Quit AND an uncaught throw). SQLite handle is heavy; never
  open-per-screen (that is the dispatcher's model, wrong for a long-lived app).
- `SanaClient`: reload with `SanaClient.load()` at the TOP of each loop
  iteration and pass that fresh instance into the iteration's screens. Rationale:
  the session file is the source of truth and it changes during a session (the
  login screen calls `client.save()`); a per-iteration `load()` is a cheap
  small-JSON read and guarantees `getAppState` and the screens see the current
  session with zero manual cache-invalidation. The login screen mutates and
  saves the instance it is handed; the next iteration reloads and reflects it.

### 2c. `getAppState()` in `src/app/session.ts`

Thin wrapper over `core/status.ts` - do not re-derive the predicates:

```ts
import { sessionInfo, isBlocking } from "../core/status.js";
import type { SanaClient } from "../sana/client.js";
import type { SanaStore, SyncState } from "../store/db.js";

export interface AppState {
  loggedIn: boolean;   // hasCookie && phase !== "needs_login"
  expired: boolean;    // hasCookie && phase === "needs_login"
  syncBlocking: boolean;
  sync: SyncState;
}

export function getAppState(client: SanaClient, store: SanaStore): AppState {
  const sync = store.getSyncState();
  const s = sessionInfo(client, sync);
  return { loggedIn: s.loggedIn, expired: s.expired, syncBlocking: isBlocking(sync), sync };
}
```

No string matching anywhere (this is the whole point - it replaces
`install.ts`'s `maybeLogin` regex scrape of the status string).

### 2d. The loop (implementation-ready pseudocode)

```ts
import { select, Separator } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import { SanaClient } from "../sana/client.js";
import { SanaStore } from "../store/db.js";
import { getAppState } from "./session.js";
import { estimateMinutes } from "../core/args.js";
// screen modules: ./screens/{status,list,search,read,summary,participants,recording,login}.js
// installer: ../install/install.js runInstall

export async function runApp(): Promise<void> {
  // Defense in depth; cli.ts already gated this path.
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.log(bareHint());   // same copy as cli.ts (share it)
    return;
  }

  const store = new SanaStore();
  try {
    while (true) {
      const client = SanaClient.load();            // fresh per iteration (2b)
      const state = getAppState(client, store);

      // ---- LOGGED OUT / EXPIRED: minimal menu ----
      if (!state.loggedIn || state.expired) {
        const choice = await menu([
          { name: state.expired ? "Sign in again (session expired)" : "Sign in to Sana", value: "login" },
          { name: "Configure AI clients", value: "configure" },
          new Separator(),
          { name: "Quit", value: "quit" },
        ]);
        if (choice === QUIT) break;                 // Ctrl-C at menu => quit
        if (choice === "quit") break;
        if (choice === "login")     { await login.run(store, client); continue; }
        if (choice === "configure") { await runInstall({ fromApp: true }); continue; }
        continue;
      }

      // ---- LOGGED IN: full menu ----
      const gated = state.syncBlocking;
      const choice = await menu([
        { name: dataLabel("Search transcripts", gated), value: "search" },
        { name: dataLabel("List meetings",      gated), value: "list" },
        { name: "Sync status",                          value: "status" },   // never gated
        new Separator(),
        { name: dataLabel("Read a transcript", gated), value: "read" },
        { name: dataLabel("Meeting summary",   gated), value: "summary" },
        { name: dataLabel("Participants",      gated), value: "participants" },
        { name: dataLabel("Recording link",    gated), value: "recording" },
        new Separator(),
        { name: "Sign in / account",   value: "login" },      // never gated
        { name: "Configure AI clients", value: "configure" }, // never gated
        new Separator(),
        { name: "Quit", value: "quit" },
      ]);

      if (choice === QUIT || choice === "quit") break;

      // Always-live entries first.
      if (choice === "status")    { await status.run(store, client); continue; }
      if (choice === "login")     { await login.run(store, client); continue; }
      if (choice === "configure") { await runInstall({ fromApp: true }); continue; }

      // Data entries: re-check gate at selection time (state can change while the
      // menu is on screen). If blocking, show the friendly panel instead of the
      // screen; the loop then recomputes and the gate auto-clears when the daemon
      // clears `blocking`.
      if (state.syncBlocking) { await showBlockedPanel(store); continue; }

      switch (choice) {
        case "search":       await search.run(store, client); break;
        case "list":         await list.run(store, client); break;
        case "read":         await read.run(store, client); break;
        case "summary":      await summary.run(store, client); break;
        case "participants": await participants.run(store, client); break;
        case "recording":    await recording.run(store, client); break;
      }
      // loop -> menu repaints with fresh state
    }
  } finally {
    store.close();   // runs on Quit, on Ctrl-C-at-menu (break), and on any throw
  }
}
```

`menu(choices)` wraps `select({ message: "...", choices })` in the cancellation
helper (section 3) and returns either the chosen `value` or the `QUIT` sentinel
(Ctrl-C at the menu = quit). See section 5 for `dataLabel` and the menu-entry
model, section 4 for `showBlockedPanel`.

State summary (matches cli-app-architecture "Main-menu state machine"):

- BOOT / non-TTY guard - returns immediately with the hint (belt and braces;
  `cli.ts` already short-circuits).
- LOGGED_OUT / EXPIRED - minimal menu: sign in, configure, quit.
- LOGGED_IN - full menu, all live.
- LOGGED_IN + syncBlocking - full menu but the six data entries are dimmed and
  route to the blocked panel; status/login/configure/quit stay live. Because the
  loop recomputes state each turn, the gate clears itself once the daemon clears
  `blocking`.
- QUIT - break, `store.close()` in finally, return; `cli.ts` calls
  `process.exit(0)`.

---

## 3. Cancellation contract

Facts about the installed prompts (verified in node_modules):

- Stock `select` handles up/down/enter/number/backspace only. Stock `input`
  handles line editing + enter. NEITHER has an Escape keypress handler - Esc does
  nothing in stock prompts. The ONLY rejection path is Ctrl-C (SIGINT), which
  rejects with `ExitPromptError` (from `@inquirer/core`).
- Custom `createPrompt` screens (the LIST browser and the READ pager, per
  cli-feature-screens 11) CAN bind Esc/q via `useKeypress` and resolve a back
  sentinel of their own.

So there are two back mechanisms and one universal cancel. The shell provides one
helper used everywhere:

```ts
// src/app/nav.ts
import { ExitPromptError } from "@inquirer/core";

export const BACK = Symbol("back");
export const QUIT = Symbol("quit");

/** Await a prompt; translate Ctrl-C (ExitPromptError) into BACK. Re-throw
 *  anything else. Screens map BACK to "return to caller"; the top menu maps it
 *  to QUIT. */
export async function cancelable<T>(p: Promise<T>): Promise<T | typeof BACK> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ExitPromptError) return BACK;
    throw e;
  }
}
```

Contract for callers:

- Inside a screen: wrap every stock prompt in `cancelable`. On `BACK`, the
  screen `return`s (pops one frame). Screens ALSO offer an explicit "Back" choice
  in their `select` menus - that is the discoverable, primary back path, because
  stock prompts have no Esc. Ctrl-C is the always-available fallback.
- At the top menu: `menu()` maps `BACK` (Ctrl-C) to the `QUIT` sentinel, so
  Ctrl-C at the menu quits the app (loop `break` -> `store.close()` in finally).
- Custom prompts (LIST, READ): bind Esc and q in `useKeypress` to `done(...)`
  with their own back result, and ALSO let Ctrl-C flow through as
  `ExitPromptError` (createPrompt handles SIGINT natively). Their `run()`
  wrappers normalize both into a plain `return`.

Semantics chosen (reconciling the two design docs): a cancel INSIDE a screen
means "back one level", a cancel AT the menu means "quit". This is
cli-app-architecture's model ("Cancelling any select/input inside a screen
returns to the menu; cancelling the top-level menu is equivalent to Quit") and it
is the only model that makes back reachable from the Esc-less stock `input`
screens (login email/code, search query). cli-feature-screens 0.3 labels Ctrl-C
"immediate quit"; if the team prefers that stricter behavior instead, do NOT
catch `ExitPromptError` in `cancelable` - let it propagate to a single top-level
`try/catch` in `runApp` that runs `store.close()` and returns. Recommended:
the back-then-quit model above (friendlier, and every screen still has a working
back).

One nuance to document for the implementer: because Ctrl-C from a deep screen
pops ONE level, walking out of a nested READ takes repeated Ctrl-C (or the
explicit Back choices). That is intended.

---

## 4. Gating (data screens during a blocking sync)

Gate condition: `getAppState().syncBlocking` (i.e. `getSyncState().blocking ===
1`). Always-live entries (never gated): Sync status, Sign in / account, Configure
AI clients, Quit. Gated when blocking: Search, List, Read, Summary, Participants,
Recording.

The blocked panel (`showBlockedPanel`) mirrors the dispatcher's gate but
friendly, using the SAME arithmetic already centralized in
`core/args.ts#estimateMinutes` and `core/status.ts`:

```ts
async function showBlockedPanel(store: SanaStore): Promise<void> {
  const s = store.getSyncState();
  const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
  const mins = estimateMinutes(remaining);       // Math.max(1, ceil(remaining*0.5/60))
  const body =
    s.transcripts_total === 0
      ? "Building your meeting list..."
      : `Downloading your transcripts: ${s.transcripts_done} / ${s.transcripts_total} done, about ${mins} min left.`;
  // Render:
  //   Sync in progress
  //   <body>
  //   Meeting data unlocks when this finishes - pick "Sync status" to watch progress.
  //   [ View status (live) ]   [ Back to menu ]
  // "View status" -> await status.run(store, client); either way, return.
}
```

Auto-unblock: two layers, both already supported by the design.

1. Menu-level: because the loop recomputes `getAppState()` every iteration, the
   moment the daemon clears `blocking` the data entries un-dim and route to the
   real screens with no restart.
2. Panel-level (optional but specified in cli-feature-screens 0.4): while the
   blocked panel is shown, re-poll `getSyncState()` every ~1s; when `blocking`
   flips to 0, auto-dismiss the panel and fall through into the real screen. If
   implemented, do it as a `createPrompt` view owning a `useEffect` interval (the
   STATUS-screen technique), not a busy loop.

Note the eventual data screens ALSO re-check the gate on entry
(cli-feature-screens 0.4) since state can change between menu render and screen
entry - the menu gate is an optimization, the screen gate is the guarantee.

---

## 5. Menu library and the menu-entry model

Use stock `@inquirer/prompts` `select` for all menus (already a dependency).

- Grouping: `Separator` (exported from `@inquirer/prompts`) between the data
  entries and the account/system entries, as shown in 2d. `new Separator()` for a
  blank rule, `new Separator("-- label --")` for a labeled one.

- Gated (dimmed) entries: do NOT use `select`'s `disabled` choice option. A
  `disabled` choice is NOT selectable - `select` skips it on navigation and
  throws `ValidationError` if ALL choices are disabled - so it cannot route to the
  blocked message. Instead a gated entry is a NORMAL, selectable choice whose
  NAME carries a dim `(syncing...)` suffix, and the loop routes it to
  `showBlockedPanel` based on `state.syncBlocking`:

  ```ts
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;   // reuse install.ts palette
  function dataLabel(label: string, gated: boolean): string {
    return gated ? `${label} ${dim("(syncing...)")}` : label;
  }
  ```

  This matches cli-app-architecture: "render dimmed with a (syncing...) suffix
  but stay selectable". Selecting a dimmed entry shows the friendly panel; it is
  never a dead end.

- `select` choice shape used: `{ name, value, description? }`. `value` is the
  route key consumed by the loop's switch. Optional `description` (shown by
  `select` under the list) can add a one-line hint, e.g. "Locked until the
  first sync finishes" on gated rows.

- The `menu()` wrapper: `const v = await cancelable(select({ message, choices,
  pageSize })); return v === BACK ? QUIT : v;` (Ctrl-C at menu = quit).

`disabled` remains fine for the meeting-ACTIONS submenu annotations that are
genuinely unavailable (e.g. "Read transcript (not downloaded yet)") - but
cli-feature-screens 2 chooses to keep those selectable-with-annotation too, so
they can show an empty state rather than being unpickable. Prefer selectable +
annotate over `disabled` throughout, to avoid dead ends.

---

## 6. `fromApp` flag on `runInstall`

Add `fromApp?: boolean` to `InstallOpts` and guard exactly two things in the
interactive path of `runInstall` (`src/install/install.ts`):

- The trailing sign-in prompt (currently `await maybeLogin();`, line 244):
  ```ts
  if (!opts.fromApp) await maybeLogin();
  ```
  The app owns a dedicated LOGIN screen; the installer must not run its own
  string-scraping `maybeLogin` when launched from the app.

- The closing "All set. Run `sana-mcp` anytime..." line (line 246):
  ```ts
  if (!opts.fromApp)
    console.log(`\nAll set. Run ${C.cyan("sana-mcp")} anytime to reconfigure clients or sign in.`);
  ```
  The app owns the outer loop; telling the user to "run sana-mcp" while they are
  inside it is wrong.

Nothing else needs `fromApp`: the `--yes` unattended path is never reached from
the app menu (the menu calls `runInstall({ fromApp: true })` with no `yes`), and
the "no clients detected" early returns are informational. (Optional polish: also
suppress or reword the "then run `sana-mcp` again" tails in those early returns
when `fromApp`, but that is cosmetic.)

Repaint after: none needed as a special step - `runInstall` returns, the loop
`continue`s, recomputes `getAppState`, and re-renders the `select`, which
repaints the menu. Because `maybeLogin` is skipped, `runInstall({fromApp})` does
not change the session, so the badge is unchanged; the per-iteration
`SanaClient.load()` still guarantees correctness if anything else did change.

---

## 7. Smell-avoidance checklist (for the implementer)

- Do NOT import `tools/dispatch` from `app/*`. Read structured data from
  `SanaStore`/`SanaClient` and the login core in `sana/auth.ts`; format in
  `app/render.ts`. (The app never round-trips through the LLM strings.)
- Do NOT re-implement `sessionInfo`/`isBlocking`/`estimateMinutes` - import from
  `core/status.ts` and `core/args.ts`.
- Do NOT re-implement the post-login side-effects - call
  `sana/auth.ts#verifyCode` / `requestCode` (they already exist and are the
  single home for `blocking`/`catchup_epoch_ms`/daemon spawn).
- ONE `SanaStore` for the app, closed in `finally`. `SanaClient.load()` per
  iteration.
- Gated entries are selectable with a dim suffix, never `select` `disabled`.
- `ExitPromptError` is imported from `@inquirer/core`, not `@inquirer/prompts`.
- Share `bareHint()` copy between `cli.ts` and `runApp`'s guard (one source).
