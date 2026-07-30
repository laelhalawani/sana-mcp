// Semantic dependencies are loaded only when semantic search is enabled and
// used, so keyword-only operations pay no model RAM/CPU cost.
import path from "node:path";
import { SQLiteError, type Database } from "bun:sqlite";
import { dataDirectory } from "../config.js";
import { RUNTIME_ENV, SEMANTIC_DETAIL_MAX_WORDS } from "../runtime/env.js";
import { BUILD_INFO, type SemanticCapability } from "../runtime/build-info.js";
import type { Bindings } from "../store/db.js";
import {
  PINNED_MODEL_ID,
  PINNED_MODEL_REVISION,
  createPinnedModelSnapshot,
  downloadPinnedModelFile,
  preparePinnedModelCache,
} from "./model-cache.js";

export const EMBED_MODEL = RUNTIME_ENV.embedModel;
export const EMBED_DIM = RUNTIME_ENV.embedDimension;
export const SEMANTIC_INDEX_VERSION = 2;
// Lines shorter than this many words are too noisy to embed and are skipped.
const MIN_WORDS = RUNTIME_ENV.embedMinWords;
const LARGE_CHUNK_WORDS = 96;
const DETAIL_CHUNK_WORDS = SEMANTIC_DETAIL_MAX_WORDS;
// Warm load is ~150ms, so we keep the model in RAM only briefly after use.
const IDLE_UNLOAD_MS = RUNTIME_ENV.embedIdleMs;

export type SemanticChunkKind = "large" | "small";

export interface SemanticChunk {
  readonly kind: SemanticChunkKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface ChunkUnit {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly words: number;
}

function textWords(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean);
}

function lineUnits(
  line: { n: number; text: string },
  maximumWords: number,
): ChunkUnit[] {
  const words = textWords(line.text);
  const units: ChunkUnit[] = [];
  for (let index = 0; index < words.length; index += maximumWords) {
    const slice = words.slice(index, index + maximumWords);
    units.push({
      startLine: line.n,
      endLine: line.n,
      text: slice.join(" "),
      words: slice.length,
    });
  }
  return units;
}

function packChunks(
  units: readonly ChunkUnit[],
  kind: SemanticChunkKind,
  maximumWords: number,
  overlapUnits: number,
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let words = 0;
    while (
      end < units.length &&
      (end === start || words + units[end]!.words <= maximumWords)
    ) {
      words += units[end]!.words;
      end++;
    }
    const selected = units.slice(start, end);
    if (words >= MIN_WORDS) {
      chunks.push({
        kind,
        startLine: selected[0]!.startLine,
        endLine: selected.at(-1)!.endLine,
        text: selected.map((unit) => unit.text).join(" "),
      });
    }
    if (end >= units.length) break;
    start = Math.max(start + 1, end - overlapUnits);
  }
  return chunks;
}

/** Build thematic speaker-turn chunks and smaller overlapping detail chunks. */
export function semanticChunks(
  lines: readonly { n: number; speaker: string; text: string }[],
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start + 1;
    while (end < lines.length && lines[end]!.speaker === lines[start]!.speaker) {
      end++;
    }
    const turn = lines.slice(start, end);
    const largeUnits = turn.flatMap((line) => lineUnits(line, LARGE_CHUNK_WORDS));
    const detailUnits = turn.flatMap((line) => lineUnits(line, DETAIL_CHUNK_WORDS));
    chunks.push(
      ...packChunks(largeUnits, "large", LARGE_CHUNK_WORDS, 0),
      ...packChunks(detailUnits, "small", DETAIL_CHUNK_WORDS, 1),
    );
    start = end;
  }
  return chunks;
}

export interface SemanticUnavailableContext {
  readonly operation:
    | "transformers-import"
    | "model-cache"
    | "model-initialization"
    | "embedding-output"
    | "sqlite-vec-import"
    | "sqlite-vec-load"
    | "sqlite-vec-schema";
  readonly model?: string;
  readonly expectedDimension?: number;
  readonly actualDimension?: number | null;
  readonly expectedBatchSize?: number;
  readonly actualBatchSize?: number | null;
  readonly expectedValueCount?: number;
  readonly actualValueCount?: number | null;
}

export class SemanticUnavailableError extends Error {
  readonly context?: SemanticUnavailableContext;

  constructor(
    message: string,
    options: { readonly cause?: unknown; readonly context?: SemanticUnavailableContext } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SemanticUnavailableError";
    this.context = options.context;
  }
}

export type SemanticCapabilityState =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "unsupported"; message: string }>;

export function resolveSemanticCapability(
  requested: boolean,
  capability: SemanticCapability,
): SemanticCapabilityState {
  if (!requested) return { kind: "disabled" };
  if (capability === "source-semantic" || capability === "bundled") {
    return { kind: "available" };
  }
  return {
    kind: "unsupported",
    message:
      "This standalone build supports keyword search only; semantic search is available from source builds.",
  };
}

export function semanticCapabilityState(): SemanticCapabilityState {
  return resolveSemanticCapability(
    RUNTIME_ENV.semanticEnabled,
    BUILD_INFO.semanticCapability,
  );
}

export function semanticEnabled(): boolean {
  const state = semanticCapabilityState();
  return state.kind === "available";
}

// ---- embedding model (lazy, idle-unloaded) --------------------------------

export interface EmbeddingOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

export interface EmbeddingPipe {
  (texts: string[], opts: Record<string, unknown>): Promise<EmbeddingOutput>;
  dispose?: () => Promise<void> | void;
}

export interface TransformersModule {
  readonly env: {
    cacheDir: string | null;
    allowRemoteModels: boolean;
    localModelPath?: string;
    allowLocalModels?: boolean;
    useFSCache?: boolean;
    useWasmCache?: boolean;
    backends?: unknown;
  };
  readonly pipeline: (
    task: "feature-extraction",
    model: string,
    options: {
      readonly dtype: "q8";
      readonly revision?: string;
      readonly local_files_only?: boolean;
    },
  ) => Promise<unknown>;
}

function unavailable(
  message: string,
  context: SemanticUnavailableContext,
  cause: unknown,
): SemanticUnavailableError {
  return new SemanticUnavailableError(message, { cause, context });
}

export async function loadEmbeddingPipe(
  importTransformers: () => Promise<TransformersModule>,
  signal?: AbortSignal,
): Promise<EmbeddingPipe> {
  let mod: TransformersModule;
  try {
    mod = await importTransformers();
  } catch (cause) {
    if (cause instanceof SemanticUnavailableError) throw cause;
    throw unavailable(
      "Semantic search dependencies are not installed. Run: bun install",
      { operation: "transformers-import", model: EMBED_MODEL },
      cause,
    );
  }

  try {
    const { pipeline, env } = mod;
    let pipelineOptions: {
      dtype: "q8";
      revision?: string;
      local_files_only?: boolean;
    } = { dtype: "q8" };
    if (BUILD_INFO.standalone) {
      if (EMBED_MODEL !== PINNED_MODEL_ID || EMBED_DIM !== 384) {
        throw new TypeError(
          `Standalone semantic runtime requires ${PINNED_MODEL_ID} with dimension 384`,
        );
      }
      let localModelRoot: string;
      try {
        localModelRoot = await preparePinnedModelCache(
          path.join(dataDirectory(), "models"),
          (file) => downloadPinnedModelFile(file, { signal }),
        );
      } catch (cause) {
        throw unavailable(
          `Could not prepare the verified semantic model revision ${PINNED_MODEL_REVISION}.`,
          { operation: "model-cache", model: PINNED_MODEL_ID },
          cause,
        );
      }
      const snapshot = createPinnedModelSnapshot(localModelRoot);
      try {
        const { configureStandaloneTransformers } = await import(
          "./standalone-runtime.js"
        );
        await configureStandaloneTransformers(
          env as Parameters<typeof configureStandaloneTransformers>[0],
          snapshot.root,
        );
        pipelineOptions = {
          dtype: "q8",
          revision: PINNED_MODEL_REVISION,
          local_files_only: true,
        };
        const pipe = await pipeline(
          "feature-extraction",
          EMBED_MODEL,
          pipelineOptions,
        );
        if (typeof pipe !== "function") {
          throw new TypeError("the feature-extraction pipeline is not callable");
        }
        return pipe as EmbeddingPipe;
      } finally {
        snapshot.dispose();
      }
    } else {
      env.cacheDir = path.join(dataDirectory(), "models");
      env.allowRemoteModels = true;
    }
    const pipe = await pipeline(
      "feature-extraction",
      EMBED_MODEL,
      pipelineOptions,
    );
    if (typeof pipe !== "function") {
      throw new TypeError("the feature-extraction pipeline is not callable");
    }
    return pipe as EmbeddingPipe;
  } catch (cause) {
    if (cause instanceof SemanticUnavailableError) throw cause;
    throw unavailable(
      `Could not initialize semantic embedding model "${EMBED_MODEL}". Check model access and the local model cache, then retry.`,
      {
        operation: "model-initialization",
        model: EMBED_MODEL,
        expectedDimension: EMBED_DIM,
      },
      cause,
    );
  }
}

async function loadPipe(signal?: AbortSignal): Promise<EmbeddingPipe> {
  return loadEmbeddingPipe(
    async () => (await import("@huggingface/transformers")) as TransformersModule,
    signal,
  );
}

function outputError(
  problem: string,
  context: Omit<SemanticUnavailableContext, "operation" | "model">,
): SemanticUnavailableError {
  return unavailable(
    `Semantic embedding output from model "${EMBED_MODEL}" is incompatible: ${problem}.`,
    {
      operation: "embedding-output",
      model: EMBED_MODEL,
      expectedDimension: EMBED_DIM,
      ...context,
    },
    new Error(problem),
  );
}

/** Validate and split the pooled transformer output into one vector per input. */
export function validateEmbeddingOutput(
  output: unknown,
  batchSize: number,
): Float32Array[] {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw outputError(`the requested batch size ${String(batchSize)} is invalid`, {
      expectedBatchSize: batchSize,
      actualBatchSize: null,
      actualDimension: null,
      actualValueCount: null,
    });
  }
  const expectedValueCount = batchSize * EMBED_DIM;
  if (
    typeof output !== "object" ||
    output === null ||
    !("dims" in output) ||
    !Array.isArray(output.dims)
  ) {
    throw outputError("the output shape is missing", {
      expectedBatchSize: batchSize,
      actualBatchSize: null,
      actualDimension: null,
      expectedValueCount,
      actualValueCount: null,
    });
  }

  const dims = output.dims;
  const actualBatchSize =
    dims.length >= 1 && Number.isInteger(dims[0]) && dims[0] > 0 ? dims[0] : null;
  const actualDimension =
    dims.length >= 2 && Number.isInteger(dims[1]) && dims[1] > 0 ? dims[1] : null;
  if (
    dims.length !== 2 ||
    actualBatchSize !== batchSize ||
    actualDimension !== EMBED_DIM
  ) {
    const renderedShape = `[${dims
      .map((value) => (typeof value === "number" ? String(value) : typeof value))
      .join(", ")}]`;
    throw outputError(
      `expected shape [${batchSize}, ${EMBED_DIM}], received ${renderedShape}`,
      {
        expectedBatchSize: batchSize,
        actualBatchSize,
        actualDimension,
        expectedValueCount,
        actualValueCount:
          "data" in output && output.data instanceof Float32Array
            ? output.data.length
            : null,
      },
    );
  }

  if (!("data" in output) || !(output.data instanceof Float32Array)) {
    throw outputError("the vector data is not a Float32Array", {
      expectedBatchSize: batchSize,
      actualBatchSize,
      actualDimension,
      expectedValueCount,
      actualValueCount: null,
    });
  }
  const flat = output.data;
  if (flat.length !== expectedValueCount) {
    throw outputError(
      `expected ${expectedValueCount} vector values, received ${flat.length}`,
      {
        expectedBatchSize: batchSize,
        actualBatchSize,
        actualDimension,
        expectedValueCount,
        actualValueCount: flat.length,
      },
    );
  }
  for (let index = 0; index < flat.length; index++) {
    if (!Number.isFinite(flat[index])) {
      throw outputError(`vector value ${index} is not finite`, {
        expectedBatchSize: batchSize,
        actualBatchSize,
        actualDimension,
        expectedValueCount,
        actualValueCount: flat.length,
      });
    }
  }

  const rows: Float32Array[] = [];
  for (let index = 0; index < batchSize; index++) {
    rows.push(flat.slice(index * EMBED_DIM, (index + 1) * EMBED_DIM));
  }
  return rows;
}

export interface EmbeddingRuntime {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  unload(): Promise<void>;
}

export interface EmbeddingRuntimeOptions {
  readonly load: (signal?: AbortSignal) => Promise<EmbeddingPipe>;
  readonly idleMs: number;
  readonly cancelLoadWhenUnused?: boolean;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function waitWithSignal<Value>(
  promise: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Value>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/** Create the small lazy-load lifecycle used by production and deterministic tests. */
export function createEmbeddingRuntime(options: EmbeddingRuntimeOptions): EmbeddingRuntime {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let pipePromise: Promise<EmbeddingPipe> | null = null;
  let pipeRef: EmbeddingPipe | null = null;
  let loadController: AbortController | null = null;
  let loadWaiters = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let activeEmbeds = 0;
  let unloadPending = false;
  let inferenceTail: Promise<void> = Promise.resolve();

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  };

  const getPipe = async (signal?: AbortSignal): Promise<EmbeddingPipe> => {
    if (
      pipePromise === null ||
      (options.cancelLoadWhenUnused === true && loadController?.signal.aborted)
    ) {
      loadController = new AbortController();
      const attempt = options.load(loadController.signal);
      pipePromise = attempt;
      void attempt.then(
        (pipe) => {
          if (pipePromise === attempt) pipeRef = pipe;
        },
        () => {
          if (pipePromise === attempt) {
            pipePromise = null;
            pipeRef = null;
            loadController = null;
          }
        },
      );
    }
    const attempt = pipePromise;
    loadWaiters++;
    try {
      return await waitWithSignal(attempt, signal);
    } finally {
      loadWaiters--;
      if (
        options.cancelLoadWhenUnused === true &&
        loadWaiters === 0 &&
        pipePromise === attempt &&
        pipeRef === null
      ) {
        loadController?.abort();
      }
    }
  };

  const unload = async (): Promise<void> => {
    clearIdleTimer();
    if (activeEmbeds > 0) {
      unloadPending = true;
      return;
    }
    unloadPending = false;
    const pipe = pipeRef;
    loadController?.abort();
    loadController = null;
    pipePromise = null;
    pipeRef = null;
    if (pipe?.dispose) {
      try {
        await pipe.dispose();
      } catch {
        // Disposal is best-effort; the model has already been detached.
      }
    }
  };

  const scheduleUnload = (): void => {
    clearIdleTimer();
    idleTimer = setTimer(() => void unload(), options.idleMs);
    idleTimer.unref?.();
  };

  return {
    async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
      clearIdleTimer();
      activeEmbeds++;
      try {
        signal?.throwIfAborted();
        const pipe = await getPipe(signal);
        signal?.throwIfAborted();
        const previous = inferenceTail;
        let release!: () => void;
        inferenceTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          signal?.throwIfAborted();
          const output = await pipe(texts, { pooling: "mean", normalize: true });
          signal?.throwIfAborted();
          return validateEmbeddingOutput(output, texts.length);
        } finally {
          release();
        }
      } finally {
        activeEmbeds--;
        if (activeEmbeds === 0) {
          if (unloadPending) void unload();
          else scheduleUnload();
        }
      }
    },
    unload,
  };
}

const embeddingRuntime = createEmbeddingRuntime({
  load: loadPipe,
  idleMs: IDLE_UNLOAD_MS,
  cancelLoadWhenUnused: BUILD_INFO.standalone,
});

/** Free the model from RAM. Called automatically after an idle period. */
export async function unloadModel(): Promise<void> {
  await embeddingRuntime.unload();
}

export type EmbedTexts = (
  texts: string[],
  signal?: AbortSignal,
) => Promise<Float32Array[]>;

export async function embedTexts(
  texts: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  return embeddingRuntime.embed(texts, signal);
}

const toBuf = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Embed a single query string; returns a Float32 BLOB for sqlite-vec. */
export async function embedQuery(
  text: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const [v] = await embedTexts([text], signal);
  return toBuf(v);
}

// ---- sqlite-vec storage (lazy) -------------------------------------------

interface SqliteVecModule {
  load(db: Database, dataDirectory?: string): void;
}

export type VectorBackend = "sqlite-vec" | "portable";

export function vectorBackendForPlatform(
  platform: NodeJS.Platform = process.platform,
  target: string | null = BUILD_INFO.target,
): VectorBackend {
  return platform === "darwin" || target?.endsWith("-musl") === true
    ? "portable"
    : "sqlite-vec";
}

export function createPortableVectorSchema(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS vec_chunks_v2_portable (
       meeting_id TEXT NOT NULL,
       chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('large', 'small')),
       chunk_no INTEGER NOT NULL,
       start_line INTEGER NOT NULL,
       end_line INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       index_version INTEGER NOT NULL,
       embedding BLOB NOT NULL,
       PRIMARY KEY (meeting_id, chunk_kind, chunk_no)
      );
     CREATE INDEX IF NOT EXISTS idx_vec_chunks_v2_portable_created
       ON vec_chunks_v2_portable(created_at);
     CREATE INDEX IF NOT EXISTS idx_vec_chunks_v2_portable_kind
       ON vec_chunks_v2_portable(chunk_kind);
     DROP TABLE IF EXISTS vec_lines_portable;`,
  );
}

function decodeVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength !== EMBED_DIM * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `Stored semantic vector has ${bytes.byteLength} bytes; expected ${EMBED_DIM * Float32Array.BYTES_PER_ELEMENT}`,
    );
  }
  const copy = new Uint8Array(bytes);
  const vector = new Float32Array(copy.buffer);
  for (let index = 0; index < vector.length; index++) {
    if (!Number.isFinite(vector[index])) {
      throw new Error(`Stored semantic vector value ${index} is not finite`);
    }
  }
  return vector;
}

export interface SemanticHit {
  readonly meeting_id: string;
  readonly kind: SemanticChunkKind;
  readonly start_line: number;
  readonly end_line: number;
  readonly distance: number;
}

export async function portableKnn(
  db: Database,
  queryVec: Uint8Array,
  opts: {
    k: number;
    kind: SemanticChunkKind;
    dateFrom?: number;
    dateTo?: number;
    fence?: <Value>(operation: () => Value) => Value;
    signal?: AbortSignal;
    completedOnly?: boolean;
  },
): Promise<SemanticHit[]> {
  const query = decodeVector(queryVec);
  const clauses = [
    "v.rowid > $after",
    "v.chunk_kind = $kind",
    "v.index_version = $indexVersion",
  ];
  const baseParams: Bindings = {
    kind: opts.kind,
    indexVersion: SEMANTIC_INDEX_VERSION,
  };
  if (opts.completedOnly === true) {
    clauses.push(
      "e.dim = $dimension",
      "e.model = $model",
      "e.index_version = $indexVersion",
      "e.vector_backend = $backend",
    );
    baseParams.dimension = EMBED_DIM;
    baseParams.model = EMBED_MODEL;
    baseParams.backend = "portable";
  }
  if (opts.dateFrom != null) {
    clauses.push("v.created_at >= $dateFrom");
    baseParams.dateFrom = opts.dateFrom;
  }
  if (opts.dateTo != null) {
    clauses.push("v.created_at <= $dateTo");
    baseParams.dateTo = opts.dateTo;
  }
  const statement = db
    .prepare(
       `SELECT v.rowid, v.meeting_id, v.chunk_kind, v.start_line, v.end_line, v.embedding
        FROM vec_chunks_v2_portable v
        ${opts.completedOnly === true
          ? "JOIN line_embeddings e ON e.meeting_id = v.meeting_id"
          : ""}
       WHERE ${clauses.join(" AND ")}
        ORDER BY v.rowid
       LIMIT $batch`,
    );
  type PortableRow = {
    rowid: number;
    meeting_id: string;
    chunk_kind: SemanticChunkKind;
    start_line: number;
    end_line: number;
    embedding: Uint8Array;
  };
  const limit = Math.max(1, opts.k);
  const nearest: SemanticHit[] = [];
  const compare = (
    left: (typeof nearest)[number],
    right: (typeof nearest)[number],
  ): number =>
    left.distance - right.distance ||
    left.meeting_id.localeCompare(right.meeting_id) ||
    left.start_line - right.start_line ||
    left.end_line - right.end_line;
  const worse = (left: SemanticHit, right: SemanticHit): boolean =>
    compare(left, right) > 0;
  const swap = (left: number, right: number): void => {
    [nearest[left], nearest[right]] = [nearest[right]!, nearest[left]!];
  };
  const siftUp = (index: number): void => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!worse(nearest[index]!, nearest[parent]!)) break;
      swap(index, parent);
      index = parent;
    }
  };
  const siftDown = (index: number): void => {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < nearest.length && worse(nearest[left]!, nearest[worst]!)) worst = left;
      if (right < nearest.length && worse(nearest[right]!, nearest[worst]!)) worst = right;
      if (worst === index) return;
      swap(index, worst);
      index = worst;
    }
  };
  let after = 0;
  const batch = 256;
  for (;;) {
    opts.signal?.throwIfAborted();
    const read = () =>
      statement.all({
        ...baseParams,
        after,
        batch,
      }) as PortableRow[];
    const rows = opts.fence ? opts.fence(read) : read();
    if (rows.length === 0) break;
    after = rows.at(-1)!.rowid;
    for (const row of rows) {
      const candidate = decodeVector(row.embedding);
      let squaredDistance = 0;
      for (let index = 0; index < query.length; index++) {
        const delta = query[index]! - candidate[index]!;
        squaredDistance += delta * delta;
      }
      const hit: SemanticHit = {
        meeting_id: row.meeting_id,
        kind: row.chunk_kind,
        start_line: row.start_line,
        end_line: row.end_line,
        distance: Math.sqrt(squaredDistance),
      };
      if (nearest.length < limit) {
        nearest.push(hit);
        siftUp(nearest.length - 1);
      } else if (compare(hit, nearest[0]!) < 0) {
        nearest[0] = hit;
        siftDown(0);
      }
    }
    opts.signal?.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return nearest.sort(compare);
}

function isMissingVecModule(cause: unknown): boolean {
  if (
    !(cause instanceof SQLiteError) ||
    cause.message !== "no such module: vec0"
  ) {
    return false;
  }
  return cause.errno === 1;
}

export function createVectorExtensionRuntime(
  importSqliteVec: () => Promise<SqliteVecModule>,
): (
  db: Database,
  fence?: <Value>(operation: () => Value) => Value,
) => Promise<void> {
  const extensionLoaded = new WeakSet<Database>();
  const ready = new WeakSet<Database>();
  const pending = new WeakMap<Database, Promise<void>>();
  return async (
    db: Database,
    fence?: <Value>(operation: () => Value) => Value,
  ): Promise<void> => {
    if (ready.has(db)) return;
    const existing = pending.get(db);
    if (existing) return existing;

    const initialization = (async (): Promise<void> => {
      if (!extensionLoaded.has(db)) {
        let sqliteVec: SqliteVecModule;
        try {
          sqliteVec = await importSqliteVec();
        } catch (cause) {
          throw unavailable(
            "Semantic search dependencies are not installed. Run: bun install",
            { operation: "sqlite-vec-import" },
            cause,
          );
        }
        try {
          const load = () => sqliteVec.load(db, dataDirectory());
          if (fence) fence(load);
          else load();
        } catch (cause) {
          throw unavailable(
            "Could not load the sqlite-vec extension for semantic search. Check that sqlite-vec supports this platform and runtime.",
            { operation: "sqlite-vec-load" },
            cause,
          );
        }
        extensionLoaded.add(db);
      }
      try {
        const createSchema = (): void => {
          const existing = db.prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks_v2'`,
          ).get() as { sql: string } | null;
          if (existing !== null) {
            const dimension = /\bembedding\s+float\[(\d+)\]/iu.exec(existing.sql)?.[1];
            if (dimension === undefined) {
              throw new Error(
                "Existing sqlite-vec chunk schema does not declare an embedding dimension",
              );
            }
            if (Number(dimension) !== EMBED_DIM) {
              db.exec(`DROP TABLE vec_chunks_v2`);
              const markersExist = db.prepare(
                `SELECT 1 AS present
                 FROM sqlite_master
                 WHERE type = 'table' AND name = 'line_embeddings'`,
              ).get();
              if (markersExist !== null) {
                db.exec(
                  `DELETE FROM line_embeddings WHERE vector_backend = 'sqlite-vec'`,
                );
              }
            }
          }
          db.exec(
            `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_v2 USING vec0(
               embedding float[${EMBED_DIM}], meeting_id TEXT, chunk_kind TEXT,
               chunk_no INTEGER,
               start_line INTEGER, end_line INTEGER, created_at INTEGER,
               index_version INTEGER
              )`,
          );
          db.exec(`DROP TABLE IF EXISTS vec_lines`);
        };
        if (fence) fence(createSchema);
        else createSchema();
      } catch (cause) {
        if (isMissingVecModule(cause)) {
          throw unavailable(
            `Could not initialize semantic vector storage because sqlite-vec did not register the vec0 module.`,
            {
              operation: "sqlite-vec-schema",
              model: EMBED_MODEL,
              expectedDimension: EMBED_DIM,
            },
            cause,
          );
        }
        throw cause;
      }
      ready.add(db);
    })();
    pending.set(db, initialization);
    try {
      await initialization;
    } finally {
      if (pending.get(db) === initialization) pending.delete(db);
    }
  };
}

const ensureVectorExtension = createVectorExtensionRuntime(
  async () => import("sqlite-vec"),
);
const vectorBackends = new WeakMap<Database, VectorBackend>();

/** Load the sqlite-vec extension into a connection and ensure the table. */
export async function ensureVec(
  db: Database,
  fence?: <Value>(operation: () => Value) => Value,
): Promise<VectorBackend> {
  const existing = vectorBackends.get(db);
  if (existing) return existing;
  if (vectorBackendForPlatform() === "portable") {
    const createSchema = () => createPortableVectorSchema(db);
    if (fence) fence(createSchema);
    else createSchema();
    vectorBackends.set(db, "portable");
    return "portable";
  }
  await ensureVectorExtension(db, fence);
  vectorBackends.set(db, "sqlite-vec");
  return "sqlite-vec";
}

/** Embed one meeting's thematic and detail chunks, then publish them atomically. */
export async function embedMeeting(
  db: Database,
  meetingId: string,
  createdAtMs: number,
  transcriptFetchedMs: number,
  lines: { n: number; speaker: string; text: string }[],
  commit: <Value>(write: () => Value) => Value,
  embedBatch: EmbedTexts = embedTexts,
): Promise<void> {
  const backend = await ensureVec(db, commit);
  const table = backend === "sqlite-vec"
    ? "vec_chunks_v2"
    : "vec_chunks_v2_portable";
  const chunks = semanticChunks(lines);
  const ins = db.prepare(
    `INSERT INTO ${table}(
       embedding, meeting_id, chunk_kind, chunk_no, start_line, end_line,
       created_at, index_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const BATCH = 128;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < chunks.length; index += BATCH) {
    vectors.push(
      ...await embedBatch(
        chunks.slice(index, index + BATCH).map((chunk) => chunk.text),
      ),
    );
  }
  commit(() => {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM ${table} WHERE meeting_id = ?`).run(meetingId);
      const chunkNumbers: Record<SemanticChunkKind, number> = { large: 0, small: 0 };
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        ins.run(
          toBuf(vectors[index]!),
          meetingId,
          chunk.kind,
          BigInt(++chunkNumbers[chunk.kind]),
          BigInt(chunk.startLine),
          BigInt(chunk.endLine),
          BigInt(createdAtMs),
          BigInt(SEMANTIC_INDEX_VERSION),
        );
      }
      db.prepare(
        `INSERT INTO line_embeddings (
           meeting_id, dim, model, done_ms, transcript_fetched_ms, index_version,
           vector_backend
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           dim = excluded.dim,
           model = excluded.model,
           done_ms = excluded.done_ms,
           transcript_fetched_ms = excluded.transcript_fetched_ms,
           index_version = excluded.index_version,
           vector_backend = excluded.vector_backend`,
      ).run(
        meetingId,
        EMBED_DIM,
        EMBED_MODEL,
        Date.now(),
        transcriptFetchedMs,
        SEMANTIC_INDEX_VERSION,
        backend,
      );
    });
    tx();
  });
}

/** KNN search over one semantic chunk granularity. */
export async function searchKnn(
  db: Database,
  queryVec: Buffer,
  opts: {
    k: number;
    kind: SemanticChunkKind;
    dateFrom?: number;
    dateTo?: number;
    fence?: <Value>(operation: () => Value) => Value;
    signal?: AbortSignal;
  }
): Promise<SemanticHit[]> {
  const backend = await ensureVec(db, opts.fence);
  if (backend === "portable") {
    return portableKnn(db, queryVec, { ...opts, completedOnly: true });
  }
  const clauses = [
    "v.embedding MATCH @q",
    "v.chunk_kind = @kind",
    "v.index_version = @indexVersion",
    "e.dim = @dimension",
    "e.model = @model",
    "e.index_version = @indexVersion",
    "e.vector_backend = @backend",
  ];
  const storageClauses = [
    "v.chunk_kind = @kind",
    "v.index_version = @indexVersion",
  ];
  const storageParams: Bindings = {
    kind: opts.kind,
    indexVersion: BigInt(SEMANTIC_INDEX_VERSION),
  };
  const params: Bindings = {
    q: queryVec,
    kind: opts.kind,
    indexVersion: BigInt(SEMANTIC_INDEX_VERSION),
    dimension: BigInt(EMBED_DIM),
    model: EMBED_MODEL,
    backend,
    k: BigInt(Math.max(1, opts.k)),
  };
  if (opts.dateFrom != null) {
    clauses.push("v.created_at >= @from");
    storageClauses.push("v.created_at >= @from");
    params.from = BigInt(opts.dateFrom);
    storageParams.from = BigInt(opts.dateFrom);
  }
  if (opts.dateTo != null) {
    clauses.push("v.created_at <= @to");
    storageClauses.push("v.created_at <= @to");
    params.to = BigInt(opts.dateTo);
    storageParams.to = BigInt(opts.dateTo);
  }
  const read = () =>
    db
      .prepare(
        `SELECT v.meeting_id, v.chunk_kind AS kind,
                CAST(v.start_line AS INTEGER) AS start_line,
                CAST(v.end_line AS INTEGER) AS end_line, v.distance
         FROM vec_chunks_v2 v
         JOIN line_embeddings e ON e.meeting_id = v.meeting_id
         WHERE ${clauses.join(" AND ")} AND k = @k ORDER BY distance`,
      )
      .all(params) as SemanticHit[];
  opts.signal?.throwIfAborted();
  let rows = opts.fence ? opts.fence(read) : read();
  const requested = Math.max(1, opts.k);
  if (rows.length >= requested) return rows.slice(0, requested);
  const count = () => (
    db.prepare(
      `SELECT COUNT(*) AS count FROM vec_chunks_v2 v
       WHERE ${storageClauses.join(" AND ")}`,
    ).get(storageParams) as { count: number }
  ).count;
  const stored = opts.fence ? opts.fence(count) : count();
  let candidateCount = requested;
  while (candidateCount < stored && rows.length < requested) {
    opts.signal?.throwIfAborted();
    candidateCount = Math.min(stored, Math.max(candidateCount + 1, candidateCount * 2));
    params.k = BigInt(candidateCount);
    rows = opts.fence ? opts.fence(read) : read();
  }
  return rows.slice(0, requested);
}
