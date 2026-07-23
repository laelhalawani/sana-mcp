# sana-mcp - binary packaging study

How to ship sana-mcp as one native binary per OS/arch, hosted free on GitHub
Releases, installable with `curl <url> | sh` (Linux/macOS) and `irm <url> | iex`
(Windows PowerShell), with no end-user toolchain.

Researched and verified against current (July 2026) toolchains. The single most
load-bearing finding, which re-frames the whole study, is stated up front below.

Use hyphens, not em/en dashes, in all code and docs in this repo.

---

## 0. The surface this port must cover (from codebase-notes.md sec. 8)

- HTTPS client to `sana.ai/x-api/trpc/<proc>`: JSON GET (query-string input)
  and POST (JSON body). TLS, cookie jar (parse Set-Cookie, resend Cookie,
  treat `deleted`/empty as clear), custom header `sana-ai-workspace-id`,
  manual 302 redirect chasing.
- SQLite (WAL, busy_timeout, transactions) with FTS5 (BM25, unicode61,
  remove_diacritics 2) and the sqlite-vec loadable extension (KNN over
  float[384]).
- Optional on-device embeddings: all-MiniLM-L6-v2 (384-dim), q8/INT8, lazy,
  idle-unloaded ~60s, ~150MB while active, model cached on disk. Runs on
  ONNX Runtime.
- MCP server over stdio (JSON-RPC 2.0), one registered tool.
- CLI (subcommands, flags, optional JSON arg).
- Detached daemon spawn + PID liveness (signal 0) + ideally a file lock.
- Cross-platform file I/O, mkdir -p, atomic writes.

The C dependencies that must live inside (or alongside) the binary are: SQLite
amalgamation (one .c file, trivial to embed), sqlite-vec (one .c file, no
deps), and optionally ONNX Runtime (the hard one - see 3.3).

---

## 1. The pivotal finding: native free CI for all 6 targets

Every one of the six targets can be built **natively** on free GitHub Actions
runners for public repos. This removes the classic cross-compile pain as the
deciding factor and lets each language build on its own platform.

| Target | Runner label (public repo, free) | Status (2026) |
|---|---|---|
| Windows x86_64 | `windows-latest` / `windows-2025` | Free, unlimited (public repos) |
| Windows aarch64 | `windows-11-arm` / `windows-11-vs2026-arm` | GA; free for all public repos since Apr 2025 |
| Linux x86_64 (glibc) | `ubuntu-latest` / `ubuntu-24.04` | Free, unlimited |
| Linux aarch64 (glibc or musl) | `ubuntu-24.04-arm` | GA; free for public repos |
| macOS Intel | `macos-13` | Free, unlimited |
| macOS Apple Silicon | `macos-14` / `macos-latest` (M1) | Free, unlimited for public repos |

Sources: GitHub changelog "arm64 standard runners now available in private
repositories" (Jan 2026); "Windows ARM64 hosted runners now available in public
preview" (Apr 2025); actions/runner-images issue #14225 (VS 2026 Arm image).

Implications:
- You do not **need** to cross-compile. Each target builds on its matching
  runner, so per-target C toolchains (the hard part of CGO / Rust musl) are
  available natively. Cross-compile (cargo-zigbuild, zig cc, goreleaser-zig)
  becomes an optimization, not a requirement.
- All standard GitHub-hosted runners are **free and unlimited for public
  repositories**. Private repos consume plan minutes (~2,000 min/month on the
  free tier). Self-hosted runners are always free.
- This means no target is impossible-for-free. Every language reviewed here can
  hit all six targets on the free tier **if** it builds natively per runner.

---

## 2. Part 1 - targets and install mechanics

### 2.1 What a `curl | sh` installer must do

1. Detect OS (`uname -s`) and arch (`uname -m`), normalize to a target triple
   fragment: `{darwin,linux,windows}-{x86_64,aarch64/arm64}`.
2. Resolve the matching release asset URL from the GitHub Releases API (or a
   pre-built URL template `https://github.com/<owner>/<repo>/releases/latest/download/<asset>`).
3. Fetch, optionally verify a SHA-256 checksum (fetch `<asset>.sha256` or a
   bundled CHECKSUMS file; `sha256sum -c`).
4. Extract (tar.gz on Unix; zip is fine too), place the binary at
   `~/.local/bin/sana` (or `/usr/local/bin` if root), `chmod +x`.
5. Print a PATH hint if `~/.local/bin` is not on PATH.

Standard implementations: `cargo-dist`'s generated installer shell, the
Astral (uv) / Bun / Deno installers, and `marckrenn/installer`-style scripts.

### 2.2 What a PowerShell `irm | iex` installer must do

Mirror the above in PowerShell:

```powershell
irm https://github.com/<owner>/<repo>/releases/latest/download/install.ps1 | iex
```

1. Read `$env:OS` / `[Environment]::Is64BitOperatingSystem` and
   `$env:PROCESSOR_ARCHITECTURE` (ARM64 -> `ARM64`).
2. Pick the `sana-<version>-windows-<arch>.zip` asset.
3. `Invoke-WebRequest`, verify SHA-256 with `Get-FileHash`.
4. `Expand-Archive` into `$env:LOCALAPPDATA\Programs\sana`, add that dir to the
   user `PATH` via `[Environment]::SetEnvironmentVariable(..., 'User')`.

`irm | iex` is the exact PowerShell analog of `curl | sh` and is the de-facto
Windows one-command pattern (Scoop, Astral uv, rustup, Bun all use it).

### 2.3 GitHub Releases as the free host

- Storage and bandwidth for release assets are free and unmetered for public
  repos (each asset up to 2 GB; no total cap that matters here).
- `latest/download/<asset>` gives a stable URL that always points at the most
  recent non-prerelease release - exactly what one-command installers need.
- No CDN bill, no auth for public assets.

### 2.4 The macOS notarization trap - and why `curl | sh` sidesteps it

This is the most misunderstood part of the whole exercise.

- Gatekeeper's first-run check is triggered by the `com.apple.quarantine`
  extended attribute. That attribute is applied **only** by user-space apps
  that save files through LaunchServices (browsers, Mail, Finder). The `curl`
  command-line tool does **not** set `com.apple.quarantine`.
- Therefore a Mach-O binary fetched by `curl | sh` has no quarantine flag,
  Gatekeeper never inspects it, and it runs with no prompt regardless of
  signature or notarization status. (Howard Oakley / Eclectic Light Co.
  documents this precisely.)
- macOS Sequoia (15) tightened Gatekeeper for browser/`open`-launched apps and
  added a Local Network Permission (TCC) prompt, but the curl path is unchanged:
  no quarantine, no Gatekeeper, no notarization needed. The TCC Local Network
  prompt only affects LAN traffic, which is irrelevant here (the app talks to
  sana.ai over the public internet).

Conclusion: for a pure `curl | sh` / `irm | iex` distribution channel, **there
is no hard Apple-imposed cost**. Apple Developer Program ($99/year) is only
needed if you additionally want browser-downloadable `.dmg`/`.pkg`, a Homebrew
cask without friction, or a notarization ticket stapled for "open" launches.

---

## 3. Part 2 - Rust vs Go (head to head)

### 3.1 Rust

Toolchain story:
- `cross` (Docker-based, cross-rs) handles most targets out of the box,
  including cross to Windows GNU. Windows-MSVC and Windows-aarch64 are weaker
  in `cross` (community reports failures); the reliable path for those two is a
  native `windows-latest` / `windows-11-arm` runner.
- `cargo-zigbuild` + `zig` lets a Linux CI host produce macOS (Intel + Apple
  Silicon) and Linux musl binaries with no Apple SDK. It also builds universal2
  (`fat-macho` merge, no `lipo`/Xcode needed). Windows-gnu works via zig;
  Windows-MSVC does not (use a native Windows runner).
- Static musl: fully feasible. `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl` are first-class.

C dependencies:
- SQLite: `rusqlite` with `features = ["bundled"]` compiles the SQLite
  amalgamation into the crate and statically links it. FTS5 is enabled by
  passing `-DSQLITE_ENABLE_FTS5` (newer rusqlite exposes it; otherwise a build
  define). WAL/transactions are runtime, not build, concerns.
- sqlite-vec: official `sqlite-vec` crate registers the extension into a
  `rusqlite::Connection` in-process (no `load_extension` needed). Statically
  linked. Built on `sqlite-loadable-rs`.
- ONNX Runtime: the `ort` crate offers `load-dynamic` (dlopen/LoadLibrary the
  runtime shared lib at runtime - no build-time link) or `download-binaries`
  (prebuilt shared lib fetched at build time). Truly static ONNX requires
  building ORT from source (large, hard to cross-compile) and is not worth it.
  Because semantic search is optional in sana-mcp, the right design is
  `load-dynamic`: the binary does not embed ONNX at all; on first semantic use
  it fetches the matching `onnxruntime` shared lib + the MiniLM model to a cache
  dir, exactly like today's `@huggingface/transformers` path.

macOS code signing and notarization:
- Required ($99/year Apple Developer Program) **only** for Developer-ID-signed,
  browser-downloadable distribution. For `curl | sh` distribution: not required
  (see 2.4). Unsigned binaries run without prompts.
- Sequoia Gatekeeper tightening (spctl bypass no longer reliable, "Open Anyway"
  in System Settings) again applies to quarantined/browser apps, not to curl.
- Hardened Runtime + notarization is a 1-liner `codesign --options runtime` +
  `notarytool submit` if you do opt in.

Pros: strongest ecosystem fit for the HTTP surface (`reqwest` does TLS,
cookies, redirect policy, JSON, multipart - a near 1:1 map to the Sana tRPC
replay). Best correctness and long-term maintainability. Universal2 via
cargo-zigbuild or `lipo`. `cargo-dist` automates the entire release + checksums
+ installer scripts.

Cons: higher port effort from TypeScript; longer builds; Windows-aarch64 and
Windows-MSVC want a native Windows runner rather than `cross`.

### 3.2 Go

Toolchain story:
- `GOOS`/`GOARCH` cross-compile is trivial and free for every target:
  `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build`. Static-by-default when
  CGO is off. This is the best cross-compile story of any language here.
- The cost appears the moment you need CGO: per-target C toolchain, glibc vs
  musl, etc. Mitigations: build natively per runner (the norm here), or use
  `zig cc` as the C compiler (`goreleaser/example-zig-cgo` is the canonical
  setup) which restores painless CGO cross-compile.

C dependencies:
- SQLite without CGO: `modernc.org/sqlite` is a pure-Go transpilation of SQLite
  (via ccgo). `CGO_ENABLED=0` -> fully static, trivial cross-compile, standard
  `database/sql` interface. FTS5 works.
- sqlite-vec: this is the catch. sqlite-vec is a single C file and is normally
  loaded as a runtime extension or statically linked. Pure-Go modernc cannot
  load a C extension at runtime. To embed sqlite-vec in Go you therefore use a
  CGO build (`mattn/go-sqlite3` + the sqlite-vec C source compiled in, or load
  the `.so`/`.dll` via `mattn`'s extension loading). The sqlite-vec repo ships
  a Go example. On native runners (one per target) a CGO build is
  straightforward; goreleaser + `zig cc` handles it for cross-compile too.
- ONNX Runtime: official `microsoft/onnxruntime-go` bindings; same shared-lib
  reality as every language. Same recommendation: load dynamically, fetch on
  first semantic use.

macOS signing/notarization: identical rules to Rust (see 2.4). Not required for
`curl | sh`.

universal2: `lipo -create` two GOARCH builds, or ship per-arch. GoReleaser
supports universal macOS artifacts.

Pros: lowest port effort from TypeScript (goroutines map to the daemon loop,
`net/http` has a cookie jar and a configurable `CheckRedirect` for manual 302
chasing out of the box). Smallest CI matrix. Official Go MCP SDK
(`modelcontextprotocol/go-sdk`). `goreleaser` gives release + archives +
checksums + Homebrew tap + Scoop manifest + GitHub Releases upload in one tool.
Single static binary, fast compile, great daemon story (`os/exec`, `syscall`
signal-0 PID check).

Cons: if you insist on pure-Go (no CGO), you lose sqlite-vec; keeping
sqlite-vec forces CGO, which narrows (but does not eliminate, thanks to native
CI + zig cc) the "trivial static" advantage. Less control over memory than
Rust. Less precise error handling.

### 3.3 Both: the ONNX Runtime reality (shared)

ONNX Runtime ships as prebuilt **shared** libraries (`libonnxruntime.so` /
`.dll` / `.dylib`) per OS/arch; execution providers (oneDNN, etc.) are separate
shared libs. Static linking requires a from-source build and is impractical to
cross-compile. There is no language where embedding a truly-static ONNX is
easy.

For sana-mcp, ONNX is **optional** (semantic search only). The clean design in
every language is identical and matches today's behavior: do **not** embed ONNX
in the binary. Ship the core binary with only SQLite + sqlite-vec embedded. On
first semantic use, fetch the matching ONNX Runtime shared lib plus the q8
MiniLM model into a cache dir and load dynamically. This keeps the binary small
and avoids the hardest C-dep entirely.

### 3.4 Rust vs Go summary table

| Dimension | Rust | Go |
|---|---|---|
| Free all-6-target build | Yes (native CI; cross via zigbuild for most) | Yes (native CI; `GOOS`/`GOARCH` trivial) |
| Static musl | First-class | Yes if CGO off; with CGO, needs zig/musl toolchain |
| SQLite embed (static) | `rusqlite/bundled` + FTS5 define | `modernc.org/sqlite` (pure Go) OR CGO |
| sqlite-vec embed | `sqlite-vec` crate, static | CGO build (native runner or `zig cc`) |
| ONNX Runtime | `ort` load-dynamic (recommended) | onnxruntime-go, load-dynamic (recommended) |
| HTTP + cookies + manual 302 | `reqwest` (excellent) | `net/http` + CookieJar + CheckRedirect (excellent) |
| MCP SDK | `modelcontextprotocol/rust-sdk` | `modelcontextprotocol/go-sdk` (official) |
| Universal2 macOS | cargo-zigbuild / `lipo` | `lipo` / GoReleaser |
| macOS notarization needed? | No (curl path); $99/yr only for browser/pkg | No (curl path); $99/yr only for browser/pkg |
| Binary size | Medium (~5-15 MB stripped) | Medium (~8-20 MB; modernc adds size) |
| Port effort from TS | Higher | Lower |
| Release automation | `cargo-dist` | `goreleaser` |

---

## 4. Part 3 - alternatives survey

### 4.1 Zig (deep dive)

Zig has the best raw cross-compile and smallest-binary story of anything here.
Its weakness for sana-mcp specifically is the HTTP layer.

Strengths:
- `zig build -Dtarget=aarch64-windows-gnu` (or any of dozens of targets) from a
  single Linux host. Zig bundles libc for every target, so cross-compile needs
  no SDKs. Fully static by default.
- `build.zig` compiles C sources natively: you point it at the SQLite
  amalgamation and the sqlite-vec C file (`addCSourceFile`, `linkLibC`) and
  they are compiled and statically linked for every target, cross or native.
  The `zig-sqlite` project demonstrates this pattern. You can even build
  ONNX Runtime's C sources through `build.zig` if you want.
- Tiny binaries (often 1-3 MB), low RAM, fast startup - great fit for a daemon
  + CLI.
- C interop is frictionless (Zig is also a C compiler). sqlite-vec and SQLite
  drop in as C files.

Weaknesses for THIS app:
- `std.http.Client` exists and does TLS via Zig's own `std.crypto.tls` (no
  OpenSSL). It works for simple requests but has documented robustness gaps
  with larger TLS payloads, HTTP/1.1 hangs, reader assertions, and limited
  TLS-version history. It was built primarily to serve `zig fetch` (the package
  manager), not as a production HTTP client. sana-mcp's surface is
  HTTP-heavy (tRPC replay, cookie jar, manual 302 chasing), so this is the
  load-bearing risk.
- No mature cookie-jar / redirect-control wrapper. You would write it.
- No MCP SDK; you would hand-roll JSON-RPC over stdio (not hard, but work).
- Pre-1.0 (0.15.x in 2026); `std.http` API churns between minor versions.
- Pragmatic mitigations exist: vendor `libcurl` via C interop, or use a
  community `fetch`-style wrapper. But that erodes the "no dependencies" appeal.

Verdict: highest ceiling, highest risk today. Best choice only if you accept
building the HTTP/cookie layer or vendoring libcurl. The cross-compile and
C-dep-bundling story is unbeatable.

### 4.2 Swift

- Best-in-class on macOS (native toolchain, easy signing/notarization). Strong
  C interop for SQLite/sqlite-vec. Server-side (Vapor, Hummingbird) is
  production-ready on Linux; the Static Linux SDK (musl) produces static Linux
  binaries.
- Weaknesses: Swift 6.1/6.2 had regressions in cross-compiled musl binaries.
  Windows support improved through 2025 (SwiftNIO Windows port) but is still
  maturing; cross-compiling Linux->Windows is not the common path. Windows
  aarch64 is the shakiest of the six targets here.
- No single obvious win over Go/Rust for a 6-target tool; its advantage
  (Apple-platform native) is neutralized by free native CI for everyone.

### 4.3 .NET NativeAOT (single file)

- C# ecosystem is huge; `Microsoft.Data.Sqlite` bundles a native `e_sqlite3`
  per RID (so SQLite is handled), and `Microsoft.ML.OnnxRuntime` is a first-party
  ONNX binding.
- NativeAOT produces a self-contained native binary; `PublishSingleFile`
  bundles everything into one file. But NativeAOT is **platform-specific** -
  there is no cross-AOT from Linux to Windows; you must build on each target
  runner (fine here, given native CI).
- Real friction: trimming + reflection-heavy libraries can break at runtime;
  single-file still extracts native libs to a temp dir unless NativeAOT; AOT +
  SQLite + trimming has documented sharp edges. Heavier RAM and larger outputs
  than Go/Rust/Zig. Good if the team is already strong in C#, otherwise
  outclassed.

### 4.4 Nim

- Small, fast static binaries; cross-compiles Linux->Windows via MinGW well.
  SQLite via a static `libsqlite3.a` is well-trodden. C interop is straightforward
  (Nim emits C).
- Weaknesses: macOS fully-static is the weakest target; cross-compile tooling
  (`nimxc`) is alpha-quality; smaller ecosystem and library pool than Go/Rust;
  no MCP SDK. Fine technically, but no decisive advantage.

### 4.5 D

- Mature language, good C interop, decent static-binary story. But the
  ecosystem has contracted; cross-compile and Windows-aarch64 support trail
  Go/Rust. No MCP SDK. Not competitive for this surface in 2026.

### 4.6 Crystal

- Ruby-like syntax, LLVM, GC. Fast and pleasant. But **Windows support is still
  preview/incomplete** per the official install page, and Windows aarch64 is not
  a real target today. That disqualifies it for a 6-target shipping goal.

### 4.7 V (Vlang)

- Markets exactly this story: `v -os windows` one-shot cross-compile, built-in
  ORM with a SQLite backend, tiny binaries. C interop is trivial.
- Caveat: V has a long history of over-promised features and questionable
  production maturity; small ecosystem; sqlite-vec would need C interop. Too
  risky to recommend for a tool meant to be reliable.

### 4.8 Alternatives summary table

| Language | Single binary | All-6 free? | SQLite+FTS5 | sqlite-vec | ONNX | HTTP+cookies maturity | 2026 fit for sana-mcp |
|---|---|---|---|---|---|---|---|
| Zig | Yes (tiny, static) | Yes (best cross-compile) | via build.zig (C) | C file (build.zig) | C interop possible | **Weak** (std.http/TLS gaps) | High ceiling, HTTP risk |
| Swift | Yes (musl on Linux) | Mostly (Win arm64 weak) | C interop | C interop | C interop | Strong (Vapor/Hummingbird) | Neutralized by free native CI |
| .NET NativeAOT | Yes (single-file AOT) | Yes (native CI per RID) | bundled e_sqlite3 | needs work | first-class | Strong (HttpClient) | Heavy; trimming rough edges |
| Nim | Yes (static) | Mostly (macOS static weak) | static lib | C interop | C interop | Modest | OK, no decisive edge |
| D | Yes | Trails | C interop | C interop | C interop | Modest | Not competitive |
| Crystal | Yes | **No (Windows preview)** | yes | C interop | - | Modest | Disqualified (Windows) |
| V | Yes | Claims yes | ORM/sqlite | C interop | C interop | Modest | Credibility risk |

---

## 5. Ranked recommendation for sana-mcp

### 5.1 Ranking

1. **Go** - best overall fit for sana-mcp's exact surface.
   - Lowest port effort from TypeScript; the daemon loop, cookie jar, and
     manual-302 redirect logic map almost 1:1 onto `net/http`.
   - Single static binary by default; `GOOS`/`GOARCH` cross-compile is trivial,
     and native free CI covers all six targets anyway.
   - `modernc.org/sqlite` keeps the common path CGO-free; sqlite-vec needs CGO,
     which is painless on native runners (or via `goreleaser` + `zig cc`).
   - Official Go MCP SDK; `goreleaser` ships release + archives + checksums +
     Homebrew/Scoop + GitHub Releases in one tool.
   - ONNX loaded dynamically and fetched on first semantic use (not embedded).

2. **Rust** - best if long-term robustness outweighs port speed.
   - `reqwest` is the most complete HTTP/cookie/redirect stack of any option;
     `rusqlite/bundled` + the `sqlite-vec` crate give fully-static SQLite+FTS5+
     sqlite-vec on every target including musl, with no CGO concept at all.
   - `ort` load-dynamic for ONNX. Universal2 via cargo-zigbuild/lipo.
     `cargo-dist` does release automation.
   - Higher up-front cost, highest quality result.

3. **Zig** - best raw packaging, weakest ecosystem for this app.
   - Smallest binaries, effortless cross-compile, and `build.zig` compiles
     SQLite + sqlite-vec (and optionally ONNX C sources) statically for all
     targets. But `std.http.Client` TLS/cookie maturity is the blocker for the
     Sana tRPC replay surface, and there is no MCP SDK. Pick only if you will
     vendor libcurl or build the HTTP layer.

### 5.2 Targets that cannot be produced for free: none

All six targets build natively on free GitHub Actions runners for public repos,
including `windows-11-arm` and `macos-14` (Apple Silicon). Cross-compile tooling
(cargo-zigbuild, `zig cc`, goreleaser-zig-cgo) is a convenience, not a
requirement.

### 5.3 The one unavoidable cost: none (with a caveat)

There is **no hard unavoidable cost**. Distributing solely through
`curl | sh` / `irm | iex` sidesteps Apple notarization entirely, because curl
does not set the `com.apple.quarantine` extended attribute, so Gatekeeper never
inspects the binary. GitHub Releases and GitHub Actions are free for public
repos.

The one **optional** cost is the Apple Developer Program at **$99/year**, needed
only if you also want browser-downloadable, notarized `.dmg`/`.pkg`, a friction
free Homebrew cask, or stapled notarization tickets for users who `open` the app
from Finder. For sana-mcp's chosen one-command installer channel, it is
avoidable.

---

## 6. Sources

- GitHub changelog: arm64 standard runners in private repos (Jan 2026);
  Windows ARM64 hosted runners public preview (Apr 2025); actions/runner-images
  #14225 (VS 2026 Arm image); Linux arm64 free in public repos (Jan 2025).
- GitHub docs: about billing for GitHub Actions; actions-runner-pricing;
  github-hosted runners reference.
- Eclectic Light Co. (Howard Oakley): how to slip unsigned apps past Gatekeeper
  - curl does not set `com.apple.quarantine`.
- Apple docs: notarizing macOS software before distribution; Developer Program
  membership $99/year.
- rust-cross/cargo-zigbuild (universal2 via fat-macho); asg017/sqlite-loadable-rs
  and the `sqlite-vec` crate; pykeio/ort (`load-dynamic`, `download-binaries`);
  rusqlite `bundled` feature + FTS5 define.
- goreleaser/example-zig-cgo (CGO cross-compile with `zig cc`); modernc.org/sqlite
  (pure-Go SQLite); modelcontextprotocol/go-sdk and rust-sdk.
- Zig: zig.guide cross-compilation; zig-sqlite; std.http.Client TLS issues
  (#25015, #15902).
- Swift: swift.org Static Linux SDK; SwiftNIO Windows mid-2025 status; Swift
  Server ecosystem blog.
- .NET: Microsoft Learn Native AOT and single-file overview; Andrew Lock on
  .NET 10 NativeAOT tool packaging.
- Nim: nim-lang docs nimc cross-compile; iffy/nimxc (alpha).
- Crystal: crystal-lang.org install and platform-support (Windows preview).
