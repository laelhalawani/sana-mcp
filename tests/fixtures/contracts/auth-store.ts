import {
  confirmedPublicationToken,
  consumeContractCatchupCompletion,
  contractUserId,
  contractWorkspaceId,
  currentContractCacheIdentity,
  initialPublicationToken,
  mutateContractCacheIdentity,
  publishContractCacheIdentity,
  recordContractEvent,
  recordContractPendingPublication,
} from "./auth-model.js";

const scenario = process.env.SANA_TEST_AUTH_SCENARIO;
if (!scenario) throw new Error("SANA_TEST_AUTH_SCENARIO is required");

export class SyncGenerationChangedError extends Error {}
export class CacheOperationChangedError extends Error {}
export const MAX_MEETING_LIST_LIMIT = 1000;

export function inspectPersistedAuthIssue(state: {
  auth_issue_code: string | null;
  auth_issue_message: string | null;
}):
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "issue"; code: string; message: string }>
  | Readonly<{
      kind: "malformed";
      code: "AUTH_STATE_MALFORMED";
      message: string;
    }> {
  const { auth_issue_code: code, auth_issue_message: message } = state;
  if (code === null && message === null) return { kind: "none" };
  if (
    code === null ||
    message === null ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ||
    message.trim() === "" ||
    message.length > 1_000
  )
    return {
      kind: "malformed",
      code: "AUTH_STATE_MALFORMED",
      message: "Persisted authentication issue tuple is malformed",
    };
  return { kind: "issue", code, message };
}

interface ContractIdentity {
  generation: number;
  publicationToken: string;
  userId: string | null;
  workspaceId: string | null;
}

interface ContractSyncState {
  phase: "synced";
  message: string;
  blocking: 0 | 1;
  transcripts_total: number;
  transcripts_done: number;
  last_full_sync_ms: number | null;
  last_incremental_ms: number | null;
  daemon_pid: number | null;
  daemon_heartbeat_ms: number | null;
  error: string | null;
  auth_generation: number;
  auth_publication_token: string | null;
  auth_user_id: string | null;
  auth_workspace_id: string | null;
  auth_transition_pid: number | null;
  auth_transition_token: string | null;
  auth_transition_generation: number | null;
  auth_transition_kind: string | null;
  auth_transition_user_id: string | null;
  auth_transition_workspace_id: string | null;
  cache_user_id: string | null;
  cache_workspace_id: string | null;
  auth_issue_code: string | null;
  auth_issue_message: string | null;
  auth_issue_operation_token: string | null;
  auth_issue_generation: number | null;
  auth_issue_kind: string | null;
  auth_pending: 0 | 1;
  catchup_generation: number | null;
  sync_issue_code: string | null;
  sync_issue_cause: string | null;
  sync_issue_message: string | null;
}

function initialState(): ContractSyncState {
  const authIncomplete = scenario === "auth-incomplete";
  const publicationProbe =
    scenario === "verify-ready-state" ||
    scenario === "sync-unavailable" ||
    scenario === "missing-authoritative-identity";
  const durableSyncFailure =
    scenario === "durable-sync-unavailable" ||
    scenario === "daemon-status-persistence-with-previous";
  return {
    phase: "synced",
    message: "synthetic contract state",
    blocking: authIncomplete || durableSyncFailure || publicationProbe ? 1 : 0,
    transcripts_total: 2,
    transcripts_done: 2,
    last_full_sync_ms: Date.parse("2026-01-03T12:00:00Z"),
    last_incremental_ms: null,
    daemon_pid: null,
    daemon_heartbeat_ms: null,
    error: null,
    auth_generation: 2,
    auth_publication_token: initialPublicationToken,
    auth_user_id: contractUserId,
    auth_workspace_id: contractWorkspaceId,
    auth_transition_pid: null,
    auth_transition_token: null,
    auth_transition_generation: null,
    auth_transition_kind: null,
    auth_transition_user_id: null,
    auth_transition_workspace_id: null,
    cache_user_id: contractUserId,
    cache_workspace_id: contractWorkspaceId,
    auth_issue_code:
      authIncomplete || publicationProbe ? "AUTH_PUBLICATION_INCOMPLETE" : null,
    auth_issue_message:
      authIncomplete || publicationProbe
        ? "Local session persistence could not be confirmed; sign in again."
        : null,
    auth_issue_operation_token: publicationProbe
      ? initialPublicationToken
      : null,
    auth_issue_generation: publicationProbe ? 2 : null,
    auth_issue_kind: publicationProbe ? "login" : null,
    auth_pending: authIncomplete || publicationProbe ? 1 : 0,
    catchup_generation: publicationProbe ? 2 : null,
    sync_issue_code:
      durableSyncFailure
        ? "LOGIN_SYNC_UNAVAILABLE"
        : publicationProbe
          ? "PREVIOUS_SYNC_UNAVAILABLE"
          : null,
    sync_issue_cause:
      durableSyncFailure
        ? "DAEMON_START_FAILED"
        : publicationProbe
          ? "PREVIOUS_DAEMON_FAILURE"
          : null,
    sync_issue_message:
      durableSyncFailure
        ? "contract daemon launch failed"
        : publicationProbe
          ? "previous contract sync failure"
          : null,
  };
}

export class SanaStore {
  private readonly state = initialState();
  private stateRead = 0;

  constructor() {
    if (
      scenario === "request-store-incomplete" ||
      scenario === "verify-store-unavailable"
    ) {
      throw new Error("synthetic local store construction failure");
    }
  }

  getSyncState(): ContractSyncState {
    if (
      this.state.blocking === 1 &&
      consumeContractCatchupCompletion()
    ) {
      this.finishContractSyncCycle({
        generation: this.state.auth_generation,
        publicationToken: this.state.auth_publication_token!,
        userId: this.state.auth_user_id!,
        workspaceId: this.state.auth_workspace_id!,
      });
    }
    this.stateRead += 1;
    return this.peekContractSyncState();
  }

  peekContractSyncState(): ContractSyncState {
    const cache = currentContractCacheIdentity();
    return {
      ...this.state,
      cache_user_id: cache.userId,
      cache_workspace_id: cache.workspaceId,
      ...(scenario === "status-snapshot-changed"
        ? {
            message:
              this.stateRead % 2 === 0
                ? "synthetic status state A"
                : "synthetic status state B",
          }
        : {}),
    };
  }

  reconcileAuthState(): Readonly<{ kind: "current"; generation: number }> {
    return {
      kind: "current",
      generation:
        scenario === "status-snapshot-changed"
          ? this.state.auth_generation - 1
          : this.state.auth_generation,
    };
  }

  readConsistent<Value>(operation: () => Value): Value {
    return operation();
  }

  countMeetings(): number {
    return 2;
  }

  countTranscripts(): number {
    return 2;
  }

  countEmbedded(): number {
    return 0;
  }

  listMeetings(): readonly [] {
    if (scenario === "cache-operation-changed-after") {
      mutateContractCacheIdentity("synchronous-after-operation");
    }
    return [];
  }

  countLineMatches(): number {
    recordContractEvent("search-read-complete");
    if (scenario === "cache-search-changed-after-await") {
      queueMicrotask(() => {
        recordContractEvent("search-yield");
        mutateContractCacheIdentity("search-after-await");
      });
    }
    return 0;
  }

  searchLines(): readonly [] {
    return [];
  }

  getMeeting(id: string): Readonly<{ id: string; name: string }> {
    return { id, name: "Contract meeting" };
  }

  clearSyncUnavailable(): void {
    this.state.sync_issue_code = null;
    this.state.sync_issue_cause = null;
    this.state.sync_issue_message = null;
  }

  clearSyncUnavailableIfCurrent(identity: unknown): "cleared" {
    this.assertCurrentIdentity(identity);
    this.clearSyncUnavailable();
    recordContractEvent(`clear-sync:${this.state.auth_generation}`);
    return "cleared";
  }

  finishContractSyncCycle(identity: unknown): void {
    this.assertCurrentIdentity(identity);
    const current = identity as ContractIdentity;
    if (
      this.state.auth_pending !== 0 ||
      this.state.auth_transition_token !== null ||
      this.state.auth_issue_code !== null ||
      this.state.catchup_generation === null ||
      this.state.catchup_generation > current.generation ||
      current.userId === null ||
      current.workspaceId === null
    ) {
      throw new Error("contract catch-up cannot release the current cache");
    }
    publishContractCacheIdentity(
      current.userId!,
      current.workspaceId!,
    );
    this.state.blocking = 0;
    this.clearSyncUnavailable();
    recordContractEvent(`finish-sync:${current.generation}`);
  }

  resetFailuresIfCurrent(identity: unknown): "reset" {
    this.assertCurrentIdentity(identity);
    recordContractEvent(`reset-failures:${this.state.auth_generation}`);
    return "reset";
  }

  recordSyncUnavailable(code: string, cause: string, message: string): void {
    this.state.sync_issue_code = code;
    this.state.sync_issue_cause = cause;
    this.state.sync_issue_message = message;
  }

  recordSyncUnavailableIfCurrent(
    identity: unknown,
    code: string,
    cause: string,
    message: string,
  ): "recorded" {
    this.assertCurrentIdentity(identity);
    if (
      scenario === "sync-status-persistence-failed" ||
      scenario === "daemon-status-persistence-failed" ||
      scenario === "daemon-status-persistence-with-previous"
    ) {
      throw new Error("synthetic sync status persistence failure");
    }
    this.recordSyncUnavailable(code, cause, message);
    recordContractEvent(`record-sync:${this.state.auth_generation}`);
    return "recorded";
  }

  beginContractPublication(
    source: Readonly<{
      generation: number;
      publicationToken: string | null;
      userId?: string | null;
      workspaceId?: string | null;
    }>,
    target: Readonly<{
      userId: string | null;
      workspaceId: string | null;
    }>,
    kind: string,
  ): ContractIdentity {
    if (
      source.generation !== this.state.auth_generation ||
      source.publicationToken !== this.state.auth_publication_token ||
      source.userId !== this.state.auth_user_id ||
      source.workspaceId !== this.state.auth_workspace_id
    ) {
      throw new Error("contract publication source does not match durable state");
    }
    const generation = source.generation + 1;
    this.state.auth_transition_pid = process.pid;
    this.state.auth_transition_token = confirmedPublicationToken;
    this.state.auth_transition_generation = generation;
    this.state.auth_transition_kind = kind;
    this.state.auth_transition_user_id = target.userId;
    this.state.auth_transition_workspace_id = target.workspaceId;
    if (kind === "login") {
      this.state.auth_pending = 1;
      this.state.blocking = 1;
      this.state.catchup_generation = generation;
      this.state.auth_issue_code = null;
      this.state.auth_issue_message = null;
      this.state.auth_issue_operation_token = null;
      this.state.auth_issue_generation = null;
      this.state.auth_issue_kind = null;
    }
    recordContractPendingPublication({
      blocking: this.state.blocking,
      auth_pending: this.state.auth_pending,
      catchup_generation: this.state.catchup_generation,
      auth_transition_pid: this.state.auth_transition_pid,
      auth_transition_token: this.state.auth_transition_token,
      auth_transition_generation: this.state.auth_transition_generation,
      auth_transition_kind: this.state.auth_transition_kind,
      auth_transition_user_id: this.state.auth_transition_user_id,
      auth_transition_workspace_id: this.state.auth_transition_workspace_id,
      auth_issue_code: this.state.auth_issue_code,
      auth_issue_message: this.state.auth_issue_message,
      auth_issue_operation_token: this.state.auth_issue_operation_token,
      auth_issue_generation: this.state.auth_issue_generation,
      auth_issue_kind: this.state.auth_issue_kind,
      sync_issue_code: this.state.sync_issue_code,
      sync_issue_cause: this.state.sync_issue_cause,
      sync_issue_message: this.state.sync_issue_message,
    });
    recordContractEvent(`store-blocking:${generation}`);
    return {
      generation,
      publicationToken: confirmedPublicationToken,
      userId: target.userId,
      workspaceId: target.workspaceId,
    };
  }

  confirmContractPublication(identity: ContractIdentity): ContractIdentity {
    if (
      identity.generation !== this.state.auth_transition_generation ||
      identity.publicationToken !== this.state.auth_transition_token
    ) {
      throw new Error("contract publication confirmation does not match intent");
    }
    this.state.auth_generation = identity.generation;
    this.state.auth_publication_token = identity.publicationToken;
    this.state.auth_user_id = identity.userId;
    this.state.auth_workspace_id = identity.workspaceId;
    this.state.auth_transition_pid = null;
    this.state.auth_transition_token = null;
    this.state.auth_transition_generation = null;
    this.state.auth_transition_kind = null;
    this.state.auth_transition_user_id = null;
    this.state.auth_transition_workspace_id = null;
    this.state.auth_pending = 0;
    recordContractEvent(`store-confirm:${identity.generation}`);
    return { ...identity };
  }

  captureCacheOperation(): Readonly<{
    generation: number;
    publicationToken: string;
    userId: string;
    workspaceId: string;
  }> {
    if (scenario === "cache-operation-changed-before") {
      mutateContractCacheIdentity("before-capture");
    }
    const guard = {
      generation: this.state.auth_generation,
      publicationToken: this.state.auth_publication_token!,
      userId: this.state.auth_user_id!,
      workspaceId: this.state.auth_workspace_id!,
    };
    this.assertGuardMatches(guard);
    return guard;
  }

  withCacheOperation<Value>(
    guard: unknown,
    operation: () => Value,
  ): Value {
    if (scenario === "cache-operation-changed-during") {
      mutateContractCacheIdentity("before-synchronous-fence");
    }
    this.assertGuardMatches(guard);
    return operation();
  }

  assertCacheOperation(guard: unknown): void {
    this.assertGuardMatches(guard);
  }

  close(): void {
    if (
      scenario === "request-local-cleanup-incomplete" ||
      scenario === "verify-local-cleanup-incomplete"
    ) {
      throw new Error("synthetic local cleanup failure");
    }
  }

  private assertCurrentIdentity(identity: unknown): void {
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("generation" in identity) ||
      !("publicationToken" in identity) ||
      !("userId" in identity) ||
      !("workspaceId" in identity)
    ) {
      throw new Error("contract current-identity assertion received no identity");
    }
    const candidate = identity as ContractIdentity;
    if (
      candidate.generation !== this.state.auth_generation ||
      candidate.publicationToken !== this.state.auth_publication_token ||
      candidate.userId !== this.state.auth_user_id ||
      candidate.workspaceId !== this.state.auth_workspace_id
    ) {
      throw new Error("contract current-identity assertion failed");
    }
  }

  private assertGuardMatches(guard: unknown): void {
    this.assertCurrentIdentity(guard);
    const cache = currentContractCacheIdentity();
    if (
      cache.userId !== this.state.auth_user_id ||
      cache.workspaceId !== this.state.auth_workspace_id
    ) {
      recordContractEvent("cache-guard-rejected");
      throw new CacheOperationChangedError();
    }
  }
}
