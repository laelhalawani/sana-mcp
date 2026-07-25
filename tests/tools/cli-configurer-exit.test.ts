import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_CLI = path.join(ROOT, "src", "cli.ts");
const BACKPRESSURE_FIXTURE = path.join(
  ROOT,
  "tests",
  "fixtures",
  "cli-configurer-backpressure.ts",
);
const LARGE_OUTPUT_BYTES = 4 * 1024 * 1024;
let suiteRoot = "";
let standaloneCli = "";
let backpressureCli = "";

function copyHostVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = process.env[name];
  if (value !== undefined) environment[name] = value;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const temporary = path.join(root, "tmp");
  const emptyPath = path.join(root, "empty-path");
  fs.mkdirSync(temporary, { recursive: true });
  fs.mkdirSync(emptyPath, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    PATH: emptyPath,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    NO_COLOR: "1",
    CI: "1",
    SANA_DATA_DIR: path.join(root, "data"),
    SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
    SANA_SEMANTIC: "0",
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec"]) {
    copyHostVariable(environment, name);
  }
  return environment;
}

function run(
  root: string,
  args: readonly string[],
  cli = SOURCE_CLI,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: isolatedEnvironment(root),
    maxBuffer: 16 * 1024 * 1024,
  });
}

beforeAll(async () => {
  suiteRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-cli-configurer-exit-"),
  );
  standaloneCli = path.join(suiteRoot, "standalone-cli.js");
  const result = await Bun.build({
    entrypoints: [SOURCE_CLI],
    outfile: standaloneCli,
    target: "bun",
    format: "esm",
    define: {
      __SANA_BUILD_STANDALONE__: "true",
      __SANA_BUILD_VERSION__: JSON.stringify(packageMetadata.version),
      __SANA_BUILD_TARGET__: JSON.stringify("bun-linux-x64"),
      __SANA_INSTALLER_PROTOCOL__: "1",
      __SANA_LIFECYCLE_PROTOCOL__: "1",
      __SANA_INSPECT_PROTOCOL__: "1",
      __SANA_SEMANTIC_CAPABILITY__: JSON.stringify("keyword"),
    },
  });
  if (!result.success)
    throw new AggregateError(
      result.logs,
      "could not build the isolated standalone CLI",
    );
  if (result.outputs.length !== 1 || !result.outputs[0])
    throw new Error(
      `isolated standalone CLI build emitted ${result.outputs.length} outputs`,
    );
  await Bun.write(standaloneCli, result.outputs[0]);

  backpressureCli = path.join(suiteRoot, "backpressure-cli.js");
  const backpressure = await Bun.build({
    entrypoints: [SOURCE_CLI],
    outfile: backpressureCli,
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "isolated-configurer-backpressure",
        setup(build) {
          build.onResolve(
            { filter: /\/install\/install\.js$/u },
            () => ({ path: BACKPRESSURE_FIXTURE }),
          );
        },
      },
    ],
  });
  if (!backpressure.success)
    throw new AggregateError(
      backpressure.logs,
      "could not build the backpressure CLI",
    );
  if (backpressure.outputs.length !== 1 || !backpressure.outputs[0])
    throw new Error(
      `backpressure CLI build emitted ${backpressure.outputs.length} outputs`,
    );
  await Bun.write(backpressureCli, backpressure.outputs[0]);
});

afterAll(() => {
  if (suiteRoot)
    fs.rmSync(suiteRoot, { recursive: true, force: true });
});

test("non-TTY bare invocation prints guidance while explicit install remains actionable", () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "install-"));
  const cursorDirectory = path.join(root, ".cursor");
  const config = path.join(cursorDirectory, "mcp.json");
  fs.mkdirSync(cursorDirectory);

  const bare = run(root, []);
  expect(bare.status, bare.stderr).toBe(0);
  expect(bare.stderr).toBe("");
  expect(bare.stdout).toBe(
    [
      "Run sana-mcp in a terminal to configure Sana and your AI clients.",
      "For one-shot commands, run: sana-mcp help",
      "",
    ].join("\n"),
  );

  for (const command of ["install", "config", "configure"]) {
    const install = run(root, [command]);
    expect(install.status, `${command}: ${install.stderr}`).toBe(1);
    expect(install.stderr).toBe("");
    expect(install.stdout).toContain(
      "An interactive terminal is required to choose clients.",
    );
  }
  expect(fs.existsSync(config)).toBe(false);
});

test("non-TTY uninstall with an owned registration exits nonzero without mutation", () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "uninstall-"));
  const cursorDirectory = path.join(root, ".cursor");
  const config = path.join(cursorDirectory, "mcp.json");
  fs.mkdirSync(cursorDirectory);
  const original = `${JSON.stringify({
    mcpServers: {
      "sana-mcp": {
        command: process.execPath,
        args: [path.join(ROOT, "src", "mcp.ts")],
      },
    },
  })}\n`;
  fs.writeFileSync(config, original);

  const result = run(root, ["uninstall"]);

  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    "An interactive terminal is required to choose clients.",
  );
  expect(fs.readFileSync(config, "utf8")).toBe(original);
});

test("successful no-client install and direct tool paths remain successful", () => {
  const installRoot = fs.mkdtempSync(path.join(suiteRoot, "success-install-"));
  const install = run(installRoot, ["install", "--yes"]);
  expect(install.status, install.stderr).toBe(0);
  expect(install.stderr).toBe("");
  expect(install.stdout).toContain("No supported AI clients detected.");

  const directRoot = fs.mkdtempSync(path.join(suiteRoot, "success-direct-"));
  const direct = run(directRoot, ["unknown-tool"]);
  expect(direct.status).toBe(1);
  expect(direct.stdout).toBe("");
  expect(direct.stderr).toContain('Unknown command "unknown-tool".');
  expect(direct.stderr).toContain("sana-mcp commands:");
  expect(direct.stderr).not.toContain("meeting_transcripts(");

  const help = run(directRoot, ["help"]);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain("sana-mcp commands:");
  expect(help.stdout).not.toContain("meeting_transcripts(");

  const listHelp = run(directRoot, ["help", "list"]);
  expect(listHelp.status, listHelp.stderr).toBe(0);
  expect(listHelp.stderr).toBe("");
  expect(listHelp.stdout).toContain("Usage for list:");
  expect(listHelp.stdout).toContain("sana-mcp list");
  expect(listHelp.stdout).toContain("--page <n>");
  expect(listHelp.stdout).not.toContain("meeting_transcripts(");
});

test("dry-run planned outcomes remain successful without mutation", () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "planned-install-"));
  const cursorDirectory = path.join(root, ".cursor");
  const config = path.join(cursorDirectory, "mcp.json");
  fs.mkdirSync(cursorDirectory);

  const result = run(root, ["install", "--dry-run", "--yes"]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Dry run complete.");
  expect(fs.existsSync(config)).toBe(false);
});

test("redirected configurer output drains fully before nonzero exit", () => {
  for (const [args, marker] of [
    [["install"], "I"],
    [["uninstall"], "U"],
  ] as const) {
    const root = fs.mkdtempSync(path.join(suiteRoot, "backpressure-"));
    const result = run(root, args, backpressureCli);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBe(LARGE_OUTPUT_BYTES);
    expect(result.stdout).toBe(marker.repeat(LARGE_OUTPUT_BYTES));
  }
});

test("standalone inspect protocol stdout remains exact", () => {
  const root = fs.mkdtempSync(path.join(suiteRoot, "inspect-"));
  const result = run(root, ["__inspect"], standaloneCli);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    `${JSON.stringify({
      mode: "standalone",
      standalone: true,
      version: packageMetadata.version,
      target: "bun-linux-x64",
      installerProtocol: 1,
      lifecycleProtocol: 1,
      inspectProtocol: 1,
      semanticCapability: "keyword",
    })}\n`,
  );
});
