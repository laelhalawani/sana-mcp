import { z } from "zod";
import { randomUUID } from "node:crypto";
import path from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  RELEASE_TARGETS,
  SOURCE_SEMANTIC_CAPABILITY,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  isReleaseSemver,
  type ReleaseTarget,
  type SemanticCapability,
} from "../release/contract.js";

export {
  RELEASE_TARGETS as SUPPORTED_COMPILE_TARGETS,
  SOURCE_SEMANTIC_CAPABILITY,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
};
export type {
  ReleaseTarget as SupportedCompileTarget,
  SemanticCapability,
};

declare const __SANA_BUILD_STANDALONE__: unknown;
declare const __SANA_BUILD_VERSION__: unknown;
declare const __SANA_BUILD_TARGET__: unknown;
declare const __SANA_INSTALLER_PROTOCOL__: unknown;
declare const __SANA_LIFECYCLE_PROTOCOL__: unknown;
declare const __SANA_INSPECT_PROTOCOL__: unknown;
declare const __SANA_SEMANTIC_CAPABILITY__: unknown;

const packageVersionSchema = z
  .string()
  .refine(isReleaseSemver, "must be a strict semantic version");

const compileTargetSchema = z.enum(RELEASE_TARGETS);

const standaloneMarkersSchema = z
  .object({
    standalone: z.literal(true),
    version: packageVersionSchema,
    target: compileTargetSchema,
    installerProtocol: z.literal(
      SUPPORTED_RELEASE_PROTOCOLS.installerProtocol,
    ),
    lifecycleProtocol: z.literal(
      SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol,
    ),
    inspectProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol),
    semanticCapability: z.literal(STANDALONE_SEMANTIC_CAPABILITY),
  })
  .strict();

export type BuildInfo =
  | Readonly<{
      mode: "source";
      standalone: false;
      version: string;
      target: null;
      installerProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.installerProtocol;
      lifecycleProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol;
      inspectProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol;
      semanticCapability: typeof SOURCE_SEMANTIC_CAPABILITY;
    }>
  | Readonly<{
      mode: "standalone";
      standalone: true;
      version: string;
      target: ReleaseTarget;
      installerProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.installerProtocol;
      lifecycleProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol;
      inspectProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol;
      semanticCapability: typeof STANDALONE_SEMANTIC_CAPABILITY;
    }>;

export interface BuildMarkers {
  readonly standalone?: unknown;
  readonly version?: unknown;
  readonly target?: unknown;
  readonly installerProtocol?: unknown;
  readonly lifecycleProtocol?: unknown;
  readonly inspectProtocol?: unknown;
  readonly semanticCapability?: unknown;
}

export class BuildIdentityError extends Error {
  readonly code = "INVALID_BUILD_IDENTITY";

  constructor(message: string, readonly issues?: readonly string[]) {
    super(message);
    this.name = "BuildIdentityError";
  }
}

function sourceBuildInfo(): BuildInfo {
  const version = packageVersionSchema.safeParse(packageMetadata.version);
  if (!version.success) {
    throw new BuildIdentityError("package.json contains an invalid version", [
      ...version.error.issues.map((issue) => issue.message),
    ]);
  }
  return Object.freeze({
    mode: "source",
    standalone: false,
    version: version.data,
    target: null,
    ...SUPPORTED_RELEASE_PROTOCOLS,
    semanticCapability: SOURCE_SEMANTIC_CAPABILITY,
  });
}

export function resolveBuildInfo(markers: BuildMarkers): BuildInfo {
  const values = Object.values(markers);
  const hasAnyMarker = values.some((value) => value !== undefined);
  if (!hasAnyMarker) return sourceBuildInfo();

  if (markers.standalone !== true) {
    throw new BuildIdentityError(
      "partial or non-standalone compile markers are not a valid build identity",
    );
  }

  const parsed = standaloneMarkersSchema.safeParse(markers);
  if (!parsed.success) {
    throw new BuildIdentityError(
      "standalone build identity is incomplete or invalid",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  if (parsed.data.version !== packageMetadata.version) {
    throw new BuildIdentityError(
      `standalone version ${parsed.data.version} does not match package version ${packageMetadata.version}`,
    );
  }
  return Object.freeze({
    mode: "standalone",
    ...parsed.data,
  });
}

function injectedBuildMarkers(): BuildMarkers {
  return {
    standalone:
      typeof __SANA_BUILD_STANDALONE__ === "undefined"
        ? undefined
        : __SANA_BUILD_STANDALONE__,
    version:
      typeof __SANA_BUILD_VERSION__ === "undefined" ? undefined : __SANA_BUILD_VERSION__,
    target: typeof __SANA_BUILD_TARGET__ === "undefined" ? undefined : __SANA_BUILD_TARGET__,
    installerProtocol:
      typeof __SANA_INSTALLER_PROTOCOL__ === "undefined"
        ? undefined
        : __SANA_INSTALLER_PROTOCOL__,
    lifecycleProtocol:
      typeof __SANA_LIFECYCLE_PROTOCOL__ === "undefined"
        ? undefined
        : __SANA_LIFECYCLE_PROTOCOL__,
    inspectProtocol:
      typeof __SANA_INSPECT_PROTOCOL__ === "undefined"
        ? undefined
        : __SANA_INSPECT_PROTOCOL__,
    semanticCapability:
      typeof __SANA_SEMANTIC_CAPABILITY__ === "undefined"
        ? undefined
        : __SANA_SEMANTIC_CAPABILITY__,
  };
}

export const BUILD_INFO = resolveBuildInfo(injectedBuildMarkers());

export function isStandaloneBuild(): boolean {
  return BUILD_INFO.standalone;
}

export function serializeStandaloneBuildInfoProperties(
  info: BuildInfo = BUILD_INFO,
): string {
  if (!info.standalone) {
    throw new BuildIdentityError(
      "release inspection properties are available only in a standalone build",
    );
  }
  return [
    `inspectProtocol=${info.inspectProtocol}`,
    `version=${info.version}`,
    `target=${info.target}`,
    `installerProtocol=${info.installerProtocol}`,
    `lifecycleProtocol=${info.lifecycleProtocol}`,
    `semanticCapability=${info.semanticCapability}`,
    "",
  ].join("\n");
}

export class BuildCommandError extends Error {
  readonly code = "INVALID_BUILD_COMMAND";

  constructor(message: string) {
    super(message);
    this.name = "BuildCommandError";
  }
}

export function parseCompileTarget(args: readonly string[]): ReleaseTarget {
  if (args[0] !== "compile") {
    throw new BuildCommandError(
      "Usage: bun src/runtime/build-info.ts compile --target <explicit-bun-target>",
    );
  }
  let rawTarget: string | undefined;
  if (args.length === 3 && args[1] === "--target") {
    rawTarget = args[2];
  } else if (args.length === 2 && args[1].startsWith("--target=")) {
    rawTarget = args[1].slice("--target=".length);
  } else {
    throw new BuildCommandError(
      "Usage: bun src/runtime/build-info.ts compile --target <explicit-bun-target>",
    );
  }
  const parsed = compileTargetSchema.safeParse(rawTarget);
  if (!parsed.success) {
    throw new BuildCommandError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

export const KEYWORD_STANDALONE_EXTERNALS = Object.freeze([
  "@huggingface/transformers",
  "sqlite-vec",
]);

export function createStandaloneBuildConfig(
  target: ReleaseTarget,
  outfile = "dist/sana-mcp",
): Bun.BuildConfig {
  return {
    entrypoints: ["src/cli.ts"],
    external: [...KEYWORD_STANDALONE_EXTERNALS],
    compile: {
      target,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
    bytecode: true,
    define: {
      __SANA_BUILD_STANDALONE__: "true",
      __SANA_BUILD_VERSION__: JSON.stringify(packageMetadata.version),
      __SANA_BUILD_TARGET__: JSON.stringify(target),
      __SANA_INSTALLER_PROTOCOL__: String(
        SUPPORTED_RELEASE_PROTOCOLS.installerProtocol,
      ),
      __SANA_LIFECYCLE_PROTOCOL__: String(
        SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol,
      ),
      __SANA_INSPECT_PROTOCOL__: String(
        SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol,
      ),
      __SANA_SEMANTIC_CAPABILITY__: JSON.stringify(
        STANDALONE_SEMANTIC_CAPABILITY,
      ),
    },
  };
}

export async function writeStandaloneBuildOutput(
  result: Bun.BuildOutput,
  outfile: string,
): Promise<void> {
  if (!result.success) {
    throw new BuildCommandError(
      `Standalone compilation failed: ${result.logs.map((log) => log.message).join("; ")}`,
    );
  }
  const entrypoints = result.outputs.filter(
    (artifact) => artifact.kind === "entry-point",
  );
  if (entrypoints.length !== 1) {
    throw new BuildCommandError(
      `Standalone compilation produced ${entrypoints.length} executable entry points`,
    );
  }
  if (!(await Bun.file(outfile).exists())) {
    throw new BuildCommandError(
      `Standalone compilation reported success but did not write ${outfile}`,
    );
  }
  if (Bun.file(outfile).size <= 0) {
    throw new BuildCommandError(
      `Standalone compilation wrote an empty file to ${outfile}`,
    );
  }
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(outfile, 0o755);
  }
}

async function compileStandalone(args: readonly string[]): Promise<void> {
  if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
    throw new BuildCommandError("Standalone compilation requires Bun");
  }
  const target = parseCompileTarget(args);
  const outfile = path.resolve(
    "dist",
    target.startsWith("bun-windows-") ? "sana-mcp.exe" : "sana-mcp",
  );
  const temporaryOutfile = `${outfile}.build-${randomUUID()}`;
  const { mkdir, rename, rm } = await import("node:fs/promises");
  await mkdir(path.dirname(outfile), { recursive: true });
  try {
    const result = await Bun.build(
      createStandaloneBuildConfig(target, temporaryOutfile),
    );
    await writeStandaloneBuildOutput(result, temporaryOutfile);
    await rename(temporaryOutfile, outfile);
  } finally {
    await rm(temporaryOutfile, { force: true });
  }
}

if (import.meta.main) {
  void compileStandalone(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
