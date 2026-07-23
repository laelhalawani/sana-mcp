# sana-mcp - Rust port feasibility study

Goal: decide whether to port sana-mcp from TypeScript/Node to Rust so it ships
as a single self-contained binary installable with `curl <url> | sh` (Linux /
macOS) and `irm <url> | iex` (Windows PowerShell), replacing the current
`git clone && npm install && npm run build && node dist/mcp.js` flow.

Researched and written 2026-07-23. All crate versions were verified against
crates.io / lib.rs / docs.rs / GitHub in July 2026 - do not trust older memory.
Use hyphens, not em/en dashes, in all code and docs in this repo.

The current app surface this port must cover (from a full read of `src/`):

- One binary, three runtime roles: MCP server on stdio (JSON-RPC 2.0), CLI
  (subcommands + flags + optional JSON arg), and a detached background daemon.
- HTTPS to `https://sana.ai/x-api/trpc/<proc>`: JSON GET (query-string input)
  and POST (JSON body). Cookie auth (`sana-ai-session` + CSRF), custom header
  `sana-ai-workspace-id`, and **manual** HTTP-redirect chasing so cookies set
  on a 302 mid-flow (the magic-link login) are captured.
- SQLite (WAL, busy_timeout, transactions) with **FTS5** (BM25,
  `tokenize='unicode61 remove_diacritics 2'`, phrase/AND matching).
- **sqlite-vec** virtual table `vec0`, KNN over `float[384]` with metadata
  columns and distance ordering. Optional, gated by `SANA_SEMANTIC=1`.
- On-device embeddings (`all-MiniLM-L6-v2`, 384-dim, quantized q8). Lazy-loaded,
  unloaded after ~60s idle, ~150MB while active. **Must stay optional** so a
  base install pays no model cost.
- Daemon coordination via a `sync_state` SQLite row (PID + heartbeat); liveness
  = signal-0 on the PID. No file lock today.

---

## 1. Verdict up front

**Conditional GO.** Every line item has a mature Rust crate and permissive
license. The only thing that breaks the strict "one file on disk" promise is
ONNX Runtime (no official static lib), and that is already an **optional**
feature. Keep embeddings opt-in, lazy-download the ONNX Runtime shared lib and
the model into the data dir on first semantic use, and the base `curl | sh`
binary stays single-file at ~8-15MB. The single biggest risk is the
cross-compile CI matrix for the bundled C components (SQLite, sqlite-vec, TLS)
across 6 targets - solvable, but it is real engineering work. Detail below.

---

## 2. Crate-by-crate mapping

All licenses are permissive (MIT and/or Apache-2.0). No license blocker.

| Concern | Crate | Version (Jul 2026) | License | Maturity |
|---|---|---|---|---|
| HTTP client | `reqwest` | 0.13.4 | MIT/Apache-2.0 | Battle-tested, default pick |
| TLS | `rustls` (via reqwest `rustls`, default) | bundled | Apache-2.0/ISC+MIT | Standard |
| Cookie jar | `cookie_store` 0.22 + `cookie` 0.18 (via reqwest `cookies`) | 0.22 / 0.18 | MIT/Apache-2.0 | Solid |
| SQLite + FTS5 | `rusqlite` (`bundled`) | 0.40.1 | MIT | Standard, very mature |
| Vector search | `sqlite-vec` | 0.1.9 | MIT OR Apache-2.0 | Pre-v1, "expect breaking changes" |
| Embeddings / LM runtime | `ort` | 2.0.0-rc.12 | MIT OR Apache-2.0 | Widely used (1.2k crates); wraps ONNX Runtime 1.24 |
| MCP SDK | `rmcp` (official) | 2.2.0 stable (3.0.0-beta.1) | Apache-2.0 | Official SDK, 3.4M downloads/month |
| CLI parsing | `clap` (derive) | 4.6.4 | MIT OR Apache-2.0 | Standard |
| Async runtime | `tokio` | current 1.x | MIT | Required by reqwest + rmcp |
| Daemon spawn | `std::process::Command` | std | - | Built-in |
| PID liveness | `libc` (Unix) / `windows-sys` | current | MIT/Apache-2.0 | Built-in FFI |
| File locks | `fs4` or `fd-lock` | current | MIT | Optional improvement |

### 2.1 HTTP client, cookie jar, manual redirects (`reqwest` 0.13.4)

The current TS code calls `fetch(..., { redirect: "manual" })`, ingests
`Set-Cookie` (`getSetCookie()`), treats `deleted`/empty as a clear, then
re-issues with a manual `cookie:` header - all to capture cookies set on a 302
during magic-link login. This maps cleanly:

- TLS: `reqwest` uses **rustls by default** (`rustls` is a default feature).
  No native-tls/OpenSSL dependency required, which is what makes a static
  single binary realistic.
- Cookies: enable the `cookies` feature. It pulls in `cookie_store` 0.22 and
  `cookie` 0.18. You can pass an `Arc<cookie_store::CookieStore>` (behind the
  `CookieStore` trait) to the `ClientBuilder` so the jar is shared across
  requests and persists.
- **Per-redirect cookie capture**: two equally good paths.
  1. Set `ClientBuilder::redirect(redirect::Policy::none())` and chase
     redirects by hand in a loop (read `set-cookie` from each response, store
     it, resend `cookie`). This is a 1:1 port of the existing `raw()` method.
  2. Use `redirect::Policy::custom(...)` and inspect each intermediate
     response; reqwest writes to the shared jar at every hop.
  Either gives you the mid-redirect Set-Cookie capture you need. The `deleted`
  / empty-value clear semantics fit naturally in a custom `CookieStore` impl or
  a tiny manual jar (the current code already ignores path/expiry, so a flat
  map works - you can skip `cookie_store` and reuse the same minimal approach).
- `sana-ai-workspace-id` header and the `accept: application/json` default are
  trivial `.header()` calls.

Gotchas:
- reqwest 0.13 switched its redirect engine to `tower-http`'s `follow-redirect`
  (`+follow-redirect` feature on the dependency). Custom policies still work,
  but double-check behavior on 0.13.x if you rely on seeing every hop's
  headers - the `Policy::none()` + manual loop path is the safest because it
  never depends on reqwest's redirect internals.
- reqwest needs `tokio`. There is no way around an async runtime here because
  rmcp's stdio transport is also tokio-based. tokio it is.
- For a single static binary, pin `default-features = false` and add exactly
  `["rustls-tls", "json", "cookies", "http2"]` (drop native-tls, gzip/brotli
  unless wanted) to keep the size down and avoid OpenSSL.

### 2.2 SQLite + FTS5 (`rusqlite` 0.40.1, `bundled`)

`rusqlite` 0.40.1 (released 2026-06-06) bundles SQLite **3.53.2** when the
`bundled` feature is on. `libsqlite3-sys` compiles the amalgamation from source
with the `cc` crate.

**Does `bundled` include FTS5?** Yes - verified directly against
`libsqlite3-sys/build.rs`. The bundled build unconditionally defines, among
others:

```
SQLITE_ENABLE_FTS3
SQLITE_ENABLE_FTS3_PARENTHESIS
SQLITE_ENABLE_FTS5
SQLITE_ENABLE_RTREE
SQLITE_ENABLE_JSON1
SQLITE_ENABLE_DBSTAT_VTAB
SQLITE_ENABLE_STAT4
SQLITE_USE_URI
SQLITE_THREADSAFE=1
SQLITE_DEFAULT_FOREIGN_KEYS=1
SQLITE_ENABLE_LOAD_EXTENSION=1
```

So the exact FTS5 setup in `src/store/db.ts`
(`tokenize='unicode61 remove_diacritics 2'`, `bm25(line_fts)`, unindexed
metadata columns) works out of the box with zero extra feature flags. WAL mode,
`busy_timeout`, prepared statements, and transactions are all first-class in
`rusqlite`.

Gotchas:
- `rusqlite` is **synchronous**. The current app is sync (better-sqlite3).
  Keep the DB layer sync and run it on a `tokio::task::spawn_blocking` bridge,
  or behind a dedicated DB thread with an mpsc channel. Do not hold a
  `Connection` across await points.
- `bundled` means every target needs a C compiler. Fine on all 6 build targets
  in CI (see section 4).
- To keep `load_extension` available for an emergency, add the `load_extension`
  feature, but you should not need it (sqlite-vec registers itself; see 2.3).

### 2.3 sqlite-vec in Rust (`sqlite-vec` 0.1.9) - investigated hard

This is the most likely blocker, so it gets the most depth. Findings:

- The `sqlite-vec` crate on crates.io **embeds the single-file C source
  (`sqlite-vec.c`) and compiles it at build time with the `cc` crate**, then
  statically links it. It is pure C with **no dependencies**. It does **not**
  use `load_extension`; instead you register it once at process start with:

  ```rust
  use sqlite_vec::sqlite3_vec_init;
  use rusqlite::ffi::sqlite3_auto_extension;
  unsafe {
      sqlite3_auto_extension(Some(std::mem::transmute(
          sqlite3_vec_init as *const (),
      )));
  }
  ```

  After that, every `Connection::open` automatically has `vec0` available. The
  current `ensureVec()` / `vec0` DDL in `src/semantic/semantic.ts` ports over
  unchanged.
- Required: `rusqlite` with the **`bundled`** feature (this is mandatory;
  sqlite-vec's build assumes it controls the SQLite it links against).
- `zerocopy` is recommended to pass `Vec<f32>` / `&[f32]` as BLOBs without
  copying, which matches the current `Buffer.from(Float32Array.buffer)` trick.

Cross-compile matrix - checked the v0.1.9 GitHub release assets directly:

| Target | Prebuilt loadable? | Rust crate (cc static)? |
|---|---|---|
| linux-x86_64 | yes | yes |
| linux-aarch64 | yes | yes |
| macos-x86_64 | yes | yes |
| macos-aarch64 | yes | yes |
| windows-x86_64 | yes | yes |
| **windows-aarch64** | **NO loadable shipped** | **yes (cc build, if a C cross-compiler is present)** |
| android / ios | yes | yes |

So the one gap is **Windows on ARM** for the *distributed loadable extension*.
That does **not** affect the Rust port, because the `cc`-based static build
compiles from source for whatever target the toolchain targets - including
`aarch64-pc-windows-msvc`, as long as the MSVC ARM64 C compiler is installed in
the build environment (GitHub Actions `windows-11-arm` runners / the ARM64 MSVC
build tools provide it). The loadable list is just what the project ships; the
crate is more flexible. Verdict: **sqlite-vec is not a blocker**, including for
Windows ARM64. Pre-v1 status ("expect breaking changes") is a minor
maintenance risk, not a porting risk.

Gotchas:
- `sqlite3_auto_extension` is process-global and `unsafe` (the transmute is
  required because of C ABI typing). Wrap it in a `Once::call_once` and only
  call it once per process.
- Because sqlite-vec forces `rusqlite/bundled`, you give up linking against a
  system SQLite. That is desirable here (single binary, predictable version).

### 2.4 Embeddings - the "LM runtime" (`ort` 2.0.0-rc.12)

Three realistic options, ranked by fit. The current TS code uses
`@huggingface/transformers` (`pipeline("feature-extraction", ..., { dtype: "q8" })`),
~150MB resident while active.

**Option A (recommended): `ort` + ONNX Runtime, dynamic, lazy-downloaded.**
- `ort` 2.0.0-rc.12 wraps ONNX Runtime **1.24**, MIT/Apache-2.0, ~1.2k direct
  dependent crates, ~1.8M downloads/month.
- ONNX Runtime loads any standard ONNX graph, including **INT8/q8 quantized**
  MiniLM. A q8 export of `all-MiniLM-L6-v2` is ~23MB on disk (vs ~90MB FP32)
  and ~60-90MB resident at inference (vs ~150-200MB FP32), retaining 95%+
  cosine similarity. That is already lighter than the current TS runtime.
- Use the **`load-dynamic`** feature: `ort` links against `libloading` and
  opens `onnxruntime.dll/.so/.dylib` at runtime from a path you control. The
  binary stays small; the ORT shared lib (~10-50MB, CPU-only build) is
  downloaded into the data dir alongside the model on first semantic use, then
  reused. Use the `fetch-models` feature (pulls `ureq` + `sha2`) to fetch and
  verify the model from the HF Hub or your own release, mirroring the current
  `env.cacheDir = MODELS_DIR` behavior.
- This preserves the "base install pays no model cost" requirement perfectly:
  the ~15MB base binary does not embed ORT or the model; both land in
  `~/.local/share/sana/models/` only when `SANA_SEMANTIC=1` is first used.

**Option B: `ort` + `download-binaries` (static-ish, build-time).**
- `download-binaries` (the default) fetches the ORT shared lib at **build**
  time via `build.rs` and links it. Still a shared lib at runtime - not a true
  single binary, and it bloats every install whether or not the user wants
  semantic search. Worse fit for the "optional" requirement. Not recommended.

**Option C: statically link ONNX Runtime from source.**
- Microsoft does **not** ship static ORT libraries. To get a true single
  binary you must build ORT from C++ source with `--build_shared_lib=OFF`
  (static) and feed it to `ort-sys`. This is a large, fragile C++ build
  (CMake, onnx, protobuf, abseil, etc.), adds ~10-50MB to the binary, and
  breaks the "optional / zero cost when off" goal because it is linked into
  every binary. Only worth it if embeddings become mandatory and the
  sidecar-free property is non-negotiable. Not recommended for sana-mcp.

**Pure-Rust alternatives** (`candle-core`, `burn`): both can run MiniLM and
avoid the C++ runtime entirely, which would give a true single static binary.
But neither has a turnkey q8 MiniLM pipeline with a model cache, both have a
larger build surface and binary-size cost of their own, and you would hand-roll
mean-pooling/normalization. The `ort`-dynamic path (Option A) gives you the
exact same model, quantization, and caching semantics you have today, for less
engineering risk. Defer candle/burn unless the ORT sidecar proves
unacceptable.

Realistic numbers (Option A):

| State | Disk added | Resident RAM |
|---|---|---|
| Base binary (no semantic) | ~8-15MB | ~10-20MB idle |
| First semantic use: ORT lib + q8 model downloaded | ~35-70MB in data dir | +~60-90MB while active |
| Semantic idle (>60s) | (cached on disk) | back to ~10-20MB (model unloaded) |

Binary-size impact of Option A on the base binary: **essentially zero** -
`ort` with `load-dynamic` only contributes the Rust FFI wrapper (~hundreds of
KB), because the runtime is an external lib.

### 2.5 MCP SDK (`rmcp` 2.2.0, official)

The official Model Context Protocol Rust SDK lives at
`modelcontextprotocol/rust-sdk` and is published as **`rmcp`**. Status (Jul
2026):

- Latest stable: **2.2.0** (2026-07-08). A **3.0.0-beta.1** (2026-07-23) is in
  flight for the 2026-07-28 spec RC. ~3.4M downloads/month, used by ~1,650
  crates directly. Apache-2.0.
- Pin **2.x stable** for the port; track 3.x after it stabilizes.
- Transport: enable the **`transport-io`** feature for the stdio server
  transport (exactly the current `StdioServerTransport`). The SDK is tokio-based
  and pluggable (also offers `transport-child-process`, streamable-HTTP client
  / server), but you only need `transport-io`.
- Tool registration: the `macros` feature (on by default) gives `#[tool]` /
  `#[r#type]` derive macros and JSON-Schema generation via `schemars`. The
  current single-tool design (one `meeting_transcripts(tool, args)` entrypoint
  where `tool` is an enum string and `args` is a free-form JSON object) maps
  to a single `#[tool]` handler with a `{ tool: String, args: serde_json::Value }`
  input. The dispatch lives in Rust instead of `src/tools/dispatch.ts`.

Maturity verdict: production-ready. This is the lowest-risk item in the port.

### 2.6 Daemon spawn + PID liveness + file locks

These are std-level, no heavy crate needed.

- **Spawn detached daemon**: `std::process::Command::new(current_exe)`
  `.arg("daemon")` (or a hidden `--daemon` subcommand) with:
  - Unix: `pre_exec` / `setsid` via the `nix` crate or `libc::setsid` to fully
    detach; `Stdio::null()` for stdin, a log file for stdout/stderr.
  - Windows: `CREATE_NO_WINDOW | DETACHED_PROCESS` via
    `.creation_flags(...)` from `std::os::windows::process::CommandExt`.
  - Drop the child handle (do not wait) so the parent exits immediately -
    equivalent to Node's `child.unref()`.
- **PID liveness (signal 0)**: the current `pidAlive()` is a direct port:
  - Unix: `libc::kill(pid, 0)`; treat `EPERM` as "exists, alive" and `ESRCH`
    as dead.
  - Windows: `OpenProcess` + `GetExitCodeProcess` (still active =
    `STILL_ACTIVE`). The `sysinfo` crate wraps this cross-platform, or use
    `windows-sys` directly to avoid a heavier dep.
- **Heartbeat**: the daemon already writes `daemon_heartbeat_ms` to
  `sync_state` every few seconds. Keep that exactly; a row is alive iff
  heartbeat fresh AND PID alive.
- **File lock (improvement)**: today there is no lock. A cheap upgrade is an
  advisory `fcntl` lock (Unix) / `LockFileEx` (Windows) on a `daemon.lock`
  file in the data dir, held for the daemon's lifetime. `fs4` or `fd-lock`
  give a one-call cross-platform API. This is optional polish, not a port
  requirement.

Gotcha: re-execing `current_exe()` for the daemon is the cleanest detached
spawn in Rust (no separate node binary to locate), and it is one of the wins of
the single-binary model.

---

## 3. Static / single-binary feasibility

| Component | Statically linkable? | Notes |
|---|---|---|
| SQLite | yes | `rusqlite/bundled` compiles amalgamation into the binary |
| FTS5 | yes | enabled by default in `bundled` |
| sqlite-vec | yes | `cc` compiles `sqlite-vec.c` into the binary |
| TLS (rustls) | yes | uses `aws-lc-rs` (default) or `ring`; both are C/Rust, link static |
| reqwest / hyper / tokio / rmcp / clap | yes | pure Rust |
| **ONNX Runtime** | **no (officially)** | MSFT ships shared libs only; static = build ORT from C++ source |

Conclusion: the **base binary is a true single file on all platforms** -
SQLite, sqlite-vec, and rustls all compile in from C source at build time, and
everything else is pure Rust. The only non-single-file piece is ONNX Runtime,
which the design already makes optional. The recommended path (2.4 Option A)
keeps ORT and the model as lazy-downloaded sidecars in the data dir, so the
`curl | sh` / `irm | iex` one-liner installs a self-contained binary that just
works for the non-semantic feature set, and grows on demand.

Linux fully-static (musl) is achievable with the `x86_64-unknown-linux-musl`
target for a zero-dependency glibc-free binary. For glibc dynamic Linux, pin
an old sysroot (manylinux-style) for broad distro compatibility.

---

## 4. Cross-compile / release matrix

Six targets cover the install story (matches the `curl|sh` / `irm|iex` goal):

| Target triple | C compiler in CI | Notes |
|---|---|---|
| `x86_64-unknown-linux-gnu` | gcc | main Linux |
| `x86_64-unknown-linux-musl` | musl-gcc | optional fully-static |
| `aarch64-unknown-linux-gnu` | aarch64-linux-gnu-gcc | Pi / ARM servers |
| `x86_64-apple-darwin` | clang (macOS-12 runner) | Intel Mac |
| `aarch64-apple-darwin` | clang (macOS-14 runner) | Apple Silicon |
| `x86_64-pc-windows-msvc` | MSVC | main Windows |
| `aarch64-pc-windows-msvc` | MSVC ARM64 (windows-arm runner) | Surface / Snapdragon |

Every one of these has a working C compiler on GitHub Actions runners, which is
all `rusqlite/bundled`, `sqlite-vec` (`cc`), and `aws-lc-rs` need. The Rust
`cross` tool or a custom matrix both work. This is the bulk of the release
engineering effort, but none of it is research-risk - it is known, repeatable
work.

Per-platform extras: macOS needs code-signing + notarization for a clean
`curl | sh` experience (Gatekeeper); Windows benefits from an Authenticode
signature but will run unsigned with a SmartScreen warning. None of this is
Rust-specific.

---

## 5. RAM and binary-size budget

Compared with the current Node app:

| Configuration | Binary / install size | Resident RAM (idle) | RAM (model loaded) |
|---|---|---|---|
| Current Node (base) | ~40-80MB `node_modules` + node runtime | ~50-80MB | ~150-200MB |
| Rust base binary | **~8-15MB** stripped | **~10-20MB** | n/a (model optional) |
| Rust + semantic sidecars | +~35-70MB in data dir (ORT + q8 model) | ~10-20MB | **~80-120MB** |

The Rust base cuts idle RAM roughly 3-5x versus Node and the on-disk footprint
roughly 4-8x, while the model-loaded case is also lighter (ORT q8 vs
transformers.js q8). Stripped, split-debuginfo, and `opt-level = "z"` + LTO
keep the binary at the low end of that range.

---

## 6. Top 3 risks / blockers

1. **ONNX Runtime is not truly single-file.** MSFT distributes only shared
   libraries, so a mandatory embedding feature would force either a sidecar
   (breaks the pure one-liner promise) or a from-source static ORT build
   (large, fragile C++ build, bloats every binary). **Mitigation (already in
   the design): keep embeddings optional, lazy-download ORT + model into the
   data dir on first semantic use.** The base binary then remains single-file
   and small. This is the biggest risk but it is fully mitigated by the
   existing `SANA_SEMANTIC` gate.

2. **Cross-compile CI for 6 targets with C components.** `rusqlite/bundled`,
   `sqlite-vec`, and `aws-lc-rs` each need a working C compiler for every
   target triple. It all works, but the release matrix (especially
   `aarch64-pc-windows-msvc` and `aarch64-apple-darwin`) plus macOS
   signing/notarization is the single largest chunk of engineering time in the
   port. **Mitigation:** standard GitHub Actions matrix + `cross`/native
   runners; validate the matrix early with a hello-world + sqlite-vec build
   before porting the whole app.

3. **sqlite-vec is pre-v1** ("expect breaking changes") and the
   `sqlite3_auto_extension` registration is `unsafe`. A breaking change in a
   future 0.1.x / 0.2 could require DDL or query changes. **Mitigation:** pin
   the exact `sqlite-vec` version, isolate all `vec0` SQL behind one module
   (mirroring `src/semantic/semantic.ts`), and wrap the one-time registration
   in `Once::call_once`. Low probability / low blast-radius.

Secondary, non-blocking items worth noting: `reqwest` 0.13's redirect engine
moved to `tower-http` (use `Policy::none()` + manual chasing to be safe);
`rusqlite` is synchronous so the DB layer needs a `spawn_blocking` bridge to
tokio; and `rmcp` 3.0 is imminent on the 2026-07-28 spec - stay on 2.x for the
port, upgrade later.

---

## 7. Recommended Cargo manifest (sketch)

```toml
[dependencies]
# HTTP + cookies + TLS, no native-tls
reqwest = { version = "0.13", default-features = false, features = ["rustls-tls", "json", "cookies", "http2"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "io-std", "process", "fs", "sync", "time"] }

# SQLite + FTS5 (bundled enables FTS5 by default)
rusqlite = { version = "0.40", features = ["bundled"] }

# Vector search (forces rusqlite/bundled; cc compiles sqlite-vec.c)
sqlite-vec = "0.1"
zerocopy = "1"

# MCP server, stdio only
rmcp = { version = "2", default-features = false, features = ["transport-io", "macros"] }

# CLI
clap = { version = "4", features = ["derive"] }

# Optional embeddings: dynamic ORT, do NOT link at build time
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["load-dynamic", "fetch-models", "ndarray"], optional = true }

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_System_Threading", "Win32_Foundation"] }

[features]
default = []
semantic = ["dep:ort"]   # gate the whole LM runtime behind SANA_SEMANTIC

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
panic = "abort"
```

This compiles a base binary with no ML cost; building with `--features semantic`
adds the `ort` wrapper (runtime still loaded dynamically at first use).

---

## 8. Summary

A Rust port is feasible with all-official, permissively-licensed crates. The
base binary is a true single file (~8-15MB, ~10-20MB RAM idle) on all six
targets because SQLite, FTS5, sqlite-vec, and rustls all compile in from C
source. The MCP SDK (`rmcp`) is mature and official. The only structural
compromise is ONNX Runtime, which cannot be a true static lib without a
painful from-source build - but keeping embeddings optional and lazy-downloading
ORT + the q8 model on first use (exactly the current `SANA_SEMANTIC` design)
preserves the one-liner install for everyone who does not use semantic search.
Go, conditional on the embedding sidecar approach.
