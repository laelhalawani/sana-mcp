import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  RELEASE_MANIFEST_VERSION,
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  ReleaseManifestError,
  parseReleaseManifest,
  parseReleaseManifestJson,
  resolveManifestAsset,
  type ReleaseAsset,
  type ReleaseManifest,
} from "../../src/install/manifest.js";
import {
  RELEASE_SEMVER_PATTERN_SOURCE,
  RELEASE_TAG_PATTERN_SOURCE,
  RELEASE_COMMIT_PATTERN_SOURCE,
  RELEASE_TARGET_CONTRACTS,
  isReleaseSemver,
  isReleaseTag,
  releaseAssetName,
  releaseTargetContract,
} from "../../src/release/contract.js";
import {
  createStandaloneBuildConfig,
  resolveBuildInfo,
} from "../../src/runtime/build-info.js";

const fixtureUrl = (name: string): URL =>
  new URL(`../fixtures/manifest/${name}`, import.meta.url);

function fixture(name: string): string {
  return fs.readFileSync(fixtureUrl(name), "utf8");
}

const releaseSchema = JSON.parse(
  fs.readFileSync(
    new URL("../../release/manifest.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const semverCorpus = JSON.parse(
  fs.readFileSync(
    new URL("../../release/semver-corpus.json", import.meta.url),
    "utf8",
  ),
) as { valid: string[]; invalid: string[] };

function schemaTargetLibcRelationships(): Map<string, "glibc" | "musl" | null> {
  const schema = releaseSchema as {
    $defs: {
      asset: {
        allOf: Array<{
          if?: {
            properties?: { target?: { enum?: unknown[] } };
            required?: unknown[];
          };
          then?: {
            properties?: { libc?: { const?: unknown } };
            required?: unknown[];
            not?: { required?: unknown[] };
          };
        }>;
      };
    };
  };
  const relationships = new Map<string, "glibc" | "musl" | null>();
  for (const branch of schema.$defs.asset.allOf) {
    const targets = branch.if?.properties?.target?.enum;
    if (!Array.isArray(targets)) continue;
    const libc = branch.then?.properties?.libc?.const;
    const forbidsLibc =
      Array.isArray(branch.then?.not?.required) &&
      branch.then.not.required.includes("libc");
    if (libc !== "glibc" && libc !== "musl" && !forbidsLibc) continue;
    assert.deepEqual(branch.if?.required, ["target"]);
    let expectedLibc: "glibc" | "musl" | null;
    if (forbidsLibc) {
      expectedLibc = null;
      assert.equal(branch.then?.required, undefined);
    } else if (libc === "glibc" || libc === "musl") {
      expectedLibc = libc;
      assert.deepEqual(branch.then?.required, ["libc"]);
    }
    else throw new Error("schema libc relationship has no authoritative value");
    for (const target of targets) {
      if (typeof target !== "string") {
        throw new Error("schema target/libc relationship contains a non-string target");
      }
      assert.equal(
        relationships.has(target),
        false,
        `schema repeats the libc relationship for ${target}`,
      );
      relationships.set(target, expectedLibc);
    }
  }
  return relationships;
}

function validManifest(): ReleaseManifest {
  return parseReleaseManifestJson(fixture("valid-all-targets.json"));
}

function mutableCopy(manifest: ReleaseManifest): Record<string, unknown> {
  return structuredClone(manifest) as unknown as Record<string, unknown>;
}

function requiredDefinition(
  definitions: Record<string, string>,
  name: string,
): string {
  const value = definitions[name];
  assert.equal(typeof value, "string", `missing build definition ${name}`);
  return value;
}

function assertInvalid(
  value: unknown,
  expectedPath?: readonly (string | number)[],
): ReleaseManifestError {
  let thrown: unknown;
  try {
    parseReleaseManifest(value);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ReleaseManifestError);
  assert.equal(thrown.code, "INVALID_RELEASE_MANIFEST");
  if (expectedPath !== undefined) {
    assert.ok(
      thrown.issues.some(
        (issue) =>
          issue.path.length === expectedPath.length &&
          issue.path.every((part, index) => part === expectedPath[index]),
      ),
    );
  }
  return thrown;
}

function assertCompileTimeAssetNarrowing(asset: ReleaseAsset): void {
  switch (asset.target) {
    case "bun-linux-x64":
    case "bun-linux-arm64": {
      const libc: "glibc" = asset.libc;
      assert.equal(libc, "glibc");
      break;
    }
    case "bun-linux-x64-musl":
    case "bun-linux-arm64-musl": {
      const libc: "musl" = asset.libc;
      assert.equal(libc, "musl");
      break;
    }
    case "bun-darwin-x64":
    case "bun-darwin-arm64":
    case "bun-windows-x64": {
      const libc: undefined = asset.libc;
      assert.equal(libc, undefined);
      break;
    }
  }
}

const typeCheckFields = {
  assetName: "sana-mcp",
  checksumFileName: "sana-mcp.sha256",
  sha256: "0".repeat(64),
};

// @ts-expect-error A musl target cannot be represented with glibc.
const invalidMuslType: ReleaseAsset = {
  ...typeCheckFields,
  target: "bun-linux-x64-musl",
  libc: "glibc",
};

const invalidDarwinType: ReleaseAsset = {
  ...typeCheckFields,
  target: "bun-darwin-arm64",
  // @ts-expect-error A Darwin target cannot carry a libc field.
  libc: "glibc",
};

test("the published JSON Schema freezes the same version, fields, and target set", () => {
  const schema = releaseSchema as {
    additionalProperties: boolean;
    required: string[];
    properties: {
      manifestVersion: { const: number };
      packageVersion: { pattern: string };
      releaseTag: { pattern: string };
      sourceCommit: { pattern: string };
      installerProtocol: { const: number };
      lifecycleProtocol: { const: number };
      inspectProtocol: { const: number };
      semanticCapability: { const: string };
      assets: { maxItems: number };
    };
    $defs: { asset: { additionalProperties: boolean; properties: { target: { enum: string[] } } } };
    "x-sana-strict-parser-required": boolean;
  };

  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.asset.additionalProperties, false);
  assert.equal(
    schema.properties.manifestVersion.const,
    RELEASE_MANIFEST_VERSION,
  );
  assert.equal(
    schema.properties.packageVersion.pattern,
    RELEASE_SEMVER_PATTERN_SOURCE,
  );
  assert.equal(
    schema.properties.releaseTag.pattern,
    RELEASE_TAG_PATTERN_SOURCE,
  );
  assert.equal(
    schema.properties.sourceCommit.pattern,
    RELEASE_COMMIT_PATTERN_SOURCE,
  );
  assert.equal(
    schema.properties.installerProtocol.const,
    SUPPORTED_RELEASE_PROTOCOLS.installerProtocol,
  );
  assert.equal(
    schema.properties.lifecycleProtocol.const,
    SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol,
  );
  assert.equal(
    schema.properties.inspectProtocol.const,
    SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol,
  );
  assert.equal(
    schema.properties.semanticCapability.const,
    STANDALONE_SEMANTIC_CAPABILITY,
  );
  assert.equal(schema.properties.assets.maxItems, RELEASE_TARGETS.length);
  assert.deepEqual(schema.$defs.asset.properties.target.enum, RELEASE_TARGETS);
  assert.equal(schema["x-sana-strict-parser-required"], true);
  assert.deepEqual(schema.required, [
    "manifestVersion",
    "packageVersion",
    "releaseTag",
    "sourceCommit",
    "installerProtocol",
    "lifecycleProtocol",
    "inspectProtocol",
    "semanticCapability",
    "assets",
  ]);
});

test("the authoritative target tuple is immutable at runtime", () => {
  assert.ok(Object.isFrozen(RELEASE_TARGETS));
  assert.ok(Object.isFrozen(RELEASE_TARGET_CONTRACTS));
  assert.ok(RELEASE_TARGET_CONTRACTS.every(Object.isFrozen));
  const mutableView = RELEASE_TARGETS as unknown as string[];
  assert.throws(() => mutableView.push("bun-linux-invented"), TypeError);
  assert.throws(() => {
    mutableView[0] = "bun-linux-invented";
  }, TypeError);
  assert.equal(RELEASE_TARGETS[0], "bun-linux-x64");
  assert.equal(RELEASE_TARGETS.length, 7);
  assert.deepEqual(
    RELEASE_TARGET_CONTRACTS.map((contract) => contract.target),
    RELEASE_TARGETS,
  );
  const schemaRelationships = schemaTargetLibcRelationships();
  assert.equal(schemaRelationships.size, RELEASE_TARGET_CONTRACTS.length);
  for (const contract of RELEASE_TARGET_CONTRACTS) {
    assert.equal(schemaRelationships.get(contract.target), contract.libc);
  }
  const schemaAssetMappings = (
    releaseSchema as {
      $defs: {
        asset: {
          oneOf: Array<{
            properties: {
              target: { const: string };
              assetName: { const: string };
              checksumFileName: { const: string };
            };
          }>;
        };
      };
    }
  ).$defs.asset.oneOf;
  assert.deepEqual(
    schemaAssetMappings.map((mapping) => ({
      target: mapping.properties.target.const,
      assetName: mapping.properties.assetName.const,
      checksumFileName: mapping.properties.checksumFileName.const,
    })),
    RELEASE_TARGETS.map((target) => {
      const assetName = releaseAssetName(target);
      return {
        target,
        assetName,
        checksumFileName: `${assetName}.sha256`,
      };
    }),
  );
});

test("parses the versioned manifest and preserves every exact declared mapping", () => {
  const manifest = validManifest();
  const installerProtocol: 1 = manifest.installerProtocol;
  const lifecycleProtocol: 1 = manifest.lifecycleProtocol;
  const inspectProtocol: 1 = manifest.inspectProtocol;
  assert.equal(installerProtocol, 1);
  assert.equal(lifecycleProtocol, 1);
  assert.equal(inspectProtocol, 1);
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.packageVersion, "0.4.1");
  assert.equal(manifest.releaseTag, "v0.4.1");
  assert.equal(
    manifest.sourceCommit,
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(manifest.installerProtocol, 1);
  assert.equal(manifest.lifecycleProtocol, 1);
  assert.equal(manifest.inspectProtocol, 1);
  assert.equal(manifest.semanticCapability, "keyword");
  assert.deepEqual(
    manifest.assets.map((asset) => asset.target),
    RELEASE_TARGETS,
  );

  for (const declared of manifest.assets) {
    assertCompileTimeAssetNarrowing(declared);
    assert.deepEqual(resolveManifestAsset(manifest, declared.target), {
      state: "available",
      asset: declared,
    });
  }
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.assets));
  assert.ok(manifest.assets.every(Object.isFrozen));
});

test("manifest assets and standalone markers use the identical canonical target", () => {
  const manifest = validManifest();
  for (const asset of manifest.assets) {
    const build = createStandaloneBuildConfig(asset.target);
    const definitions = build.define;
    assert.ok(definitions);
    const embeddedTarget = JSON.parse(
      requiredDefinition(definitions, "__SANA_BUILD_TARGET__"),
    ) as unknown;
    assert.equal(embeddedTarget, asset.target);
    const identity = resolveBuildInfo({
      standalone: JSON.parse(
        requiredDefinition(definitions, "__SANA_BUILD_STANDALONE__"),
      ),
      version: JSON.parse(
        requiredDefinition(definitions, "__SANA_BUILD_VERSION__"),
      ),
      target: embeddedTarget,
      installerProtocol: JSON.parse(
        requiredDefinition(definitions, "__SANA_INSTALLER_PROTOCOL__"),
      ),
      lifecycleProtocol: JSON.parse(
        requiredDefinition(definitions, "__SANA_LIFECYCLE_PROTOCOL__"),
      ),
      inspectProtocol: JSON.parse(
        requiredDefinition(definitions, "__SANA_INSPECT_PROTOCOL__"),
      ),
      semanticCapability: JSON.parse(
        requiredDefinition(definitions, "__SANA_SEMANTIC_CAPABILITY__"),
      ),
    });
    assert.equal(identity.mode, "standalone");
    assert.equal(identity.target, asset.target);
  }
});

test("a target omitted from a valid partial release is explicitly unavailable", () => {
  const value = mutableCopy(validManifest());
  value.assets = (value.assets as unknown[]).slice(0, 1);
  const manifest = parseReleaseManifest(value);
  assert.deepEqual(resolveManifestAsset(manifest, "bun-darwin-x64"), {
    state: "unavailable",
    reason: "target-not-published",
    target: "bun-darwin-x64",
  });
  assert.deepEqual(resolveManifestAsset(manifest, "linux-x64"), {
    state: "invalid",
    reason: "invalid-target",
  });
  assert.deepEqual(resolveManifestAsset(manifest, null), {
    state: "invalid",
    reason: "invalid-target",
  });
});

test("rejects unknown manifest versions and fields at every level", () => {
  const unknownVersion = mutableCopy(validManifest());
  unknownVersion.manifestVersion = 2;
  assertInvalid(unknownVersion, ["manifestVersion"]);

  const rootField = mutableCopy(validManifest());
  rootField.mirror = "undeclared";
  assertInvalid(rootField);

  assertInvalid(JSON.parse(fixture("invalid-unknown-field.json")));
});

test("requires an exact v-prefixed release tag and valid semantic version", () => {
  for (const tag of semverCorpus.valid) {
    assert.equal(isReleaseTag(tag), true, tag);
    assert.equal(isReleaseSemver(tag.slice(1)), true, tag);
  }
  for (const tag of semverCorpus.invalid) {
    assert.equal(isReleaseTag(tag), false, tag);
  }
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha",
    "1.2.3-alpha.1+build.01",
  ]) {
    assert.equal(isReleaseSemver(version), true);
    assert.equal(isReleaseTag(`v${version}`), true);
    const value = mutableCopy(validManifest());
    value.packageVersion = version;
    value.releaseTag = `v${version}`;
    parseReleaseManifest(value);
  }

  for (const tag of ["0.3.2", "v0.3.1", "", "latest"]) {
    const value = mutableCopy(validManifest());
    value.releaseTag = tag;
    assertInvalid(value, ["releaseTag"]);
  }

  for (const version of [
    "01.2.3",
    "1.2",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3+meta..1",
    "1.2.3-alpha_1",
  ]) {
    const value = mutableCopy(validManifest());
    value.packageVersion = version;
    value.releaseTag = `v${version}`;
    assertInvalid(value, ["packageVersion"]);
  }
});

test("requires a lowercase full source commit without inventing one", () => {
  for (const sourceCommit of [
    "",
    "0".repeat(39),
    "0".repeat(41),
    "A".repeat(40),
    "not-a-commit".padEnd(40, "0"),
  ]) {
    const value = mutableCopy(validManifest());
    value.sourceCommit = sourceCommit;
    assertInvalid(value, ["sourceCommit"]);
  }
});

test("requires the exact supported protocols and standalone capability", () => {
  for (const field of [
    "installerProtocol",
    "lifecycleProtocol",
    "inspectProtocol",
  ] as const) {
    for (const invalid of [undefined, 0, -1, 1.5, 2, "1"]) {
      const value = mutableCopy(validManifest());
      if (invalid === undefined) delete value[field];
      else value[field] = invalid;
      assertInvalid(value, [field]);
    }
  }

  const value = mutableCopy(validManifest());
  value.semanticCapability = "semantic-if-available";
  assertInvalid(value, ["semanticCapability"]);

  const sourceSemantic = mutableCopy(validManifest());
  sourceSemantic.semanticCapability = "source-semantic";
  assertInvalid(sourceSemantic, ["semanticCapability"]);
});

test("validates target and libc as one authoritative identity", () => {
  const invalidCases: Array<
    [number, unknown, readonly (string | number)[]]
  > = [
    [0, undefined, ["assets", 0, "libc"]],
    [0, "musl", ["assets", 0, "libc"]],
    [1, "glibc", ["assets", 1, "libc"]],
    [4, "glibc", ["assets", 4, "libc"]],
  ];
  for (const [index, libc, expectedPath] of invalidCases) {
    const value = mutableCopy(validManifest());
    const asset = (value.assets as Array<Record<string, unknown>>)[index];
    if (libc === undefined) delete asset.libc;
    else asset.libc = libc;
    assertInvalid(value, expectedPath);
  }

  const explicitUndefined = mutableCopy(validManifest());
  (explicitUndefined.assets as Array<Record<string, unknown>>)[4].libc =
    undefined;
  assert.equal(
    Object.hasOwn(
      (explicitUndefined.assets as Array<Record<string, unknown>>)[4],
      "libc",
    ),
    true,
  );
  assertInvalid(explicitUndefined, ["assets", 4, "libc"]);

  const unknownTarget = mutableCopy(validManifest());
  (unknownTarget.assets as Array<Record<string, unknown>>)[0].target = "linux-x64";
  assertInvalid(unknownTarget, ["assets", 0, "target"]);
});

test("rejects unsafe, missing, mismatched, or platform-invalid filenames", () => {
  const cases: Array<[number, "assetName" | "checksumFileName", unknown]> = [
    [0, "assetName", "../sana-mcp"],
    [0, "assetName", ""],
    [0, "checksumFileName", "other.sha256"],
    [4, "assetName", "sana-mcp-darwin.exe"],
    [6, "assetName", "sana-mcp-windows-x64"],
  ];
  for (const [index, field, invalid] of cases) {
    const value = mutableCopy(validManifest());
    (value.assets as Array<Record<string, unknown>>)[index][field] = invalid;
    assertInvalid(value, ["assets", index, field]);
  }
});

test("rejects Win32 device aliases and canonically unsafe basenames", () => {
  for (const name of [
    ".",
    "..",
    "CON",
    "con.txt",
    "AUX",
    "prn.log",
    "NUL",
    "COM1.exe",
    "com9.bin",
    "LPT1",
    "lpt9.sha256",
    "safe.",
    "safe ",
  ]) {
    const value = mutableCopy(validManifest());
    const asset = (value.assets as Array<Record<string, unknown>>)[4];
    asset.assetName = name;
    asset.checksumFileName = `${name}.sha256`;
    assertInvalid(value, ["assets", 4, "assetName"]);
  }

  const reservedChecksum = mutableCopy(validManifest());
  (reservedChecksum.assets as Array<Record<string, unknown>>)[4].checksumFileName =
    "CON.sha256";
  assertInvalid(reservedChecksum, ["assets", 4, "checksumFileName"]);
});

test("rejects malformed digests and every duplicate mapping", () => {
  for (const digest of [
    "",
    "0".repeat(63),
    "A".repeat(64),
    "not-a-digest".padEnd(64, "0"),
  ]) {
    const value = mutableCopy(validManifest());
    (value.assets as Array<Record<string, unknown>>)[0].sha256 = digest;
    assertInvalid(value, ["assets", 0, "sha256"]);
  }

  for (const field of ["target", "assetName", "checksumFileName"] as const) {
    const value = mutableCopy(validManifest());
    const assets = value.assets as Array<Record<string, unknown>>;
    assets[1][field] = assets[0][field];
    if (field === "target") assets[1].libc = assets[0].libc;
    if (field === "assetName") {
      assets[1].checksumFileName = `${String(assets[0].assetName)}.sha256`;
    }
    assertInvalid(value, ["assets", 1, field]);
  }

  const caseCollision = mutableCopy(validManifest());
  const caseCollisionAssets = caseCollision.assets as Array<Record<string, unknown>>;
  caseCollisionAssets[1].assetName = String(
    caseCollisionAssets[0].assetName,
  ).toUpperCase();
  caseCollisionAssets[1].checksumFileName =
    `${String(caseCollisionAssets[1].assetName)}.sha256`;
  assertInvalid(caseCollision, ["assets", 1, "assetName"]);

  const crossKindCollision = mutableCopy(validManifest());
  const crossKindAssets = crossKindCollision.assets as Array<Record<string, unknown>>;
  crossKindAssets[1].assetName = crossKindAssets[0].checksumFileName;
  crossKindAssets[1].checksumFileName =
    `${String(crossKindAssets[1].assetName)}.sha256`;
  assertInvalid(crossKindCollision, ["assets", 1, "assetName"]);
});

test("malformed JSON has a distinct typed failure without parser details", () => {
  assert.throws(
    () => parseReleaseManifestJson('{"manifestVersion":'),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseManifestError);
      assert.equal(error.code, "INVALID_MANIFEST_JSON");
      assert.deepEqual(error.issues, [{ path: [], message: "JSON parsing failed" }]);
      return true;
    },
  );
});

test("strict parser rejects the corpus represented by schema constraints", () => {
  const invalidCorpus: Array<{
    name: string;
    mutate(value: Record<string, unknown>): void;
  }> = [
    { name: "unknown root field", mutate: (value) => { value.unknown = true; } },
    {
      name: "unknown asset field",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[0].unknown = true;
      },
    },
    { name: "unknown manifest version", mutate: (value) => { value.manifestVersion = 2; } },
    { name: "invalid package version", mutate: (value) => { value.packageVersion = "01.2.3"; } },
    { name: "invalid tag syntax", mutate: (value) => { value.releaseTag = "latest"; } },
    { name: "unsupported installer protocol", mutate: (value) => { value.installerProtocol = 2; } },
    { name: "unsupported lifecycle protocol", mutate: (value) => { value.lifecycleProtocol = 2; } },
    { name: "unsupported inspect protocol", mutate: (value) => { value.inspectProtocol = 2; } },
    { name: "unsupported semantic capability", mutate: (value) => { value.semanticCapability = "source-semantic"; } },
    { name: "empty asset set", mutate: (value) => { value.assets = []; } },
    {
      name: "too many assets",
      mutate: (value) => {
        const assets = value.assets as Array<Record<string, unknown>>;
        assets.push(structuredClone(assets[0]));
      },
    },
    {
      name: "identical asset",
      mutate: (value) => {
        const first = (value.assets as Array<Record<string, unknown>>)[0];
        value.assets = [first, structuredClone(first)];
      },
    },
    {
      name: "unknown target",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[0].target = "linux-x64";
      },
    },
    {
      name: "missing Linux libc",
      mutate: (value) => {
        delete (value.assets as Array<Record<string, unknown>>)[0].libc;
      },
    },
    {
      name: "wrong musl libc",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[1].libc = "glibc";
      },
    },
    {
      name: "libc on non-Linux",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[4].libc = "glibc";
      },
    },
    {
      name: "unsafe asset path",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[0].assetName = "../binary";
      },
    },
    {
      name: "reserved asset basename",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[4].assetName = "CON.txt";
      },
    },
    {
      name: "reserved checksum basename",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[4].checksumFileName =
          "LPT9.sha256";
      },
    },
    {
      name: "trailing dot alias",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[4].assetName = "binary.";
      },
    },
    {
      name: "invalid digest",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[0].sha256 = "0".repeat(63);
      },
    },
    {
      name: "Windows binary without exe",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[6].assetName =
          "sana-mcp-windows-x64";
      },
    },
    {
      name: "non-Windows binary with exe",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[4].assetName =
          "sana-mcp-darwin-x64.exe";
      },
    },
  ];

  for (const corpusCase of invalidCorpus) {
    const value = mutableCopy(validManifest());
    corpusCase.mutate(value);
    assert.throws(
      () => parseReleaseManifest(value),
      ReleaseManifestError,
      `${corpusCase.name} unexpectedly passed strict parsing`,
    );
  }
});

test("schema and parser enforce every canonical target/libc relationship", () => {
  const source = validManifest();
  const schemaRelationships = schemaTargetLibcRelationships();

  for (const [index, target] of RELEASE_TARGETS.entries()) {
    const contract = releaseTargetContract(target);
    assert.equal(schemaRelationships.get(target), contract.libc);
    assert.equal(source.assets[index]?.target, target);
    assert.equal(source.assets[index]?.libc, contract.libc ?? undefined);

    const valid = mutableCopy(source);
    const validAsset = (valid.assets as Array<Record<string, unknown>>)[index];
    validAsset.target = target;
    if (contract.libc === null) delete validAsset.libc;
    else validAsset.libc = contract.libc;
    parseReleaseManifest(valid);

    for (const invalidLibc of [
      undefined,
      "glibc",
      "musl",
    ] as const) {
      if (
        (contract.libc === null && invalidLibc === undefined) ||
        contract.libc === invalidLibc
      ) {
        continue;
      }
      const invalid = mutableCopy(source);
      const invalidAsset = (
        invalid.assets as Array<Record<string, unknown>>
      )[index];
      invalidAsset.target = target;
      if (invalidLibc === undefined) delete invalidAsset.libc;
      else invalidAsset.libc = invalidLibc;
      assert.throws(
        () => parseReleaseManifest(invalid),
        ReleaseManifestError,
        `${target}/${String(invalidLibc)} unexpectedly passed strict parsing`,
      );
    }
  }
});

test("schema-delegated relational violations fail strict parsing", () => {
  assert.equal(
    (releaseSchema as { "x-sana-strict-parser-required"?: unknown })[
      "x-sana-strict-parser-required"
    ],
    true,
  );
  const relationalCorpus: Array<{
    name: string;
    mutate(value: Record<string, unknown>): void;
  }> = [
    { name: "tag/version mismatch", mutate: (value) => { value.releaseTag = "v0.3.1"; } },
    {
      name: "checksum filename mismatch",
      mutate: (value) => {
        (value.assets as Array<Record<string, unknown>>)[0].checksumFileName =
          "different.sha256";
      },
    },
    {
      name: "duplicate target with distinct files",
      mutate: (value) => {
        const assets = value.assets as Array<Record<string, unknown>>;
        assets[1].target = assets[0].target;
        assets[1].libc = assets[0].libc;
      },
    },
    {
      name: "case-insensitive filename collision",
      mutate: (value) => {
        const assets = value.assets as Array<Record<string, unknown>>;
        assets[1].assetName = String(assets[0].assetName).toUpperCase();
        assets[1].checksumFileName = `${String(assets[1].assetName)}.sha256`;
      },
    },
    {
      name: "binary/checksum filename collision",
      mutate: (value) => {
        const assets = value.assets as Array<Record<string, unknown>>;
        assets[1].assetName = assets[0].checksumFileName;
        assets[1].checksumFileName = `${String(assets[1].assetName)}.sha256`;
      },
    },
  ];

  for (const corpusCase of relationalCorpus) {
    const value = mutableCopy(validManifest());
    corpusCase.mutate(value);
    assert.throws(
      () => parseReleaseManifest(value),
      ReleaseManifestError,
      `${corpusCase.name} unexpectedly passed strict parsing`,
    );
  }
});
