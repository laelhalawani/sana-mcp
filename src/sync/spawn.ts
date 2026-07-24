import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SanaStore } from "../store/db.js";
import { isDaemonAlive } from "./lock.js";
import { DATA_DIR, PROJECT_ROOT, ensureDataDir, isCompiledBinary } from "../config.js";

/**
 * Ensure a background sync daemon is running; spawn a detached one if not.
 * Works in dev (bun runs the daemon .ts directly) and as a standalone
 * `bun build --compile` binary (the daemon runs as the `daemon` CLI subcommand).
 */
export function ensureDaemonRunning(): { alreadyRunning: boolean; spawned: boolean } {
  const store = new SanaStore();
  try {
    if (isDaemonAlive(store)) return { alreadyRunning: true, spawned: false };
  } finally {
    store.close();
  }

  ensureDataDir();

  let command: string;
  let args: string[];
  if (isCompiledBinary()) {
    // Standalone binary: the daemon ships as the `daemon` CLI subcommand.
    command = process.execPath;
    args = ["daemon"];
  } else {
    // Dev: bun runs the daemon TypeScript source directly (no loader needed).
    command = process.execPath;
    args = [path.join(PROJECT_ROOT, "src", "daemon-main.ts")];
  }

  const logFd = fs.openSync(path.join(DATA_DIR, "daemon.log"), "a");
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } finally {
    // The child dup'd the fd; close our copy so the parent (long-lived MCP
    // server) doesn't leak one handle per respawn.
    fs.closeSync(logFd);
  }
  return { alreadyRunning: false, spawned: true };
}
