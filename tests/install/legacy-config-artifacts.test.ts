import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectLegacyConfigArtifacts,
  legacyArtifactPattern,
} from "../../src/install/legacy-config-artifacts.js";
import {
  applyFileChange,
  planFileChange,
} from "../../src/install/writers.js";

const nonce = "a".repeat(24);
const capture = "b".repeat(48);

function bases(target: string): string[] {
  return [
    `.${target}.sana-mcp.journal.json`,
    `.${target}.sana-mcp.lock`,
    `.${target}.sana-mcp-${nonce}.bak`,
    `.${target}.sana-mcp-${nonce}.tmp`,
    `.${target}.sana-mcp.lock.publish-${nonce}-${nonce}.tmp`,
    `.${target}.sana-mcp.lock.stale-${nonce}`,
  ];
}

test("every exact legacy base and cleanup-capture form is recognized", () => {
  const pattern = legacyArtifactPattern("client.json");
  for (const base of bases("client.json")) {
    assert.equal(pattern.test(base), true, base);
    assert.equal(pattern.test(`${base}.remove-${capture}`), true, base);
  }
});

test("near misses and artifacts for another target do not match", () => {
  const pattern = legacyArtifactPattern("client.json");
  const exact = bases("client.json");
  for (const value of [
    ...exact.map((base) => `${base}x`),
    ...exact.map((base) => `${base}.remove-${"a".repeat(47)}`),
    ...exact.map((base) => `${base}.remove-${"a".repeat(49)}`),
    ...exact.map(
      (base) => `${base}.remove-${"a".repeat(47)}g`
    ),
    ...exact.map((base) => `${base}.remove-${"A".repeat(48)}`),
    ...bases("client.json.backup"),
  ])
    assert.equal(pattern.test(value), false, value);
});

test("a legacy artifact blocks a missing target read-only", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-mcp-legacy-config-")
  );
  const file = path.join(directory, "client.json");
  const artifact = path.join(directory, bases("client.json")[0]!);
  try {
    fs.writeFileSync(artifact, "preserve");
    const inspected = inspectLegacyConfigArtifacts(file);
    assert.equal(inspected.state, "blocked");
    const planned = planFileChange({
      file,
      format: "json",
      topKey: "mcpServers",
      name: "sana-mcp",
      target: { command: "/opt/sana-mcp", args: ["mcp"] },
      operation: "register",
    });
    assert.equal(planned.state, "unavailable");
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(artifact, "utf8"), "preserve");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("an artifact observed after planning blocks apply without recovery", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-mcp-legacy-config-")
  );
  const file = path.join(directory, "client.json");
  const artifact = path.join(
    directory,
    `${bases("client.json")[4]!}.remove-${capture}`
  );
  try {
    fs.writeFileSync(file, "{}\n");
    const planned = planFileChange({
      file,
      format: "json",
      topKey: "mcpServers",
      name: "sana-mcp",
      target: { command: "/opt/sana-mcp", args: ["mcp"] },
      operation: "register",
    });
    assert.equal(planned.state, "ready");
    fs.writeFileSync(artifact, "preserve");
    const result = applyFileChange(planned);
    assert.equal(result.state, "unavailable");
    assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
    assert.equal(fs.readFileSync(artifact, "utf8"), "preserve");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
