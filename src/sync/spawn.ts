import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SanaStore, type SyncState } from "../store/db.js";
import {
  daemonStateIsAlive,
  daemonStateStatus,
  DaemonStaleOwnerError,
  pidAlive,
} from "./lock.js";
import {
  PROJECT_ROOT,
  dataDirectory,
  ensureDataDir,
  isCompiledBinary,
} from "../config.js";
import { openSensitiveFile } from "../runtime/secure-files.js";
import { daemonControlReady } from "./control.js";

const DAEMON_READY_TIMEOUT_MS = 5_000;
const DAEMON_READY_POLL_MS = 25;

export class DaemonLaunchError extends Error {
  readonly code = "DAEMON_LAUNCH_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonLaunchError";
  }
}

type DaemonIdentity = Pick<
  SyncState,
  "daemon_pid" | "daemon_heartbeat_ms" | "daemon_instance_id"
>;

type ReadyResult = "child" | "concurrent";

export interface DaemonReadinessOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  readonly controlReady?: (pid: number, instanceId: string) => boolean;
}

/**
 * Wait for a structured SQLite heartbeat instead of treating process creation
 * as daemon readiness. A different new live owner means another concurrent
 * starter won the lease.
 */
export async function waitForDaemonReadiness(
  child: Pick<
    ChildProcess,
    "pid" | "once" | "off"
  >,
  store: Pick<SanaStore, "getSyncState">,
  baseline: DaemonIdentity,
  launchedAt: number,
  options: DaemonReadinessOptions = {},
): Promise<ReadyResult> {
  const timeoutMs = options.timeoutMs ?? DAEMON_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DAEMON_READY_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const processAlive = options.pidAlive ?? pidAlive;
  const controlPublished = options.controlReady ?? daemonControlReady;
  if (!Number.isSafeInteger(launchedAt) || launchedAt < 0) {
    throw new TypeError("launchedAt must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new TypeError("pollMs must be a positive safe integer");
  }

  type Terminal =
    | Readonly<{ kind: "error"; error: Error }>
    | Readonly<{
        kind: "exit";
        code: number | null;
        signal: NodeJS.Signals | null;
      }>;
  let settleTerminal!: (terminal: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve) => {
    settleTerminal = resolve;
  });
  const onError = (error: Error): void => {
    settleTerminal({ kind: "error", error });
  };
  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    settleTerminal({ kind: "exit", code, signal });
  };
  child.once("error", onError);
  child.once("exit", onExit);

  const deadline = launchedAt + timeoutMs;
  try {
    for (;;) {
      const observed = store.getSyncState();
      const childPid = child.pid;
      if (
        childPid !== undefined &&
        observed.daemon_pid === childPid &&
        observed.daemon_heartbeat_ms !== null &&
        observed.daemon_instance_id !== null &&
        observed.daemon_heartbeat_ms >= launchedAt &&
        processAlive(childPid) &&
        controlPublished(childPid, observed.daemon_instance_id)
      ) {
        return "child";
      }

      const changed =
        observed.daemon_pid !== baseline.daemon_pid ||
        observed.daemon_heartbeat_ms !== baseline.daemon_heartbeat_ms ||
        observed.daemon_instance_id !== baseline.daemon_instance_id;
      if (
        changed &&
        observed.daemon_pid !== childPid &&
        observed.daemon_instance_id !== null &&
        daemonStateIsAlive(observed, now(), processAlive) &&
        controlPublished(
          observed.daemon_pid!,
          observed.daemon_instance_id,
        )
      ) {
        return "concurrent";
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new DaemonLaunchError(
          `Daemon did not become ready within ${timeoutMs}ms`,
        );
      }

      const event = await Promise.race([
        terminal,
        sleep(Math.min(pollMs, remaining)).then(() => null),
      ]);
      if (event === null) continue;

      const finalState = store.getSyncState();
      const finalChanged =
        finalState.daemon_pid !== baseline.daemon_pid ||
        finalState.daemon_heartbeat_ms !== baseline.daemon_heartbeat_ms ||
        finalState.daemon_instance_id !== baseline.daemon_instance_id;
      if (
        finalChanged &&
        finalState.daemon_pid !== child.pid &&
        finalState.daemon_instance_id !== null &&
        daemonStateIsAlive(finalState, now(), processAlive) &&
        controlPublished(
          finalState.daemon_pid!,
          finalState.daemon_instance_id,
        )
      ) {
        return "concurrent";
      }
      if (event.kind === "error") {
        throw new DaemonLaunchError(
          "Daemon executable could not be launched",
          { cause: event.error },
        );
      }
      const detail =
        event.signal === null
          ? `exit code ${String(event.code)}`
          : `signal ${event.signal}`;
      throw new DaemonLaunchError(
        `Daemon exited before becoming ready (${detail})`,
      );
    }
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

interface DaemonStartStore {
  getSyncState(): SyncState;
  close(): void;
}

export interface DaemonStartDependencies {
  readonly createStore: () => DaemonStartStore;
  readonly prepareDataDir: () => void;
  readonly openLog: () => number;
  readonly closeLog: (descriptor: number) => void;
  readonly command: () => Readonly<{ executable: string; args: string[] }>;
  readonly spawnProcess: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pidAlive: (pid: number) => boolean;
  readonly controlReady: (pid: number, instanceId: string) => boolean;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly scheduleTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly cancelTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ExitWait {
  readonly exited: Promise<boolean>;
  cancel(): void;
}

function childExitWait(
  child: ChildProcess,
  timeoutMs: number,
  dependencies: Pick<
    DaemonStartDependencies,
    "scheduleTimer" | "cancelTimer"
  >,
): ExitWait {
  const schedule = dependencies.scheduleTimer ?? setTimeout;
  const cancel = dependencies.cancelTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let settle!: (exited: boolean) => void;
  const onExit = (): void => {
    finish(true);
  };
  const finish = (exited: boolean): void => {
    if (settled) return;
    settled = true;
    child.off("exit", onExit);
    if (timer !== undefined) cancel(timer);
    settle(exited);
  };
  const exited = new Promise<boolean>((resolve) => {
    settle = resolve;
    child.once("exit", onExit);
    timer = schedule(() => finish(false), timeoutMs);
    if (settled) cancel(timer);
  });
  return {
    exited,
    cancel: () => finish(false),
  };
}

async function stopAndReapChild(
  child: ChildProcess,
  dependencies: Pick<
    DaemonStartDependencies,
    "timeoutMs" | "scheduleTimer" | "cancelTimer"
  >,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const errors: unknown[] = [];
  if (child.pid === undefined) return;

  let exited = false;
  const gracefulWait = childExitWait(
    child,
    dependencies.timeoutMs,
    dependencies,
  );
  try {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      errors.push(error);
    }
    exited = await gracefulWait.exited;
  } finally {
    gracefulWait.cancel();
  }

  if (!exited && child.exitCode == null && child.signalCode == null) {
    const forcedWait = childExitWait(
      child,
      dependencies.timeoutMs,
      dependencies,
    );
    try {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        errors.push(error);
      }
      exited = await forcedWait.exited;
    } finally {
      forcedWait.cancel();
    }
  }

  if (
    !exited &&
    child.exitCode == null &&
    child.signalCode == null
  ) {
    errors.push(
      new DaemonLaunchError(
        `Daemon child did not exit after bounded SIGTERM and SIGKILL attempts`,
      ),
    );
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Daemon child stop and reap failed");
  }
}

const DEFAULT_DEPENDENCIES: DaemonStartDependencies = {
  createStore: () => new SanaStore(),
  prepareDataDir: ensureDataDir,
  openLog: () =>
    openSensitiveFile(path.join(dataDirectory(), "daemon.log"), "a"),
  closeLog: (descriptor) => fs.closeSync(descriptor),
  command: () =>
    isCompiledBinary()
      ? { executable: process.execPath, args: ["daemon"] }
      : {
          executable: process.execPath,
          args: [path.join(PROJECT_ROOT, "src", "daemon-main.ts")],
        },
  spawnProcess: (executable, args, options) =>
    spawn(executable, [...args], options),
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  pidAlive,
  controlReady: daemonControlReady,
  timeoutMs: DAEMON_READY_TIMEOUT_MS,
  pollMs: DAEMON_READY_POLL_MS,
  scheduleTimer: setTimeout,
  cancelTimer: clearTimeout,
};

export type EnsureDaemonResult = Readonly<{
  alreadyRunning: boolean;
  spawned: boolean;
}>;

/** @internal Dependency-injected implementation used by deterministic tests. */
export async function ensureDaemonRunningWith(
  dependencies: DaemonStartDependencies,
): Promise<EnsureDaemonResult> {
  const store = dependencies.createStore();
  let logDescriptor: number | undefined;
  let child: ChildProcess | undefined;
  let childAccepted = false;
  let result: EnsureDaemonResult | undefined;
  let primaryError: unknown;
  const childErrors: Error[] = [];
  const captureChildError = (error: Error): void => {
    childErrors.push(error);
  };

  try {
    let baseline = store.getSyncState();
    let baselineStatus = daemonStateStatus(
      baseline,
      dependencies.now(),
      dependencies.pidAlive,
    );
    if (baselineStatus.kind === "alive") {
      const deadline = dependencies.now() + dependencies.timeoutMs;
      for (;;) {
        const current = store.getSyncState();
        const currentStatus = daemonStateStatus(
          current,
          dependencies.now(),
          dependencies.pidAlive,
        );
        if (
          currentStatus.kind === "alive" &&
          current.daemon_instance_id !== null &&
          dependencies.controlReady(
            currentStatus.pid,
            current.daemon_instance_id,
          )
        ) {
          result = { alreadyRunning: true, spawned: false };
          break;
        }
        if (currentStatus.kind === "stale-live") {
          throw new DaemonStaleOwnerError(currentStatus.pid);
        }
        if (
          currentStatus.kind === "missing" ||
          currentStatus.kind === "dead"
        ) {
          baseline = current;
          baselineStatus = currentStatus;
          break;
        }
        baseline = current;
        baselineStatus = currentStatus;
        const remaining = deadline - dependencies.now();
        if (remaining <= 0) {
          throw new DaemonLaunchError(
            `Daemon ${baselineStatus.pid} did not publish cooperative control within ${dependencies.timeoutMs}ms`,
          );
        }
        await dependencies.sleep(
          Math.min(dependencies.pollMs, remaining),
        );
      }
    }
    if (baselineStatus.kind === "stale-live") {
      throw new DaemonStaleOwnerError(baselineStatus.pid);
    }
    if (result === undefined) {
      dependencies.prepareDataDir();
      logDescriptor = dependencies.openLog();
      const launch = dependencies.command();
      const launchedAt = dependencies.now();
      child = dependencies.spawnProcess(launch.executable, launch.args, {
        detached: true,
        stdio: ["ignore", logDescriptor, logDescriptor],
        env: process.env,
        windowsHide: true,
      });
      child.on("error", captureChildError);
      const ready = await waitForDaemonReadiness(
        child,
        store as Pick<SanaStore, "getSyncState">,
        baseline,
        launchedAt,
        {
          timeoutMs: dependencies.timeoutMs,
          pollMs: dependencies.pollMs,
          now: dependencies.now,
          sleep: dependencies.sleep,
          pidAlive: dependencies.pidAlive,
          controlReady: dependencies.controlReady,
        },
      );
      if (ready === "child") {
        child.unref();
        childAccepted = true;
        result = { alreadyRunning: false, spawned: true };
      } else {
        result = { alreadyRunning: true, spawned: false };
      }
    }
  } catch (error) {
    primaryError =
      error instanceof DaemonLaunchError ||
      error instanceof DaemonStaleOwnerError
        ? error
        : new DaemonLaunchError("Daemon startup failed", { cause: error });
  }

  const cleanupErrors: unknown[] = [];
  if (child && !childAccepted) {
    try {
      await stopAndReapChild(child, dependencies);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (child) {
    child.off("error", captureChildError);
  }
  for (const error of childErrors) {
    if (!errorTreeContains(primaryError, error)) cleanupErrors.push(error);
  }
  if (logDescriptor !== undefined) {
    try {
      dependencies.closeLog(logDescriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    store.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError !== undefined || cleanupErrors.length > 0) {
    const errors = [
      ...(primaryError instanceof AggregateError
        ? primaryError.errors
        : primaryError === undefined
          ? []
          : [primaryError]),
      ...cleanupErrors,
    ];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Daemon startup or cleanup failed");
  }
  return result!;
}

/**
 * Ensure a background sync daemon is running. A newly created child is only
 * reported as spawned after its own SQLite lease heartbeat is observed.
 */
export function ensureDaemonRunning(): Promise<EnsureDaemonResult> {
  return ensureDaemonRunningWith(DEFAULT_DEPENDENCIES);
}

function errorTreeContains(tree: unknown, target: unknown): boolean {
  if (tree === target) return true;
  if (tree instanceof AggregateError) {
    return tree.errors.some((error) => errorTreeContains(error, target));
  }
  return (
    tree instanceof Error &&
    "cause" in tree &&
    errorTreeContains(tree.cause, target)
  );
}
