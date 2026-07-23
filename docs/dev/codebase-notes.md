# sana-mcp - codebase notes & quirks

A reference for anyone working on this code. Captures the architecture, the
agent-facing string conventions, the runtime behavior, and the rough edges.
Generated from a full read of `src/`, `scripts/`, the docs, and the runtime
data on 2026-07-23.

Use hyphens, not em/en dashes, in all code and docs in this repo.

---

## 1. What it is

A local sync + search layer for Sana.AI meeting transcripts, exposed to LLM
agents as a **single MCP tool** (`meeting_transcripts`) plus a matching CLI.
Sana has no public meetings API, so this replays the Sana web app's own tRPC
backend (`sana.ai/x-api`) using the logged-in cookies over plain `fetch`. A
background daemon is the **only** component that talks to Sana; agent tools
read solely from a local SQLite DB. The lone network exception among the data
tools is `recording`, which fetches a short-lived signed link on demand.

Stack: TypeScript (strict, NodeNext, ESM, ES2022). Hard deps: `better-sqlite3`,
`@modelcontextprotocol/sdk`, `commander`, `playwright`. Optional deps:
`@huggingface/transformers`, `sqlite-vec` (semantic/hybrid search).

## 2. Module map

**Entry points**
- `src/mcp.ts` - MCP server. Registers one tool `meeting_transcripts`
  (`{tool, args}` schema); body calls `sana(tool, args)` and wraps the returned
  string as text content. The "running on stdio" line goes to **stderr** so it
  never corrupts the JSON-RPC stream on stdout.
- `src/cli.ts` - Commander CLI. Default command `sana <tool> [json]`; flags
  merge into `args`. `sana daemon` runs the syncer in the foreground.
- `src/daemon-main.ts` - standalone daemon entry; `runDaemon()` + fatal guard.

**Dispatch / agent surface**
- `src/tools/dispatch.ts` - the brain. `sana(tool, args)` is the single entry
  both entry points share. Routes to handlers, gates on session/sync state,
  emits all the human-readable strings.
- `src/tools/help.ts` - `TOOLS[]` docs array + `renderHelp()`. This is the
  agent's discovery surface.

**Sana API client**
- `src/sana/client.ts` - `SanaClient`. Cookie-aware `fetch` with **manual
  redirect chasing** (captures cookies set mid-302), `trpcQuery`/`trpcMutation`
  wrappers, two-step magic-link login, cursor-paginated meeting listing,
  transcript/metadata/participants fetchers.
- `src/sana/cookies.ts` - `CookieJar`. Deliberately minimal single-domain
  name->value map; ignores path/expiry; treats `deleted`/empty `Set-Cookie`
  values as "clear".
- `src/sana/types.ts` - domain types + `SessionExpiredError`.
- `src/sana/transcript.ts` - turns raw word-segments into numbered spoken-turn
  lines; renders with optional timestamps/numbers; word counter.

**Storage**
- `src/store/db.ts` - `SanaStore` over SQLite (WAL, busy_timeout 5s). Tables:
  `meetings`, `transcripts`, `meeting_metadata`, `fetch_failures`,
  `line_embeddings`, `sync_state`, plus FTS5 table `line_fts` (BM25, unicode61
  + remove_diacritics 2). Has a migration shim that `ALTER`s older DBs.

**Sync machinery**
- `src/sync/daemon.ts` - `runDaemon()` loop + `syncOnce()`: refresh meeting
  list (stop-early on incremental), download missing transcript+metadata per
  meeting, embed if semantic on, then set `phase:"synced"`. Heartbeats every
  5s; incremental every 10min (env-tunable).
- `src/sync/lock.ts` - liveness = heartbeat within 30s AND PID responds to
  signal 0 (EPERM counts as alive).
- `src/sync/spawn.ts` - `ensureDaemonRunning()` spawns a detached daemon if
  none alive; detects `.ts` (dev, `node --import tsx`) vs `.js` (prod).

**Semantic (optional)**
- `src/semantic/semantic.ts` - lazy-loads the MiniLM embedding pipeline,
  idle-unloads after 60s, stores vectors in a `sqlite-vec` virtual table,
  KNN search.

**Dev scripts** (`scripts/*.mjs`, tracked) - all Playwright-based
reverse-engineering helpers:
- `bootstrap-session.mjs` - imports profile cookies into `session.json`.
- `validate.mjs` - POC proving headless `fetch` against tRPC works.
- `paginate.mjs` - walks `asset.listRecent` pages to confirm cursor/offset.
- `investigate.mjs` / `record.mjs` - headed traffic recorders (XHR/HAR/trace).

## 3. Lifecycle / data flow

1. **Login** (`dispatch.handleLogin`) -> request code -> submit code -> `me()`
   to adopt workspace -> `resetFailures()` + `updateSyncState({blocking:1})` +
   `ensureDaemonRunning()` -> `waitForSync()` up to 30s (half the 60s MCP
   timeout) -> report done/progress.
2. **Daemon** (`runDaemon`) loops: no cookie -> `needs_login`, sleep 15s; else
   `me()` -> `syncOnce()`. On `SessionExpiredError` -> `needs_login`; other
   errors -> `phase:"error"`, sleep 30s. Between cycles it sleeps the
   incremental interval but **wakes early** if `blocking` flips back to 1.
3. **Agent reads** (`sana`) -> check auth cookie + session usable -> ensure
   daemon alive -> if `blocking`, return the "sync in progress" message
   (except `status`/`help`, which stay live) -> else serve from the DB.

## 4. Agent-facing string conventions

Every tool returns a **plain string** - never structured JSON, never thrown.

- **Markdown tables with type-annotated headers.** Columns carry their type
  inline for reliable model parsing: `started_at (UTC, YYYY-MM-DD HH:MM)`,
  `id (string)`, `status (ready/downloading/processing/failed)`, `line (int)`,
  `host (yes/no)`. Cells are pipe-escaped (`\|`) and newlines flattened
  (`escCell`, dispatch.ts).
- **Copy-pasteable next-call hints everywhere.** The code emits ready-to-fire
  invocations rather than prose: `Use meeting_transcripts("list", {"page":2})`,
  `Read around a hit with meeting_transcripts("read", {"meeting_id":"<id>",
  "lines":[<line>-2, <line>+2]})`, pagination footers, the "no selection"
  prompts in `read`. The agent is hand-fed its own next tool call.
- **Fixed time formats.** Table cells = `fmtDateTime` (`YYYY-MM-DD HH:MM`,
  UTC, `T`->space). Transcript date header = `fmtDate` (`YYYY-MM-DD`). Inline
  transcript timestamps = `fmtTime` (`m:ss` or `h:mm:ss`). All labeled UTC.
- **Signature is uniform:** `meeting_transcripts("<tool>", {...})` everywhere.
- **`read` is deliberately lazy.** With no `full`/`lines` selection it does
  **not** dump - it reports the line count and offers the two invocation
  forms, to avoid blowing context on a huge transcript.
- **Search labels its mode** in the header: `keyword, ranked by relevance` vs
  `hybrid: keyword + semantic`.

## 5. Error / edge behavior

- **Nothing throws to the agent.** `sana()` and every handler catch and
  stringify: `Could not run search for "...": <msg>`, `Sign-in failed: <msg>`,
  `Could not fetch the recording link: <msg>`.
- **Session-expiry is a typed branch.** 401/403 from tRPC ->
  `SessionExpiredError` -> either `EXPIRED_MSG` (recording) or `needs_login`
  phase (daemon). `sessionUsable()` avoids needless network calls.
- **The blocking latch.** `blocking:1` set on every login, cleared by the
  daemon only when fully caught up. While set, data tools short-circuit to
  `syncBlockedMessage` with an ETA; `status` and `help` are exempt.
- **Lenient arg coercion.** Dual keys accepted (`meeting_id`/`id`,
  `confirmation_code`/`code`); `Number(args.limit ?? 50)` with clamp; tool
  name `.trim().toLowerCase()`; unknown tool -> help text (never an error).
- **Failure tracking, not exceptions.** Bad transcripts increment
  `fetch_failures.attempts`; at `MAX_TRANSCRIPT_ATTEMPTS` (default 5) a
  meeting is "failed" and stops blocking. Login `resetFailures()` wipes
  counters for a clean retry.
- **Semantic graceful degradation.** Embedding error mid-search -> silently
  fall back to already-fused keyword results; `SemanticUnavailableError`
  (deps missing) -> an explicit instruction to set `SANA_SEMANTIC=0`.

## 6. System-call / process behavior

- Daemon spawned `detached:true`, `stdio:["ignore", logFd, logFd]`, `unref()`,
  `windowsHide:true`; stdout/stderr -> `data/daemon.log`.
- Liveness is a **heartbeat + PID check**, NOT a file lock. There's a TOCTOU
  window - the log shows two daemons starting within 1ms (pids 9708/9709). No
  mutex exists; the 30s stale window is the only guard.
- Entry detection branches on the current file's extension: `.ts` ->
  `node --import tsx entry.ts`, `.js` -> `node entry.js`.
- SQLite: `journal_mode=WAL`, `busy_timeout=5000`; all writes transactional;
  FTS backfilled lazily on first search if empty.

## 7. Quirks, dead code, inconsistencies

- **`src/browser.ts` and `src/state.ts` were removed** (Pass 1). `browser.ts`
  (Playwright `launchPersistent`/`hasSession`) was leftover from an earlier
  browser-driven design; `state.ts` (file-based `DownloadedMeeting`/`saveState`)
  predates the SQLite store. Playwright is still a hard dep and powers every dev
  script, so the README's "no browser required" is true only for the live path.
- **Stale tool aliases.** The dispatcher still accepts `list_meetings`/
  `read_transcript` (dispatch.ts) alongside the documented `list`/`read`. Works,
  but inconsistent with the README/MCP `description`/TOOLS list.
- **`list` status has a value you can't filter by.** `rowStatus` can return
  `"processing"` and the table header advertises it, but `parseFilters` only
  accepts `ready|downloading|failed` - no way to filter for processing.
- **Naming mismatch.** `sync_state.transcripts_total` is actually the
  **meeting** count; `transcripts_done` = `countComplete()` (transcript AND
  metadata). The "transcripts" labels really mean "meetings".
- **Potential semantic livelock.** `blocking` clears only when
  `meetingsMissingEmbedding()` is empty. A transcript that succeeds but whose
  embedding persistently fails isn't excluded by failure counters, so the
  daemon could loop on it and `blocking` would stay latched (rare in practice).
- **CLI flags.** The stale `--offset` flag was removed (`handleListMeetings`
  derives offset from `page`); `--no-timestamps` remains and is intentional -
  it's the CLI mirror of the `timestamps` arg.
- **Hardcoded workspace id** `Yy6S4JGT8SAx` in `record.mjs`/`validate.mjs`/
  `paginate.mjs` - a real-looking identifier left in dev scripts.
- **FTS is whole-word only.** Query tokens (`\p{L}\p{N}+`) are quoted and
  AND-ed for FTS5-safety, so substring/partial matches silently miss.
- **ETA is a rough constant** (`estimateMinutes`: ~0.5s/transcript, rounded up
  to a minute).

No test suite exists. `data/session.json` currently holds a live session
(cookies incl. `sana-ai-session`, a workspaceId, `pendingLogin: null`) -
sensitive, gitignored, correctly never logged.

## 8. Port-target surface (for the Rust/Go studies)

The exact technical surface a port must cover:
- HTTPS client to `sana.ai/x-api/trpc/<proc>`: JSON GET (query-string input)
  and POST (JSON body). TLS, cookie jar (parse Set-Cookie, resend Cookie,
  treat `deleted`/empty as clear), custom header `sana-ai-workspace-id`,
  manual 302 redirect chasing.
- SQLite (WAL, busy_timeout, transactions) with FTS5 (BM25, unicode61,
  remove_diacritics 2) and the **sqlite-vec** loadable extension (KNN over
  float[384]).
- Optional on-device embeddings: `all-MiniLM-L6-v2` (384-dim), q8/INT8,
  lazy-loaded, idle-unloaded ~60s, ~150MB while active, model cached on disk.
- MCP server over stdio (JSON-RPC 2.0), one registered tool.
- CLI (subcommands, flags, optional JSON arg).
- Detached daemon spawn + PID liveness (signal 0) + (ideally) a file lock.
- Cross-platform file I/O, mkdir -p, atomic writes.

Current footprint: Node baseline (tens of MB) + better-sqlite3; +~150MB with
the model loaded.
