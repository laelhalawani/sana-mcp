import { sana } from "../src/tools/dispatch.js";

console.log("===== help =====");
console.log(await sana("help"));
console.log("\n===== help(list_meetings) =====");
console.log(await sana("help", { tool: "list_meetings" }));
console.log("\n===== status =====");
console.log(await sana("status"));
console.log("\n===== list_meetings limit 5 =====");
const list = await sana("list_meetings", { limit: 5 });
console.log(list);

// read the first meeting that shows as ready (✓)
const readyId = list.split("\n").find((l) => l.startsWith("✓"))?.split(/\s+/)[1];
console.log("\n===== read_transcript (first ready:", readyId, ") =====");
if (readyId) {
  const t = await sana("read_transcript", { id: readyId });
  console.log(t.slice(0, 900));
}
process.exit(0);
