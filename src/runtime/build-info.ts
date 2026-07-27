import { z } from "zod";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  RELEASE_TARGETS,
  SOURCE_SEMANTIC_CAPABILITY,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  isReleaseSemver,
  releaseTargetContract,
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
declare const __SANA_STATE_COMPATIBILITY__: unknown;
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
    stateCompatibility: z.literal(
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
    ),
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
      stateCompatibility: typeof SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility;
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
      stateCompatibility: typeof SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility;
      semanticCapability: typeof STANDALONE_SEMANTIC_CAPABILITY;
    }>;

export interface BuildMarkers {
  readonly standalone?: unknown;
  readonly version?: unknown;
  readonly target?: unknown;
  readonly installerProtocol?: unknown;
  readonly lifecycleProtocol?: unknown;
  readonly inspectProtocol?: unknown;
  readonly stateCompatibility?: unknown;
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
    stateCompatibility:
      typeof __SANA_STATE_COMPATIBILITY__ === "undefined"
        ? undefined
        : __SANA_STATE_COMPATIBILITY__,
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
    `stateCompatibility=${info.stateCompatibility}`,
    `semanticCapability=${info.semanticCapability}`,
    "",
  ].join("\n");
}

export class BuildCommandError extends Error {
  readonly code = "INVALID_BUILD_COMMAND";

  constructor(
    message: string,
    readonly details?:
      | Readonly<{
          kind: "host-mismatch";
          target: ReleaseTarget;
          expectedPlatform: string;
          expectedArchitecture: string;
          actualPlatform: string;
          actualArchitecture: string;
        }>
      | Readonly<{
          kind: "unsupported-windows-source-root";
          target: ReleaseTarget;
          workingDirectory: string;
          reason: string;
        }>,
  ) {
    super(message);
    this.name = "BuildCommandError";
  }
}

export function assertReleaseBuildHost(
  target: ReleaseTarget,
  identity: Readonly<{
    platform: string;
    architecture: string;
    workingDirectory: string;
  }>,
): void {
  const contract = releaseTargetContract(target);
  if (contract.platform !== "win32") return;
  if (
    identity.platform !== contract.platform ||
    identity.architecture !== contract.architecture
  ) {
    const details = Object.freeze({
      kind: "host-mismatch" as const,
      target,
      expectedPlatform: contract.platform,
      expectedArchitecture: contract.architecture,
      actualPlatform: identity.platform,
      actualArchitecture: identity.architecture,
    });
    throw new BuildCommandError(
      `Cannot build canonical Windows release target ${target} from Bun host ` +
        `${identity.platform}/${identity.architecture}; expected Bun host ` +
        `${contract.platform}/${contract.architecture}. Run this build with Bun ` +
        `on the matching Windows release host.`,
      details,
    );
  }

  const windowsDirectory = identity.workingDirectory.replaceAll("/", "\\");
  if (
    !windowsDirectory.startsWith("\\\\") ||
    /^\\\\\?\\[A-Za-z]:\\/u.test(windowsDirectory)
  ) {
    return;
  }

  const reason = "the source path is a UNC path";
  const details = Object.freeze({
    kind: "unsupported-windows-source-root" as const,
    target,
    workingDirectory: identity.workingDirectory,
    reason,
  });
  throw new BuildCommandError(
    `Cannot build canonical Windows release target ${target} from source ` +
      `directory ${identity.workingDirectory}: ${reason}. Copy the source to ` +
      `an ordinary directory on a local NTFS volume and run the build there ` +
      `with Windows x64 Bun.`,
    details,
  );
}

const windowsSourceRootProbe = String.raw`
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class SanaReleaseSourceRoot {
  private const uint FILE_READ_ATTRIBUTES = 0x80;
  private const uint FILE_SHARE_READ = 0x1;
  private const uint FILE_SHARE_WRITE = 0x2;
  private const uint FILE_SHARE_DELETE = 0x4;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint QueryDosDevice(
    string deviceName,
    StringBuilder targetPath,
    int maximumLength
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(
    SafeFileHandle file,
    StringBuilder filePath,
    uint filePathSize,
    uint flags
  );

  public static string DosDevice(string drive) {
    var target = new StringBuilder(32768);
    if (QueryDosDevice(drive, target, target.Capacity) == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return target.ToString();
  }

  public static string FinalPath(string directory) {
    using (var handle = CreateFile(
      directory,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero
    )) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      var target = new StringBuilder(32768);
      var length = GetFinalPathNameByHandle(
        handle,
        target,
        (uint)target.Capacity,
        0
      );
      if (length == 0 || length >= target.Capacity) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return target.ToString();
    }
  }
}
'@

function Get-DriveName([string] $Candidate) {
  $Match = [Text.RegularExpressions.Regex]::Match(
    $Candidate,
    '^(?:\\\\\?\\)?(?<drive>[A-Za-z]:)\\'
  )
  if (-not $Match.Success) {
    throw "the resolved source is not an extended or ordinary DOS drive path"
  }
  return $Match.Groups["drive"].Value.ToUpperInvariant()
}

function Assert-LocalNtfsDrive([string] $DriveName) {
  $Device = [SanaReleaseSourceRoot]::DosDevice($DriveName)
  if (-not $Device.StartsWith(
    "\Device\HarddiskVolume",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "drive $DriveName is mapped, substituted, or not backed by a local disk volume"
  }
  $Drive = [IO.DriveInfo]::new($DriveName + "\")
  if (-not $Drive.IsReady -or $Drive.DriveType -ne [IO.DriveType]::Fixed) {
    throw "drive $DriveName is not a ready fixed local volume"
  }
  if (-not [string]::Equals(
    $Drive.DriveFormat,
    "NTFS",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "drive $DriveName is not formatted as NTFS"
  }
}

$InputRoot = [Environment]::GetEnvironmentVariable(
  "SANA_RELEASE_SOURCE_ROOT",
  [EnvironmentVariableTarget]::Process
)
if ([string]::IsNullOrWhiteSpace($InputRoot)) {
  throw "the build process did not provide a source root"
}
$FullRoot = [IO.Path]::GetFullPath($InputRoot)
$RootItem = [IO.DirectoryInfo]::new($FullRoot)
if (-not $RootItem.Exists) {
  throw "the source root does not exist as a directory"
}

$Cursor = $RootItem
while ($null -ne $Cursor) {
  if (($Cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "the source path traverses reparse point $($Cursor.FullName)"
  }
  $Cursor = $Cursor.Parent
}

$LexicalDrive = Get-DriveName $FullRoot
Assert-LocalNtfsDrive $LexicalDrive
$FinalRoot = [SanaReleaseSourceRoot]::FinalPath($FullRoot)
$FinalDrive = Get-DriveName $FinalRoot
Assert-LocalNtfsDrive $FinalDrive

[PSCustomObject]@{
  finalPath = $FinalRoot
  drive = $FinalDrive
  fileSystem = "NTFS"
} | ConvertTo-Json -Compress
`;

const windowsSourceRootProofSchema = z
  .object({
    finalPath: z.string().min(1),
    drive: z.string().regex(/^[A-Z]:$/),
    fileSystem: z.literal("NTFS"),
  })
  .strict();

/**
 * Proves that the native Windows build is reading source from an ordinary
 * directory on a fixed NTFS volume. The native probe resolves the directory
 * by handle, rejects every lexical reparse point, and verifies both the
 * lexical and final DOS devices instead of trusting path spelling.
 */
export function assertWindowsReleaseSourceRoot(
  target: ReleaseTarget,
  identity: Readonly<{
    platform: string;
    workingDirectory: string;
  }>,
): void {
  if (releaseTargetContract(target).platform !== "win32") return;
  if (identity.platform !== "win32") return;

  const reject = (reason: string): never => {
    const details = Object.freeze({
      kind: "unsupported-windows-source-root" as const,
      target,
      workingDirectory: identity.workingDirectory,
      reason,
    });
    throw new BuildCommandError(
      `Cannot build canonical Windows release target ${target} from source ` +
        `directory ${identity.workingDirectory}: ${reason}. Copy the source ` +
        `to an ordinary directory on a local NTFS volume and run the build ` +
        `there with Windows x64 Bun.`,
      details,
    );
  };

  const windowsDirectory = identity.workingDirectory.replaceAll("/", "\\");
  if (
    windowsDirectory.startsWith("\\\\") &&
    !/^\\\\\?\\[A-Za-z]:\\/u.test(windowsDirectory)
  ) {
    reject("the source path is a UNC path");
  }

  let systemRoot: string | undefined;
  try {
    const buffer = new Uint16Array(32_768);
    const kernel = dlopen("kernel32.dll", {
      GetSystemWindowsDirectoryW: {
        args: [FFIType.ptr, FFIType.u32],
        returns: FFIType.u32,
      },
    });
    try {
      const length = kernel.symbols.GetSystemWindowsDirectoryW(
        ptr(buffer),
        buffer.length,
      );
      if (length === 0 || length >= buffer.length) {
        reject("Windows did not return its system directory");
      }
      systemRoot = Buffer.from(
        buffer.buffer,
        buffer.byteOffset,
        length * Uint16Array.BYTES_PER_ELEMENT,
      ).toString("utf16le");
    } finally {
      kernel.close();
    }
  } catch (error) {
    if (error instanceof BuildCommandError) throw error;
    reject(
      `the Windows system-directory API could not establish helper authority: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const authoritativeSystemRoot =
    systemRoot ?? reject("Windows did not return its system directory");
  if (
    !path.win32.isAbsolute(authoritativeSystemRoot) ||
    authoritativeSystemRoot.replaceAll("/", "\\").startsWith("\\\\")
  ) {
    reject("the Windows system-directory API returned a non-local path");
  }
  const powershell = path.win32.join(
    authoritativeSystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let requestedCanonicalRoot: string | undefined;
  try {
    for (
      let cursor: string | null = powershell;
      cursor !== null;
      cursor = path.win32.dirname(cursor) === cursor
        ? null
        : path.win32.dirname(cursor)
    ) {
      const item = lstatSync(cursor);
      if (item.isSymbolicLink()) {
        reject(`the authoritative Windows helper path traverses reparse point ${cursor}`);
      }
      if (cursor === powershell && (!item.isFile() || item.size <= 0)) {
        reject("the authoritative Windows helper is not an ordinary non-empty file");
      }
    }
    const canonicalSystemRoot = realpathSync.native(authoritativeSystemRoot);
    if (canonicalSystemRoot.toUpperCase() !== authoritativeSystemRoot.toUpperCase()) {
      reject("the Windows system directory resolves through an alias");
    }
    const canonicalPowerShell = realpathSync.native(powershell);
    if (canonicalPowerShell.toUpperCase() !== powershell.toUpperCase()) {
      reject("the authoritative Windows helper resolves through an alias");
    }
    requestedCanonicalRoot = realpathSync.native(identity.workingDirectory);
  } catch (error) {
    if (error instanceof BuildCommandError) throw error;
    reject(
      `the authoritative Windows helper or requested source could not be proven: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const authoritativeRequestedRoot =
    requestedCanonicalRoot ??
    reject("the requested source directory did not resolve canonically");
  const reservedEnvironmentNames = new Set([
    "SANA_RELEASE_SOURCE_ROOT",
    "SYSTEMROOT",
    "WINDIR",
  ]);
  const probeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !reservedEnvironmentNames.has(name.toUpperCase()),
    ),
  );
  probeEnvironment.SANA_RELEASE_SOURCE_ROOT = identity.workingDirectory;
  probeEnvironment.SystemRoot = authoritativeSystemRoot;
  probeEnvironment.WINDIR = authoritativeSystemRoot;
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(windowsSourceRootProbe, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: probeEnvironment,
    },
  );
  if (result.error !== undefined) {
    reject(`the Windows native backing probe could not execute: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    reject(
      detail.length === 0
        ? `the Windows native backing probe exited with status ${String(result.status)}`
        : `the Windows native backing probe rejected it: ${detail}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout.trim());
  } catch {
    reject("the Windows native backing probe returned invalid evidence");
  }
  const proof = windowsSourceRootProofSchema.safeParse(decoded);
  const proofData = proof.success
    ? proof.data
    : reject(
      `the Windows native backing probe returned invalid evidence: ${proof.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  const normalizeWindowsHandlePath = (value: string): string => {
    const windowsPath = value.replaceAll("/", "\\");
    const withoutExtendedPrefix = windowsPath.startsWith("\\\\?\\")
      ? windowsPath.slice("\\\\?\\".length)
      : windowsPath;
    return withoutExtendedPrefix.replace(/\\+$/u, "").toUpperCase();
  };
  if (
    normalizeWindowsHandlePath(proofData.finalPath) !==
    normalizeWindowsHandlePath(authoritativeRequestedRoot)
  ) {
    reject(
      "the Windows native backing proof is not bound to the requested source directory",
    );
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
      __SANA_STATE_COMPATIBILITY__: String(
        SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
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
  assertReleaseBuildHost(target, {
    platform: process.platform,
    architecture: process.arch,
    workingDirectory: process.cwd(),
  });
  assertWindowsReleaseSourceRoot(target, {
    platform: process.platform,
    workingDirectory: process.cwd(),
  });
  const isWindowsTarget = target.startsWith("bun-windows-");
  const outfile = path.resolve(
    "dist",
    isWindowsTarget ? "sana-mcp.exe" : "sana-mcp",
  );
  // Bun's standalone compiler appends ".exe" to a Windows target outfile that
  // does not already end in ".exe". Stage with the final extension so the
  // compiled artifact lands exactly at the staged path the guard verifies.
  const temporaryOutfile = `${outfile}.build-${randomUUID()}${
    isWindowsTarget ? ".exe" : ""
  }`;
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
