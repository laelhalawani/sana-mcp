import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  assembleRelease,
  createAttestation,
  sha256File,
} from "../../scripts/release.js";
import {
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  releaseAssetName,
  releaseMetadataFileName,
} from "../../src/release/contract.js";
import { parseReleaseManifestJson } from "../../src/install/manifest.js";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const linuxOnlyTest = process.platform === "linux" ? test : test.skip;

async function makeArtifacts(directory: string): Promise<void> {
  for (const target of RELEASE_TARGETS) {
    const assetName = releaseAssetName(target);
    const artifact = path.join(directory, assetName);
    await writeFile(artifact, `executed artifact fixture for ${target}\n`);
    const inspectJson = JSON.stringify({
      mode: "standalone",
      standalone: true,
      version: packageMetadata.version,
      target,
      ...SUPPORTED_RELEASE_PROTOCOLS,
      semanticCapability: STANDALONE_SEMANTIC_CAPABILITY,
    });
    const attestation = await createAttestation({
      target,
      artifact,
      inspectJson,
      sourceCommit,
    });
    await writeFile(
      path.join(directory, `attestation-${target}.json`),
      `${JSON.stringify(attestation)}\n`,
    );
  }
}

test("assembles one complete manifest-bound release tuple", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-release-test-"));
  const artifacts = path.join(temporary, "artifacts");
  const output = path.join(temporary, "output");
  try {
    await mkdir(artifacts);
    await makeArtifacts(artifacts);
    const manifest = await assembleRelease({
      releaseTag: `v${packageMetadata.version}`,
      sourceCommit,
      artifactsDirectory: artifacts,
      outputDirectory: output,
      repositoryRoot: process.cwd(),
    });

    assert.deepEqual(
      manifest.assets.map((asset) => asset.target),
      RELEASE_TARGETS,
    );
    const diskManifest = parseReleaseManifestJson(
      await readFile(path.join(output, "manifest.json"), "utf8"),
    );
    assert.deepEqual(diskManifest, manifest);

    const manifestSha256 = await sha256File(path.join(output, "manifest.json"));
    for (const asset of manifest.assets) {
      const properties = await readFile(
        path.join(output, releaseMetadataFileName(asset.target)),
        "utf8",
      );
      assert.match(properties, /^format=sana-mcp-release-v1$/m);
      assert.match(properties, new RegExp(`^manifestSha256=${manifestSha256}$`, "m"));
      assert.match(properties, new RegExp(`^sourceCommit=${sourceCommit}$`, "m"));
      assert.match(properties, new RegExp(`^target=${asset.target}$`, "m"));
      assert.match(properties, new RegExp(`^assetName=${asset.assetName}$`, "m"));
      assert.equal(
        await sha256File(path.join(output, asset.assetName)),
        asset.sha256,
      );
    }

    assert.deepEqual(
      (await readdir(output)).sort(),
      [
        "install.ps1",
        "install.sh",
        "manifest.json",
        "manifest.json.sha256",
        "manifest.schema.json",
        ...manifest.assets.flatMap((asset) => [
          asset.assetName,
          asset.checksumFileName,
          releaseMetadataFileName(asset.target),
          `${releaseMetadataFileName(asset.target)}.sha256`,
        ]),
      ].sort(),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects stale artifacts, incomplete matrices, and mismatched tags", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-release-test-"));
  const artifacts = path.join(temporary, "artifacts");
  try {
    await mkdir(artifacts);
    await makeArtifacts(artifacts);

    const firstTarget = RELEASE_TARGETS[0];
    await writeFile(
      path.join(artifacts, releaseAssetName(firstTarget)),
      "changed after attestation\n",
    );
    await assert.rejects(
      assembleRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "tampered"),
      }),
      /changed after execution evidence/,
    );

    await assert.rejects(
      assembleRelease({
        releaseTag: "v999.0.0",
        sourceCommit,
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "wrong-tag"),
      }),
      /must exactly equal package version/,
    );
    await assert.rejects(
      assembleRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit: "not-a-full-commit",
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "invalid-commit"),
      }),
      /full Git commit SHA/,
    );

    await makeArtifacts(artifacts);
    const mismatchedAttestationPath = path.join(
      artifacts,
      `attestation-${RELEASE_TARGETS[1]}.json`,
    );
    const mismatchedAttestation = JSON.parse(
      await readFile(mismatchedAttestationPath, "utf8"),
    ) as Record<string, unknown>;
    mismatchedAttestation.sourceCommit = "f".repeat(40);
    await writeFile(
      mismatchedAttestationPath,
      `${JSON.stringify(mismatchedAttestation)}\n`,
    );
    await assert.rejects(
      assembleRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "wrong-commit"),
      }),
      /source commit mismatch/,
    );

    await makeArtifacts(artifacts);
    await rm(path.join(artifacts, `attestation-${RELEASE_TARGETS[1]}.json`));
    await assert.rejects(
      assembleRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "incomplete"),
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release workflow binds every build and publish step to the authorized commit", async () => {
  const workflow = await readFile(
    path.join(process.cwd(), ".github/workflows/release.yml"),
    "utf8",
  );
  const actionUses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)];
  assert.ok(actionUses.length > 0);
  for (const action of actionUses) {
    assert.match(action[1] ?? "", /^[a-f0-9]{40}$/);
  }
  assert.match(workflow, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(workflow, /sha: \$\{\{ steps\.verify\.outputs\.sha \}\}/);
  assert.ok(
    (
      workflow.match(
        /ref: \$\{\{ needs\.authorize\.outputs\.sha \}\}/g,
      ) ?? []
    ).length >= 4,
  );
  assert.ok(
    (
      workflow.match(
        /--commit-sha (?:["']?\$SOURCE_SHA["']?|\$env:SOURCE_SHA)/g,
      ) ?? []
    ).length >= 4,
  );
  assert.match(
    workflow,
    /git fetch --no-tags origin "refs\/tags\/\$RELEASE_TAG"/,
  );
  assert.match(
    workflow,
    /test "\$\(git rev-parse FETCH_HEAD\^\{commit\}\)" = "\$SOURCE_SHA"/,
  );
  assert.match(
    workflow,
    /alpine:3\.22@sha256:[a-f0-9]{64}/,
  );
  assert.match(workflow, /-v "\$PWD:\/work:ro"/);
  assert.match(workflow, /--target "\$SOURCE_SHA"/);
  assert.match(workflow, /Existing release targets a different source commit/);
  assert.match(workflow, /tag_without_build="\$\{RELEASE_TAG%%\+\*\}"/);
  assert.match(workflow, /Existing release title does not match/);
  assert.match(workflow, /prerelease classification is incorrect/);
  assert.match(workflow, /verify_remote_assets false/);
  assert.match(workflow, /missing_assets\+=\("release-assets\/\$asset"\)/);
  assert.match(
    workflow,
    /gh release upload "\$RELEASE_TAG" "\$\{missing_assets\[@\]\}"/,
  );
  assert.match(workflow, /verify_remote_assets true/);
  assert.match(workflow, /cmp -s "release-assets\/\$asset"/);
  assert.match(workflow, /already published with the authorized tuple/);
});

linuxOnlyTest("release publication resumes only a matching draft and re-verifies every asset", async () => {
  const workflow = YAML.parse(
    await readFile(
      path.join(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    ),
  ) as {
    jobs: {
      publish: {
        steps: Array<{ name?: string; run?: string }>;
      };
    };
  };
  const publishScript = workflow.jobs.publish.steps.find(
    (step) => step.name === "Publish the immutable tuple",
  )?.run;
  assert.ok(publishScript);

  for (const remoteMatches of [true, false]) {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "sana-publish-resume-"),
    );
    try {
      const commands = path.join(temporary, "commands");
      const localAssets = path.join(temporary, "release-assets");
      const remoteAssets = path.join(temporary, "remote-assets");
      const stateFile = path.join(temporary, "release-state.json");
      await mkdir(commands);
      await mkdir(localAssets);
      await mkdir(remoteAssets);
      await writeFile(path.join(localAssets, "a.bin"), "authorized-a\n");
      await writeFile(path.join(localAssets, "b.sha256"), "authorized-b\n");
      await writeFile(
        path.join(remoteAssets, "a.bin"),
        remoteMatches ? "authorized-a\n" : "different-a\n",
      );
      await writeFile(
        stateFile,
        JSON.stringify({
          exists: true,
          draft: true,
          tag: `v${packageMetadata.version}`,
          target: sourceCommit,
          title: `v${packageMetadata.version}`,
          prerelease: false,
        }),
      );

      const fakeGit = [
        "#!/bin/sh",
        'case "$1" in',
        "  fetch) exit 0 ;;",
        '  rev-parse) printf "%s\\n" "$SOURCE_SHA"; exit 0 ;;',
        "  *) exit 64 ;;",
        "esac",
        "",
      ].join("\n");
      const fakeGh = [
        "#!/usr/bin/env bun",
        'import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "const args = process.argv.slice(2);",
        "const stateFile = process.env.FAKE_RELEASE_STATE;",
        "const assetsDir = process.env.FAKE_RELEASE_ASSETS;",
        "if (!stateFile || !assetsDir) process.exit(70);",
        "const load = () => JSON.parse(readFileSync(stateFile, 'utf8'));",
        "const save = (state) => writeFileSync(stateFile, JSON.stringify(state));",
        "if (args[0] === 'api') {",
        "  const state = load();",
        "  if (!state.exists) { console.error('HTTP 404: Not Found'); process.exit(1); }",
        "  process.stdout.write(JSON.stringify({",
        "    tag_name: state.tag,",
        "    target_commitish: state.target,",
        "    draft: state.draft,",
        "    name: state.title,",
        "    prerelease: state.prerelease,",
        "    assets: readdirSync(assetsDir).map((name) => ({ name })),",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] !== 'release') process.exit(64);",
        "if (args[1] === 'download') {",
        "  const pattern = args[args.indexOf('--pattern') + 1];",
        "  const directory = args[args.indexOf('--dir') + 1];",
        "  copyFileSync(path.join(assetsDir, pattern), path.join(directory, pattern));",
        "  process.exit(0);",
        "}",
        "if (args[1] === 'upload') {",
        "  for (const file of args.slice(3)) copyFileSync(file, path.join(assetsDir, path.basename(file)));",
        "  process.exit(0);",
        "}",
        "if (args[1] === 'edit') {",
        "  const state = load(); state.draft = false; save(state); process.exit(0);",
        "}",
        "if (args[1] === 'create') {",
        "  const state = load();",
        "  state.exists = true; state.draft = true; state.tag = args[2];",
        "  state.target = args[args.indexOf('--target') + 1];",
        "  state.title = args[args.indexOf('--title') + 1];",
        "  state.prerelease = args.includes('--prerelease'); save(state); process.exit(0);",
        "}",
        "process.exit(64);",
        "",
      ].join("\n");
      await writeFile(path.join(commands, "git"), fakeGit);
      await writeFile(path.join(commands, "gh"), fakeGh);
      await chmod(path.join(commands, "git"), 0o755);
      await chmod(path.join(commands, "gh"), 0o755);

      const execute = (
        releaseTag = `v${packageMetadata.version}`,
      ) =>
        spawnSync("/bin/bash", ["-c", publishScript], {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${commands}:${process.env.PATH ?? ""}`,
            RELEASE_TAG: releaseTag,
            SOURCE_SHA: sourceCommit,
            GITHUB_REPOSITORY: "example/sana-mcp",
            FAKE_RELEASE_STATE: stateFile,
            FAKE_RELEASE_ASSETS: remoteAssets,
          },
        });
      const result = execute();
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        draft: boolean;
      };
      if (remoteMatches) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(state.draft, false);
        assert.equal(
          await readFile(path.join(remoteAssets, "b.sha256"), "utf8"),
          "authorized-b\n",
        );
        const rerun = execute();
        assert.equal(rerun.status, 0, rerun.stderr);
        assert.match(rerun.stdout, /already published with the authorized tuple/);

        const buildMetadataTag = `v${packageMetadata.version}+build-x`;
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: false,
            tag: buildMetadataTag,
            target: sourceCommit,
            title: buildMetadataTag,
            prerelease: false,
          }),
        );
        const buildMetadataRerun = execute(buildMetadataTag);
        assert.equal(
          buildMetadataRerun.status,
          0,
          buildMetadataRerun.stderr,
        );

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            target: sourceCommit,
            title: "wrong title",
            prerelease: false,
          }),
        );
        const wrongTitle = execute();
        assert.notEqual(wrongTitle.status, 0);
        assert.match(wrongTitle.stderr, /title does not match/);

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            target: sourceCommit,
            title: `v${packageMetadata.version}`,
            prerelease: true,
          }),
        );
        const wrongClassification = execute();
        assert.notEqual(wrongClassification.status, 0);
        assert.match(
          wrongClassification.stderr,
          /prerelease classification is incorrect/,
        );
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(state.draft, true);
        assert.match(result.stderr, /differs from the authorized tuple/);
        await assert.rejects(
          readFile(path.join(remoteAssets, "b.sha256")),
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
