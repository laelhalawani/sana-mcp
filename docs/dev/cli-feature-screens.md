---
status: accepted
scope: human-screen information architecture and interaction intent
last_verified: 2026-07-24
authority: subordinate to remediation-plan.md typed ports and failure states
---

# CLI feature screens

Design for the interactive `sana-mcp` app's feature screens: the per-screen UX
a human sees when they run bare `sana-mcp` and route in from the main menu. This
doc owns the SCREENS only. The app shell / main menu, the low-level rendering
primitives, and the data/presentation split are designed by sibling agents;
where a screen leans on those, this doc names the contract it expects.

These screens are human-facing and MUST NOT reuse the MCP tool's string output
(the Markdown tables and `meeting_transcripts("...")` call hints in
`src/tools/dispatch.ts`). They call the same `SanaStore` / `SanaClient` methods
the dispatcher does, but render for a terminal reader, not for an LLM.

Reference: the app runs interactively only (launched from a TTY). Non-TTY is not
a supported mode for these screens; the shell already gates on `process.stdin.isTTY`
(see `runInstall` in `src/install/install.ts`) and prints the non-interactive
hint before any screen is reached. Screens may therefore assume a live TTY.

All punctuation uses hyphens, never em/en dashes.

---

## 0. Conventions shared by every screen

### 0.1 Data sources (never the dispatcher strings)

| Screen        | SanaStore                                                                 | SanaClient                        |
|---------------|--------------------------------------------------------------------------|-----------------------------------|
| STATUS        | getSyncState, countMeetings, countTranscripts, countEmbedded             | -                                 |
| LIST          | listMeetings(opts), countMeetings(opts), getSyncState                    | -                                 |
| meeting actions | getMeeting, getTranscript, getMetadata                                  | -                                 |
| SEARCH        | searchLines(match,opts), countLineMatches(match,opts), semanticEnabled() | -                                 |
| READ          | getMeeting, getTranscript -> transcriptLines(JSON.parse(t.json))         | -                                 |
| SUMMARY       | getMeeting, getMetadata (summary_short, summary, notes_json)             | -                                 |
| PARTICIPANTS  | getMeeting, getMetadata (participants_json)                              | (fallback) getMeetingParticipants |
| RECORDING     | getMeeting                                                               | getMeetingById -> recordingUrl    |
| LOGIN         | resetFailures, updateSyncState, getSyncState                            | requestSignInCode, submitSignInCode |
| CONFIGURE     | (via existing installer)                                                  | -                                 |

Screens open one `SanaStore` on entry and `close()` it on exit (the dispatcher
opens/closes per call; a long-lived screen holds one handle). The data-split
agent may wrap these in a presenter layer returning plain view-models; the
layouts below assume it hands back exactly the fields named.

### 0.2 Header / breadcrumb (rendering-primitive contract)

Every screen renders a two-line header supplied by the shell:

```
Sana - Meetings                                    you@example.com - synced
Home / List / "Weekly sync 2026-06-03"
```

- Line 1: app name (left), session + sync badge (right). Badge is one of
  `synced`, `syncing N left`, `logged out`, `offline`.
- Line 2: breadcrumb of the nav stack. The last crumb is the current screen.

### 0.3 Global key bindings (present on all screens unless noted)

| Key            | Action                                                        |
|----------------|--------------------------------------------------------------|
| `Esc` / `q`    | Back one screen (pop nav stack). At the menu, prompts to quit.|
| `Ctrl+C`       | Immediate quit (inquirer default; app catches and exits 0).  |
| `?`            | Toggle an inline help/keys footer for the current screen.    |
| `r`            | Refresh the current screen's data (re-run its store reads).  |

A persistent dim footer lists the current screen's keys (same pattern as
`wizard-prompt.ts`'s shortcuts footer). `Esc`/`q` is always the back key; a
screen that needs `q` for its own purpose (none do here) would remap.

### 0.4 Cross-cutting gates (checked on entry to any DATA screen)

Data screens = LIST, SEARCH, READ, SUMMARY, PARTICIPANTS, RECORDING (STATUS,
LOGIN and CONFIGURE are always reachable). On entry each data screen runs, in
order:

1. **Logged out** - `!client.hasAuthCookie()` OR `getSyncState().phase === "needs_login"`.
   Render the BLOCKED-LOGGED-OUT panel and route to LOGIN:

   ```
   You are not logged in.

   Sign in with the email on your Sana.ai subscription to load your meetings.

     [ Sign in now ]      [ Back to menu ]
   ```

   `Enter` on "Sign in now" pushes LOGIN; on return, re-run the gate.

2. **Sync blocking** - `getSyncState().blocking === 1`. A login-triggered
   catch-up is running and data is incomplete; mirror the dispatcher's gate but
   friendly. Compute `remaining = max(0, transcripts_total - transcripts_done)`
   and `mins = max(1, ceil(remaining*0.5/60))` (same formula as
   `estimateMinutes`):

   ```
   Sync in progress

   Downloading your transcripts: 42 / 118 done, about 1 min left.
   Meetings open automatically once this finishes.

     [ View status (live) ]     [ Back to menu ]
   ```

   "View status" pushes STATUS. This panel is NOT shown for STATUS itself.
   If `transcripts_total === 0` the middle line reads "Building your meeting
   list...". While blocking, re-poll `getSyncState()` every 1s so the panel can
   auto-dismiss and enter the real screen the moment `blocking` clears.

3. **Empty store** (logged in, not blocking, but 0 rows) - the screen's own
   empty state (below).

The shell decides at menu level which entries are enabled, but each data screen
re-checks on entry (state can change while a menu is on screen).

### 0.5 Prompt building blocks (verified installed)

- `@inquirer/prompts` 8.5.x: `select`, `search`, `checkbox`, `confirm`, `input`,
  `number`, `password`, `rawlist`, `expand`, `editor`.
- `@inquirer/core` 11.x: `createPrompt`, `useState`, `useKeypress`, `useMemo`,
  `useRef`, `useEffect`, `usePagination`, `usePrefix`, `makeTheme`,
  `is{Up,Down,Enter,Space,Backspace,Tab,Number,Shift}Key`, `Separator`.
- `@inquirer/ansi`: `cursorHide/Show`, `cursorUp/Down/To/Left`, `eraseLines`.

Two screens need behaviour beyond the stock prompts and get **custom prompts**
built with `createPrompt` (same technique as `src/install/wizard-prompt.ts`):
the LIST browser and the READ pager. Everything else composes stock prompts.

---

## 1. STATUS

Live view of sync progress and coverage. Always reachable (even while blocking,
logged out shows the login CTA instead of counts).

### Data
`getSyncState()` -> phase, blocking, meetings_total, transcripts_done,
transcripts_total, last_full_sync_ms, last_incremental_ms, daemon_heartbeat_ms,
error. Plus `countMeetings()`, `countTranscripts()`, and, when
`semanticEnabled()`, `countEmbedded()`.

### Layout (caught up)

```
 Status

   Up to date.
   Meetings stored ....... 118
   Transcripts stored .... 118
   Semantic index ........ 118 / 118 embedded          (only if enabled)

   Last full sync ........ 2026-07-24 09:12 UTC
   Last incremental ...... 2026-07-24 11:48 UTC (3 min ago)
   Daemon ................ running (heartbeat 4s ago)

   New meetings sync automatically shortly after they end.

   [r] refresh   [Esc] back
```

### Layout (sync in progress / blocking)

```
 Status

   Sync in progress
   [############------------]  42 / 118 transcripts   about 1 min left

   Meeting screens unlock automatically when this finishes.

   Daemon ................ running (heartbeat 2s ago)
   Last full sync ........ never

   [r] refresh   [Esc] back
```

Progress bar width fixed (e.g. 24 cells), filled = `round(done/total*width)`.
When `transcripts_total === 0`, replace the bar with `Building the meeting
list...` and a small spinner.

### Behaviour / states
- **Live refresh**: implemented as a custom `createPrompt` view that owns a
  `useEffect` interval (1000ms) calling `getSyncState()` + counts and
  `setState`. No re-render churn beyond the changed lines. `r` forces an
  immediate poll. This is the only screen that auto-refreshes when NOT blocking.
- **Daemon down**: `daemon_heartbeat_ms` older than ~15s -> `Daemon .... not
  running` in yellow, with a dim hint "background sync is paused; it restarts on
  the next meeting action". (The shell/`ensureDaemonRunning` revives it; STATUS
  only reports.)
- **Error**: `phase === "error"` and `error` set -> red line `Last sync failed:
  <error>` above the counts.
- **Logged out**: counts hidden; show the login CTA from 0.4 step 1.
- **Empty**: logged in, `countMeetings() === 0`, not blocking -> "No meetings
  synced yet. If you just signed in, they are on the way."
- Keys: `r` refresh, `Esc`/`q` back, `?` keys.

---

## 2. LIST (browse meetings)

Scrollable, paginated, selectable meeting list with in-screen title filtering,
sort toggle, and status filter. Selecting a meeting pushes its ACTIONS submenu.

Built as a **custom prompt** (`meetingListPrompt` via `createPrompt`), because
no stock prompt combines: a live type-to-filter buffer, a colored status column,
a sort/status toggle, AND pagination with counts. (`@inquirer/search` gives
filter-as-you-type but cannot host the toggles or the status column cleanly; we
own the render instead.) Use `usePagination` from core for the visible window.

### Data
On every filter/sort/status/page change, recompute:
```
opts = { query, sort, status, limit: pageSize, offset: (page-1)*pageSize }
rows  = store.listMeetings(opts)          // MeetingListRow[]
total = store.countMeetings({ query, sort, status })
```
`pageSize` = `min(terminal rows - chrome, 20)`. Status per row matches the
dispatcher's `rowStatus`: transcript plus metadata -> `ready`; otherwise an
unfinished Sana phase -> `processing`; otherwise attempts greater than zero ->
`retrying`; otherwise `downloading`.

Date filter (from/to) is supported by the store but is a secondary control (see
below); title filter and status filter are primary.

### Layout

```
 Meetings                                              newest first - 118 total

   Filter: pri▊                                         (type to filter titles)

   2026-06-03 09:00   ready        Weekly sync
 > 2026-06-02 14:30   ready        Pricing review with Acme
   2026-06-01 11:15   downloading  1:1 Dana / Sam
   2026-05-30 16:00   retrying     Board prep
   2026-05-29 10:00   processing   Design critique
   ...

   Page 2 / 6      showing 11-20 of 118 matching

   [up/down] move  [enter] open  [/ type] filter  [s] sort  [f] status
   [n/p] page      [c] clear     [Esc] back
```

- Columns: date `YYYY-MM-DD HH:MM` (local or UTC - match STATUS; use UTC to
  align with the store), status (colored: ready=green, downloading=cyan,
  processing=yellow, retrying=yellow), title (truncated with ellipsis to fit width;
  never wraps).
- `>` cursor + cyan active row, same visual language as `wizard-prompt.ts`.

### Keys / interaction

| Key           | Action                                                           |
|---------------|-----------------------------------------------------------------|
| up/down       | Move cursor within the visible page (wraps to prev/next page at edges) |
| `Enter`       | Open the highlighted meeting's ACTIONS submenu                   |
| printable     | Append to the filter buffer; debounce ~120ms then re-query, reset to page 1 |
| `Backspace`   | Delete last filter char; re-query                               |
| `s`           | Toggle sort newest <-> oldest; reset to page 1                   |
| `f`           | Cycle status filter: all -> ready -> downloading -> retrying -> all; reset to page 1 |
| `n` / `p` or PageDn/PageUp | Next / previous page (clamped)                     |
| `c`           | Clear filter buffer + status filter, back to page 1             |
| `r`           | Re-read current page (picks up newly synced rows)               |
| `Esc` / `q`   | Back to menu                                                     |

Filter typing takes printable keys; `s`/`f`/`n`/`p`/`c` are only consumed when
the filter buffer is empty OR are always reserved (choose: reserve them, and
require the filter to capture only alphanumerics + space + punctuation via
`isNumberKey`/char, so single-letter commands still work only when buffer empty
is fragile). Decision: **the filter buffer is only active after `/`** - press
`/` to focus filter (cursor shown in the Filter field), `Enter`/`Esc` in filter
mode commits/returns to list mode; in list mode the single letters are commands.
This keeps `s`/`f`/`n`/`p` unambiguous. The header hint shows `[/ ] filter` in
list mode and `[Esc] done filtering` in filter mode.

### States
- **Loading**: first query shows a one-line spinner "Loading meetings...".
  Subsequent re-queries are fast (local SQLite) - no spinner, just swap rows.
- **Empty (no meetings at all)**: "No meetings synced yet." + `[Esc] back`.
- **Empty (filter/status matches nothing)**: keep the Filter line and controls,
  body shows "No meetings match "pri" with status = retrying." + hint to `c` clear.
- **Page overflow**: if a refresh shrinks total below the current page, clamp
  `page` and re-query.
- Gates from 0.4 apply on entry.

### Selecting -> meeting ACTIONS submenu

`Enter` pushes a `select` prompt scoped to the chosen `{ id, name,
created_at_ms }`. This submenu is the hub for screens 4-7.

```
 Pricing review with Acme
 2026-06-02 14:30 UTC - ready

 ? What would you like to do?
 > Read transcript
   Summary
   Participants
   Recording link
   Back to list
```

- Built with stock `select`. Choices are always shown; each pushes its screen.
- Disable/annotate choices by known availability to avoid dead ends:
  - "Read transcript" - if `!getTranscript(id)`, render as
    `Read transcript (not downloaded yet)` and, on select, show the READ empty
    state rather than a viewer.
  - "Summary" - if `getMetadata(id)` lacks `summary` and `summary_short` and
    `notes_json`, annotate `(none yet)`.
  - "Participants" - annotate `(none)` when `participants_json` empty.
  - "Recording link" - always enabled (fetched live); may report none.
- `Esc`/`Back` returns to LIST with the same filter/sort/page preserved (store
  list scroll state on the nav frame).

---

## 3. SEARCH

Query -> results list -> selecting a hit opens READ centered on that line.
Supports pagination and re-search. Mirrors `handleSearch` semantics (line-level
BM25, or hybrid BM25 + thematic speaker-turn + detail chunks when
`semanticEnabled()`), but fusion lives in the presenter/data layer; this screen
just asks for "page P of results for Q".

### Flow

1. **Query prompt** (stock `input`, or `search`-style live if the data layer is
   fast enough; default to `input` for an explicit Enter-to-run):

   ```
    Search transcripts
    ? Search your meetings:  pricing objections▊
      Enter to search - Esc to go back
   ```

2. **Results list** (custom-lite: reuse the LIST prompt's paging shell, or a
   `select` whose choices are the hits plus paging pseudo-rows). Recommend the
   same `createPrompt` list shell as LIST for consistent keys.

   Term handling matches the dispatcher: tokenize the query into
   `\p{L}\p{N}` terms, build `match = terms.map(t=>`"${t}"`).join(" ")`, and use
   `terms[0]` as the snippet anchor. `sort` default "best"; `f` cycles
   best/newest/oldest. `limit` default 10.

   ```
    Search: "pricing objections"                 best match - 37 hits (page 1/4)

      2026-06-02 14:30   Pricing review with Acme          line 214
    >   ...they raised two pricing objections, first the per-seat...
      2026-05-20 10:00   Renewal - Beta Corp               line 88
        ...our pricing was fine but the objections were about onboarding...
      ...

    Page 1 / 4      showing 1-10 of 37

    [up/down] move  [enter] open at line  [/] new search  [s] sort  [n/p] page  [Esc] back
   ```

   Each hit is a two-line entry: meta line (date, title, `line N`) + a dim
   snippet. Snippet built by the presenter using the dispatcher's
   `snippetAround(text, anchor, 80)` (window around first match, collapse
   whitespace, ellipses at the cut edges). Title truncated; snippet truncated to
   terminal width.

### Data
```
count = store.countLineMatches(match, {dateFrom,dateTo})    // keyword path
rows  = store.searchLines(match, {limit,offset,sort,dateFrom,dateTo})
```
Each `SearchRow` = `{ meeting_id, line_no, text, created_at_ms, name }`. When
`semanticEnabled()`, the presenter returns fused hits instead (same row shape,
`total` is the fused count); this screen renders identically and shows the label
`hybrid: keyword + semantic` in the header instead of `best match`.

### Keys

| Key         | Action                                                   |
|-------------|----------------------------------------------------------|
| up/down     | Move between hits (wrap across pages at edges)            |
| `Enter`     | Open READ for `meeting_id`, jumped and centered on `line_no`, that line highlighted |
| `/`         | New search (re-prompt for query, reset to page 1)        |
| `s` or `f`  | Cycle sort best -> newest -> oldest                      |
| `n` / `p`   | Page through results                                      |
| `Esc` / `q` | Back to menu                                              |

### States
- **No query words** (`terms.length === 0`): "Type a word or two to search." and
  stay on the query prompt.
- **No matches**: `No lines match "pricing objections".` + `[/] try another search`.
- **Loading**: keyword path is instant; hybrid path (embeds the query, may load
  a model) shows a spinner `Searching (semantic)...`. If the embedder is
  unavailable (`SemanticUnavailableError` bubbles from the presenter), fall back
  to keyword results and show a dim note `semantic unavailable - keyword only`.
- **Open at line -> READ**: pushes READ with `initialLine = line_no`; READ scrolls
  so that line sits mid-viewport and marks it (see 4).
- Gates from 0.4 apply before the query prompt.

---

## 4. READ (transcript viewer)  [the important one]

In-place pager for a single meeting's transcript. MUST NOT dump thousands of
lines into scrollback - it paints a fixed-height viewport and repaints in place
(`eraseLines` + reprint, the wizard-prompt technique) as the user pages. This is
the deliberate opposite of the MCP tool, which never dumps and asks the agent to
pick a range; here the human just scrolls.

### Data (load once on entry)
```
meeting = store.getMeeting(id)
t       = store.getTranscript(id)
lines   = transcriptLines(JSON.parse(t.json))   // {n,timeSec,time,speaker,text}[]
```
Held in a `useRef` (immutable for the screen's life). Only the viewport window
and toggles live in `useState`. Word/line counts from `t.word_count` and
`lines.length`.

### Layout

```
 Weekly sync                                    2026-06-03 - 342 lines - 5,120 words

   211  [14:02] Sam:   the main risk is the migration window, we need a
                       fallback if the cutover slips past Friday
 > 214  [14:03] Dana:  agreed, and the pricing objections from Acme are the
                       other open item before we can sign
   217  [14:04] Sam:   right, I will take the pricing follow-up
   ...
   (viewport shows ~terminal-height rows; each turn wraps under a hanging indent)

   line 214 / 342                                              timestamps: on

   [up/down] line   [PgUp/PgDn] page   [g] go to line   [/] find   [t] times
   [n/N] next/prev match   [Esc] back
```

- Each transcript line = one spoken turn: `N  [time] Speaker:  text`. Text wraps
  to width with a hanging indent aligned under the text column so the number /
  speaker gutter stays clean. A single long turn may itself exceed the viewport;
  paging then scrolls within it (viewport is line-of-text based, tracking a
  top-offset into the wrapped-line array, not the turn array).
- The active turn gets the `>` cursor + cyan, matching the house style.
- Header right shows date + line/word counts. Footer left shows current turn /
  total; footer right shows the timestamps toggle state.

### Rendering approach
Precompute the wrapped display lines once per width (and whenever `timestamps`
toggles or the terminal resizes via `process.stdout.on("resize")`). Keep a map
from turn number -> first display-row index for "go to line" and search jumps.
`usePagination` can drive the window, or manage a `top` offset manually; manual
gives precise control for "center this line". Repaint = `eraseLines(prevHeight)`
then print the current window (never `console.log` the whole transcript).

### Keys

| Key                 | Action                                                        |
|---------------------|--------------------------------------------------------------|
| up / down           | Scroll one display line (move cursor/turn accordingly)       |
| PgUp / PgDn (or `b`/space) | Scroll one viewport height                            |
| Home / End (or `<`/`>`) | Jump to first / last line                                |
| `g`                 | Prompt "Go to line:" (inline `number` input); clamp 1..count, scroll so it is centered and highlighted |
| `t`                 | Toggle timestamps on/off (reflows display lines)            |
| `/`                 | Find-within: inline input; case-insensitive substring over `line.text`; collect matching turn numbers |
| `n` / `N`           | Next / previous find match (jump + highlight); wraps        |
| `r`                 | Reload transcript from store (in case it just finished downloading) |
| `Esc` / `q`         | Back to the meeting ACTIONS submenu                         |

`initialLine` (from SEARCH) makes entry scroll so that line is centered and
transiently highlighted (distinct from the find highlight), and seeds the find
state empty.

### Find-within detail
- On `/`, capture a term with a small inline input (dim prompt on the footer
  line: `find: pric▊`). On Enter, compute `matches = lines.filter(l =>
  l.text.toLowerCase().includes(term)).map(l => l.n)`. Show `find "pric": 6
  matches` in the footer; `n`/`N` cycle. Highlight the matched substring within
  the turn (invert or yellow). `Esc` in find input cancels.
- No matches: footer `find "xyz": no matches`, viewport unchanged.

### States
- **No transcript** (`!t`): do not open the pager. Show:
  ```
   Weekly sync
   The transcript has not been downloaded yet.
   (42 / 118 transcripts synced - check STATUS)      [only if downloading]
     [ View status ]   [ Back ]
  ```
  Distinguish by `getSyncState().phase`: `downloading` -> the progress line and
  "check back" tone; otherwise "No transcript available for this meeting."
- **Empty transcript** (`lines.length === 0`): "This transcript has no spoken
  lines."
- **Very large transcript**: no special case beyond paging - load is a single
  JSON.parse already done by the store elsewhere; viewport keeps memory/scrollback
  flat regardless of length. This is the core requirement and the paging design
  above satisfies it.
- Gates from 0.4 apply on entry (though normally reached from an unblocked LIST).

---

## 5. SUMMARY

Clean human render of the meeting's summary, action items, and notes-by-topic.

### Data
```
meeting = store.getMeeting(id)
meta    = store.getMetadata(id)   // summary_short, summary, notes_json
```
Parse `notes_json` exactly as `handleSummary`:
`{ notes?: {topic?, notes?: string[]}[], actionItems?: {assignedTo?, action?, dueDate?}[] }`.
Guard the `JSON.parse` in try/catch; malformed -> treat as no notes.

### Layout

```
 Pricing review with Acme
 2026-06-02 14:30 UTC

 ── In short ──────────────────────────────────────
   Acme pushed back on per-seat pricing; we agreed to send a volume quote
   and revisit onboarding scope next week.

 ── Summary ───────────────────────────────────────
   <meta.summary, wrapped to width, blank line between paragraphs>

 ── Action items ──────────────────────────────────
   [ ] Send volume-based quote to Acme          Dana - due 2026-06-06
   [ ] Scope onboarding package                 Sam
   [ ] Confirm security review timeline

 ── Notes by topic ────────────────────────────────
   Pricing
     - Per-seat model seen as too expensive above 50 seats
     - Requested annual commit discount
   Onboarding
     - Wants a dedicated CSM for the first 90 days

   [up/down] scroll   [Esc] back
```

- Section rule lines use box-drawing/hyphen fills sized to width; omit any
  section whose data is absent (no empty headers).
- Action items: `[ ]` bullet, action text, then a dim right-aligned or
  trailing `assignee - due date` tag built only from present fields (mirrors the
  dispatcher's `assignee: / due:` join, but human-styled). These are display
  only (not toggleable - no persistence layer for checked state).
- Notes: topic as a subheading, its `notes[]` as bullets.

### Behaviour / states
- Content usually fits; when it exceeds the viewport, the whole screen scrolls
  (reuse the READ pager's viewport mechanism in read-only mode - up/down/PgUp/
  PgDn, no find/goto). If it fits, render statically with just `[Esc] back`.
- **No metadata at all** (`!meta` or all three fields empty): 
  "No summary available for this meeting yet." + `[Esc] back`. If
  `getSyncState().phase === "downloading"`, add "It may still be syncing."
- `r` reloads metadata; `Esc`/`q` back to ACTIONS.

---

## 6. PARTICIPANTS

Table of name / email / host.

### Data
```
meta = store.getMetadata(id)
ps   = meta?.participants_json ? JSON.parse(...) : []   // {displayName?,email?,isHost?}[]
```
Guarded parse (as `handleParticipants`). **Fallback**: if the local list is
empty but the user explicitly refreshes (`r`), offer a live fetch via
`client.getMeetingParticipants(id)` behind a spinner (the store copy is normally
sufficient; this is an escape hatch, and it is a network call so it is opt-in).

### Layout

```
 Participants - Pricing review with Acme (5)

   NAME                     EMAIL                          HOST
   ─────────────────────────────────────────────────────────────
   Dana Ordonez             you@example.com                 yes
   Sam Rivera               sam@acme.com                   -
   Dana Cho                 dana@acme.com                  -
   (guest)                  jordan@acme.com                -
   Priya N                                                 -

   [r] refresh from Sana   [Esc] back
```

- Columns padded to the max width in each column, clamped to terminal width
  (email truncated with ellipsis before name). Host shows `yes` / `-`.
- Missing name -> `(guest)`; missing email -> blank cell. Host sorted first is
  optional; default preserve source order.

### States
- **None**: "No participant information for this meeting." + `[r] fetch from
  Sana` + `[Esc] back`. If `r` fetch also returns none, "Sana has no
  participant list for this meeting."
- **Fetch error / session expired**: dim red "Could not reach Sana: <message>."
  and keep whatever local rows exist. `SessionExpiredError` -> route to LOGIN
  (0.4 step 1 panel).

---

## 7. RECORDING

Fetch the live signed URL, show it with an expiry note, offer open-in-browser or
copy. This is the only screen that hits the network for its main content
(mirrors `handleRecording`).

### Flow
1. **Loading**: on entry, spinner `Fetching recording link...` while awaiting
   `client.getMeetingById(id)`. Use a stock spinner or a `useEffect`-driven
   frame in a `createPrompt` view.
   ```
   url = info?.recordingUrl || info?.fallbackRecordingUrl
   ```
2. **Result**:

   ```
    Recording - Pricing review with Acme

      A temporary signed link (expires in a few hours):

      https://media.sana.ai/rec/....signed....

    ? Open how?
    > Open in browser
      Copy link to clipboard
      Show full URL (for manual copy)
      Back
   ```

   - **Open in browser**: cross-platform launch, no extra deps -
     `win32` -> `cmd /c start "" "<url>"`; `darwin` -> `open "<url>"`;
     else -> `xdg-open "<url>"`. Spawn detached, ignore stdio; wrap in try/catch
     and on failure fall through to "Show full URL". (Follow the platform
     branching already used in `runCommandClient` in `install.ts` for the
     Windows quoting pattern.)
   - **Copy to clipboard**: `pbcopy` (darwin) / `clip` (win32) /
     `wl-copy`||`xclip -selection clipboard` (linux) via piped spawn; if none
     found, show the "Show full URL" panel and note "no clipboard tool found".
   - **Show full URL**: print the URL alone on its own line for terminal
     select-copy, plus `[Esc] back`.

### States
- **No recording** (`!url`): "No recording is available for this meeting." +
  `[Esc] back`.
- **Session expired** (`SessionExpiredError`): route to LOGIN panel (0.4 step 1).
- **Network error**: red "Could not fetch the recording link: <message>." +
  `[r] retry` + `[Esc] back`.
- Note under every result: the URL is temporary; re-open the screen to mint a
  fresh one (do not cache it).

---

## 8. LOGIN

Human-facing two-step email + code sign-in. Reachable from the menu when logged
out, and pushed by the 0.4 logged-out gate. Coordinate the exact copy with the
presentation-split agent; the flow and states are below. Reuses the same client
methods `handleLogin` uses, but drives them directly (not through the
`sana("login", ...)` string tool) so it can react to each step.

### Flow

```
 Sign in to Sana

 ? Email on your Sana.ai subscription:  you@example.com▊
```

1. `email = input({ message: "Email on your Sana.ai subscription:" })`, trimmed.
   Empty -> stay. (Optional `workspace_id` is advanced; offer only behind a "more
   options" toggle or skip for v1.)
2. Spinner `Sending code...` -> `await client.requestSignInCode(email)` then
   `client.save()`.
   ```
    A 6-digit code was emailed to you@example.com.

    ? Enter the code:  ______
      Did not arrive? [s] resend   [Esc] cancel
   ```
3. `code = input({ message: "Enter the code:" })` (or a fixed-width `number`).
   Spinner `Verifying...` -> `await client.submitSignInCode(email, code)`.
4. On success, replicate the dispatcher's post-login side effects so a catch-up
   sync starts and screens gate correctly:
   ```
   store.resetFailures()
   store.updateSyncState({ blocking: 1, catchup_epoch_ms: Date.now() })
   ensureDaemonRunning()
   ```
   Then show success and route onward:
   ```
    Signed in as you@example.com.

    Downloading your transcripts now. This can take a minute.
      [ View sync status ]     [ Back to menu ]
   ```
   Because `blocking` is now 1, the data screens will show the 0.4 sync panel
   until the daemon clears it - which is correct and expected right after login.

### States
- **Send failed** (requestSignInCode throws): red "Could not start sign-in for
  <email>: <message>." + `[Enter] try again` (re-prompt email).
- **Bad / expired code** (submitSignInCode throws): "That code did not work.
  Check it, or press `s` to send a new one." Stay on the code step; keep the
  email.
- **Resend** (`s` on the code step): re-run step 2 for the same email.
- **Cancel** (`Esc`): pop back; the menu still shows "logged out".
- Already logged in (screen entered while a session exists): short-circuit to
  "Already signed in as <email>. [Sign out] [Back]" (sign-out is out of scope
  unless the shell provides it; otherwise just Back).

---

## 9. CONFIGURE AI CLIENTS

Menu entry that reuses the existing configurer wizard - do not reimplement.

### Behaviour
- Selecting this entry calls the existing `runInstall()` from
  `src/install/install.ts` (the same code path bare `sana-mcp` uses today), which
  runs `wizardPrompt` over detected clients, applies the enable/disable diff, and
  then offers `maybeLogin`.
- Because `runInstall` writes to stdout with `console.log` and drives its own
  prompt, run it as a discrete sub-flow: the shell suspends its own alternate
  render, awaits `runInstall({})`, then repaints the menu. (If the shell uses an
  alternate screen buffer, drop to the normal buffer for the duration so the
  installer's line output scrolls normally, then restore.)
- On return, refresh the menu's session badge (the installer may have signed the
  user in via `maybeLogin`).
- Empty / non-TTY / cancel behaviours are already handled inside `runInstall`
  (prints the appropriate message and returns); no extra states needed here.
- A sibling "Remove from clients" entry can similarly call `runUninstall({})`.

---

## 10. State-transition map

```
                         (bare `sana-mcp`)
                                |
                          [ MAIN MENU ]  <---- Esc from any top screen
             +----------+------+------+----------+-----------+---------+
             |          |             |          |           |         |
          STATUS      LIST         SEARCH      LOGIN      CONFIGURE   (quit)
                        |            |
              (Enter meeting)   (Enter hit)
                        |            |
                 [ MEETING ACTIONS ] |
             +-----+------+-------+---+----+
             |     |      |       |        |
           READ SUMMARY PARTIC. RECORDING |
             ^                             |
             +------- SEARCH hit ----------+   (READ opened at line_no)

  Any DATA screen entry:
    logged out?  --yes--> [LOGIN panel] --success--> re-enter
    blocking?    --yes--> [SYNC panel] --(auto when clears / View status)--> STATUS
    empty?       --yes--> screen-specific empty state
```

Nav is a stack (push on drill-in, pop on Esc). LIST preserves its
filter/sort/page across a round trip into ACTIONS and back. READ preserves its
scroll/find state only for its own lifetime (fresh each open).

## 11. Implementation notes / handoffs

- Two custom `createPrompt` components to build (pattern: `wizard-prompt.ts`):
  `meetingListPrompt` (screens 2 and reused by 3) and `transcriptPager`
  (screen 4, reused read-only by 5 when overflowing). Everything else composes
  stock `@inquirer/prompts`.
- Rendering primitives this doc assumes from the primitives agent: header/
  breadcrumb renderer, a colored status token, a width-aware truncate/wrap
  helper, a section-rule helper, a fixed-height viewport repainter
  (`eraseLines` + reprint), and a spinner. Colors follow the existing local
  ANSI palette in `wizard-prompt.ts` / `install.ts` (dim/bold/cyan/green/yellow/
  red) - no color dependency.
- Data-split agent handoffs: extend `listMeetings` row select to include
  `processing_phase` (for accurate `processing` status); expose a `searchPage`
  presenter that returns `{rows, total, label}` hiding the keyword-vs-hybrid
  branch; expose `recordingLink(id)` returning `{url|null}` or throwing
  `SessionExpiredError`; keep the `notes_json` / `participants_json` parsing in
  the presenter so screens receive typed view-models, not raw JSON.
- Every screen holds one `SanaStore` for its lifetime and `close()`s on pop.
  `RECORDING` and the PARTICIPANTS fallback are the only screens that touch
  `SanaClient` at render time.
```
