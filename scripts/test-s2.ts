import { sana } from "../src/tools/dispatch.js";
console.log("===== search pricing (limit 3) =====\n" + (await sana("search", { query: "pricing", limit: 3 })));
const mid = "v72HzzJDZx9WqTmF";
console.log("\n===== read (no lines) =====\n" + (await sana("read", { meeting_id: mid })));
console.log("\n===== read lines [1,4] =====\n" + (await sana("read", { meeting_id: mid, lines: [1, 4] })));
console.log("\n===== read lines [1,4] no timestamps =====\n" + (await sana("read", { meeting_id: mid, lines: [1, 4], timestamps: false })));
process.exit(0);
