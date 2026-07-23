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
| `status` | – | sync progress |
| `list_meetings` | `{limit?, offset?, query?}` | meetings newest-first with ids |
| `read_transcript` | `{id, timestamps?}` | full transcript text |

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
node dist/cli.js list_meetings --limit 20
node dist/cli.js read_transcript --id v72HzzJDZx9WqTmF
node dist/cli.js daemon          # run the syncer in the foreground
```

(During development, swap `node dist/cli.js` for `npm run cli --`.)

## Data layout (all under `data/`, gitignored)

- `session.json` — cookie jar + workspace id. **Sensitive.**
- `sana.db` — SQLite: meetings, transcripts, sync_state.
- `daemon.log` — background syncer log.
- `profile/` — Playwright profile (only used by dev helper scripts).

## Configuration (env vars)

- `SANA_SYNC_INTERVAL_MS` — incremental check interval (default 10 min).
- `SANA_REQUEST_DELAY_MS` — delay between transcript downloads (default 150 ms).
- `SANA_MAX_NEW_TRANSCRIPTS` — cap transcripts per cycle (0 = unlimited).
- `SANA_DATA_DIR` / `SANA_BASE_URL` — override data dir / Sana origin.

## Status / roadmap

Working: login, background sync (full + incremental), list, read, MCP + CLI.
Next: keyword search (SQLite FTS5) and semantic search (local embeddings).
