# sana-mcp: Go rewrite plan

Branch: `go-rewrite`. Living document, updated as investigation proceeds.

## Why we are doing this

The TypeScript/Bun implementation was never a deliberate choice. There was an
existing TS prototype, so it got wrapped in Bun. In hindsight that is not
carrying its weight. The tool itself is not complicated: **auth, sync, and
local operations**. What we pay for the Bun approach:

- 115 MB single-file binary per platform, ~90 s to download on a normal
  connection before the installer can even start.
- Runaway memory in the sync daemon: measured 1.5 GB -> 2.7 GB -> 3.7 GB ->
  4.26 GB RSS over ~14 minutes of indexing, still climbing. Effectively
  unbounded; it will OOM on a long backfill.
- The install path has accumulated fixes and abstractions to the point of being
  a mess (33 k lines of TS across src/, a 1840-line install.sh and a 2778-line
  install.ps1).

## What must be preserved

1. **The tool formats and the entire contract with the LLM.** The MCP tool
   surface, argument shapes, and response formats stay as they are.
2. **The UX of the interactive app.** The TUI flows (meetings list, transcript /
   summary / participants / recording views, search, sync status, account,
   configuration) keep their current shape and feel.

## Reference repos to investigate

Both are the user's own Go projects and represent the target architecture.

- `../interactive-terminal-mcp` (4.5 MB) - **the layout we want**: installer,
  MCP server, CLI, and TUI in one Go project. Closest model for sana-mcp.
- `../apis-mcp` (128 MB) - nice installer and build configuration.

What to look for in both:
- Installer design and the one-liner UX (how it detects clients, writes MCP
  configs, handles updates).
- Build configuration: cross-compilation, per-platform dependency-free static
  binaries, release automation.
- How CLI / MCP / TUI modes share one binary and one entrypoint.
- Binary size and startup characteristics.

## The contract to preserve, exactly

### MCP tool surface

One tool, `meeting_transcripts`, dispatching on a `tool` name plus optional
`args` - this shape is deliberate (the user wants the agent-facing tool
unbranded and singular) and must not change.

| tool | args | returns |
|---|---|---|
| `help` | `{tool?}` | all tools, or the argument schema for one |
| `login` | `{email}`, then `{email, confirmation_code}` | passwordless sign-in via email code |
| `status` | (none) | sync progress and coverage |
| `list` | `{page?, limit?, query?, sort?, filter?}` | meetings: id, timestamp, title, status |
| `read` | `{meeting_id, full?, lines?, timestamps?}` | transcript lines (all, or a `[start,end]` range) |
| `search` | `{query, page?, limit?, sort?, filter?}` | matching lines with meeting id + line number |
| `summary` | `{meeting_id}` | summary, notes by topic, and action items |
| `participants` | `{meeting_id}` | attendees (name, email, host) |
| `recording` | `{meeting_id}` | a temporary recording link, fetched live |

Semantics that go with it: `list.sort` = `newest|oldest`; `list.filter` =
`{status: ready|downloading|processing|retrying, date: {from, to}}` accepting ISO
`YYYY-MM-DD` or epoch ms; `read.lines` is a 1-based `[start, end]` range, and with
no selection it reports the line count and the options rather than dumping;
`search.sort` = `best|newest|oldest`; `recording` fetches a live URL that expires.

### TUI screens

Main menu: Meetings, Search transcripts, Sync status, Sana account,
Configuration, Quit. Meetings list shows `N ready` with date, word count and
status per row, and per-row actions `t` transcript, `s` summary, `p`
participants, `o` recording, `/` name filter, `f` status filter, PgUp/PgDn.
Transcript view is numbered `N [m:ss] Speaker: text` with scroll and `t/s/p/o`
switching. Search shows the index state (`semantic index 32/240`), the mode
(`hybrid`), sort (`best`) and paging.

Fix while porting: ESC is not advertised as "back" in the meetings footer, and
two rapid ESC presses get swallowed.

## RESOLVED: search architecture (investigation complete, measured)

Recommendation, pending validation on the real corpus:
**`modernc.org/sqlite` + `modernc.org/sqlite/vec` (sqlite-vec) + a hand-written
model2vec/potion encoder in Go + FTS5 BM25 as a gated booster.** Pure Go, no cgo.

### The "Fabrics PIM" -> "Fabrik" case is not phonetic

Measured, not assumed. Every string-similarity technique fails on this pair:

| Pair | Double metaphone | Soundex | Levenshtein | Trigram Jaccard |
|---|---|---|---|---|
| Fabrics / Fabrik | `AKN` vs `ANTK` no match | `A250` vs `A532` no match | 4 (of 6 chars) | **0.000** |

FTS5 trigram `MATCH 'fabrics'` against a document containing "Fabrik" returns zero
rows. This is an ASR *language-model substitution* - the recognizer replaced an
unknown foreign brand with a familiar Polish given name that fits the context -
not a phonetic confusion. **No spellfix1, SymSpell, BK-tree or metaphone design
recovers it.** What retrieves the chunk is topical similarity from the
surrounding words (PIM, catalog, attributes, migration), so **the dense channel
is load-bearing and cannot be dropped.**

Phonetics *do* fix a different real class, worth having as a cheap third channel
via `fts5vocab` + an in-memory double-metaphone map (all measured matching):
Kubernetes/"Cooper Netties", Postgres/"Post grass", Grafana/"Graphana",
Datadog/"Data dog", and the Fabrix/Fabrics user typo.

### Real query shapes are the easy case (measured)

The garbled proper noun gets **outvoted** by the surrounding content words. Rank
of the correct chunk:

| Query | potion | MiniLM | BM25 |
|---|---|---|---|
| `northwind issues with proofreading` | #1 | #1 | #1 |
| `vantik planned release date for hockey environment` | #1 | #1 | #1 |
| `lumen problems with the copy review` | #1 | #1 | #1 |
| `Alex notes on the release schedule` | #1 | #1 | #1 |
| `vantik hiring plan` | #1 | #1 | #1 |
| `fabrics vs lumen testing` | **#2** | #1 | **MISS** |

In "vantik planned release date for hockey environment", `planned release date
environment` carry the meaning and one junk token cannot drag the mean-pooled
vector away from them. **The last row is the entire justification for keeping
embeddings**: every content-bearing word is garbled and only the generic
"testing" survives, so BM25 misses completely and only the dense channel finds it.

### Phonetic channel: two rules from measurement

| Pair | Double metaphone | Levenshtein | Verdict |
|---|---|---|---|
| `Alex` / `Jazmin` | `ASMN` vs `JSMN`+**`ASMN`** | 2 | caught, **via the secondary code** |
| `lumen` / `lumen` | `ATLS` vs `A0S`+`ATS` | 2 | missed by exact code, **caught by edit distance on codes** |
| `northwind` / `northwind` | `PRS` = `PRS` | 2 | caught |
| `vantik` / `spot big` | `SPPK` vs `SPTPK` | 3 | missed |
| `Fabrics` / `Fabrik` | `AKN` vs `ANTK` | 4 | missed |

1. **Index both double-metaphone codes**, not just the primary - that alone is
   what catches Alex/Jazmin, and it is why double metaphone beats soundex.
2. **Allow edit distance 1 on the codes**, not exact lookup - `lumen`/`lumen` are
   1 apart phonetically but 2 apart as strings.

Build this channel **last**, and only if users complain about name lookups.

### Do not build (measured as unhelpful or harmful)

- **Dropping unknown query tokens** as an ASR mitigation: no improvement
  (MRR 0.917 either way) and it sometimes strips useful words.
- **Unconditional RRF**: drops MRR 0.958 -> 0.847.
- **spellfix1**: unavailable in modernc, and would not help the hard case anyway.

### sqlite-vec runs on pure-Go SQLite

Verified end to end, not taken from docs:

```
sqlite 3.53.3, vec_version v0.1.9, create virtual table vec0: OK
inserted 20000 x 512d vectors in 8.205s
KNN k=10 over 20000 vectors: 10 rows in 26.415ms
```

`vec0` accepts `float[512]`, `int8[512]`, `bit[512]`, `distance_metric=cosine`,
partition keys and auxiliary columns. All six cross-compile targets build with
`CGO_ENABLED=0`. modernc also ships FTS5, trigram, porter, soundex, JSON1,
fts5vocab, rtree. **Absent: spellfix1, editdist3, fts4, runtime
`load_extension`** - none of which we need given the finding above.

### The embedding model: potion-retrieval-32M, reimplemented in Go

model2vec inference is not neural: tokenize (BERT WordPiece, no special tokens),
one embedding-table row per token, mean, L2-normalize. A ~250-line Go encoder
(only dependency `golang.org/x/text` for NFD) was validated against the Python
reference: **worst cosine agreement 1.00000000 across 42 texts** including Polish
diacritics and `C++ / .NET 8.0`; 11,024 docs/sec, 90.7 us/doc.

Retrieval on a 24-chunk / 12-query ASR-corrupted corpus:

| Model | Size | R@1 | R@3 | MRR |
|---|---|---|---|---|
| BM25 only | 0 | 0.667 | 0.833 | 0.775 |
| **potion-retrieval-32M int8 512d** | **31 MB** | **0.917** | 1.000 | **0.958** |
| potion-retrieval-32M int8 256d | 15 MB | 0.917 | 1.000 | 0.944 |
| all-MiniLM-L6-v2 q8 ONNX (current) | 22 MB | 0.917 | 1.000 | 0.958 |

int8 quantization is free (identical to f32, 123 MB -> 31 MB). **Ship 512d int8.**
256d is a legitimate operating point only because this model was trained with
`MatryoshkaLoss([32,64,128,256,512])`, but the 16 MB saving is not worth the risk.

**This is what removes the memory problem.** No daemon, no ONNX, no worker
process, no arena: nothing to leak. Compare 20k chunks indexed in under 2 seconds
against a daemon that reached 6.79 GB and had to be SIGKILLed.

### Ranking: dense-first, lexical gated. Not naive RRF.

| Method | R@1 | R@3 | MRR |
|---|---|---|---|
| dense only | **0.917** | **1.000** | **0.958** |
| BM25 only | 0.667 | 0.833 | 0.775 |
| RRF k=60 | 0.750 | 0.917 | 0.847 |
| RRF, BM25 only when it has hits | 0.833 | 1.000 | 0.903 |

RRF *degrades* results because BM25 always emits a confident full ranking even
when the transcript is garbled and it has no real signal. Fuse only documents
FTS5 actually matched, and only for rare or quoted terms.

### Projected shipping size

Go binary 2.2 MB stripped, 9.6 MB with SQLite + sqlite-vec; model 30.8 MB int8
(22.2 MB gzipped); vocab 0.5 MB. So **~10 MB binary + ~22 MB first-run download**,
against 115 MB today.

### Risks and what to prototype first

1. The benchmark is 24 chunks / 12 queries - directional only. MTEB Retrieval puts
   potion at 81.7 % of MiniLM (35.06 vs 42.92); that gap did not appear here
   because this workload is topical bag-of-words matching, where static
   embeddings are strongest.
2. **Static embeddings ignore word order.** "Did we pick A over B" and "did we
   pick B over A" embed identically. Meeting queries are often exactly that
   shape, and the test set does not probe it. This is the main quality risk.
3. Both potion-retrieval-32M and all-MiniLM-L6-v2 are **English-only**. If
   transcripts are substantially Polish, use `minishlab/potion-multilingual-128M`.
   Pre-existing limitation, not a new one.
4. sqlite-vec v0.1.9 is pre-1.0 - pin it.
5. Nothing here recovers Fabrics/Fabrik at the *token* level. If the only matching
   chunk lacked topical context, no design finds it. The real fix for that class
   is an alias/glossary of product names mapped to observed ASR variants, applied
   as query expansion.
6. ONNX/bleve comparison rows were not verified (those research agents stopped).

**Tests to run next, in priority order:**

1. **Replay real queries against the real corpus.** The only test that settles the
   decision. Dump existing chunks + MiniLM vectors, encode the same chunks with
   potion, compare top-10 overlap and human judgement on 30-50 real queries.
2. **Word-order sensitivity.** The real weakness of static embeddings, and the
   benchmark corpus does not probe it. Test "did we pick A over B" vs "B over A",
   "client rejected our proposal" vs "we rejected the client proposal".
   **If potion cannot separate these and users ask such questions, that is the one
   finding that flips the recommendation to ONNX.**
3. **Hard negatives at real scale.** The 24-chunk corpus is topically distinct, so
   almost everything ranks #1. Real meetings have hundreds of near-duplicate
   chunks (weekly standups on the same project). Re-measure at ~20k chunks and
   expect ranks to spread.
4. **Language check.** `Fabrik`, `Alex`, `Jazmin` suggest Polish context. Both
   potion-retrieval-32M and the current MiniLM are English-only - if meetings are
   substantially Polish this is a pre-existing problem, fixed by
   `potion-multilingual-128M`.
5. **Chunk-size sweep.** Static embeddings dilute with length, since every token
   gets equal weight in the mean. The current 96-word "large" chunks may be past
   the useful point for potion specifically. Sweep 32/64/96/128 words on real data.

Then: port the encoder, wire it to `modernc.org/sqlite/vec`, and only afterwards
tune the gated BM25 booster.

Fallback: keep all-MiniLM-L6-v2 via `github.com/yalue/onnxruntime_go`, accepting
a per-platform shared library and the loss of trivial cross-compilation - i.e.
reintroducing the packaging problem we are leaving Bun to escape. Prefer this
only if a larger honest evaluation shows potion losing meaningfully on
word-order-sensitive queries.

### Modules

- `modernc.org/sqlite` v1.55.0 (SQLite 3.53.3) + blank import `modernc.org/sqlite/vec` (sqlite-vec v0.1.9)
- `golang.org/x/text` v0.40.0 (only for `unicode/norm` NFD)
- Model `minishlab/potion-retrieval-32M` (MIT); port from `MinishLab/model2vec` and `model2vec-rs`

Working prototypes live in the session scratchpad: `goproto/main.go` (Go encoder),
`sqltest/main.go` (sqlite-vec probe), `bench.py` / `hybrid.py` (evaluations).
**Copy these into the repo before the scratchpad is lost.**

## Superseded: the original open problem

This is the one genuinely unresolved question and the reason the rewrite is not
a mechanical port.

**Requirement:** a lightweight semantic embedding model that can be bundled into
the binary or lazy-downloaded, without dragging in a heavy runtime.

**Why semantic search matters here (concrete case):** transcripts contain ASR
errors. Searching for "Fabrics PIM" must find passages where the transcript says
"Fabrik". Keyword search misses this; the current embedding-based search finds it.

So the alternative framing is also open: **is there a better non-semantic search
than what we have** that survives transcription errors? (fuzzy / trigram /
phonetic / typo-tolerant approaches.)

## Findings

### Reference repo: `../interactive-terminal-mcp` (the target architecture)

This is the layout to copy. Go 1.26, `main.go` + `internal/{app,bootstrap,budget,
cli,config,daemon,fsx,install,ipc,keys,mcpserver,render,session,vterm}`.

**Size comparison, same class of tool:**

| | sana-mcp (TS/Bun) | interactive-terminal-mcp (Go) |
|---|---|---|
| source | 33,493 lines `src/` (+42k tests) | 18,684 lines total incl. tests |
| `install.sh` | 1,840 lines | 265 lines |
| `install.ps1` | 2,778 lines | 193 lines |
| CI/release workflows | 1 file, 53,292 bytes | 3 files, 211 lines total |
| install logic | ~8,500 lines across `install.ts` (2,605), `legacy-posix-recovery.ts` (3,072), `config-transaction.ts` (1,443), `config-formats.ts` (980), `atomic-config.ts` (482) | `install.go` (378) + `tui.go` (656) |
| shipped binary | 115 MB (120,854,656 B installed) | **16 MB** (16,015,522 B) |

**Key mechanisms worth taking wholesale:**

- **`github.com/sairaph/detect-harness`** - client/harness detection extracted as
  its own module. It already encodes the exact distinction I fixed in the TS code
  today: *"State is present, absent, or unavailable. Unavailable is kept distinct
  from absent so a permission error is never shown as 'not installed'."* and
  *"A client that cannot be used is still just 'not detected' as far as the list
  is concerned: the user wants to know whether it is there, not why the library
  could not reach it."* This is ~8,500 lines of our install mess, solved as a
  dependency.
- **One binary, mode by context** (`main.go`): a bare invocation runs the TUI when
  stdin+stdout are terminals, and the MCP server when they are not - so an AI
  client that execs the binary with no arguments still gets a server. Subcommands:
  `mcp`, `daemon`, `configure|install|uninstall`, `attach`. Exactly the shape
  sana-mcp needs.
- Help and version run *before* any state is loaded, so they work with an
  unwritable home directory.
- The installer is **one Bubbletea program with explicit steps**
  (`detecting -> harnesses -> retention -> summary -> settings -> applying ->
  done`) so the screen evolves in place instead of appending a block per
  question. Notably `stepDetecting` exists *because* scanning for thirteen
  clients takes a visible moment and the installer previously "showed nothing at
  all until it finished" - which is exactly the dead-air gap I hit in our v0.4.22
  run between the download finishing and the wizard appearing. Already solved
  there; port the solution rather than rediscovering it.
- **Release workflow**: `CGO_ENABLED=0`, 6-way matrix (linux/darwin/windows x
  amd64/arm64), `-trimpath -ldflags="-s -w -X main.version=$version"`, sha256sums,
  `softprops/action-gh-release`. 78 lines. Tests run `go vet`, `go test`,
  `go test -race`, plus a `GOOS=windows go vet` cross-check.
- `docs/{app-design.md, implementation-plan.md, tool-contract.md}` - the
  `tool-contract.md` pattern is exactly where our "keep the LLM contract"
  requirement should live.
- The installer draws its own progress bar rather than using curl's, deliberately,
  so the POSIX and Windows installers show a person the same thing. It stops a
  running daemon before replacing the binary, and downloads to `TARGET.new` so a
  failure never leaves a half-written binary in place.
- **Release = bump `VERSION` and merge to main.** `autorelease.yml` (70 lines)
  checks whether `VERSION` has a published release; if not it force-points the tag
  at the built commit and calls `release.yml` as a reusable workflow. It keys off
  *the absence of a published release*, not the absence of a tag, so a failed
  build does not permanently poison that version number. This replaces our
  53 KB `release.yml` and the whole hand-rolled `scripts/release.ts` (33 KB).
- The entrypoint model is shared with `favro-mcp` and `apis-mcp`, so sana-mcp
  should join that family rather than invent a fourth convention.

**Release ceremony, measured by doing it.** Cutting v0.4.23 on the TS repo
required hand-editing the same version number in **six files, seven locations**:

1. `package.json` (`version`)
2. `tests/fixtures/manifest/valid-all-targets.json` (`packageVersion`, `releaseTag`)
3. `tests/fixtures/manifest/invalid-unknown-field.json` (same two)
4. `README.md` (the `SANA_MCP_VERSION` pin example)
5. `install.sh` (two comment lines: the pinned one-liner and the tag URL)
6. `docs/dev/cli-specs.md` (the "current release candidate" line)
7. `.github/workflows/release.yml` (the `workflow_dispatch` input description)

Two separate tests enforce this - `tests/install/manifest.test.ts` and
`tests/release/version-projection.test.ts` - and they fail one at a time, so you
discover the list by running the suite repeatedly. Note that item 7 means the
release workflow's own *help text* is version-pinned and test-enforced.

In the Go design this is one file (`VERSION`); the workflow derives the tag and
`-ldflags` injects it into the binary. This is the clearest small example of the
repo turning routine operations into rituals.

**Measured binary sizes on this machine:** interactive-terminal-mcp 16.0 MB,
apis-mcp 34.0 MB, sana-mcp **120.9 MB**. A Go sana-mcp should land ~16-25 MB
before any bundled model, i.e. the 90-second download becomes roughly 10 seconds.
Even bundling a small static embedding model should keep it well under half the
current size, with no runtime at all.

**`CGO_ENABLED=0` is a hard constraint** inherited from this design. It decides the
search question below: anything requiring cgo (onnxruntime_go, mattn/go-sqlite3)
breaks the cross-compilation story.

**State and process model.** `bootstrap.Open()` resolves paths + config once, for
every entrypoint, and deliberately does *not* contact the daemon, so the installer
and help work when no daemon can run. Atomic file replacement is
`internal/fsx/replace_{unix,windows}.go` - two small files against our
`atomic-config.ts` (482) + `private-json.ts` (320) + `secure-files.ts` (569) +
`windows-acl.ts` (328) = 1,699 lines.

Their daemon owns PTYs, so every client talks to it over a socket with a JSON-line
IPC protocol (`internal/ipc`, ~700 lines). **sana-mcp probably does not need that
layer at all**: our shared state is the SQLite database, not a live kernel object.
Readers (MCP, CLI, TUI) can open the DB directly; the sync daemon only needs
single-writer coordination, which `gofrs/flock` plus SQLite WAL gives us. That
would delete our `control.ts` (1,200), `lifecycle.ts` (549), `lock.ts` (127) and
`spawn.ts` (117) lease/heartbeat machinery rather than port it. Worth confirming
before committing to it, but it is the single biggest simplification available.

### Reference repo: `../apis-mcp` (proves the SQLite + search path)

38,007 lines of Go. `install.sh` 130 lines, `install.ps1` 220 lines. Same
Bubbletea/lipgloss + `modelcontextprotocol/go-sdk v1.6.1` stack.

**The decisive finding:** apis-mcp already runs **SQLite FTS5 with `bm25()`
ranking on `modernc.org/sqlite v1.54.0`** - the pure-Go driver, no cgo
(`internal/library/index.go:378`, `internal/library/search.go:49`). It uses
per-column BM25 weights (`bm25(page_search, 0.0, 12.0, 12.0, 6.0, 4.0, 1.0,
12.0, 12.0)`) with `tokenize = 'unicode61'`.

So the **BM25 half of our hybrid search ports to Go with zero cgo and a proven
in-house precedent**. What remains genuinely open is only the semantic/ASR-error
half.

### Memory investigation on the TS implementation (completed)

Empirically narrowed down before the pivot decision:

- Uniform batch shapes (128 items, constant length): RSS plateaus flat at
  ~430 MB across 20 rounds. No growth.
- **Varied** batch shapes (batch 5-128, 3-96 words, mirroring real transcript
  chunks): RSS ratchets 583 MB -> 1041 MB over 24 rounds, and kept climbing on a
  second pass over the *same* shape sequence. This is the real workload.
- Daemon memory is ~98 % anonymous private dirty heap (4.19 GB of 4.26 GB), with
  ~70 GB of virtual data address space reserved and dozens of mid-sized arenas.
- Disabling the onnxruntime CPU arena (`session_options.enable_cpu_mem_arena =
  false`) changed **nothing**: 1037 MB vs 1042 MB over the same 24 rounds.

Conclusion: the growth is not the ONNX arena allocator. It is deeper in the
transformers.js / Bun stack, and is not fixable from our side by configuration.
This is direct evidence for leaving the stack rather than patching it.

### Install UX issues found in the end-to-end v0.4.22 run

- Claude Desktop reported two stacked failures on Linux for a non-issue (it has
  no Linux build), each duplicating its reason in brackets, one styled as a hard
  error. **Fixed** on this branch: platform support is now a property of the
  client (`platforms: ["darwin", "win32"]`) and unsupported clients are dropped
  before detection, so they never reach the wizard or the output. Carry this
  concept into the Go rewrite: *a client that cannot exist on this platform is
  not a failure, it is simply not there.*
- Wizard selection state (`◉` = currently configured, `(will enable)` only after
  toggling) is legible only once you know the convention.
- Two ESC presses in quick succession get swallowed; the meetings list footer
  never mentions that ESC returns to the main menu.

### Uncommitted TS work carried onto this branch

The working tree still has, from before the pivot:
- the Claude Desktop / platform-support fix (`src/install/*`),
- an in-flight out-of-process embedding worker refactor
  (`src/semantic/embedding-worker*.ts`, `src/sync/daemon.ts`), which isolates the
  daemon from the leak but does not remove it.

Decide whether any of this is worth landing on `main` before the rewrite takes
over.

## Status

- [x] Create `go-rewrite` branch and this plan
- [x] Investigate `../interactive-terminal-mcp` layout and installer
- [x] Investigate `../apis-mcp` installer and build config
- [x] Investigation: Go options for search + semantic search
- [x] Decide search architecture (pending real-corpus validation)
- [x] Preserve investigation prototypes in `prototypes/`
- [ ] **Validate potion vs MiniLM on the real corpus** - the one open question
- [ ] Port plan: auth, sync, local ops, MCP contract, TUI

## Also worth fixing, found while testing v0.4.22

- The sync daemon **ignores SIGTERM for 28+ seconds while embedding** and needs
  SIGKILL; it does not yield during native inference. Reproduced directly: the
  daemon at 6.79 GB survived `kill -TERM` for 28 s. The uncommitted heartbeat /
  abort work on this branch was aimed at this. In the Go design, embedding is a
  cheap in-process table lookup, so the whole class of problem disappears.
- The installer test suite has 5-second subprocess timeouts and goes flaky under
  machine load (a *different* set of 2-4 tests failed per run while the leaking
  daemon held 6.8 GB and 114 % CPU; all 54 pass unloaded). Whatever replaces it
  should not encode wall-clock assumptions that turn load into false failures.

## Constraints the rewrite inherits (decided, not open)

- `CGO_ENABLED=0`, cross-compiled 6 ways. No cgo dependencies, anywhere.
- `modernc.org/sqlite` as the driver; FTS5 + BM25 confirmed working on it.
- `modelcontextprotocol/go-sdk` for MCP; Bubbletea + lipgloss for the TUI.
- `detect-harness` for client detection and MCP config writing.
- One binary: TUI when interactive, MCP server when not, plus subcommands.
