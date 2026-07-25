import fs from "node:fs";
import path from "node:path";

export type LegacyArtifactInspection =
  | { state: "clear" }
  | { state: "blocked"; artifacts: readonly string[]; reason: string }
  | { state: "unavailable"; reason: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Recognize only artifact names produced by the former transaction writer.
 * This is deliberately read-only; migration owns any eventual cleanup.
 */
export function legacyArtifactPattern(targetLeaf: string): RegExp {
  const target = escapeRegExp(targetLeaf);
  const nonce = "[a-f0-9]{24}";
  const base = [
    `\\.${target}\\.sana-mcp\\.journal\\.json`,
    `\\.${target}\\.sana-mcp\\.lock`,
    `\\.${target}\\.sana-mcp-${nonce}\\.(?:bak|tmp)`,
    `\\.${target}\\.sana-mcp\\.lock\\.publish-${nonce}-${nonce}\\.tmp`,
    `\\.${target}\\.sana-mcp\\.lock\\.stale-${nonce}`,
  ].join("|");
  return new RegExp(`^(?:${base})(?:\\.remove-[a-f0-9]{48})?$`, "u");
}

export function inspectLegacyConfigArtifacts(
  file: string
): LegacyArtifactInspection {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  const targetLeaf = path.basename(absolute);
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "clear" };
    return {
      state: "unavailable",
      reason: `cannot inspect client config directory ${parent}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const pattern = legacyArtifactPattern(targetLeaf);
  const artifacts = names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(parent, name));
  if (artifacts.length === 0) return { state: "clear" };
  return {
    state: "blocked",
    artifacts,
    reason: `legacy sana-mcp transaction artifacts require manual action before modifying ${absolute}: ${artifacts.join(
      ", "
    )}`,
  };
}
