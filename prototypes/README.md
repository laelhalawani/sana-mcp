# Search investigation prototypes

Working code from the search investigation that produced the recommendation in
`../plan.md`. Kept because the measurements in that document came from these
programs, and a claim you cannot re-run is a claim you cannot trust later.

Compiled binaries and the 30 MB quantized model tensor were stripped; both are
regenerable (`go build`, and the model from Hugging Face).

## Go

| Path | What it establishes |
|---|---|
| `go/goproto` | The model2vec/potion encoder in Go, ~250 lines. Validated byte-identical to the Python reference (worst cosine agreement 1.00000000 over 42 texts). 11,024 docs/sec. This is the code to port into the rewrite. |
| `go/sqltest` | sqlite-vec running on pure-Go `modernc.org/sqlite`, and the `CGO_ENABLED=0` cross-compile check across all six targets. |
| `go/vecbench` | KNN timing: 20,000 x 512d vectors, k=10 in 26.4 ms. |
| `go/bench` | Retrieval benchmark harness. |
| `go/ncr` | `ncruces/go-sqlite3` (WASM) comparison - rejected, no FTS5 in the default build. |

`go/goproto/meta.json`, `vocab.txt`, `ref.txt` and `texts.txt` are the fixtures
the equivalence check runs against; `ref.txt` holds the Python reference vectors.

## Python

Reference implementations and evaluations, used to check the Go port and to
score candidates.

| Path | What it does |
|---|---|
| `python/m2v.py` | model2vec reference encoder, the oracle for the Go port |
| `python/minilm.py` | current all-MiniLM-L6-v2 baseline |
| `python/corpus.py`, `chunks.py` | builds the ASR-corrupted evaluation corpus |
| `python/bench.py`, `bench2.py` | retrieval scoring (R@1, R@3, MRR) |
| `python/hybrid.py` | dense / BM25 / RRF fusion comparison - the source of the finding that naive RRF *degrades* results |
| `python/phon.py` | double metaphone, soundex, Levenshtein, trigram Jaccard - the source of the finding that no string technique recovers "Fabrics" -> "Fabrik" |

## Caveat

The evaluation corpus is 24 chunks and 12 queries. It is directional, not
conclusive. Before committing to this architecture, rerun against the real
corpus with existing MiniLM vectors as the baseline - that is step 1 in
`../plan.md`.
