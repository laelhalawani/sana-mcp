import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { BUILD_INFO, isStandaloneBuild } from "./runtime/build-info.js";
import {
  parseRuntimeDirectories,
  RUNTIME_ENV,
} from "./runtime/env.js";
import { requireAuthoritativeHome } from "./runtime/home.js";
import {
  ensureSecureDirectories,
  readJsonFile,
  writeJsonAtomic,
  type SecureFileOptions,
} from "./runtime/secure-files.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..");

/**
 * Compatibility wrapper for existing consumers. The answer comes exclusively
 * from the injected build identity; executable names and virtual paths are not
 * consulted.
 */
export function isCompiledBinary(): boolean {
  return isStandaloneBuild();
}

export { BUILD_INFO };

export interface StoragePaths {
  readonly dataDir: string;
  readonly sessionFile: string;
  readonly configFile: string;
  readonly transcriptsDir: string;
}

export function resolveStoragePaths(): StoragePaths {
  const configured = parseRuntimeDirectories();
  const dataDir =
    configured.dataDir ??
    (BUILD_INFO.standalone
      ? path.join(requireAuthoritativeHome(), ".sana-mcp")
      : path.join(PROJECT_ROOT, "data"));
  return Object.freeze({
    dataDir,
    sessionFile: path.join(dataDir, "session.json"),
    configFile: path.join(dataDir, "config.json"),
    transcriptsDir:
      configured.transcriptsDir ?? path.join(dataDir, "transcripts"),
  });
}

export function dataDirectory(): string {
  return resolveStoragePaths().dataDir;
}

export function sessionFile(): string {
  return resolveStoragePaths().sessionFile;
}

export function transcriptsDirectory(): string {
  return resolveStoragePaths().transcriptsDir;
}

export const DEFAULT_BASE_URL = RUNTIME_ENV.baseUrl;
export const MAX_TRANSCRIPT_ATTEMPTS = RUNTIME_ENV.maxTranscriptAttempts;

const originSchema = z.string().transform((raw, context) => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    context.addIssue({ code: "custom", message: "must be an absolute HTTP(S) origin" });
    return z.NEVER;
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    (parsed.protocol === "http:" && !loopback) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must be an HTTPS (or loopback HTTP) origin without credentials, path, query, or fragment",
    });
    return z.NEVER;
  }
  return parsed.origin;
});

const appConfigSchema = z
  .object({
    baseUrl: originSchema,
    loggedInOrigin: originSchema.optional(),
  })
  .strict();

export interface AppConfig {
  baseUrl: string;
  loggedInOrigin?: string;
}

export class AppConfigValidationError extends Error {
  readonly code = "INVALID_APP_CONFIG";

  constructor(readonly issues: readonly string[]) {
    super("Application configuration is invalid");
    this.name = "AppConfigValidationError";
  }
}

export function ensureDataDir(options: SecureFileOptions = {}): void {
  const storage = resolveStoragePaths();
  ensureSecureDirectories([storage.dataDir, storage.transcriptsDir], options);
}

export function loadConfig(options: SecureFileOptions = {}): AppConfig {
  const result = readJsonFile(
    resolveStoragePaths().configFile,
    appConfigSchema,
    options,
  );
  if (result.kind === "missing") return { baseUrl: DEFAULT_BASE_URL };
  return result.value;
}

export function saveConfig(cfg: AppConfig, options: SecureFileOptions = {}): void {
  const validated = appConfigSchema.safeParse(cfg);
  if (!validated.success) {
    throw new AppConfigValidationError(
      validated.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    );
  }
  const persisted: AppConfig = { baseUrl: validated.data.baseUrl };
  if (validated.data.loggedInOrigin !== undefined) {
    persisted.loggedInOrigin = validated.data.loggedInOrigin;
  }
  writeJsonAtomic(resolveStoragePaths().configFile, persisted, options);
}
