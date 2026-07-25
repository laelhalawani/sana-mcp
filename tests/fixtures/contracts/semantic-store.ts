const contractUserId = ["user", "contract"].join("-");
const contractWorkspaceId = ["workspace", "contract"].join("-");
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

const syncState = Object.freeze({
  phase: "synced",
  message: "synthetic contract state",
  meetings_total: 4,
  transcripts_done: 2,
  transcripts_total: 2,
  last_full_sync_ms: Date.parse("2026-01-03T12:00:00Z"),
  last_incremental_ms: Date.parse("2026-01-03T12:00:00Z"),
  daemon_pid: null,
  daemon_heartbeat_ms: null,
  blocking: 0,
  catchup_epoch_ms: null,
  error: null,
  auth_pending: 0,
  auth_transition_pid: null,
  auth_generation: 1,
  auth_publication_token: [
    "22222222",
    "2222",
    "4222",
    "8222",
    "222222222222",
  ].join("-"),
  auth_user_id: contractUserId,
  auth_workspace_id: contractWorkspaceId,
  auth_transition_token: null,
  auth_transition_generation: null,
  auth_transition_kind: null,
  auth_transition_user_id: null,
  auth_transition_workspace_id: null,
  auth_issue_code: null,
  auth_issue_message: null,
  auth_issue_operation_token: null,
  auth_issue_generation: null,
  auth_issue_kind: null,
  catchup_generation: null,
  cache_user_id: contractUserId,
  cache_workspace_id: contractWorkspaceId,
  sync_issue_code: null,
  sync_issue_cause: null,
  sync_issue_message: null,
});

const rows = Object.freeze([
  {
    meeting_id: "meeting-alpha",
    line_no: 1,
    text: "Contract coverage works.",
    created_at_ms: Date.parse("2026-01-02T10:00:00Z"),
    name: "Alpha planning",
  },
  {
    meeting_id: "meeting-beta",
    line_no: 1,
    text: "Review contract path.",
    created_at_ms: Date.parse("2026-01-03T10:00:00Z"),
    name: "Beta review",
  },
]);

export class CacheOperationChangedError extends Error {}

function matchingRows(match: string): typeof rows {
  if (match.includes("coverage")) return Object.freeze([rows[0]]);
  if (match.includes("contract")) return rows;
  return Object.freeze([]);
}

export class SanaStore {
  readonly db = {};

  close(): void {}

  getSyncState(): typeof syncState {
    return syncState;
  }

  readConsistent<Value>(operation: () => Value): Value {
    return operation();
  }

  reconcileAuthState(): Readonly<{ kind: "current"; generation: 1 }> {
    return { kind: "current", generation: 1 };
  }

  clearSyncUnavailable(): void {}

  clearSyncUnavailableIfCurrent(): "cleared" {
    return "cleared";
  }

  recordSyncUnavailable(): never {
    throw new Error(
      "semantic contract daemon is available; degradation recording is unexpected",
    );
  }

  recordSyncUnavailableIfCurrent(): never {
    return this.recordSyncUnavailable();
  }

  captureCacheOperation(): Readonly<{
    generation: 1;
    publicationToken: string;
    userId: string;
    workspaceId: string;
  }> {
    return {
      generation: 1,
      publicationToken: syncState.auth_publication_token,
      userId: contractUserId,
      workspaceId: contractWorkspaceId,
    };
  }

  withCacheOperation<Value>(
    _guard: unknown,
    operation: () => Value,
  ): Value {
    return operation();
  }

  assertCacheOperation(): void {}

  countMeetings(): number {
    return 4;
  }

  countTranscripts(): number {
    return 2;
  }

  countEmbedded(): never {
    throw new Error("keyword-only standalone status must not count embeddings");
  }

  countLineMatches(match: string): number {
    return matchingRows(match).length;
  }

  searchLines(
    match: string,
    options: { limit: number; offset: number; sort: string },
  ): typeof rows {
    const selected = [...matchingRows(match)];
    if (options.sort === "newest") {
      selected.sort((a, b) => b.created_at_ms - a.created_at_ms);
    } else {
      selected.sort((a, b) => a.created_at_ms - b.created_at_ms);
    }
    return Object.freeze(selected.slice(options.offset, options.offset + options.limit));
  }
}
