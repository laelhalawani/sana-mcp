import type { SanaStore } from "../store/db.js";

// A daemon is considered alive if it wrote a heartbeat recently AND its PID
// still exists. Heartbeats are written every few seconds by the running daemon.
const STALE_MS = 30_000;

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
