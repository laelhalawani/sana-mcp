import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLIENTS,
  detectClient,
  opencodeEntry,
  vscodeEntry,
  type ClientDef,
} from "../../src/install/clients.js";

test("registry identifiers are unique and machine safe", () => {
  assert.equal(new Set(CLIENTS.map((client) => client.id)).size, CLIENTS.length);
  for (const client of CLIENTS) {
    assert.match(client.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(client.name);
    assert.ok(client.reloadHint);
    assert.match(detectClient(client).state, /^(present|absent|unavailable)$/);
    assert.equal(client.install.kind, "file");
  }
});

test("client entry builders expose exact target-bearing fields", () => {
  const target = {
    command: "/opt/sana mcp",
    args: ["mcp"],
    env: { SANA_DATA_DIR: "/tmp/profile" },
  };
  assert.deepEqual(opencodeEntry(target), {
    type: "local",
    command: [target.command, "mcp"],
    environment: target.env,
  });
  assert.deepEqual(vscodeEntry(target), {
    type: "stdio",
    command: target.command,
    args: ["mcp"],
    env: target.env,
  });
});

test("detection exceptions become unavailable instead of absence", () => {
  const client: ClientDef = {
    id: "broken",
    name: "Broken",
    detect() {
      throw new Error("probe failed");
    },
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "unavailable", reason: "no path" }),
      topKey: "mcpServers",
    },
    reloadHint: "none",
  };
  assert.deepEqual(detectClient(client), {
    state: "unavailable",
    reason: "client detection failed: probe failed",
  });
});

test("opencode refuses ambiguous simultaneous JSON and JSONC configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-opencode-"));
  const variable = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
  const previous = process.env[variable];
  try {
    process.env[variable] = root;
    const directory = path.join(root, "opencode");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "opencode.json"), "{}\n");
    fs.writeFileSync(path.join(directory, "opencode.jsonc"), "{}\n");
    const client = CLIENTS.find(({ id }) => id === "opencode");
    assert.ok(client);
    assert.equal(client?.install.path().state, "unavailable");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    fs.rmSync(root, { recursive: true });
  }
});

test("manual home-based clients become unavailable without creating cwd-relative paths", () => {
  if (process.platform === "win32") return;
  const relativeHome = `relative-sana-home-${process.pid}`;
  const accidentalPath = path.resolve(relativeHome);
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousPath = process.env.PATH;
  assert.equal(fs.existsSync(accidentalPath), false);
  try {
    process.env.HOME = relativeHome;
    delete process.env.XDG_CONFIG_HOME;
    process.env.PATH = "";
    for (const id of ["claude-code", "cursor", "codex", "gemini-cli"]) {
      const client = CLIENTS.find((candidate) => candidate.id === id);
      assert.ok(client, id);
      assert.deepEqual(client.install.path(), {
        state: "unavailable",
        reason: "HOME must be an absolute POSIX path",
      });
      assert.equal(detectClient(client).state, "unavailable");
    }
    assert.equal(fs.existsSync(accidentalPath), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
