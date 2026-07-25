import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
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
  createStandaloneBuildConfig,
  writeStandaloneBuildOutput,
} from "../src/runtime/build-info.js";

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

const attestationSchema = z
  .object({
    attestationVersion: z.literal(1),
    sourceCommit: z
      .string()
      .refine(isReleaseCommit, "must be a lowercase full Git commit SHA"),
    assetName: z.string(),
    sha256: z.string().regex(sha256Pattern),
    inspect: inspectedBuildSchema,
  })
  .strict();

export type InspectedBuild = z.infer<typeof inspectedBuildSchema>;
export type ReleaseAttestation = z.infer<typeof attestationSchema>;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
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

export async function createAttestation(options: {
  readonly target: ReleaseTarget;
  readonly artifact: string;
  readonly inspectJson: string;
  readonly sourceCommit: string;
}): Promise<ReleaseAttestation> {
  const inspect = decodeInspectJson(options.inspectJson);
  if (inspect.target !== options.target) {
    throw new Error(
      `executed binary target ${inspect.target} does not match requested target ${options.target}`,
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
  return Object.freeze({
    attestationVersion: 1,
    sourceCommit: options.sourceCommit,
    assetName: expectedName,
    sha256: await sha256File(options.artifact),
    inspect,
  });
}

function checksumText(sha256: string, fileName: string): string {
  return `${sha256}  ${fileName}\n`;
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

  const assets: ReleaseAsset[] = [];
  for (const target of RELEASE_TARGETS) {
    const attestationFile = path.join(
      options.artifactsDirectory,
      `attestation-${target}.json`,
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
  return manifest;
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

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "build") {
    const target = exactTarget(requiredOption(args, "--target"));
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
      sourceCommit: requiredOption(args, "--commit-sha"),
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
  throw new Error(
    "Usage: bun scripts/release.ts <build|attest|assemble> [explicit options]",
  );
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
