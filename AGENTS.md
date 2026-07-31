# Agent Guidelines

## Project shape

`sana-mcp` syncs Sana.AI meeting transcripts to this machine and serves them to
an agent over MCP, to a person through a full-screen application, and to scripts
through a CLI. It follows the layout and conventions of
`interactive-terminal-mcp` and `apis-mcp`.

Read `docs/tool-contract.md` before changing anything an agent sees, and
`docs/app-design.md` before changing a screen. Both are contracts.

## Hard constraints

- **`CGO_ENABLED=0`.** Every dependency must be pure Go, because release builds
  cross-compile six targets from one host. This is why the SQLite driver is
  `modernc.org/sqlite` and not `mattn/go-sqlite3`.
- **stdout belongs to the MCP protocol.** In server mode, diagnostics go to
  stderr. A stray byte on stdout corrupts the session.
- **The database is the shared state.** There is no IPC layer: the daemon is
  only the single writer under a `flock`, and every reader opens SQLite
  directly. Do not add a socket.

- **`render` has no terminal dependency.** It lays out domain values as text for
  every surface, two of which are a stdio server and a one-shot CLI. Keystroke
  handling and lipgloss live in `internal/tui`, which only the two terminal
  surfaces import. This split was made after `render` was found dragging
  bubbletea into the MCP server's dependency graph.

## Things that are load-bearing

- **`line_edits` is user-owned data, not cache.** Deleting the database loses
  corrections that cannot be re-synced. Any migration, reset, or recovery path
  must preserve it.
- **A stored transcript is never re-downloaded.** `NeedsTranscript` decides
  this. Re-listing meetings must not write `transcript_state` or `word_count` -
  the list carries neither, and writing them resets what a fetch established.
  There is a regression test; it exists because this bug shipped once.
- **Edits re-attach by content hash, not line number.** Re-transcription shifts
  line boundaries. An edit whose line cannot be found becomes `stale` and stays
  in history: never dropped, never applied to a different line.
- **Sync starts itself.** Every surface calls `daemon.EnsureRunning`. Before it
  existed, the `--detach` flag and the already-running branch were machinery for
  a caller nobody had written, and background sync simply never happened.
- **The tool description's warning about editing is part of the contract.** It
  is the only thing between a confident model and a corrupted transcript, and a
  test pins it. Transcripts are full of real names that look like misspellings -
  `Zenolith`, `Fabrix`, `Vantik` are real.

## Testing

- `go vet ./... && go test ./... && go test -race ./...` before every commit.
- Verify all six targets build: `CGO_ENABLED=0 GOOS=... GOARCH=... go build`.
- **Live tests need `SANA_LIVE=1`** and the machine's stored session. They are
  read-only and write to temporary databases. CI skips them, so live
  verification is something you do locally.
- **Drive the real thing.** Every bug worth its commit message in this repo was
  found by running the binary, not by reading it: a nil context that hung
  forever, a schema that rejected every call, a config write that emptied every
  meeting, a disconnect reported as a crash. Unit tests with mocks would have
  passed all four.
