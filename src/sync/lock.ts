import fs from "node:fs";
import path from "node:path";
import type { SanaStore } from "../store/db.js";
import { DATA_DIR } from "../config.js";

// A daemon is considered alive if it wrote a heartbeat recently AND its PID
// still exists. Heartbeats are written every few seconds by the running daemon.
const STALE_MS = 30_000;

const LOCK_FILE = path.join(DATA_DIR, "daemon.lock");

/** Atomically claim the daemon lock; false if a live/starting daemon holds it. */
export function acquireDaemonLock(): boolean {
  if (tryCreate()) return true;
  // Lock exists - inspect the holder.
  let pid: number | null = null;
  try {
    pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim()) || null;
  } catch {
    return false; // unreadable: don't steal
  }
  if (!pid) return false; // empty/garbage (mid-create window): don't steal
  if (pidAlive(pid)) return false;
  // Stale holder (dead PID): remove and re-attempt the atomic create. Only one
  // caller's wx can then succeed; the other gets EEXIST -> false. No double-spawn.
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  return tryCreate();

  function tryCreate(): boolean {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    }
  }
}

export function releaseDaemonLock(): void {
  // Only delete the lock if it still belongs to us (don't clobber a successor).
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, cross-platform
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it - still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isDaemonAlive(store: SanaStore): boolean {
  const s = store.getSyncState();
  if (!s.daemon_pid || !s.daemon_heartbeat_ms) return false;
  if (Date.now() - s.daemon_heartbeat_ms > STALE_MS) return false;
  if (s.daemon_pid === process.pid) return true;
  return pidAlive(s.daemon_pid);
}
