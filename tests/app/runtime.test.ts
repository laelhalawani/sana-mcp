import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

test("in-memory pending sign-in blocks LocalAppRuntime before store publication", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-app-pending-prepublication-"),
  );
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

          const readyToken =
            "11111111-1111-4111-8111-111111111111";
          const readyTuple = {
            generation: 1,
            publicationToken: readyToken,
            userId: "user-old",
            workspaceId: "workspace-old",
          };
          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          store.updateSyncState({
            phase: "synced",
            blocking: 0,
            auth_pending: 0,
            auth_generation: readyTuple.generation,
            auth_publication_token: readyTuple.publicationToken,
            auth_user_id: readyTuple.userId,
            auth_workspace_id: readyTuple.workspaceId,
            cache_user_id: readyTuple.userId,
            cache_workspace_id: readyTuple.workspaceId,
          });
          store.upsertMeeting({
            id: "old-private-meeting",
            name: "Old private meeting",
            source: "sana-ai:meeting",
            created_at_ms: 1,
            processing_phase: "done",
          });
          store.saveTranscript({
            meeting_id: "old-private-meeting",
            text: "old private transcript",
            json: JSON.stringify([
              {
                speaker: "Private speaker",
                words: [
                  {
                    text: "private",
                    start_timestamp: 1,
                    end_timestamp: 2,
                  },
                ],
              },
            ]),
            word_count: 1,
            segment_count: 1,
          });
          store.saveMetadata({
            meeting_id: "old-private-meeting",
            summary: "old private summary",
            summary_short: "private",
            notes_json: "[]",
            participants_json: "[]",
            has_recording: 1,
          });
          store.close();

          fs.writeFileSync(
            path.join(dataDir, "session.json"),
            JSON.stringify({
              cookies: { "sana-ai-session": "old-session-cookie" },
              userId: readyTuple.userId,
              workspaceId: readyTuple.workspaceId,
              email: "old@example.test",
              authenticatedOrigin: process.env.SANA_BASE_URL,
              pendingLogin: {
                email: "pending@example.test",
                csrfToken: "private-pending-token",
              },
              generation: readyTuple.generation,
              publicationToken: readyTuple.publicationToken,
            }),
            { mode: 0o600 },
          );

          const { LocalAppRuntime } = await import("./src/app/runtime.ts");
          const runtime = new LocalAppRuntime();
          const originalStore = runtime.store;
          const originalFetch = globalThis.fetch;
          let storeReached = false;
          let networkReached = false;
          runtime.store = new Proxy(originalStore, {
            get() {
              storeReached = true;
              throw new Error(
                "private store path reached before pending rejection",
              );
            },
          });
          globalThis.fetch = async () => {
            networkReached = true;
            throw new Error(
              "network path reached before pending rejection",
            );
          };
          const assertBlocked = async (name, operation) => {
            let blocked = false;
            try {
              await operation();
            } catch (error) {
              blocked = error?.code === "CACHE_OPERATION_CHANGED";
            }
            if (!blocked) {
              throw new Error(
                name + " did not return the typed cache-operation failure",
              );
            }
          };
          try {
            await assertBlocked("meetings", () => runtime.meetings({}));
            await assertBlocked("search", () =>
              runtime.search({ query: "private" }),
            );
            await assertBlocked("transcript", () =>
              runtime.transcript("old-private-meeting"),
            );
            await assertBlocked("summary", () =>
              runtime.summary("old-private-meeting"),
            );
            await assertBlocked("participants", () =>
              runtime.participants("old-private-meeting"),
            );
            await assertBlocked("recording", () =>
              runtime.recording("old-private-meeting"),
            );
            if (storeReached || networkReached) {
              throw new Error(
                "pending rejection reached private store or network work",
              );
            }
          } finally {
            globalThis.fetch = originalFetch;
            runtime.store = originalStore;
            runtime.close();
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
          SANA_BASE_URL:
            "https://app-pending-prepublication.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending sign-in blocks every LocalAppRuntime cache-backed data method", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-app-pending-"));
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

          const readyToken =
            "11111111-1111-4111-8111-111111111111";
          const pendingToken =
            "22222222-2222-4222-8222-222222222222";
          const readyTuple = {
            generation: 1,
            publicationToken: readyToken,
            userId: "user-old",
            workspaceId: "workspace-old",
          };
          const { SanaStore } = await import("./src/store/db.ts");
          const store = new SanaStore();
          const login = store.claimAuthPublication(
            {
              generation: 0,
              publicationToken: null,
              userId: null,
              workspaceId: null,
            },
            {
              userId: readyTuple.userId,
              workspaceId: readyTuple.workspaceId,
            },
            "login",
            readyToken,
            101,
            () => false,
          );
          if (login.kind !== "acquired") {
            throw new Error("ready authentication setup failed");
          }
          store.confirmAuthPublication(login.intent, 1);
          store.activateCacheIdentity(readyTuple);
          store.writeSyncGeneration(readyTuple, () => {
            store.upsertMeeting({
              id: "old-private-meeting",
              name: "Old private meeting",
              source: "sana-ai:meeting",
              created_at_ms: 1,
              processing_phase: "done",
            });
            store.saveTranscript({
              meeting_id: "old-private-meeting",
              text: "old private transcript",
              json: JSON.stringify([
                {
                  speaker: "Private speaker",
                  words: [
                    {
                      text: "private",
                      start_timestamp: 1,
                      end_timestamp: 2,
                    },
                  ],
                },
              ]),
              word_count: 1,
              segment_count: 1,
            });
            store.saveMetadata({
              meeting_id: "old-private-meeting",
              summary: "old private summary",
              summary_short: "private",
              notes_json: "[]",
              participants_json: "[]",
              has_recording: 1,
            });
          });
          store.updateSyncState({
            phase: "synced",
            blocking: 0,
            auth_pending: 0,
          });

          const request = store.claimAuthPublication(
            readyTuple,
            {
              userId: readyTuple.userId,
              workspaceId: readyTuple.workspaceId,
            },
            "request-code",
            pendingToken,
            102,
            () => false,
          );
          if (request.kind !== "acquired") {
            throw new Error("pending request setup failed");
          }
          store.confirmAuthPublication(request.intent, 2);
          if (store.getSyncState().blocking !== 1) {
            throw new Error("confirmed pending request did not block the cache");
          }
          store.close();

          fs.writeFileSync(
            path.join(dataDir, "session.json"),
            JSON.stringify({
              cookies: { "sana-ai-session": "old-session-cookie" },
              userId: readyTuple.userId,
              workspaceId: readyTuple.workspaceId,
              email: "old@example.test",
              authenticatedOrigin: process.env.SANA_BASE_URL,
              pendingLogin: {
                email: "pending@example.test",
                csrfToken: "private-pending-token",
              },
              generation: 2,
              publicationToken: pendingToken,
            }),
            { mode: 0o600 },
          );

          const { LocalAppRuntime } = await import("./src/app/runtime.ts");
          const runtime = new LocalAppRuntime();
          const assertBlocked = async (name, operation) => {
            let blocked = false;
            try {
              await operation();
            } catch (error) {
              blocked = error?.code === "CACHE_OPERATION_CHANGED";
            }
            if (!blocked) {
              throw new Error(name + " exposed the old cache");
            }
          };
          try {
            await assertBlocked("meetings", () => runtime.meetings({}));
            await assertBlocked("search", () =>
              runtime.search({ query: "private" }),
            );
            await assertBlocked("transcript", () =>
              runtime.transcript("old-private-meeting"),
            );
            await assertBlocked("summary", () =>
              runtime.summary("old-private-meeting"),
            );
            await assertBlocked("participants", () =>
              runtime.participants("old-private-meeting"),
            );
            await assertBlocked("recording", () =>
              runtime.recording("old-private-meeting"),
            );
          } finally {
            runtime.close();
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
          SANA_BASE_URL: "https://app-pending.example.test",
          SANA_SEMANTIC: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
