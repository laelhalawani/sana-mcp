import { SanaClient } from "../src/sana/client.js";
const c = SanaClient.load();
const id = "v72HzzJDZx9WqTmF";
const meta = await c.getMeetingById(id);
console.log("summaryShort:", meta?.summaryShort?.slice(0,90));
console.log("has notes:", Array.isArray((meta as any)?.notes), "has actionItems:", Array.isArray((meta as any)?.actionItems));
const ps = await c.getMeetingParticipants(id);
console.log("participants:", ps.map(p=>`${p.displayName||p.email}${p.isHost?"*":""}`).join(", "));
process.exit(0);
