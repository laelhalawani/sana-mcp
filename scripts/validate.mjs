// Proof of concept: use the session cookie from the persistent profile to call
// Sana's tRPC API with plain fetch - NO browser performing the requests.
// Validates the fully-headless HTTP design end to end.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(here, "..", "data", "profile");
const BASE = "https://sana.ai";

// 1) Read cookies out of the saved profile (browser used only as a cookie store).
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const cookies = await ctx.cookies("https://sana.ai");
await ctx.close();

const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
console.log(`cookies found: ${cookies.length} ->`, cookies.map((c) => c.name).join(", "));

// The workspace id the app operates in (from the app URL / user.me).
const WORKSPACE_ID = process.env.SANA_WORKSPACE_ID || "Yy6S4JGT8SAx";

const trpc = async (proc, input) => {
  const qs = input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  const res = await fetch(`${BASE}/x-api/trpc/${proc}${qs}`, {
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
      accept: "application/json",
      "sana-ai-workspace-id": WORKSPACE_ID,
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
};

// 2) Confirm we are authenticated.
const me = await trpc("user.me");
console.log("\nuser.me:", me.status, me.json?.result?.data?.user?.email ?? "(not logged in)");

// 3) List meetings.
const list = await trpc("asset.listRecent", {
  assetSourceTypes: ["sana-ai:meeting"],
  direction: "forward",
});
const assets = list.json?.result?.data?.assets ?? [];
console.log(`\nasset.listRecent: ${list.status}, ${assets.length} meetings on first page`);
for (const a of assets.slice(0, 5)) {
  console.log(`  - ${a.id}  ${new Date(a.createdAtEpochMs).toISOString().slice(0,10)}  ${a.name}`);
}

// 4) Fetch one transcript, purely over HTTP.
if (assets[0]) {
  const t = await trpc("meeting.getTranscription", { assetId: assets[0].id });
  const segs = t.json?.result?.data ?? [];
  const words = Array.isArray(segs) ? segs.reduce((n, s) => n + (s.words?.length || 0), 0) : 0;
  console.log(`\nmeeting.getTranscription(${assets[0].id}): ${t.status}, ${segs.length} segments, ${words} words`);
  if (segs[0]) {
    const preview = (segs[0].words || []).slice(0, 12).map((w) => w.text).join(" ");
    console.log(`  first speaker: ${segs[0].speaker}`);
    console.log(`  preview: ${preview} ...`);
  }
}
console.log("\nOK - headless HTTP access works.");
