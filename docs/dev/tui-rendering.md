---
status: accepted
scope: rendering vocabulary and one-region interaction intent only
last_verified: 2026-07-24
authority: subordinate to remediation-plan.md terminal-safety requirements
---

# In-place TUI rendering for the configurer

## Problem

`runInstall` / `runUninstall` (src/install/install.ts) read like a log, not an
app. Each step commits its own output and the terminal scrolls:

```
Downloading sana-mcp v0.3.2 (x64)        <- from install.sh / install.ps1
  [########################] 100% ...
Installed -> /home/you/.local/bin/sana-mcp
                                          <- binary starts here
? Configure sana-mcp for your AI clients  <- wizard prompt (redraws in place)
  + Claude Desktop: registered -> ...     <- console.log, committed
  + Cursor: registered -> ...
? Sign in to Sana now? (Y/n)              <- confirm prompt, committed
? Email for your Sana account:            <- input prompt, committed
...
All set. Run sana-mcp anytime ...
```

The root cause: `@inquirer` redraws in place only *within a single prompt's
lifetime*. Every `console.log` and every *separate* prompt leaves its final
frame committed to scrollback. The wizard (src/install/wizard-prompt.ts) looks
good precisely because it is one long-lived prompt that owns one continuously
redrawn region with a header, body, and footer.

The fix generalizes that: make the whole interactive flow behave like the
wizard - one region that is redrawn as the state advances - and give every
surface (interactive or not) a shared rendering vocabulary so spacing, glyphs,
and color are identical everywhere.

## Chosen approach

Two layers:

1. **`src/app/ui.ts`** - a dependency-light rendering primitive: theme (color,
   gated on TTY + `NO_COLOR`), glyph table (ASCII default, Unicode opt-in),
   layout helpers (`header`, `row`, `footer`, `frame`), and a `Frame` class
   that redraws a tracked region using `@inquirer/ansi`. Used by the
   non-interactive paths (`--yes`, uninstall, no-clients, plain fallback) and
   as the shared visual vocabulary for everything.

2. **`src/install/app-prompt.ts`** - the interactive configurer as a *single*
   `@inquirer/core` custom prompt implemented as a state machine
   (`configure -> applying -> results+login -> done`). Because it is one prompt,
   inquirer owns the in-place redraw across all steps for free - exactly the
   mechanism that already makes the wizard look right - so there is zero scroll
   between steps. It renders through the `ui.ts` helpers so its frames are
   visually identical to the non-interactive ones.

### Why this and not the alternatives

| Option | What it is | Verdict |
| --- | --- | --- |
| **(a) Custom `Frame` renderer only** | Hand-rolled save/restore + `eraseLines`; each step calls `frame.render(lines)`. | Chosen for **non-interactive** output. For interactive input we would have to hand-roll line-wrap accounting, keypress reading, and text-field editing that inquirer already does correctly. Fragile as the sole approach. |
| **(b) One `@inquirer/core` prompt state machine** | The entire flow is a single prompt; state transitions redraw the same region. | **Chosen for the interactive flow.** Reuses the wizard's proven mechanism, zero new redraw code, correct wrap handling, `cursorHide` and cleanup already solved, no new deps. Cost: async work (file writes, `execFileSync`, `sana("login")`, text input) must run inside `useEffect`/`useKeypress` instead of top-to-bottom `await`. Manageable and localized. |
| **(c) Ink (React reconciler)** | Full component TUI. | **Rejected.** Adds `ink` + `react` + reconciler (heavy) to a `bun build --compile --minify --bytecode` single binary; larger artifact, more surface for compile/runtime quirks, and it would sit *alongside* the `@inquirer` deps we already ship (the wizard would need a rewrite). No capability we need that (a)+(b) lack. Not worth the bundle and risk. |

Net new dependency cost of the chosen approach: **zero.** It uses only
`@inquirer/core`, `@inquirer/prompts`, and `@inquirer/ansi`, all already
in `package.json`.

## The rendering primitive: `src/app/ui.ts`

### Capability detection (computed once at import)

```ts
const noColor  = "NO_COLOR" in process.env || process.env.TERM === "dumb";
export const isTTY   = !!process.stdout.isTTY;
export const isColor = isTTY && !noColor;
// Interactive = we may run prompts and redraw. CI is treated as non-interactive.
export const isInteractive =
  !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI;
// Unicode glyphs only where we are confident they render; else ASCII.
const unicodeOK =
  isTTY &&
  process.platform !== "win32" ||          // POSIX terminals: fine
  !!process.env.WT_SESSION;                 // Windows Terminal: fine (conhost: no)
```

Rationale: `NO_COLOR` and non-TTY strip color; ASCII glyphs are the safe default
so legacy Windows conhost never shows tofu; Unicode is an enhancement.

### Color

```ts
const wrap = (open: number, close: number) =>
  (s: string) => (isColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const color = {
  dim: wrap(2, 22), bold: wrap(1, 22),
  green: wrap(32, 39), yellow: wrap(33, 39),
  red: wrap(31, 39), cyan: wrap(36, 39),
};
```

Identical to the local `C` / `c` objects already duplicated in install.ts and
wizard-prompt.ts; those two copies get deleted and both import this.

### Glyph table

One status vocabulary used by every screen (fixed width 1 cell + trailing
space, so rows align):

| Meaning | Unicode | ASCII | Color |
| --- | --- | --- | --- |
| ok / registered | `✔` | `+` | green |
| enabled (turned on) | `✔` | `+` | green |
| disabled (turned off) | `−` | `-` | yellow |
| unchanged (noop) | `=` | `=` | dim |
| skipped | `·` | `~` | dim |
| failed | `✖` | `x` | red |
| pending | spinner frame | `.` | dim |
| checkbox on / off | `[x]` / `[ ]` | same | green / default |

```ts
export const glyphs = unicodeOK
  ? { ok:"✔", disable:"−", noop:"=", skip:"·", fail:"✖", pending:"·" }
  : { ok:"+", disable:"-", noop:"=", skip:"~", fail:"x", pending:"." };
export const spinner = unicodeOK
  ? ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
  : ["-","\\","|","/"];
export function statusGlyph(r: ApplyResult, enabling = true): string {
  if (r.status === "ok")     return enabling ? color.green(glyphs.ok) : color.yellow(glyphs.disable);
  if (r.status === "noop")   return color.dim(glyphs.noop);
  if (r.status === "failed") return color.red(glyphs.fail);
  return color.dim(glyphs.skip);
}
```

`statusGlyph` replaces the private `statusIcon` in install.ts.

### Layout helpers

A fixed **2-space left gutter** for all body content. Header flush-left.

```ts
export const GUTTER = "  ";
// Title block: bold title, optional dim subtitle, then a blank line.
export function header(title: string, subtitle?: string): string[];
// "  {glyph} {label}{: detail}{  (hint)}" - detail dim, hint dim.
export function row(glyph: string, label: string, detail?: string, hint?: string): string;
// Blank line, then dim "key  action  |  key  action" (like the wizard footer).
export function footer(hints: string[]): string[];
export function keyHint(key: string, action: string): string; // bold key + action
// Assemble a whole screen with consistent spacing (see spacing rules).
export function frame(parts: { header: string[]; body: string[]; footer?: string[] }): string[];
```

**Spacing rules (enforced by `frame`)**

- Exactly one blank line after the header block.
- Exactly one blank line before the footer.
- No leading blank line, no more than one trailing blank line.
- Body rows carry no internal blank lines unless a section break is explicit.

This is the single source of truth for spacing; no screen hand-manages blanks.

### The `Frame` class (non-interactive redraw)

```ts
export class Frame {
  constructor(private stream = process.stdout) {}
  render(lines: string[]): void;  // erase previous region, draw lines, hide cursor
  clearScreen(): void;            // clearAndHome() - see boundary section
  done(finalLines?: string[]): void; // final render, show cursor, trailing newline
}
```

Implementation notes:

- Tracks the visual row count of the last render (accounting for wrap:
  `stripAnsi(line).length` divided by `stream.columns`, summed) and erases it
  with `eraseLines(n)` from `@inquirer/ansi` before drawing the next frame.
- Emits `cursorHide` on render, `cursorShow` on `done`; a `process.on("exit")`
  and `SIGINT` handler always restore the cursor.
- **When `!isTTY`, `render` degrades to a one-shot `stream.write`** (no erase,
  no cursor codes) so piped output stays clean. `Frame` is only for short,
  controlled content; anything interactive uses the prompt state machine, which
  delegates wrap accounting to inquirer's battle-tested `ScreenManager`. Being
  explicit about this split is why we do not try to hand-roll interactive input.

Export `stripAnsi(s)` and `clearAndHome()` as small helpers.

## The interactive flow: `src/install/app-prompt.ts`

One `createPrompt` state machine. State shape:

```ts
type Phase = "configure" | "applying" | "login-ask" | "login-email"
           | "login-code" | "done";
interface AppState {
  phase: Phase;
  desired: Record<string, boolean>;   // seeded from current registration
  cursor: number; showAll: boolean;   // configure phase
  applied: Map<string, ApplyResult | "pending">; // per acted client, live
  summary?: string;                   // "3 enabled, 1 unchanged, 1 failed"
  loginState: "unknown" | "in" | "out" | "signing" | "sent" | "ok" | "err";
  email: string; code: string; tick: number; // input buffers + spinner tick
}
```

`render` returns `frame({ header, body, footer })` for the current phase, so the
region always looks like one app screen. Key behaviors:

- **configure**: identical to today's wizard body (fold wizard-prompt.ts logic
  in, or keep it and let the state machine embed it). `enter` moves to
  `applying`.
- **applying**: a `useEffect` (keyed on entering the phase) runs the applies
  sequentially, calling `setState` after each so the row flips
  `pending -> ok/noop/failed` live. A `setInterval` bumps `tick` to animate the
  pending spinner; cleared when no rows are pending. On completion it computes
  `summary` and advances to `login-ask` (or `done` if already signed in - the
  `sana("status")` check runs in an effect on mount and sets `loginState`).
- **login-ask / -email / -code**: the results checklist + summary stay in the
  returned `body` (they do not scroll away); only the interactive *tail* changes.
  `login-ask` is a `[y/n]` line driven by `useKeypress`. `-email` / `-code` are
  text fields built from `rl.line` (the wizard already reads keypresses; reuse
  that pattern), each showing a masked-or-plain input row. Effects call
  `sana("login", ...)` and set `loginState`.
- **done**: final full frame (header + results + login outcome + "All set"
  footer). Because it is the prompt's terminal render, it commits **once** - the
  only thing left in scrollback is the finished app screen.

The `--yes`, no-TTY, no-clients, and uninstall paths do **not** use this prompt;
they render through `ui.ts` (`Frame` for TTY, plain writes otherwise).

## Per-screen spec

All screens share: 2-space gutter, one blank after header, one blank before
footer, shared glyphs, shared color.

### S0 - Boot header (binary entry, interactive TTY)

```
sana-mcp v0.3.2
Configure your AI clients and sign in to Sana.
```

Drawn once after `clearAndHome()` (see boundary). Bold title + version, dim
tagline, blank line. This header is the *fixed top* of every subsequent frame.

### S1 - Configure (wizard)

```
sana-mcp v0.3.2
Configure your AI clients and sign in to Sana.

  Select the clients to register sana-mcp with:

  > [x] Claude Desktop
    [x] Cursor        (will enable)
    [ ] VS Code

  up/down move  |  space toggle  |  a all  |  v show undetected  |  enter apply  |  esc cancel
```

State: cursor, per-row checkbox, `(will enable)` / `(will disable)` deltas in
yellow, dimmed undetected rows under `- not detected -` when `v` toggled.
(Today's wizard, restyled through `ui.ts`.)

### S2 - Applying (live checklist)

Header subtitle switches to `Applying changes...`. Rows for acted clients flip
in place:

```
  Applying changes...

  ⠹ Claude Desktop: registering...
  ✔ Cursor: registered
  · VS Code: pending
```

Pending rows show a spinner glyph (`tick`-driven); settled rows show the final
status glyph + `describe()` text. No footer during this phase (nothing to press).

### S3 - Results + login ask (one frame)

Results settle and a summary line appears; the login question is the tail:

```
  Done. 2 enabled, 1 unchanged.

  ✔ Claude Desktop: registered            (restart Claude Desktop)
  = Cursor: already registered (no change)
  ✔ VS Code: registered

  Sign in to Sana now?  [Y/n]
```

The checklist and summary stay put; only the last line is interactive. If
already signed in, this frame instead shows `Already signed in to Sana.` and
skips to S6/done.

### S4 - Login email / S5 - Login code

The results block stays; the tail becomes a text field, then the code field:

```
  ...results block unchanged...

  Email for your Sana account: you@example.com▏
```

then

```
  ...results block unchanged...

  Sent a 6-digit code to you@example.com.
  Enter the code: 12345▏
```

Input echoes from `rl.line`; a spinner tail shows while `sana("login")` runs.
Empty submit degrades gracefully (dim "skipping" line, advance to done).

### S6 - Done

```
sana-mcp v0.3.2
Configure your AI clients and sign in to Sana.

  Done. 2 enabled, 1 unchanged.

  ✔ Claude Desktop: registered            (restart Claude Desktop)
  = Cursor: already registered (no change)
  ✔ VS Code: registered

  ✔ Signed in as you@example.com.

  Run sana-mcp anytime to reconfigure or sign in.
```

Committed once; this is the whole session's footprint.

### S7 - Unattended (`--yes`) and S8 - no clients / non-TTY

Non-interactive, rendered with `Frame` (or plain writes when piped). Same
header, same glyphs, but no live redraw needed - one `frame.render`, then
`frame.done`:

```
sana-mcp v0.3.2

  Registering with 3 detected client(s):

  ✔ Claude Desktop: registered
  ✔ Cursor: registered
  ✔ VS Code: registered

  Run sana-mcp anytime to change this or sign in.
```

No-clients and non-TTY explainers use the same header + a single dim body line.

### S9 - Uninstall

Interactive: a checkbox selection frame (reuse the wizard body pattern), then a
live checklist identical to S2/S3 with `removed` / `not registered` verbs and
the `disable`/`noop`/`skip` glyphs.

## Shell-script <-> binary boundary

The full "screen" spans install.sh / install.ps1 (download + progress) and the
binary (everything after). To make the handoff seamless:

1. **The scripts print only transient progress and leave nothing durable.**
   Both already draw a self-updating progress line with `\r`. On completion,
   *erase* it instead of committing an "Installed ->" line:
   - install.sh: after `mv "$tmp" "$dest"`, replace the `echo "Installed -> ..."`
     with an erase of the curl progress line (`printf '\r\033[2K'`) when a TTY is
     present; keep the durable "Installed" line only on the **non-TTY** branch.
   - install.ps1: the download function already ends with `Write-Host ""`; drop
     the `Write-Host "Installed -> $dest"` and checksum chatter on the
     interactive branch (keep them on the non-interactive `else`). PATH messages
     move behind the same non-interactive guard.
2. **The binary owns all UI after download.** On interactive start it calls
   `clearAndHome()` then draws S0. Because the scripts left no durable lines, the
   app appears to "take over" the terminal cleanly - the download simply
   vanishes, which is fine for transient progress.
3. Keep the durable install summary (path, PATH note, checksum result) **only**
   on the non-interactive script branches, where the binary will not run a TUI.

`clearAndHome()` = `\x1b[2J\x1b[H`. Do **not** rely on `\x1b[3J`
(clear-scrollback): unsupported in Windows conhost. If a user prefers to keep
scrollback, honor `SANA_MCP_KEEP_SCROLLBACK=1` by skipping the clear and just
drawing S0 at the current cursor.

### Platform ANSI notes

- **Windows Terminal / conhost (Win10+)**: VT is supported; Bun enables VT
  processing on TTY stdout, so `eraseLines`, `cursorHide`, and `\x1b[2J` work.
  Use ASCII glyphs on conhost (Unicode only when `WT_SESSION` is set).
- **PowerShell via `irm | iex`**: `iex` keeps a real console (the .ps1 comment
  already notes this), so the TUI works. `[Environment]::UserInteractive` gates
  the interactive branch.
- **WSL / macOS Terminal / iTerm / Linux terminals**: full VT + Unicode; the
  `curl | sh` path hands `/dev/tty` to the binary (already implemented), so
  isTTY is true inside the binary.
- Always restore the cursor (`cursorShow`) on exit and SIGINT so a
  cancelled run never leaves an invisible cursor.

## Non-TTY / piped / NO_COLOR fallback

Single detection point in `ui.ts` (above): `isInteractive`, `isTTY`, `isColor`.

- **`!isInteractive`** (piped, CI, no controlling terminal): never run the
  prompt state machine and never emit erase/cursor escapes. install.ts already
  bails to an explainer when `!process.stdin.isTTY`; route the `--yes` and
  no-clients paths through `Frame` which, seeing `!isTTY`, writes each frame once
  as plain lines. Result: clean sequential text, no escape spam.
- **`!isColor`** (NO_COLOR, `TERM=dumb`, or non-TTY): every `color.*` helper is
  identity; glyphs remain (they are meaningful ASCII: `+ - = x ~`). Layout and
  spacing are unchanged, so piped output is stable and greppable.
- **`!unicodeOK`**: ASCII glyph set, so no tofu on legacy consoles.

## Migration checklist

- [ ] Add `src/app/ui.ts` (theme, glyphs, layout, `Frame`, detection).
- [ ] Delete the duplicated `C` (install.ts) and `c` (wizard-prompt.ts) color
      objects; import from `ui.ts`.
- [ ] Replace `statusIcon` with `ui.statusGlyph`.
- [ ] Add `src/install/app-prompt.ts` (state machine) and fold the wizard body
      into its `configure` phase; make `runInstall` (interactive branch) a thin
      wrapper that runs the prompt and prints nothing else.
- [ ] Route `--yes`, no-clients, non-TTY, and uninstall through `ui.Frame`.
- [ ] Binary entry (cli.ts / install.ts): `clearAndHome()` + S0 on interactive
      start, guarded by `SANA_MCP_KEEP_SCROLLBACK`.
- [ ] Trim install.sh / install.ps1 to transient progress on the interactive
      branch; keep durable summaries only on non-interactive branches.
- [ ] Verify on: Windows Terminal, conhost, PowerShell `irm|iex`, WSL, macOS
      Terminal, and a piped `curl ... | sh > log`.
```
