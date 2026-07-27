import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "../config.js";
import {
  ensureSecureDirectory,
  openSensitiveFile,
  readJsonFile,
} from "../runtime/secure-files.js";

const LEGACY_CONTROL_PROTOCOL = 1;
const CONTROL_PROTOCOL = 2;
const REQUEST_PROTOCOL = 1;
const STATUS_FILE = "daemon-control.json";
const REQUEST_FILE = "daemon-stop.json";
const STATUS_PREFIX = "daemon-control-v2-";
const REQUEST_PREFIX = "daemon-stop-v2-";
const LEGACY_CONTROL_CLEANUP_PREFIX = "daemon-control-v1-cleanup-";
const LEGACY_CONTROL_CAPTURE_PREFIX = "daemon-control-v1-capture-";
export const DAEMON_CONTROL_STALE_MS = 30_000;
const PROCESS_BIRTH_IDENTITY = crypto.randomUUID();
const ACTIVE_LEGACY_CONTROL_CLEANUPS = new Set<string>();

const identitySchema = {
  pid: z.number().int().positive().safe(),
  instanceId: z.string().uuid(),
};

const legacyStatusSchema = z
  .object({
    protocol: z.literal(LEGACY_CONTROL_PROTOCOL),
    ...identitySchema,
  })
  .strict();

const readyStatusSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    phase: z.literal("ready"),
    ...identitySchema,
    heartbeatMs: z.number().int().nonnegative().safe(),
  })
  .strict();

const statusSchema = z.union([legacyStatusSchema, readyStatusSchema]);

const requestSchema = z
  .object({
    protocol: z.literal(REQUEST_PROTOCOL),
    instanceId: z.string().uuid(),
    operation: z.literal("stop"),
  })
  .strict();

const legacyControlCleanupSchema = z
  .object({
    protocol: z.literal(LEGACY_CONTROL_PROTOCOL),
    pid: z.number().int().positive().safe(),
    instanceId: z.string().uuid(),
    operationId: z.string().uuid(),
    cleanerPid: z.number().int().positive().safe(),
    cleanerIdentity: z.string().uuid(),
  })
  .strict();

export interface DaemonControlIdentity {
  readonly pid: number;
  readonly instanceId: string;
}

export type DaemonControlObservation =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "legacy";
      identity: DaemonControlIdentity;
    }>
  | Readonly<{
      kind: "ready";
      identity: DaemonControlIdentity;
      heartbeatMs: number;
      freshness: "fresh" | "stale";
    }>;

export class DaemonControlUnavailableError extends Error {
  readonly code = "DAEMON_CONTROL_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonControlUnavailableError";
  }
}

export interface DaemonStopRequestResult {
  readonly identity: DaemonControlIdentity;
  readonly published: true;
  readonly continuity: "confirmed" | "changed";
}

export class DaemonStopRequestRejectedError
  extends DaemonControlUnavailableError {
  readonly published = false;
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonStopRequestRejectedError";
  }
}

export class DaemonStopPublishedError
  extends DaemonControlUnavailableError {
  readonly published = true;
  readonly continuity = "unknown";

  constructor(
    readonly identity: DaemonControlIdentity,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DaemonStopPublishedError";
  }
}

export interface DaemonStopRequestDependencies {
  readonly observeControl: () => DaemonControlObservation;
  readonly publishRequest: (
    instanceId: string,
    protocol: "legacy" | "ready",
  ) => void;
}

export interface DaemonControlOptions {
  /** @internal Isolated control root for deterministic tests. */
  readonly directory?: string;
  /** @internal Deterministic instance identity for tests. */
  readonly instanceId?: string;
  /** @internal Deterministic clock for tests. */
  readonly now?: () => number;
  /** @internal Deterministic process probe for tests. */
  readonly pidAlive?: (pid: number) => boolean;
  /** @internal Authoritative current-process birth identity for tests. */
  readonly processIdentity?: string;
  /** @internal Forced interleaving immediately before an exclusive unlink. */
  readonly beforeExclusiveUnlink?: (
    publication: "control" | "request",
  ) => void;
  /** @internal Forced pause after request publication, before re-observation. */
  readonly afterStopRequestPublication?: (
    instanceId: string,
    protocol: "legacy" | "ready",
  ) => void;
  /** @internal Forced interleaving immediately before legacy control capture. */
  readonly beforeLegacyControlCapture?: () => void;
  /** @internal Forced failure/interleaving immediately after legacy capture. */
  readonly afterLegacyControlCapture?: () => void;
  /** @internal Platform-shaped read-only validation for isolated tests. */
  readonly platform?: NodeJS.Platform;
}

function controlDirectory(options: DaemonControlOptions): string {
  return options.directory ?? dataDirectory();
}

function statusFile(options: DaemonControlOptions): string {
  return path.join(controlDirectory(options), STATUS_FILE);
}

function readyStatusFile(
  instanceId: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STATUS_PREFIX}${instanceId}.json`,
  );
}

function legacyControlCleanupFile(
  instanceId: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${LEGACY_CONTROL_CLEANUP_PREFIX}${instanceId}.json`,
  );
}

function legacyControlCaptureFile(
  operationId: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${LEGACY_CONTROL_CAPTURE_PREFIX}${operationId}.json`,
  );
}

function requestFile(
  options: DaemonControlOptions,
  instanceId?: string,
): string {
  if (instanceId !== undefined) {
    return path.join(
      controlDirectory(options),
      `${REQUEST_PREFIX}${instanceId}.json`,
    );
  }
  return path.join(controlDirectory(options), REQUEST_FILE);
}

function publicationFiles(
  options: DaemonControlOptions,
  prefix: string,
  shared: string,
): string[] {
  const directory = controlDirectory(options);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (errno(error, "ENOENT")) return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry === shared ||
        (entry.startsWith(prefix) && entry.endsWith(".json")),
    )
    .sort()
    .map((entry) => path.join(directory, entry));
}

function now(options: DaemonControlOptions): number {
  return (options.now ?? Date.now)();
}

function errno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function removeIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

type PublicationRead<T> =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "value"; value: T; modifiedMs: number }>;

type PublicationReader = <T>(
  file: string,
  schema: z.ZodType<T>,
) => PublicationRead<T>;

function readPublicationReadOnly<T>(
  file: string,
  schema: z.ZodType<T>,
  options: DaemonControlOptions,
): PublicationRead<T> {
  const directory = path.dirname(file);
  let directoryStats: fs.Stats;
  try {
    directoryStats = fs.lstatSync(directory);
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    throw new DaemonControlUnavailableError(
      `Could not inspect daemon publication directory: ${directory}`,
      { cause: error },
    );
  }
  const directoryReparse = (
    directoryStats as fs.Stats & { reparsePointTag?: number }
  ).reparsePointTag;
  if (
    directoryStats.isSymbolicLink() ||
    (directoryReparse !== undefined && directoryReparse !== 0) ||
    !directoryStats.isDirectory()
  ) {
    throw new DaemonControlUnavailableError(
      `Daemon publication directory is a link, reparse point, or non-directory: ${directory}`,
    );
  }
  if (
    (options.platform ?? process.platform) !== "win32" &&
    (directoryStats.mode & 0o077) !== 0
  ) {
    throw new DaemonControlUnavailableError(
      `Daemon publication directory permissions are not private: ${directory}`,
    );
  }

  let pathStats: fs.Stats;
  try {
    pathStats = fs.lstatSync(file);
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    throw new DaemonControlUnavailableError(
      `Could not inspect daemon publication: ${file}`,
      { cause: error },
    );
  }
  const reparseTag = (
    pathStats as fs.Stats & { reparsePointTag?: number }
  ).reparsePointTag;
  if (
    pathStats.isSymbolicLink() ||
    (reparseTag !== undefined && reparseTag !== 0) ||
    !pathStats.isFile()
  ) {
    throw new DaemonControlUnavailableError(
      `Daemon publication is a link, reparse point, or non-regular file: ${file}`,
    );
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    throw new DaemonControlUnavailableError(
      `Could not open daemon publication without mutation: ${file}`,
      { cause: error },
    );
  }
  let bytes: Buffer | undefined;
  let modifiedMs: number | undefined;
  let operationError: unknown;
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.size > 64 * 1024
    ) {
      throw new DaemonControlUnavailableError(
        `Daemon publication changed, is not regular, or exceeds the 65536-byte safety limit: ${file}`,
      );
    }
    bytes = fs.readFileSync(descriptor);
    modifiedMs = Math.trunc(stats.mtimeMs);
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      `Daemon publication read and descriptor cleanup failed: ${file}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes!.toString("utf8"));
  } catch (error) {
    throw new DaemonControlUnavailableError(
      `Daemon publication is malformed and was preserved: ${file}`,
      { cause: error },
    );
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new DaemonControlUnavailableError(
      `Daemon publication has invalid content and was preserved: ${file}`,
      { cause: validated.error },
    );
  }
  return {
    kind: "value",
    value: validated.data,
    modifiedMs: modifiedMs!,
  };
}

function checkedAge(
  currentMs: number,
  publicationMs: number,
  label: string,
  ErrorType: typeof DaemonControlUnavailableError,
): number {
  const age = currentMs - publicationMs;
  if (age < 0) {
    throw new ErrorType(
      `${label} is dated in the future; clock integrity cannot be established`,
    );
  }
  return age;
}

/**
 * Read content and metadata from one opened publication inode. This prevents a
 * path replacement between the JSON read and heartbeat observation.
 */
function readPublication<T>(
  file: string,
  schema: z.ZodType<T>,
  retry: number = 0,
): PublicationRead<T> {
  if (retry >= 8) {
    throw new DaemonControlUnavailableError(
      `Daemon publication changed repeatedly while being read: ${file}`,
    );
  }
  let descriptor: number;
  try {
    descriptor = openSensitiveFile(file, "r");
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  let bytes: Buffer | undefined;
  let modifiedMs: number | undefined;
  let operationError: unknown;
  try {
    const stats = fs.fstatSync(descriptor);
    if (stats.size > 64 * 1024) {
      throw new DaemonControlUnavailableError(
        `Daemon publication exceeds the 65536-byte safety limit: ${file}`,
      );
    }
    bytes = fs.readFileSync(descriptor);
    modifiedMs = Math.trunc(stats.mtimeMs);
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      `Daemon publication read and descriptor cleanup failed: ${file}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes!.toString("utf8"));
  } catch {
    // Preserve the malformed current path through the standard bounded reader.
    const preserved = readJsonFile(file, schema);
    if (preserved.kind === "missing") return preserved;
    return readPublication(file, schema, retry + 1);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    const preserved = readJsonFile(file, schema);
    if (preserved.kind === "missing") return preserved;
    return readPublication(file, schema, retry + 1);
  }
  return {
    kind: "value",
    value: validated.data,
    modifiedMs: modifiedMs!,
  };
}

function createExclusivePublication(
  file: string,
  value: unknown,
  modifiedMs?: number,
): boolean {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSensitiveFile(file, "wx");
    created = true;
    fs.writeFileSync(descriptor, serialized);
    if (modifiedMs !== undefined) {
      const timestamp = new Date(modifiedMs);
      fs.futimesSync(descriptor, timestamp, timestamp);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return true;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (created) {
      try {
        removeIfPresent(file);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Daemon publication and descriptor cleanup failed: ${file}`,
      );
    }
    if (errno(error, "EEXIST")) return false;
    throw error;
  }
}

function touchExactPublication<T>(
  file: string,
  schema: z.ZodType<T>,
  matches: (value: T) => boolean,
  modifiedMs: number,
  changedMessage: string,
): void {
  let descriptor: number;
  try {
    descriptor = openSensitiveFile(file, "r+");
  } catch (error) {
    if (errno(error, "ENOENT")) {
      throw new DaemonControlUnavailableError(changedMessage, {
        cause: error,
      });
    }
    throw error;
  }
  let operationError: unknown;
  try {
    const parsed = schema.safeParse(
      JSON.parse(fs.readFileSync(descriptor, "utf8")),
    );
    if (!parsed.success || !matches(parsed.data)) {
      throw new DaemonControlUnavailableError(changedMessage);
    }
    const timestamp = new Date(modifiedMs);
    fs.futimesSync(descriptor, timestamp, timestamp);
    fs.fsyncSync(descriptor);
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Daemon publication refresh and descriptor cleanup failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

function removeExclusivePublicationIf<T>(
  file: string,
  schema: z.ZodType<T>,
  matches: (value: T) => boolean,
  publication: "control" | "request",
  options: DaemonControlOptions,
): boolean {
  const observed = readPublication(file, schema);
  if (observed.kind === "missing" || !matches(observed.value)) return false;
  options.beforeExclusiveUnlink?.(publication);
  removeIfPresent(file);
  return true;
}

function legacyRecoveryFiles(
  options: DaemonControlOptions,
  prefix: string,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(controlDirectory(options));
  } catch (error) {
    if (errno(error, "ENOENT")) return [];
    throw error;
  }
  return entries
    .filter((entry) =>
      entry.startsWith(prefix) && entry.endsWith(".json")
    )
    .sort()
    .map((entry) => path.join(controlDirectory(options), entry));
}

function sameStatus(
  left: z.infer<typeof statusSchema>,
  right: z.infer<typeof statusSchema>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restoreCapturedControl(
  captureFile: string,
  captured: z.infer<typeof statusSchema>,
  options: DaemonControlOptions,
): void {
  const shared = statusFile(options);
  try {
    fs.linkSync(captureFile, shared);
    return;
  } catch (error) {
    if (!errno(error, "EEXIST")) {
      throw new DaemonControlUnavailableError(
        "Could not restore atomically captured daemon control",
        { cause: error },
      );
    }
  }
  const current = readPublication(shared, statusSchema);
  if (
    current.kind !== "value" ||
    !sameStatus(current.value, captured)
  ) {
    throw new DaemonControlUnavailableError(
      "A different daemon control was published while a captured successor awaited restoration; both were preserved",
    );
  }
}

function recoverLegacyControlCleanup(
  options: DaemonControlOptions,
): void {
  const alive = options.pidAlive ?? defaultPidAlive;
  const journaledCaptures = new Set<string>();
  const markers = legacyRecoveryFiles(
    options,
    LEGACY_CONTROL_CLEANUP_PREFIX,
  );
  for (const markerFile of markers) {
    const marker = readPublication(
      markerFile,
      legacyControlCleanupSchema,
    );
    if (marker.kind === "missing") continue;
    journaledCaptures.add(
      legacyControlCaptureFile(marker.value.operationId, options),
    );
    const sameRuntime =
      marker.value.cleanerPid === process.pid &&
      marker.value.cleanerIdentity ===
        (options.processIdentity ?? PROCESS_BIRTH_IDENTITY);
    if (
      sameRuntime &&
      ACTIVE_LEGACY_CONTROL_CLEANUPS.has(marker.value.operationId)
    ) {
      // This process is still inside the journaled operation. Its caller will
      // either complete it or preserve it for a later process to recover.
      continue;
    }
    if (!sameRuntime && alive(marker.value.cleanerPid)) {
      throw new DaemonControlUnavailableError(
        `Legacy control cleanup names live PID ${marker.value.cleanerPid}, or that PID has been reused; automatic recovery is unsafe`,
      );
    }
    const captureFile = legacyControlCaptureFile(
      marker.value.operationId,
      options,
    );
    const capture = readPublication(captureFile, statusSchema);
    if (capture.kind === "missing") {
      if (readPublication(statusFile(options), statusSchema).kind === "missing") {
        throw new DaemonControlUnavailableError(
          "Legacy control cleanup marker has neither its captured control nor a shared control; recovery is ambiguous",
        );
      }
      removeIfPresent(markerFile);
      continue;
    }
    const expected =
      capture.value.protocol === LEGACY_CONTROL_PROTOCOL &&
      capture.value.pid === marker.value.pid &&
      capture.value.instanceId === marker.value.instanceId;
    if (!expected) {
      restoreCapturedControl(captureFile, capture.value, options);
    } else if (alive(marker.value.pid)) {
      throw new DaemonControlUnavailableError(
        `Legacy daemon target PID ${marker.value.pid} became live or was reused; recovery evidence was preserved`,
      );
    }
    removeIfPresent(markerFile);
    removeIfPresent(captureFile);
  }

  for (
    const captureFile of legacyRecoveryFiles(
      options,
      LEGACY_CONTROL_CAPTURE_PREFIX,
    )
  ) {
    if (journaledCaptures.has(captureFile)) continue;
    const capture = readPublication(captureFile, statusSchema);
    if (capture.kind === "missing") continue;
    if (
      capture.value.protocol === LEGACY_CONTROL_PROTOCOL &&
      !alive(capture.value.pid)
    ) {
      if (alive(capture.value.pid)) {
        throw new DaemonControlUnavailableError(
          `Legacy daemon target PID ${capture.value.pid} became live during orphan-capture recovery`,
        );
      }
      removeIfPresent(captureFile);
      continue;
    }
    restoreCapturedControl(captureFile, capture.value, options);
    removeIfPresent(captureFile);
  }
}

function assertNoLegacyControlRecovery(
  options: DaemonControlOptions,
): void {
  const artifacts = [
    ...legacyRecoveryFiles(options, LEGACY_CONTROL_CLEANUP_PREFIX),
    ...legacyRecoveryFiles(options, LEGACY_CONTROL_CAPTURE_PREFIX),
  ];
  if (artifacts.length > 0) {
    throw new DaemonControlUnavailableError(
      `Legacy daemon control recovery is incomplete; health preserved ${artifacts[0]}`,
    );
  }
}

function observeDaemonControlWith(
  options: DaemonControlOptions,
  reader: PublicationReader,
): DaemonControlObservation {
  const observedPublications = publicationFiles(
    options,
    STATUS_PREFIX,
    STATUS_FILE,
  ).map((file) => {
    const observed = reader(file, statusSchema);
    if (observed.kind === "missing") return undefined;
    if (path.basename(file).startsWith(STATUS_PREFIX)) {
      if (observed.value.protocol !== CONTROL_PROTOCOL) {
        throw new DaemonControlUnavailableError(
          `Identity-addressed daemon control has legacy content: ${file}`,
        );
      }
      const namedInstance = path
        .basename(file)
        .slice(STATUS_PREFIX.length, -".json".length);
      if (namedInstance !== observed.value.instanceId) {
        throw new DaemonControlUnavailableError(
          `Daemon control filename does not match its instance identity: ${file}`,
        );
      }
    }
    return observed;
  }).filter((value): value is Exclude<typeof value, undefined> =>
    value !== undefined
  );
  if (observedPublications.length === 0) return { kind: "missing" };
  if (observedPublications.length !== 1) {
    throw new DaemonControlUnavailableError(
      "Multiple daemon control authorities are published; stop and inspect them manually",
    );
  }
  const observed = observedPublications[0]!;
  const value = observed.value;
  const identity = { pid: value.pid, instanceId: value.instanceId };
  if (value.protocol === LEGACY_CONTROL_PROTOCOL) {
    return { kind: "legacy", identity };
  }
  const heartbeatMs = Math.max(value.heartbeatMs, observed.modifiedMs);
  const age = checkedAge(
    now(options),
    heartbeatMs,
    "Daemon control heartbeat",
    DaemonControlUnavailableError,
  );
  return {
    kind: "ready",
    identity,
    heartbeatMs,
    freshness:
      age <= DAEMON_CONTROL_STALE_MS
        ? "fresh"
        : "stale",
  };
}

export function observeDaemonControl(
  options: DaemonControlOptions = {},
): DaemonControlObservation {
  recoverLegacyControlCleanup(options);
  return observeDaemonControlWith(options, readPublication);
}

export function observeDaemonControlReadOnly(
  options: DaemonControlOptions = {},
): DaemonControlObservation {
  assertNoLegacyControlRecovery(options);
  // Validate the root even when it contains no publication. This probe never
  // creates, chmods, quarantines, renames, or removes anything.
  readPublicationReadOnly(statusFile(options), statusSchema, options);
  return observeDaemonControlWith(
    options,
    <T>(file: string, schema: z.ZodType<T>) =>
      readPublicationReadOnly(file, schema, options),
  );
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errno(error, "ESRCH");
  }
}

/**
 * Verified-installer bridge for a proven-dead v0.4.5 control record.
 * The identity-addressed cleanup marker serializes new-protocol publishers;
 * a live or changed legacy identity is never removed.
 */
export function clearDeadLegacyDaemonControl(
  identity: DaemonControlIdentity,
  options: DaemonControlOptions = {},
): void {
  const alive = options.pidAlive ?? defaultPidAlive;
  if (alive(identity.pid)) {
    throw new DaemonControlUnavailableError(
      `Legacy daemon process ${identity.pid} is live or its PID has been reused; automatic control cleanup is unsafe`,
    );
  }
  recoverLegacyControlCleanup(options);
  const initial = observeDaemonControlWith(options, readPublication);
  if (initial.kind === "missing") return;
  if (
    initial.kind !== "legacy" ||
    initial.identity.pid !== identity.pid ||
    initial.identity.instanceId !== identity.instanceId
  ) {
    throw new DaemonControlUnavailableError(
      "Legacy daemon control changed before cleanup began",
    );
  }
  const markerFile = legacyControlCleanupFile(
    identity.instanceId,
    options,
  );
  const marker = {
    protocol: LEGACY_CONTROL_PROTOCOL,
    ...identity,
    operationId: crypto.randomUUID(),
    cleanerPid: process.pid,
    cleanerIdentity:
      options.processIdentity ?? PROCESS_BIRTH_IDENTITY,
  } as const;
  if (!createExclusivePublication(markerFile, marker)) {
    const existing = readPublication(
      markerFile,
      legacyControlCleanupSchema,
    );
    if (
      existing.kind !== "value" ||
      existing.value.pid !== identity.pid ||
      existing.value.instanceId !== identity.instanceId
    ) {
      throw new DaemonControlUnavailableError(
        "Another legacy daemon control cleanup is in progress",
      );
    }
    if (
      existing.value.cleanerPid === process.pid &&
      existing.value.cleanerIdentity === marker.cleanerIdentity
    ) {
      if (
        ACTIVE_LEGACY_CONTROL_CLEANUPS.has(existing.value.operationId)
      ) {
        throw new DaemonControlUnavailableError(
          "This legacy control cleanup operation is still active",
        );
      }
      recoverLegacyControlCleanup(options);
      return clearDeadLegacyDaemonControl(identity, options);
    }
    if (alive(existing.value.cleanerPid)) {
      throw new DaemonControlUnavailableError(
        `Legacy control cleanup names live PID ${existing.value.cleanerPid}, or that PID has been reused; automatic takeover is unsafe`,
      );
    }
    recoverLegacyControlCleanup(options);
    return clearDeadLegacyDaemonControl(identity, options);
  }
  const captureFile = legacyControlCaptureFile(
    marker.operationId,
    options,
  );
  ACTIVE_LEGACY_CONTROL_CLEANUPS.add(marker.operationId);
  try {
    options.beforeLegacyControlCapture?.();
    try {
      fs.renameSync(statusFile(options), captureFile);
    } catch (error) {
      if (errno(error, "ENOENT")) {
        throw new DaemonControlUnavailableError(
          "Legacy daemon control disappeared before atomic capture",
          { cause: error },
        );
      }
      throw error;
    }
    options.afterLegacyControlCapture?.();
    const captured = readPublication(captureFile, statusSchema);
    if (
      captured.kind !== "value"
    ) {
      throw new DaemonControlUnavailableError(
        "Atomically captured legacy daemon control is unavailable",
      );
    }
    const expected =
      captured.value.protocol === LEGACY_CONTROL_PROTOCOL &&
      captured.value.pid === identity.pid &&
      captured.value.instanceId === identity.instanceId;
    if (!expected) {
      restoreCapturedControl(captureFile, captured.value, options);
      removeIfPresent(markerFile);
      removeIfPresent(captureFile);
      return;
    }
    if (alive(identity.pid)) {
      restoreCapturedControl(captureFile, captured.value, options);
      removeIfPresent(markerFile);
      removeIfPresent(captureFile);
      return;
    }
    // Removing the marker first makes a crash leave only a token-addressed
    // orphan capture. Recovery can safely delete that proven-dead old record.
    removeIfPresent(markerFile);
    removeIfPresent(captureFile);
  } catch (error) {
    // Preserve marker and capture as a recoverable journal whenever capture
    // happened. Before-capture failures may safely release the marker.
    if (!fs.existsSync(captureFile)) removeIfPresent(markerFile);
    throw error;
  } finally {
    ACTIVE_LEGACY_CONTROL_CLEANUPS.delete(marker.operationId);
  }
}

/** Publish ready control only after the daemon owns its SQLite lease. */
export function publishDaemonControl(
  pid: number = process.pid,
  options: DaemonControlOptions = {},
): DaemonControlIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pid must be a positive safe integer");
  }
  ensureSecureDirectory(controlDirectory(options));
  recoverLegacyControlCleanup(options);
  if (
    publicationFiles(
      options,
      LEGACY_CONTROL_CLEANUP_PREFIX,
      "__no-shared-legacy-cleanup__",
    ).length > 0
  ) {
    throw new DaemonControlUnavailableError(
      "Legacy daemon control cleanup is in progress; retry startup",
    );
  }
  if (observeDaemonControl(options).kind !== "missing") {
    throw new DaemonControlUnavailableError(
      "Daemon control is already published; refuse to create a second authority",
    );
  }
  const identity = {
    pid,
    instanceId: options.instanceId ?? crypto.randomUUID(),
  };
  const parsed = z.string().uuid().safeParse(identity.instanceId);
  if (!parsed.success) throw new TypeError("instanceId must be a UUID");
  const record = {
    protocol: CONTROL_PROTOCOL,
    phase: "ready",
    ...identity,
    heartbeatMs: now(options),
  } as const;
  if (
    !createExclusivePublication(
      readyStatusFile(identity.instanceId, options),
      record,
      record.heartbeatMs,
    )
  ) {
    throw new DaemonControlUnavailableError(
      "Daemon control is already published; refuse to replace it",
    );
  }
  return identity;
}

export function refreshDaemonControl(
  identity: DaemonControlIdentity,
  options: DaemonControlOptions = {},
): void {
  touchExactPublication(
    readyStatusFile(identity.instanceId, options),
    readyStatusSchema,
    (value) =>
      value.pid === identity.pid &&
      value.instanceId === identity.instanceId,
    now(options),
    "Daemon control identity changed before heartbeat refresh",
  );
}

/** True only for this exact fresh ready identity (legacy v1 remains observable). */
export function daemonControlReady(
  expectedPid: number,
  expectedInstanceId: string,
  options: DaemonControlOptions = {},
): boolean {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new TypeError("expectedPid must be a positive safe integer");
  }
  if (!z.string().uuid().safeParse(expectedInstanceId).success) {
    throw new TypeError("expectedInstanceId must be a UUID");
  }
  const observed = observeDaemonControl(options);
  return (
    observed.kind === "ready" &&
    observed.freshness === "fresh" &&
    observed.identity.pid === expectedPid &&
    observed.identity.instanceId === expectedInstanceId
  );
}

/** @internal Exact stop publication state machine for deterministic tests. */
export function requestDaemonStopWith(
  expected: DaemonControlIdentity,
  dependencies: DaemonStopRequestDependencies,
): DaemonStopRequestResult {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0) {
    throw new TypeError("expected.pid must be a positive safe integer");
  }
  if (!z.string().uuid().safeParse(expected.instanceId).success) {
    throw new TypeError("expected.instanceId must be a UUID");
  }
  const matches = (observed: DaemonControlObservation): boolean =>
    observed.kind !== "missing" &&
    observed.identity.pid === expected.pid &&
    observed.identity.instanceId === expected.instanceId;
  const before = dependencies.observeControl();
  if (!matches(before)) {
    throw new DaemonStopRequestRejectedError(
      `Daemon ${expected.pid} has no matching cooperative control record; stop it manually`,
    );
  }
  const protocol = before.kind === "legacy" ? "legacy" : "ready";
  dependencies.publishRequest(expected.instanceId, protocol);
  let after: DaemonControlObservation;
  try {
    after = dependencies.observeControl();
  } catch (error) {
    throw new DaemonStopPublishedError(
      expected,
      "Daemon stop request was published, but postpublication control integrity could not be established",
      { cause: error },
    );
  }
  if (!matches(after)) {
    return {
      identity: expected,
      published: true,
      continuity: "changed",
    };
  }
  return {
    identity: expected,
    published: true,
    continuity: "confirmed",
  };
}

/** Ask one exact published daemon instance to stop; never retarget a successor. */
export function requestDaemonStop(
  expected: DaemonControlIdentity,
  options: DaemonControlOptions = {},
): DaemonStopRequestResult {
  return requestDaemonStopWith(expected, {
    observeControl: () => observeDaemonControl(options),
    publishRequest: (instanceId, protocol) => {
      const value = {
        protocol: REQUEST_PROTOCOL,
        instanceId,
        operation: "stop",
      } as const;
      const file = requestFile(
        options,
        protocol === "ready" ? instanceId : undefined,
      );
      if (createExclusivePublication(file, value)) {
        try {
          options.afterStopRequestPublication?.(instanceId, protocol);
        } catch (error) {
          throw new DaemonStopPublishedError(
            expected,
            "Daemon stop request was published before the publication observer failed",
            { cause: error },
          );
        }
        return;
      }
      const existing = readPublication(file, requestSchema);
      if (
        existing.kind === "value" &&
        existing.value.instanceId === instanceId
      ) {
        try {
          options.afterStopRequestPublication?.(instanceId, protocol);
        } catch (error) {
          throw new DaemonStopPublishedError(
            expected,
            "Daemon stop request was already published before the publication observer failed",
            { cause: error },
          );
        }
        return;
      }
      throw new DaemonStopRequestRejectedError(
        "Another daemon stop request is already published",
      );
    },
  });
}

/** Called by the daemon at existing heartbeat/cycle boundaries. */
export function daemonStopRequested(
  instanceId: string,
  options: DaemonControlOptions = {},
): boolean {
  const observed = readPublication(
    requestFile(options, instanceId),
    requestSchema,
  );
  return (
    observed.kind === "value" &&
    observed.value.instanceId === instanceId
  );
}

/** Remove only files still naming the daemon instance being finalized. */
export function clearDaemonControl(
  identity: DaemonControlIdentity,
  options: DaemonControlOptions = {},
): void {
  removeExclusivePublicationIf(
    requestFile(options, identity.instanceId),
    requestSchema,
    (value) => value.instanceId === identity.instanceId,
    "request",
    options,
  );
  removeExclusivePublicationIf(
    readyStatusFile(identity.instanceId, options),
    readyStatusSchema,
    (value) =>
      value.pid === identity.pid &&
      value.instanceId === identity.instanceId,
    "control",
    options,
  );
}
