import { performance } from "node:perf_hooks";
import {
  DaemonStopPublishedError,
  DaemonStopRequestRejectedError,
  clearDaemonControl,
  clearDeadLegacyDaemonControl,
  observeDaemonControl,
  observeDaemonControlReadOnly,
  requestDaemonStop,
  type DaemonControlIdentity,
  type DaemonControlObservation,
  type DaemonStopRequestResult,
} from "./control.js";
import { pidAlive } from "./lock.js";
import {
  ensureDaemonRunning,
  type EnsureDaemonResult,
} from "./spawn.js";

const LIFECYCLE_TIMEOUT_MS = 10_000;
const LIFECYCLE_POLL_MS = 50;
const STOPPED_OBSERVATIONS = 3;

export interface DaemonLifecycleResult {
  readonly state: "running" | "stopped";
  readonly changed: boolean;
}

export interface DaemonLifecycleOptions {
  /**
   * Installer-only bridge for a verified legacy binary. Callers must first
   * prove the receipt, binary digest, and exact executable path.
   */
  readonly allowLegacyCooperative?: boolean;
  /** Installer-only read authority after receipt, digest, and path verification. */
  readonly allowStaleRunning?: boolean;
}

export interface DaemonLifecycleDependencies {
  readonly observeControl: () => DaemonControlObservation;
  readonly requestStop: (
    identity: DaemonControlIdentity,
  ) => DaemonStopRequestResult;
  readonly clearControl: (identity: DaemonControlIdentity) => void;
  readonly clearLegacyControl: (identity: DaemonControlIdentity) => void;
  readonly ensureRunning: () => Promise<EnsureDaemonResult>;
  readonly pidAlive: (pid: number) => boolean;
  readonly monotonicNow: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly stoppedObservations: number;
}

const DEFAULT_DEPENDENCIES: DaemonLifecycleDependencies = {
  observeControl: () => observeDaemonControl(),
  requestStop: (identity) => requestDaemonStop(identity),
  clearControl: (identity) => clearDaemonControl(identity),
  clearLegacyControl: (identity) =>
    clearDeadLegacyDaemonControl(identity),
  ensureRunning: ensureDaemonRunning,
  pidAlive,
  monotonicNow: performance.now.bind(performance),
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  timeoutMs: LIFECYCLE_TIMEOUT_MS,
  pollMs: LIFECYCLE_POLL_MS,
  stoppedObservations: STOPPED_OBSERVATIONS,
};

const READ_ONLY_DEPENDENCIES: DaemonLifecycleDependencies = {
  ...DEFAULT_DEPENDENCIES,
  observeControl: () => observeDaemonControlReadOnly(),
};

type ControlState =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "ready-running"; identity: DaemonControlIdentity }>
  | Readonly<{ kind: "legacy-live"; identity: DaemonControlIdentity }>
  | Readonly<{
      kind: "dead";
      identity: DaemonControlIdentity;
      protocol: "legacy" | "ready";
    }>
  | Readonly<{ kind: "stale-live"; identity: DaemonControlIdentity }>;

function identityKey(identity: DaemonControlIdentity): string {
  return `${identity.pid}:${identity.instanceId}`;
}

function controlState(
  observed: DaemonControlObservation,
  alive: (pid: number) => boolean,
): ControlState {
  if (observed.kind === "missing") return observed;
  const processIsAlive = alive(observed.identity.pid);
  if (observed.kind === "legacy") {
    return processIsAlive
      ? { kind: "legacy-live", identity: observed.identity }
      : {
          kind: "dead",
          identity: observed.identity,
          protocol: "legacy",
        };
  }
  if (!processIsAlive) {
    return {
      kind: "dead",
      identity: observed.identity,
      protocol: "ready",
    };
  }
  if (observed.kind === "ready" && observed.freshness === "stale") {
    return { kind: "stale-live", identity: observed.identity };
  }
  return { kind: "ready-running", identity: observed.identity };
}

function observeControlState(
  dependencies: DaemonLifecycleDependencies,
): ControlState {
  const observed = dependencies.observeControl();
  if (
    observed.kind === "ready" &&
    observed.heartbeatMs > dependencies.now()
  ) {
    throw new Error(
      "daemon control heartbeat is dated in the future; clock integrity cannot be established",
    );
  }
  return controlState(observed, dependencies.pidAlive);
}

function assertTiming(
  dependencies: DaemonLifecycleDependencies,
): void {
  for (const [name, value] of [
    ["timeoutMs", dependencies.timeoutMs],
    ["pollMs", dependencies.pollMs],
    ["stoppedObservations", dependencies.stoppedObservations],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

function inspectOnce(
  dependencies: DaemonLifecycleDependencies,
  options: DaemonLifecycleOptions,
): "running" | "stopped" {
  const control = observeControlState(dependencies);
  if (control.kind === "ready-running") return "running";
  if (control.kind === "legacy-live") {
    if (options.allowLegacyCooperative === true) return "running";
    throw new Error(
      `legacy daemon control for live process ${control.identity.pid} has no process-birth authority; only a verified installer may enable cooperative legacy compatibility`,
    );
  }
  if (control.kind === "stale-live") {
    if (options.allowStaleRunning === true) return "running";
    throw new Error(
      `daemon control heartbeat is stale while process ${control.identity.pid} is still running; stop it manually`,
    );
  }
  if (
    control.kind === "dead" &&
    control.protocol === "legacy" &&
    options.allowLegacyCooperative !== true
  ) {
    throw new Error(
      `dead legacy daemon control for process ${control.identity.pid} can only be retired by a verified installer using cooperative legacy compatibility`,
    );
  }
  return "stopped";
}

export async function runDaemonLifecycleWith(
  operation: string,
  dependencies: DaemonLifecycleDependencies,
  options: DaemonLifecycleOptions = {},
): Promise<DaemonLifecycleResult> {
  assertTiming(dependencies);
  if (operation === "health") {
    return {
      state: inspectOnce(dependencies, options),
      changed: false,
    };
  }
  if (operation === "start") {
    const observed = observeControlState(dependencies);
    if (observed.kind === "legacy-live") {
      if (options.allowLegacyCooperative === true) {
        return { state: "running", changed: false };
      }
      throw new Error(
        `legacy daemon control for live process ${observed.identity.pid} has no process-birth authority; only a verified installer may enable cooperative legacy compatibility`,
      );
    }
    const result = await dependencies.ensureRunning();
    return {
      state: "running",
      changed: result.spawned,
    };
  }
  if (operation !== "stop") {
    throw new Error("__lifecycle operation must be health, stop, or start");
  }

  const startedAt = dependencies.monotonicNow();
  let changed = false;
  let stableStopped = 0;
  const attempted = new Map<string, DaemonControlIdentity>();
  const published = new Set<string>();
  const provenExited = new Set<string>();
  const publishStop = (identity: DaemonControlIdentity): void => {
    const key = identityKey(identity);
    try {
      const result = dependencies.requestStop(identity);
      if (
        result.published !== true ||
        result.identity.pid !== identity.pid ||
        result.identity.instanceId !== identity.instanceId
      ) {
        throw new Error(
          "daemon stop dependency returned an invalid publication outcome",
        );
      }
      attempted.set(key, identity);
      published.add(key);
      changed = true;
    } catch (error) {
      if (error instanceof DaemonStopPublishedError) {
        attempted.set(key, error.identity);
        published.add(key);
        changed = true;
        throw error;
      }
      if (error instanceof DaemonStopRequestRejectedError) return;
      throw error;
    }
  };
  for (;;) {
    for (const [key, identity] of attempted) {
      if (!provenExited.has(key) && !dependencies.pidAlive(identity.pid)) {
        provenExited.add(key);
      }
    }
    const control = observeControlState(dependencies);
    if (control.kind !== "missing") {
      for (const [key, identity] of attempted) {
        if (
          !provenExited.has(key) &&
          identity.pid === control.identity.pid &&
          identity.instanceId !== control.identity.instanceId
        ) {
          throw new Error(
            `daemon PID ${identity.pid} changed control identity before its requested process was proven exited; PID continuity is ambiguous, stop it manually`,
          );
        }
      }
    }
    if (control.kind === "legacy-live") {
      if (options.allowLegacyCooperative !== true) {
        throw new Error(
          `legacy daemon control for live process ${control.identity.pid} has no process-birth authority; only a verified installer may enable cooperative legacy compatibility`,
        );
      }
      const key = identityKey(control.identity);
      if (!published.has(key)) {
        publishStop(control.identity);
      }
      stableStopped = 0;
    } else if (control.kind === "dead") {
      if (control.protocol === "ready") {
        dependencies.clearControl(control.identity);
      } else if (options.allowLegacyCooperative === true) {
        dependencies.clearLegacyControl(control.identity);
      } else {
        throw new Error(
          `dead legacy daemon control for process ${control.identity.pid} can only be retired by a verified installer using cooperative legacy compatibility`,
        );
      }
      stableStopped = 0;
    } else if (
      control.kind === "ready-running" ||
      control.kind === "stale-live"
    ) {
      const key = identityKey(control.identity);
      if (!published.has(key)) {
        publishStop(control.identity);
      }
      stableStopped = 0;
    } else {
      // No live control: the daemon has stopped.
      if (provenExited.size === attempted.size) {
        stableStopped++;
        if (stableStopped >= dependencies.stoppedObservations) {
          return { state: "stopped", changed };
        }
      } else {
        stableStopped = 0;
      }
    }
    if (
      dependencies.monotonicNow() - startedAt >=
      dependencies.timeoutMs
    ) {
      throw new Error(
        `daemon did not reach a stable stopped state within ${dependencies.timeoutMs}ms; stop it manually`,
      );
    }
    await dependencies.sleep(dependencies.pollMs);
  }
}

export function runDaemonLifecycle(
  operation: string,
  options: DaemonLifecycleOptions = {},
): Promise<DaemonLifecycleResult> {
  return runDaemonLifecycleWith(
    operation,
    operation === "health"
      ? READ_ONLY_DEPENDENCIES
      : DEFAULT_DEPENDENCIES,
    options,
  );
}
