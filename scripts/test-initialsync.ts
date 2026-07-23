process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { SanaStore } = await import("../src/store/db.js");
const store = new SanaStore();
store.upsertMeeting({ id: "m1", name: "Alpha Sync Meeting", source: "sana-ai:meeting", created_at_ms: Date.now() });
store.updateSyncState({
  phase: "downloading", last_full_sync_ms: null,
  meetings_total: 237, transcripts_total: 237, transcripts_done: 100,
  daemon_pid: 1, daemon_heartbeat_ms: Date.now(),  // fake-alive so no daemon is spawned
});
store.close();
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== status ===\n" + await sana("status"));
console.log("\n=== list (should be blocked) ===\n" + await sana("list"));
console.log("\n=== search (should be blocked) ===\n" + await sana("search", { query: "x" }));
process.exit(0);
