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

test("null or absent workspace uses only the validated response lastUsedWorkspaceId", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-client-"));
  roots.push(root);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const fs = await import("node:fs");
        const { SanaClient } = await import("./src/sana/client.ts");
        const fixture = JSON.parse(
          fs.readFileSync(
            "./tests/fixtures/sana/user-me-workspace-null.json",
            "utf8",
          ),
        );
        if (
          fixture.provenance?.classification !==
            "observed-shape regression fixture" ||
          !fixture.provenance?.limitations?.includes(
            "No raw user.me response was captured",
          )
        ) {
          throw new Error("workspace-null fixture overstated its provenance");
        }
        const observedShape = fixture.response;
        const responses = [
          observedShape,
          {
            result: {
              data: {
                user: {
                  id: "absent-user",
                  email: "absent@example.test",
                  lastUsedWorkspaceId: "absent-workspace",
                },
              },
            },
          },
        ];
        for (const expected of [
          {
            userId: "synthetic-user",
            workspaceId: "synthetic-workspace",
            email: "synthetic@example.test",
          },
          {
            userId: "absent-user",
            workspaceId: "absent-workspace",
            email: "absent@example.test",
          },
        ]) {
          globalThis.fetch = async () =>
            new Response(JSON.stringify(responses.shift()), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          const client = new SanaClient();
          await client.me();
          if (
            client.userId !== expected.userId ||
            client.workspaceId !== expected.workspaceId ||
            client.email !== expected.email
          ) {
            throw new Error("validated response workspace was not adopted");
          }
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
  expect(child.status, child.stderr).toBe(0);
});

test("active response workspace wins over a differing last-used workspace", () => {
  const child = runClientScenario(`
    const { SanaClient } = await import("./src/sana/client.ts");
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        result: {
          data: {
            user: {
              id: "user-authoritative",
              email: "person@example.test",
              lastUsedWorkspaceId: "last-used-workspace",
            },
            workspace: { id: "active-workspace" },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = new SanaClient({
      cookies: {},
      userId: "saved-user",
      workspaceId: "saved-workspace-must-not-win",
    });
    await client.me();
    if (
      client.userId !== "user-authoritative" ||
      client.workspaceId !== "active-workspace" ||
      client.email !== "person@example.test"
    ) {
      throw new Error("active response workspace did not win");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("explicit malformed workspace never falls back to the saved workspace", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaInputValidationError,
    } = await import("./src/sana/client.ts");
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("invalid workspace reached the network");
    };
    const malformed = [
      undefined,
      "",
      "   ",
      " padded-workspace ",
      null,
      7,
      {},
      false,
    ];
    for (const workspace of malformed) {
      const client = new SanaClient({
        cookies: {},
        workspaceId: "saved-workspace-must-not-be-used",
      });
      let caught;
      try {
        await client.requestSignInCode(
          "person@example.test",
          workspace,
        );
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SanaInputValidationError)) {
        throw caught ?? new Error("malformed workspace was accepted");
      }
    }
    if (requests !== 0) {
      throw new Error("malformed workspace contacted Sana");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("absent workspace uses saved routing and valid explicit workspace wins", () => {
  const child = runClientScenario(`
    const { SanaClient } = await import("./src/sana/client.ts");
    const bodies = [];
    let request = 0;
    globalThis.fetch = async (_input, init) => {
      request++;
      if (request % 2 === 1) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ result: { data: { accepted: true } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const client = new SanaClient({
      cookies: {},
      workspaceId: "saved-workspace",
    });
    await client.requestSignInCode("person@example.test");
    await client.requestSignInCode(
      "person@example.test",
      "explicit-workspace",
    );
    if (
      bodies[0]?.loginViaWorkspaceId !== "saved-workspace" ||
      bodies[1]?.loginViaWorkspaceId !== "explicit-workspace"
    ) {
      throw new Error("workspace request routing was not exact");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("participant responses require every field used by the fixed table", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const client = new SanaClient();
    const responses = [
      [{ displayName: "Alex", email: "alex@example.test", isHost: false }],
      [{ id: "participant-a" }],
      [{ displayName: "Alex", email: "alex@example.test" }],
      [{ displayName: "   ", email: "alex@example.test", isHost: true }],
      [{
        id: " padded-participant ",
        displayName: "Alex",
        email: "alex@example.test",
        isHost: false,
      }],
    ];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        result: { data: responses.shift() },
      }), { status: 200 });

    const healthy = await client.getMeetingParticipants("meeting-a");
    if (
      healthy.length !== 1 ||
      healthy[0].displayName !== "Alex" ||
      healthy[0].email !== "alex@example.test" ||
      healthy[0].isHost !== false
    ) {
      throw new Error("valid participant response changed");
    }
    for (let index = 0; index < 4; index++) {
      let caught;
      try {
        await client.getMeetingParticipants("meeting-a");
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SanaResponseValidationError)) {
        throw caught ?? new Error("partial participant was accepted");
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("remote identity schemas reject blank IDs without partial adoption", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const malformed = [
      {
        user: { id: "   ", email: "new@example.test" },
        workspace: { id: "new-workspace" },
      },
      {
        user: { id: "new-user", email: "new@example.test" },
        workspace: { id: "\\t" },
      },
      {
        user: {
          id: "new-user",
          email: "new@example.test",
          lastUsedWorkspaceId: " padded-workspace ",
        },
        workspace: { id: "new-workspace" },
      },
    ];
    for (const data of malformed) {
      const client = new SanaClient({
        cookies: {},
        userId: "prior-user",
        workspaceId: "prior-workspace",
        email: "prior@example.test",
        generation: 4,
        publicationToken: "11111111-1111-4111-8111-111111111111",
      });
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ result: { data } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      let caught;
      try {
        await client.me();
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SanaResponseValidationError)) {
        throw caught ?? new Error("malformed remote identity was accepted");
      }
      const version = client.sessionVersion();
      if (
        client.userId !== "prior-user" ||
        client.workspaceId !== "prior-workspace" ||
        client.email !== "prior@example.test" ||
        version.generation !== 4 ||
        version.publicationToken !==
          "11111111-1111-4111-8111-111111111111" ||
        version.userId !== "prior-user" ||
        version.workspaceId !== "prior-workspace"
      ) {
        throw new Error("invalid remote identity partially changed client state");
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("me restores cookies and complete client state after identity validation failures", () => {
  const child = runClientScenario(`
    const {
      AuthoritativeWorkspaceUnavailableError,
      SanaClient,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const failures = [
      {
        data: {
          user: { id: "   ", email: "new@example.test" },
          workspace: { id: "new-workspace" },
        },
        type: SanaResponseValidationError,
      },
      {
        data: {
          user: { id: "new-user", email: "new@example.test" },
          workspace: null,
        },
        type: AuthoritativeWorkspaceUnavailableError,
      },
      {
        data: {
          user: { id: "new-user", email: "new@example.test" },
        },
        type: AuthoritativeWorkspaceUnavailableError,
      },
    ];
    for (const failure of failures) {
      const client = new SanaClient({
        cookies: { "sana-ai-session": "prior-cookie" },
        userId: "prior-user",
        workspaceId: "prior-workspace",
        email: "prior@example.test",
        pendingLogin: {
          email: "pending@example.test",
          csrfToken: "prior-csrf",
        },
        generation: 4,
        publicationToken: "11111111-1111-4111-8111-111111111111",
        authenticatedOrigin: "https://sana.ai",
      });
      const state = () => ({
        cookies: client["jar"].toJSON(),
        userId: client.userId,
        workspaceId: client.workspaceId,
        email: client.email,
        pendingLogin: client["pendingLogin"],
        generation: client["generation"],
        publicationToken: client["publicationToken"],
        authenticatedOrigin: client["authenticatedOrigin"],
        version: client.sessionVersion(),
      });
      const before = state();
      globalThis.fetch = async () =>
        new Response(JSON.stringify({
          result: { data: failure.data },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "sana-ai-session=replacement-cookie; Path=/; HttpOnly",
          },
        });
      let caught;
      try {
        await client.me();
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof failure.type)) {
        throw caught ?? new Error("malformed identity response was accepted");
      }
      if (JSON.stringify(state()) !== JSON.stringify(before)) {
        throw new Error("failed me transaction changed client state");
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("meeting timestamps and IDs are validated before cache callbacks and remain renderable", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const { fmtDateTime } = await import("./src/core/args.ts");
    const base = {
      id: "meeting-a",
      externalId: "external-a",
      name: "Meeting",
      createdAtEpochMs: 0,
      modifiedAtEpochMs: 0,
      source: "sana-ai:meeting",
      processingPhase: "done",
    };
    const invalidAssets = [
      { ...base, createdAtEpochMs: 1e100 },
      { ...base, modifiedAtEpochMs: 1e100 },
      { ...base, createdAtEpochMs: 1.5 },
      { ...base, id: "   " },
      { ...base, externalId: " padded-external " },
    ];
    for (const asset of invalidAssets) {
      const client = new SanaClient();
      let cacheCallbackCalled = false;
      globalThis.fetch = async () =>
        new Response(JSON.stringify({
          result: { data: { assets: [asset], nextCursor: null } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      let caught;
      try {
        await client.walkMeetings(() => {
          cacheCallbackCalled = true;
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SanaResponseValidationError)) {
        throw caught ?? new Error("malformed meeting metadata was accepted");
      }
      if (cacheCallbackCalled) {
        throw new Error("malformed meeting metadata reached the cache callback");
      }
    }

    const maxDateEpochMs = 8_640_000_000_000_000;
    const client = new SanaClient();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        result: {
          data: {
            assets: [{
              ...base,
              createdAtEpochMs: maxDateEpochMs,
              modifiedAtEpochMs: maxDateEpochMs,
            }],
            nextCursor: null,
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const page = await client.listMeetingsPage();
    for (const asset of page.assets) {
      fmtDateTime(asset.createdAtEpochMs);
      if (asset.modifiedAtEpochMs !== null &&
          asset.modifiedAtEpochMs !== undefined) {
        fmtDateTime(asset.modifiedAtEpochMs);
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

function runClientScenario(
  source: string,
  environment: Record<string, string> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-client-"));
  roots.push(root);
  return spawnSync(process.execPath, ["-e", source], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SANA_DATA_DIR: root,
      SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
      SANA_SEMANTIC: "0",
      ...environment,
    },
  });
}

test("exact loopback HTTP origin is allowed without weakening redirect origin binding", () => {
  const child = runClientScenario(
    `
      const {
        AuthenticationRedirectOriginError,
        SanaClient,
      } = await import("./src/sana/client.ts");
      const client = new SanaClient();
      let calls = 0;
      globalThis.fetch = async (input) => {
        calls++;
        if (calls === 1) {
          if (!String(input).startsWith("http://127.0.0.1:43123/")) {
            throw new Error("loopback request used the wrong origin");
          }
          return new Response(JSON.stringify({ csrfToken: "token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { location: "http://localhost:43123/capture" },
        });
      };
      let caught;
      try {
        await client.requestSignInCode("person@example.test");
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof AuthenticationRedirectOriginError)) {
        throw caught ?? new Error("cross-origin loopback redirect was accepted");
      }
      if (calls !== 2) {
        throw new Error("rejected loopback redirect reached its target");
      }
    `,
    { SANA_BASE_URL: "http://127.0.0.1:43123" },
  );
  expect(child.status, child.stderr).toBe(0);
});

test("invalid code cannot borrow an old valid auth cookie", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SignInChallengeRejectedError,
    } = await import("./src/sana/client.ts");
    const client = new SanaClient({
      cookies: { "sana-ai-session": "old-valid-cookie" },
      userId: "old-user",
      workspaceId: "old-workspace",
      email: "old@example.test",
      generation: 1,
      publicationToken: "11111111-1111-4111-8111-111111111111",
      authenticatedOrigin: "https://sana.ai",
      pendingLogin: {
        email: "new@example.test",
        csrfToken: "challenge-token",
      },
    });
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      if (String(init?.headers?.cookie ?? "").includes("old-valid-cookie")) {
        throw new Error("old auth cookie was sent to the code exchange");
      }
      return new Response("invalid code", { status: 200 });
    };
    let caught;
    try {
      await client.submitSignInCode("new@example.test", "123456");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SignInChallengeRejectedError)) throw caught;
    if (calls !== 1 || !client.hasAuthCookie()) {
      throw new Error("invalid challenge used or destroyed the durable old session");
    }
    globalThis.fetch = async () => {
      throw new Error("pending challenge was retained");
    };
    try {
      await client.submitSignInCode("new@example.test", "123456");
    } catch (error) {
      if (error?.message !== "pending challenge was retained") throw error;
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("fresh auth cookie and matching validated identity prove code acceptance", () => {
  const child = runClientScenario(`
    const { SanaClient } = await import("./src/sana/client.ts");
    const client = new SanaClient({
      cookies: { "sana-ai-session": "old-valid-cookie" },
      userId: "old-user",
      workspaceId: "old-workspace",
      generation: 1,
      publicationToken: "11111111-1111-4111-8111-111111111111",
      authenticatedOrigin: "https://sana.ai",
      pendingLogin: {
        email: "new@example.test",
        csrfToken: "challenge-token",
      },
    });
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) {
        return new Response("ok", {
          status: 200,
          headers: {
            "set-cookie": "sana-ai-session=fresh-cookie; Path=/; HttpOnly",
          },
        });
      }
      return new Response(JSON.stringify({
        result: {
          data: {
            user: { id: "new-user", email: "NEW@example.test" },
            workspace: { id: "new-workspace" },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const user = await client.submitSignInCode(
      "new@example.test",
      "123456",
    );
    const version = client.sessionVersion();
    if (
      user.id !== "new-user" ||
      client.userId !== "new-user" ||
      client.workspaceId !== "new-workspace" ||
      version.userId !== "new-user" ||
      version.workspaceId !== "new-workspace"
    ) {
      throw new Error("fresh sign-in identity was not adopted");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("authentication redirects never forward cookies across origins", () => {
  const child = runClientScenario(`
    const {
      AuthenticationRedirectOriginError,
      SanaClient,
    } = await import("./src/sana/client.ts");
    const client = new SanaClient({
      pendingLogin: {
        email: "person@example.test",
        csrfToken: "challenge-token",
      },
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://attacker.example/collect",
          "set-cookie": "sana-ai-session=fresh-cookie; Path=/; HttpOnly",
        },
      });
    };
    let caught;
    try {
      await client.submitSignInCode("person@example.test", "123456");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof AuthenticationRedirectOriginError)) throw caught;
    if (calls !== 1) {
      throw new Error("cross-origin redirect reached the network");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("failed fresh-session identity validation restores the complete client state", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SignInChallengeRejectedError,
    } = await import("./src/sana/client.ts");
    const originalToken = "11111111-1111-4111-8111-111111111111";
    const client = new SanaClient({
      cookies: { "sana-ai-session": "old-valid-cookie" },
      userId: "old-user",
      workspaceId: "old-workspace",
      email: "old@example.test",
      generation: 7,
      publicationToken: originalToken,
      authenticatedOrigin: "https://sana.ai",
      pendingLogin: {
        email: "new@example.test",
        csrfToken: "challenge-token",
      },
    });
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) {
        return new Response("ok", {
          status: 200,
          headers: {
            "set-cookie": "sana-ai-session=fresh-cookie; Path=/; HttpOnly",
          },
        });
      }
      return new Response(JSON.stringify({
        result: {
          data: {
            user: { id: "other-user", email: "other@example.test" },
            workspace: { id: "other-workspace" },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    let caught;
    try {
      await client.submitSignInCode("new@example.test", "123456");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SignInChallengeRejectedError)) throw caught;
    const version = client.sessionVersion();
    if (
      !client.hasAuthCookie() ||
      client.userId !== "old-user" ||
      client.workspaceId !== "old-workspace" ||
      client.email !== "old@example.test" ||
      version.generation !== 7 ||
      version.publicationToken !== originalToken ||
      version.userId !== "old-user" ||
      version.workspaceId !== "old-workspace"
    ) {
      throw new Error("failed identity validation left partial client state");
    }
    globalThis.fetch = async () => {
      throw new Error("restored pending challenge reached fetch");
    };
    try {
      await client.submitSignInCode("new@example.test", "123456");
    } catch (error) {
      if (error?.message !== "restored pending challenge reached fetch") {
        throw error;
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("HTTP, envelope, operation schema, and timeout failures are typed", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaHttpError,
      SanaRequestTimeoutError,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const client = new SanaClient();

    const scenarios = [
      {
        response: () => new Response("backend failed", { status: 500 }),
        type: SanaHttpError,
        call: () => client.listMeetingsPage(),
      },
      {
        response: () => new Response(JSON.stringify({
          error: { message: "not a success envelope" },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.listMeetingsPage(),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: { nextCursor: null } },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.listMeetingsPage(),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: { assets: [], nextCursor: "invented-cursor" } },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.listMeetingsPage(),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: {} },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getTranscription("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: {
            data: [{
              speaker: "Alex",
              words: [{ text: "hello", end_timestamp: 1 }],
            }],
          },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getTranscription("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: null },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getMeetingById("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: {
            data: { notes: [{ notes: ["missing topic"] }] },
          },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getMeetingById("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: null },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getMeetingParticipants("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: [{ displayName: 3 }] },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getMeetingParticipants("meeting-a"),
      },
      {
        response: () => new Response(JSON.stringify({
          result: { data: [{}] },
        }), { status: 200 }),
        type: SanaResponseValidationError,
        call: () => client.getMeetingParticipants("meeting-a"),
      },
      {
        response: async (_input, init) => {
          if (!(init?.signal instanceof AbortSignal)) {
            throw new Error("Sana request was not given a timeout signal");
          }
          throw new DOMException("timed out", "TimeoutError");
        },
        type: SanaRequestTimeoutError,
        call: () => client.getMeetingParticipants("meeting-a"),
      },
    ];
    for (const scenario of scenarios) {
      globalThis.fetch = scenario.response;
      let caught;
      try {
        await scenario.call();
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof scenario.type)) {
        throw caught ?? new Error("invalid Sana response was accepted");
      }
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("authentication redirects must reach a successful terminal response", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaRedirectError,
    } = await import("./src/sana/client.ts");
    const client = new SanaClient({
      cookies: {},
      pendingLogin: {
        email: "person@example.test",
        csrfToken: "challenge-token",
      },
    });
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "/still-redirecting" },
      });
    let caught;
    try {
      await client.submitSignInCode("person@example.test", "123456");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SanaRedirectError)) throw caught;
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("redirect status semantics preserve or rewrite request state deliberately", () => {
  const child = runClientScenario(`
    const { SanaClient, SanaHttpError } = await import(
      "./src/sana/client.ts"
    );
    for (const status of [301, 302, 303, 307, 308]) {
      const client = new SanaClient();
      let call = 0;
      let originalBody;
      globalThis.fetch = async (_input, init) => {
        call++;
        if (call === 1) {
          return new Response(
            JSON.stringify({ csrfToken: "csrf-" + status }),
            { status: 200 },
          );
        }
        const headers = init?.headers ?? {};
        if (call === 2) {
          if (init?.method !== "POST") {
            throw new Error(status + " initial mutation was not POST");
          }
          originalBody = init.body;
          return new Response(null, {
            status,
            headers: {
              location: "/redirect-target",
              "set-cookie": "redirect-cookie=value-" + status + "; Path=/",
            },
          });
        }
        const preserves = status === 307 || status === 308;
        if (init?.method !== (preserves ? "POST" : "GET")) {
          throw new Error(status + " used the wrong redirect method");
        }
        if (preserves) {
          if (
            init.body !== originalBody ||
            headers["content-type"] !== "application/json" ||
            headers.accept !== "application/json"
          ) {
            throw new Error(status + " did not preserve request state");
          }
        } else if (
          init.body != null ||
          Object.keys(headers).some(
            (name) => name.toLowerCase() === "content-type",
          ) ||
          headers.accept !== "application/json"
        ) {
          throw new Error(status + " did not perform the defined GET rewrite");
        }
        if (
          !String(headers.cookie ?? "").includes(
            "redirect-cookie=value-" + status,
          )
        ) {
          throw new Error(status + " did not replace cookies from the jar");
        }
        return new Response(
          JSON.stringify({ result: { data: null } }),
          { status: 200 },
        );
      };
      await client.requestSignInCode("person@example.test");
      if (call !== 3) throw new Error(status + " was not followed once");
    }

    for (const status of [300, 304]) {
      const client = new SanaClient();
      let call = 0;
      globalThis.fetch = async () => {
        call++;
        return call === 1
          ? new Response(JSON.stringify({ csrfToken: "csrf" }), {
              status: 200,
            })
          : new Response(null, {
              status,
              headers: { location: "/must-not-follow" },
            });
      };
      let caught;
      try {
        await client.requestSignInCode("person@example.test");
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof SanaHttpError) || caught.status !== status) {
        throw caught ?? new Error(status + " was accepted");
      }
      if (call !== 2) throw new Error(status + " was followed");
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("code request requires validated CSRF and tRPC acceptance responses", () => {
  const child = runClientScenario(`
    const {
      SanaClient,
      SanaResponseValidationError,
    } = await import("./src/sana/client.ts");
    const invalidCsrf = new SanaClient();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });
    let caught;
    try {
      await invalidCsrf.requestSignInCode("person@example.test");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SanaResponseValidationError)) throw caught;

    const invalidAcceptance = new SanaClient();
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      return call === 1
        ? new Response(JSON.stringify({ csrfToken: "csrf-authoritative" }), {
            status: 200,
          })
        : new Response(JSON.stringify({}), { status: 200 });
    };
    caught = undefined;
    try {
      await invalidAcceptance.requestSignInCode("person@example.test");
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof SanaResponseValidationError)) throw caught;
    try {
      await invalidAcceptance.submitSignInCode(
        "person@example.test",
        "123456",
      );
      throw new Error("missing request acceptance created a pending challenge");
    } catch (error) {
      if (
        error?.message ===
        "missing request acceptance created a pending challenge"
      ) {
        throw error;
      }
      if (!error?.message.includes("No pending login")) throw error;
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});

test("request-code cookies are origin-bound only after Sana accepts the request", () => {
  const child = runClientScenario(`
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SanaClient } = await import("./src/sana/client.ts");
    const client = new SanaClient();
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ csrfToken: "csrf-authoritative" }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie":
                "sana-ai-session=request-session; Path=/; HttpOnly",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({ result: { data: { accepted: true } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    await client.requestSignInCode("person@example.test");
    const pending = client.pendingSignInChallenge();
    if (
      pending?.email !== "person@example.test" ||
      Object.keys(pending).join(",") !== "email" ||
      !Object.isFrozen(pending)
    ) {
      throw new Error("pending challenge API exposed mutable or secret state");
    }
    client.savePublication(
      1,
      "11111111-1111-4111-8111-111111111111",
    );
    const reloaded = SanaClient.load().pendingSignInChallenge();
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(process.env.SANA_DATA_DIR, "session.json"),
        "utf8",
      ),
    );
    if (
      call !== 2 ||
      saved.authenticatedOrigin !== "https://sana.ai" ||
      saved.cookies["sana-ai-session"] !== "request-session" ||
      saved.pendingLogin?.email !== "person@example.test" ||
      saved.pendingLogin?.csrfToken !== "csrf-authoritative" ||
      reloaded?.email !== "person@example.test" ||
      saved.userId !== undefined ||
      saved.workspaceId !== undefined
    ) {
      throw new Error(
        "accepted request-code session was not durably origin-bound and pending",
      );
    }
  `);
  expect(child.status, child.stderr).toBe(0);
});
