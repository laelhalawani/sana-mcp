import { describe, expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import {
  createEmbeddingRuntime,
  createPortableVectorSchema,
  createVectorExtensionRuntime,
  EMBED_DIM,
  EMBED_MODEL,
  ensureVec,
  loadEmbeddingPipe,
  portableKnn,
  resolveSemanticCapability,
  semanticChunks,
  SEMANTIC_INDEX_VERSION,
  searchKnn,
  SemanticUnavailableError,
  validateEmbeddingOutput,
  vectorBackendForPlatform,
} from "../../src/semantic/semantic.js";
import type {
  EmbeddingOutput,
  EmbeddingPipe,
  TransformersModule,
} from "../../src/semantic/semantic.js";
import { runSearch } from "../../src/core/search.js";
import {
  CacheOperationChangedError,
  type SanaStore,
} from "../../src/store/db.js";

describe("semantic build capability", () => {
  test("selects the portable vector backend only where Bun disables extensions", () => {
    expect(vectorBackendForPlatform("darwin", "bun-darwin-arm64")).toBe("portable");
    expect(vectorBackendForPlatform("linux", "bun-linux-x64-musl")).toBe("portable");
    expect(vectorBackendForPlatform("linux", "bun-linux-x64")).toBe("sqlite-vec");
    expect(vectorBackendForPlatform("win32", "bun-windows-x64")).toBe("sqlite-vec");
  });

  test("keeps an absent request disabled for every build capability", () => {
    expect(resolveSemanticCapability(false, "bundled")).toEqual({ kind: "disabled" });
    expect(resolveSemanticCapability(false, "source-semantic")).toEqual({
      kind: "disabled",
    });
  });

  test("allows explicit semantic mode in source and bundled builds", () => {
    expect(resolveSemanticCapability(true, "source-semantic")).toEqual({
      kind: "available",
    });
    expect(resolveSemanticCapability(true, "bundled")).toEqual({
      kind: "available",
    });
  });

  test("reports runtime semantic failure as truthful keyword degradation", async () => {
    const row = {
      meeting_id: "meeting-1",
      line_no: 1,
      text: "keyword result",
      created_at_ms: 1,
      name: "Fixture",
    };
    const store = {
      db: {},
      countLineMatches: () => 1,
      searchLines: () => [row],
    } as unknown as SanaStore;
    const result = await runSearch(
      store,
      { query: "keyword" },
      {
        semanticState: { kind: "available" },
        embedQuery: async () => {
          throw new SemanticUnavailableError("model unavailable");
        },
      },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.mode).toBe("keyword");
      expect(result.degradation).toEqual({
        code: "SEMANTIC_RUNTIME_UNAVAILABLE",
        message: "model unavailable",
        cause: {
          kind: "ERROR",
          name: "SemanticUnavailableError",
          message: "model unavailable",
        },
      });
      expect(result.rows).toEqual([row]);
    }
  });

  test("types unknown thrown semantic values without inventing a message", async () => {
    const store = {
      db: {},
      countLineMatches: () => 0,
      searchLines: () => [],
    } as unknown as SanaStore;
    const result = await runSearch(
      store,
      { query: "keyword" },
      {
        semanticState: { kind: "available" },
        embedQuery: async () => {
          throw 7;
        },
      },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.mode).toBe("keyword");
      expect(result.degradation).toEqual({
        code: "SEMANTIC_RUNTIME_ERROR",
        cause: { kind: "UNKNOWN_THROWN_VALUE" },
      });
    }
  });

  test("authentication changes after an embedding await are never downgraded", async () => {
    let changed = false;
    let keywordFallbacks = 0;
    const store = {
      db: {},
      assertCacheOperation: () => {
        if (changed) throw new CacheOperationChangedError();
      },
      withCacheOperation: (_guard: unknown, operation: () => unknown) =>
        operation(),
      countLineMatches: () => {
        keywordFallbacks++;
        return 0;
      },
      searchLines: () => [],
    } as unknown as SanaStore;
    const operation = runSearch(
      store,
      { query: "keyword" },
      {
        guard: {
          generation: 1,
          publicationToken: "11111111-1111-4111-8111-111111111111",
          userId: "user-a",
          workspaceId: "workspace-a",
        },
        semanticState: { kind: "available" },
        embedQuery: async () => {
          changed = true;
          return Buffer.alloc(
            EMBED_DIM * Float32Array.BYTES_PER_ELEMENT,
          );
        },
      },
    );
    await expect(operation).rejects.toBeInstanceOf(
      CacheOperationChangedError,
    );
    expect(keywordFallbacks).toBe(0);
  });

  test("resolves semantic candidates from canonical indexed lines without reparsing transcripts", async () => {
    const row = {
      meeting_id: "meeting-1",
      line_no: 1,
      text: "keyword result",
      created_at_ms: 1,
      name: "Fixture",
    };
    const store = {
      db: {},
      countLineMatches: () => 1,
      searchLines: () => [row],
      resolveSearchLines: () => [row],
    } as unknown as SanaStore;

    const result = await runSearch(
      store,
      { query: "keyword" },
      {
        semanticState: { kind: "available" },
        embedQuery: async () => Buffer.alloc(EMBED_DIM * Float32Array.BYTES_PER_ELEMENT),
        searchKnn: async (_db, _query, options) => [{
          meeting_id: row.meeting_id,
          kind: options.kind,
          start_line: row.line_no,
          end_line: row.line_no,
          distance: 0,
        }],
      },
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.mode).toBe("hybrid");
      expect(result.rows).toEqual([row]);
      expect(result.total).toBe(1);
      expect(result.degradation).toBeUndefined();
    }
  });

  test("orders combined BM25, thematic, and detail evidence by the requested tiers", async () => {
    const rows = ["bls", "bl", "bs", "ls"].map((id, index) => ({
      meeting_id: id,
      line_no: 1,
      text: `${id} result`,
      created_at_ms: index + 1,
      name: id.toUpperCase(),
    }));
    const byId = new Map(rows.map((row) => [row.meeting_id, row]));
    const store = {
      db: {},
      searchLines: () => [byId.get("bs"), byId.get("bl"), byId.get("bls")],
      resolveSearchLines: (refs: Array<{ meeting_id: string }>) =>
        refs.flatMap((ref) => byId.get(ref.meeting_id) ?? []),
    } as unknown as SanaStore;

    const result = await runSearch(
      store,
      { query: "result", limit: 10 },
      {
        semanticState: { kind: "available" },
        embedQuery: async () => Buffer.alloc(EMBED_DIM * Float32Array.BYTES_PER_ELEMENT),
        searchKnn: async (_db, _query, options) => {
          const ids = options.kind === "small"
            ? ["bs", "ls", "bls"]
            : ["bl", "ls", "bls"];
          return ids.map((id, index) => ({
            meeting_id: id,
            kind: options.kind,
            start_line: 1,
            end_line: 1,
            distance: index,
          }));
        },
      },
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.rows.map((row) => row.meeting_id)).toEqual([
        "bls",
        "ls",
        "bl",
        "bs",
      ]);
    }
  });
});

describe("semantic transcript chunking", () => {
  test("merges consecutive speech by one speaker and keeps smaller detail windows", () => {
    const chunks = semanticChunks([
      { n: 1, speaker: "Person 1", text: "Hi." },
      { n: 2, speaker: "Person 1", text: "How's it going?" },
      { n: 3, speaker: "Person 1", text: "I haven't seen you in a while." },
      { n: 4, speaker: "Person 2", text: "Hey, it's all good today." },
    ]);

    expect(chunks.filter((chunk) => chunk.kind === "large")).toEqual([
      {
        kind: "large",
        startLine: 1,
        endLine: 3,
        text: "Hi. How's it going? I haven't seen you in a while.",
      },
      {
        kind: "large",
        startLine: 4,
        endLine: 4,
        text: "Hey, it's all good today.",
      },
    ]);
    expect(chunks.filter((chunk) => chunk.kind === "small")).toEqual([
      {
        kind: "small",
        startLine: 1,
        endLine: 3,
        text: "Hi. How's it going? I haven't seen you in a while.",
      },
      {
        kind: "small",
        startLine: 4,
        endLine: 4,
        text: "Hey, it's all good today.",
      },
    ]);
  });

  test("uses overlapping detail windows and leaves tiny turns to BM25", () => {
    const longTurn = Array.from({ length: 6 }, (_, index) => ({
      n: index + 1,
      speaker: "Speaker",
      text: Array.from({ length: 10 }, (__, word) => `w${index}-${word}`).join(" "),
    }));
    const details = semanticChunks(longTurn).filter((chunk) => chunk.kind === "small");
    expect(details.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 3],
      [3, 5],
      [5, 6],
    ]);
    expect(semanticChunks([
      { n: 1, speaker: "Speaker", text: "one two three" },
    ])).toEqual([]);
  });
});

function output(batchSize: number, dimension = EMBED_DIM): EmbeddingOutput {
  return {
    data: new Float32Array(batchSize * dimension).fill(0.25),
    dims: [batchSize, dimension],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("semantic embedding validation", () => {
  test("accepts only an exact batch and configured dimension", () => {
    const rows = validateEmbeddingOutput(output(2), 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(EMBED_DIM);
    expect(rows[1]).toHaveLength(EMBED_DIM);
  });

  test.each([
    {
      name: "dimension mismatch",
      value: output(1, EMBED_DIM + 1),
      actualDimension: EMBED_DIM + 1,
    },
    {
      name: "batch mismatch",
      value: output(2),
      actualDimension: EMBED_DIM,
    },
    {
      name: "flat length mismatch",
      value: {
        data: new Float32Array(EMBED_DIM - 1),
        dims: [1, EMBED_DIM],
      },
      actualDimension: EMBED_DIM,
    },
    {
      name: "missing shape",
      value: { data: new Float32Array(EMBED_DIM) },
      actualDimension: null,
    },
  ])("rejects $name with typed expected/actual context", ({ value, actualDimension }) => {
    try {
      validateEmbeddingOutput(value, 1);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticUnavailableError);
      const semanticError = error as SemanticUnavailableError;
      expect(semanticError.context?.operation).toBe("embedding-output");
      expect(semanticError.context?.model).toBe(EMBED_MODEL);
      expect(semanticError.context?.expectedDimension).toBe(EMBED_DIM);
      expect(semanticError.context?.actualDimension).toBe(actualDimension);
      expect(semanticError.cause).toBeInstanceOf(Error);
    }
  });

  test("rejects non-finite vector values", () => {
    const invalid = output(1);
    invalid.data[5] = Number.NaN;
    expect(() => validateEmbeddingOutput(invalid, 1)).toThrow(
      /vector value 5 is not finite/,
    );
  });
});

describe("semantic embedding lifecycle", () => {
  test("shares a successful load and clears the idle timer at the next embed start", async () => {
    let loads = 0;
    let clears = 0;
    let scheduled: (() => void) | null = null;
    const timer = { unref() {} } as ReturnType<typeof setTimeout>;
    const pipe: EmbeddingPipe = async (texts) => output(texts.length);
    const runtime = createEmbeddingRuntime({
      load: async () => {
        loads++;
        return pipe;
      },
      idleMs: 10,
      setTimer: (callback) => {
        scheduled = callback;
        return timer;
      },
      clearTimer: () => {
        clears++;
      },
    });

    await runtime.embed(["first"]);
    expect(scheduled).not.toBeNull();
    await runtime.embed(["second"]);
    expect(loads).toBe(1);
    expect(clears).toBe(1);
    await runtime.unload();
  });

  test("resets a rejected load so a later embed can retry", async () => {
    const firstFailure = new Error("model cache temporarily unavailable");
    const pipe: EmbeddingPipe = async (texts) => output(texts.length);
    let loads = 0;
    const runtime = createEmbeddingRuntime({
      load: async () => {
        loads++;
        if (loads === 1) throw firstFailure;
        return pipe;
      },
      idleMs: 60_000,
    });

    await expect(runtime.embed(["first"])).rejects.toBe(firstFailure);
    await expect(runtime.embed(["second"])).resolves.toHaveLength(1);
    expect(loads).toBe(2);
    await runtime.unload();
  });

  test("does not duplicate a concurrent load or dispose during an active embed", async () => {
    const load = deferred<EmbeddingPipe>();
    const execution = deferred<EmbeddingOutput>();
    let loads = 0;
    let disposals = 0;
    const pipe: EmbeddingPipe = Object.assign(
      async () => execution.promise,
      {
        dispose: () => {
          disposals++;
        },
      },
    );
    const runtime = createEmbeddingRuntime({
      load: () => {
        loads++;
        return load.promise;
      },
      idleMs: 60_000,
    });

    const first = runtime.embed(["first"]);
    const second = runtime.embed(["second"]);
    expect(loads).toBe(1);
    load.resolve(pipe);
    await Promise.resolve();
    await runtime.unload();
    expect(disposals).toBe(0);

    execution.resolve(output(1));
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(disposals).toBe(1);
  });

  test("does not cancel a shared load while another caller still awaits it", async () => {
    const load = deferred<EmbeddingPipe>();
    const controller = new AbortController();
    let loadSignal: AbortSignal | undefined;
    const pipe: EmbeddingPipe = async (texts) => output(texts.length);
    const runtime = createEmbeddingRuntime({
      load: (signal) => {
        loadSignal = signal;
        return load.promise;
      },
      idleMs: 60_000,
      cancelLoadWhenUnused: true,
    });

    const cancelled = runtime.embed(["cancelled"], controller.signal);
    const continuing = runtime.embed(["continuing"]);
    controller.abort(new Error("search cancelled"));
    await expect(cancelled).rejects.toThrow("search cancelled");
    expect(loadSignal?.aborted).toBe(false);
    load.resolve(pipe);
    await expect(continuing).resolves.toHaveLength(1);
    await runtime.unload();
  });

  test("restarts an abandoned cancelable load for a replacement caller", async () => {
    const loads = [deferred<EmbeddingPipe>(), deferred<EmbeddingPipe>()];
    const signals: AbortSignal[] = [];
    let loadIndex = 0;
    const pipe: EmbeddingPipe = async (texts) => output(texts.length);
    const runtime = createEmbeddingRuntime({
      load: (signal) => {
        if (signal) signals.push(signal);
        return loads[loadIndex++]!.promise;
      },
      idleMs: 60_000,
      cancelLoadWhenUnused: true,
    });
    const controller = new AbortController();

    const cancelled = runtime.embed(["cancelled"], controller.signal);
    controller.abort(new Error("search cancelled"));
    await expect(cancelled).rejects.toThrow("search cancelled");
    expect(signals[0]!.aborted).toBe(true);

    const replacement = runtime.embed(["replacement"]);
    expect(loadIndex).toBe(2);
    loads[1]!.resolve(pipe);
    await expect(replacement).resolves.toHaveLength(1);
    loads[0]!.reject(new Error("abandoned load"));
    await runtime.unload();
  });

  test("serializes inference against the shared WASM pipeline", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases = [deferred<EmbeddingOutput>(), deferred<EmbeddingOutput>()];
    let call = 0;
    const pipe: EmbeddingPipe = async () => {
      const index = call++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await releases[index].promise;
      } finally {
        active--;
      }
    };
    const runtime = createEmbeddingRuntime({
      load: async () => pipe,
      idleMs: 60_000,
    });
    const first = runtime.embed(["first"]);
    const second = runtime.embed(["second"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toBe(1);
    releases[0].resolve(output(1));
    await first;
    await Promise.resolve();
    expect(call).toBe(2);
    releases[1].resolve(output(1));
    await second;
    expect(maximumActive).toBe(1);
    await runtime.unload();
  });
});

describe("semantic optional dependency boundaries", () => {
  test("rebuilds sqlite-vec chunk storage when its fixed dimension is stale", async () => {
    if (vectorBackendForPlatform() !== "sqlite-vec") return;
    const db = new Database(":memory:", { strict: true });
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(db);
      db.exec(
        `CREATE VIRTUAL TABLE vec_chunks_v2 USING vec0(
           embedding float[${EMBED_DIM + 1}], meeting_id TEXT
         );
         CREATE TABLE line_embeddings (
           meeting_id TEXT PRIMARY KEY,
           vector_backend TEXT NOT NULL
         );
         INSERT INTO line_embeddings VALUES ('meeting', 'sqlite-vec')`,
      );
      const ensure = createVectorExtensionRuntime(async () => sqliteVec);
      await ensure(db);
      const schema = db.prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'vec_chunks_v2'`,
      ).get() as { sql: string };
      expect(schema.sql).toContain(`embedding float[${EMBED_DIM}]`);
      expect(schema.sql).not.toContain(`embedding float[${EMBED_DIM + 1}]`);
      expect(
        (db.prepare(`SELECT COUNT(*) AS count FROM line_embeddings`).get() as {
          count: number;
        }).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("production KNN exposes vectors only after the matching backend marker is complete", async () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.exec(
        `CREATE TABLE line_embeddings (
           meeting_id TEXT PRIMARY KEY,
           dim INTEGER NOT NULL,
           model TEXT NOT NULL,
           done_ms INTEGER NOT NULL,
           transcript_fetched_ms INTEGER NOT NULL,
           index_version INTEGER NOT NULL,
           vector_backend TEXT NOT NULL
         )`,
      );
      const backend = await ensureVec(db);
      const vector = Buffer.from(new Float32Array(EMBED_DIM).buffer);
      const farther = new Float32Array(EMBED_DIM);
      farther[0] = 1;
      const table = backend === "sqlite-vec"
        ? "vec_chunks_v2"
        : "vec_chunks_v2_portable";
      const insert = db.prepare(
        `INSERT INTO ${table} (
           embedding, meeting_id, chunk_kind, chunk_no, start_line, end_line,
           created_at, index_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(vector, "meeting", "large", 1, 3, 5, 10, SEMANTIC_INDEX_VERSION);
      insert.run(
        Buffer.from(farther.buffer),
        "valid",
        "large",
        1,
        7,
        8,
        10,
        SEMANTIC_INDEX_VERSION,
      );
      expect(await searchKnn(db, vector, { k: 1, kind: "large" })).toEqual([]);

      db.prepare(
        `INSERT INTO line_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "valid",
        EMBED_DIM,
        EMBED_MODEL,
        1,
        1,
        SEMANTIC_INDEX_VERSION,
        backend,
      );
      expect(await searchKnn(db, vector, { k: 1, kind: "large" })).toEqual([{
        meeting_id: "valid",
        kind: "large",
        start_line: 7,
        end_line: 8,
        distance: 1,
      }]);

      db.prepare(
        `INSERT INTO line_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "meeting",
        EMBED_DIM,
        EMBED_MODEL,
        1,
        1,
        SEMANTIC_INDEX_VERSION,
        backend,
      );
      expect(await searchKnn(db, vector, { k: 1, kind: "large" })).toEqual([{
        meeting_id: "meeting",
        kind: "large",
        start_line: 3,
        end_line: 5,
        distance: 0,
      }]);
    } finally {
      db.close();
    }
  });

  test("portable vector storage returns the nearest persisted embedding", async () => {
    const db = new Database(":memory:", { strict: true });
    try {
      createPortableVectorSchema(db);
      const first = new Float32Array(EMBED_DIM);
      const second = new Float32Array(EMBED_DIM);
      first[0] = 1;
      second[1] = 1;
      const insert = db.prepare(
        `INSERT INTO vec_chunks_v2_portable
           (meeting_id, chunk_kind, chunk_no, start_line, end_line, created_at, index_version, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("first", "small", 1, 1, 1, 10, SEMANTIC_INDEX_VERSION, Buffer.from(first.buffer));
      insert.run("second", "small", 1, 2, 2, 20, SEMANTIC_INDEX_VERSION, Buffer.from(second.buffer));

      expect(await portableKnn(db, Buffer.from(first.buffer), { k: 1, kind: "small" })).toEqual([
        { meeting_id: "first", kind: "small", start_line: 1, end_line: 1, distance: 0 },
      ]);
      expect(
        await portableKnn(db, Buffer.from(first.buffer), {
          k: 2,
          kind: "small",
          dateFrom: 15,
        }),
      ).toEqual([
        {
          meeting_id: "second",
          kind: "small",
          start_line: 2,
          end_line: 2,
          distance: Math.sqrt(2),
        },
      ]);

      db.exec(
        `CREATE TABLE line_embeddings (
           meeting_id TEXT PRIMARY KEY,
           dim INTEGER NOT NULL,
           model TEXT NOT NULL,
           done_ms INTEGER NOT NULL,
           transcript_fetched_ms INTEGER NOT NULL,
           index_version INTEGER NOT NULL,
           vector_backend TEXT NOT NULL
         )`,
      );
      expect(await portableKnn(db, Buffer.from(first.buffer), {
        k: 1,
        kind: "small",
        completedOnly: true,
      })).toEqual([]);
      db.prepare(`INSERT INTO line_embeddings VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "first",
        EMBED_DIM,
        EMBED_MODEL,
        1,
        1,
        SEMANTIC_INDEX_VERSION,
        "portable",
      );
      expect(await portableKnn(db, Buffer.from(first.buffer), {
        k: 1,
        kind: "small",
        completedOnly: true,
      })).toEqual([{
        meeting_id: "first",
        kind: "small",
        start_line: 1,
        end_line: 1,
        distance: 0,
      }]);
    } finally {
      db.close();
    }
  });

  test("portable KNN scans in bounded fenced batches and keeps only top k", async () => {
    const db = new Database(":memory:", { strict: true });
    try {
      createPortableVectorSchema(db);
      const insert = db.prepare(
        `INSERT INTO vec_chunks_v2_portable
           (meeting_id, chunk_kind, chunk_no, start_line, end_line, created_at, index_version, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 0; index < 300; index++) {
        const vector = new Float32Array(EMBED_DIM);
        vector[0] = 300 - index;
        insert.run(
          `row-${index}`,
          "small",
          index + 1,
          index + 1,
          index + 1,
          index,
          SEMANTIC_INDEX_VERSION,
          Buffer.from(vector.buffer),
        );
      }
      const query = new Float32Array(EMBED_DIM);
      let fences = 0;

      expect(
        await portableKnn(db, Buffer.from(query.buffer), {
          k: 2,
          kind: "small",
          fence: (read) => {
            fences++;
            return read();
          },
        }),
      ).toEqual([
        { meeting_id: "row-299", kind: "small", start_line: 300, end_line: 300, distance: 1 },
        { meeting_id: "row-298", kind: "small", start_line: 299, end_line: 299, distance: 2 },
      ]);
      expect(fences).toBe(3);
    } finally {
      db.close();
    }
  });

  test("portable KNN observes cancellation between bounded batches", async () => {
    const db = new Database(":memory:", { strict: true });
    try {
      createPortableVectorSchema(db);
      const insert = db.prepare(
        `INSERT INTO vec_chunks_v2_portable
           (meeting_id, chunk_kind, chunk_no, start_line, end_line, created_at, index_version, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const vector = Buffer.from(new Float32Array(EMBED_DIM).buffer);
      for (let index = 0; index < 300; index++) {
        insert.run(
          `row-${index}`,
          "large",
          index + 1,
          index + 1,
          index + 1,
          index,
          SEMANTIC_INDEX_VERSION,
          vector,
        );
      }
      const controller = new AbortController();
      const cancelled = new Error("search cancelled");

      await expect(portableKnn(db, vector, {
        k: 10,
        kind: "large",
        signal: controller.signal,
        fence: (read) => {
          const rows = read();
          controller.abort(cancelled);
          return rows;
        },
      })).rejects.toBe(cancelled);
    } finally {
      db.close();
    }
  });

  test("post-import vector load and schema creation run inside the supplied fence", async () => {
    const events: string[] = [];
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        events.push("schema");
      },
    };
    const ensure = createVectorExtensionRuntime(async () => {
      events.push("import");
      return {
        load: () => {
          events.push("load");
        },
      };
    });
    const fence = <Value>(operation: () => Value): Value => {
      events.push("fence:start");
      const result = operation();
      events.push("fence:end");
      return result;
    };
    await ensure(db as never, fence);
    expect(events).toEqual([
      "import",
      "fence:start",
      "load",
      "fence:end",
      "fence:start",
      "schema",
      "schema",
      "fence:end",
    ]);
  });

  test("normalizes transformer import and model initialization failures with causes", async () => {
    const importCause = new Error("module absent");
    await expect(
      loadEmbeddingPipe(async () => {
        throw importCause;
      }),
    ).rejects.toMatchObject({
      name: "SemanticUnavailableError",
      cause: importCause,
      context: { operation: "transformers-import", model: EMBED_MODEL },
    });

    const initCause = new Error("model download failed");
    const module = {
      env: { cacheDir: "", allowRemoteModels: false },
      pipeline: async () => {
        throw initCause;
      },
    } satisfies TransformersModule;
    await expect(loadEmbeddingPipe(async () => module)).rejects.toMatchObject({
      name: "SemanticUnavailableError",
      cause: initCause,
      context: {
        operation: "model-initialization",
        model: EMBED_MODEL,
        expectedDimension: EMBED_DIM,
      },
    });
  });

  test.each([
    ["sqlite-vec-import", "import"],
    ["sqlite-vec-load", "load"],
  ] as const)("normalizes %s failures and preserves their cause", async (operation, stage) => {
    const cause = new Error(`${stage} failed`);
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {},
    };
    const ensure = createVectorExtensionRuntime(async () => {
      if (stage === "import") throw cause;
      return {
        load: () => {
          if (stage === "load") throw cause;
        },
      };
    });

    try {
      await ensure(db as never);
      throw new Error("expected initialization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticUnavailableError);
      expect((error as SemanticUnavailableError).context?.operation).toBe(operation);
      expect((error as SemanticUnavailableError).cause).toBe(cause);
    }
  });

  test("normalizes an actual Bun SQLiteError for the missing vec0 capability", async () => {
    const db = new Database(":memory:");
    const ensure = createVectorExtensionRuntime(async () => ({ load: () => {} }));

    try {
      await ensure(db);
      throw new Error("expected vec0 capability detection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticUnavailableError);
      const semanticError = error as SemanticUnavailableError;
      expect(semanticError.cause).toBeInstanceOf(SQLiteError);
      expect(semanticError.cause).toMatchObject({
        errno: 1,
        message: "no such module: vec0",
      });
      expect(semanticError.context).toEqual({
        operation: "sqlite-vec-schema",
        model: EMBED_MODEL,
        expectedDimension: EMBED_DIM,
      });
    } finally {
      db.close();
    }
  });

  test.each([
    ["corrupt database", "SQLITE_CORRUPT", "database disk image is malformed"],
    ["read-only database", "SQLITE_READONLY", "attempt to write a readonly database"],
    ["I/O failure", "SQLITE_IOERR", "disk I/O error"],
    ["closed database", "SQLITE_MISUSE", "database is closed"],
    ["ordinary contention", "SQLITE_BUSY", "database is locked"],
    ["generic lookalike", "SQLITE_ERROR", "no such module: vec0"],
  ] as const)("preserves the original %s schema error", async (_name, code, message) => {
    const cause = Object.assign(new Error(message), { code });
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        throw cause;
      },
    };
    const ensure = createVectorExtensionRuntime(async () => ({ load: () => {} }));

    await expect(ensure(db as never)).rejects.toBe(cause);
  });

  test("preserves a non-Error missing-module lookalike", async () => {
    const cause = { code: "SQLITE_ERROR", message: "no such module: vec0" };
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        throw cause;
      },
    };
    const ensure = createVectorExtensionRuntime(async () => ({ load: () => {} }));

    await expect(ensure(db as never)).rejects.toBe(cause);
  });

  test("preserves an actual SQLiteError whose missing-module message has whitespace", async () => {
    const probe = new Database(":memory:");
    let cause!: SQLiteError;
    try {
      probe.exec(`CREATE VIRTUAL TABLE whitespace_probe USING "vec0 "(value)`);
    } catch (error) {
      cause = error as SQLiteError;
    } finally {
      probe.close();
    }
    expect(cause).toBeInstanceOf(SQLiteError);
    expect(cause.message).toBe("no such module: vec0 ");

    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        throw cause;
      },
    };
    const ensure = createVectorExtensionRuntime(async () => ({ load: () => {} }));
    await expect(ensure(db as never)).rejects.toBe(cause);
  });

  test("marks a vector connection loaded only after schema creation succeeds", async () => {
    let loads = 0;
    let schemaCreates = 0;
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        schemaCreates++;
      },
    };
    const ensure = createVectorExtensionRuntime(async () => ({
      load: () => {
        loads++;
      },
    }));
    await ensure(db as never);
    await ensure(db as never);
    expect(loads).toBe(1);
    expect(schemaCreates).toBe(2);
  });

  test("retries schema creation without reloading a successfully loaded extension", async () => {
    const firstSchemaFailure = new Error("database temporarily busy");
    let loads = 0;
    let schemaCreates = 0;
    const db = {
      prepare: () => ({ get: () => null }),
      exec: () => {
        schemaCreates++;
        if (schemaCreates === 1) throw firstSchemaFailure;
      },
    };
    const ensure = createVectorExtensionRuntime(async () => ({
      load: () => {
        loads++;
      },
    }));

    await expect(ensure(db as never)).rejects.toBe(firstSchemaFailure);
    await ensure(db as never);
    expect(loads).toBe(1);
    expect(schemaCreates).toBe(3);
  });
});
