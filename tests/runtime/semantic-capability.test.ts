import { describe, expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import {
  createEmbeddingRuntime,
  createVectorExtensionRuntime,
  EMBED_DIM,
  EMBED_MODEL,
  loadEmbeddingPipe,
  resolveSemanticCapability,
  SemanticUnavailableError,
  validateEmbeddingOutput,
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

  test("reports transcript corruption and returns authoritative keyword results", async () => {
    const row = {
      meeting_id: "meeting-1",
      line_no: 1,
      text: "keyword result",
      created_at_ms: 1,
      name: "Fixture",
    };
    const corruptJson = "{";
    let parseCause!: SyntaxError;
    try {
      JSON.parse(corruptJson);
    } catch (error) {
      parseCause = error as SyntaxError;
    }
    const store = {
      db: {},
      countLineMatches: () => 1,
      searchLines: () => [row],
      getMeeting: () => ({
        meeting_id: row.meeting_id,
        created_at_ms: row.created_at_ms,
        name: row.name,
      }),
      getTranscript: () => ({ json: corruptJson }),
    } as unknown as SanaStore;

    const result = await runSearch(
      store,
      { query: "keyword" },
      {
        semanticState: { kind: "available" },
        embedQuery: async () => Buffer.alloc(EMBED_DIM * Float32Array.BYTES_PER_ELEMENT),
        searchKnn: async () => [
          { meeting_id: row.meeting_id, line_no: row.line_no, distance: 0 },
        ],
      },
    );

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.mode).toBe("keyword");
      expect(result.rows).toEqual([row]);
      expect(result.total).toBe(1);
      expect(result.degradation).toEqual({
        code: "SEMANTIC_RUNTIME_ERROR",
        message: parseCause.message,
        cause: {
          kind: "ERROR",
          name: "SyntaxError",
          message: parseCause.message,
        },
      });
    }
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
  test("post-import vector load and schema creation run inside the supplied fence", async () => {
    const events: string[] = [];
    const db = {
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
    const db = { exec: () => {} };
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
    expect(schemaCreates).toBe(1);
  });

  test("retries schema creation without reloading a successfully loaded extension", async () => {
    const firstSchemaFailure = new Error("database temporarily busy");
    let loads = 0;
    let schemaCreates = 0;
    const db = {
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
    expect(schemaCreates).toBe(2);
  });
});
