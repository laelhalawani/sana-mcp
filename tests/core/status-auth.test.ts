import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status exposes and keeps a crashed authentication transition blocked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-auth-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { captureStatusSnapshot } = await import("./src/core/status.ts");
        const store = new SanaStore();
        const token = "11111111-1111-4111-8111-111111111111";
        const claim = store.claimAuthPublication(
          { generation: 0, publicationToken: null, userId: null, workspaceId: null },
          { userId: "user-a", workspaceId: "workspace-a" },
          "login",
          token,
          4242,
          () => false,
        );
        if (claim.kind !== "acquired") throw new Error("setup claim failed");

        const client = {
          hasAuthCookie: () => true,
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
        };
        const snapshot = captureStatusSnapshot(store, undefined, () => client);
        if (snapshot.kind !== "ready") {
          throw new Error("status snapshot did not stabilize");
        }
        const status = snapshot.status;
        const persisted = store.getSyncState();
        if (
          status.authTransition?.code !== "AUTH_PUBLICATION_ABORTED" ||
          !status.authTransition.message.includes("sign in again") ||
          status.blocking !== true ||
          persisted.auth_issue_code !== "AUTH_PUBLICATION_ABORTED" ||
          persisted.blocking !== 1
        ) {
          throw new Error(
            "status did not durably expose the crashed authentication transition",
          );
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("status exposes persisted daemon startup failure cause", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-sync-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { computeStatus } = await import("./src/core/status.ts");
        const { renderStatusInfo } = await import("./src/tools/dispatch.ts");
        const store = new SanaStore();
        store.recordSyncUnavailable(
          "LOGIN_SYNC_UNAVAILABLE",
          "DAEMON_READINESS_TIMEOUT",
          "daemon did not become ready",
        );
        const client = {
          hasAuthCookie: () => false,
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
        };
        const status = computeStatus(client, store);
        const rendered = renderStatusInfo(status);
        if (
          status.syncUnavailable?.code !== "LOGIN_SYNC_UNAVAILABLE" ||
          status.syncUnavailable.cause !== "DAEMON_READINESS_TIMEOUT" ||
          status.syncUnavailable.message !== "daemon did not become ready" ||
          !rendered.includes(
            "LOGIN_SYNC_UNAVAILABLE/DAEMON_READINESS_TIMEOUT",
          ) ||
          !rendered.includes("daemon did not become ready")
        ) {
          throw new Error("persisted daemon failure was absent from status");
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("status treats persisted authentication issues as an indivisible authoritative tuple", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-auth-issue-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { computeStatus } = await import("./src/core/status.ts");
        const store = new SanaStore();
        const client = {
          hasAuthCookie: () => true,
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
        };

        store.updateSyncState({
          blocking: 1,
          auth_pending: 1,
          auth_issue_code: "AUTH_PUBLICATION_ABORTED",
          auth_issue_message: null,
        });
        const malformed = computeStatus(client, store);
        if (
          malformed.authTransition?.code !== "AUTH_STATE_MALFORMED" ||
          malformed.authTransition.message !==
            "Persisted authentication issue tuple is malformed" ||
          malformed.blocking !== true ||
          malformed.meetings !== null ||
          malformed.transcripts !== null
        ) {
          throw new Error("status masked a malformed authentication issue tuple");
        }

        store.updateSyncState({
          auth_issue_code: "AUTH_PUBLICATION_ABORTED",
          auth_issue_message: "A paired persisted issue remains authoritative",
        });
        const healthy = computeStatus(client, store);
        if (
          healthy.authTransition?.code !== "AUTH_PUBLICATION_ABORTED" ||
          healthy.authTransition.message !==
            "A paired persisted issue remains authoritative"
        ) {
          throw new Error("status changed a healthy authentication issue tuple");
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("current ephemeral persistence failure outranks durable issue and hides blocked cache metrics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-current-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { computeStatus } = await import("./src/core/status.ts");
        const store = new SanaStore();
        store.recordSyncUnavailable(
          "OLDER_SYNC_FAILURE",
          "OLD_CAUSE",
          "older persisted problem",
        );
        store.upsertMeeting({
          id: "old-cache-meeting",
          name: "must remain hidden",
          source: "sana-ai:meeting",
          created_at_ms: 1,
        });
        const client = {
          hasAuthCookie: () => false,
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
        };
        const status = computeStatus(client, store, {
          code: "SYNC_STATUS_PERSISTENCE_FAILED",
          cause: "SQLiteError",
          message: "current status write failed",
        });
        if (
          status.syncUnavailable?.code !==
            "SYNC_STATUS_PERSISTENCE_FAILED" ||
          status.previousSyncUnavailable?.code !== "OLDER_SYNC_FAILURE" ||
          status.meetings !== null ||
          status.transcripts !== null ||
          status.semantic.embedded !== null
        ) {
          throw new Error(
            "current failure was masked or blocked cache metrics leaked",
          );
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("status returns typed retry when the paired session snapshot never stabilizes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-race-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { captureStatusSnapshot } = await import("./src/core/status.ts");
        const store = new SanaStore();
        let load = 0;
        const clients = [
          {
            hasAuthCookie: () => false,
            sessionVersion: () => ({
              generation: 0,
              publicationToken: null,
              userId: null,
              workspaceId: null,
            }),
          },
          {
            hasAuthCookie: () => true,
            sessionVersion: () => ({
              generation: 1,
              publicationToken:
                "11111111-1111-4111-8111-111111111111",
              userId: "user-a",
              workspaceId: "workspace-a",
            }),
          },
        ];
        const snapshot = captureStatusSnapshot(
          store,
          undefined,
          () => clients[load++ % 2],
        );
        if (
          snapshot.kind !== "retry" ||
          snapshot.code !== "AUTH_STATUS_SNAPSHOT_CHANGED"
        ) {
          throw new Error("unstable status snapshot was exposed");
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("ephemeral sync persistence issue is exposed only for its exact auth and cache tuple", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-status-bound-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const { captureStatusSnapshot } = await import("./src/core/status.ts");
        const store = new SanaStore();
        const client = {
          hasAuthCookie: () => false,
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
        };
        const issue = {
          code: "SYNC_STATUS_PERSISTENCE_FAILED",
          cause: "SQLiteError",
          message: "current persistence failed",
        };
        const stale = captureStatusSnapshot(
          store,
          {
            issue,
            binding: {
              authGeneration: 1,
              authPublicationToken:
                "11111111-1111-4111-8111-111111111111",
              authUserId: "user-a",
              authWorkspaceId: "workspace-a",
              cacheUserId: "user-a",
              cacheWorkspaceId: "workspace-a",
            },
          },
          () => client,
        );
        if (
          stale.kind !== "ready" ||
          stale.status.syncUnavailable !== undefined
        ) {
          throw new Error("stale ephemeral issue crossed generations");
        }
        const current = captureStatusSnapshot(
          store,
          {
            issue,
            binding: {
              authGeneration: 0,
              authPublicationToken: null,
              authUserId: null,
              authWorkspaceId: null,
              cacheUserId: null,
              cacheWorkspaceId: null,
            },
          },
          () => client,
        );
        if (
          current.kind !== "ready" ||
          current.status.syncUnavailable?.code !==
            "SYNC_STATUS_PERSISTENCE_FAILED"
        ) {
          throw new Error("matching ephemeral issue was lost");
        }
        store.close();
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: root,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  expect(child.status, child.stderr).toBe(0);
});
