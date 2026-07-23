// Full-session recorder for reverse-engineering Sana's frontend.
// Persistent-profile headed Chromium + HAR (full bodies) + Playwright trace +
// live JSON log of API traffic (incl. auth-flow navigations with their URLs,
// which carry the sign-in token/code). Finishes on STOP sentinel or window close.
//
//   node scripts/record.mjs [startUrl]

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
const LOG = path.join(OUT, "net.json");
const HAR = path.join(OUT, "session.har");
const TRACE = path.join(OUT, "trace.zip");
const STOP = path.join(OUT, "STOP");

fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(DL, { recursive: true });
try { fs.rmSync(STOP); } catch {}

const startUrl = process.argv[2] || "https://sana.ai/";
const calls = [];
let dirty = false;
const flush = () => { if (dirty) { fs.writeFileSync(LOG, JSON.stringify(calls, null, 2)); dirty = false; } };

const isApi = (u) => /\/x-api\/|\/api\/|graphql|trpc/i.test(u);
const isAuthNav = (u) => /\/x-api\/auth\/|callback|sign-in|signin|verify|token=|code=/i.test(u);

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  acceptDownloads: true,
  args: ["--no-first-run", "--no-default-browser-check"],
  recordHar: { path: HAR, content: "embed", mode: "full" },
});

await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

// Capture ALL requests to auth/api routes at request-time (so magic-link and
// callback navigations - which carry the token in the URL - are never missed).
context.on("request", (req) => {
  try {
    const url = req.url();
    if (!isApi(url) && !isAuthNav(url)) return;
    if (req.resourceType() === "document" || isAuthNav(url)) {
      calls.push({
        time: new Date().toISOString(),
        phase: "request",
        resourceType: req.resourceType(),
        method: req.method(),
        url,
        postData: req.postData()?.slice(0, 3000),
      });
      dirty = true;
    }
  } catch {}
});

context.on("response", async (response) => {
  try {
    const req = response.request();
    const url = response.url();
    const rtype = req.resourceType();
    const relevant = (rtype === "xhr" || rtype === "fetch") ? isApi(url) : isAuthNav(url);
    if (!relevant) return;
    const headers = response.headers();
    const ct = headers["content-type"];
    let body;
    try { if (ct && /json|text/i.test(ct)) body = (await response.text()).slice(0, 16000); } catch {}
    const setCookie = headers["set-cookie"];
    calls.push({
      time: new Date().toISOString(),
      phase: "response",
      resourceType: rtype,
      method: req.method(),
      url,
      status: response.status(),
      contentType: ct,
      setCookiePresent: Boolean(setCookie),
      postData: req.postData()?.slice(0, 3000),
      responseSnippet: body,
    });
    dirty = true;
  } catch {}
});

context.on("page", (page) => {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      calls.push({ time: new Date().toISOString(), phase: "console.error", text: msg.text().slice(0, 500) });
      dirty = true;
    }
  });
  page.on("download", async (download) => {
    try {
      const name = download.suggestedFilename();
      const dest = path.join(DL, name);
      await download.saveAs(dest);
      calls.push({ time: new Date().toISOString(), phase: "download", url: download.url(), saved: name });
      dirty = true; flush();
      console.log(`[download] ${name}  <-  ${download.url()}`);
    } catch (e) { console.error("download failed:", e?.message); }
  });
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log("Recorder running.");
console.log("  live log:", LOG);
console.log("  HAR:", HAR, " trace:", TRACE);
console.log("Finish by creating STOP or closing the window:", STOP);

let closed = false;
context.on("close", () => { closed = true; });
while (!closed) { flush(); if (fs.existsSync(STOP)) break; await new Promise((r) => setTimeout(r, 1500)); }

flush();
try { await context.tracing.stop({ path: TRACE }); } catch {}
try { await context.close(); } catch {}
console.log(`Done. ${calls.length} calls -> ${LOG}; HAR -> ${HAR}; trace -> ${TRACE}`);
