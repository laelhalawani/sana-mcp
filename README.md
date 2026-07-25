# sana-mcp

[![release](https://img.shields.io/github/v/release/Etals-AiApp/sana-ai-mcp?include_prereleases&label=release)](https://github.com/Etals-AiApp/sana-ai-mcp/releases)
[![license](https://img.shields.io/github/license/Etals-AiApp/sana-ai-mcp)](#license)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#what-it-does)

Give any AI agent instant, local access to your [Sana.AI](https://sana.ai) meeting
transcripts - it runs a background daemon that syncs them into a local database,
unlocking search, read, summarize, and more through a single
[MCP](https://modelcontextprotocol.io) tool (`meeting_transcripts`) and a CLI.

macOS / Linux:

```bash
sh -c 't=$(mktemp) && curl -fsSL "$1" -o "$t" && sh "$t"; s=$?; [ -z "${t:-}" ] || rm -f "$t"; exit "$s"' sh https://github.com/Etals-AiApp/sana-ai-mcp/releases/latest/download/install.sh
```

Windows (PowerShell):

```powershell
irm https://github.com/Etals-AiApp/sana-ai-mcp/releases/latest/download/install.ps1 | iex
```

The installer selects the release for your OS, CPU, and (on Linux) libc, verifies
the release manifest, checksums, and embedded binary identity, puts `sana-mcp` on
your `PATH`, then opens an interactive
configurer: it detects your AI clients, lets you toggle which ones to connect
(space to toggle, `v` to reveal undetected clients, enter to confirm), and offers
to sign you in. Run `sana-mcp` anytime to reopen it and change what's connected or
sign in later.

When the installer has no interactive terminal, it installs the verified binary
and prints the exact `sana-mcp install` command to run later; it does not guess
which clients to change. For an intentional unattended install, set
`SANA_MCP_YES=1` to configure every detected client without showing the picker.
If a terminal is present but interactive controls are disabled by redirection,
CI, or terminal policy, the installer makes the same explicit deferral and keeps
the verified runtime installed.

Run `sana-mcp update` to check for and install the latest release. A compatible
receipt-backed update verifies the installed runtime and release metadata, then
replaces the runtime without requiring Sana to be reachable; your login and local
meeting state remain in place. The command reports a no-op when you already have
the latest version and never downgrades a newer installation.

Set `SANA_MCP_VERSION` to an exact tag such as `v0.4.2` to pin an install. Linux
x64/ARM64 (glibc and musl), macOS x64/Apple Silicon, and Windows x64 are
published. On Alpine, install Bun's required C++ runtime first with
`apk add --no-cache libstdc++ libgcc`; the installer detects and reports this
before downloading release metadata or binary assets. Windows ARM64 is not yet
in the verified release matrix.

On Windows, an older official installation that cannot be updated in place is
handled as an incompatible replacement. Before changing anything, the installer explains that
local meetings must be resynced and you must sign in again, then asks whether to
continue. Declining leaves the installation unchanged. Confirming replaces the
verified old runtime and resets its default local state; it does not migrate or
revalidate the old authentication. An unrecognized receiptless executable is
never run or overwritten, and an overridden data or transcript directory is
never reset automatically.

Linux and macOS support compatible receipt-backed updates. An epoch-changing
update is refused before confirmation until their destructive replacement
coordinator is implemented.

For an intentional unattended incompatible replacement, set
`SANA_MCP_REPLACE_INCOMPATIBLE=1`. `SANA_MCP_YES=1` configures detected clients;
it does not authorize deleting incompatible local state.

## What it does

Sana has no public API for meetings. `sana-mcp` drives the same web backend the
Sana app uses (tRPC at `sana.ai/x-api`) with your logged-in session, over HTTPS
via direct `fetch` and a cookie jar. **No browser is required**, so it runs
headless on macOS, Linux, Windows, and WSL.

- A background **daemon** downloads your meetings, transcripts, and metadata into
  a local SQLite database, then checks periodically for new meetings.
- The **agent tools read only from that database**, so they respond instantly and
  never block on the network. The sole exception is `recording`, which fetches a
  short-lived link on demand.
- Everything - session, database, models, logs - stays on your machine.

## Features

- **One tool for agents** - `meeting_transcripts` - with built-in discovery:
  `help` lists everything, `help {tool}` shows exact arguments and an example.
- **List, read, search** transcripts, plus **summaries**, **participants**, and
  on-demand **recording** links.
- **Keyword search always available** - line-level SQLite FTS5 with BM25 ranking,
  whole-word matching, phrase, date-range, and sort options.
- **Optional semantic / hybrid search** - keyword + vector results fused by
  Reciprocal Rank Fusion (RRF). Off by default; no cost until you enable it.
- **Automatic sync** - the daemon polls for new meetings and pulls them in the
  background; failed downloads are retried then marked, never blocking the rest.
- **Works with your client** - auto-registers with Claude Desktop, Claude Code,
  Cursor, VS Code, Codex, Gemini CLI, Windsurf, Zed, Cline, Roo Code, Amazon Q,
  Continue, opencode.
- **Local-first & private** - no data leaves your machine except authenticated
  requests to Sana.

## Agent tools

Agents call one tool, `meeting_transcripts`, with a `tool` name and an optional
`args` object:

```text
meeting_transcripts("<tool>", { ...args })
```

| tool          | args                                                       | returns                                                                 |
|---------------|------------------------------------------------------------|-------------------------------------------------------------------------|
| `help`        | `{tool?}`                                                  | all tools, or the argument schema for one                               |
| `login`       | `{email}`, then `{email, confirmation_code}`               | passwordless sign-in via email code                                     |
| `status`      | (none)                                                     | sync progress and coverage                                              |
| `list`        | `{page?, limit?, query?, sort?, filter?}`                  | meetings: id, timestamp, title, status                                  |
| `read`        | `{meeting_id, full?, lines?, timestamps?}`                 | transcript lines (all, or a `[start,end]` range)                        |
| `search`      | `{query, page?, limit?, sort?, filter?}`                   | matching lines with meeting id + line number                            |
| `summary`     | `{meeting_id}`                                             | summary, notes by topic, and action items                               |
| `participants`| `{meeting_id}`                                             | attendees (name, email, host)                                           |
| `recording`   | `{meeting_id}`                                             | a temporary recording link, fetched live                                |

Notes:

- `list.sort` is `"newest"` (default) or `"oldest"`; `list.filter` is
  `{status: "ready"|"downloading"|"failed", date: {from, to}}` with ISO dates
  (`"YYYY-MM-DD"`) or epoch ms.
- `read.lines` is a 1-based `[start, end]` range. With no selection it reports
  the line count and your options; `full: true` returns everything.
- `search.sort` is `"best"` (relevance, default), `"newest"`, or `"oldest"`.
- `recording` is the only tool that hits the network; the returned URL expires
  after a few hours.

Example:

```text
meeting_transcripts("search", {"query": "pricing", "sort": "newest"})
meeting_transcripts("read",   {"meeting_id": "v72HzzJDZx9WqTmF", "lines": [22, 26]})
```

## Use from the CLI

The same tools work on the command line. Run `sana-mcp help` to see everything.

```bash
sana-mcp login --email you@example.com
sana-mcp login --email you@example.com --code 123456
sana-mcp status
sana-mcp list --limit 20
sana-mcp read --id <meeting-id>
sana-mcp search --query pricing
```

Subcommands:

| command                       | purpose                                                  |
|-------------------------------|----------------------------------------------------------|
| `sana-mcp <tool> [json]`      | run a tool, e.g. `sana-mcp list '{"limit":10}'`          |
| `sana-mcp daemon`             | run the background sync daemon in the foreground         |
| `sana-mcp install`            | detect MCP clients and register sana-mcp with your picks |
| `sana-mcp uninstall`          | remove sana-mcp from the clients you choose              |
| `sana-mcp update`             | verify this install and update to the latest release     |
| `sana-mcp mcp`                | run the MCP server on stdio (used by clients internally) |

## Register with an AI client

The one-line installer runs this for you. To change your selection later, or if
you installed the binary manually, run:

```bash
sana-mcp install      # detect installed clients, register sana-mcp with your picks
```

`sana-mcp install` detects the MCP-capable clients on your machine and registers
`sana-mcp` with the ones you choose. Each client's config is written safely -
your existing servers are preserved - and the operation is idempotent.

- **Detects:** Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Codex,
  Gemini CLI, Windsurf, Zed, Cline, Roo Code, Amazon Q, Continue, and opencode.
  Detected clients are pre-selected; you can add any other supported client too.
- **Flags:** `--dry-run` (show what would change), `--yes` (register with all
  detected clients, no prompt), `--name <name>` (server name; default `sana-mcp`).
- After registering, most clients need a restart or a session reload to pick up
  the new server. Remove it later with `sana-mcp uninstall` (same flags).

No supported client detected, or prefer to wire it up yourself? Point your client
at the installed binary with the `mcp` subcommand (use the absolute path, or grab
the binary from the [Releases page](https://github.com/Etals-AiApp/sana-ai-mcp/releases)):

```json
{
  "mcpServers": {
    "sana-mcp": {
      "command": "/absolute/path/to/sana-mcp",
      "args": ["mcp"]
    }
  }
}
```

The server name is `sana-mcp`; the tool it exposes is `meeting_transcripts`. The
daemon starts automatically on first use after login.

## Sign in

Sign in now:

```bash
sana-mcp login --email you@example.com                 # emails you a 6-digit code
sana-mcp login --email you@example.com --code 123456   # verify it
```

Or skip it - the agent will ask for your email and the confirmation code the
first time it tries to use the tools. After the first login, a catch-up sync runs
and the daemon keeps your meetings current; run `sana-mcp status` to watch
progress, then ask your agent to search, read, or summarize your meetings.

## How sync works

- **On every login**, a fresh catch-up sync runs and the meeting tools are held
  until it finishes, so a returning user always sees current content. `status`
  reports authoritative completed and total counts until the remaining work is
  finished.
- **Between logins**, the daemon checks periodically for new meetings and pulls
  them in the background without interrupting anything. A meeting still
  downloading shows as `downloading` in `list`.
- Downloads that fail are retried and, after several attempts, marked `failed`
  so they never block the rest. A fresh login resets the counter and retries.

## Search

**Keyword search is always available** - a line-level SQLite FTS5 index with BM25
ranking, whole-word matching, and phrase / date-range / sort options.

**Semantic / hybrid search is optional**, because it loads an embedding model
(RAM/CPU cost). Enable it with `SANA_SEMANTIC=1` and `search` becomes hybrid -
keyword + semantic results fused by Reciprocal Rank Fusion:

```bash
# From a source checkout (installs the optional deps transformers.js + sqlite-vec)
bun install
SANA_SEMANTIC=1 bun src/cli.ts daemon
# set SANA_SEMANTIC=1 for the MCP server process too
```

The model (`Xenova/all-MiniLM-L6-v2`, q8) is loaded lazily on demand and unloaded
after roughly a minute of idle (about 150 MB only while active); vectors are
stored in the same SQLite database via `sqlite-vec`. When enabled, embeddings are
built as part of the login catch-up because they are required for hybrid ranking.

> The embedding model and `sqlite-vec` are optional dependencies. They are
> installed by `bun install` (source), but are **not bundled in the prebuilt
> binary**. If the model cannot be loaded, `search` returns keyword (BM25)
> results with an explicit semantic-degradation notice; it never presents those
> results as hybrid search.

## Configuration

All environment variables are optional.

| var | default | purpose |
|-----|---------|---------|
| `SANA_SEMANTIC`            | off             | `1` to enable semantic / hybrid search                       |
| `SANA_SYNC_INTERVAL_MS`    | `600000`        | how often the daemon checks for new meetings                  |
| `SANA_REQUEST_DELAY_MS`    | `150`           | delay between transcript downloads                            |
| `SANA_MAX_ATTEMPTS`        | `5`             | download retries before a meeting is marked `failed`          |
| `SANA_EMBED_MODEL`         | `Xenova/all-MiniLM-L6-v2` | embedding model id                                 |
| `SANA_EMBED_DIM`           | `384`           | embedding vector dimension                                    |
| `SANA_EMBED_IDLE_MS`       | `60000`         | unload the embedding model after this idle time               |
| `SANA_DATA_DIR`            | `~/.sana-mcp`*  | where local state is stored (* `./data` when run from source) |
| `SANA_BASE_URL`            | `https://sana.ai` | Sana origin                                                 |

## Data & privacy

Everything is stored locally under the data directory (`~/.sana-mcp` for the
binary, `./data` when running from source), and nothing there is committed:

- `session.json` - your login cookies and workspace id. **Sensitive; never commit.**
- `sana.db` - SQLite: meetings, transcripts, metadata, the FTS index, vectors,
  and sync state.
- `models/` - cached embedding model (only when semantic search is enabled).
- `daemon.log` - background daemon log.

No data leaves your machine except the authenticated requests to Sana itself.

## Build from source

Requires [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/Etals-AiApp/sana-ai-mcp.git
cd sana-ai-mcp
bun install
bun run check         # typecheck + isolated-safe test suite
bun run compile -- --target bun-linux-x64  # -> dist/sana-mcp
```

Run from source explicitly with `bun src/cli.ts ...` (for example,
`bun src/cli.ts install`); source checkout commands do not rely on a globally
installed `sana-mcp`. The
compile target is always explicit; valid published targets are
`bun-linux-x64`, `bun-linux-x64-musl`, `bun-linux-arm64`,
`bun-linux-arm64-musl`, `bun-darwin-x64`, `bun-darwin-arm64`, and
`bun-windows-x64`. A package-version bump merged to `main` publishes the matching
release automatically when its tag does not exist. A pushed matching `v*` tag or
manual dispatch can also build or resume that exact release.

## License

GPL-3.0. See [LICENSE](LICENSE). Maintained by [Etals](https://etals.com) -
[github.com/Etals-AiApp/sana-ai-mcp](https://github.com/Etals-AiApp/sana-ai-mcp).
