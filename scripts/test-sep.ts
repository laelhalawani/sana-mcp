process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { SanaStore } = await import("../src/store/db.js");
const now = Date.now();
const st = new SanaStore();
const seg = JSON.stringify([{speaker:"Alex",words:[{text:"hello",start_timestamp:0,end_timestamp:1}]},{speaker:"Bo",words:[{text:"hi",start_timestamp:2,end_timestamp:3}]}]);
st.upsertMeeting({id:"m1",name:"Weekly sync",source:"sana-ai:meeting",created_at_ms:now,processing_phase:"done"});
st.saveTranscript({meeting_id:"m1",text:"hello hi",json:seg,word_count:2,segment_count:2});
st.saveMetadata({meeting_id:"m1",summary:"Full summary text here.",summary_short:"Quick recap",
  notes_json:JSON.stringify({notes:[{topic:"Testing",notes:["Lumen wins","100 live"]}],actionItems:[{assignedTo:"Piotr",action:"Run QA",dueDate:"2026-08-07"}]}),
  participants_json:JSON.stringify([{displayName:"Alex",email:"alex@x.com",isHost:true},{email:"bob@x.com"}]),has_recording:1});
st.updateSyncState({phase:"synced",blocking:0,last_full_sync_ms:now,daemon_pid:1,daemon_heartbeat_ms:now});
st.close();
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== read m1 lines [1,2] ===\n"+await sana("read",{meeting_id:"m1",lines:[1,2]}));
console.log("\n=== summary m1 ===\n"+await sana("summary",{meeting_id:"m1"}));
console.log("\n=== participants m1 ===\n"+await sana("participants",{meeting_id:"m1"}));
process.exit(0);
