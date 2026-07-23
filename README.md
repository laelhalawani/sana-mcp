# sana-ai-mcp

Sync and search your own [Sana.AI](https://sana.ai) meeting transcripts locally,
and expose them to AI agents through a single [MCP](https://modelcontextprotocol.io)
tool - plus a matching CLI.

Maintained by [Lumen](https://lumen.com).

---

## What it does

Sana has no public API for meetings, so this talks to the same backend the Sana
web app uses (tRPC at `sana.ai/x-api`) with your logged-in session. All traffic
is over HTTPS via direct `fetch` calls and a cookie jar - **no browser is
required**, so it runs headless on any machine (Windows, macOS, Linux, WSL).

- A background **daemon** is the only thing that talks to Sana. It downloads
  your meetings, transcripts, and metadata into a local SQLite database, then
  quietly checks for new meetings and keeps up to date.
- The **agent tools read only from that local database**, so they respond
  instantly and never block on the network (the sole exception is
  `recording`, which fetches a short-lived link on demand).
- Everything stays on your machine.

## Tools

The agent calls one tool, `meeting_transcripts`, with a `tool` name and `args`:

| tool | args | returns |
|------|------|---------|
| `help` | `{tool?}` | list all tools, or the argument schema for one |
| `login` | `{email}` then `{email, confirmation_code}` | sign in (passwordless email code) |
| `status` | (none) | sync progress and coverage |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings as a table: id, timestamp, title, status |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines (all, or a `[start,end]` range) |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching transcript lines with meeting id + line number |
| `summary` | `{meeting_id}` | summary, notes by topic, and action items |
| `participants` | `{meeting_id}` | attendees (name, email, host) |
| `recording` | `{meeting_id}` | a temporary link to the recording (fetched live) |

Discovery is built in: `help` lists everything, `help {tool}` gives a tool's
exact arguments and an example. `list` and `search` support pagination
(`page`), sorting (`sort`), and filtering (`filter` by date range and status).

## Install

```bash
git clone https://github.com/Lumen-AiApp/sana-ai-mcp.git
cd sana-ai-mcp
npm install
npm run build
```

## Use as an MCP server

Point your MCP client at the built server (use the absolute path to your clone):

```json
{
  "mcpServers": {
    "meeting-transcripts": {
      "command": "node",
      "args": ["/absolute/path/to/sana-ai-mcp/dist/mcp.js"]
    }
  }
}
```

The agent then calls `meeting_transcripts` with `{ "tool": "…", "args": {…} }`.
It signs in with `login` (an email code), and the background sync daemon starts
automatically on first use.

## Use from the CLI

```bash
node dist/cli.js login --email you@example.com
node dist/cli.js login --email you@example.com --code 123456
node dist/cli.js status
node dist/cli.js list --limit 20
node dist/cli.js read --id <meeting-id>
node dist/cli.js search --query pricing
node dist/cli.js daemon          # run the sync daemon in the foreground
```

During development you can swap `node dist/cli.js` for `npm run cli --`.

## How sync works

- **On every login** a fresh catch-up sync runs and the meeting tools are held
  until it finishes, so a returning user always gets current content. `status`
  reports progress and an ETA; if there is little new, it completes in seconds.
- **Between logins** the daemon checks periodically for new meetings and pulls
  them in the background without interrupting anything; a meeting still
  downloading shows as `downloading` in `list`.
- Downloads that fail are retried and, after several attempts, marked `failed`
  so they never block the rest.

## Search

Keyword search is always available: a line-level SQLite **FTS5** index with
**BM25** ranking, whole-word matching, and phrase/date/sort options.

**Semantic search is optional** because it loads an embedding model (RAM/CPU
cost). Enable it and `search` becomes **hybrid** - keyword + semantic results
fused by Reciprocal Rank Fusion:

```bash
npm install                       # pulls the optional deps (transformers.js, sqlite-vec)
SANA_SEMANTIC=1 node dist/cli.js daemon
# set SANA_SEMANTIC=1 for the MCP server process too
```

The model (MiniLM-L6-v2, q8) is loaded lazily on demand and unloaded after
~1 minute idle (~150 MB only while active), and its vectors are stored in the
same SQLite database via `sqlite-vec`. When enabled, embeddings are built as
part of the login catch-up (they're required for hybrid ranking).

## Configuration

Environment variables (all optional):

| var | default | purpose |
|-----|---------|---------|
| `SANA_SEMANTIC` | off | `1` to enable semantic/hybrid search |
| `SANA_SYNC_INTERVAL_MS` | `600000` | incremental check interval |
| `SANA_REQUEST_DELAY_MS` | `150` | delay between transcript downloads |
| `SANA_MAX_ATTEMPTS` | `5` | download retries before a meeting is `failed` |
| `SANA_EMBED_MODEL` / `SANA_EMBED_DIM` | MiniLM / `384` | embedding model + dimension |
| `SANA_EMBED_IDLE_MS` | `60000` | unload the model after this idle time |
| `SANA_DATA_DIR` | `./data` | where local state is stored |
| `SANA_BASE_URL` | `https://sana.ai` | Sana origin |

## Data & privacy

Everything is stored locally under `data/` (gitignored):

- `session.json` - your login cookies + workspace id. **Sensitive; never commit.**
- `sana.db` - SQLite: meetings, transcripts, metadata, the FTS index, vectors, and sync state.
- `models/` - cached embedding model (only when semantic search is enabled).
- `daemon.log` - background daemon log.

No data leaves your machine except the authenticated requests to Sana itself.

## License & maintainer

Maintained by [Lumen](https://lumen.com). See [LICENSE](LICENSE).
