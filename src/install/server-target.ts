import path from "node:path";
import { PROJECT_ROOT, isCompiledBinary } from "../config.js";

export interface ServerTarget {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The command an MCP client should run to start this sana-mcp server.
 * Compiled binary: <execPath> mcp (the CLI's mcp subcommand runs the server).
 * Dev (bun): <execPath> <abs>/src/mcp.ts. bun runs TypeScript natively, so no
 * build step or loader is needed; process.execPath is the bun binary. The MCP
 * server needs no special env, so none is set.
 */
export function serverTarget(): ServerTarget {
  if (isCompiledBinary()) return { command: process.execPath, args: ["mcp"] };
  return { command: process.execPath, args: [path.join(PROJECT_ROOT, "src", "mcp.ts")] };
}
