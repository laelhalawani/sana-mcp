import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "../config.js";
import {
  ensureSecureDirectory,
  readJsonFile,
  writeJsonAtomic,
} from "../runtime/secure-files.js";

const CONTROL_PROTOCOL = 1;
const STATUS_FILE = "daemon-control.json";
const REQUEST_FILE = "daemon-stop.json";

const statusSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    pid: z.number().int().positive().safe(),
    instanceId: z.string().uuid(),
  })
  .strict();

const requestSchema = z
  .object({
    protocol: z.literal(CONTROL_PROTOCOL),
    instanceId: z.string().uuid(),
    operation: z.literal("stop"),
  })
  .strict();

export interface DaemonControlIdentity {
  readonly pid: number;
  readonly instanceId: string;
}

export class DaemonControlUnavailableError extends Error {
  readonly code = "DAEMON_CONTROL_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonControlUnavailableError";
  }
}

export interface DaemonControlOptions {
  /** @internal Isolated control root for deterministic tests. */
  readonly directory?: string;
  /** @internal Deterministic instance identity for tests. */
  readonly instanceId?: string;
}

function controlDirectory(options: DaemonControlOptions): string {
  return options.directory ?? dataDirectory();
}

function statusFile(options: DaemonControlOptions): string {
  return path.join(controlDirectory(options), STATUS_FILE);
}

function requestFile(options: DaemonControlOptions): string {
  return path.join(controlDirectory(options), REQUEST_FILE);
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

/** Publish the control identity after the daemon owns the SQLite lease. */
export function publishDaemonControl(
  pid: number = process.pid,
  options: DaemonControlOptions = {},
): DaemonControlIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pid must be a positive safe integer");
  }
  ensureSecureDirectory(controlDirectory(options));
  const identity = {
    pid,
    instanceId: options.instanceId ?? crypto.randomUUID(),
  };
  const parsed = statusSchema.shape.instanceId.safeParse(identity.instanceId);
  if (!parsed.success) throw new TypeError("instanceId must be a UUID");
  removeIfPresent(requestFile(options));
  writeJsonAtomic(statusFile(options), {
    protocol: CONTROL_PROTOCOL,
    ...identity,
  });
  return identity;
}

/** True only after the cooperative control record names this exact process. */
export function daemonControlReady(
  expectedPid: number,
  expectedInstanceId: string,
  options: DaemonControlOptions = {},
): boolean {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new TypeError("expectedPid must be a positive safe integer");
  }
  const parsed = statusSchema.shape.instanceId.safeParse(expectedInstanceId);
  if (!parsed.success) {
    throw new TypeError("expectedInstanceId must be a UUID");
  }
  const observed = readJsonFile(statusFile(options), statusSchema);
  return (
    observed.kind === "value" &&
    observed.value.pid === expectedPid &&
    observed.value.instanceId === expectedInstanceId
  );
}

/** Ask the exact active daemon instance to stop itself. */
export function requestDaemonStop(
  expectedPid: number,
  options: DaemonControlOptions = {},
): DaemonControlIdentity {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new TypeError("expectedPid must be a positive safe integer");
  }
  const observed = readJsonFile(statusFile(options), statusSchema);
  if (observed.kind === "missing" || observed.value.pid !== expectedPid) {
    throw new DaemonControlUnavailableError(
      `Daemon ${expectedPid} has no matching cooperative control record; stop it manually`,
    );
  }
  const identity = {
    pid: observed.value.pid,
    instanceId: observed.value.instanceId,
  };
  writeJsonAtomic(requestFile(options), {
    protocol: CONTROL_PROTOCOL,
    instanceId: identity.instanceId,
    operation: "stop",
  });
  return identity;
}

/** Called by the daemon at existing heartbeat/cycle boundaries. */
export function daemonStopRequested(
  instanceId: string,
  options: DaemonControlOptions = {},
): boolean {
  const observed = readJsonFile(requestFile(options), requestSchema);
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
  const status = readJsonFile(statusFile(options), statusSchema);
  if (
    status.kind === "value" &&
    status.value.pid === identity.pid &&
    status.value.instanceId === identity.instanceId
  ) {
    removeIfPresent(statusFile(options));
  }
  const request = readJsonFile(requestFile(options), requestSchema);
  if (
    request.kind === "value" &&
    request.value.instanceId === identity.instanceId
  ) {
    removeIfPresent(requestFile(options));
  }
}
