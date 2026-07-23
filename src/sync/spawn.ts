import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SanaStore } from "../store/db.js";
import { isDaemonAlive } from "./lock.js";
import { DATA_DIR, ensureDataDir } from "../config.js";

/**
 * Ensure a background sync daemon is running; spawn a detached one if not.
 * Works both in dev (running .ts under tsx) and in prod (compiled .js).
 */
export function ensureDaemonRunning(): { alreadyRunning: boolean; spawned: boolean } {
  const store = new SanaStore();
  try {
    if (isDaemonAlive(store)) return { alreadyRunning: true, spawned: false };
  } finally {
    store.close();
  }

  ensureDataDir();
  const thisFile = fileURLToPath(import.meta.url);
  const here = path.dirname(thisFile);
  const isTs = thisFile.endsWith(".ts");
  const entry = path.resolve(here, "..", isTs ? "daemon-main.ts" : "daemon-main.js");

  // Under tsx, launch node with the tsx loader; compiled, launch node directly.
  const command = process.execPath;
  const args = isTs ? ["--import", "tsx", entry] : [entry];

  const logFd = fs.openSync(path.join(DATA_DIR, "daemon.log"), "a");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  return { alreadyRunning: false, spawned: true };
}
