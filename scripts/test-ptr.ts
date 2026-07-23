process.env.SANA_DATA_DIR = process.env.TMP_DIR!;
const { sana } = await import("../src/tools/dispatch.js");
console.log("=== list (pointer footer) ===\n"+await sana("list"));
console.log("\n=== read (no pointer) ===\n"+await sana("read",{meeting_id:"m1",lines:[1,1]}));
process.exit(0);
