# Implementation Plan

Companion to [`tool-contract.md`](tool-contract.md), which defines the
agent-facing surface, and [`app-design.md`](app-design.md), which covers the
interactive application. This document records the architecture and the
reasoning behind it.

**Status: scaffolded.** The entrypoint model, module layout, installer scripts
and release workflows are in place and cross-compile for all six targets with
`CGO_ENABLED=0`. Everything below the architecture section is designed, not yet
built.

## 1. Dependency decisions

| Concern | Choice | Why |
|---|---|---|
| SQLite | `modernc.org/sqlite` v1.55.0 | Pure Go, no cgo. FTS5, trigram, soundex, JSON1, fts5vocab all verified present. Keeps single-host cross-compilation. |
| Vectors (optional) | `modernc.org/sqlite/vec` (sqlite-vec v0.1.9) | Verified running on the pure-Go driver: `vec0` with `float[512]`/`int8[512]`/cosine, KNN over 20k vectors in 26 ms. |
| MCP | `github.com/modelcontextprotocol/go-sdk` v1.6.1 | Same version as `apis-mcp` and `interactive-terminal-mcp`. |
| Installer | `github.com/sairaph/detect-harness` v0.1.0 | Detects the harnesses, plans, applies. Replaces ~8,500 lines of hand-rolled TypeScript install logic. |
| TUI | `bubbletea` v1.3.10 + `lipgloss` v1.1.0 + `bubbles` | Same as both reference projects. |
| Config | `github.com/pelletier/go-toml/v2` | Same as both reference projects. |
| File locking | `github.com/gofrs/flock` | Daemon singleton lock, same as `apis-mcp`. |
| Embeddings (optional) | model2vec `potion-retrieval-32M`, hand-written Go encoder | 31 MB int8, ~250 lines, no runtime. Measured byte-identical to the Python reference. Off by default. |

`CGO_ENABLED=0 go build` verified for `linux/amd64`, `linux/arm64`,
`darwin/amd64`, `darwin/arm64`, `windows/amd64`, `windows/arm64`.

## 2. Entrypoint model

Identical to `interactive-terminal-mcp`, so this project joins that family
rather than inventing a fourth convention.

| Invocation | Behaviour |
|---|---|
| `sana-mcp` on a TTY | Full-screen interactive application |
| `sana-mcp` without a TTY | stdio MCP server |
| `sana-mcp mcp` | stdio MCP server, always |
| `sana-mcp configure` | Installer / settings flow |
| `sana-mcp daemon [--stop]` | Background sync daemon |
| `sana-mcp <cli command>` | One-shot CLI |

`help` and `version` run before any state is loaded, so they work when the home
directory is unwritable.

## 3. No IPC layer

`interactive-terminal-mcp` needs a socket because its daemon owns PTYs, which
are kernel objects that cannot be shared. **This project has no such thing.**
The SQLite database *is* the shared state, so every reader - MCP server, CLI,
interactive application - opens it directly. The daemon exists only to be the
single writer during sync, which a `flock` plus SQLite WAL provides.

This deletes, rather than ports, the TypeScript lease/heartbeat machinery:
`control.ts` (1,200 lines), `lifecycle.ts` (549), `lock.ts` (127), `spawn.ts`
(117).

## 4. Storage

```sql
CREATE TABLE meetings (
  meeting_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  status       TEXT NOT NULL,   -- ready | downloading | processing | retrying
  word_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE transcript_lines (
  meeting_id    TEXT NOT NULL,
  line_no       INTEGER NOT NULL,      -- 1-based, matches the tool contract
  speaker       TEXT NOT NULL,
  start_ms      INTEGER NOT NULL,
  text          TEXT NOT NULL,         -- current: the edit if one applies, else the original
  original_text TEXT NOT NULL,         -- exactly as Sana delivered it, never modified
  PRIMARY KEY (meeting_id, line_no)
);

CREATE TABLE line_edits (               -- append-only history
  edit_id         INTEGER PRIMARY KEY,
  meeting_id      TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  original_sha256 TEXT NOT NULL,        -- of original_text when the edit was made
  original_text   TEXT NOT NULL,        -- carried so history survives a re-sync
  edited_text     TEXT NOT NULL,
  edited_ms       INTEGER NOT NULL,
  author          TEXT NOT NULL,        -- user | agent
  state           TEXT NOT NULL         -- applied | superseded | reverted | stale
);

CREATE VIRTUAL TABLE line_search USING fts5(
  meeting_id UNINDEXED, line_no UNINDEXED,
  text,                                  -- current text
  original_text,                         -- what was actually said
  tokenize = 'unicode61'
);
```

**Both texts are indexed, but not equally.** Searching "Fabrix" must find a
corrected line; searching "Fabrik" should still reach what was actually said.
Keeping both spellings on one row is what an alias table could not do - an alias
equates the terms *globally*, which is wrong, because `Fabrik` denotes a person in
~90 of its 101 occurrences in a real corpus.

The current text is **strongly** preferred. Almost nobody searches for how a word
was mispronounced, so the original must never obscure correct results:

```sql
bm25(line_search, 0.0, 0.0, 10.0, 0.5)
--                 ^id  ^line ^text ^original_text
```

A 20:1 weighting. An original-only match still ranks, but below every current-text
match, so it acts as a last resort rather than competing with real hits.

## 5. Correction model

Aliasing was considered and rejected on correctness; see `../plan.md`. Editing
the local copy is the primitive, with four rules.

**Non-destructive.** `original_text` is never written after first insert. The
current text and the full edit history both live beside it, so every edit is
visible and reversible.

**Compare-and-swap, addressed by line number.** Every tool and every screen
addresses a line the way the rest of the contract already does: by
`meeting_id` + 1-based `line_no`. The edit call also supplies the *entire*
existing line text, and applies only if it matches - so an agent cannot edit a
line it misread. The content hash is an **internal** durability detail used only
to re-locate edits after a re-download (§6); it never appears in a tool
signature or on screen.

**Explicit permission, backed by reversibility.** The tool description states
that transcripts are full of real names that only look misspelled, and that no
edit may be made without the user asking for it. That instruction is advisory -
a model may ignore it - so the actual guarantee is that every edit is recorded,
visible in history, and restorable. This failure mode is demonstrated, not
hypothetical: during the search investigation both an agent and the assistant
"corrected" **Zenolith** to "crawler". It is a real product name.

**Meeting-scoped bulk apply.** A garbled name usually recurs; the real corpus
had 11 lines to fix. The TUI and the tool both offer "apply to every occurrence
in this meeting" with a preview of the affected lines. Meeting-scoped, never
global - global is exactly the alias mistake.

## 6. Sync: states, progress, and how it is shown

The TypeScript behaviour is the specification here; it is good and must be kept.

**Phase state machine**, persisted in `sync_state`:

| Phase | Meaning | Shown to a person as |
|---|---|---|
| `idle` | never synced | "Waiting to start" |
| `listing` | fetching the meeting list | "Discovering meetings" |
| `downloading` | fetching transcripts | "Syncing meetings" |
| `synced` | caught up | "Up to date" |
| `needs_login` | session absent or expired | "Sign in required" / "Sana session expired" |
| `error` | sync needs attention | "Sync needs attention" |

**Progress metrics**, all read in one transaction so a snapshot is internally
consistent: `transcripts_done` / `transcripts_total`, `remaining`, `eta_minutes`,
`meetings` (fully downloaded, transcript *and* metadata), `meetings_total`
(discovered from Sana, including still-pending rows), and `retrying`.

**Sync starts during install, and the installer waits on it visibly.** After
clients are configured and sign-in succeeds, an interactive install shows a live
status view that polls the snapshot and renders a bar:

```
Syncing meetings
[##########--------------]  103/240 transcripts   ~4 min left
```

It exits when the phase reaches `synced` with `remaining == 0`, or when the user
presses enter to leave it running. Then:

```
Meeting sync complete.                     (green, when synced)
Meeting sync continues in the background.  (otherwise)
Reload  restart Claude Code sessions
Run: sana-mcp
```

A non-interactive install (piped, `--yes`, CI) never renders the live view and
prints the static summary instead - the same four lines the current installer
produces:

```
sana-mcp setup
AI clients  2 connected
Sana account  signed in
Meeting sync  complete | continuing in background
Reload  restart Claude Code sessions
Next: sana-mcp
```

**Resync** is the daemon polling every `sync_interval_minutes` (default 15): list
meetings, insert new rows, fetch transcripts for anything not yet complete, retry
what previously failed. Incomplete meetings never block ready ones - a meeting
still processing upstream is listed with its status and picked up on a later
cycle.

**The same snapshot backs every surface**: the installer's live view, the TUI
"Sync status" screen, `sana-mcp status`, and the `status` tool. One model, four
renderers - no second source of truth about progress.

## 7. Re-download

Two rules, in this order.

**A stored transcript is not re-downloaded.** Once a meeting's transcript is
complete it is never fetched again. Sana transcripts do not change after
processing, so re-fetching only risks discarding local edits and wastes
bandwidth. The daemon fetches when a transcript is absent, previously
incomplete, or explicitly refreshed by the user.

**When a re-download does happen, edits are re-applied by content, not by
position.** Re-transcription can shift line boundaries, so line numbers are not
a reliable identity:

1. For each edit, look for a line whose `original_text` hashes to
   `original_sha256` - first at the recorded `line_no`, then across the
   transcript.
2. On a match, re-apply the edit at the line where it was found.
3. On no match, mark the edit `stale` and keep it. It stays visible in history
   with its original and edited text, so the user can re-apply it by hand.

A stale edit is never silently dropped and never applied to a line it does not
belong to. **This is the one part that cannot be retrofitted**, because it
constrains the schema, so it is built from the first migration.

**Consequence worth stating.** The database stops being a pure cache of Sana and
becomes a store holding user-owned data. Deleting `sana.db` today loses nothing;
after this it loses corrections. Backup, reset, and any "incompatible state"
recovery path must treat `line_edits` as data to preserve, not cache to discard.

## 8. Search

Ordered by what the measurements support. Full evidence in `../plan.md`.

**Primary: FTS5 BM25** over `line_search`. It wins on proper nouns and returns
the target line first whenever the query spelling matches the transcript.

**Free spelling-variant harvesting**, no model and no curation: `fts5vocab`
gives the real corpus vocabulary; edit distance plus double metaphone (**both**
codes - the secondary is what catches `Alex`/`Jazmin`) plus distributional
neighbours cluster `fabrics`/`fabrix`/`fabriko`/`fabriks` and `zenolith`/`crawlery`
automatically. Allow edit distance 1 on the phonetic codes, not exact lookup.

**Optional dense channel**, off by default: potion-retrieval-32M in Go, 31 MB
int8, 12,914 chunks in 19.2 s at 119 MB peak RSS. Enabled from Configuration,
lazily downloading the model. v1 ships with it off, which means no model
download, no indexing pass, and a ~6 MB binary.

Not built: index-time LLM mining (no LLM exists at index time - the model is a
*user* of this tool), lattice/n-best (Sana returns 1-best only and has no API to
ask), and unconditional RRF (measured to degrade results).

**Honest limitation.** Correction makes a miss fixable, not findable. Every
automatic detection method was measured and failed, so a garbled name is only
correctable once noticed by some other route. What correction buys is that the
fix is durable and shared by every later search of that transcript.

## 9. Package layout

```
main.go                  entrypoint and mode dispatch
internal/bootstrap       paths + config, shared by every entrypoint
internal/config          persisted settings
internal/cli             argument parsing and one-shot commands
internal/store           SQLite: schema, migrations, meetings, lines, edits, search
internal/sana            Sana client: auth, meetings, transcripts, recordings
internal/daemon          background sync, single writer under flock
internal/mcpserver       the meeting_transcripts tool surface
internal/app             the interactive application
internal/install         detect-harness wiring and the installer TUI
internal/search          BM25 query building, variant harvesting, optional dense
```
