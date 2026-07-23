import path from "node:path";
import { PROJECT_ROOT } from "../config.js";

export interface ServerTarget {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The command an MCP client should run to start this sana-mcp server.
 * Today: node <abs>/dist/mcp.js. process.execPath is the absolute path to the
 * node binary (and will be the bun binary post-port), so this stays correct
 * across runtimes. The MCP server needs no special env, so none is set.
 */
export function serverTarget(): ServerTarget {
  const mcpJs = path.join(PROJECT_ROOT, "dist", "mcp.js");
  return { command: process.execPath, args: [mcpJs] };
}
