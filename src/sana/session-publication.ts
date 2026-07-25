import crypto from "node:crypto";
import { SanaClient } from "./client.js";
import type {
  AuthPublicationIntent,
  AuthPublicationKind,
  SanaStore,
  SyncCycleIdentity,
  SyncState,
} from "../store/db.js";
import { pidAlive } from "../sync/lock.js";

export class AuthPublicationBusyError extends Error {
  readonly code = "AUTH_PUBLICATION_BUSY";

  constructor(readonly ownerPid: number) {
    super(`Another session publication is active in process ${ownerPid}`);
    this.name = "AuthPublicationBusyError";
  }
}

export class StaleSessionWriterError extends Error {
  readonly code = "STALE_SESSION_WRITER";

  constructor(readonly currentGeneration: number) {
    super(
      `Session writer is stale; confirmed authentication generation is ${currentGeneration}`,
    );
    this.name = "StaleSessionWriterError";
  }
}

export class AuthTransitionIncompleteError extends Error {
  readonly code = "AUTH_TRANSITION_INCOMPLETE";

  constructor(
    readonly issueCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthTransitionIncompleteError";
  }
}

export interface AuthConfirmation {
  readonly generation: number;
  readonly publicationToken: string;
  readonly userId: string | null;
  readonly workspaceId: string | null;
}

export function publishClientSession(
  store: Pick<
    SanaStore,
    | "claimAuthPublication"
    | "confirmAuthPublication"
    | "markAuthPublicationIncomplete"
  >,
  client: Pick<SanaClient, "sessionVersion" | "savePublication">,
  kind: AuthPublicationKind,
  sourceVersion = client.sessionVersion(),
): AuthConfirmation {
  const targetVersion = client.sessionVersion();
  const claim = store.claimAuthPublication(
    sourceVersion,
    {
      userId: targetVersion.userId ?? null,
      workspaceId: targetVersion.workspaceId ?? null,
    },
    kind,
    crypto.randomUUID(),
    process.pid,
    pidAlive,
  );
  if (claim.kind === "busy") {
    throw new AuthPublicationBusyError(claim.ownerPid);
  }
  if (claim.kind === "stale") {
    throw new StaleSessionWriterError(claim.currentGeneration);
  }
  if (claim.kind === "incomplete") {
    throw new AuthTransitionIncompleteError(claim.code, claim.message);
  }

  const intent = claim.intent;
  let failure: unknown;
  let confirmed = false;
  let issueCode = "AUTH_SESSION_PERSISTENCE_UNKNOWN";
  let issueMessage =
    "Local session persistence could not be confirmed; sign in again.";
  try {
    client.savePublication(
      intent.targetGeneration,
      intent.operationToken,
    );
    issueCode = "AUTH_PUBLICATION_CONFIRMATION_FAILED";
    issueMessage =
      "The session was written but its authentication generation could not be confirmed; sign in again.";
    const confirmation = store.confirmAuthPublication(intent, Date.now());
    if (confirmation === "not-current") {
      throw new Error(
        "The session publication no longer owns its authentication transition",
      );
    }
    confirmed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (!confirmed) {
      const cleanupErrors: unknown[] = [];
      try {
        const released = store.markAuthPublicationIncomplete(
          intent,
          issueCode,
          issueMessage,
          Date.now(),
        );
        if (released === "not-current") {
          cleanupErrors.push(
            new Error(
              "Could not persist the authentication issue because publication ownership changed",
            ),
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [failure, ...cleanupErrors],
          "Session publication and transition cleanup failed",
        );
      }
    }
  }
  if (confirmed) {
    return {
      generation: intent.targetGeneration,
      publicationToken: intent.operationToken,
      userId: intent.userId,
      workspaceId: intent.workspaceId,
    };
  }
  throw new AuthTransitionIncompleteError(issueCode, issueMessage, {
    cause: failure,
  });
}

export function requireCurrentSession(
  store: Pick<SanaStore, "reconcileAuthState">,
  client: Pick<SanaClient, "sessionVersion">,
): SyncCycleIdentity {
  const current = inspectCurrentSession(store, client);
  if (current.kind === "incomplete") {
    throw new AuthTransitionIncompleteError(
      current.code,
      current.message,
    );
  }
  const version = client.sessionVersion();
  if (version.userId == null || version.workspaceId == null) {
    throw new AuthTransitionIncompleteError(
      "AUTH_IDENTITY_UNAVAILABLE",
      "The confirmed session does not contain an authoritative user and workspace identity",
    );
  }
  if (version.publicationToken === null) {
    throw new AuthTransitionIncompleteError(
      "AUTH_PUBLICATION_TOKEN_UNAVAILABLE",
      "The confirmed session does not contain a publication token",
    );
  }
  return {
    generation: current.generation,
    publicationToken: version.publicationToken,
    userId: version.userId,
    workspaceId: version.workspaceId,
  };
}

export function inspectCurrentSession(
  store: Pick<SanaStore, "reconcileAuthState">,
  client: Pick<SanaClient, "sessionVersion">,
):
  | Readonly<{ kind: "current"; generation: number }>
  | Readonly<{ kind: "incomplete"; code: string; message: string }> {
  return store.reconcileAuthState(client.sessionVersion(), pidAlive);
}

export type StableSessionSnapshot =
  | Readonly<{
      kind: "stable";
      client: SanaClient;
      state: SyncState;
      generation: number;
    }>
  | Readonly<{
      kind: "incomplete";
      code: string;
      message: string;
    }>
  | Readonly<{
      kind: "unstable";
      code: "AUTH_SNAPSHOT_UNSTABLE";
      message: string;
    }>;

/**
 * Reload and compare two complete persisted session/store snapshots. A caller
 * may authorize cache access only from the returned stable pair.
 */
export function stableSessionSnapshot(
  store: Pick<SanaStore, "reconcileAuthState" | "getSyncState">,
  loadClient: () => SanaClient = SanaClient.load,
  options: Readonly<{
    attempts?: number;
    requireAuthSettled?: boolean;
  }> = {},
): StableSessionSnapshot {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || attempts > 10) {
    throw new TypeError("Stable session snapshot attempts must be between 1 and 10");
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const firstClient = loadClient();
    const reconciled = inspectCurrentSession(store, firstClient);
    if (reconciled.kind === "incomplete") return reconciled;
    const firstState = store.getSyncState();
    const secondClient = loadClient();
    const secondState = store.getSyncState();
    const firstVersion = firstClient.sessionVersion();
    const secondVersion = secondClient.sessionVersion();
    if (
      sameSessionVersion(firstVersion, secondVersion) &&
      sameConfirmedState(firstState, secondState) &&
      stableStateIsComplete(secondState) &&
      confirmedStateMatches(secondState, secondVersion) &&
      (!options.requireAuthSettled || secondState.auth_pending === 0)
    ) {
      return {
        kind: "stable",
        client: secondClient,
        state: secondState,
        generation: secondState.auth_generation,
      };
    }
  }
  return {
    kind: "unstable",
    code: "AUTH_SNAPSHOT_UNSTABLE",
    message:
      "The persisted authentication session changed while it was being inspected",
  };
}

function sameSessionVersion(
  left: ReturnType<SanaClient["sessionVersion"]>,
  right: ReturnType<SanaClient["sessionVersion"]>,
): boolean {
  return (
    left.generation === right.generation &&
    left.publicationToken === right.publicationToken &&
    (left.userId ?? null) === (right.userId ?? null) &&
    (left.workspaceId ?? null) === (right.workspaceId ?? null)
  );
}

function sameConfirmedState(left: SyncState, right: SyncState): boolean {
  return (
    left.auth_generation === right.auth_generation &&
    left.auth_publication_token === right.auth_publication_token &&
    left.auth_user_id === right.auth_user_id &&
    left.auth_workspace_id === right.auth_workspace_id &&
    left.auth_transition_pid === right.auth_transition_pid &&
    left.auth_transition_token === right.auth_transition_token &&
    left.auth_transition_generation === right.auth_transition_generation &&
    left.auth_transition_kind === right.auth_transition_kind &&
    left.auth_transition_user_id === right.auth_transition_user_id &&
    left.auth_transition_workspace_id ===
      right.auth_transition_workspace_id &&
    left.auth_issue_code === right.auth_issue_code &&
    left.auth_issue_message === right.auth_issue_message &&
    left.auth_issue_operation_token ===
      right.auth_issue_operation_token &&
    left.auth_issue_generation === right.auth_issue_generation &&
    left.auth_issue_kind === right.auth_issue_kind &&
    left.auth_pending === right.auth_pending &&
    left.blocking === right.blocking &&
    left.phase === right.phase &&
    left.cache_user_id === right.cache_user_id &&
    left.cache_workspace_id === right.cache_workspace_id
  );
}

function confirmedStateMatches(
  state: SyncState,
  version: ReturnType<SanaClient["sessionVersion"]>,
): boolean {
  return (
    state.auth_generation === version.generation &&
    state.auth_publication_token === version.publicationToken &&
    state.auth_user_id === (version.userId ?? null) &&
    state.auth_workspace_id === (version.workspaceId ?? null)
  );
}

function stableStateIsComplete(state: SyncState): boolean {
  return (
    Number.isSafeInteger(state.auth_generation) &&
    state.auth_generation >= 0 &&
    (state.auth_generation === 0) ===
      (state.auth_publication_token === null) &&
    (state.auth_user_id === null) ===
      (state.auth_workspace_id === null) &&
    state.auth_transition_pid === null &&
    state.auth_transition_token === null &&
    state.auth_transition_generation === null &&
    state.auth_transition_kind === null &&
    state.auth_transition_user_id === null &&
    state.auth_transition_workspace_id === null &&
    state.auth_issue_code === null &&
    state.auth_issue_message === null &&
    state.auth_issue_operation_token === null &&
    state.auth_issue_generation === null &&
    state.auth_issue_kind === null
  );
}
