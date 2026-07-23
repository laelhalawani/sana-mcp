// Clean-room registry of supported MCP clients (paths/formats/detection are
// public facts, re-authored from official docs - not copied from any library).
import path from "node:path";
import type { ServerTarget } from "./server-target.js";
import {
  home,
  appData,
  localAppData,
  appSupport,
  xdgConfig,
  exists,
  which,
  hasVscodeExt,
} from "./detect.js";

export type InstallKind =
  | { kind: "file-json"; path: () => string | null; topKey: string }
  | { kind: "file-toml"; path: () => string | null }
  | { kind: "file-yaml-list"; path: () => string | null }
  | {
      kind: "command";
      bin: string;
      buildArgs: (name: string, entry: ServerTarget) => string[];
      removeArgs?: (name: string) => string[];
    };

export interface ClientDef {
  id: string;
  name: string;
  detect: () => boolean;
  install: InstallKind;
  reloadHint: string;
}

// ---- per-client config paths --------------------------------------------

function claudeDesktopConfig(): string | null {
  if (process.platform === "darwin") return appSupport("Claude", "claude_desktop_config.json");
  if (process.platform === "win32") {
    const a = appData();
    return a ? path.join(a, "Claude", "claude_desktop_config.json") : null;
  }
  return null; // no official Linux build
}

function cursorConfig(): string {
  return home(".cursor", "mcp.json");
}

function codexConfig(): string {
  return home(".codex", "config.toml");
}

function geminiConfig(): string {
  return home(".gemini", "settings.json");
}

function windsurfConfig(): string {
  return home(".codeium", "windsurf", "mcp_config.json");
}

function clineConfig(): string {
  return home(".cline", "data", "settings", "cline_mcp_settings.json");
}

function rooConfig(): string | null {
  const a = appData();
  const base =
    process.platform === "darwin"
      ? appSupport("Code", "User", "globalStorage")
      : process.platform === "win32"
        ? a
          ? path.join(a, "Code", "User", "globalStorage")
          : null
        : path.join(xdgConfig(), "Code", "User", "globalStorage");
  return base ? path.join(base, "rooveterinaryinc.roo-cline", "mcp_settings.json") : null;
}

function amazonQConfig(): string {
  return home(".aws", "amazonq", "mcp.json");
}

function continueConfig(): string {
  return home(".continue", "config.yaml");
}

function zedConfig(): string | null {
  if (process.platform === "darwin") return appSupport("zed", "settings.json");
  if (process.platform === "win32") {
    const a = appData();
    return a ? path.join(a, "Zed", "settings.json") : null;
  }
  return path.join(xdgConfig(), "zed", "settings.json");
}

// ---- detection helpers ---------------------------------------------------

function appBundle(name: string): boolean {
  return process.platform === "darwin" && exists(path.join("/Applications", name));
}

// ---- the registry --------------------------------------------------------

export const CLIENTS: ClientDef[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    detect() {
      const lad = localAppData();
      return (
        exists(claudeDesktopConfig()) ||
        appBundle("Claude.app") ||
        (lad ? exists(path.join(lad, "AnthropicClaude")) : false)
      );
    },
    install: { kind: "file-json", path: claudeDesktopConfig, topKey: "mcpServers" },
    reloadHint: "quit and restart Claude Desktop",
  },
  {
    id: "claude-code",
    name: "Claude Code (CLI)",
    detect() {
      return which("claude") !== null || exists(home(".claude.json")) || exists(home(".claude"));
    },
    install: {
      kind: "command",
      bin: "claude",
      buildArgs: (name, e) => ["mcp", "add", name, "-s", "user", "--", e.command, ...e.args],
      removeArgs: (name) => ["mcp", "remove", name, "-s", "user"],
    },
    reloadHint: "restart Claude Code sessions",
  },
  {
    id: "cursor",
    name: "Cursor",
    detect() {
      const lad = localAppData();
      return (
        exists(home(".cursor")) ||
        appBundle("Cursor.app") ||
        (lad ? exists(path.join(lad, "Programs", "cursor")) : false)
      );
    },
    install: { kind: "file-json", path: cursorConfig, topKey: "mcpServers" },
    reloadHint: "restart Cursor",
  },
  {
    id: "codex",
    name: "Codex CLI",
    detect() {
      return which("codex") !== null || exists(home(".codex"));
    },
    install: { kind: "file-toml", path: codexConfig },
    reloadHint: "restart Codex sessions",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    detect() {
      return which("gemini") !== null || exists(home(".gemini"));
    },
    install: { kind: "file-json", path: geminiConfig, topKey: "mcpServers" },
    reloadHint: "restart Gemini CLI sessions",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detect() {
      const lad = localAppData();
      return (
        exists(home(".codeium", "windsurf")) ||
        appBundle("Windsurf.app") ||
        (lad ? exists(path.join(lad, "Programs", "Windsurf")) : false)
      );
    },
    install: { kind: "file-json", path: windsurfConfig, topKey: "mcpServers" },
    reloadHint: "Windsurf reloads the affected server automatically",
  },
  {
    id: "zed",
    name: "Zed",
    detect() {
      return which("zed") !== null || exists(zedConfig()) || appBundle("Zed.app");
    },
    install: { kind: "file-json", path: zedConfig, topKey: "context_servers" },
    reloadHint: "Zed reloads settings automatically",
  },
  {
    id: "cline",
    name: "Cline",
    detect() {
      return exists(home(".cline")) || hasVscodeExt("saoudrizwan.claude-dev-");
    },
    install: { kind: "file-json", path: clineConfig, topKey: "mcpServers" },
    reloadHint: "restart the server in Cline's MCP panel",
  },
  {
    id: "roo-code",
    name: "Roo Code",
    detect() {
      return exists(rooConfig()) || hasVscodeExt("rooveterinaryinc.roo-cline-");
    },
    install: { kind: "file-json", path: rooConfig, topKey: "mcpServers" },
    reloadHint: "restart the server in Roo's MCP panel",
  },
  {
    id: "amazon-q",
    name: "Amazon Q Developer CLI",
    detect() {
      return which("q") !== null || which("qchat") !== null || exists(home(".aws", "amazonq"));
    },
    install: { kind: "file-json", path: amazonQConfig, topKey: "mcpServers" },
    reloadHint: "restart Amazon Q sessions",
  },
  {
    id: "continue",
    name: "Continue",
    detect() {
      return exists(home(".continue")) || hasVscodeExt("continue.continue-");
    },
    install: { kind: "file-yaml-list", path: continueConfig },
    reloadHint: "reload Continue config",
  },
];
