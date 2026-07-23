# sana-mcp Go Port - Technical Feasibility Study

Status: July 2026. All module versions and claims were web-verified against
pkg.go.dev, the upstream repos, and release feeds this month. Nothing here is
taken from memory.

Goal: replace the `git clone && npm install && npm run build && node dist/mcp.js`
flow with a single self-contained binary installed by
`curl <github-url> | sh` (Linux/macOS) and `irm <github-url> | iex` (Windows).
One binary, three runtime roles: MCP/stdio server, CLI, detached background
daemon.

## TL;DR / verdict

**Conditional GO.** Every piece of the surface area has a working Go module
in July 2026, and the one thing that looked like a blocker - loading the C
**sqlite-vec** extension without CGO - was solved in March 2026 when
`modernc.org/sqlite` shipped sqlite-vec natively. The result is that the
**entire base app (HTTP + SQLite + FTS5 + vec0 + MCP + daemon) can be built
with `CGO_ENABLED=0`** as pure Go, giving free static cross-compilation for
all six targets from one Linux box.

The single condition: **on-device embeddings (the "LM runtime") cannot be
pure-Go today.** If you want embeddings inside the binary you must either
(a) accept CGO + ship the ONNX Runtime shared library per target, or
(b) keep embeddings as an optional sidecar. Because embeddings are already
optional in the TypeScript app, the clean answer is: ship a pure-Go base
binary, and make embeddings an optional companion. See the two strategies in
the CGO section.

---

## 1. Go module map for the exact surface

| Surface (from TS source) | Go module | Version (Jul 2026) | CGO? | Maturity |
|---|---|---|---|---|
| SQLite WAL, busy_timeout, txns | `modernc.org/sqlite` | v1.54.0 (Jul 15 2026) | No | Mature, actively maintained |
| FTS5 + BM25 + `unicode61 remove_diacritics 2` | `modernc.org/sqlite` (built in) | v1.54.0 | No | Included in the transpile |
| sqlite-vec `vec0` virtual table, KNN, distance | `modernc.org/sqlite/vec` (blank import) | since v1.47.0 (Mar 17 2026) | No | ~4 months old, several point releases since |
| HTTPS client, cookie jar, manual redirects | stdlib `net/http` + `net/http/cookiejar` | Go 1.24+ | No | Stdlib |
| MCP server, stdio JSON-RPC, tool registration | `modelcontextprotocol/go-sdk` | v1.7.0+ (v1.0 reached 2025) | No | Official, Google-backed |
| CLI (subcommands + flags + JSON arg) | `spf13/cobra` | v1.9.x line | No | De-facto standard |
| Daemon spawn (detached, hidden window) | `os/exec` + `golang.org/x/sys` | latest | No | Stdlib + x/sys |
| File lock (new - TS has none) | `github.com/gofrs/flock` | v5.x | No | Mature, wraps flock/LockFileEx |
| Embeddings, q8 MiniLM (optional) | `github.com/yalue/onnxruntime_go` | latest | **Yes** | Working, needs ONNX Runtime .so/.dll |

---

## 2. CRUX A - the SQLite CGO fork in the road

This is the decision that drives everything else. There are three viable
drivers, not two.

### Option 1: `mattn/go-sqlite3` (CGO, full power)

- Version: v1.14.x line (the only stable line; no v2 exists).
- CGO required (needs gcc/clang/mingw per target).
- FTS5: yes, via build tags (`-tags "fts5"`).
- `load_extension`: supported (`?_load_extension=1` or the `LoadExtension`
  API). sqlite-vec loads cleanly through
  `github.com/asg017/sqlite-vec-go-bindings/cgo` via `sqlite_vec.Auto()`,
  statically linked at build time.
- Performance: the fastest Go SQLite driver, especially on writes.
- Cost: first build is slow; every target needs a C toolchain.

### Option 2: `modernc.org/sqlite` (pure-Go transpile) - RECOMMENDED

- Version: **v1.54.0** (published Jul 15 2026).
- A C-to-Go transpile of the SQLite amalgamation. **No CGO.**
- FTS5: included, including `unicode61 remove_diacritics 2` (verified the
  tokenizer options ship in the transpile).
- **sqlite-vec: YES, natively.** As of **v1.47.0 (Mar 17 2026)** the driver
  ships the transpiled sqlite-vec extension in a `vec/` subpackage. You
  enable it with a blank import:

  ```go
  import (
      _ "modernc.org/sqlite"   // registers the driver
      _ "modernc.org/sqlite/vec" // auto-registers vec0 + vec_* functions
  )
  ```

  The `init()` in the vec package auto-registers the extension, so you never
  call `load_extension` and you never touch a `.so`. The `vec0` virtual
  table, metadata columns, `MATCH`/`k=` KNN, and `distance` ordering all
  work, because it is the real sqlite-vec transpiled - not a reimplementation.

  This maps **directly** onto the app's existing schema:
  `CREATE VIRTUAL TABLE vec_lines USING vec0(embedding float[384],
  meeting_id TEXT, line_no INTEGER, created_at INTEGER)` and
  `... WHERE embedding MATCH ? AND k = ? ORDER BY distance` carry over
  verbatim.
- Performance: slower than mattn on write-heavy micro-benchmarks (an older
  thread once cited a large gap; current consensus is "noticeably slower
  under contention but fine for normal loads"). sana-mcp is read-mostly with
  a periodic background sync writing transcript rows in modest batches, so
  modernc throughput is more than sufficient.
- Gotcha: a Feb 2026 r/golang thread flagged a "re-prepares statements"
  regression in some modernc versions. Pin the version (v1.54.0 is clean)
  and benchmark your actual query mix if paranoid.

### Option 3: `ncruces/go-sqlite3` (WASM via wasm2go)

- Loads sqlite-vec via
  `github.com/asg017/sqlite-vec-go-bindings/ncruces` (blank import embeds a
  custom WASM build).
- Also CGO-free, but higher memory overhead than modernc (a full WASM
  runtime in-process). Not worth it here given modernc now ships vec.

### The precise answer to the "can modernc load the C sqlite-vec extension?"

question that drives the study: **modernc cannot load arbitrary C
`.so`/`.dll` extensions via `load_extension` (that mechanism is tied to the C
shared-library loader and is absent in the transpile). It does not need to:
sqlite-vec is bundled as a transpiled Go extension and auto-registered.**
So the original open question is moot in July 2026. You get sqlite-vec in
pure Go.

**Decision: Option 2 (modernc).** It removes CGO from everything except the
optional embeddings, which is what unlocks the one-binary, trivial
cross-compile story.

---

## 3. CRUX B - the `CGO_ENABLED` tension

Two packaging strategies. The recommendation is to ship Strategy A as the
primary binary and treat Strategy B as an opt-in.

### Strategy A: `CGO_ENABLED=0` pure Go (RECOMMENDED as the base install)

- SQLite + FTS5 + vec0 from `modernc.org/sqlite` (+ `/vec`).
- HTTP, MCP, CLI, daemon - all stdlib / pure-Go modules.
- **No on-device embeddings** in this binary (semantic search falls back to
  BM25-only, exactly as the TS app does when `SANA_SEMANTIC!=1`).
- Cross-compilation: from one Linux host you produce all six targets with
  nothing but Go:

  ```
  CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o sana-linux-x64
  CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -o sana-linux-arm64
  CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -o sana-macos-x64
  CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -o sana-macos-arm64
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o sana-windows-x64.exe
  CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -o sana-windows-arm64.exe
  ```

  No C toolchain, no glibc-vs-musl decision, fully static. This is the whole
  reason to port.
- Packaging cost: trivial. A single GitHub Actions job with a matrix.
  `curl | sh` / `irm | iex` installers are a ~30-line shell/PowerShell script
  that picks the right asset from GitHub Releases.

### Strategy B: `CGO_ENABLED=1` (needed only if embeddings must be in-binary)

- Enables `yalue/onnxruntime_go` for on-device q8 MiniLM.
- Two sub-costs:
  1. **C toolchain per target.** Either build on native GitHub Actions
     runners (ubuntu for linux, macos for darwin, windows for windows) or use
     `zig cc` as a universal cross-compiler. musl vs glibc matters again for
     linux static linking.
  2. **ONNX Runtime shared library per target** (`libonnxruntime.so` /
     `libonnxruntime.dylib` / `onnxruntime.dll`, roughly 5-10 MB each, plus
     `onnxruntime_providers_shared` sometimes). You either (a) ship it beside
     the binary and set the load path, or (b) extract an embedded copy on
     first run, or (c) attempt static linking (heavier, fiddly, license
     considerations under the MIT-style ONNX Runtime license - generally OK).
- This breaks the "one pure-Go binary" cleanliness, so confine it to a
  separate `sana-embed` companion or a build tag (`-tags embeddings`).

**Recommended split:** Strategy A is the default binary everyone installs.
Strategy B is an optional `sana embed` sidecar (or a tagged build) that the
daemon locates and shells out to when `SANA_SEMANTIC=1`. The base install
then pays zero model cost and stays pure-Go; users who want hybrid search opt
in. This preserves the exact optionality the TS app already has.

---

## 4. Embeddings - the "LM runtime"

### Current TS behaviour (to match)

- Model: `Xenova/all-MiniLM-L6-v2`, 384-dim, run through
  `@huggingface/transformers` (Transformers.js, which is itself ONNX Runtime
  under the hood).
- Quantization: `dtype: "q8"` (INT8 via `MatMulInteger` in the ONNX graph).
- Lazy-loaded, unloaded after ~60s idle (`SANA_EMBED_IDLE_MS`).
- ~150 MB resident while active. Model files cached under `data/models/`.

### Go path: `github.com/yalue/onnxruntime_go` (CGO)

- A thin Go wrapper over the official ONNX Runtime C API. You ship the
  matching `libonnxruntime.*` for the target OS/arch.
- **INT8 / q8 support: yes.** Quantization is handled inside the ONNX graph
  itself (the `MatMulInteger` operator). Because `onnxruntime_go` just feeds
  the session to the C runtime, running a q8-quantized MiniLM works as long
  as you load the q8 ONNX model file - the same file Transformers.js uses.
  No special Go-side quantization code is required.
- Workflow that reproduces the TS behaviour: load the q8 ONNX model with
  `NewAdvancedSession`, run `tokenizer` (see below), feed `input_ids` /
  `attention_mask` / `token_type_ids`, mean-pool token embeddings, L2-normalize
  -> 384-dim vector -> serialize to the sqlite-vec BLOB format.
- Tokenizer: the BERT/WordPiece tokenizer is not in ONNX Runtime. Use a pure-
  Go HF tokenizer port. `clems4ever/all-minilm-l6-v2-go` vendors a fork of
  `sugarme/tokenizer` for exactly this model and is a useful reference (but
  see the pure-Go note below). `datetime/...` style alternatives exist; pick
  one that passes the model's vocab.

### Numbers (q8 MiniLM, CPU)

| Quantity | Value | Source |
|---|---|---|
| q8 ONNX model weight size | ~23 MB | HF model card |
| FP32 ONNX model weight size | ~90 MB | HF model card |
| Runtime RSS while active (weights + arena + graph) | ~150-200 MB | aimodels.fyi / matches TS ~150 MB |
| q8 speedup vs FP32 | 1.2-1.5x | HF model card |
| q8 accuracy retention | 95%+ | HF model card |
| Params | 22.7 M | model card |
| Max seq len | 512 tokens | model card |

So the Go/ONNX runtime lands in the same ~150-200 MB band as the TS app -
the model dominates, not the host language.

### Pure-Go MiniLM? (the honest answer)

- **No mature pure-Go path exists.** `clems4ever/all-minilm-l6-v2-go` sounds
  pure-Go but is not: it shells to `onnxruntime_go` and requires
  `libonnxruntime.so` at runtime. Its README shows ~28 commits / ~27 stars
  and notes per-call tensor allocation overhead - usable as a reference, not
  as a production runtime.
- `owulveryck/onnx-go` is a pure-Go ONNX graph executor, but operator
  coverage is limited and the project is effectively unmaintained; running a
  full transformer (LayerNorm, GELU, MatMul, attention) reliably is not
  realistic for production.
- Practical conclusion: for on-device embeddings in Go in mid-2026, ONNX
  Runtime via CGO is the only robust option. This is exactly why Strategy B
  is an opt-in sidecar rather than the base binary.

### Keeping it lightweight

- Lazy-load the session on first `embed` call; tear down after the same
  ~60s idle timer the TS app uses (`time.AfterFunc`).
- Cache the q8 model file under `data/models/` and download it on first use
  (do **not** embed ~23 MB in the binary - keep the install small and pay
  the cost only when semantic search is enabled).
- Run inference in the daemon process, not the short-lived CLI/MCP stdio
  process, so the model stays warm across queries.

---

## 5. MCP SDK maturity in Go

Two real choices; one is now the obvious pick.

### `modelcontextprotocol/go-sdk` - OFFICIAL, RECOMMENDED

- The official Go SDK, maintained in the `modelcontextprotocol` org **in
  collaboration with Google**, and the one featured on
  modelcontextprotocol.io's server quickstart.
- v1.0.0 landed in 2025; current line is **v1.7.0+**, tracking MCP spec
  versions through **2026-07-28**. Apache-2.0 (new contributions).
- Stdio transport: first-class (`mcp.StdioTransport{}` for the server,
  `mcp.CommandTransport` for the client). Also streamable-HTTP and SSE.
- Tool registration: `mcp.AddTool(server, &mcp.Tool{Name:...}, handler)` with
  typed handlers - exactly the one-tool surface sana-mcp needs
  (`meeting_transcripts`).
- This is the long-term-supported path. Use it.

### `mark3labs/mcp-go` - community, mature fallback

- The most popular community SDK (~7.7k stars), feature-complete (stdio /
  SSE / streamable-HTTP, connection-lost handlers), and the de-facto standard
  before the official SDK existed.
- Use only if the official SDK develops a gap you cannot wait for. For a
  one-tool stdio server there is no reason to prefer it in 2026.

For sana-mcp's needs (one tool, stdio, JSON-RPC 2.0) the official `go-sdk`
is a direct, low-risk drop-in.

---

## 6. Daemon spawn, PID liveness, file locks

### Detached spawn (replaces `src/sync/spawn.ts`)

`os/exec.Cmd` with per-OS `SysProcAttr` from `golang.org/x/sys`:

- POSIX (Linux/macOS): set `SysProcAttr{Setpgid: true}` (and `Setsid: true`
  to fully detach from the controlling terminal), point `Stdin` at
  `os.DevNull`, `Stdout`/`Stderr` at the daemon log file, call `Start()`,
  then `cmd.Process.Release()` - **do not `Wait()`** (Wait would block the
  parent until the daemon exits). This reproduces Node's `spawn({detached:
  true})` + `child.unref()`.
- Windows: `SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW |
  windows.DETACHED_PROCESS, HideWindow: true}` (CREATE_NO_WINDOW = 0x08000000)
  reproduces `windowsHide: true`. Use `CREATE_NEW_PROCESS_GROUP` if you also
  want the daemon detached from Ctrl-C signals.

### PID liveness (replaces `src/sync/lock.ts`)

The TS code uses `process.kill(pid, 0)` which Node cross-platforms. Go must
split:

- POSIX: `syscall.Kill(pid, syscall.Signal(0))`; treat `ESRCH` as dead and
  `EPERM` as alive-but-not-ours (same semantics as the TS code).
- Windows: there is no signal 0. Use `windows.OpenProcess` +
  `windows.GetExitCodeProcess` and treat `STILL_ACTIVE (259)` as alive.

The existing SQLite `sync_state` row (PID + heartbeat + 30s staleness) is
retained verbatim; it is the coordination channel between parent and daemon.
The PID check is the authority on liveness, the heartbeat guards against
stale PIDs from a crashed daemon whose PID was reused.

### File locks (a real improvement - the TS app has none)

The TS app relies solely on the DB heartbeat. A real advisory lock is a
clean upgrade:

- `github.com/gofrs/flock` (mature, pure Go via `golang.org/x/sys`) gives
  `flock(2)` on POSIX and `LockFileEx` on Windows from one API. Take an
  exclusive non-blocking lock on `<data_dir>/sana.lock` when the daemon
  starts; release on exit. Two daemons can then never run at once even if
  the DB row lies.
- This closes the only real correctness gap the current design has (PID reuse
  racing the heartbeat).

---

## 7. HTTP client (replaces `src/sana/client.ts` + `cookies.ts`)

All stdlib, no third-party HTTP deps needed:

- `net/http.Client` with a custom `CheckRedirect` returning
  `http.ErrUseLastResponse` so redirects are **not** followed automatically -
  this is how you reproduce the TS "manual redirect chasing" that captures
  cookies set on a 302 mid-flow (the magic-link login). Ingest `Set-Cookie`
  at each hop, re-issue `Cookie` from the jar on the next hop, cap at 5 hops.
- Cookie jar: `net/http/cookiejar` covers the happy path. The TS jar is a
  deliberately simplistic single-domain flat map that treats `deleted`/empty
  as a clear; you can either keep that hand-rolled behaviour (trivial - it is
  ~50 lines) or use `cookiejar` and add the `deleted`/empty-clear rule on
  top.
- Custom header `sana-ai-workspace-id` is a plain `req.Header.Set`.
- tRPC GET (query-string-encoded JSON input) and POST (JSON body) are
  straightforward `http.NewRequestWithContext` calls. `401`/`403` -> raise
  the session-expired error, exactly as today.
- HTTP/1.1 is fine; no websockets anywhere in the protocol.

---

## 8. RAM footprint vs Node

| Configuration | Node (today) | Go (port) |
|---|---|---|
| MCP server idle RSS | ~50-90 MB (V8 + runtime) | ~10-25 MB |
| Daemon idle RSS | ~60-100 MB | ~15-30 MB |
| With q8 model active | ~150-200 MB | ~150-200 MB (model dominates) |
| Model unloaded (idle, semantic on) | back to baseline | back to baseline |

Go cuts the idle/baseline footprint roughly 3-5x. When the model is loaded
both languages land in the same band because the ONNX weights and arena
dominate. The big practical win is the MCP server process (the one an agent
spawns): ~15 MB Go vs ~70 MB Node, with the same fast cold start.

## 9. Binary size and packaging

- Base pure-Go binary (cobra + modernc.org/sqlite + go-sdk + HTTP + daemon):
  roughly **10-18 MB** stripped. The modernc SQLite transpile accounts for a
  few MB of that; the MCP SDK and cobra are small.
- `upx --best` can shave that further (optional; some AV heuristics flag
  UPX-packed binaries on Windows, so test before committing).
- With embeddings in-binary (Strategy B): add the ONNX Runtime shared lib
  (~5-10 MB) if bundled; keep the ~23 MB q8 model on disk, not in the binary.
- Installers: a ~30-line `install.sh` and `install.ps1` that resolve the
  caller's `GOOS/GOARCH`, fetch the matching asset from GitHub Releases, and
  drop it on `PATH`. `curl | sh` and `irm | iex` both work.

---

## 10. Migration mapping (TS source -> Go)

| TS file | Go responsibility |
|---|---|
| `src/store/db.ts` | `modernc.org/sqlite` store package; same schema, same SQL |
| `src/semantic/semantic.ts` | optional `embed` package behind a build tag; `modernc.org/sqlite/vec` for storage |
| `src/sana/client.ts`, `cookies.ts` | `net/http` + custom `CheckRedirect` + jar |
| `src/mcp.ts`, `src/tools/*` | `modelcontextprotocol/go-sdk`, one `AddTool` |
| `src/cli.ts` | cobra subcommands + positional JSON arg |
| `src/sync/spawn.ts` | `os/exec` + per-OS `SysProcAttr` |
| `src/sync/lock.ts` | `syscall.Kill(0)` / `GetExitCodeProcess` + `gofrs/flock` |
| `src/sync/daemon.ts` | goroutine loop with `time.Ticker`, signal handling via `os/signal` |
| `src/daemon-main.ts` | same binary, `sana daemon` subcommand |

---

## 11. Top 3 risks / blockers

1. **Embeddings force CGO and break the pure-Go one-binary story (highest
   risk).** If on-device MiniLM must live in the main binary, you reintroduce
   CGO + per-target ONNX Runtime shared libs + a real cross-compile toolchain
   (`zig cc` or native runners), which costs you most of the packaging win.
   **Mitigation:** keep embeddings as an optional `sana embed` sidecar (or
   `-tags embeddings` build). The base binary the installer fetches stays
   pure-Go; semantic search is opt-in, exactly as it is in the TS app today.
   This is the single most important architectural decision in the port.

2. **`modernc.org/sqlite/vec` is young (~4 months old as of July 2026).** It
   is the real sqlite-vec transpiled, and the app's `vec0` schema and KNN
   queries map onto it directly, but its production track record is shorter
   than mattn's. **Mitigation:** pin v1.54.0, write a small integration test
   that exercises the exact `vec0(float[384] + metadata, MATCH, k=, ORDER BY
   distance)` path against real transcript vectors, and keep the
   mattn+CGO+`sqlite-vec-go-bindings/cgo` path as a documented fallback that
   only needs a build-tag swap.

3. **Windows daemon lifecycle (detached spawn + PID liveness).** No
   `signal 0` on Windows means liveness must use `OpenProcess` +
   `GetExitCodeProcess` (STILL_ACTIVE = 259), and detached hidden-window
   spawn needs the right `CreationFlags`. This is well-trodden territory
   (`golang.org/x/sys/windows` covers it), but it is the area most likely to
   throw a platform-specific surprise during testing. **Mitigation:** a
   dedicated Windows runner in CI that actually starts the daemon, checks the
   PID, and kills it.

Secondary (non-blocking) notes:

- modernc write performance under heavy contention is lower than mattn; not a
  real concern for this read-mostly, periodic-sync workload, but benchmark
  the backfill path.
- The Feb 2026 "re-prepares statements" modernc report - pin the version and
  re-check if you see unexpected CPU on the daemon.
- A pure-Go BERT/WordPiece tokenizer for MiniLM is required for the embed
  path; `sugarme/tokenizer` (or the vendored fork in `clems4ever/...`) works
  but is itself low-star - validate token IDs against the reference
  Transformers.js output before trusting embeddings.

---

## 12. Recommended architecture in one paragraph

Build the base binary with `CGO_ENABLED=0` on `modernc.org/sqlite` (+ `/vec`
blank import) for storage/FTS5/vec0, stdlib `net/http` with a manual
`CheckRedirect` for the Sana tRPC client, `modelcontextprotocol/go-sdk` for
the one-tool stdio MCP server, cobra for the CLI, and `os/exec` + `gofrs/
flock` + `syscall.Kill`/`GetExitCodeProcess` for the daemon and its liveness
check. Cross-compile all six OS/arch targets from one Linux host via a
GitHub Actions matrix and ship them as GitHub Releases assets behind
`curl | sh` and `irm | iex`. Keep on-device embeddings (q8 MiniLM via
`onnxruntime_go`) in a separate opt-in sidecar built with `CGO_ENABLED=1`,
so the default install is a single pure-Go binary of ~10-18 MB with a
~15 MB idle RSS, and users who want hybrid semantic search opt in
explicitly - preserving the exact optionality the app already has.
