export class SemanticUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticUnavailableError";
  }
}

export const EMBED_DIM = 384;
export const EMBED_MODEL = "fixture-model";
export const SEMANTIC_INDEX_VERSION = 2;

export function vectorBackendForPlatform(): "sqlite-vec" {
  return "sqlite-vec";
}

export function semanticCapabilityState(): { kind: "available" } {
  return { kind: "available" };
}

export async function embedQuery(): Promise<never> {
  const failure = process.env.SANA_TEST_SEMANTIC_FAILURE;
  switch (failure) {
    case "unavailable":
      throw new SemanticUnavailableError("synthetic semantic dependency unavailable");
    case "error":
      throw new Error("synthetic semantic runtime failure");
    case "non-error":
      throw 7;
    default:
      throw new Error(
        "SANA_TEST_SEMANTIC_FAILURE must select an explicit contract failure"
      );
  }
}

export async function searchKnn(): Promise<never> {
  throw new Error("semantic failure contract must fail before vector search");
}
