process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
process.env.SANA_MAX_ATTEMPTS = "3";
const { SanaStore } = await import("../src/store/db.js");
const now = Date.now();
const st = new SanaStore();
const seg = (t:string)=>JSON.stringify([{speaker:"Alex",words:t.split(" ").map((w,i)=>({text:w,start_timestamp:i,end_timestamp:i+1}))}]);
// mReady: has transcript + metadata
st.upsertMeeting({id:"mReady",name:"Q3 planning",source:"sana-ai:meeting",created_at_ms:now});
st.saveTranscript({meeting_id:"mReady",text:"we discuss pricing pricing again",json:seg("we discuss pricing pricing again"),word_count:5,segment_count:1});
st.saveMetadata({meeting_id:"mReady",summary:"Long summary here",summary_short:"Talked pricing",notes_json:null,participants_json:JSON.stringify([{displayName:"Alex",email:"alex@x.com",isHost:true},{email:"bob@x.com"}])});
// mFailed: no transcript, attempts >= max(3)
st.upsertMeeting({id:"mFailed",name:"Broken meeting",source:"sana-ai:meeting",created_at_ms:now-86400000});
for (let i=0;i<3;i++) st.recordFailure("mFailed","boom");
// mDownloading: no transcript, attempts 1
st.upsertMeeting({id:"mDown",name:"Fresh meeting",source:"sana-ai:meeting",created_at_ms:now-2*86400000});
st.recordFailure("mDown","transient");
st.updateSyncState({phase:"synced",blocking:0,last_full_sync_ms:now,daemon_pid:1,daemon_heartbeat_ms:now});
st.close();
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== list (all) ===\n"+await sana("list"));
console.log("\n=== list filter status=failed ===\n"+await sana("list",{filter:{status:"failed"}}));
console.log("\n=== list sort=oldest ===\n"+await sana("list",{sort:"oldest"}));
console.log("\n=== read mReady (metadata header) ===\n"+await sana("read",{meeting_id:"mReady"}));
console.log("\n=== search pricing sort=best ===\n"+await sana("search",{query:"pricing"}));
process.exit(0);
