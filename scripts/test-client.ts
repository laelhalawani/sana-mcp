import { SanaClient } from "../src/sana/client.js";

const c = SanaClient.load();
console.log("has auth cookie:", c.hasAuthCookie(), "| workspace:", c.workspaceId);

const me = await c.me();
console.log("me:", me?.email, me?.displayName);

const meetings = await c.listMeetings();
console.log(`listMeetings: ${meetings.length} total`);
for (const m of meetings.slice(0, 3)) {
  console.log(`  ${m.id}  ${new Date(m.createdAtEpochMs).toISOString().slice(0, 10)}  ${m.name}`);
}

if (meetings[0]) {
  const t = await c.getTranscription(meetings[0].id);
  const words = t.reduce((n, s) => n + (s.words?.length || 0), 0);
  console.log(`transcript[0]: ${t.length} segments, ${words} words, speaker0=${t[0]?.speaker}`);
}
c.save();
console.log("OK");
