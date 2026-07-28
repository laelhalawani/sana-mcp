// Semantic dependencies are loaded only when semantic search is enabled and
// used, so keyword-only operations pay no model RAM/CPU cost.
import path from "node:path";
import { SQLiteError, type Database } from "bun:sqlite";
import { dataDirectory } from "../config.js";
import { RUNTIME_ENV } from "../runtime/env.js";
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
// Lines shorter than this many words are too noisy to embed and are skipped.
const MIN_WORDS = RUNTIME_ENV.embedMinWords;
// Warm load is ~150ms, so we keep the model in RAM only briefly after use.
const IDLE_UNLOAD_MS = RUNTIME_ENV.embedIdleMs;

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

async function embed(
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
  const [v] = await embed([text], signal);
  return toBuf(v);
}

// ---- sqlite-vec storage (lazy) -------------------------------------------

interface SqliteVecModule {
  load(db: Database, dataDirectory?: string): void;
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
        const createSchema = () =>
          db.exec(
            `CREATE VIRTUAL TABLE IF NOT EXISTS vec_lines USING vec0(
               embedding float[${EMBED_DIM}], meeting_id TEXT, line_no INTEGER, created_at INTEGER
             )`,
          );
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

/** Load the sqlite-vec extension into a connection and ensure the table. */
export async function ensureVec(
  db: Database,
  fence?: <Value>(operation: () => Value) => Value,
): Promise<void> {
  await ensureVectorExtension(db, fence);
}

/** Embed a meeting's lines (skipping trivially short ones) and store vectors. */
export async function embedMeeting(
  db: Database,
  meetingId: string,
  createdAtMs: number,
  lines: { n: number; text: string }[],
  commit: <Value>(write: () => Value) => Value,
): Promise<void> {
  await ensureVec(db, commit);
  const usable = lines.filter((l) => l.text.split(/\s+/).length >= MIN_WORDS);
  if (usable.length === 0) {
    commit(() => {
      db.prepare(`DELETE FROM vec_lines WHERE meeting_id = ?`).run(meetingId);
    });
    return;
  }

  const ins = db.prepare(
    `INSERT INTO vec_lines(embedding, meeting_id, line_no, created_at) VALUES (?, ?, ?, ?)`
  );
  const BATCH = 128;
  for (let i = 0; i < usable.length; i += BATCH) {
    const slice = usable.slice(i, i + BATCH);
    const vecs = await embed(slice.map((l) => l.text));
    commit(() => {
      if (i === 0) {
        db.prepare(`DELETE FROM vec_lines WHERE meeting_id = ?`).run(meetingId);
      }
      const tx = db.transaction(() => {
        for (let j = 0; j < slice.length; j++) {
          ins.run(toBuf(vecs[j]), meetingId, BigInt(slice[j].n), BigInt(createdAtMs));
        }
      });
      tx();
    });
  }
}

/** KNN search over stored line vectors. */
export async function searchKnn(
  db: Database,
  queryVec: Buffer,
  opts: {
    k: number;
    dateFrom?: number;
    dateTo?: number;
    fence?: <Value>(operation: () => Value) => Value;
  }
): Promise<{ meeting_id: string; line_no: number; distance: number }[]> {
  await ensureVec(db, opts.fence);
  const clauses = ["embedding MATCH @q"];
  const params: Bindings = { q: queryVec, k: BigInt(Math.max(1, opts.k)) };
  if (opts.dateFrom != null) {
    clauses.push("created_at >= @from");
    params.from = BigInt(opts.dateFrom);
  }
  if (opts.dateTo != null) {
    clauses.push("created_at <= @to");
    params.to = BigInt(opts.dateTo);
  }
  const read = () =>
    db
      .prepare(
        `SELECT meeting_id, CAST(line_no AS INTEGER) AS line_no, distance
         FROM vec_lines WHERE ${clauses.join(" AND ")} AND k = @k ORDER BY distance`,
      )
      .all(params) as {
      meeting_id: string;
      line_no: number;
      distance: number;
    }[];
  return opts.fence ? opts.fence(read) : read();
}
