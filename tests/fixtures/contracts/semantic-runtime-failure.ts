export class SemanticUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticUnavailableError";
  }
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
