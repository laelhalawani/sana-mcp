import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { isStandaloneBuild } from "../runtime/build-info.js";

export interface ServerTarget {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Return the exact target installed into MCP client configuration.
 * Standalone identity comes from the compile-time build marker. Source mode
 * intentionally points to the current Bun executable and repository entrypoint.
 */
export function serverTarget(): ServerTarget {
  if (isStandaloneBuild()) return { command: process.execPath, args: ["mcp"] };
  return {
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, "src", "mcp.ts")],
  };
}
