import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundedErrorText } from "./error-text.js";

export interface ConfigSnapshot {
  exists: boolean;
  raw: string;
  mode?: number;
}

export type AtomicConfigResult =
  | {
      state: "published";
      durability: "verified" | "uncertain";
      warning?: string;
    }
  | { state: "conflict"; reason: string }
  | { state: "ambiguous"; reason: string }
  | { state: "failed"; reason: string };

export type AtomicConfigRemovalResult =
  | {
      state: "removed";
      durability: "verified" | "uncertain";
      warning?: string;
    }
  | { state: "conflict" | "ambiguous" | "failed"; reason: string };

export type TemporaryWriteResult =
  { state: "written" } | { state: "failed"; owned: boolean; error: unknown };

export interface AtomicConfigOperations {
  readonly platform: NodeJS.Platform;
  createParent(parent: string): void;
  assertBoundary(file: string): void;
  temporaryPath(parent: string, targetLeaf: string): string;
  writeAndFlushTemporary(
    temporary: string,
    candidate: string,
    mode: number,
  ): TemporaryWriteResult;
  readSnapshot(file: string): ConfigSnapshot;
  rename(source: string, destination: string): void;
  unlink(file: string): void;
  readPublished(file: string): string;
  flushParent(parent: string): string | undefined;
  removeTemporary(file: string): string | undefined;
}

const errorText = boundedErrorText;

function assertFinalParentDirectory(file: string): void {
  const parent = path.dirname(path.resolve(file));
  const stat = fs.lstatSync(parent);
  if (stat.isSymbolicLink())
    throw new Error(`${parent} is a symbolic link or reparse point`);
  if (!stat.isDirectory()) throw new Error(`${parent} is not a directory`);
}

function assertFinalTarget(file: string): void {
  try {
    const stat = fs.lstatSync(path.resolve(file));
    if (stat.isSymbolicLink())
      throw new Error(
        `${path.resolve(file)} is a symbolic link or reparse point`,
      );
    if (!stat.isFile())
      throw new Error(`${path.resolve(file)} is not a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readConfigSnapshot(file: string): ConfigSnapshot {
  const absolute = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, raw: "" };
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Error(`${absolute} is a symbolic link or reparse point`);
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  return {
    exists: true,
    raw: fs.readFileSync(absolute, "utf8"),
    // Windows ACLs are not representable as a POSIX mode. Transactions compare
    // and restore the byte image there; POSIX includes the normalized mode.
    ...(process.platform === "win32" ? {} : { mode: stat.mode & 0o777 }),
  };
}

function sameObservedSnapshot(
  expected: ConfigSnapshot,
  observed: ConfigSnapshot,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    expected.exists === observed.exists &&
    (!expected.exists ||
      (expected.raw === observed.raw &&
        (platform === "win32" || expected.mode === observed.mode)))
  );
}

const WINDOWS_FILE_RETRY_ATTEMPTS = 3;

function isRetryableWindowsFileError(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

function waitForWindowsFileRetry(): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, 5);
}

/**
 * Retry the short-lived EPERM/EBUSY failures produced by Windows file scanners.
 * `beforeRetry` must revalidate any optimistic precondition immediately before
 * another mutating attempt.
 */
export function retryWindowsFileOperation<T>(
  operation: () => T,
  beforeRetry: () => void = () => {},
  platform: NodeJS.Platform = process.platform,
): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (
        attempt >= WINDOWS_FILE_RETRY_ATTEMPTS ||
        !isRetryableWindowsFileError(error, platform)
      )
        throw error;
      waitForWindowsFileRetry();
      beforeRetry();
    }
  }
}

class OptimisticConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConfigConflictError";
  }
}

function flushDirectory(parent: string): string | undefined {
  let descriptor: number | undefined;
  let warning: string | undefined;
  try {
    descriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    warning = `directory durability could not be verified: ${errorText(error)}`;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        const closeWarning = `directory flush handle could not be closed cleanly: ${errorText(
          error,
        )}`;
        warning = warning ? `${warning}; ${closeWarning}` : closeWarning;
      }
    }
  }
  return warning;
}

function removeTemporary(file: string): string | undefined {
  try {
    retryWindowsFileOperation(
      () => fs.unlinkSync(file),
      undefined,
      process.platform,
    );
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `temporary cleanup failed for ${file}: ${errorText(error)}`;
  }
}

function writeAndFlushTemporary(
  temporary: string,
  candidate: string,
  mode: number,
): TemporaryWriteResult {
  let descriptor: number | undefined;
  let failure: unknown;
  let owned = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      mode,
    );
    owned = true;
    fs.writeFileSync(descriptor, candidate, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "temporary write and close both failed",
            )
          : error;
      }
    }
  }
  if (failure) return { state: "failed", owned, error: failure };
  return { state: "written" };
}

export const ordinaryConfigOperations: Readonly<AtomicConfigOperations> =
  Object.freeze({
    platform: process.platform,
    createParent: (parent) => fs.mkdirSync(parent, { recursive: true }),
    assertBoundary: (file) => {
      assertFinalParentDirectory(file);
      assertFinalTarget(file);
    },
    temporaryPath: (parent, targetLeaf) =>
      path.join(
        parent,
        `.${targetLeaf}.sana-mcp-write-${crypto
          .randomBytes(12)
          .toString("hex")}.tmp`,
      ),
    writeAndFlushTemporary,
    readSnapshot: readConfigSnapshot,
    rename: (source, destination) => fs.renameSync(source, destination),
    unlink: (file) => fs.unlinkSync(file),
    readPublished: (file) => fs.readFileSync(file, "utf8"),
    flushParent: flushDirectory,
    removeTemporary,
  } satisfies AtomicConfigOperations);

/**
 * Publish a fully-rendered candidate using a same-directory atomic rename.
 *
 * The final reread is best-effort conflict detection, not compare-and-swap:
 * another current-user process can still replace the target before rename.
 */
export function publishConfigAtomic(
  file: string,
  before: ConfigSnapshot,
  candidate: string,
  verify: (raw: string) => { ok: true } | { ok: false; reason: string },
  operations: AtomicConfigOperations = ordinaryConfigOperations,
  publishedMode: number = before.mode ?? 0o600,
): AtomicConfigResult {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const leaf = path.basename(absolute);
  let temporary: string | undefined;
  let temporaryOwned = false;
  let published = false;
  try {
    operations.createParent(parent);
    operations.assertBoundary(absolute);

    temporary = operations.temporaryPath(parent, leaf);
    const write = operations.writeAndFlushTemporary(
      temporary,
      candidate,
      publishedMode,
    );
    if (write.state === "failed") {
      temporaryOwned = write.owned;
      throw write.error;
    }
    temporaryOwned = true;

    operations.assertBoundary(absolute);
    const observed = operations.readSnapshot(absolute);
    if (!sameObservedSnapshot(before, observed, operations.platform)) {
      const cleanup = operations.removeTemporary(temporary);
      temporary = undefined;
      temporaryOwned = false;
      return cleanup
        ? {
            state: "failed",
            reason: `client config changed after planning; ${cleanup}`,
          }
        : {
            state: "conflict",
            reason:
              "client config changed after planning and was left untouched",
          };
    }

    retryWindowsFileOperation(
      () => operations.rename(temporary!, absolute),
      () => {
        operations.assertBoundary(absolute);
        const retryObserved = operations.readSnapshot(absolute);
        if (!sameObservedSnapshot(before, retryObserved, operations.platform))
          throw new OptimisticConfigConflictError(
            "client config changed while Windows was retrying publication",
          );
      },
      operations.platform,
    );
    published = true;
    temporary = undefined;
    temporaryOwned = false;

    let verification: { ok: true } | { ok: false; reason: string };
    try {
      operations.assertBoundary(absolute);
      const raw = operations.readPublished(absolute);
      const published = operations.readSnapshot(absolute);
      verification =
        !published.exists || published.raw !== raw
          ? {
              ok: false,
              reason: "published config changed during verification",
            }
          : operations.platform !== "win32" &&
              published.mode !== publishedMode
            ? {
                ok: false,
                reason: "published config mode differs from the intended mode",
              }
            : verify(raw);
    } catch (error) {
      verification = {
        ok: false,
        reason: `published config could not be read safely: ${errorText(error)}`,
      };
    }
    if (!verification.ok) {
      const durabilityWarning =
        operations.platform === "win32"
          ? undefined
          : operations.flushParent(parent);
      return {
        state: "ambiguous",
        reason: `sana-mcp published ${absolute}, but ownership could not be verified: ${
          verification.reason
        }. Inspect this file manually; it was not rolled back or removed.${
          durabilityWarning ? ` ${durabilityWarning}` : ""
        }`,
      };
    }

    const warning =
      operations.platform === "win32"
        ? undefined
        : operations.flushParent(parent);
    return warning
      ? { state: "published", durability: "uncertain", warning }
      : { state: "published", durability: "verified" };
  } catch (error) {
    const cleanup =
      temporary && temporaryOwned
        ? operations.removeTemporary(temporary)
        : undefined;
    const reason = errorText(error);
    if (published)
      return {
        state: "ambiguous",
        reason: `sana-mcp may have published ${absolute}, but the final state could not be proven: ${reason}${
          cleanup ? `; ${cleanup}` : ""
        }. Inspect this file manually; it was not rolled back or removed.`,
      };
    if (error instanceof OptimisticConfigConflictError)
      return cleanup
        ? {
            state: "failed",
            reason: `${error.message}; ${cleanup}`,
          }
        : {
            state: "conflict",
            reason: `${error.message} and was left untouched`,
          };
    return {
      state: "failed",
      reason: cleanup ? `${reason}; ${cleanup}` : reason,
    };
  }
}

/**
 * Remove a config that is still byte-for-byte equal to the expected snapshot.
 *
 * This is the absent-preimage counterpart to `publishConfigAtomic`. Like the
 * publisher, it provides observable best-effort conflict detection for a local
 * current-user process; it does not claim a kernel-level compare-and-swap.
 */
export function removeConfigAtomic(
  file: string,
  expected: ConfigSnapshot,
  operations: AtomicConfigOperations = ordinaryConfigOperations,
): AtomicConfigRemovalResult {
  if (!expected.exists)
    return {
      state: "failed",
      reason: "an existing expected snapshot is required for atomic removal",
    };
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  try {
    operations.assertBoundary(absolute);
    const observed = operations.readSnapshot(absolute);
    if (!sameObservedSnapshot(expected, observed, operations.platform))
      return {
        state: "conflict",
        reason: "client config changed before rollback and was left untouched",
      };
    retryWindowsFileOperation(
      () => operations.unlink(absolute),
      () => {
        operations.assertBoundary(absolute);
        const retryObserved = operations.readSnapshot(absolute);
        if (!sameObservedSnapshot(expected, retryObserved, operations.platform))
          throw new OptimisticConfigConflictError(
            "client config changed while Windows was retrying rollback",
          );
      },
      operations.platform,
    );
    let absent: ConfigSnapshot;
    try {
      absent = operations.readSnapshot(absolute);
    } catch (error) {
      return {
        state: "ambiguous",
        reason: `client config removal could not be verified: ${errorText(error)}`,
      };
    }
    if (absent.exists)
      return {
        state: "ambiguous",
        reason:
          "client config was removed, but another file appeared before verification",
      };
    const warning =
      operations.platform === "win32"
        ? undefined
        : operations.flushParent(parent);
    return warning
      ? { state: "removed", durability: "uncertain", warning }
      : { state: "removed", durability: "verified" };
  } catch (error) {
    let observed: ConfigSnapshot | undefined;
    try {
      observed = operations.readSnapshot(absolute);
    } catch {
      // The primary error remains authoritative when observation also fails.
    }
    if (error instanceof OptimisticConfigConflictError)
      return {
        state: "conflict",
        reason: `${error.message} and was left untouched`,
      };
    if (observed && !observed.exists)
      return {
        state: "ambiguous",
        reason: `client config may have been removed, but completion could not be proven: ${errorText(error)}`,
      };
    return { state: "failed", reason: errorText(error) };
  }
}
