// Dev helper: import the currently-valid browser-profile session into the
// client's session.json, so we can test the HTTP client without a fresh login.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PROFILE = path.join(ROOT, "data", "profile");
const SESSION = path.join(ROOT, "data", "session.json");

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
const cookies = await ctx.cookies("https://sana.ai");
await ctx.close();
const cookieMap = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

const me = await fetch("https://sana.ai/x-api/trpc/user.me", {
  headers: { cookie: cookieHeader, accept: "application/json" },
}).then((r) => r.json());
const user = me?.result?.data?.user;
const ws = me?.result?.data?.workspace;

fs.writeFileSync(
  SESSION,
  JSON.stringify(
    { cookies: cookieMap, workspaceId: ws?.id || user?.lastUsedWorkspaceId, email: user?.email },
    null,
    2
  )
);
console.log("wrote", SESSION, "\n  email:", user?.email, "\n  workspace:", ws?.id, ws?.name);
