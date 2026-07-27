---
status: superseded
scope: former installer and configurer presentation proposal
last_verified: 2026-07-24
superseded_by: remediation-plan.md
---

# Installer Flow Polish

Redesign of the one-line install experience (`install.sh` / `install.ps1` plus
the `sana-mcp install` configurer) so it reads as ONE cohesive, in-place flow
instead of a log-like scroll of appended lines.

Scope: the installer path only. The interactive app menu, the low-level
rendering primitives, the MCP-vs-human presentation split, and each individual
app screen are owned by other agents; this doc consumes their outputs and calls
out the boundaries. It designs the installer's *use* of a live checklist and the
exact human copy for every installer screen.

Note on punctuation: prose uses hyphens only (no em/en dashes). Horizontal
rules drawn from box-drawing characters (`─`) are decorative TUI elements, not
punctuation; if even those are unwanted, swap them for a row of `=`.

## What the user saw, and why it is ugly

```
Downloading sana-mcp v0.3.2 (x64)
  [########################] 100%  95.5/95.5 MB  3.4 MB/s  ETA 00:00
Checksum verified.
Installed -> C:\Users\lael\AppData\Local\sana-mcp\sana-mcp.exe

✔ Configure sana-mcp for your AI clients

  + Claude Desktop: registered -> ...(quit and restart Claude Desktop)
  + Claude Code (CLI): registered (restart Claude Code sessions)
  + Cursor: registered -> ...(restart Cursor)
  + Gemini CLI: registered -> ...(restart Gemini CLI sessions)
  + VS Code (Copilot): registered -> ...(reload VS Code (or restart Copilot chat))
✔ Sign in to Sana now? ... Yes
✔ Email for your Sana account: you@example.com
A 6-digit sign-in code was just emailed to you@example.com.

Next: get that code, then call
  meeting_transcripts("login", {"email":..., "confirmation_code": <the 6 digits>})
✔ Enter the 6-digit code from your email: 481567
```

Concrete defects:

1. Two owners print into the same screen with different styles: the shell script
   emits `Checksum verified.` / `Installed ->` / `Added ... to PATH` as bare log
   lines, then the binary emits its own header, blank lines, and result lines.
   There is no unifying frame.
2. The per-client outcome is five appended `+ Client: registered -> (hint)`
   lines. Each carries a different parenthetical reload hint, so the block is
   ragged and hard to scan.
3. A blank line falls between the collapsed wizard title and the results block
   (from `console.log("")` at `install.ts:233`), and another before the wizard
   title, so spacing is inconsistent.
4. The sign-in step prints the raw MCP/LLM string from `sana("login", ...)` -
   the `Next: ... meeting_transcripts("login", {...})` block - straight at the
   human. (The presentation-split agent is removing that leak; this design
   assumes it is gone and specifies the human copy that replaces it.)
5. There is no closing "you are all set / here is how to use it" screen. The flow
   just stops after the code prompt.

## Design principle: one screen, one owner

The download is inherently a shell-script job (it runs before the binary
exists). Everything *after* the bytes land is the binary's job. So:

- The **script** prints the minimum: a one-line header and the progress bar.
  Checksum, move, and PATH edits become *silent on success* (they still fail
  loudly). Their outcomes are handed to the binary as environment variables.
- The **binary**, launched with a new `--from-installer` flag, does a soft
  screen reset and renders the entire post-download experience as a sequence of
  unified screens: a Welcome + install summary, the client checklist, the
  sign-in step, and a final success screen.

"Soft screen reset" = `\x1b[H\x1b[J` (home + clear-to-end) when
`stdout.isTTY`, NOT the alternate screen buffer. This makes the Welcome screen
the first thing the eye lands on (the transient download lines scroll away) while
preserving scrollback. On a non-TTY it is a no-op and the `--from-installer`
path degrades to plain lines.

### Script -> binary handoff contract

The script sets these before exec, so the binary can render an accurate install
summary without re-deriving anything:

| Env var | Meaning | Example |
|---|---|---|
| `SANA_MCP_FROM_INSTALLER` | tells the binary to render the installer frame | `1` |
| `SANA_MCP_INSTALLED_VERSION` | resolved release tag | `v0.3.2` |
| `SANA_MCP_INSTALLED_PATH` | absolute path of the placed binary | `C:\Users\lael\AppData\Local\sana-mcp\sana-mcp.exe` |
| `SANA_MCP_INSTALLED_TARGET` | platform-machine | `windows-x64` |
| `SANA_MCP_CHECKSUM` | `verified` or `unverified` | `verified` |
| `SANA_MCP_PATH_ADDED` | `1` only when PATH was newly modified | `1` |

The exec itself becomes:

- POSIX: `"$dest" install --from-installer < /dev/tty > /dev/tty 2>&1`
- Windows: `& $dest install --from-installer`
- Unattended (`SANA_MCP_YES=1`): `"$dest" install --from-installer --yes`

`--from-installer` is a new boolean on `InstallOpts` (sibling of the planned
`fromApp` from `cli-app-architecture.md`). It differs from `--yes` (which is
about skipping prompts) and from `fromApp` (which suppresses login + closing
text because the app owns those). `--from-installer` turns ON the Welcome frame,
the install-summary block, and the final success screen.

## The screen sequence

### Screen 0 - download (script-owned)

Keep the existing progress bar; only tighten the surrounding copy so it matches
the binary's two-space indent and lower-case-after-first-word style.

```
  sana-mcp installer

  Downloading v0.3.2  (windows-x64)
  [########################] 100%  95.5/95.5 MB  3.4 MB/s  ETA 00:00
```

That is the ENTIRE script output on the happy path. No `Checksum verified.`,
no `Installed ->`, no `Added ... to PATH`. The binary restates all of it in
Screen 1, so printing it here too is the duplication that made the flow feel
log-like.

### Screen 1 - Welcome + what was installed (binary, after soft reset)

```
  ─────────────────────────────────────────────────────
   Welcome to sana-mcp
   Search and read your Sana.AI meeting transcripts
   from any AI client.
  ─────────────────────────────────────────────────────

   Installed   v0.3.2  ->  ...\sana-mcp\sana-mcp.exe
   Verified    checksum OK  -  added to PATH (open a new terminal to use it)
```

Copy rules for the summary line:

- Path is middle-elided to keep it on one line at 80 columns (leading `...`
  when it exceeds the width). Full path is available via `sana-mcp help`.
- Line 2 is assembled from the env vars: drop "checksum OK" and print
  "checksum not verified" (dim) when `SANA_MCP_CHECKSUM=unverified`; drop the
  "added to PATH" clause entirely when `SANA_MCP_PATH_ADDED` is unset (already
  on PATH). Never show an empty "Verified" line - if neither clause applies,
  omit the whole line.

Then one blank line, then Screen 2.

### Screen 2 - configure AI clients (live checklist)

The existing toggle wizard (`wizard-prompt.ts`) still runs to choose clients;
that module is unchanged (coordinate with its owner only on the spacing fix
below). What changes is what happens AFTER the user hits enter: the block at
`install.ts:230-241` that prints five appended `+ ...` lines is replaced by a
LIVE checklist that mutates in place.

Header + rows (rendered by the primitive; see "Rendering primitive" below):

```
   Configuring your AI clients

   [OK]  Claude Desktop      registered
   [OK]  Claude Code (CLI)   registered
   [ .]  Cursor              registering...
   [  ]  Gemini CLI          pending
   [  ]  VS Code (Copilot)   pending
```

Each row transitions through states as `applyClient` / `applyRemove` runs for
that client:

| State | When | Recommended glyph | Colour |
|---|---|---|---|
| pending | queued, not started | `[  ]` | dim |
| active | this client is being written / CLI is running | `[ .]` (or spinner) | cyan |
| done (enabled) | `ApplyResult.status === "ok"`, desired on | `[OK]` | green |
| done (removed) | ok, desired off | `[--]` | yellow |
| noop | already in the wanted state | `[==]` | dim |
| skipped | not writable / CLI not found | `[--]` | dim |
| failed | write / command threw | `[XX]` | red |

Right-hand status text is short and consistent (`registered`,
`already set`, `removed`, `skipped: <reason>`, `failed: <reason>`). The
per-client *reload hints* are NOT shown here anymore - that is what made the old
block ragged. They move, grouped, to the success screen.

The active-state matters because command-based clients (Claude Code, Codex,
Amazon Q) shell out to a real CLI and can take a second or two; file-based
clients flip near-instantly. Iterate clients sequentially so exactly one row is
`active` at a time - that motion is the "it is working" signal.

Spacing fix to coordinate with the wizard owner: on submit, the wizard collapses
to a single `✔ Configure your AI clients` line; the checklist header should
follow after exactly one blank line, and there should be no blank line between
the checklist header and its first row. (Today there are inconsistent blanks on
both sides.)

### Screen 3 - sign in to Sana

This step must NOT print any MCP/LLM string. It calls the structured login core
(`src/sana/auth.ts` `requestCode` / `verifyCode`, introduced by
`cli-app-architecture.md`) and renders its own human copy. `maybeLogin` in
`install.ts` is rewritten to use that core instead of
`console.log(await sana("login", ...))`.

Already-signed-in short-circuit (dim, then straight to Screen 4):

```
   Already signed in to Sana as you@example.com.
```

Not signed in:

```
   Sign in to Sana

   Sign in now, or skip and let your AI agent sign you in the
   first time you ask it about a meeting.

   ? Sign in now?  Yes
   ? Email         you@example.com

   Sent a 6-digit code to you@example.com.

   ? Code          481567

   Signed in as you@example.com.
```

Copy for the branches:

- Declined at "Sign in now?": `Skipped. Your agent will ask for your email and
  a sign-in code the first time it needs them.` (dim)
- Empty email: `No email entered - skipping sign-in. You can sign in later with
  sana-mcp (the interactive app) or from your agent.` (dim)
- Empty code after a code was sent: `No code entered. Run sana-mcp to finish
  signing in, or sign in from your agent later.` (dim)
- `verifyCode` failure: `That code did not match. Run sana-mcp to try again.`
  (do not loop the prompt here; the installer stays short - the app owns retry.)

The old leaked block
(`Next: get that code, then call meeting_transcripts("login", {...})`) is gone:
the installer already collected the code inline, so there is nothing for the
human to "call".

### Screen 4 - you are all set (success)

Rendered only under `--from-installer` (the app menu path suppresses it). Pulls
the reload hints, grouped, from the clients that were successfully configured
this run.

```
  ─────────────────────────────────────────────────────
   You are all set
  ─────────────────────────────────────────────────────

   Configured   Claude Desktop, Cursor, VS Code (Copilot),
                Claude Code (CLI), Gemini CLI
   Signed in    you@example.com

   One more step - restart these so they load sana-mcp:
     Quit and reopen   Claude Desktop, Cursor, VS Code
     New session       Claude Code, Gemini CLI

   Then just ask your agent about a meeting, for example:
     "Summarize my last meeting with Acme."

   Manage sana-mcp anytime:
     sana-mcp          open the interactive app (search, read, sync status)
     sana-mcp config   add or remove AI clients
     sana-mcp help     one-shot commands for scripts
```

Grouping logic for the restart block, derived from `ClientDef.reloadHint`:

- "Quit and reopen" bucket: clients whose hint says quit/restart the GUI app
  (Claude Desktop `quit and restart`, Cursor `restart Cursor`, VS Code
  `reload VS Code`).
- "New session" bucket: CLI clients whose hint says restart sessions (Claude
  Code, Gemini CLI, Codex, Amazon Q).
- Omit clients whose hint says it reloads automatically (Windsurf, Zed) - do not
  ask the user to do nothing.
- If nothing needs a manual restart, drop the "One more step" block entirely.

The `Signed in` line is omitted when the user skipped sign-in; replace it with a
one-liner: `Not signed in yet - your agent will prompt you, or run sana-mcp.`

## Rendering primitive (referenced, not designed here)

The live checklist is drawn by a primitive the rendering-primitives agent owns,
expected to live in `src/app/render.ts` (the human-formatting module defined by
`cli-app-architecture.md`). This design only depends on a small contract:

- Create a checklist from an ordered list of rows, each `{ id, label }`.
- `update(id, state, detail?)` re-renders the whole block IN PLACE (cursor up N
  lines, clear to end, repaint) rather than appending. States are the seven in
  the table above; `detail` is the right-hand status text.
- It is a no-op-friendly "live region": on a non-TTY it falls back to printing
  each row once, in its final state, with no cursor movement.

The installer supplies the rows (the acted-on clients, in menu order) and the
copy; the primitive decides glyphs, colour, spinner frames, and the redraw
mechanics. Same primitive can back the download bar's look if the two agents want
one visual language, but the download stays script-side.

## Style rules the installer frame enforces

- Two-space indent for every content line (three inside the ruled Welcome /
  success blocks to sit under the rule). No mixed indentation.
- Exactly one blank line between logical blocks; never two, never zero.
- First word of a line capitalised, rest lower-case unless a proper noun.
- Arrows and separators are ASCII (`->`, `-`, `|`); no unicode dashes.
- Colour is accent only (green ok, red fail, cyan active, dim secondary); the
  layout must read fine with colour stripped (piped / `NO_COLOR`).

## Fallback paths (must stay clean)

- **Non-TTY / piped** (`curl | sh` with no `/dev/tty`, CI): the script keeps its
  existing "Installed. Run 'sana-mcp' ..." hint and does NOT exec the
  configurer. `--from-installer` on a non-TTY prints the same screens as plain,
  unanimated lines (no soft reset, checklist rows printed once).
- **`SANA_MCP_YES=1`**: `--from-installer --yes`. Screens 1, 2 (as a
  non-interactive checklist that just prints final states), and 4 render; the
  toggle wizard and Screen 3 (sign-in) are skipped. Screen 4 adds:
  `Sign in with sana-mcp when you are ready.`
- **Checksum unverified**: Screen 1 shows `checksum not verified` in dim rather
  than hiding it - honest, not alarming.
- **No clients detected**: skip Screen 2's checklist; Screen 4 replaces the
  Configured line with `No AI clients detected yet. Install one (Claude Desktop,
  Cursor, VS Code, ...) then run sana-mcp config.`
- **A client fails**: its row ends `[XX] failed: <reason>`; Screen 4 still
  renders, listing only the clients that succeeded, plus:
  `Some clients could not be configured - run sana-mcp config to retry.`

## Changes required (by file, with ownership)

Installer-owned (this design):

- `install.sh` - drop the `Checksum verified.` / `Installed ->` /
  `Added ... to PATH` echoes on success; export the handoff env vars; exec
  `"$dest" install --from-installer` (keep the non-TTY and `--yes` branches).
- `install.ps1` - same: remove `Write-Host "Checksum verified."` /
  `"Installed -> ..."` / the PATH echo; set the env vars via `$env:`; call
  `& $dest install --from-installer`. `$ProgressPreference =
  "SilentlyContinue"` stays. Keep drawing the custom bar.
- `src/cli.ts` - add `--from-installer` to the `install` command's options and
  pass it into `runInstall`.
- `src/install/install.ts` - add `fromInstaller?: boolean` to `InstallOpts`;
  when set, do the soft reset + Screen 1, drive Screen 2 through the checklist
  primitive instead of the `acted.forEach` loop, and render Screen 4. Rewrite
  `maybeLogin` to call `src/sana/auth.ts` and print Screen 3's human copy (no
  `sana("login")`).

Owned by other agents (coordinate, do not duplicate):

- Rendering-primitives agent: the checklist / live-region primitive in
  `src/app/render.ts`.
- Presentation-split agent + `src/sana/auth.ts`: structured `requestCode` /
  `verifyCode` so the sign-in step never prints MCP text.
- Wizard owner (`wizard-prompt.ts`): the one-blank-line spacing around the
  collapsed title (only coordination point; no behaviour change).
- App-menu agent (`cli-app-architecture.md`): `fromApp` already suppresses login
  and closing text; `fromInstaller` is the complementary flag that turns the
  installer frame ON.
</content>
</invoke>
