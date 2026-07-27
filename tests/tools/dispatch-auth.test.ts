import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SanaClient } from "../../src/sana/client.js";
import type { SyncState } from "../../src/store/db.js";
import {
  ephemeralSyncPersistenceIssue,
  refreshedAuthorization,
} from "../../src/tools/dispatch.js";
import { CacheOperationChangedError } from "../../src/store/db.js";

const ROOT = path.resolve(import.meta.dir, "../..");

function state(patch: Partial<SyncState> = {}): SyncState {
  return {
    phase: "idle",
    message: "",
    meetings_total: 0,
    transcripts_done: 0,
    transcripts_total: 0,
    last_full_sync_ms: null,
    last_incremental_ms: null,
    daemon_pid: null,
    daemon_heartbeat_ms: null,
    blocking: 0,
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
}

test("post-start authorization uses refreshed session and sync state", () => {
  const staleClient = {
    hasAuthCookie: () => true,
    pendingSignInChallenge: () => null,
    sessionVersion: () => ({
      generation: 0,
      publicationToken: null,
      userId: null,
      workspaceId: null,
    }),
  } as SanaClient;
  const staleState = state();
  expect(staleClient.hasAuthCookie()).toBe(true);
  expect(staleState.phase).toBe("idle");

  const refreshedClient = {
    hasAuthCookie: () => true,
    pendingSignInChallenge: () => null,
    sessionVersion: () => ({
      generation: 0,
      publicationToken: null,
      userId: null,
      workspaceId: null,
    }),
  } as SanaClient;
  const refreshed = refreshedAuthorization(
    {
      getSyncState: () => state({ phase: "needs_login", blocking: 1 }),
      reconcileAuthState: () => ({ kind: "current", generation: 0 }),
    },
    () => refreshedClient,
  );
  expect(refreshed).toEqual({ kind: "expired" });
});

test("post-start authorization rejects a newly removed session", () => {
  const refreshed = refreshedAuthorization(
    {
      getSyncState: () => state({ blocking: 1 }),
      reconcileAuthState: () => ({ kind: "current", generation: 0 }),
    },
    () =>
      ({
        hasAuthCookie: () => false,
        pendingSignInChallenge: () => null,
        sessionVersion: () => ({
          generation: 0,
          publicationToken: null,
          userId: null,
          workspaceId: null,
        }),
      }) as SanaClient,
  );
  expect(refreshed).toEqual({ kind: "signed-out" });
});

test("post-start authorization treats a pending sign-in challenge as signed out", () => {
  const refreshed = refreshedAuthorization(
    {
      getSyncState: () =>
        state({
          phase: "synced",
          auth_generation: 2,
          auth_publication_token:
            "22222222-2222-4222-8222-222222222222",
          auth_user_id: "user-a",
          auth_workspace_id: "workspace-a",
          cache_user_id: "user-a",
          cache_workspace_id: "workspace-a",
        }),
      reconcileAuthState: () => ({ kind: "current", generation: 2 }),
    },
    () =>
      ({
        hasAuthCookie: () => true,
        pendingSignInChallenge: () => ({
          email: "pending@example.test",
        }),
        sessionVersion: () => ({
          generation: 2,
          publicationToken:
            "22222222-2222-4222-8222-222222222222",
          userId: "user-a",
          workspaceId: "workspace-a",
        }),
      }) as SanaClient,
  );
  expect(refreshed).toEqual({ kind: "signed-out" });
});

test("post-start authorization retries a racing persisted session snapshot", () => {
  const tokenA = "11111111-1111-4111-8111-111111111111";
  const tokenB = "22222222-2222-4222-8222-222222222222";
  let generation = 1;
  let loadCalls = 0;
  const client = (nextGeneration: number, token: string) =>
    ({
      hasAuthCookie: () => true,
      pendingSignInChallenge: () => null,
      sessionVersion: () => ({
        generation: nextGeneration,
        publicationToken: token,
        userId: "user-a",
        workspaceId: "workspace-a",
      }),
    }) as SanaClient;
  const loadClient = () => {
    loadCalls++;
    if (loadCalls === 1) return client(1, tokenA);
    generation = 2;
    return client(2, tokenB);
  };
  const storeState = () =>
    state({
      phase: "synced",
      auth_generation: generation,
      auth_publication_token: generation === 1 ? tokenA : tokenB,
      auth_user_id: "user-a",
      auth_workspace_id: "workspace-a",
      cache_user_id: "user-a",
      cache_workspace_id: "workspace-a",
    });
  const refreshed = refreshedAuthorization(
    {
      getSyncState: storeState,
      reconcileAuthState: (version) => ({
        kind: "current",
        generation: version.generation,
      }),
    },
    loadClient,
  );
  expect(refreshed.kind).toBe("authorized");
  if (refreshed.kind === "authorized") {
    expect(refreshed.state.auth_generation).toBe(2);
    expect(refreshed.client.sessionVersion().publicationToken).toBe(tokenB);
  }
  expect(loadCalls).toBe(4);
});

test("post-start authorization blocks an active publication instead of confirming it", () => {
  const token = "11111111-1111-4111-8111-111111111111";
  const pendingClient = {
    hasAuthCookie: () => true,
    pendingSignInChallenge: () => null,
    sessionVersion: () => ({
      generation: 1,
      publicationToken: token,
      userId: "user-a",
      workspaceId: "workspace-a",
    }),
  } as SanaClient;
  const refreshed = refreshedAuthorization(
    {
      getSyncState: () => state(),
      reconcileAuthState: () => ({
        kind: "incomplete",
        code: "AUTH_PUBLICATION_IN_PROGRESS",
        message: "publisher is live",
      }),
    },
    () => pendingClient,
  );
  expect(refreshed).toEqual({
    kind: "blocked",
    code: "AUTH_PUBLICATION_IN_PROGRESS",
    message: "publisher is live",
  });
});

test("stale sync-status CAS never becomes a current ephemeral failure", () => {
  expect(
    ephemeralSyncPersistenceIssue(
      new CacheOperationChangedError(),
      "DAEMON_FAILURE",
      "old generation daemon failed",
    ),
  ).toBeUndefined();
  expect(
    ephemeralSyncPersistenceIssue(
      new Error("database unavailable"),
      "DAEMON_FAILURE",
      "current daemon failed",
    )?.code,
  ).toBe("SYNC_STATUS_PERSISTENCE_FAILED");
});

test("help reconciles a malformed authentication issue tuple without fallback prose", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-help-auth-issue-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const fs = await import("node:fs");
          const path = await import("node:path");
          const dataDir = process.env.SANA_DATA_DIR;
          if (!dataDir) throw new Error("missing isolated data directory");
          fs.writeFileSync(
            path.join(dataDir, "session.json"),
            JSON.stringify({
              cookies: { "sana-ai-session": "isolated-test-session" },
              userId: "user-help",
              workspaceId: "workspace-help",
              email: "help@example.test",
              authenticatedOrigin: process.env.SANA_BASE_URL,
              pendingLogin: null,
              generation: 1,
              publicationToken: "11111111-1111-4111-8111-111111111111",
            }),
            { mode: 0o600 },
          );
          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          store.updateSyncState({
            phase: "synced",
            blocking: 1,
            auth_pending: 1,
            auth_generation: 1,
            auth_publication_token:
              "11111111-1111-4111-8111-111111111111",
            auth_user_id: "user-help",
            auth_workspace_id: "workspace-help",
            cache_user_id: "user-help",
            cache_workspace_id: "workspace-help",
            auth_issue_code: "AUTH_PUBLICATION_ABORTED",
            auth_issue_message: null,
          });
          store.close();

          const { sana } = await import("./src/tools/dispatch.ts");
          const output = await sana("help");
          if (
            !output.includes("Authentication is incomplete (AUTH_STATE_MALFORMED)") ||
            !output.includes("Persisted authentication issue tuple is malformed") ||
            output.includes("the local session could not be confirmed") ||
            output.includes("(AUTH_PUBLICATION_ABORTED): Authentication is incomplete")
          ) {
            throw new Error("help masked the malformed authentication issue tuple");
          }

          const verified = new SanaStore();
          const state = verified.getSyncState();
          verified.close();
          if (
            state.auth_issue_code !== "AUTH_STATE_MALFORMED" ||
            state.auth_issue_message !==
              "Persisted authentication issue tuple is malformed"
          ) {
            throw new Error("help did not reconcile the malformed tuple");
          }
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SANA_DATA_DIR: root,
          SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
          SANA_BASE_URL: "https://help-auth-issue.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("help preserves a healthy paired authentication issue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-help-auth-issue-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const fs = await import("node:fs");
          const path = await import("node:path");
          const dataDir = process.env.SANA_DATA_DIR;
          if (!dataDir) throw new Error("missing isolated data directory");
          fs.writeFileSync(
            path.join(dataDir, "session.json"),
            JSON.stringify({
              cookies: { "sana-ai-session": "isolated-test-session" },
              userId: "user-help",
              workspaceId: "workspace-help",
              email: "help@example.test",
              authenticatedOrigin: process.env.SANA_BASE_URL,
              pendingLogin: null,
              generation: 1,
              publicationToken: "11111111-1111-4111-8111-111111111111",
            }),
            { mode: 0o600 },
          );
          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          store.updateSyncState({
            phase: "synced",
            blocking: 1,
            auth_pending: 1,
            auth_generation: 1,
            auth_publication_token:
              "11111111-1111-4111-8111-111111111111",
            auth_user_id: "user-help",
            auth_workspace_id: "workspace-help",
            cache_user_id: "user-help",
            cache_workspace_id: "workspace-help",
            auth_issue_code: "AUTH_PUBLICATION_ABORTED",
            auth_issue_message: "The paired issue remains authoritative",
          });
          store.close();

          const { sana } = await import("./src/tools/dispatch.ts");
          const output = await sana("help");
          if (
            !output.includes(
              "Authentication is incomplete (AUTH_PUBLICATION_ABORTED): The paired issue remains authoritative.",
            ) ||
            output.includes("AUTH_STATE_MALFORMED")
          ) {
            throw new Error("help changed a healthy authentication issue tuple");
          }
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SANA_DATA_DIR: root,
          SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
          SANA_BASE_URL: "https://help-auth-issue.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public data dispatch renders existing signed-out guidance for a pending challenge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-dispatch-pending-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const fs = await import("node:fs");
          const path = await import("node:path");
          const dataDir = process.env.SANA_DATA_DIR;
          if (!dataDir) throw new Error("missing isolated data directory");
          fs.writeFileSync(
            path.join(dataDir, "session.json"),
            JSON.stringify({
              cookies: { "sana-ai-session": "old-session-cookie" },
              userId: "user-old",
              workspaceId: "workspace-old",
              email: "old@example.test",
              authenticatedOrigin: process.env.SANA_BASE_URL,
              pendingLogin: {
                email: "pending@example.test",
                csrfToken: "private-pending-token",
              },
              generation: 2,
              publicationToken:
                "22222222-2222-4222-8222-222222222222",
            }),
            { mode: 0o600 },
          );
          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          store.updateSyncState({
            phase: "synced",
            blocking: 0,
            auth_pending: 0,
            auth_generation: 2,
            auth_publication_token:
              "22222222-2222-4222-8222-222222222222",
            auth_user_id: "user-old",
            auth_workspace_id: "workspace-old",
            cache_user_id: "user-old",
            cache_workspace_id: "workspace-old",
          });
          store.upsertMeeting({
            id: "old-private-meeting",
            name: "Old private meeting",
            source: "sana-ai:meeting",
            created_at_ms: 1,
          });
          store.close();

          const { sana } = await import("./src/tools/dispatch.ts");
          const output = await sana("list");
          const expected =
            'You are not logged in. Run meeting_transcripts("login", {"email":"you@example.com"}) to sign in.';
          if (output !== expected || output.includes("Old private meeting")) {
            throw new Error("pending challenge exposed data or rendered expiry");
          }
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SANA_DATA_DIR: root,
          SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
          SANA_BASE_URL: "https://dispatch-pending.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status rejects a pending challenge introduced by its stable pre-daemon snapshot", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-status-pending-race-"),
  );
  try {
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const token =
            "11111111-1111-4111-8111-111111111111";
          const instanceId =
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
          const origin = process.env.SANA_BASE_URL;
          if (!origin) throw new Error("missing isolated Sana origin");

          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          store.updateSyncState({
            phase: "downloading",
            message: "old cache sync in progress",
            meetings_total: 1,
            transcripts_total: 1,
            transcripts_done: 0,
            blocking: 1,
            auth_pending: 0,
            auth_generation: 1,
            auth_publication_token: token,
            auth_user_id: "user-race",
            auth_workspace_id: "workspace-race",
            cache_user_id: "user-race",
            cache_workspace_id: "workspace-race",
            sync_issue_code: "SYNC_SENTINEL",
            sync_issue_cause: "TEST_SENTINEL",
            sync_issue_message:
              "daemon startup must not clear this sentinel",
            daemon_pid: process.pid,
            daemon_heartbeat_ms: Date.now(),
            daemon_instance_id: instanceId,
          });
          store.close();

          const { publishDaemonControl } = await import(
            "./src/sync/control.ts"
          );
          publishDaemonControl(process.pid, { instanceId });

          const { SanaClient } = await import("./src/sana/client.ts");
          const session = {
            cookies: { "sana-ai-session": "old-session-cookie" },
            userId: "user-race",
            workspaceId: "workspace-race",
            email: "old@example.test",
            authenticatedOrigin: origin,
            generation: 1,
            publicationToken: token,
          };
          const initial = new SanaClient({
            ...session,
            pendingLogin: null,
          });
          const pending = new SanaClient({
            ...session,
            pendingLogin: {
              email: "pending@example.test",
              csrfToken: "private-pending-token",
            },
          });
          let loadCalls = 0;
          SanaClient.load = () => {
            loadCalls++;
            return loadCalls === 1 ? initial : pending;
          };

          const { sana } = await import("./src/tools/dispatch.ts");
          const output = await sana("status");
          const expected =
            'You are not logged in. Run meeting_transcripts("login", {"email":"you@example.com"}) to sign in.';
          if (output !== expected || loadCalls !== 3) {
            throw new Error(
              "status did not authorize from the pending stable snapshot",
            );
          }

          const verified = new SanaStore();
          const verifiedState = verified.getSyncState();
          verified.close();
          if (
            verifiedState.sync_issue_code !== "SYNC_SENTINEL" ||
            verifiedState.sync_issue_cause !== "TEST_SENTINEL" ||
            verifiedState.sync_issue_message !==
              "daemon startup must not clear this sentinel"
          ) {
            throw new Error(
              "status reached daemon startup before rejecting pending auth",
            );
          }
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          SANA_DATA_DIR: root,
          SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
          SANA_BASE_URL: "https://status-pending-race.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
