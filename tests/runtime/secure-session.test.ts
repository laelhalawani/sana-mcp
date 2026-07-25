import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function isolatedRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-secure-session-"));
  temporaryRoots.push(root);
  return root;
}

function runIsolated(root: string, source: string) {
  return spawnSync(process.execPath, ["-e", source], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SANA_DATA_DIR: root,
      SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
      SANA_SEMANTIC: "0",
    },
  });
}

describe("secure session persistence integration", () => {
  test("writes and reloads a validated session in an isolated secure root", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    const child = runIsolated(
      root,
      `
        const { SanaClient } = await import("./src/sana/client.ts");
        const { SanaStore } = await import("./src/store/db.ts");
        const { publishClientSession } = await import(
          "./src/sana/session-publication.ts"
        );
        const client = new SanaClient();
        const store = new SanaStore();
        publishClientSession(store, client, "request-code");
        store.close();
        if (SanaClient.load().hasAuthCookie()) throw new Error("unexpected auth");
      `,
    );
    expect(child.status, child.stderr).toBe(0);

    const session = path.join(root, "session.json");
    expect(JSON.parse(fs.readFileSync(session, "utf8"))).toEqual({
      cookies: {},
      generation: 1,
      pendingLogin: null,
      publicationToken: expect.any(String),
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(session).mode & 0o777).toBe(0o600);
    }
  });

  test("preserves and copies a corrupt session while failing visibly", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    fs.writeFileSync(path.join(root, "session.json"), "{");
    const child = runIsolated(
      root,
      `
        const { SanaClient } = await import("./src/sana/client.ts");
        const { CorruptJsonFileError } = await import("./src/runtime/secure-files.ts");
        try {
          SanaClient.load();
          throw new Error("corrupt session was accepted");
        } catch (error) {
          if (!(error instanceof CorruptJsonFileError)) throw error;
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, "session.json"), "utf8")).toBe("{");
    const recovery = "session.json.corrupt";
    expect(fs.readdirSync(root)).toContain(recovery);
    expect(fs.readFileSync(path.join(root, recovery), "utf8")).toBe("{");
  });

  test("rejects partial or fabricated publication metadata", {
    timeout: 20_000,
  }, () => {
    for (const invalid of [
      {
        cookies: {},
        generation: 1,
      },
      {
        cookies: {},
        publicationToken: "11111111-1111-4111-8111-111111111111",
      },
      {
        cookies: {},
        generation: 0,
        publicationToken: "11111111-1111-4111-8111-111111111111",
      },
      {
        cookies: {},
        generation: 1,
        publicationToken: "11111111-1111-4111-8111-111111111111",
        userId: "user-without-workspace",
      },
      {
        cookies: {},
        generation: 1,
        publicationToken: "11111111-1111-4111-8111-111111111111",
        userId: "   ",
        workspaceId: "workspace-a",
      },
      {
        cookies: {},
        generation: 1,
        publicationToken: "11111111-1111-4111-8111-111111111111",
        userId: "user-a",
        workspaceId: " padded-workspace ",
      },
      {
        cookies: {},
        userId: " padded-user ",
        workspaceId: "workspace-a",
      },
    ]) {
      const root = isolatedRoot();
      fs.writeFileSync(
        path.join(root, "session.json"),
        JSON.stringify(invalid),
      );
      const child = runIsolated(
        root,
        `
          const { SanaClient } = await import("./src/sana/client.ts");
          const { CorruptJsonFileError } = await import(
            "./src/runtime/secure-files.ts"
          );
          try {
            SanaClient.load();
            throw new Error("partial publication metadata was accepted");
          } catch (error) {
            if (!(error instanceof CorruptJsonFileError)) throw error;
          }
        `,
      );
      expect(child.status, child.stderr).toBe(0);
    }
  });

  test("session without an authenticated origin requires a fresh login", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    fs.writeFileSync(
      path.join(root, "session.json"),
      JSON.stringify({
        cookies: { "sana-ai-session": "legacy-cookie" },
        workspaceId: "legacy-workspace",
      }),
    );
    const child = runIsolated(
      root,
      `
        const {
          LegacyPartialSessionError,
          SanaClient,
        } = await import("./src/sana/client.ts");
        let caught;
        try {
          SanaClient.load();
        } catch (error) {
          caught = error;
        }
        if (!(caught instanceof LegacyPartialSessionError)) {
          throw caught ?? new Error("unbound session was accepted");
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
  });

  test("origin-change login clears credentials but preserves the exact CAS baseline", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    fs.writeFileSync(
      path.join(root, "session.json"),
      JSON.stringify({
        cookies: { "sana-ai-session": "old-origin-cookie" },
        userId: "user-a",
        workspaceId: "workspace-a",
        email: "person@example.test",
        generation: 5,
        publicationToken: "11111111-1111-4111-8111-111111111111",
        authenticatedOrigin: "https://old-origin.example",
        pendingLogin: {
          email: "stale@example.test",
          csrfToken: "stale-challenge",
        },
      }),
    );
    const child = runIsolated(
      root,
      `
        const { SanaClient } = await import("./src/sana/client.ts");
        const recovery = SanaClient.loadForOriginChangeLogin();
        if (recovery.baseline !== "preserved") {
          throw new Error("authoritative baseline was reset");
        }
        const client = recovery.client;
        const version = client.sessionVersion();
        if (
          client.hasAuthCookie() ||
          version.generation !== 5 ||
          version.publicationToken !==
            "11111111-1111-4111-8111-111111111111" ||
          version.userId !== "user-a" ||
          version.workspaceId !== "workspace-a"
        ) {
          throw new Error("origin-change recovery lost the confirmed CAS baseline");
        }
        globalThis.fetch = async () => {
          throw new Error("fresh request reached fetch");
        };
        try {
          await client.submitSignInCode("stale@example.test", "123456");
        } catch (error) {
          if (error?.code !== "NO_PENDING_LOGIN") throw error;
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
  });

  test("partial legacy origin state resets explicitly without routing identity", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    fs.writeFileSync(
      path.join(root, "session.json"),
      JSON.stringify({
        cookies: { "sana-ai-session": "legacy-cookie" },
        workspaceId: "legacy-workspace",
      }),
    );
    const child = runIsolated(
      root,
      `
        const { SanaClient } = await import("./src/sana/client.ts");
        const recovery = SanaClient.loadForOriginChangeLogin();
        const version = recovery.client.sessionVersion();
        if (
          recovery.baseline !== "reset-partial-legacy" ||
          recovery.client.hasAuthCookie() ||
          version.generation !== 0 ||
          version.publicationToken !== null ||
          version.userId !== null ||
          version.workspaceId !== null
        ) {
          throw new Error("partial legacy identity was preserved or routed");
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
  });

  test("generation-less pending challenge resets even without an auth cookie", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    fs.writeFileSync(
      path.join(root, "session.json"),
      JSON.stringify({
        cookies: {},
        pendingLogin: {
          email: "stale@example.test",
          csrfToken: "stale-challenge",
        },
      }),
    );
    const child = runIsolated(
      root,
      `
        const {
          LegacyPartialSessionError,
          SanaClient,
        } = await import("./src/sana/client.ts");
        let loadError;
        try {
          SanaClient.load();
        } catch (error) {
          loadError = error;
        }
        if (!(loadError instanceof LegacyPartialSessionError)) {
          throw loadError ?? new Error("legacy pending challenge was accepted");
        }
        const recovery = SanaClient.loadForOriginChangeLogin();
        const version = recovery.client.sessionVersion();
        if (
          recovery.baseline !== "reset-partial-legacy" ||
          version.generation !== 0 ||
          version.userId !== null ||
          recovery.client.hasAuthCookie()
        ) {
          throw new Error("legacy pending challenge was preserved");
        }
        globalThis.fetch = async () => {
          throw new Error("discarded pending challenge reached the network");
        };
        try {
          await recovery.client.submitSignInCode(
            "stale@example.test",
            "123456",
          );
        } catch (error) {
          if (error?.code !== "NO_PENDING_LOGIN") throw error;
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
  });

  test("failed durable publication does not advance the in-memory generation", {
    timeout: 20_000,
  }, () => {
    const root = isolatedRoot();
    const child = runIsolated(
      root,
      `
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { SanaClient } = await import("./src/sana/client.ts");
        const client = new SanaClient();
        fs.mkdirSync(path.join(${JSON.stringify(root)}, "session.json"));
        let failed = false;
        try {
          client.savePublication(
            1,
            "11111111-1111-4111-8111-111111111111",
          );
        } catch {
          failed = true;
        }
        const version = client.sessionVersion();
        if (
          !failed ||
          version.generation !== 0 ||
          version.publicationToken !== null
        ) {
          throw new Error(
            "failed persistence was exposed as a published in-memory session",
          );
        }
      `,
    );
    expect(child.status, child.stderr).toBe(0);
  });
});
