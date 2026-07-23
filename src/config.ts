import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Project root = one level up from this file's directory (src/ or dist/).
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..");

/**
 * Whether we are running inside a `bun build --compile`-produced standalone
 * binary. When true, the project's dist/ tree is bundled into the executable
 * and no longer lives on disk, so callers must not reference source/dist paths
 * and persistent data should live under the user's home directory.
 */
export function isCompiledBinary(): boolean {
  // Bun's first-class flag when available (newer Bun).
  if (
    typeof Bun !== "undefined" &&
    (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true
  )
    return true;
  // Bun <= 1.3.x doesn't set isStandaloneExecutable, and its standalone-EXE
  // virtual filesystem path differs by OS (/$bunfs on unix, ~BUN on Windows),
  // so import.meta.url heuristics aren't portable. Instead: a compiled binary's
  // process.execPath is our app binary, not the bun/node interpreter.
  return !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
}

export const DATA_DIR = process.env.SANA_DATA_DIR
  ? path.resolve(process.env.SANA_DATA_DIR)
  : (isCompiledBinary() ? path.join(os.homedir(), ".sana-mcp") : path.join(PROJECT_ROOT, "data"));

export const SESSION_FILE = path.join(DATA_DIR, "session.json");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const TRANSCRIPTS_DIR = process.env.SANA_TRANSCRIPTS_DIR
  ? path.resolve(process.env.SANA_TRANSCRIPTS_DIR)
  : path.join(DATA_DIR, "transcripts");

// Default Sana web app origin. Overridable; the login flow will also record
// whichever origin you actually end up on after signing in.
export const DEFAULT_BASE_URL = process.env.SANA_BASE_URL || "https://sana.ai";

// A transcript download that fails this many times is marked "failed" and no
// longer blocks a login catch-up (a fresh login resets the counter and retries).
export const MAX_TRANSCRIPT_ATTEMPTS = Number(process.env.SANA_MAX_ATTEMPTS ?? 5);

export interface AppConfig {
  baseUrl: string;
  // The origin the browser landed on after login (e.g. https://sana.ai).
  loggedInOrigin?: string;
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { baseUrl: DEFAULT_BASE_URL };
  }
}

export function saveConfig(cfg: AppConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
