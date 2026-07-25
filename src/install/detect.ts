// Cross-platform, presentation-free client detection helpers.
import fs from "node:fs";
import path from "node:path";
import {
  isAuthoritativeWindowsAbsolute,
  resolveCanonicalAbsoluteDirectory,
  resolveAuthoritativeHome,
} from "../runtime/home.js";

export { isAuthoritativeWindowsAbsolute };

export type DetectionResult =
  | { state: "present"; evidence: readonly string[] }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

export type PathResolution =
  | { state: "available"; path: string }
  | { state: "unavailable"; reason: string };

export type CommandResolution =
  | { state: "present"; path: string }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function home(...parts: string[]): PathResolution {
  const resolved = resolveAuthoritativeHome();
  return resolved.state === "available"
    ? { state: "available", path: path.join(resolved.path, ...parts) }
    : { state: "unavailable", reason: resolved.reason };
}

export function appSupport(...parts: string[]): PathResolution {
  return home("Library", "Application Support", ...parts);
}

export function appData(): PathResolution {
  if (process.platform !== "win32")
    return { state: "unavailable", reason: "APPDATA is only defined for Windows clients" };
  const value = process.env.APPDATA;
  if (!value)
    return { state: "unavailable", reason: "APPDATA is required to locate this client" };
  return resolveCanonicalAbsoluteDirectory(value, "APPDATA", "win32");
}

export function localAppData(): PathResolution {
  if (process.platform !== "win32")
    return { state: "unavailable", reason: "LOCALAPPDATA is only defined for Windows clients" };
  const value = process.env.LOCALAPPDATA;
  if (!value)
    return { state: "unavailable", reason: "LOCALAPPDATA is required to detect this client" };
  return resolveCanonicalAbsoluteDirectory(value, "LOCALAPPDATA", "win32");
}

export function xdgConfig(): PathResolution {
  const configured = process.env.XDG_CONFIG_HOME;
  if (configured !== undefined) {
    return resolveCanonicalAbsoluteDirectory(
      configured,
      "XDG_CONFIG_HOME",
      process.platform,
    );
  }
  return home(".config");
}

/** A failed stat is unavailable, never silently equivalent to absence. */
export function detectPath(candidate: string | null | undefined): DetectionResult {
  if (!candidate) return { state: "unavailable", reason: "client path is unavailable" };
  try {
    fs.lstatSync(candidate);
    return { state: "present", evidence: [candidate] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unavailable", reason: `cannot inspect ${candidate}: ${errorText(error)}` };
  }
}

export function combineDetections(results: readonly DetectionResult[]): DetectionResult {
  const evidence = results.flatMap((result) =>
    result.state === "present" ? [...result.evidence] : []
  );
  if (evidence.length > 0) return { state: "present", evidence };
  const unavailable = results.find(
    (result): result is Extract<DetectionResult, { state: "unavailable" }> =>
      result.state === "unavailable"
  );
  return unavailable ?? { state: "absent" };
}

function pathCandidates(bin: string, platform = process.platform): string[] {
  if (path.basename(bin) !== bin) {
    const absolute =
      platform === "win32"
        ? isAuthoritativeWindowsAbsolute(bin) && !bin.startsWith("\\\\")
        : path.isAbsolute(bin);
    return absolute ? [bin] : [];
  }
  const rawPath = process.env.PATH;
  if (rawPath === undefined) return [];
  const directories = rawPath.split(path.delimiter).filter(Boolean);
  if (platform !== "win32") return directories.map((directory) => path.join(directory, bin));

  const extension = path.extname(bin);
  const configured = process.env.PATHEXT;
  const extensions = extension
    ? [""]
    : (configured ?? "")
        .split(";")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
  return directories
    .filter(
      (directory) =>
        isAuthoritativeWindowsAbsolute(directory) && !directory.startsWith("\\\\")
    )
    .flatMap((directory) =>
      extensions.map((candidateExtension) =>
        path.win32.join(directory, `${bin}${candidateExtension}`)
      )
    );
}

/** Resolve a command without invoking a shell or an external lookup program. */
export function resolveCommand(bin: string): CommandResolution {
  if (!bin || bin.includes("\0"))
    return { state: "unavailable", reason: "command name is empty or invalid" };
  if (
    process.platform === "win32" &&
    path.basename(bin) === bin &&
    !path.extname(bin) &&
    process.env.PATHEXT === undefined
  )
    return { state: "unavailable", reason: "PATHEXT is required for Windows command detection" };
  const candidates = pathCandidates(bin);
  if (candidates.length === 0)
    return { state: "unavailable", reason: "PATH is not available for command detection" };

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (process.platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return { state: "present", path: candidate };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR"
      )
        continue;
      return {
        state: "unavailable",
        reason: `cannot inspect command candidate ${candidate}: ${errorText(error)}`,
      };
    }
  }
  return { state: "absent" };
}

export function detectCommand(bin: string): DetectionResult {
  const result = resolveCommand(bin);
  if (result.state === "present") return { state: "present", evidence: [result.path] };
  return result;
}

export function detectVscodeExtension(prefix: string): DetectionResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*-$/.test(prefix))
    return { state: "unavailable", reason: "extension prefix is invalid" };
  const directories = [
    home(".vscode", "extensions"),
    home(".vscode-insiders", "extensions"),
    home(".cursor", "extensions"),
    home(".windsurf", "extensions"),
    home(".vscodium", "extensions"),
  ];
  const outcomes: DetectionResult[] = [];
  for (const resolution of directories) {
    if (resolution.state === "unavailable") {
      outcomes.push(resolution);
      continue;
    }
    const directory = resolution.path;
    const detected = detectPath(directory);
    if (detected.state === "absent") {
      outcomes.push(detected);
      continue;
    }
    if (detected.state === "unavailable") {
      outcomes.push(detected);
      continue;
    }
    try {
      const match = fs.readdirSync(directory).find((name) => name.startsWith(prefix));
      outcomes.push(
        match
          ? { state: "present", evidence: [path.join(directory, match)] }
          : { state: "absent" }
      );
    } catch (error) {
      outcomes.push({
        state: "unavailable",
        reason: `cannot inspect extensions in ${directory}: ${errorText(error)}`,
      });
    }
  }
  return combineDetections(outcomes);
}
