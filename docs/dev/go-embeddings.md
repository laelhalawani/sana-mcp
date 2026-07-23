# sana-mcp Go Port - On-device Embeddings (lazy MiniLM over ONNX Runtime)

Status: July 2026. Every version, URL, header, file size, and function
signature below was web-verified this month against pkg.go.dev, GitHub
release APIs, and a live probe of the HuggingFace Hub. Nothing here is
from memory. A live `curl` against the Hub confirmed the checksum story;
a local `sha256sum` of the existing TS-downloaded weights confirmed
offline reuse.

Scope: this doc covers ONLY the optional semantic/embedding subsystem
for the Go port (the `SANA_SEMANTIC=1` path). It assumes the storage,
HTTP, MCP, and daemon decisions from `go-port.md`, in particular that
the base binary is `CGO_ENABLED=0` pure Go on `modernc.org/sqlite`
(+ `/vec` for the `vec0` table that stores the vectors this subsystem
produces).

---

## TL;DR / verdict

The realistic Go path for on-device MiniLM in mid-2026 is ONNX Runtime
loaded through `github.com/yalue/onnxruntime_go` v1.31.0, plus a
pure-Go WordPiece tokenizer (`github.com/sugarme/tokenizer` v0.3.0)
and a ~200-line lazy downloader we write ourselves. `chromem-go` does
NOT help here (it only does API-based embeddings; see section 3).

Two "lazy" levels, both solved:

1. **Model weights** - downloaded from the HuggingFace Hub on first
   use with a tiny `net/http` fetcher. The Hub hands us a free
   content-SHA256 in the `x-linked-etag` response header, so
   checksumming is one `sha256` compare. Range requests work, so the
   download is resumable and can report progress. The existing
   TS-downloaded files under `data/models/Xenova/all-MiniLM-L6-v2/`
   are BYTE-IDENTICAL to the Hub (verified: local
   `sha256(model_quantized.onnx)` == the Hub's `x-linked-etag`), so
   the Go port reuses them as-is offline.

2. **ONNX Runtime shared library** (the crux) - `onnxruntime_go` has
   NO download helper and bundles only 3 of 6 target libs (as test
   fixtures, not for redistribution). We write a second small
   downloader that fetches the matching per-OS/arch archive from the
   `microsoft/onnxruntime` GitHub Release (v1.27.1 is current),
   extracts just `lib/libonnxruntime.*`, and points the binding at it
   via `ort.SetSharedLibraryPath` before `ort.InitializeEnvironment`.

The whole subsystem lives behind a `//go:build embeddings` tag, so
the default `CGO_ENABLED=0` binary is untouched (semantic search falls
back to BM25-only, exactly as the TS app does when `SANA_SEMANTIC!=1`).
Users who want hybrid search build/install the tagged variant with
`CGO_ENABLED=1` (a C toolchain per target).

---

## 1. Module set

| Role | Module | Version (Jul 2026) | CGO? | Notes |
|---|---|---|---|---|
| ONNX inference | `github.com/yalue/onnxruntime_go` | **v1.31.0** (latest tag) | Yes (loads shared lib at runtime) | Built against ORT C API headers v1.26.0; ABI-stable, loads any >=1.26 lib |
| Tokenizer (primary) | `github.com/sugarme/tokenizer` | **v0.3.0** (Sep 2025) | **No** (pure Go) | Reads `tokenizer.json`, WordPiece, returns IDs/TypeIDs/AttentionMask. Pre-v1, validate parity |
| Tokenizer (fallback) | `github.com/daulet/tokenizers` | **v1.27.0** (Mar 2026) | Yes (Rust `libtokenizers.a`) | Byte-exact HF tokenizers; only use if sugarme parity fails |
| HF Hub download | stdlib `net/http` (hand-rolled) | Go 1.24+ | No | ~150 lines; we control checksum/resume/cache layout |
| HF Hub download (alt) | `github.com/gomlx/go-huggingface/hub` | no tags, "EXPERIMENTAL" | No | `repo.DownloadFile(path)`; shares the Python HF cache. Skip: unversioned, wrong cache layout for us |
| Vector storage | `modernc.org/sqlite/vec` (blank import) | v1.54.0 | No | `vec0(float[384], ...)` table; covered in `go-port.md` |

All of this is OPTIONAL and build-tag-gated. The base binary imports
none of it.

### Why not `chromem-go`

`github.com/philippgille/chromem-go` (v0.7.0, Sep 2024) sounds like a
shortcut ("ship a ready embedder that downloads MiniLM + tokenizes +
ONNX + mean-pool + normalize"). It is not. Verified against pkg.go.dev:
chromem-go ships NO local/on-device embedder. Its `NewEmbeddingFunc*`
constructors are ALL remote-API clients (OpenAI, Azure, Cohere, Mistral,
Jina, Mixedbread, Vertex, Ollama, LocalAI, generic OpenAI-compat). It
contains zero ONNX code, downloads no model, and does no tokenization.
Its roadmap literally says "Add an EmbeddingFunc that downloads and
shells out to llamafile" - still unimplemented. It is pure Go with zero
deps and is a nice vector store, but sana-mcp already has sqlite-vec,
so there is nothing to gain from it. Do not add it for the embed step.

---

## 2. The model (grounding)

All facts below were checked against the local cache and the Hub.

- Repo: `Xenova/all-MiniLM-L6-v2` (mirror of sentence-transformers'
  all-MiniLM-L6-v2), Apache-2.0. Architecture: BERT, 6 layers, 12 heads,
  hidden_size 384, max_position_embeddings 512, vocab 30522,
  pad_token_id 0. `tokenizer_class: BertTokenizer`, `do_lower_case: true`.
- Files on the Hub (paths under the repo root):
  - `onnx/model_quantized.onnx` - q8, **22,972,370 bytes**
  - `onnx/model.onnx` - fp32, 90,387,606 bytes
  - `tokenizer.json` - 711,661 bytes (the fast-tokenizer config)
  - `config.json`, `tokenizer_config.json` - a few hundred bytes each
- Quantization format (verified by scanning the protobuf): the q8 model
  is **QDQ** format - `QuantizeLinear` / `DequantizeLinear` nodes around
  weights and activations - NOT the older `MatMulInteger` QOperator
  format. This matters: QDQ models run on the standard CPU execution
  provider on every platform ORT supports, so the q8 graph is portable
  to aarch64 and Windows without special kernels. (Transformers.js runs
  this exact file on those platforms today.)
- ONNX graph IO (verified by `strings` on both local .onnx files):
  - inputs: `input_ids` (int64, [B,S]), `token_type_ids` (int64, [B,S]),
    `attention_mask` (int64, [B,S])
  - output: `last_hidden_state` (float32, [B,S,384])
- Embedding a line = tokenize -> run -> mean-pool `last_hidden_state`
  over S using `attention_mask` -> L2-normalize -> float32[384].

The TS app loads `onnx/model_quantized.onnx` when `dtype: "q8"` is
passed (confirmed: that is the only file the q8 path reads). The Go
port loads the same file.

---

## 3. Lazy level 1 - downloading the MODEL WEIGHTS

### 3.1 The canonical Hub resolve URL (verified live)

```
https://huggingface.co/{repo}/resolve/{revision}/{path}
# concrete:
https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx
```

A `curl -sIL` against that URL returned `HTTP/2 302` redirecting to a
signed CDN URL on `us.aws.cdn.hf.co` (HF now routes large files through
its Xet bridge), then `HTTP/2 200` with the bytes. Key response headers
on the 302 (the important ones are HF-specific):

```
x-linked-size: 22972370
x-linked-etag: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
x-repo-commit: 751bff37182d3f1213fa05d7196b954e230abad9
accept-ranges: bytes
cache-control: no-store
```

Two things make this trivial to do safely:

1. **`x-linked-etag` IS the content SHA256.** It is not an opaque hash
   of the CDN object; it is the hex sha256 of the file bytes. Proof:
   the local TS-downloaded `model_quantized.onnx` hashes to
   `afdb6f1a0e45b715...` (first 16 hex chars), matching the header
   exactly. So we get checksum verification for free - no separate
   `.sha256` sidecar, no LFS metadata to parse.

2. **`accept-ranges: bytes`** is present on both the 302 and the 200,
   so HTTP range requests work. That gives us resumable downloads and
   per-chunk progress reporting for free.

The signed CDN URL in the `Location` header is time-limited (~hours),
so we must NOT cache it - always re-issue the `resolve` request and let
`net/http` follow the redirect afresh.

### 3.2 Which files, from where, to where

Download set (revision `main`, pinned to commit `751bff37...` via the
captured `x-repo-commit` if you want immutability):

| File | Size | Required? |
|---|---|---|
| `onnx/model_quantized.onnx` | 23 MB | Yes (q8 primary) |
| `onnx/model.onnx` | 90 MB | Optional (fp32 fallback, see risks) |
| `tokenizer.json` | 711 KB | Yes |
| `config.json` | 650 B | Yes (validates hidden_size/max_len) |
| `tokenizer_config.json` | 366 B | Yes |

Local cache path - REUSE THE TS LAYOUT so existing installs need no
re-download:

```
<data_dir>/models/Xenova/all-MiniLM-L6-v2/
    config.json
    tokenizer.json
    tokenizer_config.json
    onnx/model_quantized.onnx
    onnx/model.onnx            (only if fp32 fallback is enabled)
```

`<data_dir>` is the same `data/` the TS app uses (see `src/config.ts`),
so a user upgrading from the TS app to the Go binary keeps their
already-downloaded weights. This is a hard requirement and it is free
because the layouts already match.

### 3.3 The download flow (resumable + checksummed)

For each file:

1. Issue the `resolve` request. The stdlib `http.Client` follows the
   302 automatically. Add `?download=true` to be explicit, though it is
   not required for these paths.
2. Read the response headers before draining the body:
   - `expected = resp.Header.Get("X-Linked-Etag")` (strip surrounding
     quotes). This is the target sha256.
   - `size = resp.Header.Get("X-Linked-Size")` (authoritative byte
     count).
3. If `<cache>/<path>` exists and `sha256(file) == expected` and
   `len(file) == size`, skip. Done.
4. Else resume: stat any existing `<cache>/<path>.part`; if present,
   send `Range: bytes=<partlen>-`. Append to the `.part` file through a
   `TeeReader` wrapped in a progress reporter that calls a callback
   every N bytes (for the daemon log / a future TUI).
5. On EOF, `fsync`, rename `.part` -> final path, then
   `sha256(final) == expected` (final guard). If it fails, delete and
   retry once; if it still fails, raise `SemanticUnavailableError`
   (mirrors the TS error type).

For the q8 file this is ~23 MB - a few seconds on a warm link - so the
resume machinery is mostly insurance, but it is cheap insurance and the
progress callback is genuinely useful for the 90 MB fp32 fallback.

### 3.4 Offline reuse of the TS cache

Confirmed reusable as-is. The TS app writes files to the exact paths in
3.2 using `env.cacheDir = MODELS_DIR` (see `src/semantic/semantic.ts`
line 47). The Go downloader's step 3 (size + sha256 check against
`x-linked-etag`) will accept them on the first run with no network
needed beyond the initial header probe. If you want full offline start,
gate even the header probe behind "file exists and a local manifest
matches" - the manifest is just `{path, size, sha256}` tuples pinned at
build time.

No equivalent reuse question applies to tokenizer or config files: they
are plain JSON, already present, and loaded straight off disk.

---

## 4. Lazy level 2 - the ONNX RUNTIME shared library (the crux)

This is the only genuinely awkward part. `onnxruntime_go` is a thin Go
wrapper over the official C API. It `dlopen`s the shared library at
runtime and looks up the API via `OrtGetApiBase()`. It does NOT ship
the library for production use.

### 4.1 What `onnxruntime_go` actually gives you

- `ort.SetSharedLibraryPath(path string)` - MUST be called before
  `ort.InitializeEnvironment()`. Default (if you never call it) is
  `onnxruntime.dll` on Windows and `onnxruntime.so` elsewhere, resolved
  via the normal dynamic-loader search path.
- `ort.InitializeEnvironment(opts ...EnvironmentOption) error` - creates
  the process-global ORT env. Call exactly once.
- `ort.DestroyEnvironment() error` - tears the whole env down. Process
  exit only; do NOT call this on idle-unload (see 6.3).
- Sessions: `NewAdvancedSession(file, inNames, outNames, ins, outs, opts)`
  (fixed-shape tensors) or `NewDynamicAdvancedSession(file, inNames,
  outNames, opts)` (tensors supplied at `Run` time). Use the Dynamic
  variant - batch size and seq len vary per call.
- Tensors: `ort.NewTensor[T](ort.NewShape(...), data)` and
  `ort.NewEmptyTensor[T](shape)`; `tensor.GetData()` reads the flat
  slice; `tensor.Destroy()` frees.
- Run: `sess.Run(inputs, outputs)`; `sess.Destroy()` frees the session.

There is no `SetProcAddressSearcher`, no `DownloadSharedLibrary`, no
per-OS helper. The repo's `test_data/` directory DOES contain three
shared libs:

```
test_data/onnxruntime.dll          14.9 MB   (Windows amd64)
test_data/onnxruntime_arm64.dylib  37.3 MB   (macOS arm64)
test_data/onnxruntime_arm64.so     19.5 MB   (Linux arm64)
```

These are CI test fixtures. They cover only 3 of our 6 targets, are of
an untracked ORT version, and are not licensed/documented for
redistribution. Do NOT extract and ship them. Write our own downloader.

### 4.2 The downloader: GOOS/GOARCH -> release archive

ONNX Runtime current release: **v1.27.1** (Jul 11 2026), confirmed via
the GitHub Releases API. Asset names verified from the API (sizes are
the compressed archive sizes):

| GOOS / GOARCH | Archive | Bytes | Contains (in `lib/`) |
|---|---|---|---|
| linux / amd64 | `onnxruntime-linux-x64-1.27.1.tgz` | 8.8 MB | `libonnxruntime.so.1.27.1` + symlinks |
| linux / arm64 | `onnxruntime-linux-aarch64-1.27.1.tgz` | 7.8 MB | `libonnxruntime.so.1.27.1` + symlinks |
| darwin / arm64 | `onnxruntime-osx-arm64-1.27.1.tgz` | 32 MB | `libonnxruntime.dylib` (+ CoreML provider) |
| windows / amd64 | `onnxruntime-win-x64-1.27.1.zip` | 77 MB | `onnxruntime.dll` (+ providers) |
| windows / arm64 | `onnxruntime-win-arm64-1.27.1.zip` | 79 MB | `onnxruntime.dll` |
| darwin / amd64 | **none in v1.27.1** | - | Intel Mac dropped (see 7.2) |

Base URL pattern:

```
https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/<archive>
```

Cache path (our own; do NOT use the system loader path - we want it
self-contained and lazy):

```
<data_dir>/lib/onnxruntime/<goos>-<goarch>/
    libonnxruntime.so.1.27.1    # linux
    libonnxruntime.dylib        # darwin
    onnxruntime.dll             # windows
```

Extraction: `tar -xzf` (linux/darwin) or `archive/zip` (windows), but
copy ONLY the one shared lib we need out of `lib/`. The macOS and
Windows archives are large because they bundle provider shared libs
(CoreML / DirectML stubs etc.); the single CPU-EP lib is all we load.

Checksum: GitHub release assets are not consistently accompanied by a
`.sha256` file, so pin the expected sha256 per archive in a Go `const`
map at build time (recorded once from a trusted machine and reviewed on
every ORT version bump). Verify after download; refuse to load on
mismatch.

### 4.3 Version matching and the loading sequence

- `onnxruntime_go` v1.31.0 was generated from ORT C API headers v1.26.0.
  The ORT C API is ABI-stable within 1.x: the binding calls
  `OrtGetApiBase()->GetApi(API_VERSION)` with API_VERSION = the one it
  was built against, and the runtime returns a compatible function
  table. A v1.27.1 runtime therefore loads cleanly under a v1.26.0
  binding. Rule of thumb: **runtime version >= headers version**.
  1.27.1 >= 1.26.0 - fine.
- Pin the runtime version explicitly (do not "fetch latest"), so the
  build stays reproducible and the pinned checksums stay valid.

The mandatory ordering, exactly once at process start (inside the
embeddings build, on first use):

```go
ort.SetSharedLibraryPath(<abs path to the cached lib>) // MUST precede init
if err := ort.InitializeEnvironment(); err != nil { ... }
// sessions are created/destroyed freely after this; env is process-global
```

On Linux specifically, point `SetSharedLibraryPath` at the
**versioned** file `libonnxruntime.so.1.27.1`, not the bare
`libonnxruntime.so` symlink (the `onnxruntime_go` README calls this
out). On macOS/Windows the unversioned name is the real file.

---

## 5. Build tag + CGO story

Goal: the default install pays zero cost; the embeddings subsystem is
opt-in and never weakens the pure-Go base binary.

### 5.1 File layout (build-tag-gated)

```
src/semantic/
    semantic_nobuild.go     //go:build !embeddings   // stub: SemanticEnabled()=false, errors
    semantic.go             //go:build embeddings     // real impl: load, embed, store, search
    ort.go                  //go:build embeddings     // ORT session + tensors + pool/normalize
    hfhub.go                //go:build embeddings     // model downloader (x-linked-etag verify)
    ortlib.go               //go:build embeddings     // ORT shared-lib downloader + extractor
    tokenizer.go            //go:build embeddings     // sugarme wrapper, padding/truncation
```

The non-embeddings file in the default build exposes the same public
symbols (`SemanticEnabled`, `embedQuery`, `embedMeeting`, `searchKnn`,
`ensureVec`) as no-ops or constant-false, so the call sites in the
daemon/dispatch compile unchanged. When `SANA_SEMANTIC!=1` at runtime,
or the build lacks the tag, semantic search is simply unavailable and
the tool falls back to BM25-only - identical to the TS behaviour.

### 5.2 The two builds

- Default (what `curl | sh` installs):
  ```
  CGO_ENABLED=0 go build -o sana
  ```
  No C toolchain, no embeddings code compiled in, free static
  cross-compile of all six targets from one Linux host. Unchanged from
  `go-port.md` Strategy A.
- Embeddings variant (opt-in):
  ```
  CGO_ENABLED=1 go build -tags embeddings -o sana-embed
  ```
  Needs gcc/clang/mingw per target (native GitHub runners, or `zig cc`
  as a universal cross-compiler). This is `go-port.md` Strategy B,
  confined to the tagged files. Ship as the `sana embed` sidecar or a
  tagged release; the daemon locates it and shells out (or the user
  just runs the tagged binary directly).

`onnxruntime_go` only compiles when `-tags embeddings` is set, so its
CGO preamble never touches the default build. `sugarme/tokenizer` is
pure Go but is also gated by the same tag to keep the dependency graph
of the base binary clean.

### 5.3 Runtime gating

Even in the tagged build, nothing loads until a search actually runs
with `SANA_SEMANTIC=1`. The session is created on first `embed`,
destroyed after ~60s idle (section 6.3), and the shared lib / weights
are downloaded only on the first-ever run. A user who builds the tag
but never sets `SANA_SEMANTIC=1` pays nothing.

---

## 6. Code sketch (the full flow, in order)

Illustrative, not compile-checked, but the API calls and the ordering
are accurate against the v1.31.0 / v0.3.0 docs. Uses `sugarme/tokenizer`
and the dynamic session variant.

### 6.1 One-time init (download everything, then load the lib)

```go
//go:build embeddings

package semantic

import (
    "archive/tar"
    "archive/zip"
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "runtime"
    "strings"

    ort "github.com/yalue/onnxruntime_go"
    "github.com/sugarme/tokenizer/pretrained"
)

const (
    hfRepo        = "Xenova/all-MiniLM-L6-v2"
    ortVersion    = "1.27.1"
    embedDim      = 384
    maxSeqLen     = 512
    idleUnloadMs  = 60_000
)

// pinned expected sha256 of each HF file == its x-linked-etag at rev main.
// (Recorded once; re-verified on every model rev bump.)
var modelFileHashes = map[string]string{
    "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    "tokenizer.json":            "<sha256 of tokenizer.json>",
    "config.json":               "<sha256 of config.json>",
    // "onnx/model.onnx":        "<sha256 of fp32 fallback>",
}

// pinned expected sha256 of each ORT release archive.
var ortArchiveHashes = map[string]string{
    "onnxruntime-linux-x64-1.27.1.tgz":      "<sha256>",
    "onnxruntime-linux-aarch64-1.27.1.tgz":  "<sha256>",
    "onnxruntime-osx-arm64-1.27.1.tgz":      "<sha256>",
    "onnxruntime-win-x64-1.27.1.zip":        "<sha256>",
    "onnxruntime-win-arm64-1.27.1.zip":      "<sha256>",
}

func modelDir(dataDir string) string  { return filepath.Join(dataDir, "models", hfRepo) }
func ortLibDir(dataDir string) string { return filepath.Join(dataDir, "lib", "onnxruntime", runtime.GOOS+"-"+runtime.GOARCH) }

// ensureModelFile downloads path if missing/corrupt. x-linked-etag = sha256.
func ensureModelFile(dataDir, path string) (string, error) {
    dst := filepath.Join(modelDir(dataDir), path)
    if ok, _ := fileMatchesHash(dst, modelFileHashes[path]); ok {
        return dst, nil // offline reuse of TS cache hits here
    }
    url := fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", hfRepo, path)
    if err := downloadResumable(url, dst, modelFileHashes[path], nil); err != nil {
        return "", err
    }
    return dst, nil
}
```

`downloadResumable` does the HEAD-for-etag + range-append + rename +
`sha256==expected` dance from section 3.3, optionally calling a progress
callback. The `x-linked-etag` header is preferred over the pinned hash
(so a model rev bump is picked up automatically), but if the header is
absent we fall back to the pinned value.

### 6.2 The ORT shared-lib downloader

```go
func ortAssetName() (string, error) {
    switch runtime.GOOS + "/" + runtime.GOARCH {
    case "linux/amd64":
        return "onnxruntime-linux-x64-1.27.1.tgz", nil
    case "linux/arm64":
        return "onnxruntime-linux-aarch64-1.27.1.tgz", nil
    case "darwin/arm64":
        return "onnxruntime-osx-arm64-1.27.1.tgz", nil
    case "windows/amd64":
        return "onnxruntime-win-x64-1.27.1.zip", nil
    case "windows/arm64":
        return "onnxruntime-win-arm64-1.27.1.zip", nil
    default:
        return "", fmt.Errorf("embeddings: no ORT asset for %s/%s (Intel Mac dropped in >=1.27)",
            runtime.GOOS, runtime.GOARCH)
    }
}

// returns absolute path to the extracted shared lib, downloading if needed.
func ensureORTLib(dataDir string) (string, error) {
    name, err := ortAssetName()
    if err != nil {
        return "", err
    }
    want := ortArchiveHashes[name]
    final := libFileForOS(ortLibDir(dataDir)) // e.g. .../libonnxruntime.so.1.27.1
    if ok, _ := fileMatchesHash(final, ""); ok && final != "" {
        return final, nil
    }
    // download archive to a temp, verify sha256, extract only the one lib.
    url := fmt.Sprintf("https://github.com/microsoft/onnxruntime/releases/download/v%s/%s", ortVersion, name)
    tmp, _ := os.CreateTemp("", "ort-*")
    defer os.Remove(tmp.Name())
    if err := downloadResumable(url, tmp.Name(), want, nil); err != nil {
        return "", err
    }
    return extractSharedLib(tmp.Name(), ortLibDir(dataDir), name)
}
```

`extractSharedLib` switches on `.tgz` (tar+gzip) vs `.zip`, walks the
archive, and copies only `lib/libonnxruntime.so.<ver>` / `.dylib` /
`onnxruntime.dll` into `ortLibDir`. The versioned Linux name is kept as
-is (do not rename to the bare `.so`).

### 6.3 Session lifecycle + idle-unload

Keep the env alive for the process; destroy/recreate the session on
demand. Re-creating a session from a cached file is ~100-200ms, cheap
enough that a 60s idle timer is a clear win (mirrors the TS
`SANA_EMBED_IDLE_MS`).

```go
type embedder struct {
    dataDir string

    mu       sync.Mutex
    sess     *ort.DynamicAdvancedSession
    tk       *tokenizer.Tokenizer
    idleT    *time.Timer
    loaded   bool

    inNames  = []string{"input_ids", "attention_mask", "token_type_ids"}
    outNames = []string{"last_hidden_state"}
}

func (e *embedder) ensure() error {
    // one-time: download model + ORT lib, load tokenizer, init ORT env + session.
    libPath, _ := ensureORTLib(e.dataDir)
    ort.SetSharedLibraryPath(libPath)              // MUST precede InitializeEnvironment
    ort.InitializeEnvironment()                     // idempotent/guarded once per process
    modelPath, _ := ensureModelFile(e.dataDir, "onnx/model_quantized.onnx")
    pretrained.FromFile(...) -> e.tk  (with WithTruncation(512) + WithPadding batch-longest)
    e.sess, _ = ort.NewDynamicAdvancedSession(modelPath, e.inNames, e.outNames, nil)
    e.loaded = true
    e.armIdleTimer()
    return nil
}

func (e *embedder) armIdleTimer() {
    if e.idleT != nil { e.idleT.Stop() }
    e.idleT = time.AfterFunc(idleUnloadMs*time.Millisecond, e.unload)
}

func (e *embedder) unload() {
    e.mu.Lock(); defer e.mu.Unlock()
    if e.sess != nil { e.sess.Destroy(); e.sess = nil }   // frees weights + arena
    // keep e.tk; keep the ORT env alive (DestroyEnvironment is process-exit only)
    e.loaded = false
}
```

`armIdleTimer` is called after every `embed`, resetting the 60s window
on each use, exactly like the TS `scheduleUnload`.

### 6.4 Tokenize -> tensors -> run -> pool -> normalize

```go
func (e *embedder) embedBatch(ctx context.Context, texts []string) ([][]float32, error) {
    e.mu.Lock(); defer e.mu.Unlock()
    if !e.loaded { if err := e.ensure(); err != nil { return nil, err } }

    B := int64(len(texts))
    // 1. tokenize (sugarme). WithPadding(BatchLongest) pads to the longest
    //    in the batch and sets AttentionMask=0 on pad positions.
    encs, err := e.tk.EncodeBatch(inputs(B, texts), true)
    if err != nil { return nil, err }
    S := int64(len(encs[0].GetIds()))           // padded seq len

    // 2. flatten to [B*S] int64 planes, row-major
    ids, mask, typeIDs := flattenEncodings(encs, B*S)

    // 3. build ort tensors. DynamicAdvancedSession takes []Value at Run time.
    inIDs, _   := ort.NewTensor[int64](ort.NewShape(B, S), ids)
    inMask, _  := ort.NewTensor[int64](ort.NewShape(B, S), mask)
    inType, _  := ort.NewTensor[int64](ort.NewShape(B, S), typeIDs)
    defer inIDs.Destroy(); defer inMask.Destroy(); defer inType.Destroy()

    out, _ := ort.NewEmptyTensor[float32](ort.NewShape(B, S, embedDim))
    defer out.Destroy()

    if err := e.sess.Run([]ort.Value{inIDs, inMask, inType}, []ort.Value{out}); err != nil {
        return nil, err
    }
    e.armIdleTimer()

    // 4. mean-pool over S using attention_mask, then L2-normalize. [B,S,384] row-major.
    data := out.GetData()                          // len == B*S*384
    vecs := make([][]float32, B)
    for b := int64(0); b < B; b++ {
        var sum [embedDim]float32
        var denom float32
        for s := int64(0); s < S; s++ {
            // attention_mask for this (b,s)
            if mask[b*S+s] == 0 { continue }
            denom += 1
            off := (b*S + s) * embedDim
            for d := int64(0); d < embedDim; d++ { sum[d] += data[off+d] }
        }
        v := make([]float32, embedDim)
        var norm float32
        for d := int64(0); d < embedDim; d++ {
            m := sum[d] / denom                    // mean-pool
            v[d] = m
            norm += m * m
        }
        inv := 1 / float32(math.Sqrt(float64(norm)))   // L2-normalize
        for d := int64(0); d < embedDim; d++ { v[d] *= inv }
        vecs[b] = v
    }
    return vecs, nil
}
```

`flattenEncodings` copies `encs[i].GetIds()` / `.GetAttentionMask()` /
`.GetTypeIds()` into flat `[]int64` (sugarme returns `[]int`, so widen
to int64). `pretrained.FromFile` + `tk.WithPadding(BatchLongest, Right,
padId=0)` + `tk.WithTruncation(512)` set up the tokenizer once.

### 6.5 Serialize to the sqlite-vec BLOB

sqlite-vec `vec0(embedding float[384])` expects the raw IEEE-754
little-endian bytes of 384 float32 (= 1536 bytes). Encode each vector:

```go
func vecToBlob(v []float32) []byte {
    b := make([]byte, 4*len(v))
    for i, f := range v {
        binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
    }
    return b
}
```

This is byte-for-byte what the TS app produces via
`Buffer.from(v.buffer, ...)`, so vectors written by either runtime are
mutually queryable - a DB populated by the TS app works with the Go
binary and vice versa.

---

## 7. Binary size, RAM, and risks

### 7.1 Binary size and RAM

| Configuration | Binary size | Idle RSS | Active RSS (model loaded) |
|---|---|---|---|
| Default `CGO_ENABLED=0` (no tag) | 10-18 MB | 10-25 MB | n/a (no embeddings) |
| `-tags embeddings`, shared lib NOT embedded | 10-18 MB (+ <1 MB for the ORT binding code; weights + lib stay on disk in the cache) | 10-25 MB | ~150-200 MB |
| `-tags embeddings`, shared lib embedded via `//go:embed` (optional offline variant) | +8-37 MB depending on platform lib | 10-25 MB | ~150-200 MB |

The shared library is 8.8 MB (linux x64) up to 37 MB (the fat macOS
arm64 archive's dylib) on disk; the q8 weights are 23 MB. The
recommended default is to DOWNLOAD both lazily and keep the binary at
~10-18 MB. Embedding the shared lib into the binary is an opt-in
"fully offline" variant for users who want a single self-contained file
and accept the size cost.

Active RSS is dominated by the q8 weights (~23 MB) plus the ORT arena
and graph (~120-170 MB), landing in the same ~150-200 MB band as the TS
app (which the `go-port.md` table already assumes). When the idle timer
fires and `sess.Destroy()` runs, RSS drops back to the ~10-25 MB
baseline.

### 7.2 Risks and gotchas

1. **q8 on aarch64 / Windows** - LOW risk in practice. The Xenova q8
   graph is QDQ (`QuantizeLinear`/`DequantizeLinear`), which runs on the
   standard CPU EP everywhere ORT runs - it does NOT depend on the
   `MatMulInteger` kernels that have historically been spotty on
   Windows ARM64. Transformers.js runs this exact file on those
   platforms today. Mitigation anyway: ship the fp32 `onnx/model.onnx`
   (90 MB) as a fallback, and if session creation OR the first
   `sess.Run` errors out, retry once with fp32. This mirrors the
   Transformers.js "pick smallest available dtype, fall back to fp32"
   pattern.

2. **Intel Mac (darwin/amd64)** - the v1.27.1 release dropped the
   `onnxruntime-osx-x86_64-accelerate` asset. Two options: (a) pin the
   ORT downloader to v1.26.0 for darwin/amd64 only (1.26 still ships
   the Intel Mac archive), or (b) document the embeddings build as
   Apple-silicon-only on macOS. The default pure-Go base binary is
   unaffected either way.

3. **Tokenizer parity** - `sugarme/tokenizer` is pure Go and pre-v1.
   Its WordPiece + NFD/lowercase/accent-strip normalization is a
   reimplementation of the HF fast tokenizer, not the library itself.
   Before trusting embeddings, run a fixed set of transcript lines
   through both `sugarme` and the reference Transformers.js output and
   assert token-ID equality. If parity fails on edge cases, swap to
   `github.com/daulet/tokenizers` v1.27.0 (it IS the HF Rust tokenizer,
   byte-exact) at the cost of a second CGO dep + a Rust toolchain to
   build `libtokenizers.a`.

4. **Shared-lib packaging burden** - on Linux, `SetSharedLibraryPath`
   must point at the versioned `libonnxruntime.so.1.27.1`, not the
   bare symlink. On macOS the dylib may carry `@rpath` install names;
   because we load by absolute path this is fine, but if you ever
   bundle it next to the binary and rely on `DYLD_LIBRARY_PATH`, sign
   and notarize appropriately. On Windows the DLL sits beside the exe
   or at an absolute path; no rpath concept.

5. **CGO re-enters the build** - enabling `-tags embeddings`
   reintroduces CGO, so the embeddings variant loses the free static
   cross-compile of the base binary. Build it on native runners
   (ubuntu/linux, macos/darwin, windows/windows) or with `zig cc` as a
   universal cross-compiler. Keep the default binary pure-Go so the
   mass-install path (`curl | sh`) never needs a C toolchain.

6. **`DestroyEnvironment` is process-global** - never call it on
   idle-unload; it tears the whole ORT runtime down and you cannot
   cleanly re-init it in the same process. Idle-unload destroys the
   SESSION and tensors only; the env lives until the daemon exits.

7. **HF Xet CDN** - the 302 `Location` is a signed, time-limited URL.
   `net/http` follows it automatically; do not cache it. If a download
   stalls for hours and the signed URL expires mid-resume, re-issue the
   `resolve` request to get a fresh one and continue the range append.

8. **Licensing** - ONNX Runtime is MIT; all-MiniLM-L6-v2 is Apache-2.0;
   `onnxruntime_go` is MIT; `sugarme/tokenizer` is MIT. All compatible
   with bundling and redistribution.

---

## 8. Verdict in one paragraph

Add embeddings as a `//go:build embeddings`-gated package built on
`github.com/yalue/onnxruntime_go` v1.31.0 (loads ORT v1.27.1 at
runtime) and `github.com/sugarme/tokenizer` v0.3.0 (pure-Go WordPiece),
storing vectors in the existing `modernc.org/sqlite/vec` `vec0` table.
Write two small lazy downloaders: one fetches the q8 ONNX +
`tokenizer.json` + configs from
`huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/<path>`,
verifying each file against the Hub's `x-linked-etag` header (which IS
the content sha256) with resumable HTTP-range appends; the other
fetches the per-GOOS/GOARCH ORT archive from GitHub Releases, extracts
just the shared lib, and hands its path to
`ort.SetSharedLibraryPath` before `ort.InitializeEnvironment`. The
existing TS cache under `data/models/...` is byte-identical to the Hub
(verified) and is reused offline as-is. The default `CGO_ENABLED=0`
binary stays pure-Go at ~10-18 MB; the tagged embeddings variant adds
<1 MB to the binary, pulls ~23 MB of weights + ~8-37 MB of shared lib
onto disk on first use, and sits at ~150-200 MB RSS only while the
session is live, dropping back to baseline after the 60s idle-unload.
