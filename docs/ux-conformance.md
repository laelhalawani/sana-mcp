# UX conformance: original TypeScript vs the Go rewrite

The Go rewrite was supposed to be a port. It is not: the terminal surface was
rebuilt from description rather than from source, so colours, glyphs, spinner
timing, layout, footers and whole screens differ. This document is the
difference, screen by screen, so the port can be finished against a spec instead
of a memory.

**The original is authoritative.** Where this document and the Go code disagree,
the Go code is wrong.

## Status

The port described here has been carried out, with one correction to its own
premise: the **installer** follows interactive-terminal-mcp - one program whose
screen evolves in place, a bold blue header, short section lines, ` · ` footers
- while the **application's** screens follow the TypeScript original described
below. Building the installer as scrolling prints, as the original did, left
each finished question stranded above the current one.

`internal/tui` holds the
primitives (policy, both glyph sets, both spinner sets, raw SGR colour, the
composition helpers and the screen layout), `internal/render/text.go` the text
primitives, `internal/statusview` the one sync-status screen in its two modes,
and `internal/app` the menu, browser, documents, filters, help and search. The
alternate screen is gone.

Two things here are new rather than restored, both of them fixes for what the
port going wrong actually cost:

- `internal/store` refuses a database written by another implementation instead
  of silently applying nothing and reporting 0/0 forever.
- `internal/localstate` detects that state before the installer writes anything,
  explains it, asks, and can put it back; and `sana-mcp uninstall` removes the
  data, every binary the shipped installers wrote, and the PATH line they added.

## Provenance

The TypeScript tree was deleted in commit `7cbc646`. Any file is recoverable
with `git show 7cbc646~1:<path>`, and `git ls-tree -r 7cbc646~1 --name-only`
lists them. Working copies of the UI sources are in the session scratchpad.

Read directly and verified while writing this: `src/app/ui.ts`,
`src/app/render.ts`, `src/app/status-prompt.ts`, `src/app/app.ts`,
`src/install/wizard-prompt.ts`, and the render blocks of
`src/app/browser-prompt.ts` and `src/app/search-prompt.ts`. Line references
below are to those files.

---

# 1. Primitives

These are wrong everywhere downstream, so they come first.

## 1.1 Colour

`TerminalUi.style(open, value)` (`ui.ts`) emits `\x1b[<n>m` + text + `\x1b[0m`,
with exactly six codes:

| role | original | rewrite (`internal/tui/tui.go`) |
|---|---|---|
| dim | `\x1b[2m` (faint attribute) | 256-colour `244` |
| bold | `\x1b[1m` (bold only, **no colour**) | bold **+ colour 81** |
| green | `\x1b[32m` | 256-colour `42` |
| yellow | `\x1b[33m` | 256-colour `214` |
| red | `\x1b[31m` | 256-colour `203` |
| cyan | `\x1b[36m` | 256-colour `81` |

Nothing matches. The original uses only the eight basic SGR attributes so the
user's own terminal theme decides the hue; the rewrite pins a 256-colour
palette. Two consequences worth naming: every heading in the rewrite is
cyan-blue where the original is plain bold, and `dim` is a fixed grey where the
original is the faint attribute (grey 244 is close to invisible on a light
background; faint is not).

**Fix:** emit the raw SGR codes above. `Title` is bold with no foreground.

## 1.2 Colour suppression

```
control = outputTTY && !CI && TERM != "dumb"
color   = control && !NO_COLOR
```

When `color` is false, `style()` returns the text with **no escape bytes at
all**. The rewrite delegates to lipgloss/termenv autodetection, which does not
check `CI`, and has no policy value anything else can branch on.

## 1.3 Glyphs, and the ASCII fallback that does not exist

```
unicode: ok ✔  disable −  noop ·  skip ·  fail ✖  pending ·  pointer ❯  check ◉  uncheck ◯
ascii:   ok +  disable -  noop .  skip ~  fail x  pending .  pointer >  check [x] uncheck [ ]
truncation marker: … / ...      overflow marker: … / .
```

Selected by:

```
unicode = control && (win32 ? (WT_SESSION || TERM_PROGRAM=="vscode" || ConEmuANSI)
                            : /utf-?8/i matches LC_ALL ?? LC_CTYPE ?? LANG)
```

The rewrite has no glyph set. Literals are scattered through `app/view.go` and
`install/tui.go`, always unicode: pointer `>` (not `❯`), check `●` (not `◉`),
uncheck `○` (not `◯`), plus an invented `·` for non-selectable rows. `✔`, `✖`,
`−` appear nowhere. On a legacy code page the rewrite emits mojibake where the
original degrades to `> [x] [ ] +  x`.

## 1.4 Spinner

```
unicode: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
ascii:   - \ | /
```

The rewrite has the ten braille frames — the one thing that matches — but:

- **No ASCII fallback.**
- **Wrong rate.** The status screen advances one frame per
  `setInterval(refreshStatus, 1000)`, i.e. **1 frame/second**. The rewrite ticks
  at 120 ms, over eight frames/second.
- **Wrong lifetime.** The original replaces the spinner with green `✔` when
  complete and red `✖` when there is a problem (`status-prompt.ts`). The rewrite
  spins forever regardless of state.
- The interactive app's status screen has **no spinner at all** in the rewrite.

## 1.5 Layout: the frame

Every original screen renders a fixed-height region:

1. `width = columns - 1` — one column left free so the terminal never soft-wraps.
2. `capacity = availableRows - 2`; body sliced to it.
3. `while (rendered.length < availableRows - 1) rendered.push("")` — pad with
   blanks so **the footer always sits on the terminal's last row**.
4. Every line truncated to `width`.

The rewrite does none of this. Content is top-aligned, the footer floats under
the last content line, and long lines overflow — confirmed at 100 columns, where
the meetings footer is cut mid-word and `render.NoMatchHint` (160 chars) is
printed unwrapped.

The original also picks the footer to fit: `adaptiveFooter(width, choices)`
takes a list from longest to shortest and returns the first that fits. Every
screen has its own list; they are quoted per screen below.

## 1.6 Alternate screen

The original never uses it — `Frame` writes in place and every prompt is created
with `clearPromptOnDone: true`, so quitting leaves the terminal as it was with
scrollback intact. The rewrite passes `tea.WithAltScreen()` (`app/app.go`), so
the app takes over the screen and everything vanishes on exit.

**Fix:** drop `tea.WithAltScreen()`.

## 1.7 Text safety and measurement

- The original sanitises every interpolated value: `sanitizeTerminalText`
  strips CSI/OSC/DCS sequences, control characters and bidi overrides. The
  rewrite interpolates meeting titles, speaker names, paths and error text raw.
  A meeting title containing `\x1b[2J` clears the user's screen.
- `displayWidth` is grapheme-cluster aware with a wide-codepoint table and
  emoji/ZWJ/regional-indicator handling. `render.Truncate` counts runes, so CJK
  titles are cut at half their visual width.
- `wrapText` word-wraps with a hard-wrap fallback and an overflow marker. The
  rewrite has no wrap function at all, which is why 1.5 shows as overflow.

## 1.8 Composition helpers with no Go counterpart

```
GUTTER = "  "
row(glyph, label, detail?, hint?) -> "  " + glyph + " " + label
                                     + [": " + dim(detail)]
                                     + ["  " + dim("(" + hint + ")")]
keyHint(key, action)              -> bold(key) + " " + action
footer(hints)                     -> "" then dim(hints.join("  |  "))
frame({header, body, footer})     -> header, "", body, footer
statusGlyph(result, enabling)     -> ok? (enabling ? green ✔ : yellow −)
                                     : noop? dim · : failed? red ✖ : dim ·
```

Two things follow that the rewrite gets wrong everywhere: footers join with
**`"  |  "`** (two spaces, pipe, two spaces), not two spaces; and keys in a
footer are **bold**. The rewrite never bolds a key and never uses the pipe.

---

# 2. Installer

## 2.1 Persistent header — invented

The rewrite prints `  sana-mcp setup` (bold, colour 81, indented) on every
installer screen. The original prints `sana-mcp setup` exactly twice: as the
bold title of the live status view, and as the first line of the printed
summary. Neither is indented. The selection screen's heading is the wizard
message; the apply output has no heading.

## 2.2 Detecting / Applying screens — invented

`stepDetecting` ("Looking for AI clients...") and `stepApplying` ("Writing
client configuration...") have no counterpart. The original detects
synchronously and prints nothing; the first thing the user sees is the wizard.

## 2.3 Client-selection wizard

Original (`wizard-prompt.ts`):

```
{bold}Configure sana-mcp for your AI clients{reset}
{cyan ❯} {green ◉} {cyan Claude Code}{yellow   (will disable)}
  {◯} Codex CLI
  {dim}Not detected (manual opt-in){reset}
  {◯} Cursor

{dim}up/down move  |  space toggle  |  a all shown  |  v show undetected  |  enter confirm  |  esc/q cancel{reset}
```

- Row is `pointer + " " + box + " " + label + changed`, single spaces, **no
  leading gutter**.
- Unchecked box `◯` is **unstyled**; checked `◉` is green; pointer `❯` is cyan.
- Active label is cyan. **No fixed-width padding, and no status column.**
- `(will enable)` / `(will disable)` in yellow whenever the desired state
  differs from the current registration — this is the only per-row annotation.
- Undetected clients sit below a dim divider `  Not detected (manual opt-in)`,
  revealed by `v`.
- Empty states: `No safely configurable clients are available.` /
  `No clients detected. Press v to review manual opt-in clients.`
- The `v` entry flips to `v hide undetected`, and is **omitted** when nothing is
  hidden.

Rewrite differences: heading reworded and not bold; a leading space before the
cursor; `>` `●` `○` instead of `❯` `◉` `◯`; unchecked box dimmed; an invented
`·` mark; name padded to 22 with an invented status column; `(will enable)` /
`(will disable)` **missing entirely**, so the user cannot see what Enter will
change; divider replaced by a counter line; footer reworded with `·`
separators and arrow glyphs; an invented transient message line.

## 2.4 Apply results — missing

The rewrite shows nothing per client. The original prints one `row` each:

```
  {green ✔} Claude Code: {dim registered}  {dim (restart Claude Code sessions)}
  {dim ·} Codex CLI: {dim already registered (no change)}
  {red ✖} Cursor: {dim failed: EACCES ...} [config: "/home/.../mcp.json"]
  {yellow −} VS Code: {dim removed}
```

`describeApplyResult` vocabulary: `registered`, `registered with warning: …`,
`would register`, `already registered (no change)`, `blocked: …`,
`unavailable: …`, `conflict: …`, `outcome needs verification: …`, `failed: …`.
`describeRemove`: `removed`, `removed with warning: …`, `would remove`,
`not registered (nothing to remove)`. Failures append `` [config: "<path>"] ``
or `` [config path unavailable: <reason>] ``. Detection problems get
`{dim ·} {name}: detection unavailable: {reason}`.

On failure: blank line, then
`{red Configuration is incomplete.} Review the client and config-path details above before trying again.`

## 2.5 Sign-in

| | original | rewrite |
|---|---|---|
| confirm | `{cyan ❯} {bold Sign in to Sana now?} {dim (Y/n)}` | plain `  Sign in to Sana now? [Y/n]` |
| hint | none | invented `You can also sign in later with: sana-mcp login` |
| email | `Email for your Sana account:` | `  Email: ` |
| code sent | `We emailed a 6-digit sign-in code to {email}.` | `A code was emailed to {email}` (no full stop) |
| code | `Enter the 6-digit code:` | `  Code: ` |
| validation | `the sign-in code must contain exactly 6 digits` / `The confirmation code must be exactly six digits.` | none; empty input silently ignored |
| failure | `{red Sana setup is incomplete: }{text}` / `{red Sana sign-in is unavailable: }{text}` | raw error, no prefix |

## 2.6 Installer live progress

This is the screen that was reported. The original is the status prompt in
`mode: "setup"` (`status-prompt.ts`), full-screen, footer pinned to the bottom:

```
{bold}sana-mcp setup{reset}
{cyan}⠹ Syncing meetings{reset}

{green}✔ AI clients  4 connected{reset}
{yellow}· Sana account  Sign in required{reset}
  Meetings ready     128
  Pending            3 (1 retrying)
  Transcripts stored 125
{cyan}  [##################------]{reset}

{status.message}
… blank padding to the bottom …
{dim}Enter finish setup - sync continues in the background{reset}
```

Exact rules:

- Phase glyph: `✔` when complete, `✖` when there is a problem, else the spinner
  frame. Phase line is green / red / cyan to match.
- Phase labels: `Authentication not ready`, `Sana session expired`,
  `Sign in required`, `Up to date`, `Discovering meetings`,
  `Sync needs attention`, `Syncing meetings`.
- Setup mode adds the two `AI clients` / `Sana account` rows; the account glyph
  is `✔` green when signed in, `·` yellow otherwise.
- Metric labels are padded to 19 columns after a 2-space indent:
  `  Meetings ready     `, `  Pending            `, `  Transcripts stored `.
  `Pending` appends ` ({n} retrying)` when retrying.
- Bar: `[` + `#`×filled + `-`×rest + `]`, **cyan**, indented 2, width
  `min(24, width-4)`, tracking **meetings / meetingsTotal**, and rendered
  **only** when `meetingsTotal > 0` and `width >= 24`.
- Keys: `Enter`/`Esc` finish, `r` refresh, ctrl-c quit.

Rewrite: no `AI clients` / `Sana account` rows; no metric block, just
`{done}/{total} transcripts`; bar hardcoded 28 wide, uncoloured, tracking
transcripts, and drawn as `[----…]` when the total is 0 (the original draws
nothing); no `✔`/`✖`; footer reworded and not pinned; `r` unbound.

**This is why the reported screen showed `[----] 0/0` forever**: the original
would have rendered no bar at all and shown `Sign in required` or the real
phase.

## 2.7 Summary

Original, **no indentation**:

```

{bold}sana-mcp setup{reset}
AI clients  4 connected
Sana account  signed in
Meeting sync  continuing in background
Reload  restart Claude Code sessions; restart Codex sessions
Next: sana-mcp
```

and after the live view: `{green}Meeting sync complete.{reset}` or
`Meeting sync continues in the background.`, then `Reload  {hints}`, then
`Run: sana-mcp`.

Rewrite: everything indented 2; labels padded to a 14-column field so values
align (the original does not align them); `signed in as {email}` where the
original prints only `signed in`; `continuing in the background` where the
original has no "the"; an invented `waiting for sign-in` state; `Next:` rendered
bold-cyan where the original is plain; an invented `Next: sana-mcp login`.

## 2.8 Uninstall

The original is an interactive checkbox prompt: `Remove "sana-mcp" from which
clients?`, all pre-checked, `pageSize: 15`, themed with `◉`/`◯`/`❯`; then a
`statusGlyph(result, false)` row per client (yellow `−` on success); then
`Client registrations removed.`. Empty paths:
`No managed client registrations were found.` and
`Nothing selected; no changes were made.`

The rewrite is non-interactive and prints one summary line. The entire
interactive uninstall surface is missing.

---

# 3. Interactive application

## 3.1 Main menu

The original is an Inquirer `select`: prefix `{cyan ❯}`, message
`{bold What would you like to do?}`, active row cyan, `pageSize` = number of
choices. **No title, no version, no status line, no footer.**

It is **state-dependent**:

- signed out: `Sign in to Sana` (or `Sign in again (session expired)`),
  `Configure AI clients`, `Quit`
- signed in: `Meetings` (suffixed ` (syncing)` while blocking),
  `Search transcripts` (**omitted entirely while blocking**), `Sync status`,
  `Sana account`, `Configuration`, `Quit`

Rewrite: invented title line `sana-mcp {version}`; the question is gone; `>`
instead of `❯`; rows indented so labels sit at column 4 instead of 2; invented
status line; invented footer; and the menu is **static** — no signed-out
variant, no `(syncing)` suffix, and search is offered while the cache is still
blocking.

## 3.2 Meetings list

Original header:
`Meetings | {ready} ready[ | {n} syncing][ | name: {filter}][ | status: {s}]`,
bold.

Each meeting is a **3-line card**: title, metadata, blank. Selected rows carry
`❯` cyan on line 1 and a **vertical rail `│`** (ASCII `|`) cyan on line 2, and
the title is **bold**. Metadata is `{locale date}  {n} words  {Status}` joined
with two spaces, dropping the word count and then the date as width shrinks.
Status is capitalised and coloured: ready green, downloading cyan, everything
else yellow.

Empty: `No ready or syncing meetings found.` or, with filters,
`No meetings match the current filters. Press / or f to edit, or c to clear.`
Blocking: header `sana-mcp | preparing meeting cache`, body `statusLines`,
footer `auto-refreshing  r refresh  i status  esc menu  q quit`.
Refreshes every 1000 ms.

Footer list, longest first:

```
Enter actions  t transcript  s summary  p participants  o recording  PgUp/PgDn page  / name filter  f status filter
Enter actions  t/s/p/o open  PgUp/PgDn page  / name  f status
Enter actions  t/s/p/o open  PgUp/PgDn page
Enter actions  up/down move
Enter open  up/down move
Enter open
q
```

Keys: up/down/`j`/`k`, pgup/pgdn, home/end, `enter` actions menu, `t`/`s`/`p`/`o`,
`/` name filter, `f` status filter, `c` clear, `d` sync details, `r` refresh,
`i` status, `?` help, `esc`, `q`.

Rewrite: header shows the **total** not the ready count and drops the syncing
count; cards are 2 lines with no blank separator; no rail; title cyan not bold;
date format `2006-01-02 15:04` instead of the locale string; word count without
thousands separator or singular form; status lowercase, dim, **uncoloured**;
invented `page N of M`; single hardcoded overflowing footer; filter entry inline
instead of its own screen; `f` cycles instead of opening the picker; `c`, `d`,
`r`, `i`, `?`, home/end all missing.

## 3.3 Missing screens

- **Meeting actions** (`enter`): title = meeting name, rows
  `Transcript, Summary, Participants, Recording, Sync details, Back to meetings`,
  footer `up/down choose  enter open  t transcript  s summary  p participants  o recording  esc meetings`.
- **Sync details** (`d`): header `Sync details | {name}`, body `Status:`,
  `Transcript:`, `Metadata:`, `Queue:`, `Attempts:`, `Last attempt:`,
  `Next retry:` / `Retry eligibility: …`, `Last error:`, footer
  `auto-refreshing  pgup/pgdn page  t/s/p/o switch  esc meetings  q quit`.
- **Keyboard help** (`?`): header `Keyboard help`, four lines, footer
  `up/down scroll  esc meetings  q quit`.
- **Name filter screen** and **status filter picker** — both are separate
  screens with their own headers and footers.

## 3.4 Transcript view

Original: `{bold title}` then `{n} [{time}] {speaker}: {text}` per line, a
scrolling viewport with **no per-line cursor**, footer

```
up/down scroll  pgup/pgdn page  t/s/p/o switch  esc meetings  q quit
```

degrading through `pgup/pgdn page  t/s/p/o switch  esc meetings` →
`t/s/p/o switch  esc meetings` → `esc meetings  q quit` → `esc back` → `q`.
Header gains a `Loading: ` prefix while fetching. Not-downloaded:
`Transcript is downloading ({done}/{total}).`; still listing:
`The meeting list is still syncing.`; missing: `No meeting found with ID {id}.`

Rewrite: adds a per-line cursor `>`, adds an edit marker `*`, timestamps are
`m:ss` without zero padding where the original renders the stored `00:00:03`
form, footer advertises the invented `e edit line` / `h history`, and none of
the four not-ok states exist.

## 3.5 Summary / participants / recording

All three use the detail frame: `{bold title}`, body, adaptive footer.

**Summary body order** — no headings, no indentation:

```
{summaryShort}
{summary}
- {action} - {assignedTo}
{Topic name}
- {note}
```

Empty: `No summary is available.`

The rewrite reorders and restyles: notes indented `  - `, topic lines styled
bold-cyan, an added `Action items` heading, action items rewritten to
`{assignee}: {action} (due {date})` where the original is `{action} - {assignee}`
with no due date, `summaryShort` dropped, blank lines between groups, and the
empty text reworded.

**Participants**: original
`{displayName ?? email ?? "Unnamed participant"}[  {email}][  (host)]`, all
plain. Rewrite dims the email, greens `(host)`, has no `Unnamed participant`
fallback, and reworded the empty case.

**Recording**: original body is the bare URL; `Loading recording...` while
fetching with a `Loading: ` header prefix; failures `No recording is available.`,
`Your Sana session has expired. Sign in again.`,
`Could not load the recording link: {message}`. Rewrite adds an invented
`This link expires after a few hours.` and reworded failures.

Detail views in the rewrite **cannot scroll at all** and drop `up/down scroll`,
`pgup/pgdn page` and `q quit` from the footer.

## 3.6 Search

Four states, all with footers ending in a trailing ` |`.

**Query entry** — the input line is the **last line of the screen, below the
footer**:

```
{bold}Search transcripts{reset}
{dim}semantic index 812/1204{reset}
… blanks …
{dim}Enter - search | Esc - menu |{reset}
> roadmap
```

**Running**: header `Search transcripts | loading`, body
`Searching for "{query}"...`, footer `Esc - edit query | q - quit |`.

**Results**: header
`Search transcripts | {mode} | {sort} | page {p}/{n}` where mode is
`semantic` / `keyword` / `degraded {mode}`. A degradation banner
`Semantic unavailable: {code}: {detail}` in yellow. Cards are 4+ lines:
`{❯| } {name}`, `  {YYYY-MM-DD}  line {n}`, up to two wrapped snippet lines
indented 2, blank. **Query terms are highlighted `\x1b[33m` yellow** inside the
snippet and inside the opened transcript. Footer
`↑/↓ - navigate | Enter - open | s - sort | q - quit |` (`Up/Down` in ASCII).
Keys: `enter`, `s` sort, `[` / `]` page, `r` retry, `/` or `e` edit, `esc`,
up/down/`j`/`k`/pgup/pgdn/home/end, `q`.

**No results**: `No transcript matches for "{query}".` or
`No matches on page {p}; {total} matching lines exist.`, footer
`r - retry | / - edit | Esc - query | q - quit |`.

**Errors**: header suffix `| error` with `Search failed:` + message, or
`Search did not return a result.`, or `| empty query` with
`Enter at least one word to search.`

Rewrite: no coverage line, no mode/sort/page header, invented
`{n} results for "{q}"` line, 2-line cards, **no term highlighting**, no
degradation banner, no sort, no paging, no retry, and a search error is routed
to `m.detail` which the search screen never displays — **the error is
invisible**. The no-result hint is a 160-character invented sentence printed
unwrapped.

**Opening a hit**: the original stays inside the search prompt, centres the
matching line, highlights terms, and `Esc` returns to the results. The rewrite
jumps to the shared transcript screen at `index-3` with no highlighting, and
`esc` goes to the meetings list.

## 3.7 Sync status screen

Body order, exactly:

```
{bold}Sync status{reset}
{spinner|✔|✖} {phase}          <- cyan / green / red
  Meetings ready     {n}
  Pending            {n} ({r} retrying)
  Transcripts stored {n}
{cyan}  [####----]{reset}

{status.message}

Sana session: signed in; access is checked before every sync cycle.
Last completed sync: {locale}
Daemon heartbeat: {locale}

Sync error: {…}

Background sync unavailable: {…}

Status refresh failed: {…}

{dim}Updated {locale time}{reset}
… padding …
{dim}auto-refreshing  r refresh  Enter/Esc menu  q quit{reset}
```

Signed-out variants of the session line:
`Your Sana session has expired. Sign in again.` /
`You are not signed in to Sana.` / `Authentication: {message}`.

Rewrite: no glyph, no phase colour, invented `Waiting to start` label, missing
`Authentication not ready` and `Sana session expired`, metrics lowercase and
reworded with a 14-column field instead of capitalised with 19, bar 30 wide and
uncoloured and drawn above the metrics and when total is 0, and every line from
`Sana session:` down is missing. Footer is `esc menu`; `r` and `Enter` unbound.

## 3.8 Sana account

The original has **no static screen**. It is a select:
`{bold Sana account - {signed in|session expired|not signed in}}` with choices
`Back` and `Sign in` / `Sign in again`, and choosing it runs the two-step
sign-in inline (`Email for your Sana account`, `6-digit code`,
`We emailed a 6-digit code to {email}.`, `Signed in as {email}.`,
`Your meetings are syncing in the background.`).

The rewrite is read-only and **you cannot sign in from the application at all**.
It also prints an invented `Workspace {id}` row.

## 3.9 Configuration

The original menu entry calls `runtime.configure()`, which runs the client
wizard inline. There is no configuration information screen.

The rewrite replaces the capability with an invented read-only panel (`Data`,
`Sync every`, `Search`) and a sentence telling the user to run another command.

---

# 4. Invented surface with no original counterpart

1. Edit line screen, edit history screen, and the three `[y/n]` confirmations.
2. The transcript `*` edit marker and per-line cursor.
3. Installer `stepDetecting` and `stepApplying` screens.
4. The Configuration information screen.
5. Meetings `page N of M`.
6. The installer status column and the `·` non-selectable mark.
7. The global red/green banner appended to every app screen. The original has no
   such banner: each error is its own titled view or an inline line.

The correction feature (1, 2) was asked for and stays — but it must adopt the
original's glyphs, colours, footer conventions and frame.

---

# 5. Missing strings

Catalogued rather than quoted in full; all exist in the original and have no
Go counterpart. Shell: `Run sana-mcp in an interactive terminal.`,
`Could not complete that action: {m}`, `The cached {artifact} for "{name}" is
corrupt ({code}).`, `Re-sync the meeting cache before retrying.`,
`No synced meetings found.`, `Enter a valid email address.`,
`The confirmation code must be exactly six digits.`,
`Sign-in paused. Run sana-mcp and choose Sign in when ready.`,
`Signed in, but background sync could not start: {m}`. Browser: `Refresh
failed`, `Filter failed`, `Status filter failed`, `Clear filters failed`,
`The meeting list is still syncing.`, `Transcript is downloading ({d}/{t}).`,
`No meeting found with ID {id}.`, `No summary is available.`, `No participants
are available.`, `No recording is available.`, `Loading recording...`. Search:
`Search failed:`, `Search did not return a result.`, `Enter at least one word to
search.`, `No matches on page {p}; {total} matching lines exist.`, `Semantic
unavailable: {code}`. Installer: `Configuration is incomplete.`, `No supported
AI clients detected.`, `An interactive terminal is required to choose clients.
Use sana-mcp install --yes to register every detected client.`, `Client
configuration complete. Run sana-mcp anytime to change it or sign in.`,
`Registering sana-mcp with {n} detected client(s):`, `Managed registration state
could not be determined for every client.`, `Client registrations removed.`

---

# 6. One-shot CLI

`internal/cli/commands.go` differs from `commands.ts` in every command: `status`
loses the signed-out branch and the `Your current meeting cache is available
while syncing continues.` line; `list` changes column order and loses
`Showing 20 of {n}. Next page: …`; `read` loses the `{name} - {n} lines, {m}
words` header and the chooser; `search` changes the row shape and adds the
invented hint; `login` became interactive where the original is
`--email`/`--code`; `recording` drops the meeting name; `help` is a different
document.

---

# 7. Order of work

1. **Primitives** (§1): policy, SGR colours, both glyph sets, both spinner sets
   with 1 fps on the status screen, `sanitizeTerminalText`, grapheme-aware
   `displayWidth`, `truncate` with marker, `wrap`, the composition helpers, and
   the frame (truncate to `width-1`, pad, pin footer). Drop the alt screen.
   Nothing else can be correct until this is.
2. **Sync status screen** (§2.6, §3.7) — one implementation, two modes, as the
   original has it. This is the reported bug and the most-seen screen.
3. **Installer** (§2) — wizard, apply rows, sign-in wording, summary,
   interactive uninstall.
4. **Meetings list and detail views** (§3.2, §3.4, §3.5) — cards, rail,
   colours, adaptive footers.
5. **Missing screens** (§3.3) — actions, sync details, help, filters.
6. **Search** (§3.6) — four states, highlighting, sort and paging.
7. **Menu and account** (§3.1, §3.8) — state-dependent choices, inline sign-in.
8. **CLI** (§6).
