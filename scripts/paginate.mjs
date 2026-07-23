import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(here, "..", "data", "profile");
const BASE = "https://sana.ai";
const WS = process.env.SANA_WORKSPACE_ID || "Yy6S4JGT8SAx";

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const cookies = await ctx.cookies("https://sana.ai");
await ctx.close();
const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

async function page(cursor) {
  const input = { assetSourceTypes: ["sana-ai:meeting"], direction: "forward" };
  if (cursor !== undefined) input.cursor = cursor;
  const res = await fetch(
    `${BASE}/x-api/trpc/asset.listRecent?input=${encodeURIComponent(JSON.stringify(input))}`,
    { headers: { cookie, "sana-ai-workspace-id": WS, accept: "application/json" } }
  );
  const j = await res.json();
  return j?.result?.data ?? {};
}

const first = await page();
const keys = Object.keys(first);
console.log("data keys:", keys);
for (const k of keys) if (k !== "assets") console.log("  ", k, "=", JSON.stringify(first[k]));
console.log("first page assets:", (first.assets || []).length);

// Walk pages until exhausted, using nextCursor if present else offset.
let all = [...(first.assets || [])];
let cursor = first.nextCursor;
let usedOffset = false;
if (cursor === undefined || cursor === null) {
  usedOffset = true;
  cursor = all.length;
}
for (let i = 0; i < 200; i++) {
  const d = await page(cursor);
  const a = d.assets || [];
  if (a.length === 0) break;
  all = all.concat(a);
  if (usedOffset) cursor += a.length;
  else {
    if (d.nextCursor === undefined || d.nextCursor === null) break;
    cursor = d.nextCursor;
  }
}
console.log(`\nTOTAL meetings walked: ${all.length} (paging via ${usedOffset ? "offset" : "nextCursor"})`);
const uniq = new Set(all.map((a) => a.id));
console.log("unique ids:", uniq.size);
console.log("oldest:", new Date(Math.min(...all.map((a) => a.createdAtEpochMs))).toISOString().slice(0, 10));
console.log("newest:", new Date(Math.max(...all.map((a) => a.createdAtEpochMs))).toISOString().slice(0, 10));
