import fs from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import { PROFILE_DIR, ensureDataDir } from "./config.js";

/** A persistent profile counts as "logged in" once it has been populated. */
export function hasSession(): boolean {
  try {
    return (
      fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Launch a persistent browser context backed by an on-disk profile
 * (data/profile). Cookies, localStorage and IndexedDB all persist here, so the
 * user logs in once and every later run - headless or headed - reuses it.
 *
 * Cross-platform: native window on Windows/macOS when headed, WSLg under WSL.
 * `channel` can select the system Chrome/Edge instead of bundled Chromium.
 */
export async function launchPersistent(opts: {
  headless: boolean;
  channel?: "chrome" | "msedge";
}): Promise<BrowserContext> {
  ensureDataDir();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    channel: opts.channel,
    viewport: null,
    acceptDownloads: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  return context;
}
