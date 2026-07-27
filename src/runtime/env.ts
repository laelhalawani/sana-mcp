import path from "node:path";
import os from "node:os";
import { resolveCanonicalAbsoluteDirectory } from "./home.js";

/**
 * Product defaults are used only when the corresponding variable is absent.
 * An explicitly present but empty or malformed value is always an error.
 */
export const RUNTIME_DEFAULTS = Object.freeze({
  baseUrl: "https://sana.ai",
  maxRetryDelayAttempts: 5,
  countWaitMs: 30_000,
  syncIntervalMs: 10 * 60_000,
  requestDelayMs: 150,
  maxNewTranscripts: 0,
  embedModel: "Xenova/all-MiniLM-L6-v2",
  embedDimension: 384,
  embedMinWords: 5,
  embedIdleMs: 60_000,
  semanticEnabled: false,
});

export class EnvironmentConfigError extends Error {
  readonly code = "INVALID_ENVIRONMENT";

  constructor(
    readonly variable: string,
    readonly reason: string,
  ) {
    super(`${variable}: ${reason}`);
    this.name = "EnvironmentConfigError";
  }
}

export interface RuntimeSettings {
  readonly baseUrl: string;
  /** Number of failures before the retry delay stops increasing. */
  readonly maxRetryDelayAttempts: number;
  readonly countWaitMs: number;
  readonly syncIntervalMs: number;
  readonly requestDelayMs: number;
  readonly maxNewTranscripts: number;
  readonly embedModel: string;
  readonly embedDimension: number;
  readonly embedMinWords: number;
  readonly embedIdleMs: number;
  readonly semanticEnabled: boolean;
}

export interface RuntimeEnvironment extends RuntimeSettings {
  readonly dataDir?: string;
  readonly transcriptsDir?: string;
}

export type RuntimeDirectoryEnvironment = Pick<
  RuntimeEnvironment,
  "dataDir" | "transcriptsDir"
>;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

function present(source: EnvironmentSource, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === undefined) {
    return undefined;
  }
  return source[name];
}

function nonEmpty(source: EnvironmentSource, name: string): string | undefined {
  const raw = present(source, name);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) {
    throw new EnvironmentConfigError(name, "must not be empty when set");
  }
  if (value.includes("\0")) {
    throw new EnvironmentConfigError(name, "must not contain a NUL character");
  }
  return value;
}

function integer(
  source: EnvironmentSource,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = present(source, name);
  if (raw === undefined) return defaultValue;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new EnvironmentConfigError(name, "must be a base-10 integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EnvironmentConfigError(
      name,
      `must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function boolean(source: EnvironmentSource, name: string, defaultValue: boolean): boolean {
  const raw = present(source, name);
  if (raw === undefined) return defaultValue;
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
  if (/^(?:0|false|no|off)$/i.test(raw)) return false;
  throw new EnvironmentConfigError(
    name,
    "must be one of 1, true, yes, on, 0, false, no, or off",
  );
}

function directory(
  source: EnvironmentSource,
  name: string,
  workingDirectory: string,
  platform: NodeJS.Platform,
): string | undefined {
  const raw = present(source, name);
  if (raw === undefined) return undefined;
  const resolution = resolveCanonicalAbsoluteDirectory(raw, name, platform);
  if (resolution.state === "unavailable") {
    throw new EnvironmentConfigError(name, resolution.reason);
  }
  const resolved = resolution.path;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const protectedDirectories = [
    pathApi.parse(resolved).root,
    pathApi.resolve(workingDirectory),
  ];
  if (platform === process.platform) {
    protectedDirectories.push(pathApi.resolve(os.tmpdir()));
    const systemHome = resolveCanonicalAbsoluteDirectory(
      os.homedir(),
      "system home",
      platform,
    );
    if (systemHome.state === "available") {
      protectedDirectories.push(systemHome.path);
    }
  }
  const comparable = (value: string) =>
    platform === "win32" ? value.toLowerCase() : value;
  if (
    protectedDirectories.some(
      (protectedDirectory) =>
        comparable(pathApi.resolve(protectedDirectory)) === comparable(resolved),
    )
  ) {
    throw new EnvironmentConfigError(
      name,
      "must name a dedicated application subdirectory, not a filesystem, home, temporary, or working-directory root",
    );
  }
  return resolved;
}

export function parseRuntimeDirectories(
  source: EnvironmentSource = process.env,
  workingDirectory = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): RuntimeDirectoryEnvironment {
  return Object.freeze({
    dataDir: directory(source, "SANA_DATA_DIR", workingDirectory, platform),
    transcriptsDir: directory(
      source,
      "SANA_TRANSCRIPTS_DIR",
      workingDirectory,
      platform,
    ),
  });
}

function origin(source: EnvironmentSource): string {
  const raw = nonEmpty(source, "SANA_BASE_URL");
  if (raw === undefined) return RUNTIME_DEFAULTS.baseUrl;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvironmentConfigError("SANA_BASE_URL", "must be an absolute HTTP(S) origin");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EnvironmentConfigError("SANA_BASE_URL", "must use HTTP or HTTPS");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new EnvironmentConfigError(
      "SANA_BASE_URL",
      "must use HTTPS unless the origin is loopback-only",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new EnvironmentConfigError(
      "SANA_BASE_URL",
      "must be an origin without credentials, path, query, or fragment",
    );
  }
  return parsed.origin;
}

export function parseRuntimeEnvironment(
  source: EnvironmentSource = process.env,
  workingDirectory = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): RuntimeEnvironment {
  const directories = parseRuntimeDirectories(
    source,
    workingDirectory,
    platform,
  );
  return Object.freeze({
    ...directories,
    ...parseRuntimeSettings(source),
  });
}

function parseRuntimeSettings(
  source: EnvironmentSource = process.env,
): RuntimeSettings {
  const embedModel = nonEmpty(source, "SANA_EMBED_MODEL") ?? RUNTIME_DEFAULTS.embedModel;
  return Object.freeze({
    baseUrl: origin(source),
    maxRetryDelayAttempts: integer(
      source,
      "SANA_MAX_ATTEMPTS",
      RUNTIME_DEFAULTS.maxRetryDelayAttempts,
      1,
      100,
    ),
    countWaitMs: integer(
      source,
      "SANA_COUNT_WAIT_MS",
      RUNTIME_DEFAULTS.countWaitMs,
      1,
      5 * 60_000,
    ),
    syncIntervalMs: integer(
      source,
      "SANA_SYNC_INTERVAL_MS",
      RUNTIME_DEFAULTS.syncIntervalMs,
      1,
      24 * 60 * 60_000,
    ),
    requestDelayMs: integer(
      source,
      "SANA_REQUEST_DELAY_MS",
      RUNTIME_DEFAULTS.requestDelayMs,
      0,
      60_000,
    ),
    maxNewTranscripts: integer(
      source,
      "SANA_MAX_NEW_TRANSCRIPTS",
      RUNTIME_DEFAULTS.maxNewTranscripts,
      0,
      100_000,
    ),
    embedModel,
    embedDimension: integer(
      source,
      "SANA_EMBED_DIM",
      RUNTIME_DEFAULTS.embedDimension,
      1,
      16_384,
    ),
    embedMinWords: integer(
      source,
      "SANA_EMBED_MIN_WORDS",
      RUNTIME_DEFAULTS.embedMinWords,
      1,
      10_000,
    ),
    embedIdleMs: integer(
      source,
      "SANA_EMBED_IDLE_MS",
      RUNTIME_DEFAULTS.embedIdleMs,
      1,
      24 * 60 * 60_000,
    ),
    semanticEnabled: boolean(
      source,
      "SANA_SEMANTIC",
      RUNTIME_DEFAULTS.semanticEnabled,
    ),
  });
}

/**
 * Non-storage runtime settings are safe to validate during module evaluation.
 * Storage paths are resolved by config only when a persistent operation needs
 * them, so metadata/help/protocol inspection cannot touch HOME or local data.
 */
export const RUNTIME_ENV = parseRuntimeSettings();
