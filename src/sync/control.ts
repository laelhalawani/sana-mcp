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
const STARTUP_PROTOCOL = 1;
const STATUS_FILE = "daemon-control.json";
const REQUEST_FILE = "daemon-stop.json";
const STARTUP_FILE = "daemon-startup.json";
const STATUS_PREFIX = "daemon-control-v2-";
const REQUEST_PREFIX = "daemon-stop-v2-";
const LEGACY_CONTROL_CLEANUP_PREFIX = "daemon-control-v1-cleanup-";
const LEGACY_CONTROL_CAPTURE_PREFIX = "daemon-control-v1-capture-";
const STARTUP_AUTHORITY_DIRECTORY = "daemon-startup-v2-authority";
const STARTUP_CANDIDATE_PREFIX = "daemon-startup-v2-candidate-";
const STARTUP_QUARANTINE_PREFIX = "daemon-startup-v2-quarantine-";
const STARTUP_CHILD_PREFIX = "daemon-startup-v2-child-";
const STARTUP_CLEANUP_PREFIX = "daemon-startup-v2-cleanup-";
const STARTUP_RETIRED_CLEANUP_PREFIX =
  "daemon-startup-v2-retired-cleanup-";
const STARTUP_CLAIM_FILE = "claim.json";
const STARTUP_RETIREMENT_FILE = "retirement.json";
const WINDOWS_ACL_RECEIPT_FILE = ".sana-acl-setup-v1.json";
export const DAEMON_CONTROL_STALE_MS = 30_000;
export const DAEMON_STARTUP_STALE_MS = 15_000;
export const DAEMON_STARTUP_ORPHAN_GRACE_MS = 1_000;
export const DAEMON_STARTUP_TOKEN_ENV = "SANA_MCP_DAEMON_STARTUP_TOKEN";
const PROCESS_BIRTH_IDENTITY = crypto.randomUUID();
const ACTIVE_LEGACY_CONTROL_CLEANUPS = new Set<string>();
const ACTIVE_STARTUP_CLEANUPS = new Set<string>();
const ACTIVE_STARTUP_CLEANUP_TOKENS = new Set<string>();

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

const startupSchema = z
  .object({
    protocol: z.literal(STARTUP_PROTOCOL),
    token: z.string().uuid(),
    ownerPid: z.number().int().positive().safe(),
    childPid: z.number().int().positive().safe().nullable(),
    heartbeatMs: z.number().int().nonnegative().safe(),
  })
  .strict();

const startupChildSchema = z
  .object({
    protocol: z.literal(STARTUP_PROTOCOL),
    token: z.string().uuid(),
    childPid: z.number().int().positive().safe(),
  })
  .strict();

const startupCleanupSchema = z
  .object({
    protocol: z.literal(STARTUP_PROTOCOL),
    token: z.string().uuid(),
    operationId: z.string().uuid(),
    cleanerPid: z.number().int().positive().safe(),
    cleanerIdentity: z.string().uuid(),
  })
  .strict();

const startupRetirementSchema = startupCleanupSchema.extend({
  phase: z.literal("committed"),
}).strict();

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

export interface DaemonStartupClaim {
  readonly protocol: 1;
  readonly token: string;
  readonly ownerPid: number;
  readonly childPid: number | null;
  readonly heartbeatMs: number;
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

export type DaemonStartupObservation =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "starting";
      claim: DaemonStartupClaim;
      freshness: "fresh" | "stale";
      authority?: "legacy" | "fixed" | "candidate" | "quarantine";
    }>;

export type DaemonStartupClaimResult =
  | Readonly<{ kind: "acquired"; claim: DaemonStartupClaim }>
  | Readonly<{
      kind: "busy";
      claim: DaemonStartupClaim;
      freshness: "fresh" | "stale";
    }>;

export class DaemonControlUnavailableError extends Error {
  readonly code = "DAEMON_CONTROL_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonControlUnavailableError";
  }
}

export class DaemonStartupUnavailableError extends Error {
  readonly code = "DAEMON_STARTUP_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonStartupUnavailableError";
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
    publication: "control" | "request" | "startup",
  ) => void;
  /** @internal Forced pause after observing a chain tip, before CAS append. */
  readonly beforeStartupAppend?: (
    predecessorToken: string | null,
  ) => void;
  /** @internal Forced pause after an initial bind/refresh observation. */
  readonly beforeStartupMutation?: (
    operation: "bind" | "refresh",
    token: string,
  ) => void;
  /** @internal Forced pause after validation, before a token artifact create. */
  readonly beforeStartupArtifactCreate?: (
    operation: "bind" | "cleanup",
    token: string,
  ) => void;
  /** @internal Forced pause after exact authority quarantine. */
  readonly afterStartupAuthorityQuarantine?: (token: string) => void;
  /** @internal Forced failure immediately before startup authority rename. */
  readonly beforeStartupAuthorityRetirement?: (token: string) => void;
  /** @internal Forced interleaving after marker release, before quarantine removal. */
  readonly afterStartupCleanupRelease?: (token: string) => void;
  /** @internal Forced post-rename ACL verification failure. */
  readonly beforeStartupAuthorityAclVerification?: (token: string) => void;
  /** @internal Forced failure after quarantine rename, before ACL rebind. */
  readonly beforeStartupQuarantineAclVerification?: (token: string) => void;
  /** @internal Forced path swap after the ACL receipt descriptor is opened. */
  readonly duringWindowsAclReceiptRead?: (receiptFile: string) => void;
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

function legacyStartupFile(options: DaemonControlOptions): string {
  return path.join(controlDirectory(options), STARTUP_FILE);
}

function startupAuthorityDirectory(options: DaemonControlOptions): string {
  return path.join(controlDirectory(options), STARTUP_AUTHORITY_DIRECTORY);
}

function startupCandidateDirectory(
  token: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STARTUP_CANDIDATE_PREFIX}${token}`,
  );
}

function startupQuarantineDirectory(
  token: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STARTUP_QUARANTINE_PREFIX}${token}`,
  );
}

function startupClaimFile(directory: string): string {
  return path.join(directory, STARTUP_CLAIM_FILE);
}

function startupRetirementFile(directory: string): string {
  return path.join(directory, STARTUP_RETIREMENT_FILE);
}

function startupChildFile(
  token: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STARTUP_CHILD_PREFIX}${token}.json`,
  );
}

function startupCleanupFile(
  token: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STARTUP_CLEANUP_PREFIX}${token}.json`,
  );
}

function retiredStartupCleanupFile(
  token: string,
  operationId: string,
  options: DaemonControlOptions,
): string {
  return path.join(
    controlDirectory(options),
    `${STARTUP_RETIRED_CLEANUP_PREFIX}${token}-${operationId}.json`,
  );
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
  ErrorType:
    | typeof DaemonControlUnavailableError
    | typeof DaemonStartupUnavailableError,
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
  publication: "control" | "request" | "startup",
  options: DaemonControlOptions,
): boolean {
  const observed = readPublication(file, schema);
  if (observed.kind === "missing" || !matches(observed.value)) return false;
  options.beforeExclusiveUnlink?.(publication);
  removeIfPresent(file);
  return true;
}

function startupActorAlive(
  claim: DaemonStartupClaim,
  alive: (pid: number) => boolean,
): boolean {
  return alive(claim.ownerPid) ||
    (claim.childPid !== null && alive(claim.childPid));
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

interface StartupAuthority {
  readonly kind: "legacy" | "fixed";
  readonly directory: string;
  readonly claimFile: string;
  readonly claim: DaemonStartupClaim;
  readonly modifiedMs: number;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errno(error, "ESRCH");
  }
}

function validateWindowsAclReceipt(
  directory: string,
  receiptFile: string,
  options: DaemonControlOptions,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(receiptFile);
  } catch (error) {
    throw new DaemonStartupUnavailableError(
      `Could not inspect Windows ACL infrastructure receipt: ${receiptFile}`,
      { cause: error },
    );
  }
  const reparseTag = (
    stats as fs.Stats & { reparsePointTag?: number }
  ).reparsePointTag;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (reparseTag !== undefined && reparseTag !== 0) ||
    stats.size > 16 * 1024
  ) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL infrastructure receipt is unsafe: ${receiptFile}`,
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(receiptFile, fs.constants.O_RDONLY);
  } catch (error) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL infrastructure receipt could not be opened safely: ${receiptFile}`,
      { cause: error },
    );
  }
  let bytes: Buffer | undefined;
  let opened: fs.Stats | undefined;
  let operationError: unknown;
  try {
    opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino
    ) {
      throw new DaemonStartupUnavailableError(
        `Windows ACL infrastructure receipt changed before open: ${receiptFile}`,
      );
    }
    options.duringWindowsAclReceiptRead?.(receiptFile);
    bytes = fs.readFileSync(descriptor);
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
      "Windows ACL receipt read and descriptor cleanup failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  const after = fs.lstatSync(receiptFile);
  if (
    after.isSymbolicLink() ||
    after.dev !== opened!.dev ||
    after.ino !== opened!.ino ||
    after.size !== opened!.size ||
    after.mtimeMs !== opened!.mtimeMs
  ) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL infrastructure receipt changed during read: ${receiptFile}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes!.toString("utf8"));
  } catch (error) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL infrastructure receipt is malformed: ${receiptFile}`,
      { cause: error },
    );
  }
  const root = fs.realpathSync.native(directory);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).root !== root ||
    (parsed as Record<string, unknown>).setup !== "complete"
  ) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL infrastructure receipt does not validate this startup authority: ${receiptFile}`,
    );
  }
}

function readStableJsonWithoutDirectoryMutation<T>(
  file: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  let before: fs.Stats;
  let descriptor: number;
  try {
    before = fs.lstatSync(file);
    const reparseTag = (
      before as fs.Stats & { reparsePointTag?: number }
    ).reparsePointTag;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (reparseTag !== undefined && reparseTag !== 0) ||
      before.size > 64 * 1024
    ) {
      throw new DaemonStartupUnavailableError(
        `${label} is not a safe regular file and was preserved: ${file}`,
      );
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  } catch (error) {
    if (error instanceof DaemonStartupUnavailableError) throw error;
    throw new DaemonStartupUnavailableError(
      `Could not open ${label} without mutation: ${file}`,
      { cause: error },
    );
  }
  let bytes: Buffer | undefined;
  let operationError: unknown;
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new DaemonStartupUnavailableError(
        `${label} changed before open and was preserved: ${file}`,
      );
    }
    bytes = fs.readFileSync(descriptor);
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
      `${label} read and descriptor cleanup both failed`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  const after = fs.lstatSync(file);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new DaemonStartupUnavailableError(
      `${label} changed during read and was preserved: ${file}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes!.toString("utf8"));
  } catch (error) {
    throw new DaemonStartupUnavailableError(
      `${label} is malformed and was preserved: ${file}`,
      { cause: error },
    );
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new DaemonStartupUnavailableError(
      `${label} has invalid content and was preserved: ${file}`,
      { cause: validated.error },
    );
  }
  return validated.data;
}

const windowsAclReceiptSchema = z
  .object({
    version: z.literal(1),
    root: z.string().min(1),
    setup: z.literal("complete"),
  })
  .strict();

interface StableStartupDirectory {
  readonly stats: fs.Stats;
  readonly canonicalPath: string;
  readonly entries: readonly string[];
}

function inspectStartupDirectory(
  directory: string,
  options: DaemonControlOptions,
  allowedEntries: ReadonlySet<string>,
): StableStartupDirectory {
  let stats: fs.Stats;
  let canonicalPath: string;
  let entries: string[];
  try {
    stats = fs.lstatSync(directory);
    const reparseTag = (
      stats as fs.Stats & { reparsePointTag?: number }
    ).reparsePointTag;
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (reparseTag !== undefined && reparseTag !== 0)
    ) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup publication is not an ordinary directory: ${directory}`,
      );
    }
    canonicalPath = fs.realpathSync.native(directory);
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error instanceof DaemonStartupUnavailableError) throw error;
    throw new DaemonStartupUnavailableError(
      `Could not inspect daemon startup publication directory: ${directory}`,
      { cause: error },
    );
  }
  const platform = options.platform ?? process.platform;
  const receiptEntries = entries.filter(
    (entry) => entry.toLowerCase() === WINDOWS_ACL_RECEIPT_FILE,
  );
  if (
    platform === "win32" &&
    (receiptEntries.length !== 1 ||
      receiptEntries[0] !== WINDOWS_ACL_RECEIPT_FILE)
  ) {
    throw new DaemonStartupUnavailableError(
      `Windows daemon startup publication requires exactly one canonical ACL receipt: ${directory}`,
    );
  }
  for (const entry of entries) {
    if (allowedEntries.has(entry)) continue;
    if (platform === "win32" && entry === WINDOWS_ACL_RECEIPT_FILE) {
      validateWindowsAclReceipt(
        directory,
        path.join(directory, entry),
        options,
      );
      continue;
    }
    throw new DaemonStartupUnavailableError(
      `Unrecognized daemon startup publication artifact was preserved: ${path.join(directory, entry)}`,
    );
  }
  return { stats, canonicalPath, entries };
}

function assertStartupDirectoryUnchanged(
  directory: string,
  initial: StableStartupDirectory,
): void {
  let after: fs.Stats;
  let canonicalPath: string;
  try {
    after = fs.lstatSync(directory);
    canonicalPath = fs.realpathSync.native(directory);
  } catch (error) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup publication directory changed during validation: ${directory}`,
      { cause: error },
    );
  }
  if (
    after.dev !== initial.stats.dev ||
    after.ino !== initial.stats.ino ||
    canonicalPath !== initial.canonicalPath
  ) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup publication directory changed during validation: ${directory}`,
    );
  }
}

function prepareQuarantineAclForRecovery(
  token: string,
  options: DaemonControlOptions,
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  const directory = startupQuarantineDirectory(token, options);
  let stats: fs.Stats;
  let entries: string[];
  try {
    stats = fs.lstatSync(directory);
    const reparseTag = (
      stats as fs.Stats & { reparsePointTag?: number }
    ).reparsePointTag;
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (reparseTag !== undefined && reparseTag !== 0)
    ) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup quarantine is not an ordinary directory and was preserved: ${directory}`,
      );
    }
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error instanceof DaemonStartupUnavailableError) throw error;
    if (errno(error, "ENOENT")) return;
    throw new DaemonStartupUnavailableError(
      `Could not preflight daemon startup quarantine ACL recovery: ${directory}`,
      { cause: error },
    );
  }
  const allowed = new Set([
    STARTUP_CLAIM_FILE,
    STARTUP_RETIREMENT_FILE,
    WINDOWS_ACL_RECEIPT_FILE,
  ]);
  const receiptEntries = entries.filter(
    (entry) => entry.toLowerCase() === WINDOWS_ACL_RECEIPT_FILE,
  );
  if (
    receiptEntries.length !== 1 ||
    receiptEntries[0] !== WINDOWS_ACL_RECEIPT_FILE ||
    entries.some((entry) => !allowed.has(entry))
  ) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup quarantine ACL recovery found an unknown or noncanonical inventory and preserved it: ${directory}`,
    );
  }
  const claim = readStableJsonWithoutDirectoryMutation(
    startupClaimFile(directory),
    startupSchema,
    "Daemon startup quarantine claim",
  );
  if (claim.token !== token) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup quarantine claim does not exactly match its named token and was preserved: ${directory}`,
    );
  }
  if (entries.includes(STARTUP_RETIREMENT_FILE)) {
    const retirement = readStableJsonWithoutDirectoryMutation(
      startupRetirementFile(directory),
      startupRetirementSchema,
      "Daemon startup quarantine retirement",
    );
    if (retirement.token !== token) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup quarantine retirement does not exactly match its named token and was preserved: ${directory}`,
      );
    }
  }
  const receipt = readStableJsonWithoutDirectoryMutation(
    path.join(directory, WINDOWS_ACL_RECEIPT_FILE),
    windowsAclReceiptSchema,
    "Windows ACL infrastructure receipt",
  );
  const quarantineRoot = fs.realpathSync.native(directory);
  if (receipt.root === quarantineRoot) return;
  const controlRoot = fs.realpathSync.native(controlDirectory(options));
  const priorAuthorityRoot = path.join(
    controlRoot,
    STARTUP_AUTHORITY_DIRECTORY,
  );
  if (
    path.win32.normalize(receipt.root).toLowerCase() !==
      path.win32.normalize(priorAuthorityRoot).toLowerCase()
  ) {
    throw new DaemonStartupUnavailableError(
      `Windows ACL receipt names neither the quarantine nor its exact prior authority path and was preserved: ${directory}`,
    );
  }
  ensureSecureDirectory(directory);
}

interface QuarantinedStartup {
  readonly directory: string;
  readonly claim: PublicationRead<DaemonStartupClaim> & {
    readonly kind: "value";
  };
  readonly retirement: PublicationRead<
    z.infer<typeof startupRetirementSchema>
  >;
}

function readStartupCandidate(
  token: string,
  options: DaemonControlOptions,
  reader: PublicationReader = (
    file,
    schema,
  ) => readPublicationReadOnly(file, schema, options),
): PublicationRead<DaemonStartupClaim> | undefined {
  const directory = startupCandidateDirectory(token, options);
  let initial: StableStartupDirectory;
  try {
    initial = inspectStartupDirectory(
      directory,
      options,
      new Set([STARTUP_CLAIM_FILE]),
    );
  } catch (error) {
    if (errno((error as Error).cause, "ENOENT")) return undefined;
    throw error;
  }
  const claim = reader(startupClaimFile(directory), startupSchema);
  if (claim.kind === "value" && claim.value.token !== token) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup candidate claim does not exactly match its named token and was preserved: ${directory}`,
    );
  }
  assertStartupDirectoryUnchanged(directory, initial);
  return claim;
}

function readQuarantinedStartup(
  token: string,
  options: DaemonControlOptions,
  reader: PublicationReader = (
    file,
    schema,
  ) => readPublicationReadOnly(file, schema, options),
): QuarantinedStartup | undefined {
  const directory = startupQuarantineDirectory(token, options);
  let initial: StableStartupDirectory;
  try {
    initial = inspectStartupDirectory(
      directory,
      options,
      new Set([STARTUP_CLAIM_FILE, STARTUP_RETIREMENT_FILE]),
    );
  } catch (error) {
    if (errno((error as Error).cause, "ENOENT")) return undefined;
    throw error;
  }
  const claim = reader(startupClaimFile(directory), startupSchema);
  if (claim.kind !== "value" || claim.value.token !== token) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup quarantine claim does not exactly match its named token and was preserved: ${directory}`,
    );
  }
  const retirement = reader(
    startupRetirementFile(directory),
    startupRetirementSchema,
  );
  if (
    retirement.kind === "value" &&
    retirement.value.token !== token
  ) {
    throw new DaemonStartupUnavailableError(
      `Daemon startup quarantine retirement does not exactly match its named token and was preserved: ${directory}`,
    );
  }
  assertStartupDirectoryUnchanged(directory, initial);
  return { directory, claim, retirement };
}

function readFixedStartupAuthority(
  options: DaemonControlOptions,
  reader: PublicationReader = readPublication,
): StartupAuthority | undefined {
  const directory = startupAuthorityDirectory(options);
  const claimFile = startupClaimFile(directory);
  let initial: StableStartupDirectory;
  try {
    initial = inspectStartupDirectory(
      directory,
      options,
      new Set([STARTUP_CLAIM_FILE]),
    );
  } catch (error) {
    if (errno((error as Error).cause, "ENOENT")) return undefined;
    throw error;
  }
  const observed = reader(claimFile, startupSchema);
  if (observed.kind === "missing") {
    throw new DaemonStartupUnavailableError(
      `Daemon startup authority has no valid claim: ${directory}`,
    );
  }
  assertStartupDirectoryUnchanged(directory, initial);
  return {
    kind: "fixed",
    directory,
    claimFile,
    claim: observed.value,
    modifiedMs: observed.modifiedMs,
  };
}

function assertKnownStartupArtifacts(options: DaemonControlOptions): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(controlDirectory(options));
  } catch (error) {
    if (errno(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith("daemon-startup-v2-")) continue;
    if (entry === STARTUP_AUTHORITY_DIRECTORY) continue;
    const candidate = entry.startsWith(STARTUP_CANDIDATE_PREFIX)
      ? entry.slice(STARTUP_CANDIDATE_PREFIX.length)
      : undefined;
    const quarantine = entry.startsWith(STARTUP_QUARANTINE_PREFIX)
      ? entry.slice(STARTUP_QUARANTINE_PREFIX.length)
      : undefined;
    const child = entry.startsWith(STARTUP_CHILD_PREFIX) &&
        entry.endsWith(".json")
      ? entry.slice(STARTUP_CHILD_PREFIX.length, -".json".length)
      : undefined;
    const cleanup = entry.startsWith(STARTUP_CLEANUP_PREFIX) &&
        entry.endsWith(".json")
      ? entry.slice(STARTUP_CLEANUP_PREFIX.length, -".json".length)
      : undefined;
    const retired = entry.startsWith(STARTUP_RETIRED_CLEANUP_PREFIX) &&
        entry.endsWith(".json")
      ? entry.slice(
          STARTUP_RETIRED_CLEANUP_PREFIX.length,
          -".json".length,
        )
      : undefined;
    const retiredToken = retired?.slice(0, 36);
    const retiredOperation = retired?.slice(37);
    const token = candidate ?? quarantine ?? child ?? cleanup;
    if (
      (token !== undefined &&
        z.string().uuid().safeParse(token).success) ||
      (retired !== undefined &&
        retired[36] === "-" &&
        z.string().uuid().safeParse(retiredToken).success &&
        z.string().uuid().safeParse(retiredOperation).success)
    ) {
      continue;
    }
    throw new DaemonStartupUnavailableError(
      `Unrecognized daemon startup artifact: ${path.join(controlDirectory(options), entry)}`,
    );
  }
}

function readStartupAuthority(
  options: DaemonControlOptions,
  reader: PublicationReader = readPublication,
): StartupAuthority | undefined {
  assertKnownStartupArtifacts(options);
  const legacy = reader(legacyStartupFile(options), startupSchema);
  const fixed = readFixedStartupAuthority(options, reader);
  if (legacy.kind === "value" && fixed !== undefined) {
    throw new DaemonStartupUnavailableError(
      "Legacy and fixed daemon startup authorities coexist; inspect them manually",
    );
  }
  if (legacy.kind === "value") {
    return {
      kind: "legacy",
      directory: controlDirectory(options),
      claimFile: legacyStartupFile(options),
      claim: legacy.value,
      modifiedMs: legacy.modifiedMs,
    };
  }
  return fixed;
}

function startupCleanup(
  authority: StartupAuthority,
  options: DaemonControlOptions,
  reader: PublicationReader = readPublication,
): PublicationRead<z.infer<typeof startupCleanupSchema>> {
  if (authority.kind === "legacy") return { kind: "missing" };
  const observed = reader(
    startupCleanupFile(authority.claim.token, options),
    startupCleanupSchema,
  );
  if (
    observed.kind === "value" &&
    observed.value.token !== authority.claim.token
  ) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup cleanup marker does not match its authority token",
    );
  }
  return observed;
}

function effectiveStartupClaim(
  authority: StartupAuthority,
  options: DaemonControlOptions,
  reader: PublicationReader = readPublication,
): DaemonStartupClaim {
  if (authority.kind === "legacy") {
    return {
      ...authority.claim,
      heartbeatMs: Math.max(
        authority.claim.heartbeatMs,
        authority.modifiedMs,
      ),
    };
  }
  const child = reader(
    startupChildFile(authority.claim.token, options),
    startupChildSchema,
  );
  if (
    child.kind === "value" &&
    child.value.token !== authority.claim.token
  ) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup child binding does not match its authority token",
    );
  }
  return {
    ...authority.claim,
    childPid:
      child.kind === "value"
        ? child.value.childPid
        : authority.claim.childPid,
    heartbeatMs: Math.max(
      authority.claim.heartbeatMs,
      authority.modifiedMs,
    ),
  };
}

function observeDaemonStartupWith(
  options: DaemonControlOptions,
  reader: PublicationReader,
): DaemonStartupObservation {
  const authority = readStartupAuthority(options, reader);
  if (authority === undefined) {
    let entries: string[];
    try {
      entries = fs.readdirSync(controlDirectory(options));
    } catch (error) {
      if (errno(error, "ENOENT")) return { kind: "missing" };
      throw error;
    }
    const candidates = entries.filter((entry) =>
      entry.startsWith(STARTUP_CANDIDATE_PREFIX)
    );
    const quarantines = entries.filter((entry) =>
      entry.startsWith(STARTUP_QUARANTINE_PREFIX)
    );
    if (quarantines.length > 0) {
      if (quarantines.length !== 1 || candidates.length !== 0) {
        throw new DaemonStartupUnavailableError(
          "Multiple or overlapping daemon startup publications are present during retirement",
        );
      }
      const quarantineDirectory = path.join(
        controlDirectory(options),
        quarantines[0]!,
      );
      const namedToken = quarantines[0]!.slice(
        STARTUP_QUARANTINE_PREFIX.length,
      );
      const quarantine = readQuarantinedStartup(
        namedToken,
        options,
        reader,
      );
      if (quarantine === undefined) {
        throw new DaemonStartupUnavailableError(
          `Daemon startup quarantine disappeared during observation: ${quarantineDirectory}`,
        );
      }
      const captured = quarantine.claim;
      const marker = reader(
        startupCleanupFile(namedToken, options),
        startupCleanupSchema,
      );
      if (
        marker.kind === "value" &&
        marker.value.token !== namedToken
      ) {
        throw new DaemonStartupUnavailableError(
          "Daemon startup quarantine cleanup marker has a different token",
        );
      }
      const child = reader(
        startupChildFile(namedToken, options),
        startupChildSchema,
      );
      if (
        child.kind === "value" &&
        child.value.token !== namedToken
      ) {
        throw new DaemonStartupUnavailableError(
          "Daemon startup quarantine child binding has a different token",
        );
      }
      const claim = {
        ...captured.value,
        childPid:
          child.kind === "value"
            ? child.value.childPid
            : captured.value.childPid,
        heartbeatMs: Math.max(
          captured.value.heartbeatMs,
          captured.modifiedMs,
        ),
      };
      const age = checkedAge(
        now(options),
        claim.heartbeatMs,
        "Daemon startup retirement heartbeat",
        DaemonStartupUnavailableError,
      );
      return {
        kind: "starting",
        claim,
        authority: "quarantine",
        freshness:
          age <= DAEMON_STARTUP_STALE_MS ? "fresh" : "stale",
      };
    }
    if (candidates.length === 0) return { kind: "missing" };
    if (candidates.length !== 1) {
      throw new DaemonStartupUnavailableError(
        "Multiple daemon startup candidates are being published",
      );
    }
    const candidateDirectory = path.join(
      controlDirectory(options),
      candidates[0]!,
    );
    const namedToken = candidates[0]!.slice(
      STARTUP_CANDIDATE_PREFIX.length,
    );
    const candidate = readStartupCandidate(
      namedToken,
      options,
      reader,
    );
    if (
      candidate?.kind !== "value" ||
      candidate.value.token !== namedToken
    ) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup candidate is incomplete or inconsistent: ${candidateDirectory}`,
      );
    }
    const age = checkedAge(
      now(options),
      candidate.value.heartbeatMs,
      "Daemon startup candidate heartbeat",
      DaemonStartupUnavailableError,
    );
    return {
      kind: "starting",
      claim: candidate.value,
      authority: "candidate",
      freshness:
        age <= DAEMON_STARTUP_STALE_MS
          ? "fresh"
          : "stale",
    };
  }
  startupCleanup(authority, options, reader);
  const claim = effectiveStartupClaim(authority, options, reader);
  const age = checkedAge(
    now(options),
    claim.heartbeatMs,
    "Daemon startup heartbeat",
    DaemonStartupUnavailableError,
  );
  return {
    kind: "starting",
    claim,
    authority: authority.kind,
    freshness:
      age <= DAEMON_STARTUP_STALE_MS
        ? "fresh"
        : "stale",
  };
}

export function observeDaemonStartup(
  options: DaemonControlOptions = {},
): DaemonStartupObservation {
  return observeDaemonStartupWith(options, readPublication);
}

export function observeDaemonStartupReadOnly(
  options: DaemonControlOptions = {},
): DaemonStartupObservation {
  return observeDaemonStartupWith(
    options,
    <T>(file: string, schema: z.ZodType<T>) =>
      readPublicationReadOnly(file, schema, options),
  );
}

function removeTokenDirectory(directory: string): void {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(directory);
  } catch (error) {
    if (errno(error, "ENOENT")) return;
    throw error;
  }
  const tag = (before as fs.Stats & { reparsePointTag?: number })
    .reparsePointTag;
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (tag !== undefined && tag !== 0)
  ) {
    throw new DaemonStartupUnavailableError(
      `Refusing recursive mutation of non-ordinary startup directory: ${directory}`,
    );
  }
  const confirmed = fs.lstatSync(directory);
  if (confirmed.dev !== before.dev || confirmed.ino !== before.ino) {
    throw new DaemonStartupUnavailableError(
      `Startup directory changed before recursive mutation: ${directory}`,
    );
  }
  try {
    fs.rmSync(directory, { recursive: true });
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
}

function sameStartupCleanup(
  left: z.infer<typeof startupCleanupSchema>,
  right: z.infer<typeof startupCleanupSchema>,
): boolean {
  return (
    left.token === right.token &&
    left.operationId === right.operationId &&
    left.cleanerPid === right.cleanerPid &&
    left.cleanerIdentity === right.cleanerIdentity
  );
}

function publishStartupRetirement(
  quarantine: QuarantinedStartup,
  cleanup: z.infer<typeof startupCleanupSchema>,
  options: DaemonControlOptions,
): z.infer<typeof startupRetirementSchema> {
  if (quarantine.claim.value.token !== cleanup.token) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup retirement token does not match its quarantine",
    );
  }
  const retirement = {
    ...cleanup,
    phase: "committed" as const,
  };
  if (quarantine.retirement.kind === "value") {
    if (!sameStartupCleanup(quarantine.retirement.value, cleanup)) {
      throw new DaemonStartupUnavailableError(
        "A different daemon startup retirement is already committed; evidence was preserved",
      );
    }
    return quarantine.retirement.value;
  }
  if (
    !createExclusivePublication(
      startupRetirementFile(quarantine.directory),
      retirement,
    )
  ) {
    const raced = readQuarantinedStartup(cleanup.token, options);
    if (
      raced?.retirement.kind !== "value" ||
      !sameStartupCleanup(raced.retirement.value, cleanup)
    ) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup retirement changed during commit; evidence was preserved",
      );
    }
    return raced.retirement.value;
  }
  const committed = readQuarantinedStartup(cleanup.token, options);
  if (
    committed?.retirement.kind !== "value" ||
    !sameStartupCleanup(committed.retirement.value, cleanup)
  ) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup retirement commit could not be verified",
    );
  }
  return committed.retirement.value;
}

function removeRetiredStartupCleanupArtifacts(
  token: string,
  options: DaemonControlOptions,
): void {
  for (const entry of fs.readdirSync(controlDirectory(options))) {
    if (
      entry.startsWith(
        `${STARTUP_RETIRED_CLEANUP_PREFIX}${token}-`,
      )
    ) {
      removeIfPresent(path.join(controlDirectory(options), entry));
    }
  }
}

function finishQuarantinedStartup(
  token: string,
  cleanup: z.infer<typeof startupCleanupSchema>,
  options: DaemonControlOptions,
): void {
  let quarantine = readQuarantinedStartup(token, options);
  if (quarantine === undefined) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup quarantine disappeared before exact retirement",
    );
  }
  const marker = readPublication(
    startupCleanupFile(token, options),
    startupCleanupSchema,
  );
  if (
    marker.kind !== "value" ||
    !sameStartupCleanup(marker.value, cleanup)
  ) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup cleanup authority changed before retirement commit",
    );
  }
  removeIfPresent(startupChildFile(token, options));
  removeRetiredStartupCleanupArtifacts(token, options);
  publishStartupRetirement(quarantine, cleanup, options);
  if (!releaseStartupCleanup(cleanup, options)) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup retirement committed but its exact cleanup marker could not be confirmed released",
    );
  }
  options.afterStartupCleanupRelease?.(token);
  quarantine = readQuarantinedStartup(token, options);
  if (
    quarantine?.retirement.kind !== "value" ||
    !sameStartupCleanup(quarantine.retirement.value, cleanup)
  ) {
    throw new DaemonStartupUnavailableError(
      "Committed daemon startup quarantine changed before exact removal and was preserved",
    );
  }
  removeTokenDirectory(quarantine.directory);
}

function recoverQuarantinedStartup(
  token: string,
  options: DaemonControlOptions,
): void {
  prepareQuarantineAclForRecovery(token, options);
  const quarantine = readQuarantinedStartup(token, options);
  if (quarantine === undefined) return;
  if (ACTIVE_STARTUP_CLEANUP_TOKENS.has(token)) {
    throw new DaemonStartupUnavailableError(
      "This daemon startup cleanup operation is still active",
    );
  }
  const alive = options.pidAlive ?? defaultPidAlive;
  const currentIdentity =
    options.processIdentity ?? PROCESS_BIRTH_IDENTITY;
  if (quarantine.retirement.kind === "value") {
    const retirement = quarantine.retirement.value;
    const sameRuntime =
      retirement.cleanerPid === process.pid &&
      retirement.cleanerIdentity === currentIdentity;
    if (!sameRuntime && alive(retirement.cleanerPid)) {
      throw new DaemonStartupUnavailableError(
        `Committed daemon startup retirement for ${token} names live PID ${retirement.cleanerPid}, or that PID has been reused; automatic recovery is unsafe`,
      );
    }
    const marker = readPublicationReadOnly(
      startupCleanupFile(token, options),
      startupCleanupSchema,
      options,
    );
    if (
      marker.kind === "value" &&
      !sameStartupCleanup(marker.value, retirement)
    ) {
      throw new DaemonStartupUnavailableError(
        "Committed daemon startup retirement has a different cleanup marker; evidence was preserved",
      );
    }
    if (
      marker.kind === "value" &&
      !releaseStartupCleanup(retirement, options)
    ) {
      throw new DaemonStartupUnavailableError(
        "Committed daemon startup retirement could not release its exact cleanup marker",
      );
    }
    removeIfPresent(startupChildFile(token, options));
    const verified = readQuarantinedStartup(token, options);
    if (
      verified?.retirement.kind !== "value" ||
      !sameStartupCleanup(verified.retirement.value, retirement)
    ) {
      throw new DaemonStartupUnavailableError(
        "Committed daemon startup quarantine changed before recovery and was preserved",
      );
    }
    removeTokenDirectory(verified.directory);
    removeRetiredStartupCleanupArtifacts(token, options);
    return;
  }

  const cleanup = acquireStartupCleanup(token, options);
  ACTIVE_STARTUP_CLEANUPS.add(cleanup.operationId);
  ACTIVE_STARTUP_CLEANUP_TOKENS.add(cleanup.token);
  try {
    finishQuarantinedStartup(token, cleanup, options);
  } finally {
    ACTIVE_STARTUP_CLEANUPS.delete(cleanup.operationId);
    ACTIVE_STARTUP_CLEANUP_TOKENS.delete(cleanup.token);
  }
}

function sweepInactiveStartupArtifacts(
  options: DaemonControlOptions,
): void {
  assertKnownStartupArtifacts(options);
  let entries: string[];
  try {
    entries = fs.readdirSync(controlDirectory(options));
  } catch (error) {
    if (errno(error, "ENOENT")) return;
    throw error;
  }
  const activeToken = readFixedStartupAuthority(options)?.claim.token;
  const quarantinedTokens = new Set(
    entries
      .filter((entry) => entry.startsWith(STARTUP_QUARANTINE_PREFIX))
      .map((entry) => entry.slice(STARTUP_QUARANTINE_PREFIX.length)),
  );
  for (const entry of entries) {
    const artifact = path.join(controlDirectory(options), entry);
    if (entry.startsWith(STARTUP_CANDIDATE_PREFIX)) {
      const token = entry.slice(STARTUP_CANDIDATE_PREFIX.length);
      readStartupCandidate(token, options);
      removeTokenDirectory(artifact);
      continue;
    }
    if (entry.startsWith(STARTUP_QUARANTINE_PREFIX)) {
      const token = entry.slice(STARTUP_QUARANTINE_PREFIX.length);
      recoverQuarantinedStartup(token, options);
      continue;
    }
    const tokenArtifact = (
      prefix: string,
    ): string | undefined =>
      entry.startsWith(prefix) && entry.endsWith(".json")
        ? entry.slice(prefix.length, -".json".length)
        : undefined;
    const childToken = tokenArtifact(STARTUP_CHILD_PREFIX);
    const cleanupToken = tokenArtifact(STARTUP_CLEANUP_PREFIX);
    if (
      (childToken !== undefined && childToken !== activeToken) ||
      (cleanupToken !== undefined &&
        cleanupToken !== activeToken &&
        !quarantinedTokens.has(cleanupToken)) ||
      (entry.startsWith(STARTUP_RETIRED_CLEANUP_PREFIX) &&
        entry.slice(
          STARTUP_RETIRED_CLEANUP_PREFIX.length,
          STARTUP_RETIRED_CLEANUP_PREFIX.length + 36,
        ) !== activeToken)
    ) {
      removeIfPresent(artifact);
    }
  }
}

function publishStartupAuthority(
  claim: DaemonStartupClaim,
  options: DaemonControlOptions,
): boolean {
  ensureSecureDirectory(controlDirectory(options));
  const candidate = startupCandidateDirectory(claim.token, options);
  const authority = startupAuthorityDirectory(options);
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
  } catch (error) {
    if (errno(error, "EEXIST")) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup token already has a candidate artifact: ${claim.token}`,
        { cause: error },
      );
    }
    throw error;
  }
  let published = false;
  try {
    // A candidate is externally visible as soon as mkdir succeeds. Establish
    // its exact path-bound Windows ACL receipt before publishing claim data.
    ensureSecureDirectory(candidate);
    if (
      !createExclusivePublication(
        startupClaimFile(candidate),
        claim,
        claim.heartbeatMs,
      )
    ) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup candidate claim already exists",
      );
    }
    options.beforeStartupAppend?.(null);
    try {
      fs.renameSync(candidate, authority);
    } catch (error) {
      if (
        errno(error, "EEXIST") ||
        errno(error, "ENOTEMPTY") ||
        errno(error, "ENOENT") ||
        errno(error, "EPERM")
      ) {
        return false;
      }
      throw error;
    }
    published = true;
    // Windows ACL receipts are path-bound. Re-verify the renamed authority
    // and republish its exact receipt before protocol inventory reads it.
    // A failure here is postpublication and must remain observable.
    options.beforeStartupAuthorityAclVerification?.(claim.token);
    ensureSecureDirectory(authority);
    const verified = readFixedStartupAuthority(options);
    if (
      verified?.kind !== "fixed" ||
      verified.claim.token !== claim.token
    ) {
      throw new DaemonStartupUnavailableError(
        "Renamed daemon startup authority failed exact final-path validation",
      );
    }
    return true;
  } finally {
    if (!published) {
      const candidateClaim = readStartupCandidate(
        claim.token,
        options,
      );
      if (
        candidateClaim?.kind === "value" &&
        candidateClaim.value.token !== claim.token
      ) {
        throw new DaemonStartupUnavailableError(
          "Daemon startup candidate changed before cleanup and was preserved",
        );
      }
      removeTokenDirectory(candidate);
    }
  }
}

function acquireStartupCleanup(
  token: string,
  options: DaemonControlOptions,
): z.infer<typeof startupCleanupSchema> {
  const cleanupFile = startupCleanupFile(token, options);
  const alive = options.pidAlive ?? defaultPidAlive;
  const cleanerIdentity =
    options.processIdentity ?? PROCESS_BIRTH_IDENTITY;
  for (let attempt = 0; attempt < 16; attempt++) {
    const cleanup = {
      protocol: STARTUP_PROTOCOL,
      token,
      operationId: crypto.randomUUID(),
      cleanerPid: process.pid,
      cleanerIdentity,
    } as const;
    options.beforeStartupArtifactCreate?.(
      "cleanup",
      token,
    );
    if (createExclusivePublication(cleanupFile, cleanup)) return cleanup;
    const existing = readPublication(cleanupFile, startupCleanupSchema);
    if (existing.kind === "missing") continue;
    if (existing.value.token !== token) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup cleanup marker does not match its authority token",
      );
    }
    if (
      existing.value.cleanerPid === process.pid &&
      existing.value.cleanerIdentity === cleanerIdentity
    ) {
      if (ACTIVE_STARTUP_CLEANUPS.has(existing.value.operationId)) {
        throw new DaemonStartupUnavailableError(
          "This daemon startup cleanup operation is still active",
        );
      }
      return existing.value;
    }
    if (alive(existing.value.cleanerPid)) {
      throw new DaemonStartupUnavailableError(
        `Daemon startup cleanup for ${token} is owned by live PID ${existing.value.cleanerPid}, or that PID has been reused; automatic takeover is unsafe`,
      );
    }
    const retired = retiredStartupCleanupFile(
      token,
      existing.value.operationId,
      options,
    );
    try {
      fs.renameSync(cleanupFile, retired);
    } catch (error) {
      if (
        errno(error, "ENOENT") ||
        errno(error, "EEXIST") ||
        errno(error, "ENOTEMPTY") ||
        errno(error, "EPERM")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new DaemonStartupUnavailableError(
    "Daemon startup cleanup authority changed repeatedly; retry",
  );
}

function releaseStartupCleanup(
  cleanup: z.infer<typeof startupCleanupSchema>,
  options: DaemonControlOptions,
): boolean {
  const markerFile = startupCleanupFile(cleanup.token, options);
  const retiredFile = retiredStartupCleanupFile(
    cleanup.token,
    cleanup.operationId,
    options,
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(markerFile, retiredFile);
    } catch (error) {
      if (errno(error, "ENOENT")) return false;
      if (errno(error, "EEXIST") || errno(error, "ENOTEMPTY")) {
        const retired = readPublication(
          retiredFile,
          startupCleanupSchema,
        );
        if (
          retired.kind === "value" &&
          retired.value.token === cleanup.token &&
          retired.value.operationId === cleanup.operationId &&
          retired.value.cleanerIdentity === cleanup.cleanerIdentity
        ) {
          removeIfPresent(retiredFile);
          continue;
        }
      }
      throw new DaemonStartupUnavailableError(
        "Could not atomically release exact daemon startup cleanup marker",
        { cause: error },
      );
    }
    const captured = readPublication(
      retiredFile,
      startupCleanupSchema,
    );
    if (
      captured.kind === "value" &&
      captured.value.token === cleanup.token &&
      captured.value.operationId === cleanup.operationId &&
      captured.value.cleanerIdentity === cleanup.cleanerIdentity
    ) {
      removeIfPresent(retiredFile);
      return true;
    }
    if (captured.kind === "value") {
      try {
        fs.linkSync(retiredFile, markerFile);
      } catch (error) {
        if (!errno(error, "EEXIST")) {
          throw new DaemonStartupUnavailableError(
            "Could not restore a different captured startup cleanup marker",
            { cause: error },
          );
        }
      }
    }
    throw new DaemonStartupUnavailableError(
      "Startup cleanup marker changed during exact release; preserved captured evidence",
    );
  }
  throw new DaemonStartupUnavailableError(
    "Exact daemon startup cleanup marker could not be released after repeated collisions",
  );
}

function retireStartupAuthority(
  token: string,
  options: DaemonControlOptions,
  requireOrphan: boolean,
): boolean {
  if (ACTIVE_STARTUP_CLEANUP_TOKENS.has(token)) {
    throw new DaemonStartupUnavailableError(
      "This daemon startup cleanup operation is still active",
    );
  }
  const initial = readStartupAuthority(options);
  if (initial === undefined) {
    recoverQuarantinedStartup(token, options);
    return true;
  }
  if (
    initial.kind !== "fixed" ||
    initial.claim.token !== token
  ) {
    return false;
  }
  const cleanup = acquireStartupCleanup(token, options);
  ACTIVE_STARTUP_CLEANUPS.add(cleanup.operationId);
  ACTIVE_STARTUP_CLEANUP_TOKENS.add(cleanup.token);
  let completed = false;
  let quarantined = false;
  let primaryError: unknown;
  try {
    options.beforeExclusiveUnlink?.("startup");
    const current = readStartupAuthority(options);
    if (
      current === undefined ||
      current.kind !== "fixed" ||
      current.claim.token !== token
    ) {
      return current === undefined;
    }
    const marker = readPublication(
      startupCleanupFile(token, options),
      startupCleanupSchema,
    );
    if (
      marker.kind !== "value" ||
      marker.value.token !== token ||
      marker.value.operationId !== cleanup.operationId ||
      marker.value.cleanerIdentity !== cleanup.cleanerIdentity
    ) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup cleanup authority changed after exact acquisition",
      );
    }
    const effective = effectiveStartupClaim(current, options);
    const alive = options.pidAlive ?? defaultPidAlive;
    const effectiveAge = checkedAge(
      now(options),
      effective.heartbeatMs,
      "Daemon startup heartbeat",
      DaemonStartupUnavailableError,
    );
    if (
      requireOrphan &&
      (startupActorAlive(effective, alive) ||
        effectiveAge <= DAEMON_STARTUP_ORPHAN_GRACE_MS)
    ) {
      return false;
    }
    const quarantine = startupQuarantineDirectory(token, options);
    try {
      options.beforeStartupAuthorityRetirement?.(token);
      fs.renameSync(current.directory, quarantine);
      quarantined = true;
    } catch (error) {
      const captured = readPublicationReadOnly(
        startupClaimFile(quarantine),
        startupSchema,
        options,
      );
      if (
        captured.kind === "value" &&
        captured.value.token === token
      ) {
        quarantined = true;
      } else {
        const reobserved = readStartupAuthority(options);
        if (
          reobserved?.kind === "fixed" &&
          reobserved.claim.token === token
        ) {
          throw new DaemonStartupUnavailableError(
            "Daemon startup authority retirement did not complete; retry",
            { cause: error },
          );
        }
        if (
          reobserved !== undefined &&
          reobserved.claim.token !== token
        ) {
          return false;
        }
        if (
          errno(error, "ENOENT") ||
          errno(error, "EEXIST") ||
          errno(error, "ENOTEMPTY") ||
          errno(error, "EPERM")
        ) {
          throw new DaemonStartupUnavailableError(
            "Daemon startup authority retirement outcome is unavailable",
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (!quarantined) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup authority retirement was not confirmed",
      );
    }
    // The ACL receipt is bound to the old authority path. Republish and then
    // validate the complete quarantine inventory before any deletion.
    options.beforeStartupQuarantineAclVerification?.(token);
    ensureSecureDirectory(quarantine);
    const quarantinedState = readQuarantinedStartup(token, options);
    const quarantinedMarker = readPublication(
      startupCleanupFile(token, options),
      startupCleanupSchema,
    );
    if (
      quarantinedState === undefined ||
      quarantinedMarker.kind !== "value" ||
      !sameStartupCleanup(quarantinedMarker.value, cleanup)
    ) {
      throw new DaemonStartupUnavailableError(
        `Quarantined daemon startup authority failed exact verification: ${quarantine}`,
      );
    }
    options.afterStartupAuthorityQuarantine?.(token);
    finishQuarantinedStartup(token, cleanup, options);
    completed = true;
    return true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (!completed && !quarantined) {
        try {
          if (!releaseStartupCleanup(cleanup, options)) {
            throw new DaemonStartupUnavailableError(
              "Exact startup cleanup marker disappeared before release confirmation",
            );
          }
        } catch (cleanupError) {
          if (primaryError !== undefined) {
            throw new AggregateError(
              [primaryError, cleanupError],
              "Daemon startup retirement and exact marker cleanup both failed",
            );
          }
          throw cleanupError;
        }
      }
    } finally {
      ACTIVE_STARTUP_CLEANUPS.delete(cleanup.operationId);
      ACTIVE_STARTUP_CLEANUP_TOKENS.delete(cleanup.token);
    }
  }
}

/**
 * Acquire the exclusive startup publication before any SQLite construction.
 * The fixed authority directory is atomically installed and exact-token
 * retirement is first fenced inside that directory.
 */
export function claimDaemonStartup(
  ownerPid: number = process.pid,
  options: DaemonControlOptions = {},
): DaemonStartupClaimResult {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new TypeError("ownerPid must be a positive safe integer");
  }
  const alive = options.pidAlive ?? defaultPidAlive;
  const claim: DaemonStartupClaim = {
    protocol: STARTUP_PROTOCOL,
    token: options.instanceId ?? crypto.randomUUID(),
    ownerPid,
    childPid: null,
    heartbeatMs: now(options),
  };
  if (!z.string().uuid().safeParse(claim.token).success) {
    throw new TypeError("instanceId must be a UUID");
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    sweepInactiveStartupArtifacts(options);
    const authority = readStartupAuthority(options);
    if (authority === undefined) {
      if (publishStartupAuthority(claim, options)) {
        const acquired = readStartupAuthority(options);
        if (
          acquired?.kind === "fixed" &&
          acquired.claim.token === claim.token &&
          startupCleanup(acquired, options).kind === "missing"
        ) {
          return { kind: "acquired", claim };
        }
        throw new DaemonStartupUnavailableError(
          "Daemon startup authority changed immediately after acquisition",
        );
      }
      continue;
    }
    const current = effectiveStartupClaim(authority, options);
    if (authority.kind === "legacy") {
      throw new DaemonStartupUnavailableError(
        "Recognized legacy daemon startup authority cannot be retired safely by normal startup; use the verified installer replacement path",
      );
    }
    const startupAge = checkedAge(
      now(options),
      current.heartbeatMs,
      "Daemon startup heartbeat",
      DaemonStartupUnavailableError,
    );
    if (
      startupActorAlive(current, alive) ||
        startupAge <= DAEMON_STARTUP_ORPHAN_GRACE_MS
    ) {
      return {
        kind: "busy",
        claim: current,
        freshness:
          startupAge <= DAEMON_STARTUP_STALE_MS
            ? "fresh"
            : "stale",
      };
    }
    options.beforeStartupAppend?.(current.token);
    retireStartupAuthority(current.token, options, true);
  }
  throw new DaemonStartupUnavailableError(
    "Daemon startup authority changed repeatedly; retry",
  );
}

function requireCurrentStartupAuthority(
  token: string,
  options: DaemonControlOptions,
  message: string,
): StartupAuthority {
  const authority = readStartupAuthority(options);
  if (
    authority === undefined ||
    authority.kind !== "fixed" ||
    authority.claim.token !== token ||
    startupCleanup(authority, options).kind !== "missing"
  ) {
    throw new DaemonStartupUnavailableError(message);
  }
  return authority;
}

export function bindDaemonStartupChild(
  token: string,
  childPid: number = process.pid,
  options: DaemonControlOptions = {},
): DaemonStartupClaim {
  if (!z.string().uuid().safeParse(token).success) {
    throw new TypeError("startup token must be a UUID");
  }
  if (!Number.isSafeInteger(childPid) || childPid <= 0) {
    throw new TypeError("childPid must be a positive safe integer");
  }
  const initial = requireCurrentStartupAuthority(
    token,
    options,
    "Daemon startup claim is no longer the current uncompleted authority",
  );
  const observed = effectiveStartupClaim(initial, options);
  if (observed.childPid !== null && observed.childPid !== childPid) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup claim is already bound to another child",
    );
  }
  const binding = {
    protocol: STARTUP_PROTOCOL,
    token,
    childPid,
  } as const;
  const childFile = startupChildFile(token, options);
  options.beforeStartupArtifactCreate?.("bind", token);
  let createdBinding = false;
  if (
    !createExclusivePublication(
      childFile,
      binding,
    )
  ) {
    const existing = readPublication(
      childFile,
      startupChildSchema,
    );
    if (
      existing.kind !== "value" ||
      existing.value.token !== token ||
      existing.value.childPid !== childPid
    ) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup claim is already bound to another child",
      );
    }
  } else {
    createdBinding = true;
  }
  options.beforeStartupMutation?.("bind", token);
  try {
    const current = requireCurrentStartupAuthority(
      token,
      options,
      "Daemon startup claim changed before child adoption",
    );
    touchExactPublication(
      current.claimFile,
      startupSchema,
      (value) => value.token === token,
      now(options),
      "Daemon startup claim changed before child adoption",
    );
    const confirmed = requireCurrentStartupAuthority(
      token,
      options,
      "Daemon startup claim changed during child adoption",
    );
    const adopted = effectiveStartupClaim(confirmed, options);
    if (adopted.childPid !== childPid) {
      throw new DaemonStartupUnavailableError(
        "Daemon startup child binding changed during adoption",
      );
    }
    return {
      ...adopted,
      heartbeatMs: Math.max(adopted.heartbeatMs, now(options)),
    };
  } catch (error) {
    if (createdBinding) removeIfPresent(childFile);
    if (error instanceof DaemonControlUnavailableError) {
      throw new DaemonStartupUnavailableError(error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

export function refreshDaemonStartup(
  claim: DaemonStartupClaim,
  options: DaemonControlOptions = {},
): DaemonStartupClaim {
  const initial = requireCurrentStartupAuthority(
    claim.token,
    options,
    "Daemon startup claim changed before refresh",
  );
  if (initial.claim.ownerPid !== claim.ownerPid) {
    throw new DaemonStartupUnavailableError(
      "Daemon startup owner changed before refresh",
    );
  }
  options.beforeStartupMutation?.("refresh", claim.token);
  const current = requireCurrentStartupAuthority(
    claim.token,
    options,
    "Daemon startup claim changed before refresh",
  );
  const heartbeatMs = now(options);
  try {
    touchExactPublication(
      current.claimFile,
      startupSchema,
      (value) =>
        value.token === claim.token &&
        value.ownerPid === claim.ownerPid,
      heartbeatMs,
      "Daemon startup claim changed before refresh",
    );
  } catch (error) {
    if (error instanceof DaemonControlUnavailableError) {
      throw new DaemonStartupUnavailableError(error.message, {
        cause: error,
      });
    }
    throw error;
  }
  requireCurrentStartupAuthority(
    claim.token,
    options,
    "Daemon startup claim changed during refresh",
  );
  return { ...claim, heartbeatMs };
}

export function clearDaemonStartup(
  claim: Pick<DaemonStartupClaim, "token">,
  options: DaemonControlOptions = {},
): boolean {
  if (!z.string().uuid().safeParse(claim.token).success) {
    throw new TypeError("startup token must be a UUID");
  }
  return retireStartupAuthority(claim.token, options, false);
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
