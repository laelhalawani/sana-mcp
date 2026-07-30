import { performance } from "node:perf_hooks";
import fs from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
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

interface PidfdLibrary {
  readonly keepAlive: unknown;
  readonly syscall: (
    number: bigint,
    first: bigint,
    second: bigint,
    info: null,
    fourth: bigint,
  ) => bigint;
  readonly sysconf: (name: number) => bigint;
  readonly poll: (fds: Uint8Array, count: bigint, timeout: number) => number;
}

let pidfdLibrary: PidfdLibrary | undefined;

function linuxPidfdLibrary(): PidfdLibrary {
  if (pidfdLibrary !== undefined) return pidfdLibrary;
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  const failures: unknown[] = [];
  for (const candidate of [
    "libc.so.6",
    `libc.musl-${architecture}.so.1`,
    `/lib/libc.musl-${architecture}.so.1`,
    "libc.so",
  ]) {
    try {
      const library = dlopen(candidate, {
        syscall: {
          args: [
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.ptr,
            FFIType.i64,
          ],
          returns: FFIType.i64,
        },
        sysconf: { args: [FFIType.i32], returns: FFIType.i64 },
        poll: {
          args: [FFIType.ptr, FFIType.u64, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      pidfdLibrary = {
        keepAlive: library,
        syscall: library.symbols.syscall,
        sysconf: library.symbols.sysconf,
        poll: library.symbols.poll,
      };
      return pidfdLibrary;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "Linux pidfd support is unavailable");
}

function linuxProcessStat(pid: number): { state: string; startTicks: bigint } {
  const body = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = body.lastIndexOf(") ");
  const fields = end < 0 ? [] : body.slice(end + 2).trim().split(/\s+/u);
  const state = fields[0];
  const start = fields[19];
  if (
    state === undefined ||
    !/^[A-Za-z]$/u.test(state) ||
    start === undefined ||
    !/^[1-9][0-9]*$/u.test(start)
  ) {
    throw new Error("stale daemon process-birth identity is unavailable");
  }
  return { state, startTicks: BigInt(start) };
}

function linuxBootSecond(): bigint {
  const matches = [
    ...fs.readFileSync("/proc/stat", "utf8").matchAll(/^btime ([0-9]+)$/gmu),
  ];
  if (matches.length !== 1) throw new Error("Linux boot time is unavailable");
  return BigInt(matches[0]![1]!);
}

function pidfdSignal(
  library: PidfdLibrary,
  pidfd: number,
  signal: number,
): boolean {
  // Linux uses the asm-generic numbers on all release architectures.
  return library.syscall(424n, BigInt(pidfd), BigInt(signal), null, 0n) === 0n;
}

function pidfdTargetExited(library: PidfdLibrary, pidfd: number): boolean {
  const descriptor = Buffer.alloc(8);
  descriptor.writeInt32LE(pidfd, 0);
  descriptor.writeInt16LE(1, 4);
  return library.poll(descriptor, 1n, 0) === 1 && descriptor.readInt16LE(6) !== 0;
}

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
  /** Verified POSIX installer authority to terminate one exact stale instance. */
  readonly allowStaleTerminate?: boolean;
  readonly staleExecutablePath?: string;
}

export interface DaemonLifecycleDependencies {
  readonly observeControl: () => DaemonControlObservation;
  readonly requestStop: (
    identity: DaemonControlIdentity,
  ) => DaemonStopRequestResult;
  readonly clearControl: (identity: DaemonControlIdentity) => void;
  readonly clearLegacyControl: (identity: DaemonControlIdentity) => void;
  readonly terminateStale: (
    identity: DaemonControlIdentity,
    expectedExecutable: string,
  ) => void;
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
  terminateStale: (identity, expectedExecutable) => {
    if (process.platform !== "linux") {
      throw new Error("forced stale daemon termination is available only on Linux");
    }
    const library = linuxPidfdLibrary();
    const pidfd = Number(
      library.syscall(434n, BigInt(identity.pid), 0n, null, 0n),
    );
    if (pidfd < 0) throw new Error("stale daemon process handle is unavailable");
    let stopped = false;
    let suspendedByInstaller = false;
    try {
      const initial = linuxProcessStat(identity.pid);
      if (initial.state === "T" || initial.state === "t") {
        stopped = true;
      } else {
        if (!pidfdSignal(library, pidfd, 19)) {
          if (pidfdTargetExited(library, pidfd)) return;
          throw new Error("kernel-bound stale daemon suspension failed");
        }
        suspendedByInstaller = true;
      }
      for (let attempt = 0; !stopped && attempt < 100; attempt++) {
        let current: ReturnType<typeof linuxProcessStat>;
        try {
          current = linuxProcessStat(identity.pid);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            pidfdTargetExited(library, pidfd)
          ) return;
          throw error;
        }
        if (current.startTicks !== initial.startTicks) {
          throw new Error("stale daemon process identity changed while suspending it");
        }
        if (current.state === "T" || current.state === "t") {
          stopped = true;
          break;
        }
        if (current.state === "Z" || current.state === "X") return;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10,
        );
      }
      if (!stopped) throw new Error("stale daemon could not be suspended safely");
      const daemonExecutable = fs.realpathSync.native(`/proc/${identity.pid}/exe`);
      const lifecycleExecutable = fs.realpathSync.native(expectedExecutable);
      if (daemonExecutable !== lifecycleExecutable) {
        throw new Error("stale daemon executable does not match the verified runtime");
      }
      const observed = observeDaemonControl();
      if (
        observed.kind !== "ready" ||
        observed.freshness !== "stale" ||
        observed.identity.pid !== identity.pid ||
        observed.identity.instanceId !== identity.instanceId
      ) {
        throw new Error("stale daemon control identity changed before termination");
      }
      const ticksPerSecond = library.sysconf(2);
      if (ticksPerSecond <= 0n) throw new Error("Linux clock tick rate is unavailable");
      const finalStat = linuxProcessStat(identity.pid);
      if (finalStat.startTicks !== initial.startTicks) {
        throw new Error("stale daemon process identity changed before termination");
      }
      const processCreatedMs =
        Number(linuxBootSecond()) * 1000 +
        Number((initial.startTicks * 1000n) / ticksPerSecond);
      if (
        !Number.isSafeInteger(processCreatedMs) ||
        processCreatedMs + 2_000 > observed.heartbeatMs
      ) {
        throw new Error(
          "stale daemon birth does not safely predate its control heartbeat",
        );
      }
      if (!pidfdSignal(library, pidfd, 9)) {
        if (pidfdTargetExited(library, pidfd)) return;
        throw new Error("kernel-bound stale daemon termination failed");
      }
      stopped = false;
      suspendedByInstaller = false;
    } catch (error) {
      if (pidfdTargetExited(library, pidfd)) return;
      throw error;
    } finally {
      if (
        suspendedByInstaller &&
        !pidfdSignal(library, pidfd, 18) &&
        !pidfdTargetExited(library, pidfd)
      ) {
        throw new Error("installer-suspended daemon could not be resumed");
      }
      fs.closeSync(pidfd);
    }
  },
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
  const terminatedStale = new Set<string>();
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
      if (
        control.kind === "stale-live" &&
        options.allowStaleTerminate === true &&
        !terminatedStale.has(key)
      ) {
        dependencies.terminateStale(
          control.identity,
          options.staleExecutablePath ?? process.execPath,
        );
        terminatedStale.add(key);
        changed = true;
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
