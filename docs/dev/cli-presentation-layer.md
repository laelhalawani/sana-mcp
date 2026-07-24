# CLI presentation layer: separating human UI from agent-facing text

## The bug

When a human runs `sana-mcp login` (or signs in through the interactive
configurer), the terminal prints text written for an LLM. After step 1 the
human sees:

```
A 6-digit sign-in code was just emailed to you@example.com.

Next: get that code, then call
  meeting_transcripts("login", {"email":"you@example.com", "confirmation_code": <the 6 digits>})

If you have an email-reading tool, read the most recent email from
noreply@example.com titled "Sign in to Sana" to find the code. Otherwise, ask the
user to read it to you.
```

That is nonsense at a terminal: there is no agent, no email-reading tool, and
no `meeting_transcripts(...)` call for a person to make. The human is sitting
in an inquirer prompt that is already asking for the code.

## Root cause

There is exactly one code path for both audiences. `sana(tool, args)` in
`src/tools/dispatch.ts` is the single dispatcher, and every handler returns a
string whose wording coaches an LLM to call the MCP tool. Both consumers reuse
it verbatim:

- `src/cli.ts` line 100: `const out = await sana(tool ?? "help", args)` -> the
  human CLI prints whatever the agent would have received, for every subcommand
  (`login`, `status`, `list`, `read`, `search`, `summary`, `participants`,
  `recording`).
- `src/install/install.ts` `maybeLogin()` (lines 257-297): calls
  `sana("status")`, `sana("login", {email})`, and
  `sana("login", {email, confirmation_code})` and `console.log`s the returned
  agent strings straight to the human. Line 262 even sniffs those strings with
  a regex (`/not logged in|to sign in|has expired/i`) to guess login state,
  which is brittle string-scraping of a presentation layer.

The agent-facing wording is correct and must stay for the MCP tool (project
rule). The fix is not to change those strings; it is to stop the human CLI from
consuming them at all.

## Design principle: one boundary, two renderers

```
                    +-----------------------------+
                    |  shared core (no strings)   |
                    |  src/core/*.ts              |
                    |  side-effects + queries ->  |
                    |  typed structured results   |
                    +--------------+--------------+
                                   |
             +---------------------+---------------------+
             |                                           |
   +---------v----------+                    +-----------v-----------+
   | MCP handlers       |                    | CLI screens           |
   | src/tools/dispatch |                    | src/cli.ts +          |
   | render LLM strings |                    | src/install/install   |
   | (unchanged wording)|                    | render HUMAN UI       |
   +--------------------+                    +-----------------------+
```

Rules:

1. The interactive CLI app and the configurer MUST NOT call `sana(tool, args)`
   for anything user-visible. They consume structured data (`SanaClient`
   results, `SanaStore` rows, and new core results) and render their own
   human-facing text.
2. All business logic and side-effects (login side-effects, status
   computation, search fusion, list/read/summary/participants querying,
   recording fetch) live in presentation-agnostic core functions that return
   typed data. Neither business logic nor SQL is duplicated between the two
   renderers.
3. `dispatch.ts` handlers keep their exact current strings; they just build
   those strings from the same core results the CLI uses.

## Every LLM-ism that must never reach a human

From `src/tools/dispatch.ts` and `src/tools/help.ts`. Left column stays for the
MCP tool; right column is what the human sees instead (rendered by the CLI, not
by dispatch).

| # | Agent-facing text (keep for MCP) | Where | Human equivalent (CLI renders) |
|---|---|---|---|
| 1 | `Run meeting_transcripts("login", {"email":...}) to sign in.` (`LOGIN_HINT`) | dispatch:15 | `You are not signed in. Run: sana-mcp login` |
| 2 | `...run meeting_transcripts("login", ...).` (`EXPIRED_MSG`) | dispatch:16 | `Your session has expired. Run: sana-mcp login` |
| 3 | `call meeting_transcripts("login", ...)` two-step explainer (`LOGIN_EXPLAINER`) | dispatch:17-22 | Not shown; the CLI just starts the interactive email prompt |
| 4 | `Next: get that code, then call meeting_transcripts("login", {..., "confirmation_code": <the 6 digits>})` | dispatch:119-126 | `We emailed a 6-digit code to X. Enter it below.` (then an input prompt) |
| 5 | `If you have an email-reading tool, read the most recent email... Otherwise, ask the user to read it to you.` | dispatch:125 | Omitted entirely |
| 6 | `Available tools: ...  Use meeting_transcripts("help", {"tool":...})` | dispatch:144-149 | `Signed in as X.` plus a human next-steps line (e.g. `Your meetings are syncing; run sana-mcp status to check.`) |
| 7 | `Check progress with meeting_transcripts("status").` | dispatch:96,151,186 | `Run sana-mcp status to check progress.` |
| 8 | `...request a new one with meeting_transcripts("login", {"email":...}).` | dispatch:170 | `Wrong or expired code. Choose "resend" or re-run sana-mcp login.` |
| 9 | `Use meeting_transcripts("list", {"page":2}) to see the next page.` | dispatch:275 | `--page 2` hint, or an interactive "more?" prompt |
| 10 | `Per meeting (by id): read, summary, participants...` | dispatch:279 | `Read one with: sana-mcp read --id <id>` |
| 11 | `meeting_transcripts("read", {"meeting_id":..., "full":true})` / `"lines":[start,end]` | dispatch:322-325 | `sana-mcp read --id <id> --full` / `--lines 22,26` |
| 12 | `Use meeting_transcripts("list") to find valid ids.` | dispatch:294,354,396 | `Run sana-mcp list to find valid ids.` |
| 13 | search "next page" + "Read around a hit with meeting_transcripts(...)" | dispatch:460-463 | `sana-mcp read --id <id> --lines <n-2>,<n+2>` |
| 14 | JSON-shaped arg examples in the whole `TOOLS[]` catalog | help.ts:8-74 | Human `sana-mcp <cmd> --flags` usage lines |
| 15 | `Set SANA_SEMANTIC=0 to use keyword search.` (env hint is fine either way) | dispatch:556 | Same wording is acceptable for humans; keep |

The unifying tells to grep for: the literal `meeting_transcripts(`, the phrases
`your agent` / `email-reading tool` / `ask the user to read it to you`, and any
JSON object literal (`{"..."}`) inside a returned string.

## Shared-core functions to extract

New directory `src/core/`. Each function is pure of presentation: it performs
side-effects and/or queries and returns typed data. No function returns a
display string.

### `src/core/login.ts`

```ts
export interface RequestCodeResult { email: string; workspaceId?: string }

// Step 1 side-effect. Wraps client.requestSignInCode + client.save().
export async function requestLoginCode(
  client: SanaClient, email: string, workspaceId?: string
): Promise<RequestCodeResult>   // throws on failure (caller renders the error)

export interface LoginResult {
  user: SanaUser;
  workspaceId?: string;
}

// Step 2 side-effect core, shared by BOTH the MCP handler and the CLI.
// Does exactly what handleLogin does today AFTER submitSignInCode succeeds:
//   client.submitSignInCode(email, code); client.save();
//   store.resetFailures();
//   store.updateSyncState({ blocking: 1, catchup_epoch_ms: Date.now() });
//   ensureDaemonRunning();
// Returns structured user info; does NOT wait and does NOT render.
export async function performLogin(
  client: SanaClient, store: SanaStore, email: string, code: string
): Promise<LoginResult>   // throws on bad code (caller renders the error)
```

`waitForSync(store, timeoutMs): Promise<{done: boolean; count: number|null}>`
moves here too (it already returns structured data). Both renderers call it
after `performLogin` to report progress in their own words.

This is the fix's centerpiece. `handleLogin` in dispatch keeps its agent
strings but its side-effect block (dispatch:130-142) is replaced by a call to
`performLogin`; the CLI login screen calls the same `requestLoginCode` /
`performLogin` and renders human prompts around them. The blocking flag,
`catchup_epoch_ms`, failure reset, and daemon spawn happen in exactly one place,
so the CLI can never drift from the MCP handler's side-effects.

### `src/core/status.ts`

```ts
export interface SessionInfo {
  hasCookie: boolean;
  loggedIn: boolean;     // hasCookie && phase !== "needs_login"
  expired: boolean;      // hasCookie but phase === "needs_login"
}
export function sessionInfo(client: SanaClient, s: SyncState): SessionInfo

export interface StatusInfo {
  session: SessionInfo;
  blocking: boolean;
  phase: SyncPhase;
  transcriptsDone: number;
  transcriptsTotal: number;
  remaining: number;
  etaMinutes: number;
  meetings: number;       // store.countMeetings()
  transcripts: number;    // store.countTranscripts()
  lastFullSyncMs: number | null;
  semantic: { enabled: boolean; embedded: number; total: number };
}
export function computeStatus(client: SanaClient, store: SanaStore): StatusInfo
```

Move the presentation-free helpers `estimateMinutes`, `syncBlocking`, and
`sessionUsable` here. `handleStatus` and the configurer's login-state check
(replacing the regex at install.ts:262 with `computeStatus(...).session.loggedIn`)
both consume `StatusInfo`.

### `src/core/search.ts`

```ts
export interface SearchRow {
  meeting_id: string; line_no: number; text: string;
  created_at_ms: number; name: string;
}
export interface SearchResult {
  query: string; anchor: string; label: string;
  total: number; page: number; offset: number; limit: number;
  rows: SearchRow[];
  error?: string;                 // structured error reason, not prose
  unavailable?: "semantic";       // caller renders its own message
}
export async function runSearch(
  store: SanaStore, args: Record<string, unknown>
): Promise<SearchResult>
```

Houses the entire keyword-only BM25 path and the hybrid RRF fusion currently in
`handleSearch` (dispatch:467-575), minus every string. `renderSearchResults`
stays in dispatch as the LLM renderer; the CLI gets its own renderer over the
same `SearchResult`. `snippetAround` moves to core (pure helper).

### `src/core/meetings.ts`

```ts
export type RowStatus = "ready" | "downloading" | "processing" | "failed";
export function rowStatus(r): RowStatus            // move from dispatch:237

export interface MeetingPage {
  rows: MeetingListRow[]; total: number;
  page: number; limit: number; offset: number; hasMore: boolean;
}
export function queryMeetings(store, args): MeetingPage   // parse filters + list

// read: returns a structured selection or a typed not-ready reason.
export type TranscriptState =
  | { kind: "ok"; meeting; lineCount; wordCount; lines; rangeNote }
  | { kind: "no-meeting" } | { kind: "still-listing" }
  | { kind: "not-downloaded"; done; total; etaMinutes }
  | { kind: "no-transcript"; name }
  | { kind: "needs-selection"; meeting; lineCount; wordCount }
  | { kind: "empty-range"; lineCount; rangeNote };
export function getTranscriptView(store, args): TranscriptState

export type SummaryView = { meeting; short?; summary?; actionItems[]; notes[] } | null;
export function getSummaryView(store, args): SummaryView   // parse notes_json here

export interface Participant { displayName?; email?; isHost?; }
export function getParticipants(store, id): { meeting; participants: Participant[] } | null

export type RecordingResult =
  | { kind: "ok"; name; url } | { kind: "none"; name }
  | { kind: "expired" } | { kind: "error"; message };
export async function getRecordingLink(client, store, id): Promise<RecordingResult>
```

`parseFilters`, `parseDateMs`, `posInt` move to a small `src/core/args.ts`
(shared arg coercion). `fmtDate`/`fmtDateTime` can stay as shared formatting
helpers in core; the markdown table rendering (`escCell`, the `| ... |` rows)
stays in dispatch because it is a presentation choice - the CLI renders plain
aligned columns instead.

## What moves vs. what stays in `dispatch.ts`

Moves to `src/core/`:

- login side-effects and `waitForSync` -> `core/login.ts`
- `estimateMinutes`, `syncBlocking`, `sessionUsable`, status computation ->
  `core/status.ts`
- BM25 + hybrid fusion, `snippetAround` -> `core/search.ts`
- filter/list/read/summary/participants/recording querying, `rowStatus` ->
  `core/meetings.ts`
- `posInt`, `parseDateMs`, `parseFilters` -> `core/args.ts`

Stays in `dispatch.ts` (agent renderers, wording unchanged):

- `LOGIN_HINT`, `EXPIRED_MSG`, `LOGIN_EXPLAINER`
- the `sana(tool, args)` dispatcher itself (the MCP entrypoint)
- every `handleX` becomes a thin renderer: call the core function, format the
  LLM string exactly as today (markdown tables, `meeting_transcripts(...)`
  hints, pagination hints, help catalog).
- `renderSearchResults`, `escCell`, the `TOOLS[]` catalog and `renderHelp` in
  help.ts (all agent-facing).

Net: dispatch.ts shrinks to string-building; the logic it used to hold now has
a second caller (the CLI) without a copy.

## Per-CLI-screen data-source map

Every screen below is rendered by the CLI (`src/cli.ts` subcommands and
`src/install/install.ts`). None calls `sana(tool, args)`.

| CLI screen | Core / structured source | Human output (no LLM-isms) |
|---|---|---|
| login step 1 | `requestLoginCode(client, email)` | `We emailed a 6-digit code to X. Enter it below.` -> inquirer `input` for the code |
| login step 2 | `performLogin(client, store, email, code)` then `waitForSync` | `Signed in as X.` + `Syncing your meetings... run sana-mcp status to check.` On error: `That code was wrong or expired.` with resend / retry choices |
| login errors | thrown errors from core (invalid code, expired, network) | Plain sentences + a `resend code` option that re-calls `requestLoginCode` |
| status | `computeStatus(client, store)` | `Signed in as X. 128 meetings, 128 transcripts. Up to date.` or `Syncing: 40/128 (~1 min).` |
| configurer login-gate | `computeStatus(...).session.loggedIn` (replaces regex at install.ts:262) | `Already signed in to Sana.` vs. offer to sign in |
| list | `queryMeetings(store, args)` | aligned columns date/id/status/title; footer `sana-mcp list --page N` if `hasMore` |
| read | `getTranscriptView(store, args)` | header + rendered lines (`renderLines`); not-ready states map to plain sentences; selection prompt suggests `--full` / `--lines a,b` |
| search | `runSearch(store, args)` | aligned hits; footer `sana-mcp read --id <id> --lines <n-2>,<n+2>`; semantic-unavailable -> plain note |
| summary | `getSummaryView(store, args)` | title, short/long summary, action items, notes |
| participants | `getParticipants(store, id)` | aligned name/email/host table |
| recording | `getRecordingLink(client, store, id)` | the URL + `expires in a few hours`; expired -> `Run sana-mcp login`; none -> `No recording for X.` |
| not signed in (any data screen) | `sessionInfo(...)` | `You are not signed in. Run: sana-mcp login` (never the `meeting_transcripts(...)` hint) |

The CLI needs its own small renderer module (e.g. `src/cli/render.ts`) holding
the human strings and column formatting, plus a login flow module (e.g.
`src/cli/login.ts`) driving the two inquirer prompts around the core calls.
`maybeLogin()` in the configurer is rewritten to call that same login flow
instead of `sana("login", ...)`.

## Login flow redesign (human-facing), step by step

1. Prompt: `Email for your Sana account:` -> read `email`.
2. `await requestLoginCode(client, email)`. On throw:
   `Could not start sign-in for <email>: <message>` and offer retry.
3. Print: `We emailed a 6-digit code to <email>. Enter it below.`
   (No `meeting_transcripts(...)`, no "your agent", no "email-reading tool".)
4. Prompt: `6-digit code (or "r" to resend):`.
   - `r` -> back to step 2 (`requestLoginCode` again).
   - empty -> `Skipped. Run sana-mcp login when you have the code.` and exit.
5. `await performLogin(client, store, email, code)`. On throw (invalid/expired):
   `That code was wrong or expired. Choose resend, or re-run sana-mcp login.`
   -> re-prompt (bounded retries).
6. On success: `Signed in as <user.email>` (+ workspace if present). Then
   `await waitForSync(store, COUNT_WAIT_MS)`:
   - `done` -> `Your transcripts are up to date.`
   - `count != null` -> `Syncing <count> transcript(s) (~<eta> min). Run sana-mcp status to check.`
   - otherwise -> `Syncing in the background. Run sana-mcp status to check.`

All side-effects (session save, `resetFailures`, `blocking:1` +
`catchup_epoch_ms`, `ensureDaemonRunning`) happen inside `performLogin`, so the
CLI and the MCP handler are guaranteed identical here.

## Non-goals / guardrails

- Do not change any agent-facing string in `dispatch.ts` or `help.ts`.
- Do not duplicate SQL or fusion logic; the CLI and MCP share one core.
- The MCP tool remains the single `sana(tool, args)` entrypoint; only its
  handlers are refactored to build strings from core results.
- `sana-mcp <tool> [json]` raw passthrough (cli.ts:84-102): decide per taste -
  either keep it as a debug escape hatch that still prints agent strings
  (documented as such), or route it through the human renderers. The
  interactive/`login`/configurer paths are the ones that must be human.
```
