import { afterEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import type { SanaClient } from "../../src/sana/client.js";
import type { SyncState } from "../../src/store/db.js";

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
  daemonSessionPreflight,
  finalizeDaemonResources,
  syncOnce,
} = await import(
  "../../src/sync/daemon.js"
);
const {
  DaemonLaunchError,
  ensureDaemonRunningWith,
  waitForDaemonReadiness,
} = await import("../../src/sync/spawn.js");
const { DaemonStaleOwnerError } = await import("../../src/sync/lock.js");
const { SyncGenerationChangedError } = await import("../../src/store/db.js");

afterEach(() => {
  embedCalls.length = 0;
  embeddedWrites.length = 0;
  beforeEmbedCommit = undefined;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
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

test("missing meeting creation time fails only that embedding", async () => {
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
    meetingsIncomplete: () => [],
    countComplete: () => 2,
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
    finishSyncCycle: () => {},
  } as unknown as SanaStore;
  const client = {
    walkMeetings: async () => {},
  } as unknown as SanaClient;

  await syncOnce(store, client, {
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
    userId: "user-a",
    workspaceId: "workspace-a",
  }, "00000000-0000-4000-8000-000000000010");

  expect(failures).toEqual([
    {
      meetingId: "meeting-missing-date",
      message:
        "Cannot create a semantic embedding because the meeting has no authoritative creation timestamp; refresh the meeting list before retrying.",
    },
  ]);
  expect(embedCalls).toEqual([
    {
      meetingId: "meeting-valid",
      createdAtMs: 1_725_000_000_000,
    },
  ]);
  expect(marked).toEqual(["meeting-valid"]);
  expect(cleared).toEqual(["meeting-valid"]);
  expect(missingEmbeddingCalls.count).toBe(2);
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
    meetingsIncomplete: () => [],
    countComplete: () => 1,
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

test("readiness requires the newly spawned child identity and heartbeat", async () => {
  const child = fakeChild(808);
  let state = syncState({
    daemon_pid: 707,
    daemon_heartbeat_ms: 9_999,
  });
  let clock = 10_000;
  let controlPublished = false;

  const ready = waitForDaemonReadiness(
    child,
    { getSyncState: () => state },
    state,
    clock,
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (state.daemon_pid !== 808) {
          state = syncState({
            daemon_pid: 808,
            daemon_heartbeat_ms: clock,
          });
        } else {
          controlPublished = true;
        }
      },
      pidAlive: () => true,
      controlReady: (pid, instanceId) =>
        pid === 808 &&
        instanceId === TEST_DAEMON_INSTANCE &&
        controlPublished,
      timeoutMs: 100,
      pollMs: 10,
    },
  );

  await expect(ready).resolves.toBe("child");
});

test("readiness accepts a different new live lease as a concurrent winner", async () => {
  const child = fakeChild(808);
  let state = syncState();
  let clock = 10_000;
  const ready = waitForDaemonReadiness(
    child,
    { getSyncState: () => state },
    state,
    clock,
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        state = syncState({
          daemon_pid: 909,
          daemon_heartbeat_ms: clock,
        });
      },
      pidAlive: (pid) => pid === 909,
      controlReady: (pid, instanceId) =>
        pid === 909 && instanceId === TEST_DAEMON_INSTANCE,
      timeoutMs: 100,
      pollMs: 10,
    },
  );

  await expect(ready).resolves.toBe("concurrent");
});

test("a child exit before readiness is an observable launch failure", async () => {
  const child = fakeChild(808);
  const baseline = syncState();
  const ready = waitForDaemonReadiness(
    child,
    { getSyncState: () => baseline },
    baseline,
    10_000,
    {
      now: () => 10_000,
      sleep: async () => {
        child.emit("exit", 1, null);
      },
      timeoutMs: 100,
      pollMs: 10,
    },
  );

  await expect(ready).rejects.toThrow(
    "Daemon exited before becoming ready (exit code 1)",
  );
});

test("startup state initialization failures remain observable", async () => {
  const child = fakeChild(808);
  const initError = new Error("database initialization failed");
  await expect(
    waitForDaemonReadiness(
      child,
      {
        getSyncState: () => {
          throw initError;
        },
      },
      syncState(),
      10_000,
      {
        now: () => 10_000,
        sleep: async () => {},
        timeoutMs: 100,
        pollMs: 10,
      },
    ),
  ).rejects.toBe(initError);
});

test("readiness timeout is bounded and typed", async () => {
  const child = fakeChild(808);
  const baseline = syncState();
  let clock = 10_000;
  await expect(
    waitForDaemonReadiness(
      child,
      { getSyncState: () => baseline },
      baseline,
      clock,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 30,
        pollMs: 10,
      },
    ),
  ).rejects.toBeInstanceOf(DaemonLaunchError);
});

test("ensure daemon cleans up and unrefs only after structured readiness", async () => {
  const child = fakeChild(808);
  let state = syncState();
  let clock = 10_000;
  let unrefCount = 0;
  let killCount = 0;
  let closeLogCount = 0;
  let closeStoreCount = 0;
  child.unref = () => {
    unrefCount++;
    return child;
  };
  child.kill = () => {
    killCount++;
    return true;
  };

  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () => state,
      close: () => {
        closeStoreCount++;
      },
    }),
    prepareDataDir: () => {},
    openLog: () => 91,
    closeLog: (descriptor) => {
      expect(descriptor).toBe(91);
      closeLogCount++;
    },
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => child,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      state = syncState({
        daemon_pid: 808,
        daemon_heartbeat_ms: clock,
      });
    },
    pidAlive: () => true,
    controlReady: (pid, instanceId) =>
      pid === 808 &&
      instanceId === TEST_DAEMON_INSTANCE &&
      state.daemon_pid === pid,
    timeoutMs: 100,
    pollMs: 10,
  });

  expect(result).toEqual({ alreadyRunning: false, spawned: true });
  expect(unrefCount).toBe(1);
  expect(killCount).toBe(0);
  expect(closeLogCount).toBe(1);
  expect(closeStoreCount).toBe(1);
});

test("ensure daemon preserves the already-running result without spawning", async () => {
  let prepareCount = 0;
  let spawnCount = 0;
  let closeCount = 0;
  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () =>
        syncState({
          daemon_pid: 707,
          daemon_heartbeat_ms: 10_000,
        }),
      close: () => {
        closeCount++;
      },
    }),
    prepareDataDir: () => {
      prepareCount++;
    },
    openLog: () => {
      throw new Error("log should not open");
    },
    closeLog: () => {},
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => {
      spawnCount++;
      return fakeChild(808);
    },
    now: () => 10_001,
    sleep: async () => {},
    pidAlive: (pid) => pid === 707,
    controlReady: (pid, instanceId) =>
      pid === 707 && instanceId === TEST_DAEMON_INSTANCE,
    timeoutMs: 100,
    pollMs: 10,
  });

  expect(result).toEqual({ alreadyRunning: true, spawned: false });
  expect(prepareCount).toBe(0);
  expect(spawnCount).toBe(0);
  expect(closeCount).toBe(1);
});

test("an existing heartbeat is not ready until cooperative control is published", async () => {
  let clock = 10_001;
  let controlPublished = false;
  let spawnCount = 0;
  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () =>
        syncState({
          daemon_pid: 707,
          daemon_heartbeat_ms: 10_000,
        }),
      close: () => {},
    }),
    prepareDataDir: () => {},
    openLog: () => 91,
    closeLog: () => {},
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => {
      spawnCount++;
      return fakeChild(808);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      controlPublished = true;
    },
    pidAlive: (pid) => pid === 707,
    controlReady: (pid, instanceId) =>
      pid === 707 &&
      instanceId === TEST_DAEMON_INSTANCE &&
      controlPublished,
    timeoutMs: 100,
    pollMs: 10,
  });

  expect(result).toEqual({ alreadyRunning: true, spawned: false });
  expect(spawnCount).toBe(0);
  expect(controlPublished).toBe(true);
});

test("ensure daemon reports a live stale owner without spawning a writer", async () => {
  let spawnCount = 0;
  await expect(
    ensureDaemonRunningWith({
      createStore: () => ({
        getSyncState: () =>
          syncState({
            daemon_pid: 707,
            daemon_heartbeat_ms: 1,
          }),
        close: () => {},
      }),
      prepareDataDir: () => {},
      openLog: () => 91,
      closeLog: () => {},
      command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
      spawnProcess: () => {
        spawnCount++;
        return fakeChild(808);
      },
      now: () => 100_000,
      sleep: async () => {},
      pidAlive: (pid) => pid === 707,
      controlReady: () => false,
      timeoutMs: 100,
      pollMs: 10,
    }),
  ).rejects.toBeInstanceOf(DaemonStaleOwnerError);
  expect(spawnCount).toBe(0);
});

test("existing daemon readiness follows a live replacement identity", async () => {
  let state = syncState({
    daemon_pid: 707,
    daemon_heartbeat_ms: 10_000,
  });
  let clock = 10_001;
  let spawnCount = 0;

  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () => state,
      close: () => {},
    }),
    prepareDataDir: () => {},
    openLog: () => {
      throw new Error("log should not open");
    },
    closeLog: () => {},
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => {
      spawnCount++;
      return fakeChild(808);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      state = syncState({
        daemon_pid: 909,
        daemon_heartbeat_ms: clock,
        daemon_instance_id: TEST_SUCCESSOR_INSTANCE,
      });
    },
    pidAlive: (pid) => pid === 707 || pid === 909,
    controlReady: (pid, instanceId) =>
      pid === 909 && instanceId === TEST_SUCCESSOR_INSTANCE,
    timeoutMs: 100,
    pollMs: 10,
  });

  expect(result).toEqual({ alreadyRunning: true, spawned: false });
  expect(spawnCount).toBe(0);
});

test("ensure daemon kills a child that never becomes ready", async () => {
  const child = fakeChild(808);
  let clock = 10_000;
  let killCount = 0;
  child.kill = () => {
    killCount++;
    Object.defineProperty(child, "signalCode", {
      value: "SIGTERM",
      writable: true,
      configurable: true,
    });
    child.emit("exit", null, "SIGTERM");
    return true;
  };

  await expect(
    ensureDaemonRunningWith({
      createStore: () => ({
        getSyncState: () => syncState(),
        close: () => {},
      }),
      prepareDataDir: () => {},
      openLog: () => 91,
      closeLog: () => {},
      command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
      spawnProcess: () => child,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pidAlive: () => false,
      controlReady: () => false,
      timeoutMs: 20,
      pollMs: 10,
    }),
  ).rejects.toBeInstanceOf(DaemonLaunchError);
  expect(killCount).toBe(1);
});

test("concurrent winner is not reported until the losing child exits", async () => {
  const child = fakeChild(808);
  let state = syncState();
  let clock = 10_000;
  let exited = false;
  let cancelledTimers = 0;
  child.kill = () => {
    queueMicrotask(() => {
      exited = true;
      Object.defineProperty(child, "signalCode", {
        value: "SIGTERM",
        writable: true,
        configurable: true,
      });
      child.emit("exit", null, "SIGTERM");
    });
    return true;
  };

  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () => state,
      close: () => {},
    }),
    prepareDataDir: () => {},
    openLog: () => 91,
    closeLog: () => {},
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => child,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (state.daemon_pid === null) {
        state = syncState({
          daemon_pid: 909,
          daemon_heartbeat_ms: clock,
        });
      }
      await Promise.resolve();
    },
    pidAlive: (pid) => pid === 909,
    controlReady: (pid, instanceId) =>
      pid === 909 && instanceId === TEST_DAEMON_INSTANCE,
    timeoutMs: 100,
    pollMs: 10,
    scheduleTimer: () => ({}) as ReturnType<typeof setTimeout>,
    cancelTimer: () => {
      cancelledTimers++;
    },
  });

  expect(result).toEqual({ alreadyRunning: true, spawned: false });
  expect(exited).toBe(true);
  expect(cancelledTimers).toBe(1);
});

test("losing-child kill and reap failures are aggregated", async () => {
  const child = fakeChild(808);
  let clock = 10_000;
  const killError = new Error("kill failed");
  child.kill = () => {
    throw killError;
  };

  let caught: unknown;
  try {
    await ensureDaemonRunningWith({
      createStore: () => ({
        getSyncState: () => syncState(),
        close: () => {},
      }),
      prepareDataDir: () => {},
      openLog: () => 91,
      closeLog: () => {},
      command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
      spawnProcess: () => child,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pidAlive: () => false,
      controlReady: () => false,
      timeoutMs: 20,
      pollMs: 10,
      scheduleTimer: (callback) => {
        queueMicrotask(callback);
        return {} as ReturnType<typeof setTimeout>;
      },
      cancelTimer: () => {},
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const flattened = (caught as AggregateError).errors.flatMap((error) =>
    error instanceof AggregateError ? error.errors : [error],
  );
  expect(flattened).toContain(killError);
  expect(
    flattened.some(
      (error) =>
        error instanceof Error &&
        error.message.includes("did not exit after bounded SIGTERM and SIGKILL"),
    ),
  ).toBe(true);
});

test("stuck child escalates to SIGKILL and proves final exit", async () => {
  const child = fakeChild(808);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let state = syncState();
  let clock = 10_000;
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      Object.defineProperty(child, "signalCode", {
        value: "SIGKILL",
        writable: true,
        configurable: true,
      });
      child.emit("exit", null, "SIGKILL");
    }
    return true;
  };

  const result = await ensureDaemonRunningWith({
    createStore: () => ({
      getSyncState: () => state,
      close: () => {},
    }),
    prepareDataDir: () => {},
    openLog: () => 91,
    closeLog: () => {},
    command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
    spawnProcess: () => child,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      state = syncState({
        daemon_pid: 909,
        daemon_heartbeat_ms: clock,
      });
    },
    pidAlive: (pid) => pid === 909,
    controlReady: (pid, instanceId) =>
      pid === 909 && instanceId === TEST_DAEMON_INSTANCE,
    timeoutMs: 100,
    pollMs: 10,
    scheduleTimer: (callback) => {
      queueMicrotask(callback);
      return {} as ReturnType<typeof setTimeout>;
    },
    cancelTimer: () => {},
  });

  expect(result).toEqual({ alreadyRunning: true, spawned: false });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(child.signalCode).toBe("SIGKILL");
});

test("late child errors remain handled and observable during reap", async () => {
  const child = fakeChild(808);
  const lateError = new Error("late child failure");
  let state = syncState();
  let clock = 10_000;
  child.kill = () => {
    child.emit("error", lateError);
    Object.defineProperty(child, "signalCode", {
      value: "SIGTERM",
      writable: true,
      configurable: true,
    });
    child.emit("exit", null, "SIGTERM");
    return true;
  };

  await expect(
    ensureDaemonRunningWith({
      createStore: () => ({
        getSyncState: () => state,
        close: () => {},
      }),
      prepareDataDir: () => {},
      openLog: () => 91,
      closeLog: () => {},
      command: () => ({ executable: "/fixture/sana-mcp", args: ["daemon"] }),
      spawnProcess: () => child,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        state = syncState({
          daemon_pid: 909,
          daemon_heartbeat_ms: clock,
        });
      },
      pidAlive: (pid) => pid === 909,
      controlReady: (pid, instanceId) =>
        pid === 909 && instanceId === TEST_DAEMON_INSTANCE,
      timeoutMs: 100,
      pollMs: 10,
    }),
  ).rejects.toBe(lateError);
});
