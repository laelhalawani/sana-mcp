// Cross-platform path + presence helpers for client detection. Read-only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// ---- path roots ----------------------------------------------------------

export function home(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

// macOS ~/Library/Application Support/...
export function appSupport(...parts: string[]): string {
  return home("Library", "Application Support", ...parts);
}

// Windows %APPDATA% (Roaming); null off-Windows or if unset.
export function appData(): string | null {
  return process.env.APPDATA ?? null;
}

// Windows %LOCALAPPDATA%; null off-Windows or if unset.
export function localAppData(): string | null {
  return process.env.LOCALAPPDATA ?? null;
}

// XDG config dir (Linux/BSD); falls back to ~/.config.
export function xdgConfig(): string {
  return process.env.XDG_CONFIG_HOME || home(".config");
}

// ---- presence ------------------------------------------------------------

export function exists(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function anyExists(paths: Array<string | null | undefined>): boolean {
  return paths.some(exists);
}

/**
 * Resolve a binary on PATH (which on unix, where on Windows). Returns the
 * absolute path, or null if not found / the lookup tool is unavailable.
 */
export function which(bin: string): string | null {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(tool, [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

/** True if the named extension prefix is present in any VS Code-family extensions dir. */
export function hasVscodeExt(prefix: string): boolean {
  const dirs = [
    home(".vscode", "extensions"),
    home(".vscode-insiders", "extensions"),
    home(".cursor", "extensions"),
    home(".windsurf", "extensions"),
    home(".vscodium", "extensions"),
  ];
  for (const d of dirs) {
    if (!exists(d)) continue;
    try {
      if (fs.readdirSync(d).some((n) => n.startsWith(prefix))) return true;
    } catch {
      /* ignore unreadable dir */
    }
  }
  return false;
}
