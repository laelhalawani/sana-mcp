import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import {
  RELEASE_MANIFEST_VERSION,
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  isReleaseTag,
  isReleaseCommit,
  releaseAssetName,
  releaseMetadataFileName,
  releaseTargetContract,
  type ReleaseTarget,
} from "../src/release/contract.js";
import {
  parseReleaseManifest,
  type ReleaseAsset,
  type ReleaseManifest,
} from "../src/install/manifest.js";
import {
  assertReleaseBuildHost,
  assertWindowsReleaseSourceRoot,
  createStandaloneBuildConfig,
  writeStandaloneBuildOutput,
} from "../src/runtime/build-info.js";
import {
  PINNED_MODEL_ID,
  PINNED_MODEL_REVISION,
} from "../src/semantic/model-cache.js";
import {
  STANDALONE_SEMANTIC_SMOKE_VERSION,
  standaloneSemanticSmokeEvidence,
} from "../src/semantic/smoke-contract.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

const inspectedBuildSchema = z
  .object({
    mode: z.literal("standalone"),
    standalone: z.literal(true),
    version: z.literal(packageMetadata.version),
    target: z.enum(RELEASE_TARGETS),
    installerProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.installerProtocol),
    lifecycleProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol),
    inspectProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol),
    stateCompatibility: z.literal(
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
    ),
    semanticCapability: z.literal(STANDALONE_SEMANTIC_CAPABILITY),
  })
  .strict();

const semanticSmokeSchema = z
  .object({
    smokeVersion: z.literal(STANDALONE_SEMANTIC_SMOKE_VERSION),
    model: z.literal(PINNED_MODEL_ID),
    revision: z.literal(PINNED_MODEL_REVISION),
    dimensions: z.tuple([z.literal(2), z.literal(384)]),
    vectorBackend: z.enum(["sqlite-vec", "portable"]),
    sqliteVec: z.enum(["v0.1.9", "not-loaded"]),
    nearest: z.literal("row-0"),
  })
  .strict();

const attestedSemanticSmokeSchema = semanticSmokeSchema.extend({
  target: z.enum(RELEASE_TARGETS),
  executedSha256: z.string().regex(sha256Pattern),
});

const attestationSchema = z
  .object({
    attestationVersion: z.literal(1),
    sourceCommit: z
      .string()
      .refine(isReleaseCommit, "must be a lowercase full Git commit SHA"),
    assetName: z.string(),
    sha256: z.string().regex(sha256Pattern),
    inspect: inspectedBuildSchema,
    semanticSmoke: attestedSemanticSmokeSchema,
  })
  .strict();

const uploadReleaseSchema = z
  .object({
    id: z.number().int().positive().safe(),
    upload_url: z.string().min(1),
  })
  .passthrough();

const uploadedAssetSchema = z
  .object({
    name: z.string(),
    state: z.literal("uploaded"),
    size: z.number().int().nonnegative().safe(),
  })
  .passthrough();

export type InspectedBuild = z.infer<typeof inspectedBuildSchema>;
export type ReleaseAttestation = z.infer<typeof attestationSchema>;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

function sha256Bytes(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function decodeInspectJson(input: string): InspectedBuild {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("standalone inspect output is not valid JSON");
  }
  const parsed = inspectedBuildSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `standalone inspect output is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function decodeSemanticSmokeJson(input: string): z.infer<typeof semanticSmokeSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("standalone semantic smoke output is not valid JSON");
  }
  const parsed = semanticSmokeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `standalone semantic smoke output is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function createAttestation(options: {
  readonly target: ReleaseTarget;
  readonly artifact: string;
  readonly inspectJson: string;
  readonly semanticSmokeJson: string;
  readonly sourceCommit: string;
  readonly executedSha256: string;
}): Promise<ReleaseAttestation> {
  const inspect = decodeInspectJson(options.inspectJson);
  const semanticSmokeOutput = decodeSemanticSmokeJson(options.semanticSmokeJson);
  if (inspect.target !== options.target) {
    throw new Error(
      `executed binary target ${inspect.target} does not match requested target ${options.target}`,
    );
  }
  const expectedVectorBackend = options.target.startsWith("bun-darwin-")
    ? "portable"
    : "sqlite-vec";
  if (
    semanticSmokeOutput.vectorBackend !== expectedVectorBackend ||
    semanticSmokeOutput.sqliteVec !==
      (expectedVectorBackend === "sqlite-vec" ? "v0.1.9" : "not-loaded")
  ) {
    throw new Error(
      `semantic smoke backend does not match release target ${options.target}`,
    );
  }
  const expectedName = releaseAssetName(options.target);
  if (!isReleaseCommit(options.sourceCommit)) {
    throw new Error("attestation source commit must be a lowercase full Git commit SHA");
  }
  if (path.basename(options.artifact) !== expectedName) {
    throw new Error(
      `artifact must be named ${expectedName} for target ${options.target}`,
    );
  }
  if (!sha256Pattern.test(options.executedSha256)) {
    throw new Error("executed artifact SHA-256 is invalid");
  }
  const artifactSha256 = await sha256File(options.artifact);
  if (artifactSha256 !== options.executedSha256) {
    throw new Error(
      "artifact bytes do not match the digest acquired around execution",
    );
  }
  const semanticSmoke = {
    ...semanticSmokeOutput,
    target: options.target,
    executedSha256: artifactSha256,
  } satisfies z.infer<typeof attestedSemanticSmokeSchema>;
  return Object.freeze({
    attestationVersion: 1,
    sourceCommit: options.sourceCommit,
    assetName: expectedName,
    sha256: artifactSha256,
    inspect,
    semanticSmoke,
  });
}

function checksumText(sha256: string, fileName: string): string {
  return `${sha256}  ${fileName}\n`;
}

function attestationFileName(target: ReleaseTarget): string {
  return `attestation-${target}.json`;
}

function canonicalAttestation(
  target: ReleaseTarget,
  sourceCommit: string,
  sha256: string,
): ReleaseAttestation {
  return Object.freeze({
    attestationVersion: 1 as const,
    sourceCommit,
    assetName: releaseAssetName(target),
    sha256,
    inspect: {
      mode: "standalone" as const,
      standalone: true as const,
      version: packageMetadata.version,
      target,
      ...SUPPORTED_RELEASE_PROTOCOLS,
      semanticCapability: STANDALONE_SEMANTIC_CAPABILITY,
    },
    semanticSmoke: {
      ...standaloneSemanticSmokeEvidence(
        target.startsWith("bun-darwin-") ? "portable" : "sqlite-vec",
      ),
      target,
      executedSha256: sha256,
    },
  });
}

function assertCurrentManifestAuthority(manifest: ReleaseManifest): void {
  if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION) {
    throw new Error("assembled manifest version is not the current project version");
  }
  if (manifest.packageVersion !== packageMetadata.version) {
    throw new Error("assembled package version is not the current package version");
  }
  if (manifest.releaseTag !== `v${packageMetadata.version}`) {
    throw new Error("assembled release tag is not the current package tag");
  }
  for (const [name, expected] of Object.entries(SUPPORTED_RELEASE_PROTOCOLS)) {
    if (manifest[name as keyof typeof SUPPORTED_RELEASE_PROTOCOLS] !== expected) {
      throw new Error(`assembled ${name} is not the current project value`);
    }
  }
  if (manifest.semanticCapability !== STANDALONE_SEMANTIC_CAPABILITY) {
    throw new Error(
      "assembled semantic capability is not the current standalone capability",
    );
  }
  const observedTargets = manifest.assets.map((asset) => asset.target);
  if (
    observedTargets.length !== RELEASE_TARGETS.length ||
    observedTargets.some((target, index) => target !== RELEASE_TARGETS[index])
  ) {
    throw new Error(
      "assembled assets are not the exact ordered canonical release target matrix",
    );
  }
}

export function releaseProperties(
  manifest: ReleaseManifest,
  asset: ReleaseAsset,
  manifestSha256: string,
  installer: Readonly<{
    assetName: "install.ps1" | "install.sh";
    sha256: string;
  }>,
): string {
  if (!sha256Pattern.test(manifestSha256)) {
    throw new Error("manifest SHA-256 is invalid");
  }
  const expectedInstaller = asset.target.startsWith("bun-windows-")
    ? "install.ps1"
    : "install.sh";
  if (installer.assetName !== expectedInstaller) {
    throw new Error(
      `installer asset must be ${expectedInstaller} for target ${asset.target}`,
    );
  }
  if (!sha256Pattern.test(installer.sha256)) {
    throw new Error("installer SHA-256 is invalid");
  }
  return [
    "format=sana-mcp-release-v1",
    `manifestVersion=${manifest.manifestVersion}`,
    `manifestSha256=${manifestSha256}`,
    `packageVersion=${manifest.packageVersion}`,
    `releaseTag=${manifest.releaseTag}`,
    `sourceCommit=${manifest.sourceCommit}`,
    `installerProtocol=${manifest.installerProtocol}`,
    `lifecycleProtocol=${manifest.lifecycleProtocol}`,
    `inspectProtocol=${manifest.inspectProtocol}`,
    `stateCompatibility=${manifest.stateCompatibility}`,
    `semanticCapability=${manifest.semanticCapability}`,
    `installerAssetName=${installer.assetName}`,
    `installerSha256=${installer.sha256}`,
    `target=${asset.target}`,
    ...(asset.libc === undefined ? [] : [`libc=${asset.libc}`]),
    `assetName=${asset.assetName}`,
    `checksumFileName=${asset.checksumFileName}`,
    `sha256=${asset.sha256}`,
    "",
  ].join("\n");
}

export async function assembleRelease(options: {
  readonly releaseTag: string;
  readonly sourceCommit: string;
  readonly artifactsDirectory: string;
  readonly outputDirectory: string;
  readonly repositoryRoot?: string;
}): Promise<ReleaseManifest> {
  if (
    !isReleaseTag(options.releaseTag) ||
    options.releaseTag !== `v${packageMetadata.version}`
  ) {
    throw new Error(
      `release tag must exactly equal package version v${packageMetadata.version}`,
    );
  }
  if (!isReleaseCommit(options.sourceCommit)) {
    throw new Error("release source commit must be a lowercase full Git commit SHA");
  }

  const expectedArtifactInventory = RELEASE_TARGETS.flatMap((target) => [
    releaseAssetName(target),
    attestationFileName(target),
  ]).sort();
  const observedArtifactInventory = (await readdir(
    options.artifactsDirectory,
  )).sort();
  if (
    observedArtifactInventory.length !== expectedArtifactInventory.length ||
    observedArtifactInventory.some(
      (name, index) => name !== expectedArtifactInventory[index],
    )
  ) {
    throw new Error(
      "release artifacts are not the exact attested canonical target matrix",
    );
  }

  const assets: ReleaseAsset[] = [];
  const attestations = new Map<ReleaseTarget, ReleaseAttestation>();
  for (const target of RELEASE_TARGETS) {
    const attestationFile = path.join(
      options.artifactsDirectory,
      attestationFileName(target),
    );
    const parsed = attestationSchema.safeParse(
      JSON.parse(await readFile(attestationFile, "utf8")) as unknown,
    );
    if (!parsed.success) {
      throw new Error(
        `invalid attestation for ${target}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (parsed.data.inspect.target !== target) {
      throw new Error(`attestation target mismatch for ${target}`);
    }
    if (parsed.data.sourceCommit !== options.sourceCommit) {
      throw new Error(`attestation source commit mismatch for ${target}`);
    }
    const assetName = releaseAssetName(target);
    if (parsed.data.assetName !== assetName) {
      throw new Error(`attestation asset mismatch for ${target}`);
    }
    const artifact = path.join(options.artifactsDirectory, assetName);
    const actualSha256 = await sha256File(artifact);
    if (actualSha256 !== parsed.data.sha256) {
      throw new Error(`artifact changed after execution evidence for ${target}`);
    }
    attestations.set(target, Object.freeze(parsed.data));
    const contract = releaseTargetContract(target);
    assets.push({
      target,
      ...(contract.libc === null ? {} : { libc: contract.libc }),
      assetName,
      checksumFileName: `${assetName}.sha256`,
      sha256: actualSha256,
    } as ReleaseAsset);
  }

  const manifest = parseReleaseManifest({
    manifestVersion: RELEASE_MANIFEST_VERSION,
    packageVersion: packageMetadata.version,
    releaseTag: options.releaseTag,
    sourceCommit: options.sourceCommit,
    ...SUPPORTED_RELEASE_PROTOCOLS,
    semanticCapability: STANDALONE_SEMANTIC_CAPABILITY,
    assets,
  });
  assertCurrentManifestAuthority(manifest);

  await mkdir(options.outputDirectory, { recursive: true });
  const root = options.repositoryRoot ?? process.cwd();
  const installerDigests = {
    "install.ps1": await sha256File(path.join(root, "install.ps1")),
    "install.sh": await sha256File(path.join(root, "install.sh")),
  } as const;
  for (const asset of manifest.assets) {
    const source = path.join(options.artifactsDirectory, asset.assetName);
    const destination = path.join(options.outputDirectory, asset.assetName);
    await copyFile(source, destination);
    if (!asset.assetName.endsWith(".exe")) await chmod(destination, 0o755);
    await writeFile(
      path.join(options.outputDirectory, asset.checksumFileName),
      checksumText(asset.sha256, asset.assetName),
      "utf8",
    );
    const attestation = attestations.get(asset.target);
    if (attestation === undefined) {
      throw new Error(`missing attested digest authority for ${asset.target}`);
    }
    await writeFile(
      path.join(options.outputDirectory, attestationFileName(asset.target)),
      `${JSON.stringify(attestation, null, 2)}\n`,
      "utf8",
    );
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(options.outputDirectory, "manifest.json");
  await writeFile(manifestPath, manifestText, "utf8");
  const manifestSha256 = await sha256File(manifestPath);
  await writeFile(
    path.join(options.outputDirectory, "manifest.json.sha256"),
    checksumText(manifestSha256, "manifest.json"),
    "utf8",
  );

  for (const asset of manifest.assets) {
    const metadataName = releaseMetadataFileName(asset.target);
    const metadataPath = path.join(options.outputDirectory, metadataName);
    await writeFile(
      metadataPath,
      releaseProperties(manifest, asset, manifestSha256, {
        assetName: asset.target.startsWith("bun-windows-")
          ? "install.ps1"
          : "install.sh",
        sha256: asset.target.startsWith("bun-windows-")
          ? installerDigests["install.ps1"]
          : installerDigests["install.sh"],
      }),
      "utf8",
    );
    await writeFile(
      `${metadataPath}.sha256`,
      checksumText(await sha256File(metadataPath), metadataName),
      "utf8",
    );
  }

  for (const relative of [
    "install.sh",
    "install.ps1",
    "release/manifest.schema.json",
  ]) {
    await copyFile(
      path.join(root, relative),
      path.join(options.outputDirectory, path.basename(relative)),
    );
    if (relative === "install.sh" || relative === "install.ps1") {
      const installerName = path.basename(relative) as
        | "install.sh"
        | "install.ps1";
      await writeFile(
        path.join(options.outputDirectory, `${installerName}.sha256`),
        checksumText(installerDigests[installerName], installerName),
        "utf8",
      );
    }
  }
  await verifyAssembledRelease({
    releaseTag: options.releaseTag,
    sourceCommit: options.sourceCommit,
    directory: options.outputDirectory,
    repositoryRoot: root,
  });
  return manifest;
}

export async function verifyAssembledRelease(options: {
  readonly releaseTag: string;
  readonly sourceCommit: string;
  readonly directory: string;
  readonly repositoryRoot?: string;
}): Promise<ReleaseManifest> {
  const manifestPath = path.join(options.directory, "manifest.json");
  const manifestInput = await readFile(manifestPath, "utf8");
  const manifest = parseReleaseManifest(
    JSON.parse(manifestInput) as unknown,
  );
  if (manifest.releaseTag !== options.releaseTag) {
    throw new Error("assembled release tag does not match the authorized tag");
  }
  if (manifest.sourceCommit !== options.sourceCommit) {
    throw new Error("assembled source commit does not match the authorized commit");
  }
  assertCurrentManifestAuthority(manifest);
  const canonicalManifestInput = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestInput !== canonicalManifestInput) {
    throw new Error("assembled manifest is not the canonical authorized encoding");
  }
  const expectedNames = [
    "install.ps1",
    "install.ps1.sha256",
    "install.sh",
    "install.sh.sha256",
    "manifest.json",
    "manifest.json.sha256",
    "manifest.schema.json",
    ...manifest.assets.flatMap((asset) => [
      attestationFileName(asset.target),
      asset.assetName,
      asset.checksumFileName,
      releaseMetadataFileName(asset.target),
      `${releaseMetadataFileName(asset.target)}.sha256`,
    ]),
  ].sort();
  const observed = (await readdir(options.directory)).sort();
  if (
    observed.length !== expectedNames.length ||
    observed.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("assembled release inventory is not the exact authorized tuple");
  }
  const manifestSha256 = await sha256File(manifestPath);
  if (
    await readFile(path.join(options.directory, "manifest.json.sha256"), "utf8") !==
    checksumText(manifestSha256, "manifest.json")
  ) {
    throw new Error("assembled manifest checksum file is invalid");
  }
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const installerDigests = {
    "install.ps1": await sha256File(path.join(repositoryRoot, "install.ps1")),
    "install.sh": await sha256File(path.join(repositoryRoot, "install.sh")),
  } as const;
  for (const asset of manifest.assets) {
    const attestationPath = path.join(
      options.directory,
      attestationFileName(asset.target),
    );
    let attestationInput: unknown;
    let attestationText: string;
    try {
      attestationText = await readFile(attestationPath, "utf8");
      attestationInput = JSON.parse(attestationText);
    } catch {
      throw new Error(`assembled attestation is invalid JSON for ${asset.target}`);
    }
    const attestation = attestationSchema.safeParse(attestationInput);
    if (!attestation.success) {
      throw new Error(
        `assembled attestation is invalid for ${asset.target}: ${attestation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    if (
      attestation.data.sourceCommit !== options.sourceCommit ||
      attestation.data.assetName !== asset.assetName ||
      attestation.data.sha256 !== asset.sha256 ||
      attestation.data.inspect.target !== asset.target
    ) {
      throw new Error(
        `assembled asset is not bound to its attested digest authority for ${asset.target}`,
      );
    }
    const expectedAttestationText = `${JSON.stringify(
      canonicalAttestation(asset.target, options.sourceCommit, asset.sha256),
      null,
      2,
    )}\n`;
    if (attestationText !== expectedAttestationText) {
      throw new Error(
        `assembled attestation is not the canonical digest authority for ${asset.target}`,
      );
    }
    if (
      await sha256File(path.join(options.directory, asset.assetName)) !==
      asset.sha256
    ) {
      throw new Error(`assembled asset digest mismatch for ${asset.target}`);
    }
    if (
      await readFile(
        path.join(options.directory, asset.checksumFileName),
        "utf8",
      ) !== checksumText(asset.sha256, asset.assetName)
    ) {
      throw new Error(`assembled checksum file mismatch for ${asset.target}`);
    }
    const metadataName = releaseMetadataFileName(asset.target);
    const installerName = asset.target.startsWith("bun-windows-")
      ? "install.ps1"
      : "install.sh";
    if (
      await readFile(path.join(options.directory, metadataName), "utf8") !==
      releaseProperties(manifest, asset, manifestSha256, {
        assetName: installerName,
        sha256: installerDigests[installerName],
      })
    ) {
      throw new Error(`assembled metadata differs from manifest for ${asset.target}`);
    }
    const metadataSha256 = await sha256File(
      path.join(options.directory, metadataName),
    );
    if (
      await readFile(
        path.join(options.directory, `${metadataName}.sha256`),
        "utf8",
      ) !== checksumText(metadataSha256, metadataName)
    ) {
      throw new Error(`assembled metadata checksum mismatch for ${asset.target}`);
    }
  }
  for (const installer of ["install.ps1", "install.sh"] as const) {
    const digest = await sha256File(path.join(options.directory, installer));
    if (digest !== installerDigests[installer]) {
      throw new Error(`assembled installer differs from source for ${installer}`);
    }
    if (
      await readFile(path.join(options.directory, `${installer}.sha256`), "utf8") !==
      checksumText(digest, installer)
    ) {
      throw new Error(`assembled installer checksum mismatch for ${installer}`);
    }
  }
  if (
    await sha256File(path.join(options.directory, "manifest.schema.json")) !==
    await sha256File(path.join(repositoryRoot, "release/manifest.schema.json"))
  ) {
    throw new Error("assembled manifest schema differs from the authorized source");
  }
  return manifest;
}

export async function assembledReleaseAuthority(options: {
  readonly releaseTag: string;
  readonly sourceCommit: string;
  readonly directory: string;
  readonly repositoryRoot?: string;
}): Promise<
  Readonly<{
    authorityVersion: 1;
    releaseTag: string;
    sourceCommit: string;
    files: readonly Readonly<{ name: string; sha256: string }>[];
  }>
> {
  const manifest = await verifyAssembledRelease(options);
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const installerDigests = {
    "install.ps1": await sha256File(path.join(repositoryRoot, "install.ps1")),
    "install.sh": await sha256File(path.join(repositoryRoot, "install.sh")),
  } as const;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256Bytes(manifestText);
  const authorities = new Map<string, string>([
    ["install.ps1", installerDigests["install.ps1"]],
    [
      "install.ps1.sha256",
      sha256Bytes(
        checksumText(installerDigests["install.ps1"], "install.ps1"),
      ),
    ],
    ["install.sh", installerDigests["install.sh"]],
    [
      "install.sh.sha256",
      sha256Bytes(checksumText(installerDigests["install.sh"], "install.sh")),
    ],
    ["manifest.json", manifestSha256],
    [
      "manifest.json.sha256",
      sha256Bytes(checksumText(manifestSha256, "manifest.json")),
    ],
    [
      "manifest.schema.json",
      await sha256File(path.join(repositoryRoot, "release/manifest.schema.json")),
    ],
  ]);
  for (const asset of manifest.assets) {
    const installerName = asset.target.startsWith("bun-windows-")
      ? "install.ps1"
      : "install.sh";
    const attestationText = `${JSON.stringify(
      canonicalAttestation(asset.target, options.sourceCommit, asset.sha256),
      null,
      2,
    )}\n`;
    const checksum = checksumText(asset.sha256, asset.assetName);
    const metadataName = releaseMetadataFileName(asset.target);
    const metadata = releaseProperties(manifest, asset, manifestSha256, {
      assetName: installerName,
      sha256: installerDigests[installerName],
    });
    authorities.set(attestationFileName(asset.target), sha256Bytes(attestationText));
    authorities.set(asset.assetName, asset.sha256);
    authorities.set(asset.checksumFileName, sha256Bytes(checksum));
    authorities.set(metadataName, sha256Bytes(metadata));
    authorities.set(
      `${metadataName}.sha256`,
      sha256Bytes(checksumText(sha256Bytes(metadata), metadataName)),
    );
  }
  const files = [...authorities]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, sha256]) => Object.freeze({ name, sha256 }));
  return Object.freeze({
    authorityVersion: 1 as const,
    releaseTag: options.releaseTag,
    sourceCommit: options.sourceCommit,
    files: Object.freeze(files),
  });
}

function requiredOption(
  args: readonly string[],
  name: string,
): string {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    const value = inline.slice(prefix.length);
    if (value.length > 0) return value;
  }
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`missing required ${name}`);
  }
  return value;
}

function exactTarget(value: string): ReleaseTarget {
  if (!RELEASE_TARGETS.includes(value as ReleaseTarget)) {
    throw new Error(`unsupported release target: ${value}`);
  }
  return value as ReleaseTarget;
}

export async function uploadReleaseAsset(
  options: Readonly<{
    releaseJson: string;
    repository: string;
    assetName: string;
    descriptor: number;
    expectedSha256: string;
    expectedUploadOrigin: string;
    authToken: string;
  }>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const repositorySegments = options.repository.split("/");
  if (
    repositorySegments.length !== 2 ||
    repositorySegments.some(
      (segment) =>
        !/^[A-Za-z0-9_.-]+$/u.test(segment) ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error("release upload repository is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(options.assetName)) {
    throw new Error("release upload asset name is invalid");
  }
  if (
    !Number.isSafeInteger(options.descriptor) ||
    options.descriptor < 3
  ) {
    throw new Error("release upload descriptor is invalid");
  }
  if (!sha256Pattern.test(options.expectedSha256)) {
    throw new Error("release upload expected digest is invalid");
  }
  let expectedUploadOrigin: URL;
  try {
    expectedUploadOrigin = new URL(options.expectedUploadOrigin);
  } catch {
    throw new Error("release upload origin authority is invalid");
  }
  if (
    expectedUploadOrigin.protocol !== "https:" ||
    expectedUploadOrigin.username !== "" ||
    expectedUploadOrigin.password !== "" ||
    expectedUploadOrigin.pathname !== "/" ||
    expectedUploadOrigin.search !== "" ||
    expectedUploadOrigin.hash !== "" ||
    expectedUploadOrigin.origin !== options.expectedUploadOrigin ||
    expectedUploadOrigin.href !== `${options.expectedUploadOrigin}/`
  ) {
    throw new Error("release upload origin authority is not an exact HTTPS origin");
  }
  let releaseInput: unknown;
  try {
    releaseInput = JSON.parse(options.releaseJson);
  } catch {
    throw new Error("release upload authority is not valid JSON");
  }
  const release = uploadReleaseSchema.parse(releaseInput);
  const expectedUploadTemplate =
    `${options.expectedUploadOrigin}/repos/${options.repository}` +
    `/releases/${release.id}/assets{?name,label}`;
  if (release.upload_url !== expectedUploadTemplate) {
    throw new Error(
      "release upload endpoint is not the exact expected origin, repository, release id, and raw path",
    );
  }
  if (!/^[\x21-\x7e]{1,1024}$/u.test(options.authToken)) {
    throw new Error("release upload authentication is unavailable");
  }
  const uploadUrl = new URL(
    release.upload_url.slice(0, -"{?name,label}".length),
  );
  uploadUrl.searchParams.set("name", options.assetName);
  const descriptorFile = Bun.file(options.descriptor, {
    type: "application/octet-stream",
  });
  const bytes = new Uint8Array(await descriptorFile.arrayBuffer());
  if (sha256Bytes(bytes) !== options.expectedSha256) {
    throw new Error("release upload descriptor differs from immutable authority");
  }
  const response = await fetchImpl(uploadUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.authToken}`,
      "Content-Type": "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: bytes,
  });
  if (response.status !== 201) {
    throw new Error(
      `release asset upload failed with HTTP status ${response.status}`,
    );
  }
  let responseInput: unknown;
  try {
    responseInput = await response.json();
  } catch {
    throw new Error("release asset upload returned invalid JSON");
  }
  const uploaded = uploadedAssetSchema.parse(responseInput);
  if (
    uploaded.name !== options.assetName ||
    uploaded.size !== bytes.byteLength
  ) {
    throw new Error("release asset upload response does not match the request");
  }
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "build") {
    const target = exactTarget(requiredOption(args, "--target"));
    assertReleaseBuildHost(target, {
      platform: process.platform,
      architecture: process.arch,
      workingDirectory: process.cwd(),
    });
    assertWindowsReleaseSourceRoot(target, {
      platform: process.platform,
      workingDirectory: process.cwd(),
    });
    const outfile = path.resolve(requiredOption(args, "--outfile"));
    if (await Bun.file(outfile).exists()) {
      throw new Error(`refusing to reuse an existing release artifact: ${outfile}`);
    }
    const result = await Bun.build(createStandaloneBuildConfig(target, outfile));
    await writeStandaloneBuildOutput(result, outfile);
    return;
  }
  if (command === "attest") {
    const target = exactTarget(requiredOption(args, "--target"));
    const artifact = requiredOption(args, "--artifact");
    const inspectFile = requiredOption(args, "--inspect-file");
    const output = requiredOption(args, "--output");
    const attestation = await createAttestation({
      target,
      artifact,
      inspectJson: await readFile(inspectFile, "utf8"),
      semanticSmokeJson: await readFile(
        requiredOption(args, "--semantic-smoke-file"),
        "utf8",
      ),
      sourceCommit: requiredOption(args, "--commit-sha"),
      executedSha256: requiredOption(args, "--executed-sha256"),
    });
    await writeFile(output, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    return;
  }
  if (command === "assemble") {
    await assembleRelease({
      releaseTag: requiredOption(args, "--tag"),
      sourceCommit: requiredOption(args, "--commit-sha"),
      artifactsDirectory: requiredOption(args, "--artifacts-dir"),
      outputDirectory: requiredOption(args, "--output-dir"),
    });
    return;
  }
  if (command === "verify-assembled") {
    await verifyAssembledRelease({
      releaseTag: requiredOption(args, "--tag"),
      sourceCommit: requiredOption(args, "--commit-sha"),
      directory: requiredOption(args, "--dir"),
    });
    return;
  }
  if (command === "assembled-authority") {
    const authority = await assembledReleaseAuthority({
      releaseTag: requiredOption(args, "--tag"),
      sourceCommit: requiredOption(args, "--commit-sha"),
      directory: requiredOption(args, "--dir"),
    });
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    return;
  }
  if (command === "upload-asset") {
    const descriptorText = requiredOption(args, "--fd");
    if (!/^[1-9][0-9]*$/u.test(descriptorText)) {
      throw new Error("release upload descriptor is invalid");
    }
    await uploadReleaseAsset({
      releaseJson: await readFile(
        requiredOption(args, "--release-json"),
        "utf8",
      ),
      repository: requiredOption(args, "--repository"),
      assetName: requiredOption(args, "--asset-name"),
      descriptor: Number(descriptorText),
      expectedSha256: requiredOption(args, "--expected-sha256"),
      expectedUploadOrigin: requiredOption(args, "--expected-origin"),
      authToken: process.env.GH_TOKEN ?? "",
    });
    return;
  }
  throw new Error(
    "Usage: bun scripts/release.ts <build|attest|assemble|verify-assembled|assembled-authority|upload-asset> [explicit options]",
  );
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
