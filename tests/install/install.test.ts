import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExitPromptError } from "@inquirer/core";
import {
  ClientConfigurationIncompleteError,
  describeApplyResult,
  handleClientConfigurationCliError,
  runInstall,
  runUninstall,
} from "../../src/install/install.js";
import type { InstallInteraction } from "../../src/install/install.js";
import type { ApplyResult } from "../../src/install/apply.js";
import { CLIENTS, type ClientDef } from "../../src/install/clients.js";
import { serverTarget } from "../../src/install/server-target.js";

interface EnvironmentSnapshot {
  HOME?: string;
  USERPROFILE?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
  LOCALAPPDATA?: string;
  PATH?: string;
}

function cursorFixture(file: string): ClientDef {
  return {
    id: "cursor",
    name: "Cursor",
    detect: () => ({ state: "present", evidence: [file] }),
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "available", path: file }),
      topKey: "mcpServers",
    },
    reloadHint: "restart Cursor",
  };
}

function captureInteraction(
  logs: string[],
  additions: Partial<InstallInteraction> = {}
): InstallInteraction {
  return {
    terminal: {
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      env: { NO_COLOR: "", LANG: "C.UTF-8" },
      platform: process.platform,
    },
    writeLine: (line) => logs.push(line),
    ...additions,
  };
}

async function withForeignCursor(
  dryRun: boolean
): Promise<{ output: string; config: string; configPath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-uninstall-"));
  const cursorDirectory = path.join(root, ".cursor");
  const config = path.join(cursorDirectory, "mcp.json");
  fs.mkdirSync(cursorDirectory, { recursive: true });
  const original =
    '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n';
  fs.writeFileSync(config, original);

  const previous: EnvironmentSnapshot = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  const logs: string[] = [];
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    process.env.APPDATA = path.join(root, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(root, "AppData", "Local");
    process.env.PATH = path.join(root, "empty-path");
    await assert.rejects(
      runUninstall(
        { yes: true, dryRun, name: "sana-mcp" },
        captureInteraction(logs, {
          clients: [cursorFixture(config)],
        })
      ),
      (error: unknown) =>
        error instanceof ClientConfigurationIncompleteError &&
        error.code === "CLIENT_CONFIGURATION_INCOMPLETE"
    );
    return {
      output: logs.join("\n"),
      config: fs.readFileSync(config, "utf8"),
      configPath: config,
    };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true });
  }
}

test("uninstall collision is nonzero/manual and never prints success", async () => {
  const result = await withForeignCursor(false);
  assert.match(result.output, /Cursor: configuration unavailable:/u);
  assert.match(result.output, /Configuration is incomplete/u);
  assert.doesNotMatch(result.output, /\nDone\./u);
  assert.match(result.config, /"command":"foreign"/u);
  assert.match(result.output, /config: .*mcp\.json/u);
});

test("uninstall returns structured planned, completed, cancelled, and unavailable outcomes", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-uninstall-outcome-")
  );
  const file = path.join(root, "client.json");
  const client = cursorFixture(file);
  const absentClient: ClientDef = {
    ...client,
    detect: () => ({ state: "absent" }),
  };
  const writeOwned = () => {
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        mcpServers: { "sana-mcp": serverTarget() },
      })}\n`
    );
  };
  try {
    assert.deepEqual(
      await runUninstall(
        { yes: true },
        captureInteraction([], { clients: [absentClient] })
      ),
      { disposition: "no-registrations", selectedCount: 0 }
    );

    writeOwned();
    assert.deepEqual(
      await runUninstall(
        {},
        captureInteraction([], {
          clients: [client],
          terminal: {
            input: { isTTY: false },
            output: { isTTY: true, write() {} },
            env: { NO_COLOR: "", LANG: "C.UTF-8" },
            platform: process.platform,
          },
        })
      ),
      { disposition: "interaction-unavailable", selectedCount: 0 }
    );
    assert.equal(fs.existsSync(file), true);

    assert.deepEqual(
      await runUninstall(
        {},
        captureInteraction([], {
          clients: [client],
          chooseClients: async () => {
            throw new ExitPromptError();
          },
        })
      ),
      { disposition: "cancelled", selectedCount: 0 }
    );
    assert.equal(fs.existsSync(file), true);

    assert.deepEqual(
      await runUninstall(
        {},
        captureInteraction([], {
          clients: [client],
          chooseClients: async () => [],
        })
      ),
      { disposition: "no-selection", selectedCount: 0 }
    );
    assert.equal(fs.existsSync(file), true);

    const dryRunOutput: string[] = [];
    assert.deepEqual(
      await runUninstall(
        { yes: true, dryRun: true },
        captureInteraction(dryRunOutput, { clients: [client] })
      ),
      { disposition: "planned", selectedCount: 1 }
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      mcpServers: { "sana-mcp": serverTarget() },
    });
    assert.doesNotMatch(dryRunOutput.join("\n"), /restart Cursor/u);

    assert.deepEqual(
      await runUninstall(
        { yes: true },
        captureInteraction([], { clients: [client] })
      ),
      { disposition: "completed", selectedCount: 1 }
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      mcpServers: {},
    });
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("incomplete interactive wizard result is a typed nonzero caller outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-install-wizard-"));
  const cursorDirectory = path.join(root, ".cursor");
  const config = path.join(cursorDirectory, "mcp.json");
  fs.mkdirSync(cursorDirectory, { recursive: true });
  const previous: EnvironmentSnapshot = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  const logs: string[] = [];
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    process.env.APPDATA = path.join(root, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(root, "AppData", "Local");
    process.env.PATH = path.join(root, "empty-path");
    await assert.rejects(
      runInstall(
        {},
        captureInteraction(logs, {
          clients: [cursorFixture(config)],
          isInteractiveInput: () => true,
          prompt: async () => ({ submitted: true, desired: {} }),
        })
      ),
      ClientConfigurationIncompleteError
    );
    assert.equal(fs.existsSync(config), false);
    const output = logs.join("\n");
    assert.match(output, /result was incomplete; no changes were applied/u);
    assert.doesNotMatch(output, /All set/u);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true });
  }
});

test("dry-run planning failure is nonzero and remains read-only", async () => {
  const result = await withForeignCursor(true);
  assert.match(
    result.output,
    /Dry run: no client config files will be changed/u
  );
  assert.match(result.output, /Configuration is incomplete/u);
  assert.doesNotMatch(result.output, /Dry run complete/u);
  assert.doesNotMatch(result.output, /\nDone\./u);
  assert.match(result.config, /"command":"foreign"/u);
});

test("uninstall rejects hostile server names before detection or prompting", async () => {
  const hostile = "sana\n\u001b[31m\u202emcp";
  const logs: string[] = [];
  await assert.rejects(
    runUninstall(
      { name: hostile },
      captureInteraction(logs)
    ),
    /server name must be 1-64 ASCII/u
  );
  const output = logs.join("\n");
  assert.equal(output, "");
  assert.doesNotMatch(output, /[\n\r\u001b\u202e]/u);
});

test("install rejects an invalid name before detection or no-client success", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-install-name-"));
  const previous: EnvironmentSnapshot = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  const originalDetections = CLIENTS.map((client) => client.detect);
  const logs: string[] = [];
  let detectionCalls = 0;
  try {
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    process.env.APPDATA = path.join(root, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(root, "AppData", "Local");
    process.env.PATH = path.join(root, "empty-path");
    CLIENTS.forEach((client) => {
      client.detect = () => {
        detectionCalls += 1;
        return { state: "absent" };
      };
    });
    await assert.rejects(
      runInstall(
        { name: "invalid/name", yes: true },
        captureInteraction(logs)
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "server name must be 1-64 ASCII letters, digits, dots, underscores, or hyphens"
    );

    assert.equal(detectionCalls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(logs.join("\n"), "");
  } finally {
    CLIENTS.forEach((client, index) => {
      client.detect = originalDetections[index]!;
    });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true });
  }
});

test("CLI boundary recognizes only the typed expected error", () => {
  const previous = process.exitCode;
  try {
    process.exitCode = 0;
    assert.equal(
      handleClientConfigurationCliError(
        new ClientConfigurationIncompleteError(["Cursor"])
      ),
      true
    );
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.equal(
      handleClientConfigurationCliError(
        Object.assign(new Error("unexpected"), {
          code: "CLIENT_CONFIGURATION_INCOMPLETE",
        })
      ),
      false
    );
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = previous ?? 0;
  }
});

test("human manual-result rendering sanitizes hostile reasons and paths", () => {
  const hostilePath = "/tmp/client\n\u001b[31m\u202econfig.json";
  const hostileReason = "failed\n\u001b[2Jspoof\rrow\u0007\u202e";
  const common = {
    clientId: "fixture",
    clientName: "Fixture",
    serverName: "sana-mcp",
    desired: "present" as const,
    operation: "register" as const,
    pathState: "known" as const,
    file: hostilePath,
  };
  const results: ApplyResult[] = [
    { ...common, state: "collision", reason: hostileReason },
    { ...common, state: "unavailable", reason: hostileReason },
    { ...common, state: "conflict", reason: hostileReason },
    { ...common, state: "ambiguous", reason: hostileReason },
    { ...common, state: "failed", reason: hostileReason },
  ];
  for (const result of results) {
    const rendered = describeApplyResult(result);
    assert.doesNotMatch(
      rendered,
      /[\n\r\u001b\u0007\u202e]/u,
      result.state
    );
    assert.match(rendered, /config: "\/tmp\/client\\n\\u001b\[31mconfig\.json"/u);
    assert.match(rendered, /failed spoof row/u);
    assert.equal(result.pathState, "known");
    assert.equal(result.file, hostilePath);
  }

  const successful: ApplyResult[] = [
    { ...common, state: "applied", durability: "verified" },
    { ...common, state: "planned" },
    { ...common, state: "noop" },
  ];
  for (const result of successful) {
    const rendered = describeApplyResult(result);
    assert.doesNotMatch(rendered, /[\n\r\u001b\u202e]/u);
    assert.doesNotMatch(rendered, /\[config: /u);
    assert.equal(rendered.includes(hostilePath), false);
  }

  const unavailable: ApplyResult = {
    clientId: "fixture",
    clientName: "Fixture",
    serverName: "sana-mcp",
    desired: "present",
    operation: "register",
    pathState: "unavailable",
    pathUnavailableReason: "root\n\u001b[31munavailable",
    state: "unavailable",
    reason: hostileReason,
  };
  const rendered = describeApplyResult(unavailable);
  assert.doesNotMatch(rendered, /[\n\r\u001b]/u);
  assert.match(rendered, /config path unavailable: root unavailable/u);
});

test("native Bun CLI reports expected incomplete config without a stack", { timeout: 15_000 }, (context) => {
  if (typeof Bun === "undefined") {
    context.diagnostic(
      "native Bun CLI subprocess evidence is collected by the Windows run"
    );
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-cli-boundary-"));
  const cursorDirectory = path.join(root, ".cursor");
  fs.mkdirSync(cursorDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(cursorDirectory, "mcp.json"),
    '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n'
  );
  try {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(process.cwd(), "src", "cli.ts"),
        "uninstall",
        "--yes",
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: path.join(root, ".config"),
        APPDATA: path.join(root, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(root, "AppData", "Local"),
        PATH: path.join(root, "empty-path"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    assert.equal(child.exitCode, 1);
    assert.match(stdout, /Configuration is incomplete/u);
    assert.doesNotMatch(stdout, /\nDone\./u);
    assert.doesNotMatch(
      stderr,
      /ClientConfigurationIncompleteError|\n\s+at\s/u
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
