import { afterEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import type { SanaClient } from "../../src/sana/client.js";
import type { SyncState } from "../../src/store/db.js";
import type { DaemonControlObservation } from "../../src/sync/control.js";

const embedCalls: Array<{ meetingId: string; createdAtMs: number }> = [];
const embeddedWrites: string[] = [];
let beforeEmbedCommit: (() => void) | undefined;
const temporaryRoots: string[] = [];
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const TEST_DAEMON_INSTANCE =
  "00000000-0000-4000-8000-000000000010";
const TEST_SUCCESSOR_INSTANCE =
  "00000000-0000-4000-8000-000000000011";

class TestSemanticUnavailableError extends Error {}

mock.module("../../src/semantic/semantic.js", () => ({
  semanticEnabled: () => true,
  semanticCapabilityState: () => ({ kind: "available" as const }),
  embedMeeting: async (
    _db: unknown,
    meetingId: string,
    createdAtMs: number,
    _lines: unknown,
    commit: (write: () => void) => void,
  ): Promise<void> => {
    embedCalls.push({ meetingId, createdAtMs });
    beforeEmbedCommit?.();
    commit(() => {
      embeddedWrites.push(meetingId);
    });
  },
  EMBED_DIM: 384,
  EMBED_MODEL: "test-model",
  SemanticUnavailableError: TestSemanticUnavailableError,
}));

const {
  DaemonResourceFinalizationError,
  daemonSessionPreflight,
  finalizeDaemonResources,
  prepareDaemonRetryState,
  retireDeadForegroundControl,
  syncOnce,
} = await import(
  "../../src/sync/daemon.js"
);
const { DaemonStaleOwnerError } = await import("../../src/sync/lock.js");
const { SanaStore, SyncGenerationChangedError } = await import(
  "../../src/store/db.js"
);

async function removeTemporaryRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 49) throw error;
      await Bun.sleep(100);
    }
  }
}

afterEach(async () => {
  embedCalls.length = 0;
  embeddedWrites.length = 0;
  beforeEmbedCommit = undefined;
  for (const root of temporaryRoots.splice(0)) {
    await removeTemporaryRoot(root);
  }
});

test("daemon startup resets retry history exactly once", () => {
  let resets = 0;
  prepareDaemonRetryState({
    resetFailures: () => {
      resets++;
    },
  });
  expect(resets).toBe(1);
});

test("partial artifact success remains retrying and avoids transcript redownload", async () => {
  let transcript: ReturnType<SanaStore["getTranscript"]> = null;
  let metadata: ReturnType<SanaStore["getMetadata"]> = null;
  let transcriptRequests = 0;
  let detailsRequests = 0;
  let participantRequests = 0;
  let failures = 0;
  let clears = 0;
  let listedPages = 0;
  const state = syncState({
    auth_generation: 1,
    auth_publication_token: "11111111-1111-4111-8111-111111111111",
    auth_user_id: "user-a",
    auth_workspace_id: "workspace-a",
    cache_user_id: "user-a",
    cache_workspace_id: "workspace-a",
  });
  const store = {
    db: {},
    getSyncState: () => state,
    writeSyncGeneration: (_cycle: unknown, operation: () => unknown) => operation(),
    writeCacheGeneration: (_cycle: unknown, operation: () => unknown) => operation(),
    assertSyncGeneration: () => {},
    updateSyncState: (patch: Partial<SyncState>) => Object.assign(state, patch),
    renewDaemonLease: () => "renewed",
    getMeeting: (id: string) => ({ id, created_at_ms: 1 }),
    upsertMeeting: () => {},
    countMeetings: () => 1,
    meetingsDue: () => (metadata === null ? ["meeting-a"] : []),
    countIncomplete: () => (metadata === null ? 1 : 0),
    countComplete: () => (transcript !== null && metadata !== null ? 1 : 0),
    countTranscripts: () => (transcript === null ? 0 : 1),
    getTranscript: () => transcript,
    saveTranscript: () => {
      transcript = {
        meeting_id: "meeting-a",
        text: "Hello",
        json: "[]",
        word_count: 1,
        segment_count: 0,
        fetched_ms: 1,
      };
    },
    getMetadata: () => metadata,
    saveMetadata: () => {
      metadata = {
        summary: null,
        summary_short: null,
        notes_json: null,
        participants_json: "[]",
        has_recording: 0,
      };
    },
    recordFailure: () => {
      failures++;
    },
    clearFailure: () => {
      clears++;
    },
    meetingsMissingEmbedding: () => [],
    releaseCurrentCache: () => {},
    finishSyncCycle: () => {},
  } as unknown as SanaStore;
  const client = {
    walkMeetings: async (page: (assets: unknown[]) => unknown) => {
      listedPages++;
      expect(page([])).not.toBe(false);
      listedPages++;
      expect(page([])).not.toBe(false);
    },
    getTranscription: async () => {
      transcriptRequests++;
      return [];
    },
    getMeetingById: async () => {
      detailsRequests++;
      return {};
    },
    getMeetingParticipants: async () => {
      participantRequests++;
      if (participantRequests === 1) throw new Error("participants temporary");
      return [];
    },
  } as unknown as SanaClient;
  const cycle = {
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
    userId: "user-a",
    workspaceId: "workspace-a",
  };

  await syncOnce(store, client, cycle, TEST_DAEMON_INSTANCE);
  expect({ transcriptRequests, detailsRequests, participantRequests }).toEqual({
    transcriptRequests: 1,
    detailsRequests: 1,
    participantRequests: 1,
  });
  expect(failures).toBe(1);
  expect(clears).toBe(0);

  await syncOnce(store, client, cycle, TEST_DAEMON_INSTANCE);
  expect({ transcriptRequests, detailsRequests, participantRequests }).toEqual({
    transcriptRequests: 1,
    detailsRequests: 2,
    participantRequests: 2,
  });
  expect(failures).toBe(1);
  expect(clears).toBe(1);
  expect(listedPages).toBe(4);
});

function runLeaseScenario(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-daemon-lease-"));
  const file = path.join(root, "profile", "sana.db");
  try {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { SanaStore } = await import("./src/store/db.ts");
          const {
            acquireDaemonLease,
            heartbeatDaemonLease,
            DaemonLeaseLostError,
          } = await import("./src/sync/lock.ts");
          const file = ${JSON.stringify(file)};
          ${source}
        `,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: { ...process.env, SANA_SEMANTIC: "0" },
      },
    );
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

function syncState(
  patch: Partial<SyncState> = {},
): SyncState {
  const state: SyncState = {
    phase: "idle",
    message: "",
    meetings_total: 0,
    transcripts_done: 0,
    transcripts_total: 0,
    last_full_sync_ms: null,
    last_incremental_ms: null,
    daemon_pid: null,
    daemon_heartbeat_ms: null,
    daemon_instance_id: null,
    blocking: 1,
    catchup_epoch_ms: null,
    auth_pending: 0,
    auth_transition_pid: null,
    auth_generation: 0,
    auth_publication_token: null,
    auth_user_id: null,
    auth_workspace_id: null,
    auth_transition_token: null,
    auth_transition_generation: null,
    auth_transition_kind: null,
    auth_transition_user_id: null,
    auth_transition_workspace_id: null,
    auth_issue_code: null,
    auth_issue_message: null,
    auth_issue_operation_token: null,
    auth_issue_generation: null,
    auth_issue_kind: null,
    catchup_generation: null,
    cache_user_id: null,
    cache_workspace_id: null,
    sync_issue_code: null,
    sync_issue_cause: null,
    sync_issue_message: null,
    error: null,
    updated_ms: 0,
    ...patch,
  };
  if (
    state.daemon_pid !== null &&
    state.daemon_instance_id === null
  ) {
    state.daemon_instance_id = TEST_DAEMON_INSTANCE;
  }
  return state;
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", {
    value: pid,
    configurable: true,
  });
  Object.defineProperty(child, "exitCode", {
    value: null,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(child, "signalCode", {
    value: null,
    writable: true,
    configurable: true,
  });
  child.kill = () => true;
  child.unref = () => child;
  return child;
}

test("embedding errors are retried without mutating artifact failures", async () => {
  const failures: Array<{ meetingId: string; message: string }> = [];
  const marked: string[] = [];
  const cleared: string[] = [];
  const missingEmbeddingCalls = { count: 0 };
  const transcriptJson = JSON.stringify([
    {
      speaker: "Speaker",
      words: [
        {
          text: "A complete deterministic transcript line for embedding.",
          start_timestamp: 0,
          end_timestamp: 1,
        },
      ],
    },
  ]);

  const store = {
    db: {},
    getSyncState: () =>
      syncState({
        auth_generation: 1,
        auth_publication_token:
          "11111111-1111-4111-8111-111111111111",
        auth_user_id: "user-a",
        auth_workspace_id: "workspace-a",
        cache_user_id: "user-a",
        cache_workspace_id: "workspace-a",
      }),
    writeSyncGeneration: (
      _cycle: unknown,
      operation: () => unknown,
    ) => operation(),
    writeCacheGeneration: (
      _cycle: unknown,
      operation: () => unknown,
    ) => operation(),
    activateCacheIdentity: () => "unchanged",
    updateSyncState: () => {},
    renewDaemonLease: () => "renewed",
    countMeetings: () => 2,
    meetingsDue: () => [],
    countIncomplete: () => 0,
    countComplete: () => 2,
    countTranscripts: () => 2,
    meetingsMissingEmbedding: () => {
      missingEmbeddingCalls.count++;
      return ["meeting-missing-date", "meeting-valid"];
    },
    getTranscript: (meetingId: string) => ({
      meeting_id: meetingId,
      text: "fixture",
      json: transcriptJson,
      word_count: 7,
      segment_count: 1,
      fetched_ms: 1,
    }),
    getMeeting: (meetingId: string) =>
      meetingId === "meeting-missing-date"
        ? { id: meetingId, created_at_ms: null }
        : { id: meetingId, created_at_ms: 1_725_000_000_000 },
    recordFailure: (meetingId: string, message: string) => {
      failures.push({ meetingId, message });
    },
    markEmbedded: (meetingId: string) => {
      marked.push(meetingId);
    },
    clearFailure: (meetingId: string) => {
      cleared.push(meetingId);
    },
    releaseCurrentCache: () => {},
    finishSyncCycle: () => {},
  } as unknown as SanaStore;
  const client = {
    walkMeetings: async () => {},
  } as unknown as SanaClient;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-daemon-log-"));
  temporaryRoots.push(root);
  const previousDataDir = process.env.SANA_DATA_DIR;
  const previousTranscriptsDir = process.env.SANA_TRANSCRIPTS_DIR;
  process.env.SANA_DATA_DIR = path.join(root, "data");
  process.env.SANA_TRANSCRIPTS_DIR = path.join(root, "transcripts");
  try {
    await syncOnce(store, client, {
      generation: 1,
      publicationToken: "11111111-1111-4111-8111-111111111111",
      userId: "user-a",
      workspaceId: "workspace-a",
    }, "00000000-0000-4000-8000-000000000010");
  } finally {
    if (previousDataDir === undefined) delete process.env.SANA_DATA_DIR;
    else process.env.SANA_DATA_DIR = previousDataDir;
    if (previousTranscriptsDir === undefined) delete process.env.SANA_TRANSCRIPTS_DIR;
    else process.env.SANA_TRANSCRIPTS_DIR = previousTranscriptsDir;
  }

  expect(failures).toEqual([]);
  expect(embedCalls).toEqual([
    {
      meetingId: "meeting-valid",
      createdAtMs: 1_725_000_000_000,
    },
  ]);
  expect(marked).toEqual(["meeting-valid"]);
  expect(cleared).toEqual([]);
  expect(missingEmbeddingCalls.count).toBe(1);
});

test("stale cycle cannot commit vector rows after embedding await", async () => {
  let generation = 1;
  const marked: string[] = [];
  const transcriptJson = JSON.stringify([
    {
      speaker: "Speaker",
      words: [
        {
          text: "A complete deterministic transcript line for embedding.",
          start_timestamp: 0,
          end_timestamp: 1,
        },
      ],
    },
  ]);
  beforeEmbedCommit = () => {
    generation = 2;
  };
  const store = {
    db: {},
    getSyncState: () =>
      syncState({
        last_full_sync_ms: 1,
        auth_generation: generation,
        auth_publication_token:
          generation === 1
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        auth_user_id: "user-a",
        auth_workspace_id: "workspace-a",
        cache_user_id: "user-a",
        cache_workspace_id: "workspace-a",
      }),
    writeSyncGeneration: (
      cycle: { generation: number; publicationToken: string },
      operation: () => unknown,
    ) => {
      const token =
        generation === 1
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222";
      if (
        cycle.generation !== generation ||
        cycle.publicationToken !== token
      ) {
        throw new SyncGenerationChangedError();
      }
      return operation();
    },
    writeCacheGeneration: (
      cycle: { generation: number; publicationToken: string },
      operation: () => unknown,
    ) => {
      const token =
        generation === 1
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222";
      if (
        cycle.generation !== generation ||
        cycle.publicationToken !== token
      ) {
        throw new SyncGenerationChangedError();
      }
      return operation();
    },
    updateSyncState: () => {},
    renewDaemonLease: () => "renewed",
    getMeeting: (id: string) => ({
      id,
      created_at_ms: 1_725_000_000_000,
    }),
    upsertMeeting: () => {},
    countMeetings: () => 1,
    meetingsDue: () => [],
    countIncomplete: () => 0,
    countComplete: () => 1,
    countTranscripts: () => 1,
    meetingsMissingEmbedding: () => ["meeting-a"],
    getTranscript: () => ({
      meeting_id: "meeting-a",
      text: "fixture",
      json: transcriptJson,
      word_count: 7,
      segment_count: 1,
      fetched_ms: 1,
    }),
    markEmbedded: (id: string) => marked.push(id),
    clearFailure: () => {},
    recordFailure: () => {},
    releaseCurrentCache: () => {},
    finishSyncCycle: () => {},
  } as unknown as SanaStore;
  const client = {
    walkMeetings: async () => {},
  } as unknown as SanaClient;

  await expect(
    syncOnce(store, client, {
      generation: 1,
      publicationToken: "11111111-1111-4111-8111-111111111111",
      userId: "user-a",
      workspaceId: "workspace-a",
    }, "00000000-0000-4000-8000-000000000010"),
  ).rejects.toBeInstanceOf(SyncGenerationChangedError);
  expect(embeddedWrites).toEqual([]);
  expect(marked).toEqual([]);
});

test("complete listing releases the cache before artifact requests", async () => {
  let released = false;
  let transcriptSaved = false;
  const cycle = {
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
    userId: "user-a",
    workspaceId: "workspace-a",
  };
  const store = {
    db: {},
    getSyncState: () =>
      syncState({
        last_full_sync_ms: 1,
        auth_generation: cycle.generation,
        auth_publication_token: cycle.publicationToken,
        auth_user_id: cycle.userId,
        auth_workspace_id: cycle.workspaceId,
        cache_user_id: cycle.userId,
        cache_workspace_id: cycle.workspaceId,
      }),
    writeSyncGeneration: (_cycle: unknown, operation: () => unknown) => operation(),
    writeCacheGeneration: (_cycle: unknown, operation: () => unknown) => operation(),
    updateSyncState: () => {},
    assertSyncGeneration: () => {},
    activateCacheIdentity: () => "unchanged",
    upsertMeeting: () => {},
    countMeetings: () => 1,
    countTranscripts: () => (transcriptSaved ? 1 : 0),
    countIncomplete: () => (transcriptSaved ? 0 : 1),
    meetingsDue: () => ["meeting-a"],
    releaseCurrentCache: () => {
      released = true;
    },
    getTranscript: () =>
      transcriptSaved
        ? { meeting_id: "meeting-a", text: "", json: "[]", word_count: 0, segment_count: 0, fetched_ms: 1 }
        : null,
    getMetadata: () => ({
      summary: null,
      summary_short: null,
      notes_json: null,
      participants_json: "[]",
      has_recording: 0,
    }),
    saveTranscript: () => {
      transcriptSaved = true;
    },
    clearFailure: () => {},
    recordFailure: () => {},
    renewDaemonLease: () => "renewed",
    meetingsMissingEmbedding: () => [],
    finishSyncCycle: () => {},
  } as unknown as SanaStore;
  const client = {
    walkMeetings: async () => {},
    getTranscription: async () => {
      expect(released).toBe(true);
      return [];
    },
  } as unknown as SanaClient;

  await syncOnce(store, client, cycle, TEST_DAEMON_INSTANCE);
  expect(released).toBe(true);
});

test("daemon finalization preserves execution and cleanup errors", () => {
  const primaryError = new Error("daemon failed");
  const clearError = new Error("clear failed");
  const closeError = new Error("close failed");
  const calls: string[] = [];

  let caught: unknown;
  try {
    finalizeDaemonResources(
      {
        clearDaemonIdentityIfOwned: () => {
          calls.push("clear");
          throw clearError;
        },
        close: () => {
          calls.push("close");
          throw closeError;
        },
      },
      true,
      "00000000-0000-4000-8000-000000000010",
      primaryError,
    );
  } catch (error) {
    caught = error;
  }

  expect(calls).toEqual(["clear", "close"]);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([
    primaryError,
    clearError,
    closeError,
  ]);
  expect(caught).toBeInstanceOf(DaemonResourceFinalizationError);
  expect(
    (caught as InstanceType<typeof DaemonResourceFinalizationError>)
      .retainControl,
  ).toBe(true);
});

test("uncertain SQLite close retains ready control until exact process death", () => {
  const closeError = new Error("SQLite close failed");
  let caught: unknown;
  try {
    finalizeDaemonResources(
      {
        clearDaemonIdentityIfOwned: () => "cleared",
        close: () => {
          throw closeError;
        },
      },
      true,
      TEST_DAEMON_INSTANCE,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DaemonResourceFinalizationError);
  expect(
    (caught as InstanceType<typeof DaemonResourceFinalizationError>)
      .retainControl,
  ).toBe(true);
  expect((caught as AggregateError).errors).toEqual([closeError]);
});

test("foreground daemon retires only proven-dead exact v2 crash residue before store startup", () => {
  let control: DaemonControlObservation = {
    kind: "ready",
    identity: {
      pid: 707,
      instanceId: TEST_DAEMON_INSTANCE,
    },
    heartbeatMs: 1_000,
    freshness: "stale",
  };
  const cleared: Array<{ pid: number; instanceId: string }> = [];
  retireDeadForegroundControl({
    observeControl: () => control,
    pidAlive: () => false,
    clearControl: (identity) => {
      cleared.push(identity);
      control = { kind: "missing" };
    },
  });
  expect(cleared).toEqual([{
    pid: 707,
    instanceId: TEST_DAEMON_INSTANCE,
  }]);

  control = {
    kind: "ready",
    identity: {
      pid: 808,
      instanceId: TEST_SUCCESSOR_INSTANCE,
    },
    heartbeatMs: 1_000,
    freshness: "fresh",
  };
  expect(() =>
    retireDeadForegroundControl({
      observeControl: () => control,
      pidAlive: () => true,
      clearControl: () => {
        throw new Error("must not clear live successor");
      },
    })
  ).toThrow(/live process 808/u);
  expect(control).toMatchObject({
    identity: { instanceId: TEST_SUCCESSOR_INSTANCE },
  });

  control = {
    kind: "ready",
    identity: {
      pid: 707,
      instanceId: TEST_DAEMON_INSTANCE,
    },
    heartbeatMs: 1_000,
    freshness: "stale",
  };
  expect(() =>
    retireDeadForegroundControl({
      observeControl: () => control,
      pidAlive: () => false,
      clearControl: () => {
        control = {
          kind: "ready",
          identity: {
            pid: 808,
            instanceId: TEST_SUCCESSOR_INSTANCE,
          },
          heartbeatMs: 1_000,
          freshness: "fresh",
        };
      },
    })
  ).toThrow(/changed during proven-dead retirement/u);
  expect(control).toMatchObject({
    identity: { instanceId: TEST_SUCCESSOR_INSTANCE },
  });
});

test("daemon waits on a pending challenge without authentication or expiry effects", async () => {
  let waitCalls = 0;
  let needsLoginCalls = 0;
  let authNetworkCalls = 0;
  const result = await daemonSessionPreflight(
    {
      markNeedsLoginIfCurrent: () => {
        needsLoginCalls++;
        return "marked";
      },
    },
    {
      pendingSignInChallenge: () => ({
        email: "person@example.test",
      }),
      hasAuthCookie: () => true,
      sessionVersion: () => ({
        generation: 1,
        publicationToken:
          "11111111-1111-4111-8111-111111111111",
        userId: null,
        workspaceId: null,
      }),
      me: async () => {
        authNetworkCalls++;
      },
    },
    async () => {
      waitCalls++;
    },
  );

  expect(result).toBe("wait");
  expect(waitCalls).toBe(1);
  expect(needsLoginCalls).toBe(0);
  expect(authNetworkCalls).toBe(0);
});

test("SQLite lease preserves stale live owners and replaces proven dead owners", {
  timeout: 20_000,
}, () => {
  const child = runLeaseScenario(`
    const first = new SanaStore(file);
    const second = new SanaStore(file);
    const initial = acquireDaemonLease(first, 101, 10_000, () => true);
    if (initial.kind !== "acquired" || initial.replacedPid !== null) {
      throw new Error("initial lease was not acquired");
    }
    const busy = acquireDaemonLease(second, 202, 10_001, (pid) => pid === 101);
    if (busy.kind !== "busy" || busy.ownerPid !== 101) {
      throw new Error("recent live owner did not win contention");
    }

    let staleProbeCalled = false;
    const stale = acquireDaemonLease(second, 202, 40_001, () => {
      staleProbeCalled = true;
      return true;
    });
    if (stale.kind !== "busy" || stale.ownerPid !== 101 ||
        stale.ownerHeartbeat !== "stale" || !staleProbeCalled) {
      throw new Error("stale live owner was not preserved as manual contention");
    }
    const dead = acquireDaemonLease(first, 303, 40_002, () => false);
    if (dead.kind !== "acquired" || dead.replacedPid !== 101) {
      throw new Error("dead recent owner was not atomically replaced");
    }

    let lost = false;
    try {
      heartbeatDaemonLease(second, initial.instanceId, 202, 40_003);
    } catch (error) {
      lost = error instanceof DaemonLeaseLostError;
    }
    if (!lost) throw new Error("predecessor heartbeat did not lose ownership");
    heartbeatDaemonLease(first, dead.instanceId, 303, 40_004);
    if (second.clearDaemonIdentityIfOwned(202, initial.instanceId) !== "not-owner") {
      throw new Error("predecessor cleared its successor");
    }
    if (first.clearDaemonIdentityIfOwned(303, dead.instanceId) !== "cleared") {
      throw new Error("current owner could not clear its lease");
    }
    first.close();
    second.close();
  `);
  expect(child.status, child.stderr).toBe(0);
});
