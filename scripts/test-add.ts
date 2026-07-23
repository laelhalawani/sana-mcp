process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { SanaStore } = await import("../src/store/db.js");
const now = Date.now();
const st = new SanaStore();
const seg = JSON.stringify([{speaker:"Alex",words:[{text:"hello",start_timestamp:0,end_timestamp:1}]}]);
// real meeting id so recording live-fetch works
st.upsertMeeting({id:"v72HzzJDZx9WqTmF",name:"NORTHWIND X Lumen Weekly",source:"sana-ai:meeting",created_at_ms:now,processing_phase:"done"});
st.saveTranscript({meeting_id:"v72HzzJDZx9WqTmF",text:"hello",json:seg,word_count:1,segment_count:1});
st.saveMetadata({meeting_id:"v72HzzJDZx9WqTmF",summary:"long",summary_short:"Weekly sync recap",
  notes_json:JSON.stringify({notes:[{topic:"Testing",notes:["Lumen beats Fabrik","100 products live"]}],actionItems:[{assignedTo:null,action:"Continue copy tests",dueDate:null}]}),
  participants_json:JSON.stringify([{displayName:"Alex",email:"a@x.com",isHost:true}]),has_recording:1});
// a processing (not done) meeting w/o transcript
st.upsertMeeting({id:"mProc",name:"Just ended",source:"sana-ai:meeting",created_at_ms:now-3600000,processing_phase:"pending-index"});
st.updateSyncState({phase:"synced",blocking:0,last_full_sync_ms:now,daemon_pid:1,daemon_heartbeat_ms:now});
st.close();
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== list (processing status) ===\n"+await sana("list"));
console.log("\n=== read (metadata) ===\n"+await sana("read",{meeting_id:"v72HzzJDZx9WqTmF"}));
console.log("\n=== recording (live) ===\n"+(await sana("recording",{meeting_id:"v72HzzJDZx9WqTmF"})).slice(0,200));
process.exit(0);
