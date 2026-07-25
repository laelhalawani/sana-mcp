import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ensureWindowsPrivateRoot,
  type WindowsAclSetup,
} from "./windows-acl.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class SecurePathError extends Error {
  readonly code: string = "INSECURE_PATH";

  constructor(
    message: string,
    readonly target: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecurePathError";
  }
}

export class SecurePathManualActionError extends SecurePathError {
  override readonly code = "SECURE_PATH_MANUAL_ACTION";

  constructor(target: string, readonly action: string, options?: ErrorOptions) {
    super(`Secure permissions could not be verified for ${target}`, target, options);
    this.name = "SecurePathManualActionError";
  }
}

export interface SecureFileOptions {
  readonly platform?: NodeJS.Platform;
  /** Required authoritative Windows directory when Windows ACL setup is needed. */
  readonly systemRoot?: string;
  /** @internal Adapter injection for isolated platform tests. */
  readonly windowsAcl?: WindowsAclSetup;
  /** @internal Mount roots that must never be adopted as managed directories. */
  readonly mountPoints?: readonly string[];
}

interface FileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

function errno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function reparseOrLink(stats: fs.Stats): boolean {
  const reparseTag = (stats as fs.Stats & { reparsePointTag?: number })
    .reparsePointTag;
  return stats.isSymbolicLink() || (reparseTag !== undefined && reparseTag !== 0);
}

function comparable(target: string, platform: NodeJS.Platform): string {
  const resolved =
    platform === "win32"
      ? path.win32.resolve(target).replace(/[\\/]+$/, "")
      : path.resolve(target).replace(/\/+$/, "");
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isObservedMountBoundaryPath(
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return isFilesystemRootPath(target, platform);
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  if (parent === absolute) return true;
  try {
    const targetStats = fs.statSync(absolute);
    const parentStats = fs.statSync(parent);
    return targetStats.dev !== parentStats.dev;
  } catch (error) {
    if (errno(error, "ENOENT")) return false;
    throw new SecurePathError(
      "Could not inspect the managed path's filesystem boundary",
      absolute,
      { cause: error },
    );
  }
}

export function isFilesystemRootPath(
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolved =
    platform === "win32" ? path.win32.resolve(target) : path.resolve(target);
  const parsed =
    platform === "win32" ? path.win32.parse(resolved) : path.parse(resolved);
  return comparable(resolved, platform) === comparable(parsed.root, platform);
}

function assertManagedDirectoryTarget(
  target: string,
  options: SecureFileOptions,
): void {
  const platform = options.platform ?? process.platform;
  if (isFilesystemRootPath(target, platform)) {
    throw new SecurePathManualActionError(
      target,
      "Choose a private application directory instead of a filesystem root.",
    );
  }
  if (isObservedMountBoundaryPath(target, platform)) {
    throw new SecurePathManualActionError(
      target,
      "Choose a private subdirectory instead of adopting a mounted filesystem root.",
    );
  }
  for (const mountPoint of options.mountPoints ?? []) {
    if (comparable(target, platform) === comparable(mountPoint, platform)) {
      throw new SecurePathManualActionError(
        target,
        "Choose a private application directory instead of a mounted volume root.",
      );
    }
  }
}

function inspectDirectory(target: string): fs.Stats | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (errno(error, "ENOENT")) return undefined;
    throw new SecurePathError(
      "Could not inspect the managed directory",
      target,
      { cause: error },
    );
  }
  if (reparseOrLink(stats) || !stats.isDirectory()) {
    throw new SecurePathError(
      "Managed directory is a link, reparse point, or non-directory",
      target,
    );
  }
  return stats;
}

function inspectRegularFile(target: string): fs.Stats | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (errno(error, "ENOENT")) return undefined;
    throw new SecurePathError("Could not inspect the sensitive file", target, {
      cause: error,
    });
  }
  if (reparseOrLink(stats) || !stats.isFile()) {
    throw new SecurePathError(
      "Sensitive path is a link, reparse point, or non-regular file",
      target,
    );
  }
  return stats;
}

function existingComponents(target: string): string[] {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  const components: string[] = [];
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

function createAndCheckDirectory(target: string): void {
  const components = existingComponents(target);
  for (const component of components) {
    const existing = inspectDirectory(component);
    if (existing) continue;
    try {
      fs.mkdirSync(component, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (!errno(error, "EEXIST")) {
        throw new SecurePathError(
          "Could not create the private application directory",
          component,
          { cause: error },
        );
      }
    }
    inspectDirectory(component);
  }
  inspectDirectory(target);
}

function privateRoots(targets: readonly string[]): string[] {
  return targets.filter((candidate) => {
    return !targets.some((possibleParent) => {
      if (candidate === possibleParent) return false;
      const relative = path.relative(possibleParent, candidate);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    });
  });
}

export function ensureSecureDirectory(
  target: string,
  options: SecureFileOptions = {},
): void {
  ensureSecureDirectories([target], options);
}

export function ensureSecureDirectories(
  targets: readonly string[],
  options: SecureFileOptions = {},
): void {
  if (targets.length === 0) return;
  const absoluteTargets = [...new Set(targets.map((target) => path.resolve(target)))];
  for (const target of absoluteTargets) assertManagedDirectoryTarget(target, options);

  // Inspect all existing components before creating anything. This avoids a
  // partial setup when a later requested path is already unsafe.
  for (const target of absoluteTargets) {
    for (const component of existingComponents(target)) inspectDirectory(component);
  }
  for (const target of absoluteTargets) createAndCheckDirectory(target);

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    for (const root of privateRoots(absoluteTargets)) {
      const knownPaths = absoluteTargets.filter((candidate) => {
        const relative = path.relative(root, candidate);
        return (
          relative === "" ||
          (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
        );
      });
      try {
        (options.windowsAcl ?? ensureWindowsPrivateRoot)({
          root,
          knownPaths,
          systemRoot: options.systemRoot ?? process.env.SystemRoot,
        });
      } catch (error) {
        if (error instanceof SecurePathError) throw error;
        const detail =
          error instanceof Error ? error.message : "unknown adapter failure";
        throw new SecurePathManualActionError(
          root,
          `Windows private-storage ACL setup failed: ${detail}`,
          { cause: error },
        );
      }
    }
    for (const target of absoluteTargets) inspectDirectory(target);
    return;
  }

  for (const target of absoluteTargets) {
    try {
      fs.chmodSync(target, DIRECTORY_MODE);
    } catch (error) {
      throw new SecurePathError(
        "Could not restrict the private application directory to mode 0700",
        target,
        { cause: error },
      );
    }
    const stats = inspectDirectory(target);
    if (!stats || (stats.mode & 0o777) !== DIRECTORY_MODE) {
      throw new SecurePathError(
        "Private application directory permission verification failed",
        target,
      );
    }
  }
}

export function repairSensitiveFilePermissions(
  target: string,
  options: SecureFileOptions = {},
): void {
  repairSensitiveFilesPermissions([target], options);
}

export function repairSensitiveFilesPermissions(
  targets: readonly string[],
  options: SecureFileOptions = {},
): void {
  if (targets.length === 0) return;
  const platform = options.platform ?? process.platform;
  const absoluteTargets = targets.map((target) => path.resolve(target));
  const parents = [...new Set(absoluteTargets.map((target) => path.dirname(target)))];
  ensureSecureDirectories(parents, options);

  for (const target of absoluteTargets) {
    if (!inspectRegularFile(target)) {
      throw new SecurePathError("Sensitive file does not exist", target);
    }
    if (platform !== "win32") {
      try {
        fs.chmodSync(target, FILE_MODE);
      } catch (error) {
        throw new SecurePathError(
          "Could not restrict the sensitive file to mode 0600",
          target,
          { cause: error },
        );
      }
      const verified = inspectRegularFile(target);
      if (!verified || (verified.mode & 0o777) !== FILE_MODE) {
        throw new SecurePathError(
          "Sensitive file permission verification failed",
          target,
        );
      }
    }
  }
}

function openFlags(flags: string, platform: NodeJS.Platform): number {
  const c = fs.constants;
  const noFollow = platform === "win32" ? 0 : c.O_NOFOLLOW;
  switch (flags) {
    case "r":
      return c.O_RDONLY | noFollow;
    case "r+":
      return c.O_RDWR | noFollow;
    case "a":
      return c.O_WRONLY | c.O_APPEND | c.O_CREAT | noFollow;
    case "a+":
      return c.O_RDWR | c.O_APPEND | c.O_CREAT | noFollow;
    case "ax":
      return c.O_WRONLY | c.O_APPEND | c.O_CREAT | c.O_EXCL | noFollow;
    case "ax+":
      return c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_EXCL | noFollow;
    case "w":
      return c.O_WRONLY | c.O_CREAT | c.O_TRUNC | noFollow;
    case "w+":
      return c.O_RDWR | c.O_CREAT | c.O_TRUNC | noFollow;
    case "wx":
      return c.O_WRONLY | c.O_CREAT | c.O_EXCL | noFollow;
    case "wx+":
      return c.O_RDWR | c.O_CREAT | c.O_EXCL | noFollow;
    default:
      throw new TypeError(`Unsupported sensitive-file open mode: ${flags}`);
  }
}

export function openSensitiveFile(
  target: string,
  flags: string,
  options: SecureFileOptions = {},
): number {
  const absolute = path.resolve(target);
  const platform = options.platform ?? process.platform;
  ensureSecureDirectory(path.dirname(absolute), options);
  inspectRegularFile(absolute);

  let descriptor: number;
  try {
    descriptor = fs.openSync(absolute, openFlags(flags, platform), FILE_MODE);
  } catch (error) {
    if (errno(error, "ELOOP")) {
      throw new SecurePathError(
        "Sensitive file changed to a link before it could be opened",
        absolute,
        { cause: error },
      );
    }
    throw error;
  }

  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new SecurePathError(
        "Opened sensitive path is not a regular file",
        absolute,
      );
    }
    if (platform !== "win32") {
      fs.fchmodSync(descriptor, FILE_MODE);
      if ((fs.fstatSync(descriptor).mode & 0o777) !== FILE_MODE) {
        throw new SecurePathError(
          "Opened sensitive file permission verification failed",
          absolute,
        );
      }
    }
    return descriptor;
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `Sensitive-file open and cleanup failed for ${absolute}`,
      );
    }
    throw error;
  }
}

function snapshot(stats: fs.BigIntStats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
  };
}

function snapshotPath(target: string): FileSnapshot | undefined {
  const stats = inspectRegularFile(target);
  return stats ? snapshot(fs.lstatSync(target, { bigint: true })) : undefined;
}

function snapshotsEqual(
  left: FileSnapshot | undefined,
  right: FileSnapshot | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function fsyncDirectory(directory: string, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  let descriptor: number | undefined;
  let operationError: unknown;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!errno(error, "EINVAL") && !errno(error, "ENOTSUP")) {
      operationError = error;
    }
  }
  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      `Private-directory flush and descriptor cleanup failed for ${directory}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

export interface AtomicWriteOptions extends SecureFileOptions {
  /** Refuse publication if the observed destination changes while writing. */
  readonly rejectObservedChange?: boolean;
}

export function writePrivateFileAtomic(
  target: string,
  contents: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const absolute = path.resolve(target);
  const directory = path.dirname(absolute);
  const platform = options.platform ?? process.platform;
  ensureSecureDirectory(directory, options);
  const initial = snapshotPath(absolute);
  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.tmp.${process.pid}.${crypto.randomUUID()}`,
  );
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSensitiveFile(temporary, "wx", options);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const current = snapshotPath(absolute);
    if (
      options.rejectObservedChange !== false &&
      !snapshotsEqual(initial, current)
    ) {
      throw new SecurePathManualActionError(
        absolute,
        "The destination changed while the replacement was being prepared. Preserve both versions and retry.",
      );
    }
    inspectDirectory(directory);
    fs.renameSync(temporary, absolute);
    published = true;
    if (platform !== "win32") {
      fs.chmodSync(absolute, FILE_MODE);
      const verified = inspectRegularFile(absolute);
      if (!verified || (verified.mode & 0o777) !== FILE_MODE) {
        throw new SecurePathError(
          "Published sensitive file permission verification failed",
          absolute,
        );
      }
    } else {
      inspectRegularFile(absolute);
    }
    fsyncDirectory(directory, platform);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (!published) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        if (!errno(cleanupError, "ENOENT")) cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Atomic private-file write and cleanup failed for ${absolute}`,
      );
    }
    throw error;
  }
}

export {
  CorruptJsonFileError,
  CorruptJsonPreservationError,
  InvalidJsonValueError,
  JsonFileTooLargeError,
  readJsonFile,
  writeJsonAtomic,
  type ReadJsonOptions,
  type ReadJsonResult,
} from "./private-json.js";
