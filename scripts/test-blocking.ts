process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { SanaStore } = await import("../src/store/db.js");
const now = Date.now();
const store = new SanaStore();
store.upsertMeeting({ id: "mA", name: "Ready Meeting", source: "sana-ai:meeting", created_at_ms: now - 86400000 });
store.upsertMeeting({ id: "mB", name: "New Incoming Meeting", source: "sana-ai:meeting", created_at_ms: now });
store.saveTranscript({ meeting_id: "mA", text: "hi", json: JSON.stringify([{speaker:"X",words:[{text:"hi",start_timestamp:0,end_timestamp:1}]}]), word_count: 1, segment_count: 1 });
// NOT-blocked, incremental downloading mB (should stay hidden except in list)
store.updateSyncState({ phase: "synced", blocking: 0, last_full_sync_ms: now, meetings_total: 2, transcripts_total: 2, transcripts_done: 1, daemon_pid: 1, daemon_heartbeat_ms: now });
store.close();
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== NOT blocking ===");
console.log("[status]\n" + await sana("status"));
console.log("\n[list]\n" + await sana("list"));

// now flip to blocking (login catch-up)
const s2 = new SanaStore();
s2.updateSyncState({ blocking: 1, phase: "downloading", transcripts_total: 2, transcripts_done: 1, daemon_pid: 1, daemon_heartbeat_ms: Date.now() });
s2.close();
console.log("\n=== blocking (login catch-up) ===");
console.log("[status]\n" + await sana("status"));
console.log("\n[list]\n" + await sana("list"));
console.log("\n[read]\n" + await sana("read", { meeting_id: "mA" }));
process.exit(0);
