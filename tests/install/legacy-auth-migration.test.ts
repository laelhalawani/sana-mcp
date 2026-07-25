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

function runMigration(
  session: unknown,
  responseSource: string,
  extraEnvironment: Record<string, string> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-legacy-auth-"));
  roots.push(root);
  const sessionFile = path.join(root, "session.json");
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  const original = fs.readFileSync(sessionFile);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        globalThis.fetch = ${responseSource};
        const {
          migrateLegacyAuthentication,
        } = await import("./src/install/legacy-auth-migration.ts");
        process.stdout.write(JSON.stringify(await migrateLegacyAuthentication()));
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
        ...extraEnvironment,
      },
    },
  );
  return { child, root, sessionFile, original };
}

test("legacy authentication is revalidated without trusting saved routing identity", () => {
  const run = runMigration(
    {
      cookies: { "sana-ai-session": "legacy-cookie" },
      workspaceId: "legacy-workspace-must-not-route",
      email: "old@example.test",
      pendingLogin: null,
    },
    `async (_input, init) => {
      if (String(init?.headers?.cookie) !== "sana-ai-session=legacy-cookie") {
        throw new Error("legacy cookie was not presented");
      }
      if ("sana-ai-workspace-id" in (init?.headers ?? {})) {
        throw new Error("legacy workspace routed the validation request");
      }
      return new Response(JSON.stringify({
        result: { data: {
          user: { id: "user-current", email: "current@example.test" },
          workspace: { id: "workspace-current" },
        } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }`,
  );
  expect(run.child.status, run.child.stderr).toBe(0);
  expect(JSON.parse(run.child.stdout)).toEqual({
    state: "preserved",
    persistentStateTouched: true,
  });
  const saved = JSON.parse(fs.readFileSync(run.sessionFile, "utf8"));
  expect(saved.userId).toBe("user-current");
  expect(saved.workspaceId).toBe("workspace-current");
  expect(saved.generation).toBe(1);
  expect(saved.authenticatedOrigin).toBe("https://sana.ai");
  expect(saved.cookies["sana-ai-session"]).toBe("legacy-cookie");
});

test("cookies-only legacy authentication is also a migration candidate", () => {
  const run = runMigration(
    {
      cookies: { "sana-ai-session": "legacy-cookie" },
      email: "old@example.test",
      pendingLogin: null,
    },
    `async () => new Response(JSON.stringify({
      result: { data: {
        user: { id: "user-current", email: "current@example.test" },
        workspace: { id: "workspace-current" },
      } },
    }), { status: 200, headers: { "content-type": "application/json" } })`,
  );
  expect(run.child.status, run.child.stderr).toBe(0);
  expect(JSON.parse(run.child.stdout).state).toBe("preserved");
});

test("unavailable validation leaves the legacy session byte-for-byte unchanged", () => {
  const run = runMigration(
    {
      cookies: { "sana-ai-session": "legacy-cookie" },
      workspaceId: "legacy-workspace",
      pendingLogin: null,
    },
    `async () => { throw new Error("network unavailable"); }`,
  );
  expect(run.child.status, run.child.stderr).toBe(0);
  expect(JSON.parse(run.child.stdout)).toEqual({
    state: "validation-unavailable",
    persistentStateTouched: false,
  });
  expect(fs.readFileSync(run.sessionFile)).toEqual(run.original);
  expect(fs.existsSync(path.join(run.root, "meetings.db"))).toBe(false);
});

test("expired or origin-unbound legacy authentication becomes a usable signed-out publication", () => {
  for (const scenario of [
    {
      response: `async () => new Response("expired", { status: 401 })`,
      environment: {},
    },
    {
      response: `async () => { throw new Error("custom origin reached network"); }`,
      environment: { SANA_BASE_URL: "https://example.test" },
    },
  ]) {
    const run = runMigration(
      {
        cookies: { "sana-ai-session": "legacy-cookie" },
        workspaceId: "legacy-workspace",
        pendingLogin: null,
      },
      scenario.response,
      scenario.environment,
    );
    expect(run.child.status, run.child.stderr).toBe(0);
    expect(JSON.parse(run.child.stdout)).toEqual({
      state: "fresh-login-required",
      persistentStateTouched: true,
    });
    const saved = JSON.parse(fs.readFileSync(run.sessionFile, "utf8"));
    expect(saved.cookies).toEqual({});
    expect(saved.generation).toBe(1);
    expect(saved.publicationToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});

test("current published authentication migration is idempotent", () => {
  const session = {
    cookies: {},
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
    pendingLogin: null,
  };
  const run = runMigration(
    session,
    `async () => { throw new Error("current session reached network"); }`,
  );
  expect(run.child.status, run.child.stderr).toBe(0);
  expect(JSON.parse(run.child.stdout)).toEqual({
    state: "not-needed",
    persistentStateTouched: false,
  });
  expect(fs.readFileSync(run.sessionFile)).toEqual(run.original);
});

test("malformed pre-1.0 session is preserved for recovery and reset to usable signed-out state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-legacy-auth-corrupt-"));
  roots.push(root);
  const sessionFile = path.join(root, "session.json");
  fs.writeFileSync(sessionFile, '{"cookies":');
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        globalThis.fetch = async () => {
          throw new Error("malformed session reached the network");
        };
        const {
          migrateLegacyAuthentication,
        } = await import("./src/install/legacy-auth-migration.ts");
        process.stdout.write(JSON.stringify(await migrateLegacyAuthentication()));
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
  expect(JSON.parse(child.stdout)).toEqual({
    state: "fresh-login-required",
    persistentStateTouched: true,
  });
  const saved = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  expect(saved.cookies).toEqual({});
  expect(saved.generation).toBe(1);
  const recovery = fs
    .readdirSync(root)
    .filter((entry) => entry === "session.json.corrupt");
  expect(recovery).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, recovery[0]!), "utf8")).toBe(
    '{"cookies":',
  );
});

test("unreadable local session returns a no-mutation state for installer rollback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-legacy-auth-path-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "session.json"));
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        globalThis.fetch = async () => {
          throw new Error("unreadable session reached the network");
        };
        const {
          migrateLegacyAuthentication,
        } = await import("./src/install/legacy-auth-migration.ts");
        process.stdout.write(JSON.stringify(await migrateLegacyAuthentication()));
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
  expect(JSON.parse(child.stdout)).toEqual({
    state: "local-session-unavailable",
    persistentStateTouched: false,
  });
  expect(fs.statSync(path.join(root, "session.json")).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(root, "sana.db"))).toBe(false);
});
