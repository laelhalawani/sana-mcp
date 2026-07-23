process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== search pricing page1 limit2 ===\n"+await sana("search",{query:"pricing",limit:2,page:1}));
console.log("\n=== search pricing page2 limit2 ===\n"+await sana("search",{query:"pricing",limit:2,page:2}));
process.exit(0);
