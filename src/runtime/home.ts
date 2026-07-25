import os from "node:os";
import path from "node:path";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type CanonicalDirectoryResolution =
  | Readonly<{ state: "available"; path: string }>
  | Readonly<{ state: "unavailable"; reason: string }>;

export type HomeDirectoryResolution =
  | Readonly<{
      state: "available";
      path: string;
      source: "HOME" | "USERPROFILE" | "HOMEDRIVE+HOMEPATH" | "system";
    }>
  | Readonly<{
      state: "unavailable";
      code: "HOME_DIRECTORY_UNAVAILABLE";
      reason: string;
    }>;

export interface HomeDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: EnvironmentSource;
  readonly homedir?: () => string;
}

export class HomeDirectoryError extends Error {
  readonly code = "HOME_DIRECTORY_UNAVAILABLE";

  constructor(readonly reason: string) {
    super(
      `Home directory is unavailable: ${reason}. Set an absolute home directory or configure an explicit absolute application data path.`,
    );
    this.name = "HomeDirectoryError";
  }
}

function present(
  source: EnvironmentSource,
  name: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(source, name)
    ? source[name]
    : undefined;
}

function unavailable(reason: string): HomeDirectoryResolution {
  return {
    state: "unavailable",
    code: "HOME_DIRECTORY_UNAVAILABLE",
    reason,
  };
}

function unavailableDirectory(reason: string): CanonicalDirectoryResolution {
  return { state: "unavailable", reason };
}

function canonicalPosixDirectory(
  value: string,
  source: string,
): CanonicalDirectoryResolution {
  if (value.length === 0)
    return unavailableDirectory(`${source} must not be empty`);
  if (value.includes("\0"))
    return unavailableDirectory(`${source} must not contain a NUL character`);
  if (value !== value.trim())
    return unavailableDirectory(`${source} must not have surrounding whitespace`);
  if (!path.posix.isAbsolute(value))
    return unavailableDirectory(`${source} must be an absolute POSIX path`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.endsWith("/"))
    return unavailableDirectory(`${source} must be a canonical POSIX path`);
  if (normalized === path.posix.parse(normalized).root)
    return unavailableDirectory(`${source} must not be the filesystem root`);
  return { state: "available", path: normalized };
}

export function isAuthoritativeWindowsAbsolute(value: string): boolean {
  if (
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\") ||
    !path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const root = path.win32.parse(value).root;
  return (
    /^[A-Za-z]:\\$/u.test(root) ||
    /^\\\\[^\\/]+\\[^\\/]+\\$/u.test(root)
  );
}

function uncLexicalError(value: string, source: string): string | undefined {
  if (
    !value.startsWith("\\\\") ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\")
  ) {
    return undefined;
  }
  const components = value.slice(2).split("\\");
  const server = components[0];
  const share = components[1];
  if (
    server === undefined ||
    server.length === 0 ||
    server === "." ||
    server === ".."
  ) {
    return `${source} must contain a valid UNC server authority`;
  }
  if (server.endsWith(".") || server.endsWith(" ")) {
    return `${source} UNC server authority must not end in a dot or space`;
  }
  if (/[\[\]+ =;,]/u.test(server)) {
    return `${source} UNC server authority contains an invalid character`;
  }
  if (
    share === undefined ||
    share.length === 0 ||
    share === "." ||
    share === ".."
  ) {
    return `${source} must contain a non-empty UNC share name`;
  }
  if (share.endsWith(".") || share.endsWith(" ")) {
    return `${source} UNC share name must not end in a dot or space`;
  }
  if (/[\[\]+=;,]/u.test(share)) {
    return `${source} UNC share name contains an MS-FSCC-invalid character`;
  }
  if (share.length > 80) {
    return `${source} UNC share name must not exceed 80 characters`;
  }
  return undefined;
}

function canonicalWindowsDirectory(
  value: string,
  source: string,
): CanonicalDirectoryResolution {
  if (value.length === 0)
    return unavailableDirectory(`${source} must not be empty`);
  if (value.includes("\0"))
    return unavailableDirectory(`${source} must not contain a NUL character`);
  if (value !== value.trim())
    return unavailableDirectory(`${source} must not have surrounding whitespace`);
  if (/[\u0000-\u001f<>"/|?*]/u.test(value))
    return unavailableDirectory(
      `${source} must not contain Win32-forbidden characters`,
    );
  const colonSearchStart = /^[A-Za-z]:\\/u.test(value) ? 2 : 0;
  if (value.slice(colonSearchStart).includes(":"))
    return unavailableDirectory(
      `${source} must not contain Win32-forbidden characters`,
    );
  const uncError = uncLexicalError(value, source);
  if (uncError !== undefined) return unavailableDirectory(uncError);
  if (!isAuthoritativeWindowsAbsolute(value))
    return unavailableDirectory(
      `${source} must be an absolute drive path or complete UNC share path`,
    );
  const normalized = path.win32.normalize(value);
  if (
    normalized !== value ||
    value.endsWith("\\") ||
    value.endsWith("/")
  )
    return unavailableDirectory(`${source} must be a canonical Windows path`);
  if (
    normalized.toLowerCase() ===
    path.win32.parse(normalized).root.toLowerCase()
  ) {
    return unavailableDirectory(`${source} must not be a drive or share root`);
  }
  const root = path.win32.parse(normalized).root;
  const segments = normalized.slice(root.length).split("\\");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      segment.includes(":")
    ) {
      return unavailableDirectory(
        `${source} must not contain empty, aliased, or device path segments`,
      );
    }
    const deviceStem = segment.split(".", 1)[0]!;
    if (
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(deviceStem)
    ) {
      return unavailableDirectory(
        `${source} must not contain empty, aliased, or device path segments`,
      );
    }
  }
  return { state: "available", path: normalized };
}

export function resolveCanonicalAbsoluteDirectory(
  value: string,
  source: string,
  platform: NodeJS.Platform = process.platform,
): CanonicalDirectoryResolution {
  return platform === "win32"
    ? canonicalWindowsDirectory(value, source)
    : canonicalPosixDirectory(value, source);
}

function homeResolution(
  resolution: CanonicalDirectoryResolution,
  source: "HOME" | "USERPROFILE" | "HOMEDRIVE+HOMEPATH" | "system",
): HomeDirectoryResolution {
  return resolution.state === "available"
    ? { ...resolution, source }
    : {
        state: "unavailable",
        code: "HOME_DIRECTORY_UNAVAILABLE",
        reason: resolution.reason,
      };
}

function validateHomeDrive(value: string): string | undefined {
  if (value.length === 0) return "HOMEDRIVE must not be empty";
  if (value.includes("\0"))
    return "HOMEDRIVE must not contain a NUL character";
  if (value !== value.trim())
    return "HOMEDRIVE must not have surrounding whitespace";
  if (!/^[A-Za-z]:$/u.test(value))
    return "HOMEDRIVE must be exactly a Windows drive designator such as C:";
  return undefined;
}

function validateHomePath(value: string): string | undefined {
  if (value.length === 0) return "HOMEPATH must not be empty";
  if (value.includes("\0"))
    return "HOMEPATH must not contain a NUL character";
  if (value !== value.trim())
    return "HOMEPATH must not have surrounding whitespace";
  if (
    !value.startsWith("\\") ||
    value.startsWith("\\\\") ||
    value.includes("/") ||
    path.win32.normalize(value) !== value
  ) {
    return "HOMEPATH must be a canonical rooted path without a drive or UNC prefix";
  }
  return undefined;
}

export function resolveAuthoritativeHome(
  options: HomeDirectoryOptions = {},
): HomeDirectoryResolution {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const systemHomedir = options.homedir ?? os.homedir;

  if (platform === "win32") {
    const userProfile = present(environment, "USERPROFILE");
    if (userProfile !== undefined) {
      return homeResolution(
        canonicalWindowsDirectory(userProfile, "USERPROFILE"),
        "USERPROFILE",
      );
    }
    const homeDrive = present(environment, "HOMEDRIVE");
    const homePath = present(environment, "HOMEPATH");
    if (homeDrive !== undefined || homePath !== undefined) {
      if (homeDrive === undefined || homePath === undefined) {
        return unavailable(
          "HOMEDRIVE and HOMEPATH must be provided together",
        );
      }
      const driveError = validateHomeDrive(homeDrive);
      if (driveError !== undefined) return unavailable(driveError);
      const pathError = validateHomePath(homePath);
      if (pathError !== undefined) return unavailable(pathError);
      return homeResolution(
        canonicalWindowsDirectory(
          `${homeDrive}${homePath}`,
          "HOMEDRIVE+HOMEPATH",
        ),
        "HOMEDRIVE+HOMEPATH",
      );
    }
    try {
      return homeResolution(
        canonicalWindowsDirectory(systemHomedir(), "system"),
        "system",
      );
    } catch (error) {
      return unavailable(
        `the operating system home lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const configuredHome = present(environment, "HOME");
  if (configuredHome !== undefined) {
    return homeResolution(
      canonicalPosixDirectory(configuredHome, "HOME"),
      "HOME",
    );
  }
  try {
    return homeResolution(
      canonicalPosixDirectory(systemHomedir(), "system"),
      "system",
    );
  } catch (error) {
    return unavailable(
      `the operating system home lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function requireAuthoritativeHome(
  options: HomeDirectoryOptions = {},
): string {
  const resolution = resolveAuthoritativeHome(options);
  if (resolution.state === "unavailable") {
    throw new HomeDirectoryError(resolution.reason);
  }
  return resolution.path;
}
