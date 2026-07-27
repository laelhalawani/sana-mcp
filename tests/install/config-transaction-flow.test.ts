import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClientAuthenticationPartialError,
  ClientAuthenticationSessionCleanupError,
  ClientConfigurationCancelledError,
  runInstall,
  runInstallerConfigTransaction,
  type ConfigurerAuthSession,
  type InstallInteraction,
} from "../../src/install/install.js";
import { serializeConfigTransactionResult } from "../../src/install/config-transaction.js";
import type { ClientDef } from "../../src/install/clients.js";

const target = { command: process.execPath, args: ["mcp"] };

function fixture(
  id: string,
  file: string,
  state: "present" | "absent" = "present",
): ClientDef {
  return {
    id,
    name: `Fixture ${id}`,
    detect: () =>
      state === "present" ? { state, evidence: [file] } : { state },
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "available", path: file }),
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
}

function terminal() {
  return {
    input: { isTTY: true },
    output: { isTTY: true, write: () => undefined },
    env: { NO_COLOR: "", LANG: "C.UTF-8" },
    platform: process.platform,
  } as const;
}

function authSession(
  verify: (() => Promise<any>) | { alreadyReady: true },
  request: () => Promise<void> = async () => undefined,
): ConfigurerAuthSession {
  return {
    inspect: () =>
      "alreadyReady" in verify
        ? {
            kind: "ready",
            generation: 1,
            session: { hasCookie: true, loggedIn: true, expired: false },
          }
        : {
            kind: "signed-out",
            generation: 0,
            session: { hasCookie: false, loggedIn: false, expired: false },
          },
    requestCode: request,
    verifyCode: async () =>
      "alreadyReady" in verify
        ? assert.fail("verify must not run for an existing session")
        : await verify(),
    close: () => undefined,
  };
}

function interaction(
  clients: readonly ClientDef[],
  output: string[],
  desired: Record<string, boolean>,
  auth: ConfigurerAuthSession,
): InstallInteraction {
  const answers = ["person@example.test", "123456"];
  return {
    clients,
    terminal: terminal(),
    writeLine: (line) => output.push(line),
    prompt: async () => ({ submitted: true, desired }),
    confirm: async () => true,
    input: async () => answers.shift() ?? "",
    openAuthSession: () => auth,
  };
}

test("interactive batch adds an explicitly selected undetected client and removes an owned one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const addFile = path.join(root, "add.json");
  const removeFile = path.join(root, "remove.json");
  const add = fixture("add", addFile, "absent");
  const remove = fixture("remove", removeFile);
  fs.writeFileSync(
    removeFile,
    `${JSON.stringify({ mcpServers: { "sana-mcp": target } })}\n`,
  );
  const output: string[] = [];
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      interaction(
        [add, remove],
        output,
        { add: true, remove: false },
        authSession(async () => ({
          kind: "ready",
          user: { email: "person@example.test" },
          workspaceId: "workspace-1",
          confirmation: {
            generation: 1,
            publicationToken: "token",
            userId: "user-1",
            workspaceId: "workspace-1",
          },
        })),
      ),
    );
    assert.equal(result.outcome, "applied");
    assert.equal(result.disposition, "configured");
    assert.equal(result.authentication, "ready");
    assert.equal(result.appliedCount, 2);
    assert.equal(
      JSON.parse(fs.readFileSync(addFile, "utf8")).mcpServers["sana-mcp"]
        .command,
      process.execPath,
    );
    assert.equal(
      "sana-mcp" in JSON.parse(fs.readFileSync(removeFile, "utf8")).mcpServers,
      false,
    );
    const wire = serializeConfigTransactionResult(result);
    assert.equal(wire.split("\n").length, 2);
    assert.equal("clientResults" in JSON.parse(wire), false);
    assert.match(output.join("\n"), /Sana account  signed in/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("cancel, no clients, and exact no-change are successful explicit no-mutation dispositions", async () => {
  for (const scenario of ["cancelled", "no-clients", "no-changes"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    let unchanged:
      | Readonly<{ contents: string; mtimeNs: bigint }>
      | undefined;
    if (scenario === "no-changes") {
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
      const unchangedTime = new Date("2001-02-03T04:05:06.000Z");
      fs.utimesSync(file, unchangedTime, unchangedTime);
      unchanged = {
        contents: fs.readFileSync(file, "utf8"),
        mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
      };
    }
    const client = fixture("client", file);
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: scenario === "no-clients" ? [] : [client],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async ({ rows }) => {
            if (scenario === "cancelled")
              return { submitted: false, desired: {} };
            assert.deepEqual(
              rows.map(({ id, detected, current }) => ({
                id,
                detected,
                current,
              })),
              [{ id: "client", detected: true, current: true }]
            );
            return {
              submitted: true,
              desired: Object.fromEntries(
                rows.map(({ id, current }) => [id, current])
              ),
            };
          },
          openAuthSession: () => authSession({ alreadyReady: true }),
        },
      );
      assert.equal(result.outcome, "no-mutation");
      assert.equal(result.disposition, scenario);
      assert.equal(result.exitCode, 0);
      assert.equal(fs.existsSync(path.join(root, "journal")), false);
      if (unchanged !== undefined) {
        assert.equal(fs.readFileSync(file, "utf8"), unchanged.contents);
        assert.equal(
          fs.statSync(file, { bigint: true }).mtimeNs,
          unchanged.mtimeNs
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("interactive submission is replanned as a complete desired set", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const client = fixture("client", file);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
  );
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      {
        clients: [client],
        terminal: terminal(),
        writeLine: () => undefined,
        prompt: async () => {
          fs.unlinkSync(file);
          return { submitted: true, desired: { client: true } };
        },
        openAuthSession: () => authSession({ alreadyReady: true }),
      },
    );
    assert.equal(result.outcome, "applied");
    assert.equal(result.appliedCount, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["sana-mcp"].command,
      process.execPath,
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("preflight failure occurs before the wizard and is configuration-unavailable", async () => {
  let prompted = false;
  const result = await runInstallerConfigTransaction(
    {
      journalDirectory: "relative-journal",
      serverCommand: process.execPath,
    },
    {
      clients: [],
      terminal: terminal(),
      writeLine: () => undefined,
      prompt: async () => {
        prompted = true;
        return { submitted: false, desired: {} };
      },
    },
  );
  assert.equal(prompted, false);
  assert.equal(result.outcome, "configuration-unavailable");
  assert.equal(result.authentication, "not-attempted");
  assert.equal(result.journal, undefined);
});

test(
  "preflight rejects a dangling receipt entry before the wizard",
  { skip: process.platform === "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const journalDirectory = path.join(root, "journal");
    fs.mkdirSync(journalDirectory, { mode: 0o700 });
    fs.symlinkSync(
      path.join(root, "missing-receipt"),
      path.join(journalDirectory, "client-config-transaction.json"),
    );
    let prompted = false;
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory,
          serverCommand: process.execPath,
        },
        {
          clients: [],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => {
            prompted = true;
            return { submitted: false, desired: {} };
          },
        },
      );
      assert.equal(prompted, false);
      assert.equal(result.outcome, "configuration-unavailable");
      assert.equal(result.authentication, "not-attempted");
      assert.match(result.message!, /path entry already exists/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  },
);

test("--yes proves authoritative absence when no detector is positive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
        yes: true,
      },
      {
        clients: [fixture("absent", path.join(root, "absent.json"), "absent")],
        terminal: terminal(),
        writeLine: () => undefined,
      },
    );
    assert.equal(result.outcome, "no-mutation");
    assert.equal(result.disposition, "no-clients");
    assert.equal(fs.existsSync(path.join(root, "journal")), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("--yes fails closed on foreign state when no detector is positive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "foreign.json");
  fs.writeFileSync(
    file,
    '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n',
  );
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
        yes: true,
      },
      {
        clients: [fixture("foreign", file, "absent")],
        terminal: terminal(),
        writeLine: () => undefined,
      },
    );
    assert.equal(result.outcome, "configuration-unavailable");
    assert.equal(result.authentication, "not-attempted");
    assert.equal(fs.existsSync(path.join(root, "journal")), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("--yes ignores unrelated unavailable status when a positive target applies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "detected.json");
  const unavailable: ClientDef = {
    ...fixture("unavailable", path.join(root, "unused.json"), "absent"),
    detect: () => ({ state: "unavailable", reason: "probe unavailable" }),
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "unavailable", reason: "path unavailable" }),
      topKey: "mcpServers",
    },
  };
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
        yes: true,
      },
      {
        clients: [fixture("detected", file), unavailable],
        terminal: terminal(),
        writeLine: () => undefined,
      },
    );
    assert.equal(result.outcome, "applied");
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("post-apply observer failure is not misreported as authentication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      {
        clients: [fixture("client", file)],
        terminal: terminal(),
        writeLine: () => undefined,
        onPhase: (phase) => {
          if (phase === "post-apply") throw new Error("post-apply observer failed");
        },
        prompt: async () => ({
          submitted: true,
          desired: { client: true },
        }),
        openAuthSession: () => {
          throw new Error("authentication must not start");
        },
      },
    );
    assert.equal(result.outcome, "failed-rolled-back");
    assert.equal(result.disposition, "interaction-unavailable");
    assert.equal(result.authentication, "not-attempted");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("confirmed authentication survives post-auth presentation failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const answers = ["person@example.test", "123456"];
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      {
        clients: [fixture("client", file)],
        terminal: terminal(),
        writeLine: (line) => {
          if (line.includes("Sana account  signed in"))
            throw new Error("render failed");
        },
        prompt: async () => ({
          submitted: true,
          desired: { client: true },
        }),
        confirm: async () => true,
        input: async () => answers.shift()!,
        openAuthSession: () =>
          authSession(async () => ({
            kind: "ready",
            user: { email: "person@example.test" },
            workspaceId: "workspace-1",
            confirmation: {
              generation: 1,
              publicationToken: "token",
              userId: "user-1",
              workspaceId: "workspace-1",
            },
          })),
      },
    );
    assert.equal(result.outcome, "interaction-unavailable");
    assert.equal(result.authentication, "retained");
    assert.equal(result.disposition, "interaction-unavailable");
    assert.equal(fs.existsSync(file), true);
    assert.ok(result.journal);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("confirmed authentication cleanup failure is typed without config rollback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const answers = ["person@example.test", "123456"];
  const auth = authSession(async () => ({
    kind: "ready",
    user: { email: "person@example.test" },
    workspaceId: "workspace-1",
    confirmation: {
      generation: 1,
      publicationToken: "token",
      userId: "user-1",
      workspaceId: "workspace-1",
    },
  }));
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      {
        clients: [fixture("client", file)],
        terminal: terminal(),
        writeLine: () => undefined,
        prompt: async () => ({
          submitted: true,
          desired: { client: true },
        }),
        confirm: async () => true,
        input: async () => answers.shift()!,
        openAuthSession: () => ({
          ...auth,
          close: () => {
            throw new Error("confirmed close failed");
          },
        }),
      },
    );
    assert.equal(result.outcome, "authentication-incomplete");
    assert.equal(result.authentication, "retained");
    assert.equal(result.disposition, "authentication-incomplete");
    assert.equal(
      result.errorCode,
      "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
    );
    assert.match(result.message!, /confirmed close failed/u);
    assert.doesNotMatch(result.message!, /presentation failed/u);
    assert.equal(fs.existsSync(file), true);
    assert.ok(result.journal);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("skipped authentication cleanup failure is typed without config rollback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const auth = authSession(async () => assert.fail("verify must not run"));
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      {
        clients: [fixture("client", file)],
        terminal: terminal(),
        writeLine: () => undefined,
        prompt: async () => ({
          submitted: true,
          desired: { client: true },
        }),
        confirm: async () => false,
        openAuthSession: () => ({
          ...auth,
          close: () => {
            throw new Error("skipped close failed");
          },
        }),
      },
    );
    assert.equal(result.outcome, "authentication-incomplete");
    assert.equal(result.authentication, "skipped");
    assert.equal(result.disposition, "authentication-incomplete");
    assert.equal(
      result.errorCode,
      "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
    );
    assert.match(result.message!, /skipped close failed/u);
    assert.doesNotMatch(result.message!, /presentation failed/u);
    assert.equal(fs.existsSync(file), true);
    assert.ok(result.journal);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

for (const batch of ["applied", "no-mutation"] as const) {
  test(`prompt cancellation plus cleanup failure preserves an authoritative ${batch} batch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    const auth = authSession(async () => assert.fail("verify must not run"));
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          confirm: async () => {
            const cancellation = new Error("prompt cancelled");
            cancellation.name = "ExitPromptError";
            throw cancellation;
          },
          openAuthSession: () => ({
            ...auth,
            close: () => {
              throw new Error(`${batch} cancellation close failed`);
            },
          }),
        },
      );
      assert.equal(result.outcome, "authentication-incomplete");
      assert.equal(result.authentication, "skipped");
      assert.equal(result.disposition, "authentication-incomplete");
      assert.equal(
        result.errorCode,
        "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
      );
      assert.match(result.message!, /cancellation close failed/u);
      assert.doesNotMatch(result.message!, /presentation failed/u);
      assert.equal(fs.existsSync(file), true);
      assert.equal(result.appliedCount, batch === "applied" ? 1 : 0);
      assert.equal(result.noopCount, batch === "no-mutation" ? 1 : 0);
      assert.equal(result.journal === undefined, batch === "no-mutation");
      assert.equal(
        result.clientResults?.[0]?.state,
        batch === "applied" ? "applied" : "noop",
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

for (const batch of ["applied", "no-mutation"] as const) {
  test(`nested cancellation does not mask ${batch} authentication and cleanup failures`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    const nestedCancellation = () =>
      new ClientConfigurationCancelledError(
        "sana-sign-in",
        new Error("nested cancellation"),
      );
    const auth = authSession(
      async () => assert.fail("verify must not run"),
      async () => {
        if (batch === "applied") throw nestedCancellation();
        throw new Error("request operation failed");
      },
    );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          confirm: async () => true,
          input: async () => "person@example.test",
          openAuthSession: () => ({
            ...auth,
            close: () => {
              if (batch === "no-mutation") throw nestedCancellation();
              throw new Error("operation cleanup failed");
            },
          }),
        },
      );
      assert.equal(
        result.outcome,
        batch === "applied"
          ? "failed-rolled-back"
          : "authentication-incomplete",
      );
      assert.equal(result.authentication, "unconfirmed");
      assert.notEqual(
        result.errorCode,
        "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
      );
      assert.doesNotMatch(result.message!, /authentication.*skipped/iu);
      assert.equal(fs.existsSync(file), batch === "no-mutation");
      assert.equal(result.noopCount, batch === "no-mutation" ? 1 : 0);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

function publicAuthenticationSemanticError(
  semantic: "cancellation" | "partial",
): Error {
  if (semantic === "cancellation")
    return new ClientConfigurationCancelledError(
      "sana-sign-in",
      new Error("forged public cancellation"),
    );
  return new ClientAuthenticationPartialError(
    "forged@example.test",
    "forged-workspace",
    {
      generation: 99,
      publicationToken: "forged-token",
      userId: "forged-user",
      workspaceId: "forged-workspace",
    },
    {
      code: "LOGIN_SYNC_UNAVAILABLE",
      message: "forged partial authentication",
      cause: new Error("forged partial authentication"),
    },
  );
}

for (const batch of ["applied", "no-mutation"] as const) {
  test(`actual prompt cancellation remains skipped for an ${batch} batch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          confirm: async () => {
            const cancellation = new Error("prompt cancelled");
            cancellation.name = "ExitPromptError";
            throw cancellation;
          },
          openAuthSession: () =>
            authSession(async () => assert.fail("verify must not run")),
        },
      );
      assert.equal(result.outcome, batch);
      assert.equal(result.authentication, "skipped");
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const semantic of ["cancellation", "partial"] as const) {
    test(`pre-open onPhase public ${semantic} cannot forge auth for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: () => undefined,
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            onPhase: (phase) => {
              if (phase === "authentication")
                throw publicAuthenticationSemanticError(semantic);
            },
            openAuthSession: () =>
              assert.fail("session must not open after phase failure"),
          },
        );
        assert.equal(
          result.outcome,
          batch === "applied"
            ? "failed-rolled-back"
            : "authentication-incomplete",
        );
        assert.equal(result.authentication, "unconfirmed");
        assert.equal(fs.existsSync(file), batch === "no-mutation");
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  test(`raw phase-only failure remains unconfirmed for an ${batch} batch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          onPhase: (phase) => {
            if (phase === "authentication")
              throw new Error("raw phase-only failure");
          },
          openAuthSession: () =>
            assert.fail("session must not open after phase failure"),
        },
      );
      assert.equal(
        result.outcome,
        batch === "applied"
          ? "failed-rolled-back"
          : "authentication-incomplete",
      );
      assert.equal(result.authentication, "unconfirmed");
      assert.match(result.message!, /raw phase-only failure/u);
      assert.equal(fs.existsSync(file), batch === "no-mutation");
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const authCase of ["confirmed", "skipped"] as const) {
    test(`outer ${authCase} completion rendering retains private authority for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      const answers = ["person@example.test", "123456"];
      const auth = authSession(async () => ({
        kind: "ready",
        user: { email: "person@example.test" },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 7,
          publicationToken: "token",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
      }));
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: (line) => {
              if (
                line.includes(
                  authCase === "confirmed"
                    ? "Sana account  signed in"
                    : "Sana account  not signed in",
                )
              )
                throw new Error(`${authCase} outer completion failed`);
            },
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => authCase === "confirmed",
            input: async () => answers.shift() ?? "",
            openAuthSession: () => auth,
          },
        );
        assert.equal(result.outcome, "interaction-unavailable");
        assert.equal(
          result.authentication,
          authCase === "confirmed" ? "retained" : "skipped",
        );
        assert.equal(
          result.errorCode,
          "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE",
        );
        assert.match(result.message!, /outer completion failed/u);
        assert.equal(fs.existsSync(file), true);
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  test(`actual cancellation observer failure retains private skipped authority for an ${batch} batch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          confirm: async () => {
            const cancellation = new Error("prompt cancelled");
            cancellation.name = "ExitPromptError";
            throw cancellation;
          },
          onPhase: (phase) => {
            if (phase === "post-auth-skipped")
              throw new Error("cancellation observer failed");
          },
          openAuthSession: () =>
            authSession(async () => assert.fail("verify must not run")),
        },
      );
      assert.equal(result.outcome, "interaction-unavailable");
      assert.equal(result.authentication, "skipped");
      assert.match(result.message!, /cancellation observer failed/u);
      assert.equal(fs.existsSync(file), true);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const source of ["presentation", "on-phase"] as const) {
    for (const semantic of ["cancellation", "partial"] as const) {
      for (const closeFailure of [false, true] as const) {
        test(`public ${semantic} from ${source} with ${closeFailure ? "failed" : "successful"} close cannot forge auth for an ${batch} batch`, async () => {
          const root = fs.mkdtempSync(
            path.join(os.tmpdir(), "sana-tx-flow-"),
          );
          const file = path.join(root, "client.json");
          if (batch === "no-mutation")
            fs.writeFileSync(
              file,
              `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
            );
          const answers = ["person@example.test", "123456"];
          const postAuthDisposition =
            semantic === "cancellation" ? "retained" : "skipped";
          const auth = authSession(async () => ({
            kind: "ready",
            user: { email: "person@example.test" },
            workspaceId: "workspace-1",
            confirmation: {
              generation: 6,
              publicationToken: "token",
              userId: "user-1",
              workspaceId: "workspace-1",
            },
          }));
          try {
            const result = await runInstallerConfigTransaction(
              {
                journalDirectory: path.join(root, "journal"),
                serverCommand: process.execPath,
              },
              {
                clients: [fixture("client", file)],
                terminal: terminal(),
                writeLine: (line) => {
                  if (
                    source === "presentation" &&
                    line.includes("We emailed a 6-digit")
                  )
                    throw publicAuthenticationSemanticError(semantic);
                },
                prompt: async () => ({
                  submitted: true,
                  desired: { client: true },
                }),
                confirm: async () =>
                  source === "on-phase"
                    ? semantic === "cancellation"
                    : true,
                input: async () => answers.shift() ?? "",
                onPhase: (phase) => {
                  if (
                    source === "on-phase" &&
                    ((semantic === "cancellation" &&
                      phase === "post-auth-confirmed") ||
                      (semantic === "partial" &&
                        phase === "post-auth-skipped"))
                  )
                    throw publicAuthenticationSemanticError(semantic);
                },
                openAuthSession: () => ({
                  ...auth,
                  close: () => {
                    if (closeFailure)
                      throw new Error("real authoritative close failure");
                  },
                }),
              },
            );
            const trustedPostAuth = source === "on-phase";
            assert.equal(
              result.authentication,
              trustedPostAuth ? postAuthDisposition : "unconfirmed",
            );
            assert.equal(
              result.outcome,
              trustedPostAuth
                ? closeFailure
                  ? "authentication-incomplete"
                  : "interaction-unavailable"
                : batch === "applied"
                  ? "failed-rolled-back"
                  : "authentication-incomplete",
            );
            assert.equal(
              result.errorCode ===
                "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
              trustedPostAuth && closeFailure,
            );
            assert.equal(
              fs.existsSync(file),
              batch === "no-mutation" || trustedPostAuth,
            );
          } finally {
            fs.rmSync(root, { recursive: true });
          }
        });
      }
    }
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const authCase of [
    "partial",
    "partial-cleanup",
    "cancellation-cleanup",
    "confirmed-cleanup",
    "skipped-cleanup",
  ] as const) {
    test(`${authCase} authority survives failure-rendering errors for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      const partialResult = {
        kind: "sync-unavailable" as const,
        user: { email: "person@example.test" },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 2,
          publicationToken: "token",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
        failure: {
          code: "LOGIN_SYNC_UNAVAILABLE" as const,
          message: "daemon unavailable",
          cause: new Error("daemon unavailable"),
        },
      };
      const confirmedResult = {
        kind: "ready" as const,
        user: { email: "person@example.test" },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 3,
          publicationToken: "token",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
      };
      const verify = async () => {
        if (authCase === "partial" || authCase === "partial-cleanup")
          return partialResult;
        if (authCase === "confirmed-cleanup") return confirmedResult;
        return assert.fail("verification must not run for this case");
      };
      const auth = authSession(verify);
      const answers = ["person@example.test", "123456"];
      const hasCleanup = authCase !== "partial";
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: (line) => {
              if (line.includes("Sana setup is incomplete"))
                throw new Error(`${authCase} failure rendering exploded`);
            },
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => {
              if (authCase === "cancellation-cleanup") {
                const cancellation = new Error("prompt cancelled");
                cancellation.name = "ExitPromptError";
                throw cancellation;
              }
              return authCase !== "skipped-cleanup";
            },
            input: async () => answers.shift() ?? "",
            openAuthSession: () => ({
              ...auth,
              close: () => {
                if (hasCleanup)
                  throw new Error(`${authCase} authoritative close failed`);
              },
            }),
          },
        );
        assert.equal(
          result.outcome,
          authCase === "partial" && batch === "applied"
            ? "failed-rolled-back"
            : "authentication-incomplete",
        );
        assert.equal(
          result.authentication,
          authCase === "cancellation-cleanup" ||
            authCase === "skipped-cleanup"
            ? "skipped"
            : "retained",
        );
        assert.equal(
          result.errorCode,
          hasCleanup
            ? "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED"
            : "CONFIG_TRANSACTION_AUTHENTICATION_INCOMPLETE",
        );
        assert.match(result.message!, /failure rendering exploded/u);
        if (hasCleanup) {
          assert.match(result.message!, /authoritative close failed/u);
          if (authCase === "partial-cleanup") {
            assert.match(result.message!, /daemon unavailable/u);
            assert.doesNotMatch(result.message!, /Setup completed/iu);
          }
        }
        assert.equal(
          fs.existsSync(file),
          batch === "no-mutation" || hasCleanup,
        );
        if (hasCleanup) {
          assert.equal(result.appliedCount, batch === "applied" ? 1 : 0);
          assert.equal(result.noopCount, batch === "no-mutation" ? 1 : 0);
          assert.equal(
            result.clientResults?.[0]?.state,
            batch === "applied" ? "applied" : "noop",
          );
        }
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const thrown of [
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "false", value: false },
    { label: "zero", value: 0 },
    { label: "empty-string", value: "" },
  ] as const) {
    test(`${thrown.label} authentication throws cannot become ready for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: () => undefined,
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => {
              throw thrown.value;
            },
            openAuthSession: () =>
              authSession(async () => assert.fail("verify must not run")),
          },
        );
        assert.equal(
          result.outcome,
          batch === "applied"
            ? "failed-rolled-back"
            : "authentication-incomplete",
        );
        assert.equal(result.authentication, "unconfirmed");
        assert.equal(
          result.errorCode,
          "CONFIG_TRANSACTION_AUTHENTICATION_INCOMPLETE",
        );
        assert.match(result.message!, /non-Error value was thrown/u);
        assert.equal(fs.existsSync(file), batch === "no-mutation");
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const source of ["prompt", "presentation", "post-auth-phase"] as const) {
    test(`an inner ${source} aggregate cannot impersonate cleanup for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      const fakeCleanupAggregate = () =>
        new AggregateError(
          [
            new ClientConfigurationCancelledError(
              "sana-sign-in",
              new Error("inner cancellation"),
            ),
            new ClientAuthenticationSessionCleanupError(
              undefined,
              new Error("fake inner cleanup"),
            ),
          ],
          `${source} inner aggregate`,
        );
      const answers = ["person@example.test", "123456"];
      const auth = authSession(async () => ({
        kind: "ready",
        user: { email: "person@example.test" },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 4,
          publicationToken: "token",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
      }));
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: (line) => {
              if (
                source === "presentation" &&
                line.includes("We emailed a 6-digit")
              )
                throw fakeCleanupAggregate();
            },
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => {
              if (source === "prompt") throw fakeCleanupAggregate();
              return true;
            },
            input: async () => answers.shift() ?? "",
            onPhase: (phase) => {
              if (
                source === "post-auth-phase" &&
                phase === "post-auth-confirmed"
              )
                throw fakeCleanupAggregate();
            },
            openAuthSession: () => auth,
          },
        );
        const postAuth = source === "post-auth-phase";
        assert.equal(
          result.outcome,
          postAuth
            ? "interaction-unavailable"
            : batch === "applied"
              ? "failed-rolled-back"
              : "authentication-incomplete",
        );
        assert.equal(
          result.authentication,
          postAuth ? "retained" : "unconfirmed",
        );
        assert.notEqual(
          result.errorCode,
          "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
        );
        assert.equal(
          fs.existsSync(file),
          batch === "no-mutation" || postAuth,
        );
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  test(`session-open authority survives rendering failure for an ${batch} batch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    if (batch === "no-mutation")
      fs.writeFileSync(
        file,
        `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
      );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        {
          clients: [fixture("client", file)],
          terminal: terminal(),
          writeLine: (line) => {
            if (line.includes("Sana sign-in is unavailable"))
              throw new Error("open failure rendering exploded");
          },
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          openAuthSession: () => {
            throw new Error("authoritative session open failed");
          },
        },
      );
      assert.equal(
        result.outcome,
        batch === "applied"
          ? "failed-rolled-back"
          : "authentication-incomplete",
      );
      assert.equal(result.authentication, "unconfirmed");
      assert.match(result.message!, /authoritative session open failed/u);
      assert.match(result.message!, /open failure rendering exploded/u);
      assert.equal(fs.existsSync(file), batch === "no-mutation");
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const authCase of ["confirmed", "skipped"] as const) {
    test(`${authCase} cleanup failure stays authoritative for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      const answers = ["person@example.test", "123456"];
      const auth = authSession(async () => ({
        kind: "ready",
        user: { email: "person@example.test" },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 5,
          publicationToken: "token",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
      }));
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: () => undefined,
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => authCase === "confirmed",
            input: async () => answers.shift() ?? "",
            openAuthSession: () => ({
              ...auth,
              close: () => {
                throw new Error(`${authCase} authoritative cleanup failed`);
              },
            }),
          },
        );
        assert.equal(result.outcome, "authentication-incomplete");
        assert.equal(
          result.authentication,
          authCase === "confirmed" ? "retained" : "skipped",
        );
        assert.equal(
          result.errorCode,
          "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
        );
        assert.doesNotMatch(result.message!, /authoritative presentation failed/u);
        assert.match(result.message!, /authoritative cleanup failed/u);
        assert.equal(fs.existsSync(file), true);
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

for (const batch of ["applied", "no-mutation"] as const) {
  for (const source of [
    "open-session",
    "request-code",
    "verify-code",
    "raw-aggregate",
  ] as const) {
    test(`${source} cleanup-shaped errors are not authoritative for an ${batch} batch`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
      const file = path.join(root, "client.json");
      if (batch === "no-mutation")
        fs.writeFileSync(
          file,
          `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`,
        );
      const cleanupShaped = () =>
        new ClientAuthenticationSessionCleanupError(
          "signed-in",
          new Error(`${source} nested cleanup`),
        );
      const answers = ["person@example.test", "123456"];
      const auth = authSession(
        async () => {
          if (source === "verify-code") throw cleanupShaped();
          return assert.fail("verification must fail for this case");
        },
        async () => {
          if (source === "request-code") throw cleanupShaped();
        },
      );
      try {
        const result = await runInstallerConfigTransaction(
          {
            journalDirectory: path.join(root, "journal"),
            serverCommand: process.execPath,
          },
          {
            clients: [fixture("client", file)],
            terminal: terminal(),
            writeLine: () => undefined,
            prompt: async () => ({
              submitted: true,
              desired: { client: true },
            }),
            confirm: async () => true,
            input: async () => answers.shift() ?? "",
            onPhase: (phase) => {
              if (source === "raw-aggregate" && phase === "authentication")
                throw new AggregateError(
                  [
                    new ClientConfigurationCancelledError(
                      "sana-sign-in",
                      new Error("raw cancellation"),
                    ),
                    new ClientAuthenticationSessionCleanupError(
                      undefined,
                      new Error("raw cleanup"),
                    ),
                  ],
                  "observer aggregate",
                );
            },
            openAuthSession: () => {
              if (source === "open-session") throw cleanupShaped();
              return auth;
            },
          },
        );
        assert.equal(
          result.outcome,
          batch === "applied"
            ? "failed-rolled-back"
            : "authentication-incomplete",
        );
        assert.equal(result.authentication, "unconfirmed");
        assert.notEqual(
          result.errorCode,
          "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
        );
        assert.equal(fs.existsSync(file), batch === "no-mutation");
        assert.equal(result.appliedCount, 0);
        assert.equal(result.noopCount, batch === "no-mutation" ? 1 : 0);
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    });
  }
}

test("authentication failure preserves an authoritative no-op batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const expected = `${JSON.stringify({ mcpServers: { "sana-mcp": target } }, null, 2)}\n`;
  fs.writeFileSync(file, expected);
  const output: string[] = [];
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
      },
      interaction(
        [fixture("client", file)],
        output,
        { client: true },
        authSession(
          async () => assert.fail("verify must not run"),
          async () => {
            throw new Error("request failed");
          },
        ),
      ),
    );
    assert.equal(result.outcome, "authentication-incomplete");
    assert.equal(result.authentication, "unconfirmed");
    assert.equal(result.appliedCount, 0);
    assert.equal(result.noopCount, 1);
    assert.equal(result.journal, undefined);
    assert.equal(result.clientResults?.length, 1);
    assert.equal(result.clientResults?.[0]?.state, "noop");
    assert.equal(result.clientResults?.[0]?.file, file);
    assert.equal(fs.readFileSync(file, "utf8"), expected);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("batch result provenance is validated before presentation or authentication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  const client = fixture("client", file);
  try {
    await assert.rejects(
      runInstall(
        {},
        {
          clients: [client],
          terminal: terminal(),
          writeLine: () => undefined,
          prompt: async () => ({
            submitted: true,
            desired: { client: true },
          }),
          applyBatch: async () => [
            {
              state: "noop",
              clientId: client.id,
              clientName: client.name,
              serverName: "wrong-server",
              desired: "present",
              operation: "register",
              pathState: "known",
              file,
            },
          ],
          openAuthSession: () =>
            assert.fail("authentication must not open for invalid provenance"),
        },
      ),
      /result provenance is invalid/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("--yes is unattended, configures detected clients, and never opens auth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
  const file = path.join(root, "client.json");
  try {
    const result = await runInstallerConfigTransaction(
      {
        journalDirectory: path.join(root, "journal"),
        serverCommand: process.execPath,
        yes: true,
      },
      {
        clients: [fixture("detected", file)],
        terminal: terminal(),
        writeLine: () => undefined,
        openAuthSession: () => {
          throw new Error("auth must not open for --yes");
        },
      },
    );
    assert.equal(result.outcome, "applied");
    assert.equal(result.authentication, "not-attempted");
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

for (const authCase of ["partial", "failure"] as const) {
  test(`interactive ${authCase} login compensates configs and reports retained auth truthfully`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-tx-flow-"));
    const file = path.join(root, "client.json");
    const output: string[] = [];
    const auth =
      authCase === "partial"
        ? authSession(async () => ({
            kind: "sync-unavailable",
            user: { email: "person@example.test" },
            workspaceId: "workspace-1",
            confirmation: {
              generation: 2,
              publicationToken: "token",
              userId: "user-1",
              workspaceId: "workspace-1",
            },
            failure: {
              code: "LOGIN_SYNC_UNAVAILABLE",
              message: "daemon unavailable",
              cause: new Error("daemon unavailable"),
            },
          }))
        : authSession(
            async () => assert.fail("verify must not run"),
            async () => {
              throw new Error("request failed");
            },
          );
    try {
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: path.join(root, "journal"),
          serverCommand: process.execPath,
        },
        interaction([fixture("client", file)], output, { client: true }, auth),
      );
      assert.equal(result.outcome, "failed-rolled-back");
      assert.equal(result.disposition, "authentication-incomplete");
      assert.equal(
        result.authentication,
        authCase === "partial" ? "retained" : "unconfirmed",
      );
      assert.equal(result.exitCode, 1);
      assert.equal(fs.existsSync(file), false);
      assert.ok(result.journal);
      assert.match(
        result.message!,
        authCase === "partial"
          ? /authentication was retained/u
          : /authentication was not confirmed/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}
