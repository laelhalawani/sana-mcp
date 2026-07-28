import {
  PINNED_MODEL_ID,
  PINNED_MODEL_REVISION,
} from "./model-cache.js";

export const STANDALONE_SEMANTIC_SMOKE_VERSION = 1 as const;

export function standaloneSemanticSmokeEvidence(
  vectorBackend: "sqlite-vec" | "portable" = "sqlite-vec",
): Readonly<{
  smokeVersion: 1;
  model: typeof PINNED_MODEL_ID;
  revision: typeof PINNED_MODEL_REVISION;
  dimensions: readonly [2, 384];
  vectorBackend: "sqlite-vec" | "portable";
  sqliteVec: "v0.1.9" | "not-loaded";
  nearest: "row-0";
}> {
  return Object.freeze({
    smokeVersion: STANDALONE_SEMANTIC_SMOKE_VERSION,
    model: PINNED_MODEL_ID,
    revision: PINNED_MODEL_REVISION,
    dimensions: Object.freeze([2, 384] as const),
    vectorBackend,
    sqliteVec: vectorBackend === "sqlite-vec" ? "v0.1.9" : "not-loaded",
    nearest: "row-0",
  });
}
