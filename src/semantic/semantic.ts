// Optional semantic search. The embedding model and sqlite-vec are optional
// dependencies and are only loaded when semantic search is enabled AND used,
// so a base install pays no RAM/CPU cost. Enable with SANA_SEMANTIC=1.
import path from "node:path";
import type { Database } from "bun:sqlite";
import { DATA_DIR } from "../config.js";
import type { Bindings } from "../store/db.js";

export const EMBED_MODEL = process.env.SANA_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = Number(process.env.SANA_EMBED_DIM ?? 384);
// Lines shorter than this many words are too noisy to embed and are skipped.
const MIN_WORDS = Number(process.env.SANA_EMBED_MIN_WORDS ?? 5);
const MODELS_DIR = path.join(DATA_DIR, "models");
// Warm load is ~150ms, so we keep the model in RAM only briefly after use.
const IDLE_UNLOAD_MS = Number(process.env.SANA_EMBED_IDLE_MS ?? 60_000);

export function semanticEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SANA_SEMANTIC ?? "");
}

export class SemanticUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticUnavailableError";
  }
}

// ---- embedding model (lazy, idle-unloaded) --------------------------------

interface Pipe {
  (texts: string[], opts: Record<string, unknown>): Promise<{ data: Float32Array; dims: number[] }>;
  dispose?: () => Promise<void> | void;
}
let pipePromise: Promise<Pipe> | null = null;
let pipeRef: Pipe | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function loadPipe(): Promise<Pipe> {
  let mod: typeof import("@huggingface/transformers");
  try {
    mod = await import("@huggingface/transformers");
  } catch {
    throw new SemanticUnavailableError(
      'Semantic search dependencies are not installed. Run: npm install @huggingface/transformers sqlite-vec'
    );
  }
  const { pipeline, env } = mod;
  env.cacheDir = MODELS_DIR;
  env.allowRemoteModels = true;
  const pipe = (await pipeline("feature-extraction", EMBED_MODEL, {
    dtype: "q8",
  })) as unknown as Pipe;
  pipeRef = pipe;
  return pipe;
}

/** Free the model from RAM. Called automatically after an idle period. */
export async function unloadModel(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = pipeRef;
  pipePromise = null;
  pipeRef = null;
  if (p?.dispose) {
    try {
      await p.dispose();
    } catch {
      /* ignore */
    }
  }
}

function scheduleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void unloadModel(), IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!pipePromise) pipePromise = loadPipe();
  const pipe = await pipePromise;
  const out = await pipe(texts, { pooling: "mean", normalize: true });
  scheduleUnload(); // reset the idle timer on every use
  const dim = out.dims[out.dims.length - 1];
  const flat = out.data;
  const rows: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) rows.push(flat.slice(i * dim, (i + 1) * dim));
  return rows;
}

const toBuf = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Embed a single query string; returns a Float32 BLOB for sqlite-vec. */
export async function embedQuery(text: string): Promise<Buffer> {
  const [v] = await embed([text]);
  return toBuf(v);
}

// ---- sqlite-vec storage (lazy) -------------------------------------------

const vecLoaded = new WeakSet<Database>();

/** Load the sqlite-vec extension into a connection and ensure the table. */
export async function ensureVec(db: Database): Promise<void> {
  if (vecLoaded.has(db)) return;
  let sqliteVec: typeof import("sqlite-vec");
  try {
    sqliteVec = await import("sqlite-vec");
  } catch {
    throw new SemanticUnavailableError(
      'Semantic search dependencies are not installed. Run: npm install @huggingface/transformers sqlite-vec'
    );
  }
  sqliteVec.load(db);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_lines USING vec0(
       embedding float[${EMBED_DIM}], meeting_id TEXT, line_no INTEGER, created_at INTEGER
     )`
  );
  vecLoaded.add(db);
}

/** Embed a meeting's lines (skipping trivially short ones) and store vectors. */
export async function embedMeeting(
  db: Database,
  meetingId: string,
  createdAtMs: number,
  lines: { n: number; text: string }[]
): Promise<void> {
  await ensureVec(db);
  const usable = lines.filter((l) => l.text.split(/\s+/).length >= MIN_WORDS);
  db.prepare(`DELETE FROM vec_lines WHERE meeting_id = ?`).run(meetingId);
  if (usable.length === 0) return;

  const ins = db.prepare(
    `INSERT INTO vec_lines(embedding, meeting_id, line_no, created_at) VALUES (?, ?, ?, ?)`
  );
  const BATCH = 128;
  for (let i = 0; i < usable.length; i += BATCH) {
    const slice = usable.slice(i, i + BATCH);
    const vecs = await embed(slice.map((l) => l.text));
    const tx = db.transaction(() => {
      for (let j = 0; j < slice.length; j++) {
        ins.run(toBuf(vecs[j]), meetingId, BigInt(slice[j].n), BigInt(createdAtMs));
      }
    });
    tx();
  }
}

/** KNN search over stored line vectors. */
export async function searchKnn(
  db: Database,
  queryVec: Buffer,
  opts: { k: number; dateFrom?: number; dateTo?: number }
): Promise<{ meeting_id: string; line_no: number; distance: number }[]> {
  await ensureVec(db);
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
  return db
    .prepare(
      `SELECT meeting_id, CAST(line_no AS INTEGER) AS line_no, distance
       FROM vec_lines WHERE ${clauses.join(" AND ")} AND k = @k ORDER BY distance`
    )
    .all(params) as { meeting_id: string; line_no: number; distance: number }[];
}
