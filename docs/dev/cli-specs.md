---
status: superseded
scope: former combined CLI, installer, runtime, and release specification
last_verified: 2026-07-24
superseded_by: remediation-plan.md
---

# sana-mcp CLI - complete specification

The authoritative spec for the `sana-mcp` command-line tool: how it is
downloaded, installed, and configured, and every command, option, and behaviour
it exposes. Covers the download UX, the interactive configurer, the interactive
app, the one-shot tool commands, the MCP server, the background daemon, all
flags, environment variables, and exit/edge behaviour.

Status legend used throughout:

- [shipped] - implemented in the current `v0.4.14` release candidate.
- [planned] - designed in the per-area documents but not implemented in the
  current release candidate.

Style: hyphens only, never em/en dashes. All timestamps are UTC unless stated.

---

## 1. Overview

`sana-mcp` is one self-contained binary with several faces:

| Face | Invocation | Purpose |
|---|---|---|
| Interactive app | `sana-mcp` (no args, in a terminal) | Browse, search, read meetings, sign in, and configure clients [shipped]. |
| Client configurer | `sana-mcp install` (aliases `config`, `configure`) | Detect installed AI clients and register/unregister the MCP server with them. |
| One-shot tool | `sana-mcp <tool> [json]` + flags | Non-interactive, scriptable output of a single capability (help/status/list/read/search/...). |
| MCP server | `sana-mcp mcp` | Speak MCP over stdio; this is what AI clients launch. |
| Background daemon | `sana-mcp daemon` | The only component that talks to Sana; syncs meetings into local SQLite. |
| Updater | `sana-mcp update` | Verify and install the latest release from an installed standalone runtime. |
| Uninstaller | `sana-mcp uninstall` | Remove the server from chosen clients. |

The binary is produced with `bun build --compile` for seven verified targets:
Linux x64/ARM64 with glibc or musl, macOS x64/Apple Silicon, and Windows x64.
Windows ARM64 is not currently published. It embeds the Bun runtime. Alpine
also requires its `libstdc++`, `libgcc`, and `gcompat` runtime packages; the POSIX installer
checks them before downloading release metadata or binary assets and prints the
exact `apk add` command when absent.

Data is local-only. A background daemon downloads meetings, transcripts, and
metadata into a local SQLite database; all read commands serve from that DB and
never block on the network. The single network exception among data commands is
`recording`, which fetches a short-lived signed link on demand. Nothing leaves
the machine except authenticated requests to Sana.

---

## 2. Download and install UX

### 2.1 One-line installers

macOS / Linux:

```
curl -fsSL https://github.com/laelhalawani/sana-mcp/raw/main/install.sh | sh
```

Windows (PowerShell):

```
irm https://github.com/laelhalawani/sana-mcp/raw/main/install.ps1 | iex
```

Both scripts:

1. Resolve the release tag from `SANA_MCP_VERSION` when explicitly pinned.
   Otherwise, detect the target first and download
   `releases/latest/download/manifest-<target>.properties` together with its
   `.sha256`; only the checksum-verified projection supplies the exact release
   tag.
2. Select one canonical asset:
   - glibc Linux: `sana-mcp-linux-{x64,arm64}`;
   - musl Linux: `sana-mcp-linux-{x64,arm64}-musl`;
   - macOS: `sana-mcp-darwin-{x64,arm64}`;
   - Windows: `sana-mcp-windows-x64.exe` (Windows ARM64 is not published).
3. Download the binary with platform-specific progress:
   - `install.sh` uses `curl --progress-bar` without deriving separate speed or
     ETA fields.
   - `install.ps1` uses a custom streamed renderer such as
     `[####----] 45%  43.2/95.5 MB  2.4 MB/s  ETA 00:21`.
4. Require and verify the SHA-256 sidecars for release metadata, the release
   manifest, and the selected binary. A missing, malformed, mismatched, or
   incorrectly named checksum aborts before installation; checksum verification
   is never skipped. [shipped]
5. Place the binary:
   - macOS/Linux: `${SANA_MCP_INSTALL_DIR:-~/.local/bin}/sana-mcp`.
   - Windows: `${SANA_MCP_INSTALL_DIR:-%LOCALAPPDATA%\sana-mcp}\sana-mcp.exe`.
6. Add the install dir to PATH without duplicating entries:
   - POSIX exports it for the current installer process and persists it in an
     applicable supported shell profile when needed.
   - Windows writes User PATH for new shells only; it launches the configurer by
     the authoritative absolute executable path.
7. Complete the platform handoff:
   - A direct Windows script run commits the runtime transaction, releases its
     locks and temporary resources, then attempts to start the public configurer.
   - POSIX keeps client configuration inside its installer transaction.
   - An updater handoff does not start the configurer.

Manual install: download the asset for your platform from the
[Releases page](https://github.com/laelhalawani/sana-mcp/releases), verify its
`.sha256`, `chmod +x` (POSIX), and put it on PATH.

### 2.2 Installer environment variables

| Var | Default | Effect |
|---|---|---|
| `SANA_MCP_VERSION` | latest release | Pin the release tag to install. |
| `SANA_MCP_INSTALL_DIR` | `~/.local/bin` (POSIX), `%LOCALAPPDATA%\sana-mcp` (Windows) | Where the binary is placed. |
| `SANA_MCP_YES` | unset | Unattended: register with all detected clients without a picker and skip authentication. |

### 2.3 Handoff and screen flow

Windows and POSIX intentionally use different transaction boundaries:

- Every successful direct Windows script run - local or one-line, fresh,
  compatible, or incompatible - attempts to start the public
  `sana-mcp install` configurer exactly once after runtime commit, installer
  cleanup, and lock release.
- The Windows configurer presents registrations that exactly match the installed
  command as checked starting selections. In interactive setup it also recognizes
  valid saved Sana authentication. `SANA_MCP_YES=1` runs
  `sana-mcp install --yes` without the picker or authentication, after which the
  Windows installer prints the exact command to sign in. A direct non-TTY run
  still attempts the public configurer; if interaction is unavailable,
  installation remains successful and the script prints an exact retry command.
- An updater handoff never starts the configurer, even when `SANA_MCP_YES=1`.
  A compatible Windows update preserves registration, authentication, and local
  meeting state without setup output. Only an incompatible Windows update prints
  the exact deferred command that opens client configuration and sign-in.
- POSIX behavior is unchanged. A fresh interactive direct install runs the
  private, journaled configuration transaction before installer commit. A fresh
  direct non-TTY install defers configuration and prints the exact public
  command; `SANA_MCP_YES=1` performs unattended transactional configuration.
  A receipt-backed compatible existing direct install preserves client
  configuration and does not reopen it.

The public configurer detects supported AI clients, allows checked selections to
be toggled, and applies registrations. When at least one safely configurable row
is available and client selection/configuration completes, an interactive run
reaches sign-in and recognizes valid saved authentication. With no safely
configurable rows it reports no clients and returns before authentication. Run
`sana-mcp install` later to reopen it.

---

## 3. Command reference

Commander parses named subcommands (`mcp`, `daemon`, `update`, `install`,
`uninstall`) before the default `[tool] [json]` action. Global: `--help`,
`--version` (version comes from `package.json`, the single source of truth).

### 3.1 Routing (the default action)

| Invocation | tool | flags | TTY | Routes to |
|---|---|---|---|---|
| `sana-mcp` | none | none | stdin+stdout TTY | shipped interactive app `runApp()` |
| `sana-mcp` | none | none | not a TTY | print a short hint, exit 0 |
| `sana-mcp help` / `status` / `list '{...}'` / ... | present | any | any | one-shot `sana(tool, args)` |
| `sana-mcp --limit 5` | none | present | any | one-shot `sana("help", args)` (legacy) |
| `sana-mcp update` | subcommand | none | any for compatible/current/newer; incompatible consent requires stdin+stdout TTY | `runUpdate()` |
| `sana-mcp install` / `config` / `configure` | subcommand | `--dry-run --yes --name` | any | `runInstall(opts)` |
| `sana-mcp uninstall` | subcommand | `--dry-run --yes --name` | any | `runUninstall(opts)` |
| `sana-mcp mcp` | subcommand | - | any | `runMcp()` |
| `sana-mcp daemon` | subcommand | - | any | `runDaemon()` |
| `sana-mcp --help` / `--version` | - | - | any | commander built-ins |

"Meaningful flags" that keep a bare invocation on the one-shot path:
`--email --code --id --page --limit --query --no-timestamps`.

Non-interactive detection is two-layered: `cli.ts` checks
`process.stdin.isTTY && process.stdout.isTTY` before launching the app, and the
app re-checks at entry. This keeps `sana-mcp | cat`, cron, and `$(sana-mcp)`
from hanging on a prompt.

### 3.2 `sana-mcp install` (aliases: `config`, `configure`)

Detect installed MCP clients and register/unregister the server with the ones
you choose.

Options:

| Flag | Meaning |
|---|---|
| `--dry-run` | Show what would change; write nothing. |
| `--yes` | Unattended: register with all detected clients, no prompts. |
| `--name <name>` | Server name written into client configs (default `sana-mcp`). |
| `--from-installer` | [planned] Internal: render the welcome/summary/success installer frame. |

Interactive behaviour [shipped, refined in planned]:

- Detects clients (section 4) and opens a wizard showing detected, safely
  configurable clients plus every proven-owned registration. A proven-owned
  registration remains visible and checked even when executable detection says
  absent or unavailable.
- Keys: up/down move, `space` toggle, `a` toggle-all, `v` reveal undetected
  safely configurable clients, which are selectable manual opt-ins, `enter`
  apply, `esc`/`q` cancel. A persistent footer lists the shortcuts.
- A registration for the same server name but a different command target is
  foreign and blocked rather than selected or overwritten. Foreign or unreadable
  client configuration remains nonactionable, is reported with its path and
  reason, and can make the overall configuration result incomplete.
- On apply, only the diff is written: newly-on clients are registered, newly-off
  clients are unregistered, and exact owned registrations that remain selected
  are no-ops left unchanged. A different or stale command target is foreign and
  blocked, not refreshed. [planned: this renders as a live checklist rather than
  appended lines.]
- When at least one safely configurable row is available and selection and
  configuration complete, continue to the optional human-facing sign-in step.
  With no safely configurable rows, report no clients and return before
  authentication.
- Idempotent and non-destructive: existing servers and unrelated config keys are
  preserved; a config file that cannot be parsed is left untouched and reported
  as skipped.

Unattended (`--yes`): registers with every detected client, prints a per-client
result, and skips authentication. If no clients are detected, says so and exits.
When invoked by the direct Windows installer through `SANA_MCP_YES=1`, the
installer then prints the exact command to sign in.

`config` / `configure` are aliases so "configure" reads naturally; there is no
path by which a bare invocation silently edits all configs.

### 3.3 `sana-mcp update`

Shipped standalone updater with no command options. It proves the running binary
and adjacent installer receipt before network access, resolves and verifies the
latest exact release tuple, reports current versions as no-ops, and never
downgrades an installed version newer than latest. Compatible updates need no
terminal or Sana availability and preserve registration, authentication, and
local meeting state.

Windows hands the checksum-verified installer to an external process so the
running executable can exit before replacement. Linux and macOS run a compatible
installer synchronously. A state-incompatible update is currently automatic only
on Windows and requires interactive confirmation unless
`SANA_MCP_REPLACE_INCOMPATIBLE=1` explicitly authorizes replacement; POSIX
refuses it before confirmation or mutation. Updater handoffs do not launch the
configurer.

### 3.4 `sana-mcp uninstall`

Same detection + selection UI as `install`, but removes the named server from
the chosen clients. Same flags (`--dry-run`, `--yes`, `--name`). Removal
preserves every other server/key; removing the last server may drop the now-empty
container key.

### 3.5 `sana-mcp` (interactive app) [shipped]

Bare `sana-mcp` in a terminal launches a full interactive app: a main menu that
routes to feature screens. It reads structured data directly from `SanaStore` /
`SanaClient` and renders human-facing UI - it never reuses the MCP tool's
agent-facing strings.

Main-menu state machine (recomputed each loop so it reflects login/sync live):

- Logged out or expired: a minimal menu - Sign in, Configure AI clients, Quit.
- Logged in: full menu - Search, List, Sync status, Read, Summary, Participants,
  Recording, Sign in/account, Configure AI clients, Quit.
- Logged in + a catch-up sync blocking: `status`, `login`, `configure`, `quit`
  stay live; the seven data screens are gated with a friendly "sync in progress"
  message and unlock automatically when the daemon clears the block.

Global keys on screens: `Esc`/`q` back (at the menu, prompt to quit), `Ctrl+C`
quit, `?` toggle a keys footer, `r` refresh the current screen's data.

Feature screens (all human-facing; data sources noted):

- STATUS - `getSyncState` + counts. Live-refreshing view of sync progress and
  coverage, daemon health, last sync times, semantic-index coverage (if enabled).
- LIST - `listMeetings`/`countMeetings`. Paginated, selectable meeting list with
  type-to-filter (`/`), sort toggle (`s`), status filter (`f`), paging (`n`/`p`).
  Enter opens a per-meeting ACTIONS submenu (Read / Summary / Participants /
  Recording / Back). List filter/sort/page persist across the round trip.
- SEARCH - `searchLines`/`countLineMatches` (hybrid when semantic on). Query ->
  paginated hits (date, title, line no, snippet); Enter opens READ centered on
  the hit line. `/` new search, `s` sort, `n`/`p` page.
- READ - transcript viewer. A fixed-height in-place pager (never dumps the whole
  transcript to scrollback): up/down line, PgUp/PgDn page, `g` go-to-line, `t`
  toggle timestamps, `/` find-within, `n`/`N` next/prev match, `r` reload.
- SUMMARY - `getMetadata`. Short summary, full summary, action items, notes by
  topic; scrolls in place if it overflows.
- PARTICIPANTS - `getMetadata` (participants_json), with an opt-in live refresh
  via `getMeetingParticipants`. Name / email / host table.
- RECORDING - `getMeetingById` (live). Spinner while fetching; shows the signed
  URL + expiry note; offers open-in-browser (`start`/`open`/`xdg-open`) or copy
  to clipboard; re-open to mint a fresh link.
- LOGIN - human two-step email + code (section 6).
- CONFIGURE AI CLIENTS - calls the normal `runInstall()` configurer. Its normal
  client-selection and optional login flow runs inside the app; the app refreshes
  its runtime state after the configurer returns.

Data screens gate on entry: logged out -> route to LOGIN; blocking -> show a
sync panel that auto-dismisses when the block clears; empty -> a screen-specific
empty state.

### 3.6 One-shot tool commands: `sana-mcp <tool> [json]`

Non-interactive single-capability output, designed for scripting and pipes. The
tool name plus an optional JSON args object, or flags, is parsed by `cli.ts` and
routed to `runHumanCommand(tool, args)`. That human command layer calls
structured core APIs and renders human-facing text. It is distinct from the
MCP/agent surface, which routes through the agent dispatcher and preserves its
LLM-facing output contracts.

Tools: `help`, `login`, `status`, `list`, `read`, `search`, `summary`,
`participants`, `recording`. Human CLI command names are exact.

Flags mapped into args:

| Flag | Arg | Applies to |
|---|---|---|
| `--email <email>` | `email` | login |
| `--code <code>` | `confirmation_code` | login |
| `--id <id>` | `meeting_id` / `id` | read, summary, participants, recording |
| `--page <n>` | `page` | list, search |
| `--limit <n>` | `limit` | list, search |
| `--query <q>` | `query` | list (title filter), search |
| `--no-timestamps` | `timestamps=false` | read |

JSON args (positional) allow the full argument set for each tool; see section 5
for per-tool arguments. Example: `sana-mcp list '{"sort":"oldest","limit":20}'`.

List and search treat `--page` as a one-based page number and combine it with
their validated limit to select the requested result window.

### 3.7 `sana-mcp mcp`

Run the MCP server on stdio (JSON-RPC 2.0). Registers a single tool,
`meeting_transcripts`, whose body calls `sana(tool, args)` and returns the string
as text content. The startup line goes to stderr so it never corrupts the
protocol stream. This is what a registered AI client launches
(`<binary> mcp`).

### 3.8 `sana-mcp daemon`

Run the background sync daemon in the foreground. Normally the daemon is spawned
detached and automatically by other commands (see section 7); this subcommand
runs it attached for debugging or a foreground service.

---

## 4. Supported AI clients

`install`/`uninstall` detect and configure these clients. Detection = a config
dir/file exists, an app bundle/install dir exists, a CLI is on PATH, or a
VS Code-family extension is present. Config writes are format-specific and
comment-preserving where the format allows.

| Client | Config location (per OS) | Format / key | Detect | Reload |
|---|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (mac); `%APPDATA%\Claude\...` (win) | JSON `mcpServers` | config/app bundle / `%LOCALAPPDATA%\AnthropicClaude` | quit + restart |
| Claude Code (CLI) | via `claude mcp add/remove -s user` | command | `claude` on PATH / `~/.claude.json` / `~/.claude` | restart sessions |
| Cursor | `~/.cursor/mcp.json` | JSON `mcpServers` | `~/.cursor` / app bundle / programs dir | restart |
| VS Code (Copilot) | `~/.config/Code/User/mcp.json` (linux); `%APPDATA%\Code\User\mcp.json` (win); `~/Library/Application Support/Code/User/mcp.json` (mac) | JSONC `servers`, `type:"stdio"` | `code` on PATH / config / app | reload window / restart Copilot |
| Codex CLI | `~/.codex/config.toml` | TOML `[mcp_servers.<id>]` | `codex` on PATH / `~/.codex` | restart sessions |
| Gemini CLI | `~/.gemini/settings.json` | JSON `mcpServers` | `gemini` on PATH / `~/.gemini` | restart sessions |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON `mcpServers` | dir / app / programs | auto-reloads |
| Zed | `~/.config/zed/settings.json` (linux); `%APPDATA%\Zed\settings.json` (win); appSupport (mac) | JSON `context_servers` | `zed` on PATH / config / app | auto-reloads |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | JSON `mcpServers` | `~/.cline` / VS Code ext `saoudrizwan.claude-dev-` | restart server in panel |
| Roo Code | VS Code globalStorage `rooveterinaryinc.roo-cline/mcp_settings.json` | JSON `mcpServers` | config / VS Code ext | restart server in panel |
| Amazon Q Developer CLI | `~/.aws/amazonq/mcp.json` | JSON `mcpServers` | `q`/`qchat` on PATH / `~/.aws/amazonq` | restart sessions |
| Continue | `~/.continue/config.yaml` | YAML `mcpServers` (list) | `~/.continue` / VS Code ext `continue.continue-` | reload config |
| opencode | `~/.config/opencode/opencode.jsonc` (or `.json`); win `%APPDATA%\opencode\` | JSONC `mcp`, `type:"local"`, command as array | `opencode` on PATH / config dir | restart |

Registered command written per client:

- Compiled binary: `<binary> mcp`.
- Dev (bun): `<bun> <repo>/src/mcp.ts`.
- Command-based clients (Claude Code) on Windows are invoked via the resolved
  full binary path through `cmd.exe` (avoids PATH/PATHEXT `.cmd`-shim issues).

Write safety: JSON/JSONC/TOML/YAML writers upsert only the named entry; other
servers and keys survive; unparseable files are skipped, not clobbered; writes
are atomic (temp file + rename, with a stash/restore fallback on Windows). The
opencode entry omits `enabled` so a user's explicit `enabled:false` is preserved
across re-runs.

Not auto-configured (configure via the IDE): JetBrains AI Assistant, Sourcegraph
Cody (undocumented/internal config paths).

---

## 5. Agent tools (the `meeting_transcripts` surface)

The MCP server exposes one tool, `meeting_transcripts`, called as
`meeting_transcripts("<tool>", { ...args })`. The same tools back the one-shot
CLI. Every tool returns a plain string; nothing throws to the caller.

| tool | args | returns |
|---|---|---|
| `help` | `{tool?}` | all tools, or one tool's argument schema + example |
| `login` | `{email}` then `{email, confirmation_code}` | passwordless email-code sign-in |
| `status` | (none) | sync progress and coverage |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings: started_at, id, status, title |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines (all, or a `[start,end]` range) |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching lines with meeting id + line number + snippet |
| `summary` | `{meeting_id}` | summary, notes by topic, action items |
| `participants` | `{meeting_id}` | attendees (name, email, host) |
| `recording` | `{meeting_id}` | temporary signed recording link (fetched live) |

Argument detail:

- `list.sort`: `"newest"` (default) or `"oldest"`. `list.filter`:
  `{status: "ready"|"downloading"|"processing"|"retrying", date: {from, to}}`; dates are ISO
  (`"YYYY-MM-DD"`) or epoch ms. `list.page` default 1, `list.limit` default 50.
- `read.lines`: 1-based `[start, end]` range; a line is one spoken turn. With no
  `full`/`lines` selection, `read` reports the line count and options rather than
  dumping. `read.full=true` returns everything. `read.timestamps` default true.
- `search.sort`: `"best"` (relevance, default), `"newest"`, or `"oldest"`.
  `search.page` default 1, `search.limit` default 10 (max 100). `search.filter`:
  `{date: {from, to}}`.
- `meeting_id` is also accepted as `id`; `confirmation_code` also as `code`.
- Pagination/limit args tolerate numeric strings; non-numeric values fall back to
  the default (they never crash the query).
- `recording` fetches a live Sana URL that expires after a few hours. Initial
  semantic indexing or search may also download the pinned public embedding
  model; no transcript or query data is sent with that model request.

Search defaults to hybrid keyword and semantic ranking (SQLite FTS5 + BM25 plus
vector results fused by Reciprocal Rank Fusion). Compiled binaries bundle the
semantic runtime, using sqlite-vec where Bun supports dynamic extensions and a
portable local vector backend otherwise, then download and verify the exact
pinned model revision on first use. `SANA_SEMANTIC=0` selects keyword-only search.
Runtime failures degrade explicitly to keyword results.

---

## 6. Authentication (sign-in)

Sana sign-in is passwordless: an email delivers a 6-digit code.

Two steps:

1. Request a code for an email. Backend: `auth/csrf-token` ->
   `user.sendSignInLink` (emails the code).
2. Submit the code. Backend: `auth/magic-link?email&csrfToken&code`, then
   `user.me` to establish the session and adopt the workspace.

Post-login side effects (one shared code path so the CLI, the MCP handler, and
the configurer never drift):

- Save the session (cookie jar + workspace id).
- `resetFailures()` so previously-failed downloads are retried.
- `updateSyncState({ blocking: 1, catchup_epoch_ms: now })` - a fresh catch-up
  sync is requested and data tools are held until it completes.
- `ensureDaemonRunning()`.

Presentation split [planned - cli-presentation-layer.md]: the MCP handler renders
agent-facing text (which coaches an LLM to call `meeting_transcripts("login",
...)`), and the human CLI/app/installer render human text ("We emailed a 6-digit
code to X. Enter it below." -> "Signed in as X."). The human path must never
print `meeting_transcripts(...)`, "your agent", or "ask the user to read it to
you". The shared login logic lives in `src/sana/auth.ts` / `src/core/login.ts`;
only the strings differ per audience.

Session expiry: a 401/403 from the backend raises `SessionExpiredError`; the
daemon marks state `needs_login`, and data commands report an expired session and
prompt re-login (human wording in the CLI, agent wording in the MCP tool).

---

## 7. Sync and the daemon

- The daemon is the only component that talks to Sana. It refreshes the complete
  meeting list, downloads missing transcript and metadata artifacts, optionally
  builds embeddings, and marks state `synced` only when no canonical artifacts
  are missing. It heartbeats every 5s and runs an incremental check
  every `SANA_SYNC_INTERVAL_MS` (default 10 min), waking early when a login
  requests a fresh catch-up.
- On every login a catch-up sync runs. Data tools are held (`blocking = 1`) only
  until the current account's cache identity is safe; ready meetings remain
  usable while incomplete artifacts continue syncing.
- Failed artifact downloads remain `retrying` indefinitely with exponential
  delay. `SANA_MAX_ATTEMPTS` controls when that delay stops increasing, not
  whether another attempt will happen. Login or daemon restart retries them
  immediately.
- If semantic embeddings cannot run, the daemon degrades to keyword-only for
  that run rather than blocking forever.
- Auto-spawn: read commands and login call `ensureDaemonRunning()`, which spawns
  a detached, unref'd daemon (hidden window on Windows; output to
  `daemon.log`) if none is alive. Liveness = a heartbeat within 30s AND the PID
  responding to signal 0, plus an exclusive lockfile (`daemon.lock`, atomic
  create with dead-PID recovery) to prevent double-spawn.

Meeting `status` values shown in `list`: `ready` (transcript and metadata
present), `downloading` (not yet attempted), `processing` (Sana still
processing), and `retrying` (an incomplete artifact will be tried again).

---

## 8. Configuration (environment variables)

All optional.

| Var | Default | Purpose |
|---|---|---|
| `SANA_SEMANTIC` | on | `0`/`false`/`no`/`off` disables semantic/hybrid search. |
| `SANA_SYNC_INTERVAL_MS` | `600000` | Incremental sync check interval. |
| `SANA_REQUEST_DELAY_MS` | `150` | Delay between Sana artifact requests. |
| `SANA_MAX_ATTEMPTS` | `5` | Failures before the retry delay stops increasing. |
| `SANA_MAX_NEW_TRANSCRIPTS` | `0` (unlimited) | Cap new transcript downloads per cycle. |
| `SANA_COUNT_WAIT_MS` | `30000` | How long login waits to report the meeting count. |
| `SANA_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model id. |
| `SANA_EMBED_DIM` | `384` | Embedding vector dimension. |
| `SANA_EMBED_MIN_WORDS` | `5` | Skip embedding lines shorter than this. |
| `SANA_EMBED_IDLE_MS` | `60000` | Unload the embedding model after this idle time. |
| `SANA_DATA_DIR` | `~/.sana-mcp` (compiled binary) / `./data` (from source) | Where local state is stored. |
| `SANA_BASE_URL` | `https://sana.ai` | Sana origin. |
| `SANA_PROFILE_DIR` / `SANA_TRANSCRIPTS_DIR` | under the data dir | Overrides for those subpaths. |
| `NO_COLOR` / `TERM=dumb` | - | Disable color output (glyphs remain as meaningful ASCII). |
| `SANA_MCP_KEEP_SCROLLBACK` | unset | [planned] Skip the installer's soft screen clear. |

Compiled-binary detection: the binary decides `isCompiledBinary()` via
`Bun.isStandaloneExecutable` when available, else the bunfs virtual-path signal
in `import.meta.url`, else the executable basename. This drives the default
`DATA_DIR` and how the MCP command / daemon are spawned.

---

## 9. Data and privacy

Everything is stored locally under the data directory (`~/.sana-mcp` for the
binary, `./data` from source):

- `session.json` - login cookies + workspace id. Sensitive; never commit.
- `sana.db` - SQLite: meetings, transcripts, metadata, the FTS index, vectors,
  sync state. Opened WAL, `busy_timeout=5000`, `strict:true`.
- `models/` - cached embedding model (only when semantic search is enabled).
- `daemon.log` - background daemon log.
- `daemon.lock` - daemon mutex.

No data leaves the machine except authenticated requests to Sana itself.

---

## 10. TTY, color, and non-interactive behaviour

- A bare `sana-mcp` invocation without a TTY prints a hint and exits 0 rather
  than hanging.
- `sana-mcp install` without a TTY and without `--yes` reports
  interaction-unavailable and exits 1. When a direct Windows installer launches
  it after commit and cleanup, that local setup failure does not change the
  successful runtime installation; the outer installer prints an exact retry
  command. The POSIX installer instead detects non-TTY operation before invoking
  configuration, keeps the installed runtime, and prints the later command.
- Interactive surfaces (app, configurer wizard) require a TTY on both stdin and
  stdout.
- Color is applied only on a TTY and when `NO_COLOR`/`TERM=dumb` are unset.
  Status glyphs remain meaningful ASCII (`+ - = x ~`) when color is off; Unicode
  glyphs are used only where they render safely (POSIX terminals, Windows
  Terminal), ASCII on legacy Windows conhost.
- The cursor is always restored on exit and on SIGINT.
- [planned] In-place redraw: interactive multi-step flows render as one evolving
  screen (a single `@inquirer/core` state-machine prompt) instead of appending;
  a `Frame` primitive handles non-interactive redraw and degrades to plain
  sequential writes when piped. TUI foundation: `@inquirer/core` +
  `@inquirer/ansi` (+ `ansi-escapes`), pure JS so the single binary
  cross-compiles cleanly (Ink and OpenTUI were evaluated and rejected for
  compile/native-artifact reasons; see tui-library-research.md).

---

## 11. Exit codes and errors

- Successful commands exit 0. The one-shot dispatcher always returns a string
  (never throws); user-level problems (not logged in, no such meeting, search
  error) are reported in that string with exit 0.
- The installer scripts exit non-zero on download failure or checksum mismatch,
  and abort before placing anything on PATH.
- Invalid JSON args to `sana-mcp <tool> '<json>'` print `Invalid JSON args.` and
  exit 1.
- The daemon-main entry exits 1 on a fatal daemon error.

---

## 12. Build and release

- Build: `bun build src/cli.ts --compile --target=bun-<os>-<arch>
  --external @huggingface/transformers --external sqlite-vec` per target.
- Version is single-sourced from `package.json` (read by `cli.ts` and `mcp.ts`).
- CI (`.github/workflows/release.yml`): on a push to `main` whose
  `v<package.json version>` tag does not exist (or a matching `v*` tag or manual
  dispatch), the verified target matrix builds in parallel, uploads artifacts,
  and a single `publish` job validates and publishes the complete manifest-bound
  tuple. Tags containing `-` publish as prereleases.
- Installers resolve `releases/latest`, so the one-liner always fetches the
  newest release.

---

## 13. Design docs

This spec consolidates:

- `cli-app-architecture.md` - command routing + interactive app shell.
- `cli-feature-screens.md` - per-screen interactive UX.
- `cli-presentation-layer.md` - human vs agent output split, shared core.
- `tui-rendering.md` - in-place redraw primitive + configurer state machine.
- `installer-flow-polish.md` - unified download -> configure -> sign-in -> done.
- `tui-library-research.md` - TUI dependency decision (inquirer, not Ink/OpenTUI).
- `codebase-notes.md` - architecture and quirks.
</content>
