# meeting-transcripts (sana-mcp)

Sync and read your own [Sana.AI](https://sana.ai) meeting transcripts locally,
exposed as a single agent tool `meeting_transcripts(tool, args)` (MCP) and a CLI.

No official API is used — Sana's public API has no meeting/transcript endpoints.
Instead this talks to the same backend the web app uses (tRPC at
`sana.ai/x-api/trpc`) with your logged-in session. All traffic is over HTTPS
(TLS) using direct `fetch` requests plus a cookie jar — **no browser is
required**, so it runs headless anywhere.
Cross-platform: Windows, macOS, Linux/WSL (Node only).

## How it works

- **Login** is a passwordless email code, done entirely over HTTPS:
  `csrf-token` → `user.sendSignInLink` (emails a 6-digit code) →
  `auth/magic-link?email&csrfToken&code` (sets the session cookie).
- A **background sync daemon** is the only thing that talks to Sana. On first
  run it lists all meetings then downloads every transcript into a local SQLite
  DB. After that it periodically checks for new meetings and downloads them,
  without blocking anything.
- The **tools read only from the local store**, so they never block on the
  network. If you query mid-sync, they tell you the progress and to check back.

## The tool: `meeting_transcripts(tool, args)`

| tool | args | what it does |
|------|------|--------------|
| `help` | `{tool?}` | list tools, or details for one |
| `login` | `{email}` then `{email, confirmation_code}` | sign in (two steps) |
| `status` | (none) | sync progress |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings as a table (id, timestamp, title, status) |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines (whole or a `[start,end]` range) |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching lines (BM25; hybrid when semantic is on) |
| `summary` | `{meeting_id}` | summary, notes, action items |
| `participants` | `{meeting_id}` | attendee list (name, email, host) |
| `recording` | `{meeting_id}` | temporary recording URL (fetched live) |

`read`/`summary`/`participants` are fully local; `recording` fetches a fresh
signed URL live. `list`/`search` support `sort` and `filter` (date range,
status) — see `help {tool}` for exact argument schemas.

If the session expires, any tool (except `help`) replies:
`Your login has expired. To login again run meeting_transcripts("login", {email})`.

## Setup

```bash
npm install
npx playwright install chromium   # only needed for the dev session-import helper
npm run build
```

## Run as an MCP server

Point your MCP client at the built server:

```json
{
  "mcpServers": {
    "meeting-transcripts": {
      "command": "node",
      "args": ["/home/lael/sana-mcp/dist/mcp.js"]
    }
  }
}
```

The agent then calls `meeting_transcripts` with `{ "tool": "...", "args": {...} }`.
The background sync daemon is auto-started (detached) the first time a tool runs.

## CLI

```bash
node dist/cli.js login --email you@example.com
node dist/cli.js login --email you@example.com --code 123456
node dist/cli.js status
node dist/cli.js list --limit 20
node dist/cli.js read --id v72HzzJDZx9WqTmF
node dist/cli.js search --query pricing
node dist/cli.js daemon          # run the syncer in the foreground
```

(During development, swap `node dist/cli.js` for `npm run cli --`.)

## Data layout (all under `data/`, gitignored)

- `session.json` — cookie jar + workspace id. **Sensitive.**
- `sana.db` — SQLite: meetings, transcripts, metadata, FTS index, vectors, sync_state.
- `models/` — cached embedding model (only when semantic search is enabled).
- `daemon.log` — background syncer log.
- `profile/` — Playwright profile (only used by dev helper scripts).

## Semantic search (optional)

Keyword search (SQLite FTS5, BM25-ranked) works out of the box with no extra
dependencies. **Semantic** search is opt-in because it loads an embedding model
(RAM/CPU cost):

```bash
npm install                 # installs the optional deps (@huggingface/transformers, sqlite-vec)
SANA_SEMANTIC=1 npm run daemon   # (and set SANA_SEMANTIC=1 for the MCP server too)
```

When enabled, the daemon embeds transcript lines (MiniLM-L6-v2, q8, ~150 MB RAM
while active) into a `sqlite-vec` table, and `search` becomes **hybrid** —
keyword + semantic fused by Reciprocal Rank Fusion. The model is loaded lazily
on demand and unloaded after ~1 min idle, so it costs nothing when unused.
Embeddings are part of the login catch-up sync when enabled (required for
hybrid scoring). If the optional deps are missing while `SANA_SEMANTIC=1`, tools
say so rather than silently degrading.

## Configuration (env vars)

- `SANA_SYNC_INTERVAL_MS` — incremental check interval (default 10 min).
- `SANA_REQUEST_DELAY_MS` — delay between transcript downloads (default 150 ms).
- `SANA_MAX_NEW_TRANSCRIPTS` — cap transcripts per cycle (0 = unlimited).
- `SANA_MAX_ATTEMPTS` — download retries before a meeting is marked `failed` (default 5).
- `SANA_DATA_DIR` / `SANA_BASE_URL` — override data dir / Sana origin.
- `SANA_SEMANTIC` — `1` to enable semantic/hybrid search.
- `SANA_EMBED_MODEL` / `SANA_EMBED_DIM` — embedding model + dim (default MiniLM / 384).
- `SANA_EMBED_IDLE_MS` — unload the model after this idle time (default 60 s).

## Status / roadmap

Working: login, background sync (full + incremental), list, read, search
(BM25 + optional hybrid semantic), summary, participants, recording, MCP + CLI.
Next: packaging/distribution (npx + MCPB bundle).
