import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 50,
      retryDelay: 100,
    });
  }
});

function isolatedPublication(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-session-publish-"));
  roots.push(root);
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
        const { SanaStore } = await import("./src/store/db.ts");
        const {
          publishClientSession,
          StaleSessionWriterError,
        } = await import("./src/sana/session-publication.ts");
        function writer(
          generation,
          publicationToken,
          userId = "user-authoritative",
          workspaceId = "workspace-authoritative",
        ) {
          let version = {
            generation,
            publicationToken,
            userId,
            workspaceId,
          };
          let saveCount = 0;
          return {
            sessionVersion: () => version,
            savePublication: (nextGeneration, token) => {
              saveCount++;
              version = {
                generation: nextGeneration,
                publicationToken: token,
                userId,
                workspaceId,
              };
            },
            saves: () => saveCount,
          };
        }
        const database = new SanaStore();
        try {
          ${source}
        } finally {
          database.close();
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
        SANA_SEMANTIC: "0",
      },
    },
  );
}

test("stale daemon and request-code writers cannot overwrite a confirmed login", () => {
  const child = isolatedPublication(`
    const login = writer(0, null);
    publishClientSession(database, login, "login", {
      generation: 0,
      publicationToken: null,
      userId: null,
      workspaceId: null,
    });
    const confirmed = login.sessionVersion();
    if (confirmed.generation !== 1) {
      throw new Error("initial login generation was not confirmed");
    }

    for (const kind of ["refresh", "request-code"]) {
      const stale = writer(0, null);
      let caught;
      try {
        publishClientSession(database, stale, kind, {
          generation: 0,
          publicationToken: null,
          userId: null,
          workspaceId: null,
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof StaleSessionWriterError)) {
        throw caught ?? new Error("stale " + kind + " writer was accepted");
      }
      if (stale.saves() !== 0) {
        throw new Error("stale " + kind + " writer persisted session data");
      }
    }

    const state = database.getSyncState();
    if (
      state.auth_generation !== 1 ||
      state.auth_publication_token !== confirmed.publicationToken
    ) {
      throw new Error("stale writer changed the confirmed publication");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("authentication generations advance monotonically without wall-clock ordering", () => {
  const child = isolatedPublication(`
    const first = writer(0, null, null, null);
    publishClientSession(database, first, "request-code");
    const firstVersion = first.sessionVersion();
    const second = writer(
      firstVersion.generation,
      firstVersion.publicationToken,
      "user-authoritative",
      "workspace-authoritative",
    );
    publishClientSession(database, second, "login", firstVersion);
    if (
      second.sessionVersion().generation !== 2 ||
      database.getSyncState().catchup_generation !== 2
    ) {
      throw new Error("authentication generations did not advance monotonically");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});
