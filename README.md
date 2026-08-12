# sana-mcp

[![release](https://img.shields.io/github/v/release/laelhalawani/sana-mcp?include_prereleases&label=release)](https://github.com/laelhalawani/sana-mcp/releases)
[![license](https://img.shields.io/github/license/laelhalawani/sana-mcp)](#license)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#what-it-does)

Give any AI agent instant, local access to your [Sana.AI](https://sana.ai) meeting
transcripts - it runs a background daemon that syncs them into a local database,
unlocking search, read, summarize, and more through a single
[MCP](https://modelcontextprotocol.io) tool (`meeting_transcripts`) and a CLI.

One static binary, about 14 MB. Nothing to install alongside it.

macOS / Linux:

```bash
curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.ps1 | iex
```

The installer downloads the binary for your OS and CPU, finds the AI clients on
your machine, asks which to connect, signs you in to Sana, and shows your
meetings downloading. Then run `sana-mcp`.

Linux x64/ARM64, macOS x64/Apple Silicon, and Windows x64/ARM64 are published.

## What it does

Sana has no public API for meetings. `sana-mcp` drives the same web backend the
Sana app uses (tRPC at `sana.ai/x-api`) with your logged-in session, over HTTPS
with a cookie jar. **No browser is required**, so it runs headless on macOS,
Linux, Windows, and WSL.

- A background **daemon** downloads your meetings, transcripts, and metadata into
  a local SQLite database, then checks periodically for new ones.
- The **agent tools read only from that database**, so they respond instantly and
  never block on the network. The sole exception is `recording`, which fetches a
  short-lived link on demand.
- Everything - session, database, logs - stays on your machine.

## Features

- **One tool for agents** - `meeting_transcripts` - with built-in discovery:
  `help` lists everything, `help {tool}` shows exact arguments.
- **List, read, search** transcripts, plus **summaries**, **participants**, and
  on-demand **recording** links.
- **Search** - line-level SQLite FTS5 with BM25 ranking, phrase and date-range
  filters, and sort options.
- **Automatic sync** - a background daemon starts itself whenever you use
  sana-mcp, polls for new meetings, retries incomplete downloads, and never
  re-downloads a transcript it already has.
- **Correct transcription errors** - and keep the original. See below.
- **Works with your client** - registers with Claude Desktop, Claude Code,
  Cursor, VS Code, Codex, Gemini CLI, Windsurf, Zed, Cline, Roo Code, Amazon Q,
  Continue, opencode.
- **Local-first and private** - no data leaves your machine except authenticated
  requests to Sana.

## Agent tools

Agents call one tool, `meeting_transcripts`, with a `tool` name and an optional
`args` object:

```text
meeting_transcripts("<tool>", { ...args })
```

| tool | args | returns |
|---|---|---|
| `help` | `{tool?}` | all tools, or one tool's schema |
| `login` | `{email}`, then `{email, confirmation_code}` | passwordless sign-in by email code |
| `status` | (none) | sync progress and coverage |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings: id, timestamp, title, status |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines, all or a `[start,end]` range |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching lines with meeting id and line number |
| `summary` | `{meeting_id}` | summary, notes by topic, action items |
| `participants` | `{meeting_id}` | workspace members with access, and speakers heard in the transcript |
| `recording` | `{meeting_id}` | a temporary recording link, fetched live |
| `edit_line` | `{meeting_id, line, expected_text, new_text}` | corrects one line |
| `line_history` | `{meeting_id, line?}` | what was changed, original and current |
| `restore_line` | `{meeting_id, line}` | puts a line back to what Sana delivered |

```text
meeting_transcripts("search", {"query": "pricing", "sort": "newest"})
meeting_transcripts("read",   {"meeting_id": "v72HzzJDZx9WqTmF", "lines": [22, 26]})
```

Full schemas and semantics: [`docs/tool-contract.md`](docs/tool-contract.md).

## Use it from the CLI

```sh
sana-mcp                       # the full-screen application
sana-mcp status                # sync progress
sana-mcp list                  # meetings, newest first
sana-mcp search pricing        # search every transcript
sana-mcp read <meeting-id> 20 40
sana-mcp configure             # change which clients are connected
sana-mcp daemon --stop
```

A bare `sana-mcp` opens the application on a terminal, and serves MCP without
one - so a client that runs the binary with no arguments still gets a server.

## Fixing transcription errors

Transcripts come from speech recognition, and it gets names wrong. A discussion
about **Fabrix** can be transcribed as **Fabrik**, and then no search for
"Fabrix" will ever find it.

You can correct any line - in the application (`e` to edit, `ctrl+s` to save,
`h` for history) or through the tools. Corrections are safe by construction:

- **Nothing is destroyed.** What Sana delivered is kept forever, shown beside
  every change, and restoring is one key.
- **A correction survives a re-sync.** Edits re-attach by content, so they follow
  their line even when re-transcription shifts the numbering. One that no longer
  matches anything is kept and marked, never applied to the wrong line.
- **Both spellings stay searchable.** The corrected name finds the line; what was
  actually said still finds it too, ranked well below.

A warning that also sits in the tool description and on the edit screen: meeting
transcripts are full of product, company and personal names that look like
misspellings and are not - `Zenolith`, `Fabrix`, `Vantik` are real. An agent must
never edit a transcript unless you asked for that specific correction.

## Where things live

Everything is under `~/.sana-mcp`: the SQLite database, your session, the daemon
log, and the binary itself in `bin/`.

`sana-mcp uninstall` removes all of it. It lists what it is about to remove and
asks first: the client registrations, that directory, every copy of the binary
the installers have written (including `~/.local/bin`, where an older version
put it), and the PATH line they added to your shell profile. It stops any
running daemon first, by asking each installed binary to stop its own - a daemon
started by a different version only answers to that version.

Note that the database holds your corrections, which cannot be re-synced from
Sana. It is not purely a cache.

## Installing over an older version

An older version's database cannot be read by this one. The installer checks for
that before it writes anything, says what continuing costs - your meetings are
downloaded again, and you may have to sign in again - and asks. Nothing is
deleted until the new setup succeeds, so cancelling or a failure part-way
through puts the old state back exactly as it was.

## Development

```sh
go vet ./... && go test ./... && go test -race ./...
```

Live tests exercise the real API with your stored session; they are read-only,
write to temporary databases, and are skipped unless `SANA_LIVE=1`.

Releasing is bumping `VERSION` and merging to `main`.

See [`AGENTS.md`](AGENTS.md) for the constraints that are load-bearing,
[`docs/tool-contract.md`](docs/tool-contract.md) for the agent surface, and
[`docs/app-design.md`](docs/app-design.md) for the application.

## License

GPL-3.0
