import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "../..");

function isolatedEnvironment(
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
  };
  delete environment.SANA_DATA_DIR;
  delete environment.SANA_TRANSCRIPTS_DIR;
  Object.assign(environment, additions);
  return environment;
}

test("standalone store startup rejects relative HOME before filesystem mutation", async () => {
  if (process.platform !== "linux") return;
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-home-store-"),
  );
  try {
    const outputDirectory = path.join(temporary, "bundle");
    const standaloneDefines = {
      __SANA_BUILD_STANDALONE__: "true",
      __SANA_BUILD_VERSION__: JSON.stringify(packageMetadata.version),
      __SANA_BUILD_TARGET__: JSON.stringify("bun-linux-x64"),
      __SANA_INSTALLER_PROTOCOL__: "1",
      __SANA_LIFECYCLE_PROTOCOL__: "1",
      __SANA_INSPECT_PROTOCOL__: "1",
      __SANA_STATE_COMPATIBILITY__: "1",
      __SANA_SEMANTIC_CAPABILITY__: JSON.stringify("bundled"),
    };
    const build = await Bun.build({
      entrypoints: [
        path.join(root, "tests/fixtures/runtime/home-store-probe.ts"),
      ],
      outdir: outputDirectory,
      target: "bun",
      format: "esm",
      define: standaloneDefines,
    });
    expect(build.success).toBe(true);
    const bundle = path.join(outputDirectory, "home-store-probe.js");
    const cli = path.join(outputDirectory, "cli.js");
    const cliBuild = await Bun.build({
      entrypoints: [path.join(root, "src/cli.ts")],
      outfile: cli,
      target: "bun",
      format: "esm",
      define: standaloneDefines,
    });
    expect(cliBuild.success).toBe(true);
    expect(cliBuild.outputs).toHaveLength(1);
    await Bun.write(cli, cliBuild.outputs[0]!);
    const runDirectory = path.join(temporary, "run");
    fs.mkdirSync(runDirectory);

    const imported = spawnSync(process.execPath, [bundle, "import-only"], {
      cwd: runDirectory,
      encoding: "utf8",
      env: isolatedEnvironment({ HOME: "relative-home" }),
    });
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout.trim())).toEqual({ kind: "imported" });

    for (const args of [
      ["--help"],
      ["--version"],
      ["__inspect", "--format", "properties"],
    ]) {
      const metadata = spawnSync(process.execPath, [cli, ...args], {
        cwd: runDirectory,
        encoding: "utf8",
        env: isolatedEnvironment({ HOME: "relative-home" }),
      });
      expect(metadata.status, `${args.join(" ")}: ${metadata.stderr}`).toBe(0);
    }
    expect(fs.readdirSync(runDirectory)).toEqual([]);

    const invalid = spawnSync(process.execPath, [bundle], {
      cwd: runDirectory,
      encoding: "utf8",
      env: isolatedEnvironment({ HOME: "relative-home" }),
    });
    expect(invalid.status).toBe(73);
    const failure = JSON.parse(invalid.stdout.trim()) as {
      kind: string;
      code: string;
      message: string;
    };
    expect(failure).toMatchObject({
      kind: "error",
      code: "HOME_DIRECTORY_UNAVAILABLE",
    });
    expect(failure.message).toContain("HOME must be an absolute POSIX path");
    expect(failure.message).toContain("explicit absolute application data path");
    expect(fs.existsSync(path.join(runDirectory, "relative-home"))).toBe(false);
    expect(fs.existsSync(path.join(runDirectory, ".sana-mcp"))).toBe(false);
    expect(fs.readdirSync(runDirectory)).toEqual([]);

    const invalidExplicit = spawnSync(process.execPath, [bundle], {
      cwd: runDirectory,
      encoding: "utf8",
      env: isolatedEnvironment({
        HOME: temporary,
        SANA_DATA_DIR: "relative-data",
      }),
    });
    expect(invalidExplicit.status).toBe(73);
    expect(JSON.parse(invalidExplicit.stdout.trim())).toMatchObject({
      kind: "error",
      code: "INVALID_ENVIRONMENT",
    });
    expect(fs.readdirSync(runDirectory)).toEqual([]);

    const explicitData = path.join(runDirectory, "explicit-data");
    const explicitTranscripts = path.join(
      runDirectory,
      "explicit-transcripts",
    );
    const valid = spawnSync(process.execPath, [bundle], {
      cwd: runDirectory,
      encoding: "utf8",
      env: isolatedEnvironment({
        HOME: "relative-home",
        SANA_DATA_DIR: explicitData,
        SANA_TRANSCRIPTS_DIR: explicitTranscripts,
      }),
    });
    expect(valid.status, valid.stderr).toBe(0);
    const success = JSON.parse(valid.stdout.trim()) as {
      kind: string;
      dataDir: string;
      dbFile: string;
    };
    expect(success).toEqual({
      kind: "ready",
      dataDir: explicitData,
      dbFile: path.join(explicitData, "sana.db"),
    });
    expect(fs.existsSync(path.join(explicitData, "sana.db"))).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, "relative-home"))).toBe(false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
