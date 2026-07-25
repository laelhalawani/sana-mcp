import crypto from "node:crypto";
import type {
  DaemonLeaseClaim,
  SanaStore,
  SyncState,
} from "../store/db.js";

export const DAEMON_STALE_MS = 30_000;
export type { DaemonLeaseClaim } from "../store/db.js";

export class DaemonLeaseLostError extends Error {
  readonly code = "DAEMON_LEASE_LOST";

  constructor(pid: number) {
    super(`Daemon lease no longer belongs to process ${pid}`);
    this.name = "DaemonLeaseLostError";
  }
}

export class DaemonStaleOwnerError extends Error {
  readonly code = "DAEMON_STALE_OWNER";

  constructor(readonly ownerPid: number) {
    super(
      `Daemon process ${ownerPid} is still running but its heartbeat is stale; stop that process and retry`,
    );
    this.name = "DaemonStaleOwnerError";
  }
}

export type DaemonStateStatus =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "alive"; pid: number }>
  | Readonly<{ kind: "dead"; pid: number }>
  | Readonly<{ kind: "stale-live"; pid: number }>;

/**
 * Claim the single daemon identity in SQLite. The store serializes the read,
 * liveness decision, and replacement in one immediate transaction.
 */
export function acquireDaemonLease(
  store: Pick<SanaStore, "claimDaemonLease">,
  pid: number = process.pid,
  now: number = Date.now(),
  alive: (ownerPid: number) => boolean = pidAlive,
  instanceId: string = crypto.randomUUID(),
): DaemonLeaseClaim {
  return store.claimDaemonLease(
    pid,
    instanceId,
    now,
    DAEMON_STALE_MS,
    alive,
  );
}

/** Renew only the lease still owned by this daemon. */
export function heartbeatDaemonLease(
  store: Pick<SanaStore, "renewDaemonLease">,
  instanceId: string,
  pid: number = process.pid,
  now: number = Date.now(),
): void {
  if (store.renewDaemonLease(pid, instanceId, now) === "not-owner") {
    throw new DaemonLeaseLostError(pid);
  }
}

export function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pid must be null or a positive safe integer");
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errno(error, "ESRCH")) return false;
    if (errno(error, "EPERM")) return true;
    throw new Error(`Could not determine whether process ${pid} is alive`, {
      cause: error,
    });
  }
}

export function daemonStateIsAlive(
  state: Pick<SyncState, "daemon_pid" | "daemon_heartbeat_ms">,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  return daemonStateStatus(state, now, alive).kind === "alive";
}

export function daemonStateStatus(
  state: Pick<SyncState, "daemon_pid" | "daemon_heartbeat_ms">,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): DaemonStateStatus {
  const pid = state.daemon_pid;
  const heartbeat = state.daemon_heartbeat_ms;
  if (pid === null) return { kind: "missing" };
  const processIsAlive = pid === process.pid || alive(pid);
  const heartbeatIsRecent =
    heartbeat !== null && now - heartbeat <= DAEMON_STALE_MS;
  if (processIsAlive && !heartbeatIsRecent) {
    return { kind: "stale-live", pid };
  }
  return processIsAlive
    ? { kind: "alive", pid }
    : { kind: "dead", pid };
}

export function isDaemonAlive(
  store: Pick<SanaStore, "getSyncState">,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  return daemonStateIsAlive(store.getSyncState(), now, alive);
}

function errno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
