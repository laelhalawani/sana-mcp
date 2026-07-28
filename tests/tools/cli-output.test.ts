import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURE = path.join(ROOT, "tests/fixtures/cli-output-dispatch.ts");
const CLI_PROCESS_TIMEOUT_MS = 10_000;
let temporaryRoot = "";
let cli = "";

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sana-cli-output-"));
  fs.mkdirSync(path.join(temporaryRoot, "tmp"));
  cli = path.join(temporaryRoot, "cli.js");
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "src/cli.ts")],
    outfile: cli,
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "isolated-human-command",
        setup(build) {
          build.onResolve(
            { filter: /\/app\/commands\.js$/u },
            () => ({ path: FIXTURE }),
          );
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(
      result.logs,
      "could not build the isolated human CLI",
    );
  if (result.outputs.length !== 1 || !result.outputs[0])
    throw new Error(
      `isolated human CLI build emitted ${result.outputs.length} outputs`,
    );
  await Bun.write(cli, result.outputs[0]);
});

afterAll(() => {
  if (temporaryRoot)
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function run(tool: string, json?: string): ReturnType<typeof spawnSync> {
  const result = spawnSync(
    process.execPath,
    [cli, tool, ...(json ? [json] : [])],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        HOME: temporaryRoot,
        USERPROFILE: temporaryRoot,
        XDG_CONFIG_HOME: path.join(temporaryRoot, ".config"),
        XDG_DATA_HOME: path.join(temporaryRoot, ".local", "share"),
        XDG_CACHE_HOME: path.join(temporaryRoot, ".cache"),
        APPDATA: path.join(temporaryRoot, "appdata"),
        LOCALAPPDATA: path.join(temporaryRoot, "localappdata"),
        TMP: path.join(temporaryRoot, "tmp"),
        TEMP: path.join(temporaryRoot, "tmp"),
        TMPDIR: path.join(temporaryRoot, "tmp"),
        PATH: path.dirname(process.execPath),
        SANA_DATA_DIR: path.join(temporaryRoot, "data"),
        SANA_TRANSCRIPTS_DIR: path.join(temporaryRoot, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  return result;
}

const sanitizedOutputs = {
  list: "# Meetings\n\n| title |\n|---|\n| Red title |\n",
  read: "# Meeting\n\n[00:01] Speaker: transcript\n",
  summary: "# Summary\n\n- Note hidden\n",
  participants:
    "| name | email |\n|---|---|\n| Participant | person@example.test |\n",
  search:
    "| meeting | snippet |\n|---|---|\n| Search title | result |\n",
} as const;

for (const [tool, expected] of Object.entries(sanitizedOutputs)) {
  test(`one-shot ${tool} output neutralizes terminal controls and bidi text`, () => {
    const result = run(tool);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected);
    expect(result.stdout).not.toMatch(/[\u001b\u0007\u202e]/u);
  });
}

test("one-shot CLI preserves ordinary multiline output and blank lines", () => {
  const result = run("ordinary");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("First\tline\n\nSecond line\n");
});

test("one-shot CLI drains a multi-megabyte sanitized result before success", () => {
  const result = run("large");
  const expected = `${"L".repeat(4 * 1024 * 1024)}\n`;
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.length).toBe(expected.length);
  expect(result.stdout).toBe(expected);
});

test("invalid JSON drains its error and exits nonzero without dispatch", () => {
  const result = run("list", "{");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Invalid JSON args: expected one JSON object.\n",
  );
});

for (const value of ["null", "[]", "42", '"text"']) {
  test(`JSON args reject non-object value ${value}`, () => {
    const result = run("list", value);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Invalid JSON args: expected one JSON object.\n",
    );
  });
}

test("one-shot flags preserve page, limit, and timestamp semantics", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "args", "--page", "2", "--limit", "5", "--no-timestamps"],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        HOME: temporaryRoot,
        USERPROFILE: temporaryRoot,
        XDG_CONFIG_HOME: path.join(temporaryRoot, ".config"),
        XDG_DATA_HOME: path.join(temporaryRoot, ".local", "share"),
        XDG_CACHE_HOME: path.join(temporaryRoot, ".cache"),
        APPDATA: path.join(temporaryRoot, "appdata"),
        LOCALAPPDATA: path.join(temporaryRoot, "localappdata"),
        TMP: path.join(temporaryRoot, "tmp"),
        TEMP: path.join(temporaryRoot, "tmp"),
        TMPDIR: path.join(temporaryRoot, "tmp"),
        PATH: path.dirname(process.execPath),
        SANA_DATA_DIR: path.join(temporaryRoot, "data"),
        SANA_TRANSCRIPTS_DIR: path.join(temporaryRoot, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    page: 2,
    limit: 5,
    timestamps: false,
  });
});

test("one-shot JSON preserves the login code alias", () => {
  const result = run("args", '{"email":"person@example.test","code":"123456"}');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    email: "person@example.test",
    code: "123456",
  });
});

test("one-shot CLI sanitizes thrown errors without changing failure status", () => {
  const result = run("error");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Remote error detail\n");
  expect(result.stderr).not.toContain(temporaryRoot);
  expect(result.stderr).not.toMatch(/[\u001b\u0007\u202e]/u);
});
