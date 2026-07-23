# Rust port - embedding (semantic search) runtime

Status: research, July 2026. All crate versions and APIs below were verified against crates.io, docs.rs, and source on 2026-07-23. Do not trust older memory - the Rust ML ecosystem churns fast and `hf-hub` 1.0 is a breaking redesign.

Goal: optional, lazy, idle-unloaded 384-dim embeddings of transcript lines for the existing hybrid (BM25 + sqlite-vec `vec0`) search, mirroring today's TypeScript behavior in `src/semantic/semantic.ts`:

- model `Xenova/all-MiniLM-L6-v2` (= `sentence-transformers/all-MiniLM-L6-v2`, a 6-layer / 384-hidden BERT)
- mean-pool over the sequence dim, then L2-normalize to unit length
- gated behind `SANA_SEMANTIC=1`, lazy-loaded on first search, idle-unloaded after ~60 s
- ~150 MB RAM while active today

The local TS cache (already on disk) lives at `data/models/Xenova/all-MiniLM-L6-v2/` and contains `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx` (90 MB, fp32), `onnx/model_quantized.onnx` (22 MB, INT8 q8).

---

## TL;DR recommendation

**Winner: `candle` + `hf-hub`**, gated behind a `semantic` cargo feature.

- Pure Rust runtime (`candle-core`/`candle-nn`/`candle-transformers` 0.11.0, `default-features = false`). No native shared library to ship, dlopen, or fetch per platform.
- `hf-hub` 1.0.0 (stable, released 2026-07-10) gives content-addressed, sha256-verified, resumable, dedup, offline-capable downloads with a blocking API. It is the lazy-download layer.
- Stable crates. The alternative (`ort` 2.0) has been release-candidate-only for 20+ months (rc.7 Oct 2024 through rc.12 Mar 2026) with no stable 2.0.
- The canonical candle BERT example already defaults to `sentence-transformers/all-MiniLM-L6-v2` and does attention-masked mean-pool + L2-norm matching `sentence_transformers` exactly. We reuse that code path.

Cost of choosing candle (disclosed honestly):

- candle cannot read ONNX. The existing `onnx/model_quantized.onnx` (22 MB) is useless to it. It must download `model.safetensors` (~87 MB fp32) from `sentence-transformers/all-MiniLM-L6-v2` once.
- `config.json` and `tokenizer.json` from the existing TS cache are reusable (they are format-agnostic). Only the weights are not.
- Embeddings drift very slightly versus the current q8-ONNX output (cosine ~0.999 after pooling). Negligible for transcript KNN, but a one-time re-embed of stored vectors after migration is the clean move.

`ort` is the strong runner-up. Pick it instead only if "do not re-download, do not re-embed, bit-match the TS vectors" outranks "clean single-binary distribution" for you. Its exact recipe is in the Runner-up section.

---

## The two levels of "lazy"

### Level 1 - lazy download of model files

Independent of the runtime. Use `hf-hub` 1.0 in both cases. It downloads from the canonical HuggingFace resolve URL:

```
https://huggingface.co/{owner}/{model}/resolve/{revision}/{filename}
```

- `revision` containing `/` (e.g. `refs/pr/21`) is percent-encoded as `refs%2Fpr%2F21` in the path.
- The CDN (302 redirect to `us.aws.cdn.hf.co`) advertises `Accept-Ranges` / `Content-Range`, so range/resume works, and returns `X-Linked-ETag` = the sha256. `hf-hub` stores blobs content-addressed by that hash and skips re-download when the blob is present and matches. Resumable on interruption; retries on transient failure.

`hf-hub` 1.0 cache layout (shares cleanly with Python `huggingface_hub`):

```
<hf_hub_cache>/models--<owner>--<name>/
    refs/<branch>            -> commit sha
    snapshots/<commit_sha>/  -> symlinks into blobs/
    blobs/<sha256>           -> real bytes
```

Point the cache inside the sana-mcp data dir so everything stays in one place:

```rust
let client = HFClientSync::builder()
    .cache_dir(data_dir.join("models").join("hf"))
    .build()?;
```

Offline reuse: set `HF_HUB_OFFLINE=1` (or call `cache_enabled(false)`), and `hf-hub` serves from the cache without touching the network. `HFClient::scan_cache` lets you inspect what is present.

### Level 2 - lazy/dynamic loading of the inference runtime

This is where the two runtimes diverge sharply.

- **candle**: the "runtime" is just Rust code compiled in when the `semantic` feature is on. Nothing is dlopen'd, nothing native ships. Loading the model = `mmap` the safetensors file (`VarBuilder::from_mmaped_safetensors`), which the OS pages in lazily and reclaims on `drop`. Idle-unload is literally dropping the `BertModel`.
- **ort**: ONNX Runtime is a C++ shared library (`libonnxruntime.so` / `onnxruntime.dll` / `libonnxruntime.dylib`). Two ways to get it:
  - default features (`download-binaries` + `copy-dylibs`): a prebuilt dylib is fetched at `cargo build` time and copied next to the binary. Adds a build-time network dependency and ships a ~15-40 MB native blob per target alongside the binary.
  - `load-dynamic` (`ort-sys/disable-linking` + `libloading`): the dylib is `dlopen`'d at runtime. ort does NOT auto-download it; you must locate or fetch the right per-platform binary and aim `ORT_DYLIB_PATH` at it. That is a real cross-platform footgun (glibc vs musl, x86_64 vs aarch64, Windows MSVC vs ARM, macOS arm64 vs x86). The `fetch-models` cargo feature in `ort` 2.0.0-rc.12 enables `ureq`+`sha2` but exposes **no** public download API - verified absent from `src/lib.rs` (no `download` module, no HuggingFace symbols). So with `ort` you still end up using `hf-hub` (or hand-rolled `ureq`/`reqwest`) for downloads, and you separately manage the dylib.

Verdict on Level 2: candle wins on simplicity and portability.

---

## Crate landscape, verified 2026-07-23

| Crate | Latest | Notes |
|---|---|---|
| `ort` | 2.0.0-rc.12 (2026-03-05) | Wraps ONNX Runtime 1.24. Still RC. MSRV 1.88. Last stable line is 1.16.x. |
| `ort` features of note | `download-binaries`, `copy-dylibs`, `load-dynamic`, `fetch-models` (no-op API), `tls-rustls` | default pulls a prebuilt dylib at build time. |
| `candle-core` / `candle-nn` / `candle-transformers` | 0.11.0 (2026-06-26) | `default-features = []` = pure CPU Rust. Stable. |
| `hf-hub` | 1.0.0 (2026-07-10) | **Breaking redesign**: `HFClient` / `HFClientBuilder` / `HFRepository<T>` replace the old `Api`/`ApiRepo`. reqwest-based, async, with a `blocking` feature. |
| `tokenizers` | 0.23.1 (2026-04-27) | Note: `candle-core` 0.11.0 hard-depends on `tokenizers ^0.22` (resolves to 0.22.2), so pin `0.22` in sana-mcp to match; 0.23 conflicts. |

Dependency-graph facts that shape the Cargo.toml:

- `candle-core` 0.11.0 hard-depends on `safetensors ^0.8`, `memmap2` (mmap), and `tokenizers ^0.22`. It does **not** depend on `hf-hub` at all - the hf-hub version is entirely sana-mcp's choice.
- `tokenizers`'s `http` feature pulls `hf-hub ^0.4` (old API). We do **not** enable it, so only our pinned `hf-hub` 1.0 ends up in the tree.
- `tokenizers` default features pull `onig` (Oniguruma, a vendored C regex lib). It is statically linked at build time - no runtime native dependency, just extra compile time. Set `default-features = false` if you want to drop it, but pre-tokenization for BERT wants a regex backend, so the practical choice is to keep it (or wire `fancy-regex`).

---

## Runtime comparison

### `ort` (ONNX Runtime)

Pros:

- Runs the **exact** `onnx/model_quantized.onnx` that transformers.js uses today, so embeddings are bit-for-bit the same as the TS pipeline. Stored vectors in `vec_lines` stay valid - no re-embedding.
- Reuses the entire existing on-disk TS cache as-is.
- ONNX Runtime INT8 kernels are heavily optimized on x86 (VNNI/AVX-512) and well-supported on aarch64 and Windows.

Cons:

- 2.0 is still RC (20+ months, no stable). A release-candidate ML runtime is a reliability liability for a tool users install locally.
- Requires the onnxruntime dylib. `download-binaries`+`copy-dylibs` bloats distribution and needs network at build (or a vendored dylib); `load-dynamic` forces you to fetch and locate the right dylib per platform at runtime. Either way, cross-compilation and distribution get noticeably harder.
- `fetch-models` exposes no usable download API; you bring your own downloader (i.e. `hf-hub`).

### `candle` + `hf-hub`

Pros:

- Pure Rust, `default-features = []`. Single distributable binary, trivial cross-compile, no dylib lifecycle.
- Stable crates.
- The reference `candle-examples/examples/bert/main.rs` defaults to `sentence-transformers/all-MiniLM-L6-v2` and performs attention-masked mean-pooling + L2-norm matching `sentence_transformers`. We adopt it verbatim.
- RAM is competitive or better: candle mmaps the 87 MB safetensors and touches ~90-110 MB resident during inference, whereas ONNX Runtime's arena allocator runs ~150 MB even for the 22 MB q8 model.
- `mmap` means idle weight pages are reclaimable by the OS - nice for idle-unload.

Cons:

- Cannot read ONNX. Must download `model.safetensors` (87 MB fp32) once. No prebuilt fp16 file exists on the repo (`model_fp16.safetensors` returns 404).
- Slight embedding drift vs q8-ONNX. Re-embed stored vectors once after migration (optional but clean).
- No INT8 path; CPU fp32 everywhere. Speed is fine for a 22 M-param model on transcript lines.

---

## Winner: candle + hf-hub

### Cargo.toml - everything optional, default feature-free

```toml
[dependencies]
# ...base deps (rusqlite, etc.) - no model cost
candle-core         = { version = "0.11", default-features = false, optional = true }
candle-nn           = { version = "0.11", default-features = false, optional = true }
candle-transformers = { version = "0.11", default-features = false, optional = true }
hf-hub              = { version = "1.0", features = ["blocking", "rustls-tls"], optional = true }
tokenizers          = { version = "0.22", default-features = false, optional = true }
anyhow              = { version = "1", optional = true }

[features]
default = []
# Flip on only for semantic search. Base binary links zero model code.
semantic = [
    "dep:candle-core",
    "dep:candle-nn",
    "dep:candle-transformers",
    "dep:hf-hub",
    "dep:tokenizers",
    "dep:anyhow",
]
```

Notes:

- `default = []` means a plain `cargo build` produces a binary with zero model cost. `cargo build --features semantic` opts in.
- `rustls-tls` avoids an OpenSSL/system-TLS dependency at both `hf-hub` and `tokenizers` (via `hf-hub?/rustls-tls`).
- `tokenizers = "0.22"` matches what `candle-core` 0.11 already compiles, so no duplicate versions.
- Keep `tokenizers` default features off if you want to drop the `onig` C build; otherwise enable them for the standard pre-tokenization regex backend.

### Lazy-download flow

Files needed (candle path) and where they come from:

| File | Size | Source repo | Reuse existing TS cache? |
|---|---|---|---|
| `model.safetensors` | ~87 MB (fp32) | `sentence-transformers/all-MiniLM-L6-v2`, rev `refs/pr/21` or `main` | No - candle cannot read the 22 MB `onnx/model_quantized.onnx`. |
| `tokenizer.json` | ~0.7 MB | same | Yes - it is the tokenizers-library format; the Xenova copy already on disk loads directly. |
| `config.json` | <1 KB | same | Yes - it is the BERT model config (384 hidden, 6 layers, 12 heads, 30522 vocab). |

Resolve URLs (revision `refs/pr/21` is the candle-canonical snapshot; `main` also works):

```
https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/refs%2Fpr%2F21/model.safetensors
https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/refs%2Fpr%2F21/tokenizer.json
https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/refs%2Fpr%2F21/config.json
```

Flow:

1. On first semantic request, compute a cache root, e.g. `data_dir/models/hf` (so it sits next to the legacy `data_dir/models/Xenova/...`).
2. Checksum + resume: let `hf-hub` do it. It writes `blobs/<sha256>`, verifies against `X-Linked-ETag`, resumes via HTTP range, and dedups. No manual sha2 code needed.
3. Progress: `hf-hub` 1.0 exposes a `progress` module; wire it to the existing CLI/MCP progress channel if desired.
4. Offline reuse: set `HF_HUB_OFFLINE=1` (or `cache_enabled(false)`); `hf-hub` serves snapshots from `blobs/` with no network.
5. Reuse the legacy TS cache: before downloading, look for `data_dir/models/Xenova/all-MiniLM-L6-v2/tokenizer.json` and `.../config.json` and pass those paths straight in. Only `model.safetensors` must be fetched fresh. (Optional: also re-fetch `tokenizer.json` from the sentence-transformers repo if you want to remove any doubt about tokenizer parity.)

### Tokenizer + mean-pool + L2-normalize (code sketch)

Adapted from `candle-examples/examples/bert/main.rs`. Order: tokenize batch -> pad -> tensors -> forward -> masked mean-pool -> L2-normalize -> `Vec<Vec<f32>>`.

```rust
// src/semantic/embed.rs
// Only compiled when `--features semantic`.
#![cfg(feature = "semantic")]

use std::path::Path;
use anyhow::{anyhow, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config};
use tokenizers::Tokenizer;

pub struct Embedder {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl Embedder {
    /// `weights` = model.safetensors path, `tok` = tokenizer.json path.
    pub fn load(weights: &Path, tok: &Path, cfg: &Config) -> Result<Self> {
        let device = Device::Cpu; // pure CPU
        // mmap: OS pages weights in lazily and reclaims them on drop.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights], DType::F32, &device)
                .map_err(|e| anyhow!("mmap weights: {e}"))?
        };
        let model = BertModel::load(vb, cfg).map_err(|e| anyhow!("model load: {e}"))?;
        let tokenizer = Tokenizer::from_file(tok)
            .map_err(|e| anyhow!("tokenizer load: {e}"))?;
        Ok(Self { model, tokenizer, device })
    }

    /// Returns one 384-dim unit vector per input text.
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let batch = texts.len();
        let enc = self.tokenizer
            .encode_batch(texts.to_vec(), true /* add special tokens */)
            .map_err(|e| anyhow!("encode: {e}"))?;

        let max_len = enc.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
        let (mut ids, mut mask, mut tids) = (
            Vec::with_capacity(batch * max_len),
            Vec::with_capacity(batch * max_len),
            Vec::with_capacity(batch * max_len),
        );
        for e in &enc {
            let n = e.get_ids().len();
            ids.extend_from_slice(e.get_ids());          // u32
            mask.extend_from_slice(e.get_attention_mask()); // u32 (0/1)
            tids.extend_from_slice(e.get_type_ids());    // u32
            for _ in n..max_len { ids.push(0); mask.push(0); tids.push(0); } // pad
        }

        let input_ids = Tensor::from_vec(ids,   (batch, max_len), &self.device)?;
        let attn       = Tensor::from_vec(mask, (batch, max_len), &self.device)?;
        let tok_type   = Tensor::from_vec(tids, (batch, max_len), &self.device)?;

        // [batch, seq, 384]
        let hidden = self.model
            .forward(&input_ids, &tok_type, Some(&attn))
            .map_err(|e| anyhow!("forward: {e}"))?;

        // attention-masked mean pool over the sequence axis
        let mask_f = attn.to_dtype(DType::F32)?.unsqueeze(2)?;     // [b, seq, 1]
        let summed = hidden.broadcast_mul(&mask_f)?.sum(1)?;       // [b, 384]
        let counts = mask_f.sum(1)?;                               // [b, 1]
        let pooled = summed.broadcast_div(&counts)?;               // [b, 384]

        // L2 normalize to unit length
        let norm = pooled.sqr()?.sum_keepdim(1)?.sqrt()?;
        let unit = pooled.broadcast_div(&norm.clamp_min(1e-12)?)?;

        let rows = unit.to_vec2::<f32>()?; // Vec<Vec<f32>> length batch, each len 384
        Ok(rows)
    }
}
```

Loading the config from the cached `config.json` (with a hardcoded fallback so it works even if the file is missing):

```rust
fn bert_config(config_json: &Path) -> Result<Config> {
    if config_json.is_file() {
        let s = std::fs::read_to_string(config_json)?;
        if let Ok(c) = serde_json::from_str::<Config>(&s) { return Ok(c); }
    }
    Ok(Config {
        vocab_size: 30522, num_hidden_layers: 6, num_attention_heads: 12,
        hidden_size: 384, intermediate_size: 1536, max_position_embeddings: 512,
        type_vocab_size: 2, layer_norm_eps: 1e-12,
        hidden_act: candle_transformers::models::bert::HiddenAct::Gelu,
        ..Default::default()
    })
}
```

Fetching the weights with `hf-hub` 1.0 blocking API:

```rust
use hf_hub::HFClientSync;

fn ensure_weights(data_dir: &Path) -> Result<std::path::PathBuf> {
    let client = HFClientSync::builder()
        .cache_dir(data_dir.join("models").join("hf"))
        .build()?;
    let repo = client.model("sentence-transformers", "all-MiniLM-L6-v2");
    let path = repo.download_file()
        .filename("model.safetensors")
        .send()?; // returns the cached snapshot path; sha256-verified, resumable
    Ok(path)
}
```

### Idle-unload after ~60 s

The model is just owned Rust behind a lock; dropping it unmaps the safetensors (OS reclaims the pages). Arm a 60 s idle timer that takes the lock and replaces the `Embedder` with `None`:

```rust
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct EmbedCache {
    inner: Arc<RwLock<Option<Embedder>>>,
}

impl EmbedCache {
    pub async fn get(&self) -> anyhow::Result<tokio::sync::RwLockReadGuard<'_, Option<Embedder>>> {
        // load lazily on first use (omitted), then schedule the idle timer below.
        unimplemented!()
    }

    /// Call after every embed(). Resets the 60 s countdown.
    fn schedule_unload(&self) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            // Drop the model. mmap pages are released by the OS.
            *inner.write().await = None;
        });
    }
}
```

If sana-mcp is not async, the same idea works with a `std::sync::Mutex<Option<Embedder>>` plus a single background thread sleeping on a condvar / channel timeout.

---

## Binary size and RAM

Approximate, release build, x86_64-linux:

| Configuration | Binary delta | Extra shipped files | Active RAM |
|---|---|---|---|
| Base, feature off | 0 | none | 0 (semantic code absent) |
| `--features semantic`, loaded | ~4-6 MB (candle + hf-hub/reqwest/rustls + tokenizers/onig) | none native (onig is statically linked at build) | ~90-110 MB (mmaped 87 MB weights + small activations) |
| `--features semantic`, idle (model dropped) | same | none | ~0 (pages evicted) |

For comparison, `ort` default features add ~3 MB of bindings plus a ~15-40 MB onnxruntime dylib shipped next to the binary, and runs ~150 MB resident (arena allocator) on the 22 MB q8 model.

---

## Risks and gotchas

- **Embedding drift / stored vectors.** candle fp32 vs TS q8-ONNX differ at the ~1e-3 level per component (cosine ~0.999 after pooling). KNN over transcript lines tolerates this, but for consistency run a one-time re-embed of `vec_lines` after switching runtimes (re-derive all meeting vectors with candle, same as `embedMeeting` does today).
- **Tokenizer parity.** The Xenova `tokenizer.json` and the sentence-transformers BERT tokenizer share the bert-base-uncased vocab and settings (`do_lower_case`, WordPiece, 512 max len, 30522 vocab). They should emit identical token ids. Verify by encoding a few probe strings and diffing ids before relying on the cached file.
- **Revision pinning.** Pin a specific revision (`refs/pr/21`, the candle-canonical one) so a re-download never silently changes weights. hf-hub snapshots are keyed by commit sha, so a pinned revision is reproducible.
- **No fp16 on CPU in practice.** `model_fp16.safetensors` is a 404 on the repo. You can cast fp32 weights to f16 at load (`DType::F16`), which halves mmap size, but x86 has no native fp16 math so candle upcasts to fp32 for compute - no speed gain, only lower resident size. Not worth it for a 22 M-param model.
- **512-token cap.** all-MiniLM truncates at 512. Transcript "lines" are short today, so this is fine; if you ever embed whole paragraphs, truncate or chunk.
- **`tokenizers`/`onig` build cost.** Keeping `tokenizers` default features pulls Oniguruma (vendored C, statically linked). Build time goes up; runtime distribution is unaffected. Disable defaults if your toolchain dislikes the C build.
- **MSRV.** `ort` 2.0-rc requires Rust 1.88; candle 0.11 has no published MSRV but tracks recent stable. Pin a recent stable toolchain in `rust-toolchain.toml`.
- **aarch64 / Windows.** candle is pure Rust and uniform across targets (no per-platform binary). This is its main operational advantage over `ort`, whose INT8 dylibs have spotty coverage on musl, aarch64-Windows, etc.
- **hf-hub 1.0 is a breaking redesign.** Any code snippet online using `ApiBuilder`/`api.repo()` is from the 0.x line (0.5.x and earlier) and will not compile against 1.0. Use `HFClient`/`HFClientSync` + `client.model(owner, name)` + `repo.download_file().filename(...).send()`.

---

## Runner-up: the `ort` recipe (if parity and zero re-download win)

Choose this when "reuse everything on disk, match the TS vectors exactly, never re-embed" is the top priority and you accept the dylib distribution burden.

```toml
[dependencies]
ort = { version = "=2.0.0-rc.12", default-features = false, features = [
    "ndarray", "tracing", "tls-rustls", "fetch-models"
], optional = true }
# Choose ONE of:
#   "download-binaries","copy-dylibs"  -> dylib fetched at build, shipped next to binary
#   "load-dynamic"                     -> dlopen at runtime; you supply ORT_DYLIB_PATH
hf-hub = { version = "1.0", features = ["blocking","rustls-tls"], optional = true }
tokenizers = { version = "0.22", optional = true }   # WordPiece, feeds ort

[features]
default = []
semantic = ["dep:ort", "dep:hf-hub", "dep:tokenizers"]
```

- Download target: `Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx` (22 MB, INT8) plus `tokenizer.json` and `config.json`, via `hf-hub`. ONNX Runtime executes the INT8 graph natively (dynamic-quantizeLinear / QDQ ops) - `ort` runs q8 models directly, no extra flag.
- The existing `data/models/Xenova/all-MiniLM-L6-v2/` cache is reusable as-is; have the loader check that path first, then fall back to `hf-hub`.
- Tokenize with the `tokenizers` crate, build `ort::value::Value::from_array` for `input_ids`, `attention_mask`, `token_type_ids`, run `session.run(...)`, then do mean-pool + L2-norm on the output tensor exactly as in the candle sketch.
- Vectors match the TS pipeline bit-for-bit, so no re-embedding is needed.

---

## References

- ort: https://docs.rs/ort/2.0.0-rc.12 , https://github.com/pykeio/ort
- candle BERT model: https://github.com/huggingface/candle/blob/main/candle-transformers/src/models/bert.rs
- candle BERT example (all-MiniLM-L6-v2, masked mean-pool + L2-norm): https://github.com/huggingface/candle/blob/main/candle-examples/examples/bert/main.rs
- hf-hub 1.0: https://docs.rs/hf-hub/1.0.0 , https://github.com/huggingface/hf-hub
- tokenizers: https://docs.rs/tokenizers/0.23.1 (sana-mcp pins 0.22 to match candle-core)
- HuggingFace resolve URL + cache layout: https://huggingface.co/docs/huggingface_hub/en/guides/cache
- Model card: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- Existing TS implementation: `src/semantic/semantic.ts`
