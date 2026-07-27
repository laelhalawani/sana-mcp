import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  retryDelayMs,
  SanaStore,
  SyncGenerationChangedError,
  type SyncCycleIdentity,
} from "../../src/store/db.js";

const roots: string[] = [];

async function removeRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      // Bun can retain a Windows SQLite directory handle until process exit.
      // The isolated test root is removed by the parent harness after exit.
      if (attempt >= 49 && process.platform === "win32") return;
      if (attempt >= 49) throw error;
      await Bun.sleep(100);
    }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeRoot(root);
  }
});

function store(): SanaStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-sync-retry-"));
  roots.push(root);
  return new SanaStore(path.join(root, "profile", "sana.db"));
}

function meeting(
  db: SanaStore,
  id: string,
  createdAt: number,
  phase: string | null = "done",
): void {
  db.upsertMeeting({
    id,
    name: id,
    source: "sana-ai:meeting",
    created_at_ms: createdAt,
    processing_phase: phase,
  });
}

function saveTranscript(db: SanaStore, id: string): void {
  db.saveTranscript({
    meeting_id: id,
    text: "",
    json: "[]",
    word_count: 0,
    segment_count: 0,
  });
}

function saveMetadata(db: SanaStore, id: string): void {
  db.saveMetadata({
    meeting_id: id,
    summary: null,
    summary_short: null,
    notes_json: null,
    participants_json: "[]",
    has_recording: 0,
  });
}

describe("sync retry scheduling", () => {
  test("uses exact exponential boundaries and caps without overflow", () => {
    expect(retryDelayMs(-100)).toBe(10 * 60_000);
    expect(retryDelayMs(0)).toBe(10 * 60_000);
    expect(retryDelayMs(1)).toBe(10 * 60_000);
    expect(retryDelayMs(2)).toBe(20 * 60_000);
    expect(retryDelayMs(5)).toBe(160 * 60_000);
    expect(retryDelayMs(6)).toBe(160 * 60_000);
    expect(retryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(160 * 60_000);

    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const { retryDelayMs } = await import("./src/store/db.ts");
         console.log(JSON.stringify([retryDelayMs(6), retryDelayMs(7), retryDelayMs(Number.MAX_SAFE_INTEGER)]));`,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        encoding: "utf8",
        env: { ...process.env, SANA_MAX_ATTEMPTS: "100", SANA_SEMANTIC: "0" },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      320 * 60_000,
      6 * 60 * 60_000,
      6 * 60 * 60_000,
    ]);
  });

  test("attempts at and above the old cap become due after their delay", () => {
    const db = store();
    meeting(db, "meeting-old", 1);
    const attemptedAt = 1_000_000;
    db.db.prepare(
      `INSERT INTO fetch_failures(meeting_id, attempts, last_error, last_attempt_ms)
       VALUES (?, ?, ?, ?)`,
    ).run("meeting-old", 50, "temporary", attemptedAt);
    const delay = retryDelayMs(50);

    expect(db.meetingsDue(attemptedAt + delay - 1)).toEqual([]);
    expect(db.meetingsDue(attemptedAt + delay)).toEqual(["meeting-old"]);
    expect(db.countIncomplete()).toBe(1);
    expect(db.countRetrying()).toBe(1);
    db.close();
  });

  test("a transient failure backs off and becomes due at the exact boundary", () => {
    const db = store();
    meeting(db, "meeting-transient", 1);
    db.recordFailure("meeting-transient", "temporary");
    const failure = db.db
      .prepare(
        `SELECT attempts, last_attempt_ms FROM fetch_failures WHERE meeting_id = ?`,
      )
      .get("meeting-transient") as {
      attempts: number;
      last_attempt_ms: number;
    };

    expect(failure.attempts).toBe(1);
    expect(db.meetingsDue(failure.last_attempt_ms + retryDelayMs(1) - 1)).toEqual(
      [],
    );
    expect(db.meetingsDue(failure.last_attempt_ms + retryDelayMs(1))).toEqual([
      "meeting-transient",
    ]);
    db.close();
  });

  test("orders oldest due work fairly and reset makes old failures immediate", () => {
    const db = store();
    meeting(db, "meeting-newer", 20);
    meeting(db, "meeting-older", 10);
    db.db.prepare(
      `INSERT INTO fetch_failures(meeting_id, attempts, last_error, last_attempt_ms)
       VALUES (?, 1, 'temporary', ?)`,
    ).run("meeting-newer", 100);
    db.db.prepare(
      `INSERT INTO fetch_failures(meeting_id, attempts, last_error, last_attempt_ms)
       VALUES (?, 1, 'temporary', ?)`,
    ).run("meeting-older", 100);

    expect(db.meetingsDue(100 + retryDelayMs(1))).toEqual([
      "meeting-older",
      "meeting-newer",
    ]);
    db.resetFailures();
    db.db.prepare(`UPDATE meetings SET first_seen_ms = ? WHERE id = ?`).run(
      1,
      "meeting-newer",
    );
    db.db.prepare(`UPDATE meetings SET first_seen_ms = ? WHERE id = ?`).run(
      2,
      "meeting-older",
    );
    expect(db.meetingsDue(0)).toEqual(["meeting-newer", "meeting-older"]);
    expect(db.countRetrying()).toBe(0);
    db.close();
  });

  test("processing meetings count pending and become due only after source completion", () => {
    const db = store();
    meeting(db, "meeting-processing", 1, "transcribing");

    expect(db.meetingsDue(Date.now())).toEqual([]);
    expect(db.countIncomplete()).toBe(1);
    expect(db.listMeetings({ status: "processing" }).map((row) => row.id)).toEqual([
      "meeting-processing",
    ]);

    meeting(db, "meeting-processing", 1, "done");
    expect(db.meetingsDue(Date.now())).toEqual(["meeting-processing"]);
    expect(db.listMeetings({ status: "downloading" }).map((row) => row.id)).toEqual([
      "meeting-processing",
    ]);
    db.close();
  });

  test("ready and retrying filters account for transcript and metadata together", () => {
    const db = store();
    meeting(db, "meeting-ready", 1);
    meeting(db, "meeting-retrying", 2);
    saveTranscript(db, "meeting-ready");
    saveMetadata(db, "meeting-ready");
    saveTranscript(db, "meeting-retrying");
    db.recordFailure("meeting-retrying", "metadata temporary");

    expect(db.listMeetings({ status: "ready" }).map((row) => row.id)).toEqual([
      "meeting-ready",
    ]);
    expect(db.listMeetings({ status: "retrying" }).map((row) => row.id)).toEqual([
      "meeting-retrying",
    ]);
    expect(db.listMeetings({ status: "downloading" })).toEqual([]);
    db.close();
  });
});

test("finishSyncCycle derives truthful counts and releases a safe partial cache", () => {
  const db = store();
  const token = "11111111-1111-4111-8111-111111111111";
  const claim = db.claimAuthPublication(
    { generation: 0, publicationToken: null, userId: null, workspaceId: null },
    { userId: "user-a", workspaceId: "workspace-a" },
    "login",
    token,
    process.pid,
    () => false,
  );
  if (claim.kind !== "acquired") throw new Error("test login claim failed");
  db.confirmAuthPublication(claim.intent, 1);
  const cycle: SyncCycleIdentity = {
    generation: 1,
    publicationToken: token,
    userId: "user-a",
    workspaceId: "workspace-a",
  };
  db.activateCacheIdentity(cycle);
  for (let index = 0; index < 238; index++) {
    const id = `meeting-${index}`;
    meeting(db, id, index);
    if (index < 139) saveTranscript(db, id);
    if (index < 100) saveMetadata(db, id);
  }

  db.finishSyncCycle({
    last_full_sync_ms: 100,
    last_incremental_ms: 200,
    cycle,
  });
  const state = db.getSyncState();
  expect(state).toMatchObject({
    phase: "downloading",
    meetings_total: 238,
    transcripts_done: 139,
    transcripts_total: 238,
    blocking: 0,
  });
  expect(state.message).toContain("138 pending");

  const nextToken = "22222222-2222-4222-8222-222222222222";
  const nextClaim = db.claimAuthPublication(
    cycle,
    { userId: "user-a", workspaceId: "workspace-a" },
    "login",
    nextToken,
    process.pid,
    () => false,
  );
  if (nextClaim.kind !== "acquired") throw new Error("next login claim failed");
  db.confirmAuthPublication(nextClaim.intent, 300);
  expect(db.getSyncState().blocking).toBe(1);
  expect(() => db.releaseCurrentCache(cycle)).toThrow(
    SyncGenerationChangedError,
  );
  expect(db.getSyncState().blocking).toBe(1);
  db.close();
});
