// Read-only: is our MCP server currently registered with a given client?
// Used by the configurer wizard to show each toggle's current on/off state.
import { execFileSync, execSync } from "node:child_process";
import type { ClientDef } from "./clients.js";
import { which } from "./detect.js";
import {
  hasJsonServer,
  hasJsoncServer,
  hasTomlServer,
  hasYamlServer,
} from "./writers.js";

/**
 * Best-effort check of whether `name` is registered with client `c`.
 * File-based clients read their config; command-based clients (Claude Code)
 * query the CLI. Any error or missing file counts as "not registered".
 */
export function isRegistered(c: ClientDef, name: string): boolean {
  try {
    const inst = c.install;
    switch (inst.kind) {
      case "file-json": {
        const f = inst.path();
        return f ? hasJsonServer(f, inst.topKey, name) : false;
      }
      case "file-jsonc": {
        const f = inst.path();
        return f ? hasJsoncServer(f, inst.topKey, name) : false;
      }
      case "file-toml": {
        const f = inst.path();
        return f ? hasTomlServer(f, name) : false;
      }
      case "file-yaml-list": {
        const f = inst.path();
        return f ? hasYamlServer(f, name) : false;
      }
      case "command": {
        // Binary missing -> we can't tell; report not-registered rather than
        // failing an enable later.
        if (which(inst.bin) === null) return false;
        // e.g. `claude mcp get <name>` exits 0 when present, non-zero otherwise.
        // On Windows `claude` is a .cmd shim, so go through the shell there.
        try {
          if (process.platform === "win32") {
            const line = [inst.bin, "mcp", "get", name]
              .map((a) => `"${String(a).replace(/"/g, '""')}"`)
              .join(" ");
            execSync(line, { stdio: ["ignore", "ignore", "ignore"], timeout: 4000, windowsHide: true });
          } else {
            execFileSync(inst.bin, ["mcp", "get", name], {
              stdio: ["ignore", "ignore", "ignore"],
              timeout: 4000,
            });
          }
          return true;
        } catch {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
}
