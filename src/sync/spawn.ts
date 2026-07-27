// Background-daemon launcher.
//
// The launcher is intentionally database-free: it reads only the daemon control
// record (a small JSON file) to decide whether a daemon is already running, and
// spawns the daemon otherwise. Single-daemon ownership is authoritative at the
// SQLite lease (see lock.ts / the store); the control record is the readiness
// surface the launcher and installer lifecycle observe.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  PROJECT_ROOT,
  dataDirectory,
  ensureDataDir,
  isCompiledBinary,
} from "../config.js";
import { openSensitiveFile } from "../runtime/secure-files.js";
import {
  observeDaemonControl,
  type DaemonControlObservation,
} from "./control.js";
import { pidAlive } from "./lock.js";

const DAEMON_READY_TIMEOUT_MS = 10_000;
const DAEMON_READY_POLL_MS = 50;

export class DaemonLaunchError extends Error {
  readonly code = "DAEMON_LAUNCH_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonLaunchError";
  }
}

export interface EnsureDaemonResult {
  readonly alreadyRunning: boolean;
  readonly spawned: boolean;
}

function controlRunning(
  observed: DaemonControlObservation,
): { running: boolean; pid: number | null } {
  if (observed.kind === "ready" && pidAlive(observed.identity.pid)) {
    return { running: true, pid: observed.identity.pid };
  }
  return { running: false, pid: null };
}

function launchCommand(): Readonly<{ executable: string; args: string[] }> {
  return isCompiledBinary()
    ? { executable: process.execPath, args: ["daemon"] }
    : {
        executable: process.execPath,
        args: [path.join(PROJECT_ROOT, "src", "daemon-main.ts")],
      };
}

/**
 * Ensure a background daemon is running. If the control record already
 * advertises a live daemon, no work is done. Otherwise the daemon is spawned
 * detached and the launcher waits for it to publish a live control record.
 */
export async function ensureDaemonRunning(): Promise<EnsureDaemonResult> {
  const existing = controlRunning(observeDaemonControl());
  if (existing.running) {
    return { alreadyRunning: true, spawned: false };
  }

  ensureDataDir();
  const logDescriptor = openSensitiveFile(
    path.join(dataDirectory(), "daemon.log"),
    "a",
  );
  let child: ChildProcess;
  try {
    const launch = launchCommand();
    child = spawn(launch.executable, [...launch.args], {
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      windowsHide: true,
    });
  } catch (error) {
    try {
      fs.closeSync(logDescriptor);
    } catch {
      // best-effort
    }
    throw error;
  }

  const startedAt = performance.now();
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitCode = code;
    exitSignal = signal;
  };
  child.once("exit", onExit);
  try {
    for (;;) {
      const observed = controlRunning(observeDaemonControl());
      if (observed.running) {
        // A concurrent launcher may have won the lease; either way a daemon is
        // now live. Detach our child so it does not become a zombie.
        child.unref();
        return {
          alreadyRunning: observed.pid !== child.pid,
          spawned: observed.pid === child.pid,
        };
      }
      if (exitCode !== null || exitSignal !== null) {
        const detail =
          exitSignal === null
            ? `exit code ${String(exitCode)}`
            : `signal ${String(exitSignal)}`;
        throw new DaemonLaunchError(
          `Daemon exited before becoming ready (${detail})`,
        );
      }
      if (performance.now() - startedAt > DAEMON_READY_TIMEOUT_MS) {
        throw new DaemonLaunchError(
          `Daemon did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms`,
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, DAEMON_READY_POLL_MS),
      );
    }
  } finally {
    child.off("exit", onExit);
    // Keep the log descriptor open for the child's inherited stdio until the
    // daemon has published readiness; only then close the launcher's copy.
    try {
      fs.closeSync(logDescriptor);
    } catch {
      // best-effort; the child owns its inherited copy regardless.
    }
  }
}
