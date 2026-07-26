import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyFileChange,
  inspectConfigOwnership,
  planFileChange,
} from "../../src/install/writers.js";
import { claudeCodePredecessorEntry } from "../../src/install/clients.js";

const target = { command: "/opt/sana-mcp", args: ["mcp"] };

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-writers-"));
}

function plan(file: string, operation: "register" | "remove" = "register") {
  return planFileChange({
    file,
    format: "json",
    topKey: "mcpServers",
    name: "sana-mcp",
    target,
    operation,
  });
}

test("JSON changes are atomic, mode preserving, and idempotent", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    fs.writeFileSync(file, '{"foreign":true}\n', { mode: 0o640 });
    const result = applyFileChange(plan(file));
    assert.equal(result.state, "applied");
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      foreign: true,
      mcpServers: { "sana-mcp": target },
    });
    assert.equal(plan(file).state, "noop");
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("a new nested config is created only during apply", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "nested", "client.json");
  try {
    const planned = plan(file);
    assert.equal(planned.state, "ready");
    assert.equal(fs.existsSync(path.dirname(file)), false);
    assert.equal(applyFileChange(planned).state, "applied");
    assert.equal(
      inspectConfigOwnership({
        file,
        format: "json",
        topKey: "mcpServers",
        name: "sana-mcp",
        target,
      }).state,
      "owned",
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("writer planning preserves nested aggregate causes", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    const planned = planFileChange({
      file,
      format: "json",
      topKey: "mcpServers",
      name: "sana-mcp",
      target,
      operation: "register",
      build: () => {
        throw new AggregateError(
          [
            new Error("render primary cause"),
            new Error("render cleanup cause"),
          ],
          "render and cleanup both failed",
        );
      },
    });
    assert.equal(planned.state, "unavailable");
    const reason = planned.ownership.reason;
    assert.match(reason, /render primary cause/u);
    assert.match(reason, /render cleanup cause/u);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("foreign same-name entries are never replaced or removed", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const original =
    '{"mcpServers":{"sana-mcp":{"command":"other","args":[]}}}\n';
  try {
    fs.writeFileSync(file, original);
    assert.equal(plan(file).state, "collision");
    assert.equal(plan(file, "remove").state, "collision");
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("an exact predecessor entry is owned, unchanged on register, and removable", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const predecessor = {
    type: "stdio",
    command: target.command,
    args: target.args,
    env: {},
  };
  const original = `${JSON.stringify({
    mcpServers: { "sana-mcp": predecessor },
    retained: true,
  })}\n`;
  const options = {
    file,
    format: "json" as const,
    topKey: "mcpServers",
    name: "sana-mcp",
    target,
    predecessors: [claudeCodePredecessorEntry],
  };
  try {
    fs.writeFileSync(file, original);
    assert.equal(
      planFileChange({ ...options, operation: "register" }).state,
      "noop",
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    const removal = planFileChange({ ...options, operation: "remove" });
    assert.equal(removal.state, "ready");
    assert.equal(applyFileChange(removal).state, "applied");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      mcpServers: {},
      retained: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("an observed edit after planning returns conflict and remains untouched", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const original = '{"one":1}\n';
  const changed = '{"one":2}\n';
  try {
    fs.writeFileSync(file, original);
    const planned = plan(file);
    assert.equal(planned.state, "ready");
    fs.writeFileSync(file, changed);
    const result = applyFileChange(planned);
    assert.equal(result.state, "conflict");
    assert.equal(fs.readFileSync(file, "utf8"), changed);
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("duplicate JSON keys and unsafe final links are unavailable", (context) => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const link = path.join(directory, "linked.json");
  try {
    fs.writeFileSync(file, '{"mcpServers":{},"mcpServers":{}}\n');
    assert.equal(plan(file).state, "unavailable");
    if (process.platform === "win32") {
      context.diagnostic(
        "reparse creation requires Windows developer mode; native review covers the boundary",
      );
    } else {
      fs.symlinkSync(file, link);
      assert.equal(plan(link).state, "unavailable");
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
