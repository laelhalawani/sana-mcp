const daemonPidText = process.env.SANA_TEST_DAEMON_PID;
if (!daemonPidText || !/^[1-9]\d*$/.test(daemonPidText)) {
  throw new Error("SANA_TEST_DAEMON_PID must be a positive integer");
}
const daemonPid = Number(daemonPidText);
if (!Number.isSafeInteger(daemonPid)) throw new Error("SANA_TEST_DAEMON_PID is out of range");

const { SanaStore } = await import("../../../src/store/db.js");
const store = new SanaStore();
try {
  store.updateSyncState({
    phase: "downloading",
    message: "synthetic sync in progress",
    meetings_total: 4,
    transcripts_done: 1,
    transcripts_total: 4,
    last_full_sync_ms: Date.parse("2026-01-03T12:00:00Z"),
    last_incremental_ms: Date.parse("2026-01-03T12:00:00Z"),
    daemon_pid: daemonPid,
    daemon_heartbeat_ms: Date.now(),
    blocking: 1,
    catchup_epoch_ms: null,
    error: null,
  });
} finally {
  store.close();
}
