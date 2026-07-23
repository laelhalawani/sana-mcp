// Background investigation browser.
// Launches a headed, persistent-profile Chromium, opens Sana, and records all
// XHR/fetch traffic + any downloads while the user drives it. Exits when a STOP
// sentinel file appears or the browser window is closed.
//
// Run from the project root:  node scripts/investigate.mjs [startUrl]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DATA = path.join(ROOT, "data");
const PROFILE = path.join(DATA, "profile");
const OUT = path.join(DATA, "inspect");
const DL = path.join(OUT, "downloads");
const LOG = path.join(OUT, "network.json");
const STOP = path.join(OUT, "STOP");

fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(DL, { recursive: true });

const startUrl = process.argv[2] || "https://sana.ai/";
const calls = [];
let dirty = false;
const flush = () => {
  if (!dirty) return;
  fs.writeFileSync(LOG, JSON.stringify(calls, null, 2));
  dirty = false;
};

function interesting(url, ct) {
  if (/\/(api|graphql|trpc|rpc|v1|v2|_next\/data)\b/i.test(url)) return true;
  if (/transcript|meeting|download|recording|content|export|note/i.test(url))
    return true;
  if (ct && /json/i.test(ct)) return true;
  return false;
}

// clear any previous STOP sentinel
try { fs.rmSync(STOP); } catch {}

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  acceptDownloads: true,
  args: ["--no-first-run", "--no-default-browser-check"],
});

context.on("response", async (response) => {
  try {
    const req = response.request();
    const rtype = req.resourceType();
    if (rtype !== "xhr" && rtype !== "fetch") return;
    const url = response.url();
    const headers = response.headers();
    const ct = headers["content-type"];
    if (!interesting(url, ct)) return;

    let body;
    try {
      if (ct && /json|text/i.test(ct)) body = (await response.text()).slice(0, 12000);
    } catch {}

    const reqHeaders = req.headers();
    calls.push({
      time: new Date().toISOString(),
      type: rtype,
      method: req.method(),
      url,
      status: response.status(),
      contentType: ct,
      // auth mechanism clues (values redacted, presence only):
      auth: {
        hasAuthorization: Boolean(reqHeaders["authorization"]),
        hasCookie: Boolean(reqHeaders["cookie"]),
      },
      postData: req.postData()?.slice(0, 3000),
      responseSnippet: body,
    });
    dirty = true;
  } catch {}
});

context.on("page", (page) => {
  page.on("download", async (download) => {
    try {
      const name = download.suggestedFilename();
      const dest = path.join(DL, name);
      await download.saveAs(dest);
      calls.push({
        time: new Date().toISOString(),
        type: "download",
        method: "GET",
        url: download.url(),
        responseSnippet: `saved as ${name}`,
      });
      dirty = true;
      flush();
      console.log(`[download] ${name}  <-  ${download.url()}`);
    } catch (e) {
      console.error("download capture failed:", e?.message);
    }
  });
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log("Investigation browser open. Log ->", LOG);
console.log("Log in, go to Meetings, open one, click Download. Then create the");
console.log("STOP file (or close the window) to finish:", STOP);

let closed = false;
context.on("close", () => { closed = true; });

// Main loop: flush periodically, watch for STOP sentinel / window close.
while (!closed) {
  flush();
  if (fs.existsSync(STOP)) break;
  await new Promise((r) => setTimeout(r, 1500));
}

flush();
try { await context.close(); } catch {}
console.log(`Done. ${calls.length} calls captured -> ${LOG}`);
