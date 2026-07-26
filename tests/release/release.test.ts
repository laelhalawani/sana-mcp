import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("release workflow binds every build and publish step to the authorized commit", async () => {
  const workflow = await readFile(
    path.join(process.cwd(), ".github/workflows/release.yml"),
    "utf8",
  );
  const parsedWorkflow = YAML.parse(workflow) as {
    jobs: Record<
      string,
      {
        needs?: string | string[];
        if?: string;
        steps?: Array<{
          name?: string;
          run?: string;
          uses?: string;
          with?: Record<string, unknown>;
        }>;
      }
    >;
  };
  const actionUses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)];
  assert.ok(actionUses.length > 0);
  for (const action of actionUses) {
    assert.match(action[1] ?? "", /^[a-f0-9]{40}$/);
  }
  assert.match(workflow, /push:\s*\n\s+tags: \["v\*"\]\s*\n\s+branches: \[main\]/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.sha \}\}/,
  );
  assert.match(workflow, /sha: \$\{\{ steps\.verify\.outputs\.sha \}\}/);
  assert.match(workflow, /skip: \$\{\{ steps\.verify\.outputs\.skip \}\}/);
  assert.match(
    workflow,
    /create_tag: \$\{\{ steps\.verify\.outputs\.create_tag \}\}/,
  );
  assert.match(
    workflow,
    /release_tag=\$package_tag[\s\S]*"repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$tag_name"[\s\S]*"repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$object_sha"/,
  );
  assert.match(workflow, /Tag \$release_tag does not match package version \$package_tag/);
  assert.ok(
    (
      workflow.match(
        /if: needs\.authorize\.outputs\.skip != 'true'/g,
      ) ?? []
    ).length >= 5,
  );
  assert.ok(
    (
      workflow.match(
        /ref: \$\{\{ needs\.authorize\.outputs\.sha \}\}/g,
      ) ?? []
    ).length >= 5,
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
    /verify_release_tag\(\)[\s\S]*resolve_tag_commit "\$RELEASE_TAG" "\$tag_probe_error"/,
  );
  assert.match(
    workflow,
    /verify_created_release_tag\(\)[\s\S]*tag_probe=1[\s\S]*"\$tag_status" -ne 2[\s\S]*"\$tag_probe" -ge 10[\s\S]*sleep 1/,
  );
  assert.doesNotMatch(
    workflow.match(/verify_release_tag\(\) \{[\s\S]*?\n\s+\}/)?.[0] ?? "",
    /sleep/,
  );
  assert.doesNotMatch(workflow, /repos\/\$GITHUB_REPOSITORY\/commits\/\$(?:release_tag|RELEASE_TAG)/);
  assert.match(
    workflow,
    /test "\$observed_tag_sha" = "\$SOURCE_SHA"/,
  );
  assert.match(
    workflow,
    /alpine:3\.22@sha256:[a-f0-9]{64}/,
  );
  assert.match(
    workflow,
    /apk add --no-cache libstdc\+\+ libgcc[\s\S]*"\$1" __inspect --format json[\s\S]*"\$1" --help/,
  );
  assert.match(workflow, /-v "\$PWD:\/work:ro"/);
  assert.match(workflow, /--target "\$SOURCE_SHA"/);
  assert.match(
    workflow,
    /"repos\/\$GITHUB_REPOSITORY\/git\/refs"[\s\S]*"ref=refs\/tags\/\$RELEASE_TAG"[\s\S]*"sha=\$SOURCE_SHA"/,
  );
  assert.match(workflow, /gh release create "\$RELEASE_TAG" \\\n\s+--verify-tag/);
  assert.match(
    workflow,
    /group: release-\$\{\{ needs\.authorize\.outputs\.tag \}\}/,
  );
  assert.doesNotMatch(workflow, /release\.target_commitish/);
  assert.match(workflow, /tag_without_build="\$\{RELEASE_TAG%%\+\*\}"/);
  assert.match(workflow, /Existing release title does not match/);
  assert.match(workflow, /prerelease classification is incorrect/);
  assert.match(workflow, /verify_remote_assets false/);
  assert.match(
    workflow,
    /gh api \\\n\s+--paginate \\\n\s+"repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100" \\\n\s+--slurp/,
  );
  assert.doesNotMatch(
    workflow,
    /repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG/,
  );
  assert.match(workflow, /missing_assets\+=\("release-assets\/\$asset"\)/);
  assert.match(
    workflow,
    /gh release upload "\$RELEASE_TAG" "\$\{missing_assets\[@\]\}"/,
  );
  assert.match(workflow, /verify_remote_assets true/);
  assert.match(workflow, /cmp -s "release-assets\/\$asset"/);
  assert.match(workflow, /already published with the authorized tuple/);
  assert.match(
    workflow,
    /verify_remote_assets true\s+verify_release_tag\s+gh release edit "\$RELEASE_TAG" --draft=false/,
  );
  assert.match(
    workflow,
    /gh release edit "\$RELEASE_TAG" --draft=false[\s\S]*verify_remote_assets true\s+verify_release_tag/,
  );

  const quality = parsedWorkflow.jobs.quality;
  assert.ok(quality);
  assert.equal(quality.needs, "authorize");
  assert.equal(quality.if, "needs.authorize.outputs.skip != 'true'");
  const qualityCheckout = quality.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@")
  );
  assert.deepEqual(qualityCheckout, {
    uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    with: {
      ref: "${{ needs.authorize.outputs.sha }}",
      "persist-credentials": false,
    },
  });
  const qualityBun = quality.steps?.find((step) =>
    step.uses?.startsWith("oven-sh/setup-bun@")
  );
  assert.deepEqual(qualityBun, {
    uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    with: {
      "bun-version": "1.3.14",
    },
  });
  assert.ok(
    quality.steps?.some(
      (step) => step.run === "bun install --frozen-lockfile --no-progress",
    ),
  );
  assert.ok(quality.steps?.some((step) => step.run === "bun run check"));

  assert.deepEqual(parsedWorkflow.jobs.publish?.needs, [
    "authorize",
    "quality",
    "linux",
    "macos",
    "windows",
  ]);

  const expectedWindowsRegressionCommand =
    "bun test --timeout 20000 tests/app/runtime.test.ts tests/core/status-auth.test.ts tests/install/apply.test.ts tests/install/atomic-config.test.ts tests/install/clients.test.ts tests/install/config-formats.test.ts tests/install/configurer-flow.test.ts tests/install/status.test.ts tests/install/writers.test.ts tests/runtime/secure-session.test.ts tests/runtime/secure-store.test.ts tests/sana/client.test.ts tests/sana/auth-request.test.ts tests/sana/auth.test.ts tests/sana/session-publication.test.ts tests/sync/daemon.test.ts tests/tools/dispatch-auth.test.ts tests/install/config-transaction.test.ts tests/install/config-transaction-flow.test.ts";
  const windowsSteps = parsedWorkflow.jobs.windows?.steps;
  assert.equal(
    windowsSteps?.find(
      (step) => step.name === "Run native Windows regression suite",
    )?.run,
    expectedWindowsRegressionCommand,
  );
  assert.equal(
    windowsSteps?.find(
      (step) => step.name === "Exercise the full native Windows installer replacement",
    )?.run,
    'bun test tests/install/installers.test.ts --test-name-pattern "Windows full installer replaces an active receipt-backed v0.4.5 mcp runtime"',
  );
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
        `exact_ref="repos/example/sana-mcp/git/ref/tags/v${packageMetadata.version}"`,
        'if [ "$2" = "$exact_ref" ]; then',
        'case "${FAKE_TAG_PROBE:-missing}" in',
        `  exists) if [ "\${FAKE_TAG_KIND:-commit}" = "tag" ]; then printf 'tag %s\\n' '${"a".repeat(40)}'; else printf 'commit %s\\n' "\${FAKE_TAG_SHA:-${sourceCommit}}"; fi; exit 0 ;;`,
        "  missing) echo 'HTTP 404: Not Found' >&2; exit 1 ;;",
        "  error) echo 'synthetic remote failure' >&2; exit 1 ;;",
        "  *) exit 64 ;;",
        "esac",
        "fi",
        `if [ "$2" = "repos/example/sana-mcp/git/tags/${"a".repeat(40)}" ]; then`,
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

// This executes many serialized fake-GitHub subprocess scenarios, including
// bounded visibility retries, so allow for process startup under full-suite load.
linuxOnlyTest("release publication resumes only a matching draft and re-verifies every asset", { timeout: 60_000 }, async () => {
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
  const afterPublish = publishScript.slice(
    publishScript.indexOf(
      'gh release edit "$RELEASE_TAG" --draft=false',
    ),
  );
  assert.match(
    afterPublish,
    /gh release edit "\$RELEASE_TAG" --draft=false[\s\S]*require_release[\s\S]*validate_release_identity[\s\S]*test "\$release_is_draft" = "false"[\s\S]*verify_remote_assets true/,
  );

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
          title: `v${packageMetadata.version}`,
          prerelease: false,
        }),
      );

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
        "if (args[0] === 'api' && args.includes('--method')) {",
        "  const state = load();",
        "  const requestedSha = args[args.indexOf('-f', args.indexOf('-f') + 1) + 1].slice('sha='.length);",
        "  if (process.env.FAKE_TAG_CREATE_FAIL === '1') { console.error('synthetic tag creation failure'); process.exit(1); }",
        "  const raceSha = process.env.FAKE_TAG_RACE_SHA;",
        "  state.tagExists = true; state.tagCreated = true;",
        "  state.tagSha = raceSha || process.env.FAKE_CREATED_TAG_SHA || requestedSha;",
        "  state.tagKind = process.env.FAKE_CREATED_TAG_KIND || 'commit';",
        "  state.tagVisibilityMisses = Number(process.env.FAKE_TAG_VISIBILITY_MISSES ?? '0');",
        "  save(state);",
        "  if (raceSha) { console.error('synthetic concurrent tag creation'); process.exit(1); }",
        "  process.stdout.write('{}'); process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1]?.includes('/git/ref/tags/')) {",
        "  if (process.env.FAKE_TAG_LOOKUP_ERROR === '1') { console.error('synthetic tag lookup failure'); process.exit(1); }",
        "  const state = load();",
        "  state.tagLookups = (state.tagLookups ?? 0) + 1; save(state);",
        "  if (state.tagCreated && process.env.FAKE_POST_CREATE_TAG_LOOKUP_ERROR === '1') { console.error('synthetic post-create tag lookup failure'); process.exit(1); }",
        "  if ((state.tagVisibilityMisses ?? 0) > 0) { state.tagVisibilityMisses -= 1; save(state); console.error('HTTP 404: Not Found'); process.exit(1); }",
        "  if (state.tagExists === false) { console.error('HTTP 404: Not Found'); process.exit(1); }",
        "  if (state.tagKind === 'tag') process.stdout.write(`tag ${state.tagObjectSha}\\n`);",
        "  else process.stdout.write(`${state.tagKind ?? 'commit'} ${state.tagSha ?? process.env.SOURCE_SHA}\\n`);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1]?.includes('/git/tags/')) {",
        "  const state = load();",
        "  if (process.env.FAKE_TAG_OBJECT_LOOKUP_ERROR === '1') { console.error('HTTP 404: Not Found'); process.exit(1); }",
        "  if (state.tagKind !== 'tag' || !args[1].endsWith(`/${state.tagObjectSha}`)) process.exit(66);",
        "  process.stdout.write(`commit ${state.tagSha ?? process.env.SOURCE_SHA}\\n`); process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1]?.includes('/commits/')) {",
        "  console.error('commit lookup must not be used as a tag lookup'); process.exit(67);",
        "}",
        "if (args[0] === 'api' && args.includes('--paginate')) {",
        "  const state = load();",
        "  state.releaseLookups = (state.releaseLookups ?? 0) + 1; save(state);",
        "  if (Number(process.env.FAKE_RELEASE_LOOKUP_FAILURE_AT) === state.releaseLookups) { console.error('synthetic release lookup failure'); process.exit(1); }",
        "  if (Number(process.env.FAKE_RELEASE_MALFORMED_AT) === state.releaseLookups) { process.stdout.write('['); process.exit(0); }",
        "  const releases = state.exists ? [{",
        "    tag_name: state.tag,",
        "    target_commitish: 'main',",
        "    draft: state.draft,",
        "    name: state.title,",
        "    prerelease: state.prerelease,",
        "    assets: readdirSync(assetsDir).map((name) => ({ name })),",
        "  }] : [];",
        "  if (Number(process.env.FAKE_RELEASE_DUPLICATE_AT) === state.releaseLookups && releases.length === 1) releases.push({ ...releases[0] });",
        "  if ((state.releaseVisibilityMisses ?? 0) > 0) { state.releaseVisibilityMisses -= 1; save(state); process.stdout.write(JSON.stringify([[], []])); process.exit(0); }",
        "  process.stdout.write(JSON.stringify([[], releases]));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') process.exit(68);",
        "if (args[0] !== 'release') process.exit(64);",
        "if (args[1] === 'download') {",
        "  const pattern = args[args.indexOf('--pattern') + 1];",
        "  const directory = args[args.indexOf('--dir') + 1];",
        "  copyFileSync(path.join(assetsDir, pattern), path.join(directory, pattern));",
        "  if (process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA) { const state = load(); state.tagSha = process.env.FAKE_MOVE_TAG_ON_DOWNLOAD_SHA; save(state); }",
        "  process.exit(0);",
        "}",
        "if (args[1] === 'upload') {",
        "  for (const file of args.slice(3)) copyFileSync(file, path.join(assetsDir, path.basename(file)));",
        "  if (process.env.FAKE_MOVE_TAG_ON_UPLOAD_SHA) { const state = load(); state.tagSha = process.env.FAKE_MOVE_TAG_ON_UPLOAD_SHA; save(state); }",
        "  process.exit(0);",
        "}",
        "if (args[1] === 'edit') {",
        "  const state = load(); state.draft = false;",
        "  if (process.env.FAKE_MOVE_TAG_ON_EDIT_SHA) state.tagSha = process.env.FAKE_MOVE_TAG_ON_EDIT_SHA;",
        "  save(state); process.exit(0);",
        "}",
        "if (args[1] === 'create') {",
        "  const state = load();",
        "  if (!args.includes('--verify-tag') || state.tagExists === false) process.exit(65);",
        "  state.exists = true; state.draft = true; state.tag = args[2];",
        "  state.title = args[args.indexOf('--title') + 1];",
        "  state.prerelease = args.includes('--prerelease');",
        "  state.releaseVisibilityMisses = Number(process.env.FAKE_RELEASE_VISIBILITY_MISSES ?? '0');",
        "  save(state); process.exit(0);",
        "}",
        "process.exit(64);",
        "",
      ].join("\n");
      await writeFile(path.join(commands, "gh"), fakeGh);
      await chmod(path.join(commands, "gh"), 0o755);
      await writeFile(
        path.join(commands, "sleep"),
        [
          "#!/usr/bin/env bun",
          'import { readFileSync, writeFileSync } from "node:fs";',
          "const stateFile = process.env.FAKE_RELEASE_STATE;",
          "if (!stateFile) process.exit(70);",
          "const state = JSON.parse(readFileSync(stateFile, 'utf8'));",
          "state.sleepCalls = [...(state.sleepCalls ?? []), ...process.argv.slice(2)];",
          "writeFileSync(stateFile, JSON.stringify(state));",
          "",
        ].join("\n"),
      );
      await chmod(path.join(commands, "sleep"), 0o755);

      const execute = (
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
      ) =>
        spawnSync("/bin/bash", ["-c", publishScript], {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${commands}:${process.env.PATH ?? ""}`,
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

        const movedPublishedTagSha =
          "2222222222222222222222222222222222222222";
        const publishedTagMovedDuringVerification = execute(
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
        ) as { tagSha?: string };
        assert.equal(publishedState.tagSha, movedPublishedTagSha);

        const buildMetadataTag = `v${packageMetadata.version}+build-x`;
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: false,
            tag: buildMetadataTag,
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
        const annotatedPublishedRerun = execute(annotatedTag);
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
        const automaticMainRelease = execute(
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
        const transientlyHiddenCreatedTag = execute(
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
        const persistentlyHiddenCreatedTag = execute(
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
          expectedError: RegExp,
          postCreateLookupFailure: boolean,
          createdTagSha?: string,
          createdTagKind?: string,
        ) => {
          await resetAbsentRelease();
          const failure = execute(
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
          /Could not resolve release tag .* after creation/,
          true,
        );
        await assertHardPostCreateTagFailure(
          /invalid commit SHA/,
          false,
          "short",
        );
        await assertHardPostCreateTagFailure(
          /does not resolve directly to a commit/,
          false,
          sourceCommit,
          "blob",
        );
        await assertHardPostCreateTagFailure(
          /Release tag moved after authorization/,
          false,
          "3333333333333333333333333333333333333333",
        );

        await resetAbsentRelease();
        const transientlyHiddenRelease = execute(
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
        assert.equal(transientState.releaseLookups, 6);
        assert.deepEqual(transientState.sleepCalls, ["1", "1"]);

        await resetAbsentRelease();
        const persistentlyHiddenRelease = execute(
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
          const failedReleaseLookup = execute(
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
        const racedTag = execute(
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
        const disappearedManualTag = execute(
          `v${packageMetadata.version}`,
          false,
        );
        assert.notEqual(disappearedManualTag.status, 0);
        assert.match(
          disappearedManualTag.stderr,
          /disappeared after authorization/,
        );

        const failedTagCreation = execute(
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

        const exactConcurrentTag = execute(
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
            tagSha: sourceCommit,
          }),
        );
        const lookupFailure = execute(
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
        const annotatedDereferenceFailure = execute(
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
            tagSha: sourceCommit,
          }),
        );
        const releaseLookupFailure = execute(
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
        await rm(path.join(remoteAssets, "b.sha256"));
        await writeFile(
          stateFile,
          JSON.stringify({
            exists: true,
            draft: true,
            tag: `v${packageMetadata.version}`,
            title: `v${packageMetadata.version}`,
            prerelease: false,
            tagExists: true,
            tagSha: sourceCommit,
          }),
        );
        const movedDuringUpload = execute(
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
            tagSha: sourceCommit,
          }),
        );
        const movedDuringEdit = execute(
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
