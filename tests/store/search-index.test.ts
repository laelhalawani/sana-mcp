import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SanaStore } from "../../src/store/db.js";

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
});
