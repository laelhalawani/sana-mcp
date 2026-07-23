# sana-mcp Bun Port - Technical Feasibility Study

Status: July 2026. All runtime versions, target lists, and behavior claims
were web-verified this month against bun.com/docs, the Bun GitHub releases
and issues, and the transformers.js / sqlite-vec upstream sources. Nothing
here is taken from memory - Bun moves fast and several old caveats
(macOS loadExtension segfault, no cross-compile, no .node embedding) have
since been fixed.

Goal: same as the Go and Rust studies - replace the
`git clone && npm install && npm run build && node dist/mcp.js` flow with a
single self-contained binary installed by `curl <url> | sh` (Linux/macOS)
and `irm <url> | iex` (Windows). The appeal of Bun specifically: **keep the
existing TypeScript codebase** and compile it, instead of rewriting in Go or
Rust. This study evaluates whether that low-effort path actually reaches the
one-binary, all-six-targets goal, and how it compares to the Go baseline
(documented in `go-port.md`, ~10-18 MB binary, recommended) and the Rust
baseline (`rust-port.md`, ~8-15 MB).

---

## TL;DR / verdict

**CONDITIONAL GO - the lowest-effort path, at the cost of binary size.**
Bun can ship sana-mcp as a single `curl | sh`-installed binary across all
six OS/arch targets from one free GitHub Actions Linux runner, with **no
rewrite** - only a mechanical swap of `better-sqlite3` for the built-in
`bun:sqlite` and dropping the dead `playwright` dependency. That is days of
work, versus weeks for the Go/Rust ports.

The catch is size: a compiled Bun binary is **~55-95 MB** (the whole Bun
runtime is embedded), roughly **4-6x larger than Go** (~10-18 MB) and
**~6-10x larger than Rust** (~8-15 MB). For a CLI that an MCP host spawns,
that is a real but not disqualifying cost - many popular CLIs ship in this
range. Runtime idle RSS (~30-60 MB) beats Node (~50-90 MB) but loses to Go
(~15-30 MB).

The base app (MCP/stdio + SQLite + FTS5 + Sana HTTP client + CLI + daemon)
compiles with **zero native dependencies**. The two optional features
(sqlite-vec vectors and on-device MiniLM embeddings) need the same
opt-in sidecar treatment the Go study recommends - they do not block the
default install.

If minimizing effort is the top priority, Bun wins. If minimizing binary
size / footprint is the top priority, Go remains the recommendation.

---

## 1. Bun version and compile overview (July 2026)

- Latest stable: **Bun 1.3.14**, released **May 13 2026** (per the GitHub
  releases feed and endoflife.date, last updated July 19 2026). The 1.3
  series is described as Bun's biggest release yet (unified SQL API, Redis
  client, package catalogs, async stack traces).
- `bun build --compile` produces a **single self-contained executable** with
  the Bun runtime embedded. Relevant flags:
  - `--target=<target>` - cross-compile to another OS/arch from one host.
  - `--minify` - shrinks the transpiled app code (megabytes on large apps).
  - `--bytecode` - moves JavaScriptCore parsing to build time, speeds cold
    start (does not obscure source).
  - `--sourcemap` - embeds a zstd-compressed sourcemap for real stack
    traces. Production combo: `--minify --sourcemap --bytecode`.
  - `--windows-icon`, `--windows-hide-console` - Windows-only polish (not
    usable when cross-compiling from non-Windows, per docs).
- Asset embedding: files imported with `with { type: "file" }` are embedded
  and surfaced via `Bun.file()` / Node `fs` APIs. `.node` native addons can
  also be embedded (see section 3).

### 1.1 Cross-compile targets (verified from bun.com/docs/bundler/executables)

All six sana-mcp targets have a `--target` string:

| Target string | OS | Arch | Libc | Notes |
|---|---|---|---|---|
| `bun-linux-x64` | Linux | x64 | glibc | default; `-baseline` / `-modern` variants for pre-2013 vs AVX2 CPUs |
| `bun-linux-arm64` | Linux | arm64 | glibc | no baseline/modern split |
| `bun-linux-x64-musl` | Linux | x64 | musl | Alpine / distroless |
| `bun-linux-arm64-musl` | Linux | arm64 | musl | Alpine / distroless |
| `bun-darwin-x64` | macOS | Intel | - | `-baseline` variant exists |
| `bun-darwin-arm64` | macOS | Apple Silicon | - | the common Mac case |
| `bun-windows-x64` | Windows | x64 | - | `-baseline` / `-modern` variants |
| `bun-windows-arm64` | Windows | arm64 | - | see warning below |

(The `-baseline` x64 variants target Nehalem-class CPUs without AVX2 and
avoid "Illegal instruction" crashes on old hardware. ARM64 targets have no
baseline/modern distinction.)

**Target segments can appear in any order** as long as they are `-`-
delimited, so `bun-linux-x64`, `bun-x64-linux`, etc. are all accepted.

### 1.2 The one target to verify in CI: `bun-windows-arm64`

`bun-windows-arm64` **is listed in the official target table** and there are
real GitHub Actions workflows that produce Windows ARM64 executables with
it (e.g. the `plannotator` repo). However it is the least battle-tested
target: Bun issue #25346 tracks cross-compile cache bugs specifically
affecting `--target=bun-windows-arm64`, and several community compatibility
matrices mark it as a known gap with workarounds like "use an x64 Windows
runner". None of Linux-x64, Linux-arm64, macOS-x64, macOS-arm64, or
Windows-x64 have this cloud over them.

**Action:** emit `bun-windows-arm64` from the Linux runner like the others,
but add a native windows-arm64 GitHub Actions runner as a fallback that
builds without `--target` (compiling on-host) if the cross-compiled artifact
is buggy. Windows ARM64 is a small minority of installs, so a best-effort
target plus a fallback is acceptable.

### 1.3 Binary size - the headline cost

The Bun runtime is embedded whole, so the floor is large regardless of app
size. Verified data points:

| Source | Reported size |
|---|---|
| Bun "hello world" compiled (recent HN thread) | ~58 MB |
| Bun "hello world" compiled (issue #5854) | ~91 MB |
| Real cross-compile to macOS (mamezou blog) | ~51 MB |
| Bun runtime itself (uncompressed) | ~88 MB |

The docs themselves acknowledge: "Bun's binary is still way too big and we
need to make it smaller." `--minify --bytecode` trim the **app** portion
(useful for a large bundle) but cannot shrink the runtime floor.

**Expected sana-mcp compiled size: ~55-95 MB** per target. By contrast the
Go base binary is ~10-18 MB and Rust ~8-15 MB. For a `curl | sh` install
this means a ~60 MB download; acceptable but visibly heavier than the Go
alternative.

---

## 2. Native dependencies under `--compile` - the crux

This is what determines whether the "keep the TS code" pitch holds. sana-mcp
has four native-ish dependencies today: `better-sqlite3`, `sqlite-vec`,
`@huggingface/transformers` (ONNX Runtime), and `playwright`. They sort
cleanly into "drop", "swap for built-in", and "ship alongside".

### 2.1 `better-sqlite3` -> `bun:sqlite` (SWAP, mechanical) - the win

`better-sqlite3` is a Node-API C++ native addon - exactly the class of
dependency that is awkward under `--compile`. Bun ships a **built-in**
`bun:sqlite` (JavaScriptCore bindings to a bundled SQLite, no native addon to
bundle). Dropping `better-sqlite3` for `bun:sqlite` removes the only hard
native dep from the base app.

Feature parity for sana-mcp's exact usage:

| Feature used in `src/store/db.ts` | `better-sqlite3` | `bun:sqlite` (Jul 2026) |
|---|---|---|
| WAL, `busy_timeout` via `pragma()` | yes | yes - but via `db.run("PRAGMA ...")` (no `.pragma()` helper) |
| `CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='unicode61 remove_diacritics 2')` | yes | **yes - FTS5 is compiled in** (confirmed by Bun's creator; bundled SQLite enables it) |
| `bm25(line_fts)` ranking | yes | yes |
| `prepare().run/.get/.all` with named `@param` params | yes | yes (`@`, `$`, `:` prefixes all accepted) |
| `db.transaction(fn)` + `.deferred/.immediate/.exclusive` | yes | yes (identical API; nested -> savepoints) |
| BigInt binding (for `vec0` `line_no`/`created_at`) | yes | yes (native BigInt support) |
| `db.loadExtension(...)` | n/a (used via sqlite-vec JS loader) | **yes on all platforms** since Bun >=1.3.4 (see 2.2) |
| `.get()` return on no row | `undefined` | `null` |

The port is **mechanical**. Concrete edits in `src/store/db.ts`:

1. `import Database from "better-sqlite3";` ->
   `import { Database } from "bun:sqlite";`.
2. `this.db.pragma("journal_mode = WAL");` ->
   `this.db.run("PRAGMA journal_mode = WAL;");` (and the `busy_timeout` line
   similarly). `PRAGMA table_info(...)` is already done through
   `.prepare().all()` so it is unaffected.
3. `readonly db: Database.Database;` -> `readonly db: Database;` (the
   better-sqlite3 type-namespace trick is not needed; `bun:sqlite` exports
   the `Database` class directly).
4. Audit `.get()` consumers for `undefined` vs `null` (`src/semantic/semantic.ts`
   uses `import type Database from "better-sqlite3"` only as a type - swap to
   `import type { Database } from "bun:sqlite"`). The hand-written
   `if (row)` / `?? null` checks mostly keep working; TypeScript may need
   the return types loosened from `... | undefined` to `... | null`.

Everything else - the schema, the FTS5 `MATCH` queries, the `bm25()` ordering,
the `vec0` virtual tables, the transaction wrappers - is plain SQL that runs
unchanged.

### 2.2 sqlite-vec - load via `db.loadExtension`, works on all platforms now

The `vec0` extension is loaded today by the `sqlite-vec` npm package's JS
loader (`sqliteVec.load(db)`). Under `bun:sqlite` the equivalent is
`db.loadExtension("/abs/path/to/sqlitevec")`, pointing at the platform's
extension binary (`.so` / `.dylib` / `.dll`).

**The macOS blocker is fixed.** Historically Bun on macOS used Apple's
system SQLite, which is built with `SQLITE_OMIT_LOAD_EXTENSION`, so
`loadExtension` segfaulted (issue #5756). During the 1.3.x cycle, PR #31249
**statically links Bun's bundled SQLite on every platform** (fixing issue
#31247). As of Bun >=1.3.4 (current is 1.3.14) `loadExtension()` works on
macOS, Linux, and Windows by default - no `Database.setCustomSQLite` needed.
(The official `loadExtension` reference page still carries the old macOS
warning; it is stale. The behavior change is in the static-linking PR.)

Two ways to ship the extension file:

- **Embed + extract (single-binary preserving):** import the extension with
  `with { type: "file" }`, write it to a temp path at runtime, call
  `db.loadExtension(tempPath)`. Because each target is compiled separately,
  you embed only the extension matching that target. This keeps the default
  experience one-file.
- **Ship alongside:** place `sqlitevec-<os>-<arch>.{so,dylib,dll}` next to
  the binary and locate it at runtime. Simpler, but breaks the "single file"
  property for users who opt into semantic search.

sqlite-vec is a single C file, no transitive native deps, so either path is
clean. And because sana-mcp already gates all of this behind
`SANA_SEMANTIC=1` (the `vec0` table is created lazily in `ensureVec()`),
users who never enable semantic search never trigger the extension load.

### 2.3 `@huggingface/transformers` / ONNX Runtime - runs on Bun, WASM is the clean path

Transformers.js **v4 officially supports Bun** (the v4 announcement names
Node, Bun, and Deno). The lazy HF model download and the q8 MiniLM pipeline
work at runtime under a compiled binary exactly as they do under Node,
because they are just `fetch` + `fs` writes + inference - none of that is
affected by bundling.

The subtlety is the ONNX Runtime backend:

- By default in Node-like environments, Transformers.js uses
  **`onnxruntime-node`** (a Node-API native addon that itself dynamically
  loads `libonnxruntime.{so,dylib,dll}`). Bun now **can embed `.node` files
  into a `--compile`d executable** (docs: "You can embed `.node` files into
  executables"; caveat: `node-pre-gyp`-style addons must be `require`d
  directly). But `onnxruntime-node`'s addon also needs its shared libs on
  disk at runtime, which is fiddly to wire through `--compile`.
- **The WASM backend (`onnxruntime-web`) avoids native deps entirely** - no
  `.node`, no shared libs, pure WASM. It bundles into the binary cleanly.
  CPU inference is slower than the native backend, but for a background
  indexer embedding transcript lines in batches with a ~60s idle-unload, the
  speed difference is acceptable (MiniLM-L6-v2 q8 is a 22.7 M-param model;
  WASM throughput is fine for this scale).

**Recommended:** under `--compile`, force Transformers.js to the WASM backend
(via `env.backends.onnx.wasm` config) so the embeddings path stays
native-debt-free. Users who want maximum speed can run the non-compiled
`bun` version with `onnxruntime-node`. This mirrors the Go study's
"embeddings are an opt-in sidecar" conclusion - keep the base binary clean.

Note on WASM bundle size: a v4 pre-release issue (transformers.js #1521)
flagged that the ORT WASM bundle grew past 25 MB. That is bundled into your
binary at compile time and is part of why the binary is large - but only if
you include the embeddings code path. Because the model weights themselves
are **downloaded lazily to `data/models/`** (see section 4), they do not
bloat the binary.

### 2.4 `playwright` - DROP (confirmed dead code)

`grep` confirms `playwright` is imported only in `src/browser.ts`, and
**nothing in `src/` imports `browser.ts`**. Its only callers are dev
scripts under `scripts/` (`investigate.mjs`, `record.mjs`, `validate.mjs`,
`bootstrap-session.mjs`, `paginate.mjs`). The live login path does not use
it. Remove `playwright` from `dependencies` (keep it as a devDependency or
in a separate `package.json` for the dev scripts). This removes a large,
browser-binary-heavy dependency that would otherwise severely complicate
`--compile`.

---

## 3. Lazy model download under `--compile` - works unchanged

The existing flow in `src/semantic/semantic.ts`:

- `env.cacheDir = MODELS_DIR;` (`data/models/` under the data dir)
- `env.allowRemoteModels = true;`
- `pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" })` fetches
  from HuggingFace on first use and caches on disk.

None of this is bundling-related. A `--compile`d binary can still:

1. Resolve a writable data dir at runtime (the user's `~/.sana/` or platform
   equivalent - the same logic `config.ts` already uses, just re-pointed to
   survive being run from anywhere).
2. Fetch model files over HTTPS at runtime.
3. Write them under the data dir and re-use them on subsequent runs.

So the lazy download survives `--compile` with **no code change** beyond
making sure `DATA_DIR` resolves to a user-writable location that does not
assume the binary's install directory. The model weights (q8 ~23 MB, fp32
~90 MB) stay out of the binary, exactly as the Go study recommends.

---

## 4. Footprint - binary size and RSS

### 4.1 Compiled binary size

| Build | Binary size |
|---|---|
| **Bun** (sana-mcp base, estimated) | **~55-95 MB** |
| of which: Bun runtime floor | ~50-90 MB |
| of which: app code (minified + bytecode) | a few MB |
| Go base (from `go-port.md`, Strategy A) | ~10-18 MB |
| Rust base (from `rust-port.md`) | ~8-15 MB |
| Node today | n/a (not a single binary) |

Bun is ~4-6x larger than Go and ~6-10x larger than Rust. The entire Bun
runtime (JavaScriptCore + built-in SQLite + bundler + package manager code
paths) is embedded whether or not you use those features. `--minify` and
`--bytecode` help the app slice but cannot touch the runtime floor.

### 4.2 Runtime RSS

| Configuration | Node (today) | Bun (compiled) | Go (port) |
|---|---|---|---|
| MCP server idle | ~50-90 MB | **~30-60 MB** | ~10-25 MB |
| Daemon idle | ~60-100 MB | ~40-70 MB | ~15-30 MB |
| With q8 MiniLM active | ~150-200 MB | ~150-200 MB | ~150-200 MB |
| Model unloaded (semantic on, idle) | back to baseline | back to baseline | back to baseline |

Bun's JavaScriptCore is lighter than Node's V8, so idle RSS drops versus
today. It is still 2-3x heavier than Go's idle footprint because a JS
runtime + GC is in memory. When the model is loaded the ONNX weights
dominate and all three languages converge in the ~150-200 MB band.

**Practical impact:** the process an MCP host actually spawns is the stdio
MCP server. ~40 MB (Bun) vs ~70 MB (Node today) vs ~15 MB (Go). Bun is a
clear win over the status quo; Go is a further win over Bun.

---

## 5. Migration mapping (TS source -> change needed)

| TS file | Change for Bun compile |
|---|---|
| `src/store/db.ts` | Swap `better-sqlite3` import for `bun:sqlite`; `.pragma()` -> `db.run("PRAGMA ...")`; `Database.Database` type -> `Database`; audit `.get()` null vs undefined. SQL, FTS5, transactions unchanged. |
| `src/semantic/semantic.ts` | Type import swap; force Transformers.js WASM backend under compile; `db.loadExtension` for sqlite-vec (was `sqliteVec.load(db)`). Logic unchanged. |
| `src/browser.ts` | Delete from runtime path (dead code). |
| `src/sana/client.ts`, `cookies.ts` | None. `fetch` + manual redirects + cookie jar are pure TS and run unchanged on Bun. |
| `src/mcp.ts`, `src/tools/*` | None. `@modelcontextprotocol/sdk` works on Bun. |
| `src/cli.ts` | None. `commander` works on Bun. |
| `src/sync/spawn.ts`, `lock.ts`, `daemon.ts` | None. `child_process.spawn({detached:true})` + `unref()`, `process.kill(pid, 0)`, SQLite heartbeat - all standard, all work on Bun. |
| `src/config.ts` | Re-point `DATA_DIR` to a user-writable location independent of the binary's install path (so a compiled binary run from `/usr/local/bin` still finds `~/.sana/`). |
| `package.json` | Remove `playwright` and `better-sqlite3` from `dependencies`; move `@huggingface/transformers` + `sqlite-vec` to optional. Add Bun compile scripts. |

The total diff is small - mostly one file (`db.ts`) plus config/dependency
housekeeping. No module of the runtime surface needs rewriting.

---

## 6. CI and packaging (free, one runner)

A single GitHub Actions job on an `ubuntu-latest` runner produces all six
targets via a matrix:

```yaml
strategy:
  matrix:
    target:
      - bun-linux-x64
      - bun-linux-arm64
      - bun-darwin-x64
      - bun-darwin-arm64
      - bun-windows-x64
      - bun-windows-arm64
steps:
  - uses: oven-sh/setup-bun@v1
    with: { bun-version: 1.3.14 }
  - run: bun install --production
  - run: bun build src/cli.ts --compile --minify --bytecode --sourcemap
         --target=${{ matrix.target }} --outfile sana-${{ matrix.target }}
  - uses: softprops/action-gh-release@v2
```

Plus an optional `bun-linux-arm64-musl` (and `bun-linux-x64-musl`) for
Alpine users, and a native windows-arm64 fallback job that builds without
`--target` (compiling on-host) in case the cross-compiled arm64 artifact
hits issue #25346.

Installers are the same ~30-line `install.sh` / `install.ps1` described in
`go-port.md`: detect OS/arch, fetch the matching asset from GitHub Releases,
drop on `PATH`. `curl <url> | sh` and `irm <url> | iex` both work. No C
toolchain, no per-target build environment - cross-compile handles it.

---

## 7. Top risks / downsides

1. **Binary size (~55-95 MB) - the single biggest downside.** The full Bun
   runtime is embedded. This is 4-6x Go and 6-10x Rust, and there is no way
   to strip the runtime floor (`--minify --bytecode` only shrink app code).
   For users on slow connections or small VMs this is noticeable. The Bun
   team acknowledges the size and is working on it, but as of 1.3.14 it is
   still the reality. **Mitigation:** none within Bun; if size is
   disqualifying, choose Go/Rust.

2. **`bun-windows-arm64` cross-compile is the least reliable target.** It is
   in the official target list and works in some real CI workflows, but
   issue #25346 and several community matrices flag it as buggy. The other
   five targets are solid. **Mitigation:** ship it from the Linux runner but
   keep a native windows-arm64 fallback runner; arm64 Windows is a small
   share of installs.

3. **ONNX Runtime native backend is awkward under `--compile`.** Embedding
   `.node` files is now supported, but `onnxruntime-node` also dynamically
   loads shared libs that do not embed cleanly. **Mitigation:** force the
   WASM backend for the compiled embeddings path (slower CPU inference,
   zero native debt), or keep embeddings as an opt-in non-compiled sidecar -
   the same conclusion the Go study reaches.

4. **Bun is a younger runtime than Node/Go/Rust.** 1.3.x is stable and
   production-used, but the platform still ships behavior changes between
   minor versions (e.g. the static-SQLite flip mid-1.3.x). **Mitigation:**
   pin the Bun version in CI and in `setup-bun`; re-verify on each bump.

5. **Less of a footprint win than Go.** Idle RSS (~30-60 MB) beats Node but
   loses to Go (~15-30 MB). If the MCP host is sensitive to per-spawned-
   process memory, Go is better. For typical agent hosts this is not a
   deciding factor.

Secondary (non-blocking):

- macOS WAL behavior: Bun's macOS SQLite now uses the static build, so the
  old "Apple system SQLite" quirks (persistent `-wal`/`-shm`) no longer
  apply once you are on 1.3.4+.
- `db.run("PRAGMA ...")` is mildly less ergonomic than `db.pragma()`, but
  the migration is a search-and-replace.

---

## 8. Where Bun sits vs Go and Rust for sana-mcp's goals

sana-mcp's stated goals, ranked: (1) single one-command binary across all
six targets, (2) optional lightweight embeddings, (3) low effort.

| Goal | Bun | Go (`go-port.md`) | Rust (`rust-port.md`) |
|---|---|---|---|
| Single `curl \| sh` / `irm \| iex` binary | yes | yes | yes |
| All 6 OS/arch targets from one Linux runner | yes (windows-arm64 least reliable) | yes (trivial, `CGO_ENABLED=0`) | yes |
| Default base binary has zero native deps | yes (`bun:sqlite` + drop playwright) | yes (modernc pure-Go) | yes (rusqlite bundled) |
| sqlite-vec (optional semantic) | `loadExtension`, embed+extract | blank import, pure-Go | load_extension, bundled |
| On-device MiniLM (optional semantic) | WASM backend, or sidecar | CGO sidecar (onnxruntime_go) | ort crate sidecar |
| **Binary size (base)** | **~55-95 MB** | ~10-18 MB | ~8-15 MB |
| Idle RSS (MCP server) | ~30-60 MB | ~10-25 MB | ~10-25 MB |
| RSS with model active | ~150-200 MB | ~150-200 MB | ~150-200 MB |
| Code reuse from existing TS | **~95% - mechanical edits** | 0% (full rewrite) | 0% (full rewrite) |
| Estimated effort to ship | **days** | weeks | weeks |
| Runtime maturity (July 2026) | young-but-stable (1.3.14) | very mature | mature |

### Single biggest advantage: effort

Bun reuses the entire TypeScript codebase. The only substantive code edit is
the `better-sqlite3` -> `bun:sqlite` swap in `src/store/db.ts` (mechanical),
plus deleting the dead `playwright` import and re-pointing `DATA_DIR`. The
MCP server, the Sana tRPC client, the daemon, the CLI, the SQL schema, FTS5
queries, and the embeddings pipeline all carry over verbatim. Go and Rust
require rewriting every one of those modules from scratch.

### Single biggest downside: binary size

~55-95 MB is 4-6x Go and there is no workaround within Bun. The Bun runtime
floor is the floor. If the deployment context is sensitive to download size
or disk footprint (small CI runners, slow networks, embedded hosts), this
weighs heavily. For a typical developer-machine install it is merely a
noticeable-but-acceptable cost.

### Is it the lowest-risk fastest path?

**Yes - if effort is the dominant axis and binary size is acceptable.** Bun
is unambiguously the fastest path to a one-command binary across all six
targets, with the lowest rewrite risk, because it preserves the codebase.
The base app compiles with zero native dependencies once `better-sqlite3` is
swapped and `playwright` dropped, and the two optional features map onto
clean sidecar / WASM patterns.

**No - if binary size or minimum idle RSS is the dominant axis.** Go remains
the recommendation when the ~10-18 MB binary and ~15 MB idle RSS matter more
than rewriting. Go also has the cleanest sqlite-vec story (native pure-Go
transpile, no extension file to ship) and the most battle-tested
cross-compiler.

**Pragmatic split:** if the team wants to ship the binary experience quickly
and defer the rewrite, Bun is a legitimate 1.0. A future Go/Rust port can
later shrink the binary 4-6x without changing the user-facing install story,
so Bun does not paint the project into a corner.

---

## Sources (verified July 2026)

- Bun official docs - single-file executables: https://bun.com/docs/bundler/executables
- Bun official docs - `bun:sqlite`: https://bun.com/docs/runtime/sqlite
- Bun `Database.loadExtension` reference: https://bun.com/reference/bun/sqlite/Database/loadExtension
- Bun GitHub releases (v1.3.14, May 13 2026): https://github.com/oven-sh/bun/releases
- Bun issue #31247 + PR #31249 - static SQLite on every platform (fixes macOS
  `loadExtension`): https://github.com/oven-sh/bun/issues/31247
- Bun issue #5756 - historical macOS `loadExtension` segfault (resolved by
  the above): https://github.com/oven-sh/bun/issues/5756
- Bun issue #5854 - binary size ("91 MB hello world"): https://github.com/oven-sh/bun/issues/5854
- Bun issue #15374 - `.node` embedding under `--compile` (now supported per
  docs): https://github.com/oven-sh/bun/issues/15374
- Bun issue #25346 - `bun-windows-arm64` cross-compile bugs:
  https://github.com/oven-sh/bun/issues/25346
- Bun issue #3473 - cross-compilation tracking: https://github.com/oven-sh/bun/issues/3473
- Bun v1.1.5 blog - Windows ARM64 + cross-compile introduction:
  https://bun.com/blog/bun-v1.1.5
- FTS5 in `bun:sqlite` (Jarred Sumner confirmation):
  https://x.com/jarredsumner/status/1673856130853011456
- Transformers.js v4 announcement (Bun support):
  https://huggingface.co/blog/transformersjs-v4
- Transformers.js ONNX backend docs (onnxruntime-node default):
  https://huggingface.co/docs/transformers.js/en/api/backends/onnx
- sqlite-vec Bun example: https://github.com/asg017/sqlite-vec/blob/main/examples/simple-bun/demo.ts
- sqlite.org FTS5 reference: https://www.sqlite.org/fts5.html
- endoflife.date - Bun (1.3.14 current): https://endoflife.date/bun
