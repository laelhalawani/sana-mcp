import { sana } from "../src/tools/dispatch.js";
console.log("===== help (logged in) =====\n" + await sana("help"));
console.log("\n===== help tool=search =====\n" + await sana("help", { tool: "search" }));
console.log("\n===== search (no args) =====\n" + await sana("search"));
console.log("\n===== search query=pricing =====\n" + (await sana("search", { query: "pricing", limit: 3 })).slice(0, 700));
process.exit(0);
