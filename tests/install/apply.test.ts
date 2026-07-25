import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyClientChange,
  planClientChange,
  validateServerName,
  type ConfigPathProvenance,
} from "../../src/install/apply.js";
import type { ClientDef } from "../../src/install/clients.js";

const target = { command: "/opt/sana-mcp", args: ["mcp"] };

function fixture(file: string): ClientDef {
  return {
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
}

test("server names are deliberately narrow", () => {
  validateServerName("sana-mcp_2.test");
  for (const invalid of [
    "",
    "../sana",
    "sana mcp",
    "a".repeat(65),
    "sana\nmcp",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
  ])
    assert.throws(() => validateServerName(invalid));
});

test("planning is presentation-free and dry-run does not mutate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-apply-"));
  const file = path.join(directory, "client.json");
  try {
    const change = await planClientChange(fixture(file), "sana-mcp", target, "present");
    assert.equal(change.state, "ready");
    const result = await applyClientChange(change, { dryRun: true });
    assert.equal(result.state, "planned");
    assert.equal(result.file, file);
    assert.equal(fs.existsSync(file), false);
    assert.equal("detail" in result, false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("apply reports collision and does not overwrite a foreign target", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-apply-"));
  const file = path.join(directory, "client.json");
  const original = '{"mcpServers":{"sana-mcp":{"command":"other","args":[]}}}\n';
  try {
    fs.writeFileSync(file, original);
    const change = await planClientChange(fixture(file), "sana-mcp", target, "present");
    assert.equal(change.state, "collision");
    assert.equal(change.file, file);
    const result = await applyClientChange(change);
    assert.equal(result.state, "collision");
    assert.equal(result.file, file);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("invalid names fail before filesystem mutation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-apply-"));
  const file = path.join(directory, "client.json");
  try {
    const change = await planClientChange(fixture(file), "../other", target, "present");
    assert.equal(change.state, "unavailable");
    assert.equal(change.pathState, "known");
    if (change.pathState === "known") assert.equal(change.file, file);
    assert.equal((await applyClientChange(change)).state, "unavailable");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("path-unavailable provenance remains explicit even for an invalid name", async () => {
  const client: ClientDef = {
    id: "unavailable",
    name: "Unavailable",
    detect: () => ({ state: "unavailable", reason: "detection unavailable" }),
    install: {
      kind: "file",
      format: "json",
      path: () => ({
        state: "unavailable",
        reason: "authoritative config path is unavailable",
      }),
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
  const change = await planClientChange(client, "../invalid", target, "present");
  assert.equal(change.state, "unavailable");
  assert.equal(change.pathState, "unavailable");
  if (change.pathState === "unavailable")
    assert.equal(
      change.pathUnavailableReason,
      "authoritative config path is unavailable"
    );
  const result = await applyClientChange(change);
  assert.equal(result.pathState, "unavailable");
});

test("thrown path resolution becomes typed unavailable through plan and apply", async () => {
  const detail = "resolver failed\n\u001b[31mwithout a path";
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
  const change = await planClientChange(
    client,
    "sana-mcp",
    target,
    "present"
  );
  assert.equal(change.state, "unavailable");
  assert.equal(change.pathState, "unavailable");
  if (change.state === "unavailable" && change.pathState === "unavailable") {
    assert.equal(
      change.reason,
      `client config path resolution failed: ${detail}`
    );
    assert.equal(change.pathUnavailableReason, change.reason);
  }
  const result = await applyClientChange(change);
  assert.deepEqual(result, change);
});

test("config path provenance is exhaustively discriminated", () => {
  const values: ConfigPathProvenance[] = [
    { pathState: "known", file: "/tmp/client.json" },
    {
      pathState: "unavailable",
      pathUnavailableReason: "no authoritative path",
    },
  ];
  for (const value of values) {
    switch (value.pathState) {
      case "known":
        assert.equal(value.file, "/tmp/client.json");
        break;
      case "unavailable":
        assert.equal(value.pathUnavailableReason, "no authoritative path");
        break;
      default: {
        const exhaustive: never = value;
        assert.fail(`unexpected provenance ${String(exhaustive)}`);
      }
    }
  }
});
