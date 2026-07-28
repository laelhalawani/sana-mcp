import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SanaStore } from "../../src/store/db.js";
import {
  EMBED_DIM,
  EMBED_MODEL,
  ensureVec,
  SEMANTIC_INDEX_VERSION,
  vectorBackendForPlatform,
} from "../../src/semantic/semantic.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStore(): SanaStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-search-index-"));
  roots.push(root);
  return new SanaStore(path.join(root, "sana.db"));
}

function transcript(...texts: string[]): string {
  return JSON.stringify(
    texts.map((text, index) => ({
      speaker: "Speaker",
      words: [
        { text, start_timestamp: index, end_timestamp: index + 1 },
      ],
    })),
  );
}

describe("transcript search index", () => {
  test("repairs a missing meeting when the FTS index is only partially populated", () => {
    const store = createStore();
    for (const [id, text] of [
      ["indexed", "already searchable"],
      ["missing", "reconciled transcript"],
    ] as const) {
      store.upsertMeeting({
        id,
        name: id,
        source: "sana-ai:meeting",
        created_at_ms: 1,
      });
      store.saveTranscript({
        meeting_id: id,
        text,
        json: transcript(text, `${text} second line`),
        word_count: 2,
        segment_count: 1,
      });
    }
    store.db.prepare(`DELETE FROM line_fts WHERE meeting_id = ?`).run("missing");
    store.db
      .prepare(`DELETE FROM line_fts WHERE meeting_id = ? AND line_no = ?`)
      .run("indexed", 2);
    store.db
      .prepare(`DELETE FROM line_fts_state WHERE meeting_id IN (?, ?)`)
      .run("missing", "indexed");

    expect(store.searchLines('"reconciled"')).toEqual([
      expect.objectContaining({ meeting_id: "missing", line_no: 1 }),
      expect.objectContaining({ meeting_id: "missing", line_no: 2 }),
    ]);
    expect(store.searchLines('"searchable"')).toEqual([
      expect.objectContaining({ meeting_id: "indexed", line_no: 1 }),
      expect.objectContaining({ meeting_id: "indexed", line_no: 2 }),
    ]);
    store.close();
  });

  test("resolves semantic anchors from canonical indexed lines in one result shape", () => {
    const store = createStore();
    store.upsertMeeting({
      id: "meeting",
      name: "Indexed meeting",
      source: "sana-ai:meeting",
      created_at_ms: 42,
    });
    store.saveTranscript({
      meeting_id: "meeting",
      text: "first\nsecond",
      json: transcript("first phrase", "second phrase"),
      word_count: 4,
      segment_count: 2,
    });

    expect(store.resolveSearchLines([
      { meeting_id: "meeting", line_no: 2 },
      { meeting_id: "meeting", line_no: 2 },
      { meeting_id: "missing", line_no: 1 },
    ])).toEqual([{
      meeting_id: "meeting",
      line_no: 2,
      text: "second phrase",
      created_at_ms: 42,
      name: "Indexed meeting",
    }]);
    store.close();
  });

  test("counts only the current transcript and semantic index generation", () => {
    const store = createStore();
    store.upsertMeeting({
      id: "meeting",
      name: "Versioned meeting",
      source: "sana-ai:meeting",
      created_at_ms: 1,
    });
    store.saveTranscript({
      meeting_id: "meeting",
      text: "current",
      json: transcript("current semantic phrase is long enough"),
      word_count: 6,
      segment_count: 1,
    });
    const fetchedMs = store.getTranscript("meeting")!.fetched_ms;
    const insert = store.db.prepare(
      `INSERT INTO line_embeddings (
         meeting_id, dim, model, done_ms, transcript_fetched_ms, index_version,
         vector_backend
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "meeting",
      EMBED_DIM,
      EMBED_MODEL,
      1,
      fetchedMs,
      SEMANTIC_INDEX_VERSION - 1,
      vectorBackendForPlatform(),
    );
    expect(store.meetingsMissingEmbedding(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toEqual(["meeting"]);
    expect(store.countEmbedded(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toBe(0);

    store.db.prepare(
      `UPDATE line_embeddings SET index_version = ? WHERE meeting_id = ?`,
    ).run(SEMANTIC_INDEX_VERSION, "meeting");
    expect(store.meetingsMissingEmbedding(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toEqual([]);
    expect(store.countEmbedded(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toBe(1);

    const otherBackend = vectorBackendForPlatform() === "portable"
      ? "sqlite-vec"
      : "portable";
    store.db.prepare(
      `UPDATE line_embeddings SET vector_backend = ? WHERE meeting_id = ?`,
    ).run(otherBackend, "meeting");
    expect(store.meetingsMissingEmbedding(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toEqual(["meeting"]);
    store.db.prepare(
      `UPDATE line_embeddings SET vector_backend = ? WHERE meeting_id = ?`,
    ).run(vectorBackendForPlatform(), "meeting");

    store.saveTranscript({
      meeting_id: "meeting",
      text: "replacement",
      json: transcript("replacement semantic phrase is also long enough"),
      word_count: 7,
      segment_count: 1,
    });
    expect(store.countEmbedded(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackendForPlatform(),
    )).toBe(0);
    store.close();
  });

  test("allows the internal hybrid fusion pool beyond the public page cap", () => {
    const store = createStore();
    store.upsertMeeting({
      id: "meeting",
      name: "Large index",
      source: "sana-ai:meeting",
      created_at_ms: 1,
    });
    const lines = Array.from(
      { length: 150 },
      (_, index) => `shared keyword phrase ${index}`,
    );
    store.saveTranscript({
      meeting_id: "meeting",
      text: lines.join("\n"),
      json: transcript(...lines),
      word_count: lines.length * 4,
      segment_count: lines.length,
    });

    expect(store.searchLines('"shared"', { limit: 300 })).toHaveLength(100);
    expect(store.searchLines('"shared"', {
      limit: 300,
      fusionPool: true,
    })).toHaveLength(150);
    store.close();
  });

  test("refreshes transcripts after reopening vector storage and removes stale chunks", async () => {
    const store = createStore();
    store.upsertMeeting({
      id: "meeting",
      name: "Restarted meeting",
      source: "sana-ai:meeting",
      created_at_ms: 1,
    });
    store.saveTranscript({
      meeting_id: "meeting",
      text: "old",
      json: transcript("old semantic phrase has enough words"),
      word_count: 6,
      segment_count: 1,
    });
    const backend = await ensureVec(store.db);
    const vector = Buffer.from(new Float32Array(EMBED_DIM).buffer);
    const table = backend === "sqlite-vec"
      ? "vec_chunks_v2"
      : "vec_chunks_v2_portable";
    store.db.prepare(
      `INSERT INTO ${table} (
         embedding, meeting_id, chunk_kind, chunk_no, start_line, end_line,
         created_at, index_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      vector,
      "meeting",
      "large",
      1,
      1,
      1,
      1,
      SEMANTIC_INDEX_VERSION,
    );
    const file = store.file;
    store.close();

    const reopened = new SanaStore(file);
    await ensureVec(reopened.db);
    reopened.saveTranscript({
      meeting_id: "meeting",
      text: "new",
      json: transcript("new semantic phrase also has enough words"),
      word_count: 7,
      segment_count: 1,
    }, backend);
    expect(
      (reopened.db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE meeting_id = ?`,
      ).get("meeting") as { count: number }).count,
    ).toBe(0);
    reopened.close();
  });
});
