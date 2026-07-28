import path from "node:path";
import { Database } from "bun:sqlite";
import {
  PINNED_MODEL_ID,
  PINNED_MODEL_REVISION,
  createPinnedModelSnapshot,
  preparePinnedModelCache,
} from "./model-cache.js";
import { configureStandaloneTransformers } from "./standalone-runtime.js";
import { standaloneSemanticSmokeEvidence } from "./smoke-contract.js";
import {
  createPortableVectorSchema,
  portableKnn,
  vectorBackendForPlatform,
} from "./semantic.js";

interface SmokeTransformersModule {
  env: Parameters<typeof configureStandaloneTransformers>[0];
  pipeline: (
    task: "feature-extraction",
    model: string,
    options: Record<string, unknown>,
  ) => Promise<(texts: string[], options: Record<string, unknown>) => Promise<{
    data: Float32Array;
    dims: number[];
  }>>;
}

export async function runStandaloneSemanticSmoke(): Promise<void> {
  const root = process.env.SANA_SEMANTIC_SMOKE_ROOT;
  if (root === undefined || !path.isAbsolute(root)) {
    throw new Error("SANA_SEMANTIC_SMOKE_ROOT must name an isolated absolute directory");
  }
  const localModelRoot = await preparePinnedModelCache(path.join(root, "models"));
  const snapshot = createPinnedModelSnapshot(localModelRoot);
  const transformers = (await import(
    "@huggingface/transformers"
  )) as unknown as SmokeTransformersModule;
  let pipe: Awaited<ReturnType<SmokeTransformersModule["pipeline"]>>;
  try {
    await configureStandaloneTransformers(transformers.env, snapshot.root);
    pipe = await transformers.pipeline("feature-extraction", PINNED_MODEL_ID, {
      dtype: "q8",
      revision: PINNED_MODEL_REVISION,
      local_files_only: true,
    });
  } finally {
    snapshot.dispose();
  }
  const output = await pipe(
    [
      "Database indexes make vector search fast.",
      "The quarterly planning meeting starts tomorrow.",
    ],
    { pooling: "mean", normalize: true },
  );
  if (output.dims.length !== 2 || output.dims[0] !== 2 || output.dims[1] !== 384) {
    throw new Error(`Unexpected embedding shape: ${JSON.stringify(output.dims)}`);
  }

  const db = new Database(":memory:");
  try {
    const query = output.data.slice(0, 384);
    const vectorBackend = vectorBackendForPlatform();
    let nearest: { label: string; distance: number } | null;
    if (vectorBackend === "portable") {
      createPortableVectorSchema(db);
      const insert = db.prepare(
        `INSERT INTO vec_lines_portable
           (meeting_id, line_no, created_at, embedding)
         VALUES (?, ?, ?, ?)`,
      );
      for (let index = 0; index < 2; index++) {
        const vector = output.data.slice(index * 384, (index + 1) * 384);
        insert.run(
          `row-${index}`,
          1,
          index,
          Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        );
      }
      const hit = portableKnn(
        db,
        Buffer.from(query.buffer, query.byteOffset, query.byteLength),
        { k: 1 },
      )[0];
      nearest = hit
        ? { label: hit.meeting_id, distance: hit.distance }
        : null;
    } else {
      const sqliteVec = (await import("sqlite-vec")) as unknown as {
        load(db: Database, dataDirectory: string): void;
      };
      sqliteVec.load(db, root);
      db.exec("CREATE VIRTUAL TABLE smoke_vectors USING vec0(embedding float[384], label TEXT)");
      const insert = db.prepare(
        "INSERT INTO smoke_vectors(embedding, label) VALUES (?, ?)",
      );
      for (let index = 0; index < 2; index++) {
        const vector = output.data.slice(index * 384, (index + 1) * 384);
        insert.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), `row-${index}`);
      }
      nearest = db
        .query(
          "SELECT label, distance FROM smoke_vectors WHERE embedding MATCH ? AND k = 1 ORDER BY distance",
        )
        .get(Buffer.from(query.buffer, query.byteOffset, query.byteLength)) as
        | { label: string; distance: number }
        | null;
    }
    if (nearest?.label !== "row-0" || !Number.isFinite(nearest.distance)) {
      throw new Error("Compiled semantic KNN smoke returned an unexpected nearest row");
    }
    if (vectorBackend === "sqlite-vec") {
      const version = db.query("SELECT vec_version() AS version").get() as {
        version: string;
      };
      if (version.version !== "v0.1.9") {
        throw new Error(`Unexpected sqlite-vec version: ${version.version}`);
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        standaloneSemanticSmokeEvidence(vectorBackend),
      )}\n`,
    );
  } finally {
    db.close();
    const disposable = pipe as unknown as { dispose?: () => Promise<void> | void };
    await disposable.dispose?.();
  }
}
