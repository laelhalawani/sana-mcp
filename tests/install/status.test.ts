import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ClientDef } from "../../src/install/clients.js";
import { registrationStatus } from "../../src/install/status.js";

const target = { command: "/opt/sana-mcp", args: ["mcp"] };

test("file status distinguishes owned, foreign, absent, and unavailable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-status-"));
  const file = path.join(directory, "client.json");
  const client: ClientDef = {
    id: "fixture",
    name: "Fixture",
    detect: () => ({ state: "present", evidence: [file] }),
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "available", path: file }),
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
  try {
    const absent = await registrationStatus(client, "sana-mcp", target);
    assert.equal(absent.state, "absent");
    assert.equal(absent.file, file);
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { "sana-mcp": target } })
    );
    assert.equal(
      (await registrationStatus(client, "sana-mcp", target)).state,
      "owned"
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { "sana-mcp": { command: "other", args: [] } },
      })
    );
    assert.equal(
      (await registrationStatus(client, "sana-mcp", target)).state,
      "foreign"
    );
    fs.writeFileSync(file, "{broken");
    assert.equal(
      (await registrationStatus(client, "sana-mcp", target)).state,
      "unavailable"
    );
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("registration status exposes a typed path-unavailable reason", async () => {
  const client: ClientDef = {
    id: "unavailable",
    name: "Unavailable",
    detect: () => ({ state: "unavailable", reason: "not detectable" }),
    install: {
      kind: "file",
      format: "json",
      path: () => ({
        state: "unavailable",
        reason: "config root is unavailable",
      }),
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
  const status = await registrationStatus(client, "sana-mcp", target);
  assert.equal(status.state, "unavailable");
  assert.equal(status.pathState, "unavailable");
  if (status.pathState === "unavailable")
    assert.equal(status.pathUnavailableReason, "config root is unavailable");
});

test("registration status types thrown path resolution without inventing a path", async () => {
  const detail = "resolver denied\n\u001b[31mno path";
  const client: ClientDef = {
    id: "throwing",
    name: "Throwing",
    detect: () => ({ state: "unavailable", reason: "not detectable" }),
    install: {
      kind: "file",
      format: "json",
      path: () => {
        throw new Error(detail);
      },
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
  const status = await registrationStatus(client, "sana-mcp", target);
  assert.equal(status.state, "unavailable");
  assert.equal(status.pathState, "unavailable");
  if (status.state === "unavailable" && status.pathState === "unavailable") {
    assert.equal(
      status.reason,
      `client config path resolution failed: ${detail}`
    );
    assert.equal(status.pathUnavailableReason, status.reason);
    assert.equal("file" in status, false);
  }
});
