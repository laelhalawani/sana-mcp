import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");

const harness = String.raw`
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const scenario = process.argv[3];
const install = path.join(root, "install");
const executable = path.join(install, "sana-mcp");
const marker = path.join(root, "installer.properties");
const currentVersion = scenario === "installed-newer" ? "0.5.0" : "0.4.1";
const receiptFormat =
  scenario === "v2-current" || scenario === "receipt-state-mismatch"
  ? "sana-mcp-install-v2"
  : "sana-mcp-install-v1";
fs.mkdirSync(install, { recursive: true });
fs.writeFileSync(executable, "installed-runtime", { mode: 0o700 });
const binarySha256 = createHash("sha256")
  .update(fs.readFileSync(executable))
  .digest("hex");
fs.writeFileSync(
  path.join(install, ".sana-mcp-install-v1"),
  [
    "format=" + receiptFormat,
    "version=" + currentVersion,
    "target=bun-linux-x64",
    "sourceCommit=" + "1".repeat(40),
    "binarySha256=" + (
      scenario === "bad-installed-hash" ? "0".repeat(64) : binarySha256
    ),
    "pathProfile=none",
    "pathBlockSha256=none",
    ...(receiptFormat === "sana-mcp-install-v2"
      ? [
          "installerProtocol=1",
          "lifecycleProtocol=1",
          "inspectProtocol=1",
          "stateCompatibility=" + (
            scenario === "receipt-state-mismatch" ? "2" : "1"
          ),
        ]
      : []),
    "",
  ].join("\n"),
);
process.execPath = executable;

const buildInfoUrl = pathToFileURL(
  path.join(process.cwd(), "src/runtime/build-info.ts"),
).href;
mock.module(buildInfoUrl, () => ({
  BUILD_INFO: {
    mode: "standalone",
    standalone: true,
    version: currentVersion,
    target: "bun-linux-x64",
    installerProtocol: 1,
    lifecycleProtocol: 1,
    inspectProtocol: 1,
    stateCompatibility: 1,
    semanticCapability: "bundled",
  },
}));

const nextVersion =
  scenario === "current" || scenario === "v2-current"
    ? currentVersion
    : scenario === "installed-newer"
      ? "0.4.2"
      : "0.4.2";
const nextState =
  scenario === "incompatible-decline" || scenario === "incompatible-update"
    ? 2
    : 1;
const installer = new TextEncoder().encode([
  "#!/bin/sh",
  "set -eu",
  "printf '%s\\n' \\",
  '  "version=$SANA_MCP_VERSION" \\',
  '  "directory=$SANA_MCP_INSTALL_DIR" \\',
  '  "update=$SANA_MCP_UPDATE" \\',
  '  "expectedVersion=$SANA_MCP_EXPECTED_INSTALLED_VERSION" \\',
  '  "expectedTarget=$SANA_MCP_EXPECTED_INSTALLED_TARGET" \\',
  '  "expectedSha256=$SANA_MCP_EXPECTED_INSTALLED_SHA256" \\',
  '  "expectedState=$SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY" \\',
  '  "replace=\${SANA_MCP_REPLACE_INCOMPATIBLE-}" > ' + JSON.stringify(marker),
  "",
].join("\n"));
const installerHash = createHash("sha256").update(installer).digest("hex");
const metadataName = "manifest-bun-linux-x64.properties";
const metadata = new TextEncoder().encode([
  "format=sana-mcp-release-v1",
  "manifestVersion=1",
  "manifestSha256=" + "2".repeat(64),
  "packageVersion=" + nextVersion,
  "releaseTag=v" + nextVersion,
  "sourceCommit=" + "1".repeat(40),
  "installerProtocol=1",
  "lifecycleProtocol=1",
  "inspectProtocol=1",
  "target=bun-linux-x64",
  "stateCompatibility=" + nextState,
  "semanticCapability=bundled",
  "installerAssetName=install.sh",
  "installerSha256=" + installerHash,
  "assetName=sana-mcp-bun-linux-x64",
  "checksumFileName=sana-mcp-bun-linux-x64.sha256",
  "sha256=" + "3".repeat(64),
  "",
].join("\n"));
const metadataHash = createHash("sha256").update(metadata).digest("hex");
const requests = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith("/" + metadataName)) {
    return new Response(metadata);
  }
  if (url.endsWith("/" + metadataName + ".sha256")) {
    const digest = scenario === "bad-metadata-checksum"
      ? "0".repeat(64)
      : metadataHash;
    return new Response(digest + "  " + metadataName + "\n");
  }
  if (url.endsWith("/install.sh")) return new Response(installer);
  if (url.endsWith("/install.sh.sha256")) {
    const digest = scenario === "bad-installer-checksum"
      ? "0".repeat(64)
      : installerHash;
    return new Response(digest + "  install.sh\n");
  }
  return new Response("not found", { status: 404 });
};

const { runUpdate } = await import(
  pathToFileURL(path.join(process.cwd(), "src/install/update.ts")).href
);
if (scenario === "stale-consent-compatible") {
  process.env.SANA_MCP_REPLACE_INCOMPATIBLE = "1";
}
let confirmation = null;
try {
  const result = await runUpdate({
    platform: scenario === "incompatible-decline" ? "win32" : undefined,
    confirmIncompatible: async (current, next) => {
      confirmation = [current, next];
      return false;
    },
  });
  console.log(JSON.stringify({
    ok: true,
    result,
    requests,
    confirmation,
    marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    requests,
    confirmation,
    marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
  }));
}
`;

type HarnessResult = Readonly<{
  ok: boolean;
  result?: {
    state: string;
    version: string;
    latestVersion?: string;
  };
  error?: string;
  requests: readonly string[];
  confirmation: readonly [number, number] | null;
  marker: string | null;
}>;

function runHarness(scenario: string): HarnessResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-update-test-"));
  const home = path.join(root, "home");
  const commandDirectory = path.join(root, "commands");
  const harnessFile = path.join(root, "harness.ts");
  fs.mkdirSync(home);
  fs.mkdirSync(commandDirectory);
  fs.writeFileSync(harnessFile, harness);
  const environment = {
    ...process.env,
    HOME: home,
    PATH: `/usr/bin:/bin`,
  };
  delete environment.SANA_DATA_DIR;
  delete environment.SANA_TRANSCRIPTS_DIR;
  delete environment.SANA_MCP_REPLACE_INCOMPATIBLE;
  try {
    const child = spawnSync(
      process.execPath,
      [harnessFile, root, scenario],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split(/\r?\n/u);
    return JSON.parse(lines.at(-1)!) as HarnessResult;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("standalone update coordinator", () => {
  test("reports an installed v1 or v2 release as current without downloading an installer", () => {
    for (const scenario of ["current", "v2-current"]) {
      const result = runHarness(scenario);
      expect(result.ok, scenario).toBe(true);
      expect(result.result, scenario).toEqual({
        state: "current",
        version: "0.4.1",
      });
      expect(result.requests, scenario).toHaveLength(2);
      expect(result.requests.every((url) => url.includes("/latest/download/")))
        .toBe(true);
      expect(result.marker).toBeNull();
    }
  });

  test("does not downgrade a runtime newer than the published release", () => {
    const result = runHarness("installed-newer");
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      state: "newer",
      version: "0.5.0",
      latestVersion: "0.4.2",
    });
    expect(result.requests).toHaveLength(2);
    expect(result.marker).toBeNull();
  });

  test("rejects changed installed bytes before making any network request", () => {
    const result = runHarness("bad-installed-hash");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer matches its receipt");
    expect(result.requests).toEqual([]);
    expect(result.marker).toBeNull();
  });

  test("rejects latest metadata whose checksum does not match", () => {
    const result = runHarness("bad-metadata-checksum");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("metadata checksum mismatch");
    expect(result.requests).toHaveLength(2);
    expect(result.marker).toBeNull();
  });

  test("rejects a receipt/runtime state mismatch before making any network request", () => {
    const result = runHarness("receipt-state-mismatch");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "receipt and runtime disagree on state compatibility",
    );
    expect(result.requests).toEqual([]);
    expect(result.marker).toBeNull();
  });

  test("declines an incompatible state update before fetching or running the installer", () => {
    const result = runHarness("incompatible-decline");
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ state: "cancelled", version: "0.4.1" });
    expect(result.confirmation).toEqual([1, 2]);
    expect(result.requests).toHaveLength(2);
    expect(result.marker).toBeNull();
  });

  test("runs a checksum-bound compatible installer with pinned update context", () => {
    for (const scenario of ["compatible-update", "stale-consent-compatible"]) {
      const result = runHarness(scenario);
      expect(result.ok, scenario).toBe(true);
      expect(result.result, scenario).toEqual({
        state: "updated",
        version: "0.4.2",
      });
      expect(result.confirmation, scenario).toBeNull();
      expect(result.requests, scenario).toHaveLength(4);
      expect(result.marker, scenario).toContain("version=v0.4.2\n");
      expect(result.marker, scenario).toContain("directory=");
      expect(result.marker, scenario).toContain("update=1\n");
      expect(result.marker, scenario).toContain("expectedVersion=0.4.1\n");
      expect(result.marker, scenario).toContain(
        "expectedTarget=bun-linux-x64\n",
      );
      expect(result.marker, scenario).toMatch(
        /expectedSha256=[a-f0-9]{64}\n/u,
      );
      expect(result.marker, scenario).toContain("expectedState=1\n");
      expect(result.marker, scenario).toContain("replace=\n");
    }
  });

  test("does not execute an installer whose release sidecar is inconsistent", () => {
    const result = runHarness("bad-installer-checksum");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("installer checksum mismatch");
    expect(result.requests).toHaveLength(4);
    expect(result.marker).toBeNull();
  });

  test("refuses an unsupported incompatible POSIX update before confirmation", () => {
    const result = runHarness("incompatible-update");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("currently available only on Windows");
    expect(result.confirmation).toBeNull();
    expect(result.requests).toHaveLength(2);
    expect(result.marker).toBeNull();
  });
});
