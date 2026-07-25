// Registry of supported MCP clients. It contains data and deterministic
// detection/config-shaping only; presentation belongs to the app layer.
import path from "node:path";
import type { ServerTarget } from "./server-target.js";
import type { EntryBuilder, FileConfigKind } from "./writers.js";
import {
  appData,
  appSupport,
  combineDetections,
  detectCommand,
  detectPath,
  detectVscodeExtension,
  home,
  localAppData,
  type DetectionResult,
  type PathResolution,
  xdgConfig,
} from "./detect.js";

export interface FileInstall {
  kind: "file";
  format: FileConfigKind;
  path: () => PathResolution;
  topKey?: string;
  build?: EntryBuilder;
}

export interface ClientDef {
  id: string;
  name: string;
  detect: () => DetectionResult;
  install: FileInstall;
  reloadHint: string;
}

export function detectClient(client: ClientDef): DetectionResult {
  try {
    return client.detect();
  } catch (error) {
    return {
      state: "unavailable",
      reason: `client detection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function available(candidate: string): PathResolution {
  return { state: "available", path: candidate };
}

function joinResolution(root: PathResolution, ...parts: string[]): PathResolution {
  return root.state === "available" ? available(path.join(root.path, ...parts)) : root;
}

/** Standard command/args/env MCP entry. */
/** opencode uses a command vector and the `environment` key. */
export const opencodeEntry: EntryBuilder = (entry) => {
  const value: Record<string, unknown> = {
    type: "local",
    command: [entry.command, ...entry.args],
  };
  if (entry.env && Object.keys(entry.env).length > 0) value.environment = { ...entry.env };
  return value;
};

/** VS Code uses an explicit stdio discriminator. */
export const vscodeEntry: EntryBuilder = (entry) => {
  const value: Record<string, unknown> = {
    type: "stdio",
    command: entry.command,
    args: [...entry.args],
  };
  if (entry.env && Object.keys(entry.env).length > 0) value.env = { ...entry.env };
  return value;
};

function claudeDesktopConfig(): PathResolution {
  if (process.platform === "darwin")
    return appSupport("Claude", "claude_desktop_config.json");
  if (process.platform === "win32")
    return joinResolution(appData(), "Claude", "claude_desktop_config.json");
  return { state: "unavailable", reason: "Claude Desktop has no supported Linux config path" };
}

function rooConfig(): PathResolution {
  if (process.platform === "darwin")
    return appSupport(
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "mcp_settings.json"
    );
  if (process.platform === "win32")
    return joinResolution(
      appData(),
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "mcp_settings.json"
    );
  return joinResolution(
    xdgConfig(),
    "Code",
    "User",
    "globalStorage",
    "rooveterinaryinc.roo-cline",
    "mcp_settings.json"
  );
}

function zedConfig(): PathResolution {
  if (process.platform === "darwin") return appSupport("zed", "settings.json");
  if (process.platform === "win32")
    return joinResolution(appData(), "Zed", "settings.json");
  return joinResolution(xdgConfig(), "zed", "settings.json");
}

function opencodeDir(): PathResolution {
  if (process.platform === "win32") return joinResolution(appData(), "opencode");
  return joinResolution(xdgConfig(), "opencode");
}

function opencodeConfig(): PathResolution {
  const directory = opencodeDir();
  if (directory.state === "unavailable") return directory;
  const jsonc = path.join(directory.path, "opencode.jsonc");
  const json = path.join(directory.path, "opencode.json");
  const jsoncState = detectPath(jsonc);
  const jsonState = detectPath(json);
  if (jsoncState.state === "present" && jsonState.state === "present")
    return {
      state: "unavailable",
      reason: "both opencode.jsonc and opencode.json exist; the authoritative config is ambiguous",
    };
  if (jsoncState.state === "present") return available(jsonc);
  if (jsoncState.state === "unavailable")
    return { state: "unavailable", reason: jsoncState.reason };
  if (jsonState.state === "unavailable")
    return { state: "unavailable", reason: jsonState.reason };
  return available(json);
}

function vscodeUserConfig(): PathResolution {
  if (process.platform === "darwin")
    return appSupport("Code", "User", "mcp.json");
  if (process.platform === "win32")
    return joinResolution(appData(), "Code", "User", "mcp.json");
  return joinResolution(xdgConfig(), "Code", "User", "mcp.json");
}

function detectAppBundle(name: string): DetectionResult {
  return process.platform === "darwin"
    ? detectPath(path.join("/Applications", name))
    : { state: "absent" };
}

function detectResolvedPath(resolution: PathResolution): DetectionResult {
  return resolution.state === "available"
    ? detectPath(resolution.path)
    : { state: "unavailable", reason: resolution.reason };
}

function detectWindowsPath(root: PathResolution, ...parts: string[]): DetectionResult {
  if (process.platform !== "win32") return { state: "absent" };
  return detectResolvedPath(joinResolution(root, ...parts));
}

export const CLIENTS: readonly ClientDef[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    detect: () =>
      combineDetections([
        detectResolvedPath(claudeDesktopConfig()),
        detectAppBundle("Claude.app"),
        detectWindowsPath(localAppData(), "AnthropicClaude"),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: claudeDesktopConfig,
      topKey: "mcpServers",
    },
    reloadHint: "quit and restart Claude Desktop",
  },
  {
    id: "claude-code",
    name: "Claude Code (CLI)",
    detect: () =>
      combineDetections([
        detectCommand("claude"),
        detectResolvedPath(home(".claude.json")),
        detectResolvedPath(home(".claude")),
      ]),
    // User-scoped Claude Code MCP registrations are represented in this file.
    // File ownership can be proved exactly; opaque CLI text output cannot.
    install: {
      kind: "file",
      format: "json",
      path: () => home(".claude.json"),
      topKey: "mcpServers",
    },
    reloadHint: "restart Claude Code sessions",
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: () =>
      combineDetections([
        detectResolvedPath(home(".cursor")),
        detectAppBundle("Cursor.app"),
        detectWindowsPath(localAppData(), "Programs", "cursor"),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: () => home(".cursor", "mcp.json"),
      topKey: "mcpServers",
    },
    reloadHint: "restart Cursor",
  },
  {
    id: "codex",
    name: "Codex CLI",
    detect: () =>
      combineDetections([
        detectCommand("codex"),
        detectResolvedPath(home(".codex")),
      ]),
    install: {
      kind: "file",
      format: "toml",
      path: () => home(".codex", "config.toml"),
    },
    reloadHint: "restart Codex sessions",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    detect: () =>
      combineDetections([
        detectCommand("gemini"),
        detectResolvedPath(home(".gemini")),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: () => home(".gemini", "settings.json"),
      topKey: "mcpServers",
    },
    reloadHint: "restart Gemini CLI sessions",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detect: () =>
      combineDetections([
        detectResolvedPath(home(".codeium", "windsurf")),
        detectAppBundle("Windsurf.app"),
        detectWindowsPath(localAppData(), "Programs", "Windsurf"),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: () => home(".codeium", "windsurf", "mcp_config.json"),
      topKey: "mcpServers",
    },
    reloadHint: "Windsurf reloads the affected server automatically",
  },
  {
    id: "zed",
    name: "Zed",
    detect: () =>
      combineDetections([detectCommand("zed"), detectResolvedPath(zedConfig()), detectAppBundle("Zed.app")]),
    install: { kind: "file", format: "json", path: zedConfig, topKey: "context_servers" },
    reloadHint: "Zed reloads settings automatically",
  },
  {
    id: "cline",
    name: "Cline",
    detect: () =>
      combineDetections([
        detectResolvedPath(home(".cline")),
        detectVscodeExtension("saoudrizwan.claude-dev-"),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: () =>
        home(".cline", "data", "settings", "cline_mcp_settings.json"),
      topKey: "mcpServers",
    },
    reloadHint: "restart the server in Cline's MCP panel",
  },
  {
    id: "roo-code",
    name: "Roo Code",
    detect: () =>
      combineDetections([
        detectResolvedPath(rooConfig()),
        detectVscodeExtension("rooveterinaryinc.roo-cline-"),
      ]),
    install: { kind: "file", format: "json", path: rooConfig, topKey: "mcpServers" },
    reloadHint: "restart the server in Roo's MCP panel",
  },
  {
    id: "amazon-q",
    name: "Amazon Q Developer CLI",
    detect: () =>
      combineDetections([
        detectCommand("q"),
        detectCommand("qchat"),
        detectResolvedPath(home(".aws", "amazonq")),
      ]),
    install: {
      kind: "file",
      format: "json",
      path: () => home(".aws", "amazonq", "mcp.json"),
      topKey: "mcpServers",
    },
    reloadHint: "restart Amazon Q sessions",
  },
  {
    id: "continue",
    name: "Continue",
    detect: () =>
      combineDetections([
        detectResolvedPath(home(".continue")),
        detectVscodeExtension("continue.continue-"),
      ]),
    install: {
      kind: "file",
      format: "yaml-list",
      path: () => home(".continue", "config.yaml"),
    },
    reloadHint: "reload Continue config",
  },
  {
    id: "opencode",
    name: "opencode",
    detect: () =>
      combineDetections([detectCommand("opencode"), detectResolvedPath(opencodeDir())]),
    install: {
      kind: "file",
      format: "jsonc",
      path: opencodeConfig,
      topKey: "mcp",
      build: opencodeEntry,
    },
    reloadHint: "restart opencode",
  },
  {
    id: "vscode",
    name: "VS Code (Copilot)",
    detect: () =>
      combineDetections([
        detectCommand("code"),
        detectResolvedPath(vscodeUserConfig()),
        detectAppBundle("Visual Studio Code.app"),
        detectWindowsPath(localAppData(), "Programs", "Microsoft VS Code"),
      ]),
    install: {
      kind: "file",
      format: "jsonc",
      path: vscodeUserConfig,
      topKey: "servers",
      build: vscodeEntry,
    },
    reloadHint: "reload VS Code (or restart Copilot chat)",
  },
];
