import { SanaClient } from "./auth-client.js";
import { SanaStore } from "./auth-store.js";

const scenario = process.env.SANA_TEST_AUTH_SCENARIO;
if (!scenario) throw new Error("SANA_TEST_AUTH_SCENARIO is required");

const INCOMPLETE = {
  kind: "incomplete" as const,
  code: "AUTH_PUBLICATION_INCOMPLETE",
  message: "Local session persistence could not be confirmed; sign in again.",
};

export function inspectCurrentSession(): Readonly<
  | { kind: "current"; generation: number }
  | typeof INCOMPLETE
> {
  if (scenario === "auth-incomplete") return INCOMPLETE;
  if (scenario === "auth-refresh-identity-mismatch") {
    return {
      kind: "incomplete",
      code: "AUTH_REFRESH_IDENTITY_MISMATCH",
      message: "A session refresh cannot change the confirmed Sana identity",
    };
  }
  return {
    kind: "current",
    generation: scenario === "status-snapshot-changed" ? 1 : 2,
  };
}

export function stableSessionSnapshot(
  store: { getSyncState(): unknown },
  loadClient: () => SanaClient = SanaClient.load,
):
  | typeof INCOMPLETE
  | Readonly<{
      kind: "stable";
      client: SanaClient;
      state: ReturnType<typeof store.getSyncState>;
      generation: number;
    }> {
  if (scenario === "auth-incomplete") {
    return INCOMPLETE;
  }
  if (scenario === "auth-refresh-identity-mismatch") {
    return {
      kind: "incomplete",
      code: "AUTH_REFRESH_IDENTITY_MISMATCH",
      message: "A session refresh cannot change the confirmed Sana identity",
    };
  }
  return {
    kind: "stable",
    client: loadClient(),
    state: store.getSyncState(),
    generation: 2,
  };
}

export class AuthPublicationBusyError extends Error {
  constructor(readonly ownerPid: number) {
    super(`Another session publication is active in process ${ownerPid}`);
    this.name = "AuthPublicationBusyError";
  }
}

export class StaleSessionWriterError extends Error {
  constructor(readonly currentGeneration: number) {
    super(
      `Session writer is stale; confirmed authentication generation is ${currentGeneration}`,
    );
    this.name = "StaleSessionWriterError";
  }
}

export class AuthTransitionIncompleteError extends Error {
  constructor(
    readonly issueCode: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthTransitionIncompleteError";
  }
}

export function publishClientSession(
  store: SanaStore,
  client: SanaClient,
  kind: string,
  sourceVersion: Readonly<{
    generation: number;
    publicationToken: string | null;
    userId?: string | null;
    workspaceId?: string | null;
  }>,
): Readonly<{
  generation: number;
  publicationToken: string;
  userId: string | null;
  workspaceId: string | null;
}> {
  if (
    scenario === "request-local-publication-incomplete" ||
    scenario === "verify-local-incomplete"
  ) {
    if (scenario === "verify-local-incomplete") {
      throw new Error("synthetic local publication failure");
    }
    throw new Error("synthetic request publication failure");
  }
  if (scenario === "auth-transition-incomplete") {
    throw new AuthTransitionIncompleteError(
      "AUTH_PUBLICATION_INCOMPLETE",
      "Local session persistence could not be confirmed; sign in again.",
    );
  }
  if (scenario === "publication-busy") {
    throw new AuthPublicationBusyError(4242);
  }
  if (scenario === "stale-writer") {
    throw new StaleSessionWriterError(7);
  }
  const targetVersion = client.sessionVersion();
  const intended = store.beginContractPublication(
    sourceVersion,
    {
      userId: targetVersion.userId,
      workspaceId: targetVersion.workspaceId,
    },
    kind,
  );
  client.saveContractPublication(intended.generation);
  const confirmation = store.confirmContractPublication(intended);
  return confirmation;
}

export function requireCurrentSession(): Readonly<{
  generation: 2;
  userId: "user-contract";
  workspaceId: "workspace-contract";
}> {
  return {
    generation: 2,
    userId: "user-contract",
    workspaceId: "workspace-contract",
  };
}
