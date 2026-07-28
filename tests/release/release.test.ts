import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
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
  uploadReleaseAsset,
  verifyAssembledRelease,
} from "../../scripts/release.js";
import {
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  releaseAssetName,
  releaseMetadataFileName,
} from "../../src/release/contract.js";
import { parseReleaseManifestJson } from "../../src/install/manifest.js";
import type { ReleaseAsset } from "../../src/install/manifest.js";
import { standaloneSemanticSmokeEvidence } from "../../src/semantic/smoke-contract.js";

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
      semanticSmokeJson: JSON.stringify(
        standaloneSemanticSmokeEvidence(
          target.startsWith("bun-darwin-") || target.endsWith("-musl")
            ? "portable"
            : "sqlite-vec",
        ),
      ),
      sourceCommit,
      executedSha256: await sha256File(artifact),
    });
    await writeFile(
      path.join(directory, `attestation-${target}.json`),
      `${JSON.stringify(attestation)}\n`,
    );
  }
}

test("attestation requires the exact digest acquired around execution", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-attestation-test-"));
  const target = "bun-linux-x64";
  const artifact = path.join(temporary, releaseAssetName(target));
  const inspectJson = JSON.stringify({
    mode: "standalone",
    standalone: true,
    version: packageMetadata.version,
    target,
    ...SUPPORTED_RELEASE_PROTOCOLS,
    semanticCapability: STANDALONE_SEMANTIC_CAPABILITY,
  });
  try {
    await writeFile(artifact, "bytes that were executed\n");
    const executedSha256 = await sha256File(artifact);
    const attestation = await createAttestation({
      target,
      artifact,
      inspectJson,
      semanticSmokeJson: JSON.stringify(standaloneSemanticSmokeEvidence()),
      sourceCommit,
      executedSha256,
    });
    assert.equal(attestation.sha256, executedSha256);
    assert.equal(attestation.semanticSmoke.target, target);
    assert.equal(attestation.semanticSmoke.executedSha256, executedSha256);
    await assert.rejects(
      createAttestation({
        target,
        artifact,
        inspectJson,
        semanticSmokeJson: JSON.stringify({
          ...standaloneSemanticSmokeEvidence(),
          revision: "f".repeat(40),
        }),
        sourceCommit,
        executedSha256,
      }),
      /semantic smoke output is invalid/,
    );
    await assert.rejects(
      createAttestation({
        target,
        artifact,
        inspectJson,
        semanticSmokeJson: JSON.stringify(
          standaloneSemanticSmokeEvidence("portable"),
        ),
        sourceCommit,
        executedSha256,
      }),
      /semantic smoke backend does not match release target/,
    );

    await writeFile(artifact, "bytes replaced after execution\n");
    await assert.rejects(
      createAttestation({
        target,
        artifact,
        inspectJson,
        semanticSmokeJson: JSON.stringify(standaloneSemanticSmokeEvidence()),
        sourceCommit,
        executedSha256,
      }),
      /do not match the digest acquired around execution/,
    );
    await assert.rejects(
      createAttestation({
        target,
        artifact,
        inspectJson,
        semanticSmokeJson: JSON.stringify(standaloneSemanticSmokeEvidence()),
        sourceCommit,
        executedSha256: "not-a-digest",
      }),
      /executed artifact SHA-256 is invalid/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

linuxOnlyTest("Linux execution descriptor stays bound across a path swap", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sana-execution-fd-"));
  const snapshot = path.join(temporary, "artifact");
  try {
    await chmod(temporary, 0o700);
    await copyFile("/bin/sh", snapshot);
    await chmod(snapshot, 0o500);
    const result = spawnSync(
      "bash",
      [
        "-eu",
        "-c",
        [
          'exec 9<"$1"',
          'before="$(sha256sum /proc/self/fd/9 | awk \'{print $1}\')"',
          'cp "$2" "$1.replacement"',
          'chmod 500 "$1.replacement"',
          'mv "$1.replacement" "$1"',
          'observed="$(/proc/self/fd/9 -c \'printf pinned\')"',
          'after="$(sha256sum /proc/self/fd/9 | awk \'{print $1}\')"',
          'test "$observed" = pinned',
          'test "$after" = "$before"',
          'test "$(sha256sum "$1" | awk \'{print $1}\')" != "$before"',
        ].join("\n"),
        "descriptor-test",
        snapshot,
        "/bin/false",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await chmod(temporary, 0o700);
    await rm(temporary, { recursive: true, force: true });
  }
});

linuxOnlyTest(
  "release upload reads the stable descriptor and binds the authoritative asset name",
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "sana-release-upload-fd-"),
    );
    const asset = path.join(temporary, "asset.bin");
    const authorizedBytes = Buffer.from("authorized upload bytes\n");
    let descriptor: number | undefined;
    try {
      await writeFile(asset, authorizedBytes);
      descriptor = openSync(asset, "r");
      await writeFile(`${asset}.replacement`, "attacker path bytes\n");
      await rename(`${asset}.replacement`, asset);
      const expectedSha256 = createHash("sha256")
        .update(authorizedBytes)
        .digest("hex");
      let observedUrl = "";
      let observedBody = Buffer.alloc(0);
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        observedUrl = String(input);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer test-token");
        assert.equal(
          headers.get("content-type"),
          "application/octet-stream",
        );
        const body = init?.body;
        assert.ok(ArrayBuffer.isView(body));
        observedBody = Buffer.from(
          body.buffer,
          body.byteOffset,
          body.byteLength,
        );
        return new Response(
          JSON.stringify({
            name: "asset.bin",
            state: "uploaded",
            size: authorizedBytes.byteLength,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      await uploadReleaseAsset(
        {
          releaseJson: JSON.stringify({
            id: 4242,
            upload_url:
              "https://uploads.github.test/repos/example/sana-mcp/releases/4242/assets{?name,label}",
          }),
          repository: "example/sana-mcp",
          assetName: "asset.bin",
          descriptor,
          expectedSha256,
          expectedUploadOrigin: "https://uploads.github.test",
          authToken: "test-token",
        },
        fetchImpl,
      );
      assert.equal(
        observedUrl,
        "https://uploads.github.test/repos/example/sana-mcp/releases/4242/assets?name=asset.bin",
      );
      assert.deepEqual(observedBody, authorizedBytes);
      assert.notDeepEqual(await readFile(asset), authorizedBytes);

      for (const repository of ["../sana-mcp", "example/.."]) {
        await assert.rejects(
          uploadReleaseAsset(
            {
              releaseJson: JSON.stringify({
                id: 4242,
                upload_url:
                  `https://uploads.github.test/repos/${repository}` +
                  "/releases/4242/assets{?name,label}",
              }),
              repository,
              assetName: "asset.bin",
              descriptor,
              expectedSha256,
              expectedUploadOrigin: "https://uploads.github.test",
              authToken: "test-token",
            },
            fetchImpl,
          ),
          /release upload repository is invalid/,
        );
      }
      await assert.rejects(
        uploadReleaseAsset(
          {
            releaseJson: JSON.stringify({
              id: 4242,
              upload_url:
                "https://uploads.github.test/repos/other/repo/releases/4242/assets{?name,label}",
            }),
            repository: "example/sana-mcp",
            assetName: "asset.bin",
            descriptor,
            expectedSha256,
            expectedUploadOrigin: "https://uploads.github.test",
            authToken: "test-token",
          },
          fetchImpl,
        ),
        /not the exact expected origin, repository, release id, and raw path/,
      );
      for (const uploadUrl of [
        "https://sub.uploads.github.test/repos/example/sana-mcp/releases/4242/assets{?name,label}",
        "https://user@uploads.github.test/repos/example/sana-mcp/releases/4242/assets{?name,label}",
        "https://uploads.github.test:443/repos/example/sana-mcp/releases/4242/assets{?name,label}",
        "https://uploads.github.test/repos/%65xample/sana-mcp/releases/4242/assets{?name,label}",
        "https://uploads.github.test/repos/example/sana-mcp/releases/4242/assets?unexpected=1{?name,label}",
        "https://uploads.github.test/repos/example/sana-mcp/releases/4242/assets#fragment{?name,label}",
      ]) {
        await assert.rejects(
          uploadReleaseAsset(
            {
              releaseJson: JSON.stringify({
                id: 4242,
                upload_url: uploadUrl,
              }),
              repository: "example/sana-mcp",
              assetName: "asset.bin",
              descriptor,
              expectedSha256,
              expectedUploadOrigin: "https://uploads.github.test",
              authToken: "test-token",
            },
            fetchImpl,
          ),
          /not the exact expected origin, repository, release id, and raw path/,
        );
      }
      for (const expectedUploadOrigin of [
        "https://uploads.github.test:443",
        "https://user@uploads.github.test",
        "https://uploads.github.test/path",
        "https://uploads.github.test?query=1",
        "https://uploads.github.test#fragment",
      ]) {
        await assert.rejects(
          uploadReleaseAsset(
            {
              releaseJson: JSON.stringify({
                id: 4242,
                upload_url:
                  "https://uploads.github.test/repos/example/sana-mcp/releases/4242/assets{?name,label}",
              }),
              repository: "example/sana-mcp",
              assetName: "asset.bin",
              descriptor,
              expectedSha256,
              expectedUploadOrigin,
              authToken: "test-token",
            },
            fetchImpl,
          ),
          /origin authority is not an exact HTTPS origin/,
        );
      }
      let invalidEndpointReachedNetwork = false;
      await assert.rejects(
        uploadReleaseAsset(
          {
            releaseJson: JSON.stringify({
              id: 4242,
              upload_url:
                "https://foreign.example/repos/example/sana-mcp/releases/4242/assets{?name,label}",
            }),
            repository: "example/sana-mcp",
            assetName: "asset.bin",
            descriptor,
            expectedSha256,
            expectedUploadOrigin: "https://uploads.github.test",
            authToken: "",
          },
          (async () => {
            invalidEndpointReachedNetwork = true;
            throw new Error("invalid endpoint reached the network");
          }) as typeof fetch,
        ),
        /not the exact expected origin, repository, release id, and raw path/,
      );
      assert.equal(invalidEndpointReachedNetwork, false);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

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
    assert.equal(
      manifest.stateCompatibility,
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
    );
    const diskManifest = parseReleaseManifestJson(
      await readFile(path.join(output, "manifest.json"), "utf8"),
    );
    assert.deepEqual(diskManifest, manifest);
    const futureStateManifest = structuredClone(manifest);
    (futureStateManifest as { stateCompatibility: number }).stateCompatibility =
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility + 1;
    assert.equal(
      parseReleaseManifestJson(JSON.stringify(futureStateManifest))
        .stateCompatibility,
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility + 1,
    );
    for (const invalidStateCompatibility of [0, -1, 1.5, "1", null]) {
      const invalidManifest = structuredClone(manifest) as unknown as Record<
        string,
        unknown
      >;
      invalidManifest.stateCompatibility = invalidStateCompatibility;
      assert.throws(() =>
        parseReleaseManifestJson(JSON.stringify(invalidManifest)),
      );
    }
    const missingStateCompatibility = structuredClone(manifest) as unknown as Record<
      string,
      unknown
    >;
    delete missingStateCompatibility.stateCompatibility;
    assert.throws(() =>
      parseReleaseManifestJson(JSON.stringify(missingStateCompatibility)),
    );

    const manifestSha256 = await sha256File(path.join(output, "manifest.json"));
    const installerSha256 = {
      "install.ps1": await sha256File(path.join(output, "install.ps1")),
      "install.sh": await sha256File(path.join(output, "install.sh")),
    } as const;
    for (const asset of manifest.assets) {
      const installerAssetName = asset.target.startsWith("bun-windows-")
        ? "install.ps1"
        : "install.sh";
      const properties = await readFile(
        path.join(output, releaseMetadataFileName(asset.target)),
        "utf8",
      );
      assert.match(properties, /^format=sana-mcp-release-v1$/m);
      assert.match(properties, new RegExp(`^manifestSha256=${manifestSha256}$`, "m"));
      assert.match(properties, new RegExp(`^sourceCommit=${sourceCommit}$`, "m"));
      assert.match(properties, new RegExp(`^target=${asset.target}$`, "m"));
      assert.match(properties, new RegExp(`^assetName=${asset.assetName}$`, "m"));
      assert.match(
        properties,
        new RegExp(
          `^stateCompatibility=${SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility}$`,
          "m",
        ),
      );
      assert.match(
        properties,
        new RegExp(`^installerAssetName=${installerAssetName}$`, "m"),
      );
      assert.match(
        properties,
        new RegExp(
          `^installerSha256=${installerSha256[installerAssetName]}$`,
          "m",
        ),
      );
      assert.equal(
        await sha256File(path.join(output, asset.assetName)),
        asset.sha256,
      );
    }
    for (const installerAssetName of [
      "install.ps1",
      "install.sh",
    ] as const) {
      assert.equal(
        await readFile(path.join(output, `${installerAssetName}.sha256`), "utf8"),
        `${installerSha256[installerAssetName]}  ${installerAssetName}\n`,
      );
      assert.equal(
        installerSha256[installerAssetName],
        await sha256File(path.join(process.cwd(), installerAssetName)),
      );
    }

    assert.deepEqual(
      (await readdir(output)).sort(),
      [
        "install.ps1",
        "install.ps1.sha256",
        "install.sh",
        "install.sh.sha256",
        "manifest.json",
        "manifest.json.sha256",
        "manifest.schema.json",
        ...manifest.assets.flatMap((asset) => [
          `attestation-${asset.target}.json`,
          asset.assetName,
          asset.checksumFileName,
          releaseMetadataFileName(asset.target),
          `${releaseMetadataFileName(asset.target)}.sha256`,
        ]),
      ].sort(),
    );
    await verifyAssembledRelease({
      releaseTag: `v${packageMetadata.version}`,
      sourceCommit,
      directory: output,
      repositoryRoot: process.cwd(),
    });
    const manifestPath = path.join(output, "manifest.json");
    const manifestChecksumPath = path.join(output, "manifest.json.sha256");
    const authorizedManifestText = await readFile(manifestPath, "utf8");
    const restoreManifest = async (): Promise<void> => {
      await writeFile(manifestPath, authorizedManifestText, "utf8");
      await writeFile(
        manifestChecksumPath,
        `${await sha256File(manifestPath)}  manifest.json\n`,
        "utf8",
      );
    };
    const truncatedManifest = structuredClone(manifest);
    (truncatedManifest.assets as ReleaseAsset[]).pop();
    await writeFile(
      manifestPath,
      `${JSON.stringify(truncatedManifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      manifestChecksumPath,
      `${await sha256File(manifestPath)}  manifest.json\n`,
      "utf8",
    );
    await assert.rejects(
      verifyAssembledRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        directory: output,
        repositoryRoot: process.cwd(),
      }),
      /exact ordered canonical release target matrix/,
    );
    await restoreManifest();
    const wrongEpochManifest = structuredClone(manifest);
    (wrongEpochManifest as { stateCompatibility: number }).stateCompatibility =
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility + 1;
    await writeFile(
      manifestPath,
      `${JSON.stringify(wrongEpochManifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      manifestChecksumPath,
      `${await sha256File(manifestPath)}  manifest.json\n`,
      "utf8",
    );
    await assert.rejects(
      verifyAssembledRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        directory: output,
        repositoryRoot: process.cwd(),
      }),
      /stateCompatibility is not the current project value/,
    );
    await restoreManifest();
    const firstAttestedAsset = manifest.assets[0];
    if (firstAttestedAsset === undefined) throw new Error("release has no assets");
    const attestationPath = path.join(
      output,
      `attestation-${firstAttestedAsset.target}.json`,
    );
    const authorizedAttestationText = await readFile(attestationPath, "utf8");
    const attestation = JSON.parse(
      authorizedAttestationText,
    ) as { sha256: string };
    attestation.sha256 = "f".repeat(64);
    await writeFile(
      attestationPath,
      `${JSON.stringify(attestation, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      verifyAssembledRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        directory: output,
        repositoryRoot: process.cwd(),
      }),
      /not bound to its attested digest authority/,
    );
    await writeFile(attestationPath, authorizedAttestationText, "utf8");
    const mutatedAsset = manifest.assets[0];
    if (mutatedAsset === undefined) throw new Error("release has no assets");
    await writeFile(
      path.join(output, mutatedAsset.assetName),
      "mutated after assembly\n",
    );
    await assert.rejects(
      verifyAssembledRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        directory: output,
        repositoryRoot: process.cwd(),
      }),
      /assembled asset digest mismatch/,
    );
    await copyFile(
      path.join(artifacts, mutatedAsset.assetName),
      path.join(output, mutatedAsset.assetName),
    );
    await writeFile(path.join(output, "install.sh"), "mutated installer\n");
    const mutatedInstallerSha = await sha256File(path.join(output, "install.sh"));
    await writeFile(
      path.join(output, "install.sh.sha256"),
      `${mutatedInstallerSha}  install.sh\n`,
    );
    await assert.rejects(
      verifyAssembledRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        directory: output,
        repositoryRoot: process.cwd(),
      }),
      /assembled installer differs from source/,
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

    await makeArtifacts(artifacts);
    const incompatibleAttestationPath = path.join(
      artifacts,
      `attestation-${RELEASE_TARGETS[1]}.json`,
    );
    const incompatibleAttestation = JSON.parse(
      await readFile(incompatibleAttestationPath, "utf8"),
    ) as { inspect: { stateCompatibility: number } };
    incompatibleAttestation.inspect.stateCompatibility =
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility + 1;
    await writeFile(
      incompatibleAttestationPath,
      `${JSON.stringify(incompatibleAttestation)}\n`,
    );
    await assert.rejects(
      assembleRelease({
        releaseTag: `v${packageMetadata.version}`,
        sourceCommit,
        artifactsDirectory: artifacts,
        outputDirectory: path.join(temporary, "incompatible-state"),
      }),
      /stateCompatibility/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

linuxOnlyTest("release resolver distinguishes version reuse, new versions, and lookup failure", async () => {
  const workflow = YAML.parse(
    await readFile(
      path.join(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    ),
  ) as {
    jobs: {
      authorize: {
        steps: Array<{ id?: string; run?: string }>;
      };
    };
  };
  const resolver = workflow.jobs.authorize.steps.find(
    (step) => step.id === "verify",
  )?.run;
  assert.ok(resolver);

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "sana-release-resolver-"),
  );
  try {
    const commands = path.join(temporary, "commands");
    await mkdir(commands);
    await writeFile(
      path.join(commands, "bun"),
      `#!/bin/sh\nprintf '%s' '${packageMetadata.version}'\n`,
    );
    await writeFile(
      path.join(commands, "git"),
      [
        "#!/bin/sh",
        'case "$1" in',
        `  rev-parse) printf '%s\\n' '${sourceCommit}'; exit 0 ;;`,
        "  show-ref)",
        '    [ "${FAKE_TAG_PROBE:-missing}" = "exists" ] && exit 0',
        "    exit 1",
        "    ;;",
        "  ls-remote)",
        '    case "${FAKE_TAG_PROBE:-missing}" in',
        `      exists) printf '%s\\t%s\\n' '${sourceCommit}' 'refs/tags/v${packageMetadata.version}'; exit 0 ;;`,
        "      missing) exit 2 ;;",
        "      error) echo 'synthetic remote failure' >&2; exit 128 ;;",
        "      *) exit 64 ;;",
        "    esac",
        "    ;;",
        "  *) exit 64 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(commands, "gh"),
      [
        "#!/bin/sh",
        '[ "$1" = "api" ] || exit 64',
        '[ "$2" = "--hostname" ] && [ "$3" = "github.com" ] || exit 64',
        `exact_ref="repos/example/sana-mcp/git/ref/tags/v${packageMetadata.version}"`,
        'if [ "$4" = "$exact_ref" ]; then',
        'case "${FAKE_TAG_PROBE:-missing}" in',
        `  exists) if [ "\${FAKE_TAG_KIND:-commit}" = "tag" ]; then printf 'tag %s\\n' '${"a".repeat(40)}'; else printf 'commit %s\\n' "\${FAKE_TAG_SHA:-${sourceCommit}}"; fi; exit 0 ;;`,
        "  missing) echo 'HTTP 404: Not Found' >&2; exit 1 ;;",
        "  error) echo 'synthetic remote failure' >&2; exit 1 ;;",
        "  *) exit 64 ;;",
        "esac",
        "fi",
        `if [ "$4" = "repos/example/sana-mcp/git/tags/${"a".repeat(40)}" ]; then`,
        "  if [ \"${FAKE_TAG_OBJECT_PROBE:-exists}\" = \"missing\" ]; then echo 'HTTP 404: Not Found' >&2; exit 1; fi",
        `  printf 'commit %s\\n' "\${FAKE_TAG_SHA:-${sourceCommit}}"`,
        "  exit 0",
        "fi",
        "echo 'unexpected API path' >&2",
        "exit 65",
        "",
      ].join("\n"),
    );
    await chmod(path.join(commands, "bun"), 0o755);
    await chmod(path.join(commands, "git"), 0o755);
    await chmod(path.join(commands, "gh"), 0o755);

    const execute = (options: {
      eventName: "push" | "workflow_dispatch";
      refName: string;
      refType: "branch" | "tag";
      requestedTag?: string;
      tagProbe: "exists" | "missing" | "error";
      tagSha?: string;
      tagKind?: "commit" | "tag";
      tagObjectProbe?: "exists" | "missing";
    }) => {
      const output = path.join(
        temporary,
        `output-${Math.random().toString(16).slice(2)}`,
      );
      const result = spawnSync("/bin/bash", ["-c", resolver], {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${commands}:${process.env.PATH ?? ""}`,
          EVENT_NAME: options.eventName,
          REF_NAME: options.refName,
          REF_TYPE: options.refType,
          REQUESTED_TAG: options.requestedTag ?? "",
          FAKE_TAG_PROBE: options.tagProbe,
          ...(options.tagSha === undefined
            ? {}
            : { FAKE_TAG_SHA: options.tagSha }),
          ...(options.tagKind === undefined
            ? {}
            : { FAKE_TAG_KIND: options.tagKind }),
          ...(options.tagObjectProbe === undefined
            ? {}
            : { FAKE_TAG_OBJECT_PROBE: options.tagObjectProbe }),
          GITHUB_REPOSITORY: "example/sana-mcp",
          GITHUB_API_URL: "https://api.github.com",
          GITHUB_SERVER_URL: "https://github.com",
          GH_HOST: "ambient.invalid",
          GITHUB_OUTPUT: output,
        },
      });
      const outputs =
        result.status === 0
          ? Object.fromEntries(
              readFileSync(output, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const separator = line.indexOf("=");
                  return [
                    line.slice(0, separator),
                    line.slice(separator + 1),
                  ];
                }),
            )
          : {};
      return { result, outputs };
    };

    const unchanged = execute({
      eventName: "push",
      refName: "main",
      refType: "branch",
      tagProbe: "exists",
    });
    assert.equal(unchanged.result.status, 0, unchanged.result.stderr);
    assert.equal(unchanged.outputs.skip, "true");
    assert.equal(unchanged.outputs.create_tag, "false");

    const changed = execute({
      eventName: "push",
      refName: "main",
      refType: "branch",
      tagProbe: "missing",
    });
    assert.equal(changed.result.status, 0, changed.result.stderr);
    assert.equal(changed.outputs.tag, `v${packageMetadata.version}`);
    assert.equal(changed.outputs.sha, sourceCommit);
    assert.equal(changed.outputs.skip, "false");
    assert.equal(changed.outputs.create_tag, "true");

    const unavailable = execute({
      eventName: "push",
      refName: "main",
      refType: "branch",
      tagProbe: "error",
    });
    assert.notEqual(unavailable.result.status, 0);
    assert.match(
      unavailable.result.stderr,
      new RegExp(
        `Could not determine whether v${packageMetadata.version.replaceAll(".", "\\.")} already exists`,
      ),
    );

    const tagPush = execute({
      eventName: "push",
      refName: `v${packageMetadata.version}`,
      refType: "tag",
      tagProbe: "exists",
    });
    assert.equal(tagPush.result.status, 0, tagPush.result.stderr);
    assert.equal(tagPush.outputs.skip, "false");
    assert.equal(tagPush.outputs.create_tag, "false");

    const annotatedTagPush = execute({
      eventName: "push",
      refName: `v${packageMetadata.version}`,
      refType: "tag",
      tagProbe: "exists",
      tagKind: "tag",
    });
    assert.equal(
      annotatedTagPush.result.status,
      0,
      annotatedTagPush.result.stderr,
    );

    const annotatedObjectMissing = execute({
      eventName: "push",
      refName: "main",
      refType: "branch",
      tagProbe: "exists",
      tagKind: "tag",
      tagObjectProbe: "missing",
    });
    assert.notEqual(annotatedObjectMissing.result.status, 0);
    assert.match(
      annotatedObjectMissing.result.stderr,
      new RegExp(
        `Could not determine whether v${packageMetadata.version.replaceAll(".", "\\.")} already exists`,
      ),
    );

    const matchingManual = execute({
      eventName: "workflow_dispatch",
      refName: "main",
      refType: "branch",
      requestedTag: `v${packageMetadata.version}`,
      tagProbe: "exists",
    });
    assert.equal(
      matchingManual.result.status,
      0,
      matchingManual.result.stderr,
    );
    assert.equal(matchingManual.outputs.create_tag, "false");

    const missingManual = execute({
      eventName: "workflow_dispatch",
      refName: "main",
      refType: "branch",
      requestedTag: `v${packageMetadata.version}`,
      tagProbe: "missing",
    });
    assert.notEqual(missingManual.result.status, 0);
    assert.match(missingManual.result.stderr, /is not an existing tag/);

    const mismatchedTagCommit = execute({
      eventName: "push",
      refName: `v${packageMetadata.version}`,
      refType: "tag",
      tagProbe: "exists",
      tagSha: "fedcba9876543210fedcba9876543210fedcba98",
    });
    assert.notEqual(mismatchedTagCommit.result.status, 0);
    assert.match(
      mismatchedTagCommit.result.stderr,
      /Checkout is not the exact requested tag commit/,
    );

    const mismatchedManual = execute({
      eventName: "workflow_dispatch",
      refName: "main",
      refType: "branch",
      requestedTag: "v9.9.9",
      tagProbe: "exists",
    });
    assert.notEqual(mismatchedManual.result.status, 0);
    assert.match(
      mismatchedManual.result.stderr,
      new RegExp(
        `does not match package version v${packageMetadata.version.replaceAll(".", "\\.")}`,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Bounded retry sleeps are simulator functions that only record state. The
// workflow script remains byte-for-byte the YAML value extracted above.
// This is a slow end-to-end publication simulation (it stands up a fake GitHub
// + upload server and drives the real publish script). It is excluded from the
// fast `bun run check` suite; run it explicitly with SANA_RELEASE_SIM=1.
const releaseSimulationTest =
  process.env.SANA_RELEASE_SIM === "1" && process.platform === "linux"
    ? test
    : test.skip;
releaseSimulationTest("release publication resumes only a matching draft and re-verifies every asset", { timeout: 300_000 }, async () => {
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
  const publicationPatchIndex = publishScript.indexOf("-F draft=false");
  assert.notEqual(publicationPatchIndex, -1);
  const afterPublish = publishScript.slice(publicationPatchIndex);
  assert.match(
    afterPublish,
    /-F draft=false[\s\S]*require_pinned_release[\s\S]*test "\$release_is_draft" = "false"[\s\S]*require_verified_asset_identity[\s\S]*verify_remote_assets true[\s\S]*require_verified_asset_identity[\s\S]*require_pinned_release[\s\S]*require_verified_asset_identity[\s\S]*contain_published_release/,
  );

  const bashEnvironmentFixture = path.join(
    process.cwd(),
    "tests/fixtures/release/fake-github.sh",
  );
  const simulatorHandler = path.join(
    process.cwd(),
    "tests/fixtures/release/fake-github.ts",
  );
  assert.equal(await realpath(bashEnvironmentFixture), bashEnvironmentFixture);
  assert.equal(await realpath(simulatorHandler), simulatorHandler);

  let simulatorRoot: string | undefined;
  let outsideRoot: string | undefined;
  let uploadServer: ReturnType<typeof Bun.serve> | undefined;
  let uploadAuthority:
    | Readonly<{
        remoteAssets: string;
        stateFile: string;
        modeFile: string;
        releaseIdentityFile: string;
      }>
    | undefined;
  const observedUploadRequests: Array<{
    origin: string;
    authorization: string | null;
    assetName: string;
  }> = [];
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    const ownedSimulatorRoot = await mkdtemp(
      path.join(os.tmpdir(), "sana-publish-simulator-"),
    );
    simulatorRoot = ownedSimulatorRoot;
    const ownedOutsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "sana-publish-outside-"),
    );
    outsideRoot = ownedOutsideRoot;
    await chmod(ownedSimulatorRoot, 0o700);
    await chmod(ownedOutsideRoot, 0o700);
    const outsideSentinel = path.join(
      ownedOutsideRoot,
      "valid-state.json",
    );
    const outsideSentinelBytes = Buffer.from(
      JSON.stringify({
        exists: true,
        draft: true,
        tag: "outside-authority",
        title: "outside-authority",
        prerelease: false,
      }),
    );
    await writeFile(outsideSentinel, outsideSentinelBytes);
    const canonicalSimulatorRoot = await realpath(ownedSimulatorRoot);
    assert.equal(canonicalSimulatorRoot, ownedSimulatorRoot);
    const commands = path.join(ownedSimulatorRoot, "commands");
    await mkdir(commands);
    await writeFile(
      path.join(commands, "gh"),
      "#!/bin/sh\nprintf '%s\\n' 'poison-gh: BASH_ENV simulator function was not installed' >&2\nexit 79\n",
    );
    await chmod(path.join(commands, "gh"), 0o755);
    const isolatedHome = path.join(ownedSimulatorRoot, "home");
    const isolatedGhConfig = path.join(ownedSimulatorRoot, "gh-config");
    await mkdir(isolatedHome);
    await mkdir(isolatedGhConfig);

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) => {
        if (value === undefined) return false;
        const upper = name.toUpperCase();
        return (
          !upper.endsWith("_PROXY") &&
          upper !== "NO_PROXY" &&
          !upper.startsWith("BASH_FUNC_") &&
          ![
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_CONFIG_DIR",
            "GITHUB_CONFIG",
            "GIT_ASKPASS",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_COUNT",
            "GIT_TERMINAL_PROMPT",
            "SSH_ASKPASS",
            "SSH_AUTH_SOCK",
            "XDG_CONFIG_HOME",
          ].includes(upper)
        );
      }),
    ) as NodeJS.ProcessEnv;
    const simulatorEnvironment = {
      ...inheritedEnvironment,
      BASH_ENV: bashEnvironmentFixture,
      PATH: `${commands}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: isolatedHome,
      GH_CONFIG_DIR: isolatedGhConfig,
      TMPDIR: path.join(ownedSimulatorRoot, "tmp"),
      TMP: path.join(ownedSimulatorRoot, "tmp"),
      TEMP: path.join(ownedSimulatorRoot, "tmp"),
      LC_ALL: "C",
      FAKE_GITHUB_ROOT: canonicalSimulatorRoot,
      FAKE_GITHUB_BUN: process.execPath,
      FAKE_GITHUB_HANDLER: simulatorHandler,
    };
    for (const forbiddenName of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_ASKPASS",
      "SSH_AUTH_SOCK",
      "XDG_CONFIG_HOME",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          simulatorEnvironment,
          forbiddenName,
        ),
        false,
        `${forbiddenName} leaked into the release simulator`,
      );
    }
    await mkdir(simulatorEnvironment.TMPDIR);

    const opensslAvailable = spawnSync(
      "/bin/bash",
      ["-c", 'command -v openssl >/dev/null'],
      {
        cwd: ownedSimulatorRoot,
        env: simulatorEnvironment,
        encoding: "utf8",
      },
    );
    assert.equal(opensslAvailable.status, 0, "openssl is required for TLS upload simulation");
    const tlsKey = path.join(ownedSimulatorRoot, "upload-server.key");
    const tlsCertificate = path.join(
      ownedSimulatorRoot,
      "upload-server.crt",
    );
    const certificate = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        tlsKey,
        "-out",
        tlsCertificate,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      {
        cwd: ownedSimulatorRoot,
        env: simulatorEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(
      certificate.status,
      0,
      `could not create isolated upload TLS authority: ${certificate.stderr}`,
    );
    await chmod(tlsKey, 0o600);
    await chmod(tlsCertificate, 0o600);
    uploadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        key: Bun.file(tlsKey),
        cert: Bun.file(tlsCertificate),
      },
      async fetch(request) {
        const authority = uploadAuthority;
        if (authority === undefined) {
          return new Response("upload authority unavailable", { status: 503 });
        }
        const requestUrl = new URL(request.url);
        const assetName = requestUrl.searchParams.get("name");
        observedUploadRequests.push({
          origin: requestUrl.origin,
          authorization: request.headers.get("authorization"),
          assetName: assetName ?? "",
        });
        if (
          request.method !== "POST" ||
          requestUrl.pathname !==
            "/repos/example/sana-mcp/releases/4242/assets" ||
          requestUrl.searchParams.size !== 1 ||
          assetName === null ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(assetName) ||
          request.headers.get("authorization") !== "Bearer simulator-token" ||
          request.headers.get("content-type") !== "application/octet-stream"
        ) {
          return new Response("invalid upload request", { status: 400 });
        }
        const releaseIdentity = JSON.parse(
          await readFile(authority.releaseIdentityFile, "utf8"),
        ) as { currentId?: number };
        if (
          releaseIdentity.currentId !== 4242 ||
          requestUrl.pathname !==
            `/repos/example/sana-mcp/releases/${releaseIdentity.currentId}/assets`
        ) {
          return new Response("release identity is unavailable", {
            status: 404,
          });
        }
        const mode = JSON.parse(
          await readFile(authority.modeFile, "utf8"),
        ) as {
          response?: "normal" | "malformed" | "failure";
          moveTagSha?: string;
        };
        if (mode.response === "failure") {
          return Response.json({ message: "synthetic upload failure" }, {
            status: 500,
          });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        await writeFile(path.join(authority.remoteAssets, assetName), bytes);
        if (mode.moveTagSha !== undefined) {
          const state = JSON.parse(
            await readFile(authority.stateFile, "utf8"),
          ) as Record<string, unknown>;
          state.tagSha = mode.moveTagSha;
          await writeFile(authority.stateFile, JSON.stringify(state));
        }
        if (mode.response === "malformed") {
          return new Response("{", {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json(
          {
            name: assetName,
            state: "uploaded",
            size: bytes.byteLength,
          },
          { status: 201 },
        );
      },
    });
    const uploadOrigin = `https://127.0.0.1:${uploadServer.port}`;
    const pinnedReleaseHandler = path.join(
      ownedSimulatorRoot,
      "pinned-release-handler.ts",
    );
    await writeFile(
      pinnedReleaseHandler,
      `
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const identityFile = process.env.FAKE_RELEASE_IDENTITY;
const stateFile = process.env.FAKE_RELEASE_STATE;
const assetsDirectory = process.env.FAKE_RELEASE_ASSETS;
const repository = process.env.GITHUB_REPOSITORY;
const releaseTag = process.env.RELEASE_TAG;
const uploadOrigin = process.env.FAKE_RELEASE_UPLOAD_ORIGIN;
const assetIdentityMapFile = process.env.FAKE_ASSET_IDENTITY_MAP;
if (
  !identityFile ||
  !stateFile ||
  !assetsDirectory ||
  !repository ||
  !releaseTag ||
  !uploadOrigin ||
  !assetIdentityMapFile
) throw new Error("pinned release simulator authority is incomplete");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const identity = () => readJson(identityFile);
const state = () => readJson(stateFile);
const saveIdentity = (value) =>
  writeFileSync(identityFile, JSON.stringify(value));
const saveState = (value) => writeFileSync(stateFile, JSON.stringify(value));
const assetIdentityMap = new Map(
  readJson(assetIdentityMapFile).map((entry) => [entry.name, entry.id]),
);
const assetTuples = (releaseId) =>
  readdirSync(assetsDirectory)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const id =
        assetIdentityMap.get(name) + (identity().assetIdOffset ?? 0);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("remote asset lacks a stable identity");
      }
      return {
        id,
        name,
        url:
          \`https://api.github.com/repos/\${repository}/releases/assets/\${id}\`,
      };
    });
const releaseDocument = () => {
  const currentIdentity = identity();
  const currentState = state();
  const id = currentIdentity.currentId;
  if (
    currentState.exists !== true ||
    !Number.isSafeInteger(id) ||
    id <= 0
  ) return undefined;
  return {
    id,
    url: \`https://api.github.com/repos/\${repository}/releases/\${id}\`,
    upload_url:
      \`\${uploadOrigin}/repos/\${repository}/releases/\${id}\` +
      "/assets{?name,label}",
    tag_name: currentState.tag,
    draft: currentState.draft,
    name: currentState.title,
    prerelease: currentState.prerelease,
    assets: assetTuples(id),
  };
};
const failMissing = () => {
  process.stderr.write("HTTP 404: Not Found\\n");
  process.exit(1);
};

if (mode === "augment-pages") {
  const pages = JSON.parse(process.argv[3]);
  const document = releaseDocument();
  for (const page of pages) {
    for (let index = 0; index < page.length; index += 1) {
      if (page[index].tag_name === releaseTag && document !== undefined) {
        page[index] = document;
        const shape = process.env.FAKE_RELEASE_DRAFT_SHAPE;
        if (shape === "missing") delete page[index].draft;
        else if (shape === "null") page[index].draft = null;
        else if (shape === "object") page[index].draft = {};
        else if (shape === "string") page[index].draft = "true";
      }
    }
  }
  process.stdout.write(JSON.stringify(pages));
} else if (mode === "get-release") {
  const requestedId = Number(process.argv[3]);
  const currentIdentity = identity();
  currentIdentity.pinnedFetches += 1;
  if (
    process.env.FAKE_REPLACE_RELEASE_AFTER_ASSETS === "1" &&
    currentIdentity.pinnedFetches === 3
  ) {
    currentIdentity.currentId = 4343;
    currentIdentity.replaced = true;
    saveIdentity(currentIdentity);
    failMissing();
  }
  if (
    process.env.FAKE_REPLACE_ASSET_IDS_AFTER_VERIFICATION === "1" &&
    currentIdentity.pinnedFetches === 3
  ) {
    currentIdentity.assetIdOffset = 100000;
  }
  if (
    process.env.FAKE_REPLACE_PUBLISHED_ASSET_IDS_AFTER_VERIFICATION === "1" &&
    state().draft === false &&
    currentIdentity.pinnedFetches === 2
  ) {
    currentIdentity.assetIdOffset = 100000;
  }
  saveIdentity(currentIdentity);
  const document = releaseDocument();
  if (document === undefined || document.id !== requestedId) failMissing();
  process.stdout.write(JSON.stringify(document));
} else if (mode === "download-asset") {
  const requestedId = Number(process.argv[3]);
  const document = releaseDocument();
  const asset = document?.assets.find((candidate) => candidate.id === requestedId);
  if (asset === undefined) failMissing();
  if (process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA) {
    const currentState = state();
    currentState.tagSha = process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA;
    saveState(currentState);
  }
  process.stdout.write(readFileSync(path.join(assetsDirectory, asset.name)));
} else if (mode === "move-download-tag") {
  const currentState = state();
  currentState.tagSha = process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA;
  saveState(currentState);
} else if (mode === "patch-release") {
  const requestedId = Number(process.argv[3]);
  const requestedDraft = process.argv[4] === "true";
  const currentIdentity = identity();
  const currentState = state();
  if (
    currentIdentity.currentId !== requestedId ||
    currentState.exists !== true
  ) failMissing();
  currentState.draft = requestedDraft;
  if (!requestedDraft && process.env.FAKE_MOVE_TAG_ON_EDIT_SHA) {
    currentState.tagSha = process.env.FAKE_MOVE_TAG_ON_EDIT_SHA;
  }
  currentIdentity.patches += 1;
  if (requestedDraft) currentIdentity.containmentPatches += 1;
  else currentIdentity.publicationPatches += 1;
  saveState(currentState);
  saveIdentity(currentIdentity);
  process.stdout.write(JSON.stringify(releaseDocument()));
} else {
  throw new Error(\`unsupported pinned release simulator mode: \${mode}\`);
}
`,
      "utf8",
    );

    const requiredCommands = [
      "bash",
      "bun",
      "cat",
      "cmp",
      "find",
      "grep",
      "mkdir",
      "mktemp",
      "sort",
    ];
    for (const command of requiredCommands) {
      const available = spawnSync(
        "/bin/bash",
        ["-c", `command -v "${command}" >/dev/null`],
        {
          cwd: ownedSimulatorRoot,
          env: simulatorEnvironment,
          encoding: "utf8",
        },
      );
      assert.equal(
        available.status,
        0,
        `required release-test dependency ${command} is unavailable`,
      );
    }
    const bunAvailable = spawnSync(process.execPath, ["--version"], {
      cwd: ownedSimulatorRoot,
      env: simulatorEnvironment,
      encoding: "utf8",
    });
    assert.equal(
      bunAvailable.status,
      0,
      `required release-test Bun runtime is unavailable: ${bunAvailable.stderr}`,
    );

    for (const remoteMatches of [true, false]) {
      const temporary = path.join(
        ownedSimulatorRoot,
        remoteMatches ? "matching" : "mismatching",
      );
      await mkdir(temporary);
      let scenarioFailure: unknown;
      let scenarioFailed = false;
      try {
        const localAssets = path.join(temporary, "release-assets");
        const buildArtifacts = path.join(temporary, "build-artifacts");
        const remoteAssets = path.join(temporary, "remote-assets");
        const childTemporary = path.join(temporary, "tmp");
        const childHome = path.join(temporary, "home");
        const childGhConfig = path.join(temporary, "gh-config");
        const stateFile = path.join(temporary, "release-state.json");
        const uploadModeFile = path.join(temporary, "upload-mode.json");
        const releaseIdentityFile = path.join(
          temporary,
          "release-identity.json",
        );
      const releaseSourceDirectory = path.join(temporary, "release");
      await mkdir(buildArtifacts);
      await mkdir(remoteAssets);
      await mkdir(childTemporary);
      await mkdir(childHome);
      await mkdir(childGhConfig);
      await mkdir(releaseSourceDirectory);
      for (const sourceName of ["install.ps1", "install.sh"] as const) {
        await copyFile(
          path.join(process.cwd(), sourceName),
          path.join(temporary, sourceName),
        );
      }
      await copyFile(
        path.join(process.cwd(), "release/manifest.schema.json"),
        path.join(releaseSourceDirectory, "manifest.schema.json"),
      );
      await makeArtifacts(buildArtifacts);
      const assembleLocalTuple = async (releaseTag: string): Promise<void> => {
        await rm(localAssets, { recursive: true, force: true });
        await assembleRelease({
          releaseTag,
          sourceCommit,
          artifactsDirectory: buildArtifacts,
          outputDirectory: localAssets,
          repositoryRoot: process.cwd(),
        });
      };
      await assembleLocalTuple(`v${packageMetadata.version}`);
      const completeAssetNames = (await readdir(localAssets)).sort();
      const missingUploadAsset = "manifest.json.sha256";
      assert.ok(completeAssetNames.includes(missingUploadAsset));
      const assetIdentityMap = completeAssetNames.map((name, index) => ({
        id: 4_242_000 + index + 1,
        name,
      }));
      const assetIdentityMapFile = path.join(
        temporary,
        "asset-identity-map.json",
      );
      const assetTransferMapFile = path.join(
        temporary,
        "asset-transfer-map.tsv",
      );
      await writeFile(assetIdentityMapFile, JSON.stringify(assetIdentityMap));
      await writeFile(
        assetTransferMapFile,
        assetIdentityMap
          .map((entry) => `${entry.id}\t${entry.name}`)
          .join("\n") + "\n",
      );
      if (remoteMatches) {
        for (const assetName of completeAssetNames) {
          if (assetName === missingUploadAsset) continue;
          await copyFile(
            path.join(localAssets, assetName),
            path.join(remoteAssets, assetName),
          );
        }
      } else {
        const mismatchingAsset = completeAssetNames[0];
        assert.ok(mismatchingAsset);
        await writeFile(
          path.join(remoteAssets, mismatchingAsset),
          "different remote bytes\n",
        );
      }
      await writeFile(uploadModeFile, JSON.stringify({ response: "normal" }));
      uploadAuthority = {
        remoteAssets,
        stateFile,
        modeFile: uploadModeFile,
        releaseIdentityFile,
      };
      await writeFile(
        stateFile,
        JSON.stringify({
          exists: true,
          draft: true,
          tag: `v${packageMetadata.version}`,
          title: `v${packageMetadata.version}`,
          prerelease: false,
          tagExists: true,
          tagKind: "commit",
          tagSha: sourceCommit,
        }),
      );
      if (remoteMatches) {
        const baseInvocationEnvironment = {
          ...simulatorEnvironment,
          PWD: temporary,
          HOME: childHome,
          GH_CONFIG_DIR: childGhConfig,
          TMPDIR: childTemporary,
          TMP: childTemporary,
          TEMP: childTemporary,
          SOURCE_SHA: sourceCommit,
          RELEASE_TAG: `v${packageMetadata.version}`,
          GITHUB_REPOSITORY: "example/sana-mcp",
          FAKE_RELEASE_STATE: stateFile,
          FAKE_RELEASE_ASSETS: remoteAssets,
          FAKE_RELEASE_SCENARIO: "direct simulator probe",
        };
        const stateBeforeMissingBashEnvironment = await readFile(stateFile);
        const missingBashEnvironment = spawnSync(
          "/bin/bash",
          [
            "-c",
            [
              'test "$(type -t gh)" = "function" || {',
              "  gh",
              "  exit $?",
              "}",
            ].join("\n"),
          ],
          {
            cwd: temporary,
            env: {
              ...baseInvocationEnvironment,
              BASH_ENV: path.join(temporary, "missing-bash-env"),
            },
            encoding: "utf8",
          },
        );
        assert.equal(missingBashEnvironment.status, 79);
        assert.equal(missingBashEnvironment.stdout, "");
        assert.equal(
          missingBashEnvironment.stderr,
          "poison-gh: BASH_ENV simulator function was not installed\n",
        );
        assert.deepEqual(
          await readFile(stateFile),
          stateBeforeMissingBashEnvironment,
          "missing BASH_ENV mutated release state",
        );
        const unreadableBashEnvironment = path.join(
          temporary,
          "unreadable-bash-env",
        );
        await writeFile(unreadableBashEnvironment, "gh() { exit 0; }\n");
        await chmod(unreadableBashEnvironment, 0o000);
        const unreadableEnvironment = spawnSync(
          "/bin/bash",
          [
            "-c",
            [
              'test "$(type -t gh)" = "function" || {',
              "  gh",
              "  exit $?",
              "}",
            ].join("\n"),
          ],
          {
            cwd: temporary,
            env: {
              ...baseInvocationEnvironment,
              BASH_ENV: unreadableBashEnvironment,
            },
            encoding: "utf8",
          },
        );
        assert.equal(unreadableEnvironment.status, 79);
        assert.equal(unreadableEnvironment.stdout, "");
        assert.match(
          unreadableEnvironment.stderr,
          /Permission denied[\s\S]*poison-gh: BASH_ENV simulator function was not installed\n$/u,
        );
        assert.deepEqual(
          await readFile(stateFile),
          stateBeforeMissingBashEnvironment,
          "unreadable BASH_ENV mutated release state",
        );

        const directArguments = [
          "space value",
          "*?[glob]",
          "--leading-dash",
          "",
        ];
        const directProbe = spawnSync(
          "/bin/bash",
          [
            "-c",
            'gh __probe 23 "stdout-line" "stderr-line" "$@"',
            "fake-github-direct-probe",
            ...directArguments,
          ],
          {
            cwd: temporary,
            env: baseInvocationEnvironment,
            encoding: "utf8",
          },
        );
        assert.equal(directProbe.status, 23);
        assert.equal(
          directProbe.stdout,
          `${JSON.stringify(directArguments)}\nstdout-line\n`,
        );
        assert.equal(directProbe.stderr, "stderr-line\n");
        const rawProbe = spawnSync(
          "/bin/bash",
          [
            "-c",
            'gh __probe-raw 19 "stdout-without-newline" "stderr-without-newline"',
          ],
          {
            cwd: temporary,
            env: baseInvocationEnvironment,
            encoding: "utf8",
          },
        );
        assert.equal(rawProbe.status, 19);
        assert.equal(rawProbe.stdout, "stdout-without-newline");
        assert.equal(rawProbe.stderr, "stderr-without-newline");

        const directFailure = (
          label: string,
          args: readonly string[],
          environment: NodeJS.ProcessEnv,
          expectedStatus: number,
          expectedMessage: string,
        ): void => {
          const result = spawnSync(
            "/bin/bash",
            ["-c", 'gh "$@"', `fake-github-${label}`, ...args],
            {
              cwd: temporary,
              env: {
                ...baseInvocationEnvironment,
                FAKE_RELEASE_SCENARIO: label,
                ...environment,
              },
              encoding: "utf8",
            },
          );
          assert.equal(result.status, expectedStatus, label);
          assert.equal(result.stdout, "", label);
          assert.equal(
            result.stderr,
            `fake-github[${label}]: ${expectedMessage}\n`,
            label,
          );
        };
        for (const [label, value] of [
          ["CR argument probe", "value\rwith-cr"],
          ["LF argument probe", "value\nwith-lf"],
        ] as const) {
          directFailure(
            label,
            ["__probe", "0", "stdout", "stderr", value],
            {},
            64,
            "argument 4 contains a line break",
          );
        }
        for (const [label, value] of [
          ["CR environment probe", "1\r"],
          ["LF environment probe", "1\n"],
        ] as const) {
          directFailure(
            label,
            ["__probe", "0", "stdout", "stderr"],
            { FAKE_TAG_CREATE_FAIL: value },
            70,
            "FAKE_TAG_CREATE_FAIL contains a line break",
          );
        }
        directFailure(
          "oversize argument probe",
          ["__probe", "0", "stdout", "stderr", "x".repeat(16_385)],
          {},
          64,
          "argument 4 exceeds 16384 bytes",
        );
        directFailure(
          "oversize environment probe",
          ["__probe", "0", "stdout", "stderr"],
          { FAKE_TAG_CREATE_FAIL: "x".repeat(16_385) },
          70,
          "FAKE_TAG_CREATE_FAIL exceeds 16384 bytes",
        );
        directFailure(
          "missing parent probe",
          ["__probe", "0", "stdout", "stderr"],
          {
            FAKE_RELEASE_STATE: path.join(
              temporary,
              "missing-parent",
              "state.json",
            ),
          },
          70,
          "file path has a missing component",
        );
        directFailure(
          "relative parent escape probe",
          ["__probe", "0", "stdout", "stderr"],
          { FAKE_RELEASE_STATE: "../outside-state.json" },
          70,
          "file path is not canonical and absolute",
        );
        const invalidModeRoot = path.join(temporary, "invalid-mode-root");
        await mkdir(invalidModeRoot);
        await chmod(invalidModeRoot, 0o755);
        directFailure(
          "invalid root mode probe",
          ["__probe", "0", "stdout", "stderr"],
          { FAKE_GITHUB_ROOT: invalidModeRoot },
          70,
          "simulator root must be an owned ordinary mode-0700 directory",
        );
        const linkedRoot = path.join(temporary, "linked-root");
        await symlink(ownedSimulatorRoot, linkedRoot);
        directFailure(
          "noncanonical root probe",
          ["__probe", "0", "stdout", "stderr"],
          { FAKE_GITHUB_ROOT: linkedRoot },
          70,
          "simulator root must be an owned ordinary mode-0700 directory",
        );

        const corruptShapeCases = [
          [
            "corrupt tag lookup shape",
            [
              "api",
              `repos/example/sana-mcp/git/ref/tags/v${packageMetadata.version}`,
              "--jq",
              ".object.sha",
            ],
            "tag lookup arguments are invalid",
          ],
          [
            "corrupt tag creation shape",
            [
              "api",
              "--method",
              "POST",
              "repos/example/sana-mcp/git/refs",
              "-f",
              `ref=refs/tags/v${packageMetadata.version}`,
              "-f",
              `sha=${sourceCommit}`,
              "-f",
              "extra=value",
            ],
            "tag creation arguments are invalid",
          ],
          [
            "corrupt release create shape",
            [
              "release",
              "create",
              `v${packageMetadata.version}`,
              "--verify-tag",
              "--target",
              sourceCommit,
              "--title",
              `v${packageMetadata.version}`,
            ],
            "release creation arguments are invalid",
          ],
          [
            "corrupt release edit shape",
            [
              "release",
              "edit",
              `v${packageMetadata.version}`,
              "--draft",
              "false",
            ],
            "release edit arguments are invalid",
          ],
          [
            "corrupt release download shape",
            [
              "release",
              "download",
              `v${packageMetadata.version}`,
              "--pattern",
              "a.bin",
              "--pattern",
              "a.bin",
              "--dir",
              childTemporary,
            ],
            "release download arguments are invalid",
          ],
          [
            "corrupt release upload shape",
            [
              "release",
              "upload",
              "v0.0.0",
              path.join(localAssets, "a.bin"),
            ],
            "release upload arguments are invalid",
          ],
        ] as const;
        for (const [label, args, messagePrefix] of corruptShapeCases) {
          const result = spawnSync(
            "/bin/bash",
            ["-c", 'gh "$@"', `fake-github-${label}`, ...args],
            {
              cwd: temporary,
              env: {
                ...baseInvocationEnvironment,
                FAKE_RELEASE_SCENARIO: label,
              },
              encoding: "utf8",
            },
          );
          assert.equal(result.status, 64, label);
          assert.equal(result.stdout, "", label);
          assert.equal(
            result.stderr,
            `fake-github[${label}]: ${messagePrefix}: ${JSON.stringify(args)}\n`,
            label,
          );
        }
        assert.deepEqual(
          await readFile(outsideSentinel),
          outsideSentinelBytes,
          "negative simulator probes mutated the outside sentinel",
        );

        const stateLink = path.join(temporary, "state-link");
        const symlinkScenario = "symlink escape probe";
        await symlink(outsideSentinel, stateLink);
        const escaped = spawnSync(
          "/bin/bash",
          ["-c", 'sleep "1"'],
          {
            cwd: temporary,
            env: {
              ...baseInvocationEnvironment,
              FAKE_RELEASE_STATE: stateLink,
              FAKE_RELEASE_SCENARIO: symlinkScenario,
            },
            encoding: "buffer",
          },
        );
        const symlinkStderr = Buffer.from(
          `fake-github[${symlinkScenario}]: file path contains a symbolic link or reparse point\n`,
        );
        assert.equal(escaped.status, 70);
        assert.deepEqual(escaped.stdout, Buffer.alloc(0));
        assert.deepEqual(escaped.stderr, symlinkStderr);
        assert.deepEqual(
          await readFile(outsideSentinel),
          outsideSentinelBytes,
          "escape probe mutated the outside valid-JSON sentinel",
        );

        const assetsLink = path.join(temporary, "assets-link");
        await symlink(ownedOutsideRoot, assetsLink);
        const confinementProbes = [
          {
            label: "assets symlink escape probe",
            args: [
              "api",
              "--paginate",
              "repos/example/sana-mcp/releases?per_page=100",
              "--slurp",
            ],
            environment: { FAKE_RELEASE_ASSETS: assetsLink },
            expected: "directory path contains a symbolic link or reparse point",
          },
          {
            label: "upload source escape probe",
            args: [
              "release",
              "upload",
              `v${packageMetadata.version}`,
              outsideSentinel,
            ],
            environment: {},
            expected: "file path escapes the simulator root",
          },
          {
            label: "download destination escape probe",
            args: [
              "release",
              "download",
              `v${packageMetadata.version}`,
              "--pattern",
              completeAssetNames.find(
                (assetName) => assetName !== missingUploadAsset,
              )!,
              "--dir",
              ownedOutsideRoot,
            ],
            environment: {},
            expected: "directory path escapes the simulator root",
          },
        ] as const;
        for (const probe of confinementProbes) {
          const result = spawnSync(
            "/bin/bash",
            [
              "-c",
              'gh "$@"',
              `fake-github-${probe.label}`,
              ...probe.args,
            ],
            {
              cwd: temporary,
              env: {
                ...baseInvocationEnvironment,
                FAKE_RELEASE_SCENARIO: probe.label,
                ...probe.environment,
              },
              encoding: "utf8",
            },
          );
          assert.equal(result.status, 70, probe.label);
          assert.equal(result.stdout, "", probe.label);
          assert.equal(
            result.stderr,
            `fake-github[${probe.label}]: ${probe.expected}\n`,
            probe.label,
          );
          assert.deepEqual(
            await readFile(outsideSentinel),
            outsideSentinelBytes,
            `${probe.label} mutated the outside sentinel`,
          );
        }

        const invalidStateCases = [
          {
            label: "NUL state probe",
            bytes: Buffer.from([0x7b, 0x00, 0x7d]),
            expected: "release state contains a NUL byte",
          },
          {
            label: "oversize state probe",
            bytes: Buffer.alloc(1_048_577, 0x20),
            expected: "release state exceeds 1048576 bytes",
          },
        ] as const;
        for (const invalidState of invalidStateCases) {
          const invalidStatePath = path.join(
            temporary,
            `${invalidState.label.replaceAll(" ", "-")}.json`,
          );
          await writeFile(invalidStatePath, invalidState.bytes);
          const result = spawnSync(
            "/bin/bash",
            ["-c", 'sleep "1"'],
            {
              cwd: temporary,
              env: {
                ...baseInvocationEnvironment,
                FAKE_RELEASE_SCENARIO: invalidState.label,
                FAKE_RELEASE_STATE: invalidStatePath,
              },
              encoding: "utf8",
            },
          );
          assert.equal(result.status, 70, invalidState.label);
          assert.equal(result.stdout, "", invalidState.label);
          assert.equal(
            result.stderr,
            `fake-github[${invalidState.label}]: ${invalidState.expected}\n`,
            invalidState.label,
          );
        }
        const unsafeRemoteAsset = path.join(remoteAssets, "unsafe.bin");
        await symlink(outsideSentinel, unsafeRemoteAsset);
        const unsafeAssetProbe = spawnSync(
          "/bin/bash",
          [
            "-c",
            'gh api --paginate "repos/example/sana-mcp/releases?per_page=100" --slurp',
          ],
          {
            cwd: temporary,
            env: {
              ...baseInvocationEnvironment,
              FAKE_RELEASE_SCENARIO: "unsafe remote asset probe",
            },
            encoding: "utf8",
          },
        );
        assert.equal(unsafeAssetProbe.status, 70);
        assert.equal(unsafeAssetProbe.stdout, "");
        assert.equal(
          unsafeAssetProbe.stderr,
          "fake-github[unsafe remote asset probe]: file path contains a symbolic link or reparse point\n",
        );
        assert.deepEqual(
          await readFile(outsideSentinel),
          outsideSentinelBytes,
        );
        await rm(unsafeRemoteAsset);
      }

      interface ProcessIdentity {
        readonly pid: number;
        readonly processGroup: number;
        readonly startTime: string;
      }
      const readProcessIdentity = async (
        pid: number,
      ): Promise<ProcessIdentity | undefined> => {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const commandEnd = stat.lastIndexOf(")");
          if (commandEnd < 0) {
            throw new Error(`process ${pid} published malformed /proc stat`);
          }
          const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
          const processGroup = Number(fields[2]);
          const startTime = fields[19];
          if (
            !Number.isSafeInteger(processGroup) ||
            startTime === undefined ||
            !/^[0-9]+$/u.test(startTime)
          ) {
            throw new Error(`process ${pid} published invalid identity fields`);
          }
          return { pid, processGroup, startTime };
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ESRCH")
          ) {
            return undefined;
          }
          throw error;
        }
      };
      const snapshotProcessGroup = async (
        processGroup: number,
      ): Promise<readonly ProcessIdentity[]> => {
        const identities = await Promise.all(
          (await readdir("/proc"))
            .filter((entry) => /^[1-9][0-9]*$/u.test(entry))
            .map(async (entry) => await readProcessIdentity(Number(entry))),
        );
        return identities.filter(
          (identity): identity is ProcessIdentity =>
            identity?.processGroup === processGroup,
        );
      };
      const survivingRecordedMembers = async (
        recorded: readonly ProcessIdentity[],
      ): Promise<readonly ProcessIdentity[]> => {
        const observations = await Promise.all(
          recorded.map(async (identity) => {
            const current = await readProcessIdentity(identity.pid);
            return current?.processGroup === identity.processGroup &&
              current.startTime === identity.startTime
              ? current
              : undefined;
          }),
        );
        return observations.filter(
          (identity): identity is ProcessIdentity => identity !== undefined,
        );
      };
      const signalOwnedProcessGroup = (
        processGroup: number,
        signal: NodeJS.Signals,
      ): void => {
        try {
          process.kill(-processGroup, signal);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          ) {
            throw error;
          }
        }
      };
      const waitForRecordedProcessDeath = async (
        recorded: readonly ProcessIdentity[],
        timeoutMs: number,
      ): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (
          (await survivingRecordedMembers(recorded)).length > 0 &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        return (await survivingRecordedMembers(recorded)).length === 0;
      };
      const scenarioDeadlineMs = 45_000;
      interface LifecycleAuthorityOverrides {
        readonly readProcessIdentity?: typeof readProcessIdentity;
        readonly snapshotProcessGroup?: typeof snapshotProcessGroup;
        readonly survivingRecordedMembers?: typeof survivingRecordedMembers;
        readonly signalOwnedProcessGroup?: typeof signalOwnedProcessGroup;
      }
      const coordinateDetachedChild = (
        child: ReturnType<typeof spawn>,
        label: string,
        deadlineMs: number,
        authorityOverrides: LifecycleAuthorityOverrides = {},
      ): Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        error?: Error;
      }> => {
        let stdout = "";
        let stderr = "";
        let stdoutEnded = false;
        let stderrEnded = false;
        let childError: Error | undefined;
        let exitResult:
          | { status: number | null; signal: NodeJS.Signals | null }
          | undefined;
        let closeResult:
          | { status: number | null; signal: NodeJS.Signals | null }
          | undefined;
        let leaderIdentity: ProcessIdentity | undefined;
        let identityFinished = false;
        let cleanupRequested = false;
        let cleanupFinished = false;
        let authorityRefreshRequested = false;
        let timedOut = false;
        let hardExpired = false;
        let settled = false;
        let coordinatorRunning = false;
        let coordinatorQueued = false;
        const failures: unknown[] = [];
        const recordedMembers = new Map<string, ProcessIdentity>();
        const authorityRead =
          authorityOverrides.readProcessIdentity ?? readProcessIdentity;
        const authoritySnapshot =
          authorityOverrides.snapshotProcessGroup ?? snapshotProcessGroup;
        const authoritySurvivors =
          authorityOverrides.survivingRecordedMembers ??
          survivingRecordedMembers;
        const authoritySignal =
          authorityOverrides.signalOwnedProcessGroup ??
          signalOwnedProcessGroup;
        const remember = (identities: readonly ProcessIdentity[]): void => {
          for (const identity of identities) {
            recordedMembers.set(
              `${identity.pid}:${identity.startTime}`,
              identity,
            );
          }
        };

        let resolveResult!: (result: {
          status: number | null;
          signal: NodeJS.Signals | null;
          stdout: string;
          stderr: string;
          error?: Error;
        }) => void;
        const resultPromise = new Promise<{
          status: number | null;
          signal: NodeJS.Signals | null;
          stdout: string;
          stderr: string;
          error?: Error;
        }>((resolve) => {
          resolveResult = resolve;
        });

        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        assert.ok(stdoutStream);
        assert.ok(stderrStream);
        stdoutStream.setEncoding("utf8");
        stderrStream.setEncoding("utf8");

        const schedule = (): void => {
          coordinatorQueued = true;
          if (coordinatorRunning || settled) return;
          coordinatorRunning = true;
          void runCoordinator();
        };
        const onStdoutData = (chunk: string): void => {
          stdout += chunk;
          schedule();
        };
        const onStderrData = (chunk: string): void => {
          stderr += chunk;
          schedule();
        };
        const onStdoutEnd = (): void => {
          stdoutEnded = true;
          schedule();
        };
        const onStderrEnd = (): void => {
          stderrEnded = true;
          schedule();
        };
        const onStdoutError = (error: Error): void => {
          failures.push(error);
          stdoutEnded = true;
          schedule();
        };
        const onStderrError = (error: Error): void => {
          failures.push(error);
          stderrEnded = true;
          schedule();
        };
        const onChildError = (error: Error): void => {
          childError = error;
          cleanupRequested = true;
          schedule();
        };
        const onChildExit = (
          status: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          exitResult = { status, signal };
          setTimeout(() => {
            if (!settled && closeResult === undefined) {
              cleanupRequested = true;
              schedule();
            }
          }, 25);
          schedule();
        };
        const onChildClose = (
          status: number | null,
          signal: NodeJS.Signals | null,
        ): void => {
          closeResult = { status, signal };
          cleanupRequested = true;
          schedule();
        };

        // Install every child and stream listener synchronously before any
        // identity lookup or other await.
        stdoutStream.on("data", onStdoutData);
        stderrStream.on("data", onStderrData);
        stdoutStream.once("end", onStdoutEnd);
        stderrStream.once("end", onStderrEnd);
        stdoutStream.once("error", onStdoutError);
        stderrStream.once("error", onStderrError);
        child.once("error", onChildError);
        child.once("exit", onChildExit);
        child.once("close", onChildClose);

        const deadlineTimer = setTimeout(() => {
          timedOut = true;
          cleanupRequested = true;
          schedule();
        }, deadlineMs);
        const hardTimer = setTimeout(() => {
          hardExpired = true;
          cleanupRequested = true;
          stdoutStream.destroy();
          stderrStream.destroy();
          schedule();
        }, deadlineMs + 1_500);
        const authorityTimer = setInterval(() => {
          authorityRefreshRequested = true;
          schedule();
        }, 10);

        const childHandleAlive = (): boolean =>
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null &&
          child.kill(0);

        const waitForAuthorityDeath = async (
          recorded: readonly ProcessIdentity[],
          timeoutMs: number,
        ): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          while (
            (await authoritySurvivors(recorded)).length > 0 &&
            Date.now() < deadline
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          return (await authoritySurvivors(recorded)).length === 0;
        };

        const refreshOwnedGroupAuthority = async (): Promise<boolean> => {
          if (leaderIdentity === undefined) return false;
          const preExisting = [...recordedMembers.values()];
          const continuity = await authoritySurvivors(preExisting);
          if (continuity.length === 0) return false;
          const observed = await authoritySnapshot(
            leaderIdentity.processGroup,
          );
          const continuityAtAdoption =
            await authoritySurvivors(preExisting);
          if (continuityAtAdoption.length === 0) return false;
          remember(observed);
          return true;
        };

        const cleanupOwnedProcesses = async (): Promise<void> => {
          if (cleanupFinished) return;
          cleanupFinished = true;
          let continuityProven = false;
          if (leaderIdentity !== undefined) {
            try {
              continuityProven = await refreshOwnedGroupAuthority();
            } catch (error) {
              failures.push(error);
            }
          }
          let proof: readonly ProcessIdentity[] = [];
          try {
            proof = await authoritySurvivors([
              ...recordedMembers.values(),
            ]);
          } catch (error) {
            failures.push(error);
          }
          if (
            continuityProven &&
            proof.length > 0 &&
            leaderIdentity !== undefined
          ) {
            try {
              authoritySignal(
                leaderIdentity.processGroup,
                "SIGTERM",
              );
            } catch (error) {
              failures.push(error);
            }
          } else if (childHandleAlive()) {
            try {
              child.kill("SIGTERM");
            } catch (error) {
              failures.push(error);
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          let survivors: readonly ProcessIdentity[] = [];
          try {
            survivors = await authoritySurvivors([
              ...recordedMembers.values(),
            ]);
          } catch (error) {
            failures.push(error);
          }
          if (
            continuityProven &&
            survivors.length > 0 &&
            leaderIdentity !== undefined
          ) {
            try {
              authoritySignal(
                leaderIdentity.processGroup,
                "SIGKILL",
              );
            } catch (error) {
              failures.push(error);
            }
          } else if (childHandleAlive()) {
            try {
              child.kill("SIGKILL");
            } catch (error) {
              failures.push(error);
            }
          }
          if (survivors.length > 0) {
            try {
              if (!(await waitForAuthorityDeath(survivors, 500))) {
                failures.push(
                  new Error(
                    `detached child ${JSON.stringify(label)} retained exact recorded process tuples after SIGKILL`,
                  ),
                );
              }
            } catch (error) {
              failures.push(error);
            }
          }
          if (leaderIdentity !== undefined) {
            try {
              const finalGroup = await authoritySnapshot(
                leaderIdentity.processGroup,
              );
              if (finalGroup.length > 0) {
                const provenFinal = await authoritySurvivors([
                  ...recordedMembers.values(),
                ]);
                if (provenFinal.length > 0) {
                  failures.push(
                    new Error(
                      `detached child ${JSON.stringify(label)} did not leave a dead process group ${leaderIdentity.processGroup}`,
                    ),
                  );
                } else {
                  failures.push(
                    new Error(
                      `detached child ${JSON.stringify(label)} observed an unproven reused process group ${leaderIdentity.processGroup} and did not signal it`,
                    ),
                  );
                }
              }
            } catch (error) {
              failures.push(error);
            }
          }
        };

        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          clearTimeout(hardTimer);
          clearInterval(authorityTimer);
          stdoutStream.off("data", onStdoutData);
          stderrStream.off("data", onStderrData);
          const outcome = closeResult ?? exitResult ?? {
            status: null,
            signal: null,
          };
          if (timedOut) {
            failures.unshift(
              new Error(
                `detached child ${JSON.stringify(label)} exceeded its ${deadlineMs} millisecond deadline`,
              ),
            );
          }
          if (hardExpired && closeResult === undefined) {
            failures.push(
              new Error(
                `detached child ${JSON.stringify(label)} did not close before its absolute settlement deadline`,
              ),
            );
          }
          if (childError !== undefined) failures.push(childError);
          const error =
            failures.length === 0
              ? undefined
              : failures.length === 1
                ? failures[0] as Error
                : new AggregateError(
                    failures,
                    `detached child ${JSON.stringify(label)} settlement failed`,
                  );
          resolveResult({
            ...outcome,
            stdout,
            stderr,
            ...(error === undefined ? {} : { error }),
          });
        };

        async function runCoordinator(): Promise<void> {
          try {
            while (coordinatorQueued && !settled) {
              coordinatorQueued = false;
              if (
                authorityRefreshRequested &&
                identityFinished &&
                leaderIdentity !== undefined &&
                !cleanupRequested
              ) {
                authorityRefreshRequested = false;
                try {
                  await refreshOwnedGroupAuthority();
                } catch (error) {
                  failures.push(error);
                  cleanupRequested = true;
                }
              }
              if (cleanupRequested && identityFinished && !cleanupFinished) {
                await cleanupOwnedProcesses();
              }
              if (
                closeResult !== undefined &&
                identityFinished &&
                cleanupFinished &&
                stdoutEnded &&
                stderrEnded
              ) {
                finish();
                return;
              }
              if (hardExpired && identityFinished && cleanupFinished) {
                finish();
                return;
              }
            }
          } catch (error) {
            failures.push(error);
            cleanupRequested = true;
            if (hardExpired) finish();
          } finally {
            coordinatorRunning = false;
            if (coordinatorQueued && !settled) schedule();
          }
        }

        void (async () => {
          const pid = child.pid;
          if (pid === undefined) {
            failures.push(
              new Error(
                `detached child ${JSON.stringify(label)} did not publish a PID`,
              ),
            );
            cleanupRequested = true;
          } else {
            try {
              const identity = await authorityRead(pid);
              if (identity === undefined) {
                failures.push(
                  new Error(
                    `detached child ${JSON.stringify(label)} exited before identity capture`,
                  ),
                );
                cleanupRequested = true;
              } else if (identity.processGroup !== pid) {
                failures.push(
                  new Error(
                    `detached child ${JSON.stringify(label)} did not own process group ${pid}`,
                  ),
                );
                cleanupRequested = true;
              } else {
                leaderIdentity = identity;
                remember([identity]);
                try {
                  await refreshOwnedGroupAuthority();
                } catch (error) {
                  failures.push(error);
                  cleanupRequested = true;
                }
              }
            } catch (error) {
              failures.push(error);
              cleanupRequested = true;
            } finally {
              identityFinished = true;
              schedule();
            }
          }
          if (pid === undefined) {
            identityFinished = true;
            schedule();
          }
        })();

        return resultPromise;
      };

      if (remoteMatches) {
        const unrelated = spawn(
          "/bin/bash",
          ["-c", 'trap "" TERM; while :; do /bin/sleep 1; done'],
          {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
        let unrelatedSpawnError: Error | undefined;
        unrelated.once("error", (error) => {
          unrelatedSpawnError = error;
        });
        const unrelatedClosed = new Promise<void>((resolve) => {
          unrelated.once("close", () => resolve());
        });
        try {
          const unrelatedPid = unrelated.pid;
          assert.ok(unrelatedPid);
          const unrelatedIdentity = await readProcessIdentity(unrelatedPid);
          assert.ok(unrelatedIdentity);

          const lifecycleCases = [
            {
              label: "successful descendant",
              script: '(trap "" TERM; /bin/sleep 0.05) & wait',
              deadlineMs: 1_000,
              expectsTimeout: false,
            },
            {
              label: "early-close stubborn descendant",
              script:
                '(trap "" TERM; while :; do /bin/sleep 1; done) & /bin/sleep 0.05; exit 0',
              deadlineMs: 1_000,
              expectsTimeout: false,
            },
            {
              label: "timeout stubborn descendant",
              script:
                'trap "" TERM; (trap "" TERM; while :; do /bin/sleep 1; done) & while :; do /bin/sleep 1; done',
              deadlineMs: 150,
              expectsTimeout: true,
            },
          ] as const;
          for (const lifecycleCase of lifecycleCases) {
            const child = spawn(
              "/bin/bash",
              ["-c", lifecycleCase.script],
              {
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            const resultPromise = coordinateDetachedChild(
              child,
              lifecycleCase.label,
              lifecycleCase.deadlineMs,
            );
            const result = await resultPromise;
            if (lifecycleCase.expectsTimeout) {
              assert.ok(result.error);
              assert.match(result.error.message, /exceeded its 150 millisecond deadline/u);
            } else {
              assert.equal(
                result.error,
                undefined,
                result.error?.message,
              );
              assert.equal(result.status, 0);
            }
            const observedUnrelated =
              await readProcessIdentity(unrelatedIdentity.pid);
            assert.deepEqual(
              observedUnrelated,
              unrelatedIdentity,
              `${lifecycleCase.label} signalled the unrelated sentinel`,
            );
          }
          const missingExecutable = spawn(
            path.join(temporary, "missing-executable"),
            [],
            {
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const missingExecutableResult = await coordinateDetachedChild(
            missingExecutable,
            "spawn-error empty-identity cleanup",
            150,
          );
          assert.ok(missingExecutableResult.error);
          assert.match(
            missingExecutableResult.error.message,
            /spawn-error empty-identity cleanup|spawn/u,
          );
          const observedAfterSpawnError =
            await readProcessIdentity(unrelatedIdentity.pid);
          assert.deepEqual(
            observedAfterSpawnError,
            unrelatedIdentity,
            "spawn-error cleanup signalled the unrelated sentinel",
          );

          let mismatchGroupSignals = 0;
          const mismatchChild = spawn(
            "/bin/bash",
            ["-c", "while :; do :; done"],
            {
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const mismatchPid = mismatchChild.pid;
          assert.ok(mismatchPid);
          const mismatchResult = await coordinateDetachedChild(
            mismatchChild,
            "mismatched process-group authority",
            200,
            {
              readProcessIdentity: async (pid) => ({
                pid,
                processGroup: unrelatedIdentity.processGroup,
                startTime: "1",
              }),
              snapshotProcessGroup: async () => {
                throw new Error(
                  "mismatched group must never be snapshotted",
                );
              },
              signalOwnedProcessGroup: () => {
                mismatchGroupSignals += 1;
              },
            },
          );
          assert.ok(mismatchResult.error);
          const settlementMessages = (error: unknown): string[] =>
            error instanceof AggregateError
              ? [
                  error.message,
                  ...error.errors.flatMap((entry) =>
                    settlementMessages(entry),
                  ),
                ]
              : [error instanceof Error ? error.message : String(error)];
          assert.match(
            settlementMessages(mismatchResult.error).join("\n"),
            /did not own process group/u,
          );
          assert.equal(mismatchGroupSignals, 0);
          assert.deepEqual(
            await readProcessIdentity(unrelatedIdentity.pid),
            unrelatedIdentity,
            "mismatched-PGID cleanup touched the unrelated tuple",
          );

          let reusedGroupSignals = 0;
          const reusedChild = spawn(
            "/bin/bash",
            ["-c", "/bin/sleep 0.08"],
            {
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const reusedPid = reusedChild.pid;
          assert.ok(reusedPid);
          const reusedResult = await coordinateDetachedChild(
            reusedChild,
            "reused process-group observation",
            1_000,
            {
              snapshotProcessGroup: async (processGroup) => {
                const actual = await snapshotProcessGroup(processGroup);
                return actual.length > 0
                  ? actual
                  : [
                      {
                        pid: unrelatedIdentity.pid,
                        processGroup,
                        startTime: unrelatedIdentity.startTime,
                      },
                    ];
              },
              signalOwnedProcessGroup: () => {
                reusedGroupSignals += 1;
              },
            },
          );
          assert.ok(reusedResult.error);
          assert.match(
            settlementMessages(reusedResult.error).join("\n"),
            /unproven reused process group/u,
          );
          assert.equal(reusedGroupSignals, 0);
          assert.deepEqual(
            await readProcessIdentity(unrelatedIdentity.pid),
            unrelatedIdentity,
            "reused-PGID observation touched the unrelated tuple",
          );
          assert.equal(unrelatedSpawnError, undefined);
        } finally {
          if (
            unrelated.pid !== undefined &&
            unrelated.exitCode === null &&
            unrelated.signalCode === null
          ) {
            unrelated.kill("SIGKILL");
          }
          await Promise.race([
            unrelatedClosed,
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "unrelated lifecycle sentinel did not close after owned cleanup",
                    ),
                  ),
                1_000,
              ),
            ),
          ]);
        }
      }

      const execute = async (
        scenario: string,
        releaseTag = `v${packageMetadata.version}`,
        createTag = false,
        tagRaceSha?: string,
        tagCreateFails = false,
        tagLookupFails = false,
        tagMoveOnUploadSha?: string,
        tagMoveOnEditSha?: string,
        tagObjectLookupFails = false,
        tagMoveOnDownloadSha?: string,
        releaseVisibilityMisses = 0,
        releaseLookupFailureAt?: number,
        releaseMalformedAt?: number,
        releaseDuplicateAt?: number,
        tagVisibilityMisses = 0,
        postCreateTagLookupFails = false,
        createdTagSha?: string,
        createdTagKind?: string,
      ) => {
        await rm(path.join(childTemporary, "containment-failed-once"), {
          force: true,
        });
        await writeFile(
          uploadModeFile,
          JSON.stringify({
            response:
              scenario === "upload returns malformed response"
                ? "malformed"
                : scenario === "upload returns failure status"
                  ? "failure"
                  : "normal",
            ...(tagMoveOnUploadSha === undefined
              ? {}
              : { moveTagSha: tagMoveOnUploadSha }),
          }),
        );
        const uploadRequestStart = observedUploadRequests.length;
        const ghInvocationLog = path.join(
          temporary,
          "gh-invocations.log",
        );
        await writeFile(
          releaseIdentityFile,
          JSON.stringify({
            currentId: 4242,
            pinnedFetches: 0,
            patches: 0,
            publicationPatches: 0,
            containmentPatches: 0,
            assetIdOffset: 0,
            replaced: false,
          }),
        );
        await writeFile(ghInvocationLog, "");
        const preflightScript = [
          'test "${SANA_FAKE_GITHUB_BASH_ENV_V1-}" = "${BASH_ENV-}" || { echo "fake-github preflight: BASH_ENV provenance mismatch" >&2; exit 78; }',
          'test "$(type -t gh)" = "function" || { echo "fake-github preflight: gh is not a function" >&2; exit 78; }',
          'test "$(type -t sleep)" = "function" || { echo "fake-github preflight: sleep is not a function" >&2; exit 78; }',
          `test "\${FAKE_GITHUB_HANDLER-}" = ${JSON.stringify(simulatorHandler)} || { echo "fake-github preflight: handler path mismatch" >&2; exit 78; }`,
          `test "\${FAKE_GITHUB_BUN-}" = ${JSON.stringify(process.execPath)} || { echo "fake-github preflight: Bun path mismatch" >&2; exit 78; }`,
          'original_gh_definition="$(declare -f gh)"',
          'eval "fake_gh${original_gh_definition#gh}"',
          "bun() {",
          '  if [ "${2-}" = "assembled-authority" ]; then',
          '    case "${FAKE_AUTHORITY_PRODUCER_MODE-}" in',
          '      partial-failure) printf "%s" \'{"authorityVersion":1,"files":\'; return 71 ;;',
          "      empty-success) return 0 ;;",
          "    esac",
          "  fi",
          '  "$FAKE_GITHUB_BUN" "$@"',
          "}",
          "gh() {",
          '  printf "%s\\n" "$*" >> "$FAKE_GH_INVOCATION_LOG" || return $?',
          '  test "${GH_HOST-}" = "github.com" || { echo "fake-github: GH_HOST is not authoritative" >&2; return 64; }',
          '  if [ "${1-}" = "release" ]; then',
          '    test "${2-}" = "create" && test "${4-}" = "--repo" &&',
          '      test "${5-}" = "$GITHUB_REPOSITORY" ||',
          '      { echo "fake-github: release command lacks exact repository authority" >&2; return 64; }',
          '    fake_gh release create "$3" "${@:6}"',
          "    return",
          "  fi",
          '  test "${1-}" = "api" && test "${2-}" = "--hostname" &&',
          '    test "${3-}" = "github.com" ||',
          '    { echo "fake-github: API command lacks exact host authority" >&2; return 64; }',
          '  api_args=("api" "${@:4}")',
          '  if [ "${api_args[1]-}" = "--paginate" ]; then',
          '    pages="$(fake_gh "${api_args[@]}")" || return $?',
          '    "$FAKE_GITHUB_BUN" "$FAKE_PINNED_RELEASE_HANDLER" augment-pages "$pages" || return $?',
          '    if [ "${FAKE_SWAP_UPLOAD_PATH-}" = "1" ] && [ ! -e "$TMPDIR/path-swap-complete" ]; then',
          '      descriptor_target="$(find "$TMPDIR" -path "*/authorized-assets/$FAKE_UPLOAD_ASSET" -type f -print -quit)"',
          '      test -n "$descriptor_target" || return 69',
          '      chmod u+w "$(dirname "$descriptor_target")" || return $?',
          '      printf "%s\\n" "attacker pathname replacement" > "$descriptor_target.replacement" || return $?',
          '      mv -f "$descriptor_target.replacement" "$descriptor_target" || return $?',
          '      : > "$TMPDIR/path-swap-complete"',
          "    fi",
          "    return",
          "  fi",
          '  if [ "${api_args[1]-}" = "-H" ]; then',
          '    test "${api_args[2]-}" = "Accept: application/octet-stream" || return 64',
          '    asset_endpoint="${api_args[3]-}"',
          '    asset_id="${asset_endpoint##*/}"',
          '    test "$asset_endpoint" = "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" || return 64',
          '    asset_name="$(awk -F "\\t" -v requested="$asset_id" \'$1 == requested { print $2 }\' "$FAKE_ASSET_TRANSFER_MAP")"',
          '    test -n "$asset_name" && test -f "$FAKE_RELEASE_ASSETS/$asset_name" || return 1',
          '    if [ -n "${FAKE_MOVE_TAG_ON_DOWNLOAD_SHA-}" ] && [ ! -e "$TMPDIR/download-tag-moved" ]; then',
          '      "$FAKE_GITHUB_BUN" "$FAKE_PINNED_RELEASE_HANDLER" move-download-tag || return $?',
          '      : > "$TMPDIR/download-tag-moved"',
          "    fi",
          '    cat "$FAKE_RELEASE_ASSETS/$asset_name"',
          "    return",
          "  fi",
          '  if [ "${api_args[1]-}" = "--method" ] && [ "${api_args[2]-}" = "PATCH" ]; then',
          '    release_endpoint="${api_args[3]-}"',
          '    requested_id="${release_endpoint##*/}"',
          '    draft_field="${api_args[5]-}"',
          '    test "${#api_args[@]}" -eq 6 &&',
          '      test "$release_endpoint" = "repos/$GITHUB_REPOSITORY/releases/$requested_id" &&',
          '      test "${api_args[4]-}" = "-F" || return 64',
          '    case "$draft_field" in draft=true|draft=false) ;; *) return 64 ;; esac',
          '    if [ "$draft_field" = "draft=false" ] && [ "${FAKE_PUBLICATION_APPLIED_RESPONSE_FAILURE-}" = "1" ]; then',
          '      "$FAKE_GITHUB_BUN" "$FAKE_PINNED_RELEASE_HANDLER" patch-release "$requested_id" false >/dev/null || return $?',
          '      echo "synthetic publication response failure after apply" >&2',
          '      return 75',
          "    fi",
          '    if [ "$draft_field" = "draft=true" ] && [ "${FAKE_CONTAINMENT_FAILURE_MODE-}" = "initial" ] && [ ! -e "$TMPDIR/containment-failed-once" ]; then',
          '      : > "$TMPDIR/containment-failed-once"',
          '      echo "synthetic initial containment failure" >&2',
          '      return 76',
          "    fi",
          '    if [ "$draft_field" = "draft=true" ] && [ "${FAKE_CONTAINMENT_FAILURE_MODE-}" = "persistent" ]; then',
          '      echo "synthetic persistent containment failure" >&2',
          '      return 76',
          "    fi",
          '    "$FAKE_GITHUB_BUN" "$FAKE_PINNED_RELEASE_HANDLER" patch-release "$requested_id" "${draft_field#draft=}"',
          "    return",
          "  fi",
          '  if [ "${api_args[1]-}" = "--method" ]; then',
          '    fake_gh "${api_args[@]}"',
          "    return",
          "  fi",
          '  api_endpoint="${api_args[1]-}"',
          '  case "$api_endpoint" in',
          '    "repos/$GITHUB_REPOSITORY/releases/"*)',
          '      requested_id="${api_endpoint##*/}"',
          '      test "$api_endpoint" = "repos/$GITHUB_REPOSITORY/releases/$requested_id" || return 64',
          '      "$FAKE_GITHUB_BUN" "$FAKE_PINNED_RELEASE_HANDLER" get-release "$requested_id"',
          "      return",
          "      ;;",
          "  esac",
          '  fake_gh "${api_args[@]}"',
          "  return",
          "}",
          "",
        ].join("\n");
        const child = spawn(
          "/bin/bash",
          ["-c", `${preflightScript}${publishScript}`],
          {
          cwd: temporary,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...simulatorEnvironment,
            PWD: temporary,
            HOME: childHome,
            GH_CONFIG_DIR: childGhConfig,
            TMPDIR: childTemporary,
            TMP: childTemporary,
            TEMP: childTemporary,
            GITHUB_WORKSPACE: process.cwd(),
            GITHUB_API_URL: "https://api.github.com",
            GITHUB_SERVER_URL: "https://github.com",
            EXPECTED_UPLOAD_ORIGIN:
              scenario === "upload origin authority mismatch"
                ? `https://localhost:${uploadServer?.port ?? 0}`
                : uploadOrigin,
            FAKE_RELEASE_UPLOAD_ORIGIN: uploadOrigin,
            FAKE_PINNED_RELEASE_HANDLER: pinnedReleaseHandler,
            FAKE_RELEASE_IDENTITY: releaseIdentityFile,
            FAKE_ASSET_IDENTITY_MAP: assetIdentityMapFile,
            FAKE_ASSET_TRANSFER_MAP: assetTransferMapFile,
            FAKE_GH_INVOCATION_LOG: ghInvocationLog,
            GH_HOST: "ambient.invalid",
            GH_TOKEN: "simulator-token",
            NODE_EXTRA_CA_CERTS: tlsCertificate,
            RELEASE_TAG: releaseTag,
            SOURCE_SHA: sourceCommit,
            CREATE_TAG: String(createTag),
            ...(tagRaceSha === undefined
              ? {}
              : { FAKE_TAG_RACE_SHA: tagRaceSha }),
            ...(tagCreateFails ? { FAKE_TAG_CREATE_FAIL: "1" } : {}),
            ...(tagLookupFails ? { FAKE_TAG_LOOKUP_ERROR: "1" } : {}),
            FAKE_TAG_VISIBILITY_MISSES: String(tagVisibilityMisses),
            ...(postCreateTagLookupFails
              ? { FAKE_POST_CREATE_TAG_LOOKUP_ERROR: "1" }
              : {}),
            ...(createdTagSha === undefined
              ? {}
              : { FAKE_CREATED_TAG_SHA: createdTagSha }),
            ...(createdTagKind === undefined
              ? {}
              : { FAKE_CREATED_TAG_KIND: createdTagKind }),
            ...(tagObjectLookupFails
              ? { FAKE_TAG_OBJECT_LOOKUP_ERROR: "1" }
              : {}),
            ...(tagMoveOnDownloadSha === undefined
              ? {}
              : { FAKE_MOVE_TAG_ON_DOWNLOAD_SHA: tagMoveOnDownloadSha }),
            FAKE_RELEASE_VISIBILITY_MISSES: String(releaseVisibilityMisses),
            ...(releaseLookupFailureAt === undefined
              ? {}
              : {
                  FAKE_RELEASE_LOOKUP_FAILURE_AT: String(
                    releaseLookupFailureAt,
                  ),
                }),
            ...(releaseMalformedAt === undefined
              ? {}
              : { FAKE_RELEASE_MALFORMED_AT: String(releaseMalformedAt) }),
            ...(releaseDuplicateAt === undefined
              ? {}
              : { FAKE_RELEASE_DUPLICATE_AT: String(releaseDuplicateAt) }),
            ...(tagMoveOnUploadSha === undefined
              ? {}
              : { FAKE_MOVE_TAG_ON_UPLOAD_SHA: tagMoveOnUploadSha }),
            ...(tagMoveOnEditSha === undefined
              ? {}
              : { FAKE_MOVE_TAG_ON_EDIT_SHA: tagMoveOnEditSha }),
            GITHUB_REPOSITORY: "example/sana-mcp",
            FAKE_RELEASE_STATE: stateFile,
            FAKE_RELEASE_ASSETS: remoteAssets,
            FAKE_RELEASE_SCENARIO: scenario,
            FAKE_UPLOAD_ASSET: missingUploadAsset,
            ...(scenario === "authority producer returns partial failure"
              ? { FAKE_AUTHORITY_PRODUCER_MODE: "partial-failure" }
              : scenario === "authority producer returns empty success"
                ? { FAKE_AUTHORITY_PRODUCER_MODE: "empty-success" }
                : {}),
            ...([
              "missing",
              "null",
              "object",
              "string",
            ].includes(scenario.replace("invalid draft shape: ", ""))
              ? {
                  FAKE_RELEASE_DRAFT_SHAPE: scenario.replace(
                    "invalid draft shape: ",
                    "",
                  ),
                }
              : {}),
            ...(scenario === "release id replaced after asset verification"
              ? { FAKE_REPLACE_RELEASE_AFTER_ASSETS: "1" }
              : {}),
            ...(scenario === "asset ids replaced after verification"
              ? { FAKE_REPLACE_ASSET_IDS_AFTER_VERIFICATION: "1" }
              : {}),
            ...(scenario === "published asset ids replaced after verification"
              ? {
                  FAKE_REPLACE_PUBLISHED_ASSET_IDS_AFTER_VERIFICATION: "1",
                }
              : {}),
            ...([
              "publication applied but response fails",
              "publication applied, response fails, initial containment fails",
              "publication applied, response fails, containment remains unavailable",
            ].includes(scenario)
              ? { FAKE_PUBLICATION_APPLIED_RESPONSE_FAILURE: "1" }
              : {}),
            ...(scenario ===
            "publication applied, response fails, initial containment fails"
              ? { FAKE_CONTAINMENT_FAILURE_MODE: "initial" }
              : scenario ===
                  "publication applied, response fails, containment remains unavailable"
                ? { FAKE_CONTAINMENT_FAILURE_MODE: "persistent" }
                : {}),
            ...(scenario === "descriptor survives pathname replacement"
              ? { FAKE_SWAP_UPLOAD_PATH: "1" }
              : {}),
          },
        });
        const result = await coordinateDetachedChild(
          child,
          `publish scenario ${scenario}`,
          scenarioDeadlineMs,
        );
        const { stdout, stderr } = result;
        const diagnostic = [
          `publish scenario ${JSON.stringify(scenario)}`,
          `status=${String(result.status)}`,
          `signal=${String(result.signal)}`,
          `error=${result.error?.message ?? "<none>"}`,
          `stdout=${stdout || "<empty>"}`,
          `stderr=${stderr || "<empty>"}`,
        ].join("\n");
        if (result.error !== undefined || result.status === null) {
          assert.fail(diagnostic);
        }
        return {
          ...result,
          stdout,
          stderr,
          diagnostic,
          uploadRequests: observedUploadRequests.slice(uploadRequestStart),
          ghInvocations: (await readFile(ghInvocationLog, "utf8"))
            .split("\n")
            .filter(Boolean),
          releaseIdentity: JSON.parse(
            await readFile(releaseIdentityFile, "utf8"),
          ) as {
            currentId: number;
            pinnedFetches: number;
            patches: number;
            publicationPatches: number;
            containmentPatches: number;
            assetIdOffset: number;
            replaced: boolean;
          },
        };
      };
      const result = await execute(
        remoteMatches
          ? "descriptor survives pathname replacement"
          : "mismatching draft",
      );
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        draft: boolean;
      };
      if (remoteMatches) {
        assert.equal(result.status, 0, result.diagnostic);
        assert.equal(state.draft, false);
        assert.deepEqual(
          await readFile(path.join(remoteAssets, missingUploadAsset)),
          await readFile(path.join(localAssets, missingUploadAsset)),
        );
        assert.ok(result.uploadRequests.length >= 1);
        assert.ok(
          result.uploadRequests.every(
            (request) =>
              request.origin === uploadOrigin &&
              request.authorization === "Bearer simulator-token",
            ),
        );
        const resetMatchingDraftWithoutUploadAsset = async (): Promise<void> => {
          await rm(path.join(remoteAssets, missingUploadAsset), { force: true });
          await writeFile(
            stateFile,
            JSON.stringify({
              exists: true,
              draft: true,
              tag: `v${packageMetadata.version}`,
              title: `v${packageMetadata.version}`,
              prerelease: false,
              tagExists: true,
              tagKind: "commit",
              tagSha: sourceCommit,
            }),
          );
        };

        const authorityStateBefore = await readFile(stateFile);
        const authorityAssetsBefore = (await readdir(remoteAssets)).sort();
        for (const scenario of [
          "authority producer returns partial failure",
          "authority producer returns empty success",
        ]) {
          const rejectedAuthority = await execute(scenario);
          assert.notEqual(rejectedAuthority.status, 0);
          assert.deepEqual(rejectedAuthority.ghInvocations, []);
          assert.deepEqual(rejectedAuthority.uploadRequests, []);
          assert.deepEqual(await readFile(stateFile), authorityStateBefore);
          assert.deepEqual(
            (await readdir(remoteAssets)).sort(),
            authorityAssetsBefore,
          );
        }

        for (const draftShape of [
          "missing",
          "null",
          "object",
          "string",
        ]) {
          await resetMatchingDraftWithoutUploadAsset();
          const invalidDraft = await execute(
            `invalid draft shape: ${draftShape}`,
          );
          assert.notEqual(invalidDraft.status, 0);
          assert.match(
            invalidDraft.stderr,
            /Existing release identity is invalid/,
          );
          assert.deepEqual(invalidDraft.uploadRequests, []);
          assert.equal(invalidDraft.releaseIdentity.patches, 0);
          const invalidDraftState = JSON.parse(
            await readFile(stateFile, "utf8"),
          ) as { draft: boolean };
          assert.equal(invalidDraftState.draft, true);
          await assert.rejects(
            readFile(path.join(remoteAssets, missingUploadAsset)),
          );
        }

        await resetMatchingDraftWithoutUploadAsset();
        const replacedRelease = await execute(
          "release id replaced after asset verification",
        );
        assert.notEqual(replacedRelease.status, 0);
        assert.match(replacedRelease.stderr, /Pinned release id 4242 is unavailable/);
        assert.equal(replacedRelease.releaseIdentity.currentId, 4343);
        assert.equal(replacedRelease.releaseIdentity.replaced, true);
        assert.equal(replacedRelease.releaseIdentity.patches, 0);
        const replacementState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(replacementState.draft, true);

        await resetMatchingDraftWithoutUploadAsset();
        const replacedAssetIdentities = await execute(
          "asset ids replaced after verification",
        );
        assert.notEqual(replacedAssetIdentities.status, 0);
        assert.match(
          replacedAssetIdentities.stderr,
          /Pinned release asset identities changed after verification/,
        );
        assert.equal(replacedAssetIdentities.releaseIdentity.currentId, 4242);
        assert.equal(replacedAssetIdentities.releaseIdentity.assetIdOffset, 100000);
        assert.equal(replacedAssetIdentities.releaseIdentity.publicationPatches, 0);
        assert.equal(replacedAssetIdentities.releaseIdentity.containmentPatches, 0);
        const replacedAssetState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(replacedAssetState.draft, true);

        await resetMatchingDraftWithoutUploadAsset();
        const failedUpload = await execute("upload returns failure status");
        assert.notEqual(failedUpload.status, 0);
        assert.match(failedUpload.stderr, /HTTP status 500/);
        assert.equal(failedUpload.uploadRequests.length, 1);
        assert.equal(
          failedUpload.uploadRequests[0]?.authorization,
          "Bearer simulator-token",
        );
        await assert.rejects(
          readFile(path.join(remoteAssets, missingUploadAsset)),
        );

        await resetMatchingDraftWithoutUploadAsset();
        const malformedUpload = await execute(
          "upload returns malformed response",
        );
        assert.notEqual(malformedUpload.status, 0);
        assert.match(malformedUpload.stderr, /returned invalid JSON/);
        assert.equal(malformedUpload.uploadRequests.length, 1);
        assert.deepEqual(
          await readFile(path.join(remoteAssets, missingUploadAsset)),
          await readFile(path.join(localAssets, missingUploadAsset)),
        );

        await resetMatchingDraftWithoutUploadAsset();
        const rejectedOrigin = await execute(
          "upload origin authority mismatch",
        );
        assert.notEqual(rejectedOrigin.status, 0);
        assert.match(
          rejectedOrigin.stderr,
          /release identity document is invalid/,
        );
        assert.deepEqual(rejectedOrigin.uploadRequests, []);
        await assert.rejects(
          readFile(path.join(remoteAssets, missingUploadAsset)),
        );

        await resetMatchingDraftWithoutUploadAsset();
        const recoveredUpload = await execute("upload retry after transport failures");
        assert.equal(recoveredUpload.status, 0, recoveredUpload.diagnostic);
        const rerun = await execute("published matching rerun");
        assert.equal(rerun.status, 0, rerun.diagnostic);
        assert.match(rerun.stdout, /already published with the authorized tuple/);

        const publishedAssetReplacement = await execute(
          "published asset ids replaced after verification",
        );
        assert.notEqual(publishedAssetReplacement.status, 0);
        assert.match(
          publishedAssetReplacement.stderr,
          /Pinned release asset identities changed after verification/,
        );
        assert.match(
          publishedAssetReplacement.stderr,
          /returned to draft containment/,
        );
        const containedPublishedAssetState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(containedPublishedAssetState.draft, true);
        assert.equal(
          publishedAssetReplacement.releaseIdentity.assetIdOffset,
          100000,
        );
        assert.equal(
          publishedAssetReplacement.releaseIdentity.containmentPatches,
          1,
        );

        const movedPublishedTagSha =
          "2222222222222222222222222222222222222222";
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: false,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const publishedTagMovedDuringVerification = await execute(
          "published tag moves during verification",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          movedPublishedTagSha,
        );
        assert.notEqual(publishedTagMovedDuringVerification.status, 0);
        assert.match(
          publishedTagMovedDuringVerification.stderr,
          /Release tag moved after authorization/,
        );
        const publishedState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean; tagSha?: string };
        assert.equal(publishedState.draft, true);
        assert.equal(publishedState.tagSha, movedPublishedTagSha);
        assert.equal(
          publishedTagMovedDuringVerification.releaseIdentity
            .containmentPatches,
          1,
        );

        const buildMetadataTag = `v${packageMetadata.version}+build-x`;
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: false,
            tag: buildMetadataTag,
            title: buildMetadataTag,
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const buildMetadataRerun = await execute(
          "reject non-current build-metadata tag",
          buildMetadataTag,
        );
        assert.notEqual(buildMetadataRerun.status, 0);
        assert.match(
          buildMetadataRerun.stderr,
          /assembled release tag does not match the authorized tag/,
        );

        const annotatedTag = `v${packageMetadata.version}`;
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: false,
            tag: annotatedTag,
            title: annotatedTag,
            prerelease: false,
            tagExists: true,
            tagKind: "tag",
            tagObjectSha: "a".repeat(40),
            tagSha: sourceCommit,
          }),
        );
        const annotatedPublishedRerun = await execute(
          "published annotated-tag rerun",
          annotatedTag,
        );
        assert.equal(
          annotatedPublishedRerun.status,
          0,
          annotatedPublishedRerun.stderr,
        );

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: "wrong title",
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const wrongTitle = await execute("draft with wrong title");
        assert.notEqual(wrongTitle.status, 0);
        assert.match(wrongTitle.stderr, /title does not match/);

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: true,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const wrongClassification = await execute(
          "draft with wrong prerelease classification",
        );
        assert.notEqual(wrongClassification.status, 0);
        assert.match(
          wrongClassification.stderr,
          /prerelease classification is incorrect/,
        );

        for (const asset of await readdir(remoteAssets)) {
          await rm(path.join(remoteAssets, asset));
        }
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: false,
            draft: false,
            tag: "",
            title: "",
            prerelease: false,
            tagExists: false,
            tagSha: null,
          }),
        );
        const automaticMainRelease = await execute(
          "automatic main release",
          `v${packageMetadata.version}`,
          true,
        );
        assert.equal(
          automaticMainRelease.status,
          0,
          automaticMainRelease.stderr,
        );
        const automaticState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          draft: boolean;
          tag: string;
        };
        assert.equal(automaticState.draft, false);
        assert.equal(
          automaticState.tag,
          `v${packageMetadata.version}`,
        );

        const resetAbsentRelease = async () => {
          for (const asset of await readdir(remoteAssets)) {
            await rm(path.join(remoteAssets, asset));
          }
          await writeFile(
            stateFile,
            JSON.stringify({
              exists: false,
              draft: false,
              tag: `v${packageMetadata.version}`,
              title: "",
              prerelease: false,
              tagExists: false,
              tagSha: null,
            }),
          );
        };

        await resetAbsentRelease();
        const transientlyHiddenCreatedTag = await execute(
          "created tag transiently hidden",
          `v${packageMetadata.version}`,
          true,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          0,
          undefined,
          undefined,
          undefined,
          2,
        );
        assert.equal(
          transientlyHiddenCreatedTag.status,
          0,
          transientlyHiddenCreatedTag.stderr,
        );
        const transientTagState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          draft: boolean;
          sleepCalls: string[];
          tagLookups: number;
        };
        assert.equal(transientTagState.draft, false);
        assert.deepEqual(transientTagState.sleepCalls, ["1", "1"]);
        assert.ok(transientTagState.tagLookups > 3);

        await resetAbsentRelease();
        const persistentlyHiddenCreatedTag = await execute(
          "created tag persistently hidden",
          `v${packageMetadata.version}`,
          true,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          0,
          undefined,
          undefined,
          undefined,
          10,
        );
        assert.notEqual(persistentlyHiddenCreatedTag.status, 0);
        assert.match(
          persistentlyHiddenCreatedTag.stderr,
          /did not become visible after creation/,
        );
        const persistentTagState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          exists: boolean;
          sleepCalls: string[];
          tagLookups: number;
        };
        assert.equal(persistentTagState.exists, false);
        assert.equal(persistentTagState.tagLookups, 11);
        assert.deepEqual(persistentTagState.sleepCalls, Array(9).fill("1"));
        assert.deepEqual(await readdir(remoteAssets), []);

        const assertHardPostCreateTagFailure = async (
          scenario: string,
          expectedError: RegExp,
          postCreateLookupFailure: boolean,
          createdTagSha?: string,
          createdTagKind?: string,
        ) => {
          await resetAbsentRelease();
          const failure = await execute(
            scenario,
            `v${packageMetadata.version}`,
            true,
            undefined,
            false,
            false,
            undefined,
            undefined,
            false,
            undefined,
            0,
            undefined,
            undefined,
            undefined,
            0,
            postCreateLookupFailure,
            createdTagSha,
            createdTagKind,
          );
          assert.notEqual(failure.status, 0);
          assert.match(failure.stderr, expectedError);
          const failureState = JSON.parse(
            await readFile(stateFile, "utf8"),
          ) as {
            exists: boolean;
            sleepCalls?: string[];
            tagLookups: number;
          };
          assert.equal(failureState.exists, false);
          assert.equal(failureState.tagLookups, 2);
          assert.deepEqual(failureState.sleepCalls ?? [], []);
          assert.deepEqual(await readdir(remoteAssets), []);
        };

        await assertHardPostCreateTagFailure(
          "post-create tag lookup fails",
          /Could not resolve release tag .* after creation/,
          true,
        );
        await assertHardPostCreateTagFailure(
          "created tag has malformed commit",
          /invalid commit SHA/,
          false,
          "short",
        );
        await assertHardPostCreateTagFailure(
          "created tag resolves to blob",
          /does not resolve directly to a commit/,
          false,
          sourceCommit,
          "blob",
        );
        await assertHardPostCreateTagFailure(
          "created tag resolves to wrong commit",
          /Release tag moved after authorization/,
          false,
          "3333333333333333333333333333333333333333",
        );

        await resetAbsentRelease();
        const transientlyHiddenRelease = await execute(
          "created release transiently hidden",
          `v${packageMetadata.version}`,
          true,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          2,
        );
        assert.equal(
          transientlyHiddenRelease.status,
          0,
          transientlyHiddenRelease.stderr,
        );
        const transientState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          draft: boolean;
          releaseLookups: number;
          sleepCalls: string[];
        };
        assert.equal(transientState.draft, false);
        assert.equal(transientState.releaseLookups, 4);
        assert.deepEqual(transientState.sleepCalls, ["1", "1"]);

        await resetAbsentRelease();
        const persistentlyHiddenRelease = await execute(
          "created release persistently hidden",
          `v${packageMetadata.version}`,
          true,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          5,
        );
        assert.notEqual(persistentlyHiddenRelease.status, 0);
        assert.match(
          persistentlyHiddenRelease.stderr,
          /disappeared during publication/,
        );
        const persistentState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          draft: boolean;
          releaseLookups: number;
          sleepCalls: string[];
        };
        assert.equal(persistentState.draft, true);
        assert.equal(persistentState.releaseLookups, 6);
        assert.deepEqual(persistentState.sleepCalls, ["1", "1", "1", "1"]);
        assert.deepEqual(await readdir(remoteAssets), []);

        for (const failureMode of [
          { name: "API", args: [2, undefined, undefined] },
          { name: "malformed", args: [undefined, 2, undefined] },
          { name: "duplicate", args: [undefined, undefined, 2] },
        ] as const) {
          await resetAbsentRelease();
          const failedReleaseLookup = await execute(
            `created release ${failureMode.name} lookup failure`,
            `v${packageMetadata.version}`,
            true,
            undefined,
            false,
            false,
            undefined,
            undefined,
            false,
            undefined,
            0,
            ...failureMode.args,
          );
          assert.notEqual(
            failedReleaseLookup.status,
            0,
            `${failureMode.name} failure unexpectedly succeeded`,
          );
          assert.match(
            failedReleaseLookup.stderr,
            new RegExp(
              `Could not resolve release v${packageMetadata.version.replaceAll(".", "\\.")}`,
            ),
          );
          const failedState = JSON.parse(
            await readFile(stateFile, "utf8"),
          ) as {
            draft: boolean;
            releaseLookups: number;
            sleepCalls?: string[];
          };
          assert.equal(failedState.draft, true);
          assert.equal(failedState.releaseLookups, 2);
          assert.deepEqual(failedState.sleepCalls ?? [], []);
          assert.deepEqual(await readdir(remoteAssets), []);
        }

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: false,
            draft: false,
            tag: `v${packageMetadata.version}`,
            title: "",
            prerelease: false,
            tagExists: false,
            tagSha: null,
          }),
        );
        const racedTagSha =
          "fedcba9876543210fedcba9876543210fedcba98";
        const racedTag = await execute(
          "concurrent tag created at wrong commit",
          `v${packageMetadata.version}`,
          true,
          racedTagSha,
        );
        assert.notEqual(racedTag.status, 0);
        assert.match(racedTag.stderr, /Release tag moved after authorization/);
        const racedState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as {
          exists: boolean;
          tagSha: string;
        };
        assert.equal(racedState.exists, false);
        assert.equal(racedState.tagSha, racedTagSha);

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: false,
            draft: false,
            tag: `v${packageMetadata.version}`,
            title: "",
            prerelease: false,
            tagExists: false,
            tagSha: null,
          }),
        );
        const disappearedManualTag = await execute(
          "manual tag disappears after authorization",
          `v${packageMetadata.version}`,
          false,
        );
        assert.notEqual(disappearedManualTag.status, 0);
        assert.match(
          disappearedManualTag.stderr,
          /disappeared after authorization/,
        );

        const failedTagCreation = await execute(
          "automatic tag creation fails",
          `v${packageMetadata.version}`,
          true,
          undefined,
          true,
        );
        assert.notEqual(failedTagCreation.status, 0);
        assert.match(
          failedTagCreation.stderr,
          /Could not create release tag/,
        );

        const exactConcurrentTag = await execute(
          "concurrent tag created at authorized commit",
          `v${packageMetadata.version}`,
          true,
          sourceCommit,
        );
        assert.equal(
          exactConcurrentTag.status,
          0,
          exactConcurrentTag.stderr,
        );

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: false,
            draft: false,
            tag: `v${packageMetadata.version}`,
            title: "",
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const lookupFailure = await execute(
          "authorized tag lookup fails",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          true,
        );
        assert.notEqual(lookupFailure.status, 0);
        assert.match(lookupFailure.stderr, /Could not resolve release tag/);

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagKind: "tag",
            tagObjectSha: "a".repeat(40),
            tagSha: sourceCommit,
          }),
        );
        const annotatedDereferenceFailure = await execute(
          "annotated tag dereference fails",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          false,
          undefined,
          undefined,
          true,
        );
        assert.notEqual(annotatedDereferenceFailure.status, 0);
        assert.match(
          annotatedDereferenceFailure.stderr,
          /Could not resolve release tag/,
        );

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const releaseLookupFailure = await execute(
          "initial release lookup fails",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          false,
          undefined,
          undefined,
          false,
          undefined,
          0,
          1,
        );
        assert.notEqual(releaseLookupFailure.status, 0);
        assert.match(
          releaseLookupFailure.stderr,
          new RegExp(
            `Could not resolve release v${packageMetadata.version.replaceAll(".", "\\.")}`,
          ),
        );

        const movedTagSha =
          "1111111111111111111111111111111111111111";
        await rm(path.join(remoteAssets, missingUploadAsset));
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const movedDuringUpload = await execute(
          "tag moves during upload",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          false,
          movedTagSha,
        );
        assert.notEqual(movedDuringUpload.status, 0);
        assert.match(
          movedDuringUpload.stderr,
          /Release tag moved after authorization/,
        );
        const uploadRaceState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(uploadRaceState.draft, true);

        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagKind: "commit",
            tagSha: sourceCommit,
          }),
        );
        const movedDuringEdit = await execute(
          "tag moves during publication edit",
          `v${packageMetadata.version}`,
          false,
          undefined,
          false,
          false,
          undefined,
          movedTagSha,
        );
        assert.notEqual(movedDuringEdit.status, 0);
        assert.match(
          movedDuringEdit.stderr,
          /Release tag moved after authorization/,
        );
        assert.match(
          movedDuringEdit.stderr,
          /returned to draft containment/,
        );
        const containedPublicationState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean; tagSha: string };
        assert.equal(containedPublicationState.draft, true);
        assert.equal(containedPublicationState.tagSha, movedTagSha);
        assert.equal(movedDuringEdit.releaseIdentity.publicationPatches, 1);
        assert.equal(movedDuringEdit.releaseIdentity.containmentPatches, 1);
        assert.equal(movedDuringEdit.releaseIdentity.patches, 2);

        const resetAuthorizedCompleteDraft = async (): Promise<void> => {
          await writeFile(
            stateFile,
            JSON.stringify({
              exists: true,
              draft: true,
              tag: `v${packageMetadata.version}`,
              title: `v${packageMetadata.version}`,
              prerelease: false,
              tagExists: true,
              tagKind: "commit",
              tagSha: sourceCommit,
            }),
          );
        };

        await resetAuthorizedCompleteDraft();
        const ambiguousPublication = await execute(
          "publication applied but response fails",
        );
        assert.notEqual(ambiguousPublication.status, 0);
        assert.match(
          ambiguousPublication.stderr,
          /Release publication update failed; enforcing draft containment/,
        );
        assert.match(
          ambiguousPublication.stderr,
          /returned to draft containment/,
        );
        const ambiguousPublicationState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(ambiguousPublicationState.draft, true);
        assert.equal(
          ambiguousPublication.releaseIdentity.publicationPatches,
          1,
        );
        assert.equal(
          ambiguousPublication.releaseIdentity.containmentPatches,
          1,
        );

        await resetAuthorizedCompleteDraft();
        const recoveredContainment = await execute(
          "publication applied, response fails, initial containment fails",
        );
        assert.notEqual(recoveredContainment.status, 0);
        assert.match(
          recoveredContainment.stderr,
          /Draft containment attempt 1 failed .* retrying/,
        );
        assert.match(
          recoveredContainment.stderr,
          /returned to draft containment/,
        );
        const recoveredContainmentState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(recoveredContainmentState.draft, true);
        assert.equal(
          recoveredContainment.releaseIdentity.publicationPatches,
          1,
        );
        assert.equal(
          recoveredContainment.releaseIdentity.containmentPatches,
          1,
        );

        await resetAuthorizedCompleteDraft();
        const unavailableContainment = await execute(
          "publication applied, response fails, containment remains unavailable",
        );
        assert.notEqual(unavailableContainment.status, 0);
        assert.match(
          unavailableContainment.stderr,
          /Publication state is unknown for pinned release id 4242\. Manually return this exact release id to draft before any retry/,
        );
        assert.match(
          unavailableContainment.stderr,
          /could not be verified/,
        );
        const unavailableContainmentState = JSON.parse(
          await readFile(stateFile, "utf8"),
        ) as { draft: boolean };
        assert.equal(unavailableContainmentState.draft, false);
        assert.equal(
          unavailableContainment.releaseIdentity.publicationPatches,
          1,
        );
        assert.equal(
          unavailableContainment.releaseIdentity.containmentPatches,
          0,
        );
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(state.draft, true);
        assert.match(result.stderr, /differs from the authorized tuple/);
        await assert.rejects(
          readFile(path.join(remoteAssets, missingUploadAsset)),
        );
      }
      } catch (error) {
        scenarioFailed = true;
        scenarioFailure = error;
      } finally {
        let scenarioCleanupFailure: unknown;
        try {
          assert.equal(path.dirname(temporary), ownedSimulatorRoot);
          assert.match(
            path.basename(temporary),
            /^(?:matching|mismatching)$/u,
          );
          assert.equal(await realpath(temporary), temporary);
          await rm(temporary, { recursive: true, force: true });
        } catch (error) {
          scenarioCleanupFailure = error;
        }
        const scenarioFailures = [
          ...(scenarioFailed ? [scenarioFailure] : []),
          ...(scenarioCleanupFailure === undefined
            ? []
            : [scenarioCleanupFailure]),
        ];
        if (scenarioFailures.length === 1) throw scenarioFailures[0];
        if (scenarioFailures.length > 1) {
          throw new AggregateError(
            scenarioFailures,
            `release scenario ${remoteMatches ? "matching" : "mismatching"} and cleanup both failed`,
          );
        }
      }
    }
    assert.deepEqual(
      await readFile(outsideSentinel),
      outsideSentinelBytes,
      "release scenarios mutated the outside sentinel",
    );
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (uploadServer !== undefined) {
      try {
        await uploadServer.stop(true);
        uploadAuthority = undefined;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    for (const ownedRoot of [simulatorRoot, outsideRoot]) {
      if (ownedRoot === undefined) continue;
      try {
        const expectedPrefix = ownedRoot === simulatorRoot
          ? "sana-publish-simulator-"
          : "sana-publish-outside-";
        assert.equal(path.dirname(ownedRoot), os.tmpdir());
        assert.match(path.basename(ownedRoot), new RegExp(`^${expectedPrefix}`));
        assert.equal(await realpath(ownedRoot), ownedRoot);
        await rm(ownedRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const failures = [
      ...(primaryFailed ? [primaryFailure] : []),
      ...cleanupFailures,
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "release simulator test and cleanup both failed",
      );
    }
  }
});
