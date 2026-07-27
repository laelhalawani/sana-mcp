// Presentation-agnostic session + sync status. Status snapshots pair the
// persisted session with one SQLite read transaction before exposing metrics.
import { SanaClient } from "../sana/client.js";
import {
  inspectPersistedAuthIssue,
  type SanaStore,
  type SyncState,
  type SyncPhase,
} from "../store/db.js";
import { semanticCapabilityState } from "../semantic/semantic.js";
import { inspectCurrentSession } from "../sana/session-publication.js";

export interface SessionInfo {
  hasCookie: boolean;
  loggedIn: boolean;
  expired: boolean;
}

export function sessionInfo(client: SanaClient, s: SyncState): SessionInfo {
  const hasCookie = client.hasAuthCookie();
  const hasPendingChallenge = client.pendingSignInChallenge() !== null;
  const needsLogin = s.phase === "needs_login";
  return {
    hasCookie,
    loggedIn: hasCookie && !hasPendingChallenge && !needsLogin,
    expired: hasCookie && !hasPendingChallenge && needsLogin,
  };
}

export function sessionUsable(client: SanaClient, s: SyncState): boolean {
  return (
    client.hasAuthCookie() &&
    client.pendingSignInChallenge() === null &&
    s.phase !== "needs_login"
  );
}

export function isBlocking(s: SyncState): boolean {
  return s.blocking === 1;
}

export interface SyncUnavailableInfo {
  code: string;
  cause: string;
  message: string;
}

export interface StatusIssueBinding {
  authGeneration: number;
  authPublicationToken: string | null;
  authUserId: string | null;
  authWorkspaceId: string | null;
  cacheUserId: string | null;
  cacheWorkspaceId: string | null;
}

export interface BoundSyncUnavailableInfo {
  issue: SyncUnavailableInfo;
  binding: StatusIssueBinding;
}

export interface StatusInfo {
  session: SessionInfo;
  blocking: boolean;
  phase: SyncPhase;
  transcriptsDone: number | null;
  transcriptsTotal: number | null;
  remaining: number | null;
  etaMinutes: number | null;
  meetings: number | null;
  transcripts: number | null;
  lastFullSyncMs: number | null;
  lastIncrementalMs: number | null;
  daemonHeartbeatMs: number | null;
  error: string | null;
  authTransition?: { code: string; message: string };
  syncUnavailable?: SyncUnavailableInfo;
  previousSyncUnavailable?: SyncUnavailableInfo;
  semantic: {
    enabled: boolean;
    embedded: number | null;
    total: number | null;
    degradation?: { code: "SEMANTIC_CAPABILITY_UNAVAILABLE"; message: string };
  };
}

export type StatusSnapshot =
  | Readonly<{ kind: "ready"; status: StatusInfo }>
  | Readonly<{
      kind: "retry";
      code: "AUTH_STATUS_SNAPSHOT_CHANGED";
      message: string;
    }>;

export function captureStatusSnapshot(
  store: SanaStore,
  ephemeralSyncUnavailable?: BoundSyncUnavailableInfo,
  loadClient: () => SanaClient = SanaClient.load,
): StatusSnapshot {
  for (let attempt = 0; attempt < 3; attempt++) {
    const firstClient = loadClient();
    inspectCurrentSession(store, firstClient);
    const firstState = store.getSyncState();
    const secondClient = loadClient();
    const status = store.readConsistent(() => {
      const secondState = store.getSyncState();
      if (
        !sameSessionClient(firstClient, secondClient) ||
        JSON.stringify(firstState) !== JSON.stringify(secondState)
      ) {
        return null;
      }
      return buildStatus(
        secondClient,
        store,
        secondState,
        ephemeralSyncUnavailable &&
          statusIssueBindingMatches(
            ephemeralSyncUnavailable.binding,
            secondState,
            secondClient.sessionVersion(),
          )
          ? ephemeralSyncUnavailable.issue
          : undefined,
      );
    });
    if (status !== null) return { kind: "ready", status };
  }
  return {
    kind: "retry",
    code: "AUTH_STATUS_SNAPSHOT_CHANGED",
    message:
      "Authentication or sync state changed while local status was being collected",
  };
}

/**
 * Structured status for callers that already own a paired client/store view.
 * The MCP status path uses captureStatusSnapshot so it never mixes generations.
 */
export function computeStatus(
  client: SanaClient,
  store: SanaStore,
  ephemeralSyncUnavailable?: SyncUnavailableInfo,
): StatusInfo {
  return store.readConsistent(() =>
    buildStatus(
      client,
      store,
      store.getSyncState(),
      ephemeralSyncUnavailable,
    ),
  );
}

function buildStatus(
  client: SanaClient,
  store: SanaStore,
  s: SyncState,
  ephemeralSyncUnavailable?: SyncUnavailableInfo,
): StatusInfo {
  const version = client.sessionVersion();
  const tupleMatches =
    version.generation === s.auth_generation &&
    version.publicationToken === s.auth_publication_token &&
    (version.userId ?? null) === s.auth_user_id &&
    (version.workspaceId ?? null) === s.auth_workspace_id;
  const persistedAuthIssue = inspectPersistedAuthIssue(s);
  const authTransition =
    persistedAuthIssue.kind !== "none"
      ? {
          code: persistedAuthIssue.code,
          message: persistedAuthIssue.message,
        }
      : s.auth_transition_token !== null
        ? {
            code: "AUTH_PUBLICATION_IN_PROGRESS",
            message:
              "A local authentication publication is still in progress",
          }
        : !tupleMatches
          ? {
              code: "AUTH_STATUS_SNAPSHOT_CHANGED",
              message:
                "Authentication changed while local status was being collected",
            }
          : undefined;
  const activeCacheBlocked =
    client.pendingSignInChallenge() !== null ||
    s.blocking === 1 ||
    s.auth_user_id === null ||
    s.auth_workspace_id === null ||
    s.cache_user_id !== s.auth_user_id ||
    s.cache_workspace_id !== s.auth_workspace_id;
  const exposeMetrics = !activeCacheBlocked && authTransition === undefined;
  const transcripts = exposeMetrics ? store.countTranscripts() : null;
  const meetings = exposeMetrics ? store.countMeetings() : null;
  const transcriptsDone = exposeMetrics ? s.transcripts_done : null;
  const transcriptsTotal = exposeMetrics ? s.transcripts_total : null;
  const remaining =
    transcriptsDone !== null && transcriptsTotal !== null
      ? Math.max(0, transcriptsTotal - transcriptsDone)
      : null;
  const durableSyncUnavailable =
    s.sync_issue_code !== null &&
    s.sync_issue_cause !== null &&
    s.sync_issue_message !== null
      ? {
          code: s.sync_issue_code,
          cause: s.sync_issue_cause,
          message: s.sync_issue_message,
        }
      : undefined;
  const semanticState = semanticCapabilityState();
  const semanticOn = semanticState.kind === "available";
  return {
    session: sessionInfo(client, s),
    blocking: activeCacheBlocked || authTransition !== undefined,
    phase: s.phase,
    transcriptsDone,
    transcriptsTotal,
    remaining,
    // No authoritative download-rate measurement exists yet. Reporting no ETA
    // is preferable to inventing one from a hardcoded per-item duration.
    etaMinutes: null,
    meetings,
    transcripts,
    lastFullSyncMs: exposeMetrics ? s.last_full_sync_ms : null,
    lastIncrementalMs: exposeMetrics ? s.last_incremental_ms : null,
    daemonHeartbeatMs: s.daemon_heartbeat_ms,
    error: s.error,
    ...(authTransition ? { authTransition } : {}),
    ...(ephemeralSyncUnavailable
      ? {
          syncUnavailable: ephemeralSyncUnavailable,
          ...(durableSyncUnavailable
            ? { previousSyncUnavailable: durableSyncUnavailable }
            : {}),
        }
      : durableSyncUnavailable
        ? { syncUnavailable: durableSyncUnavailable }
        : {}),
    semantic: {
      enabled: semanticOn,
      embedded:
        semanticOn && exposeMetrics ? store.countEmbedded() : null,
      total: exposeMetrics ? transcripts : null,
      ...(semanticState.kind === "unsupported"
        ? {
            degradation: {
              code: "SEMANTIC_CAPABILITY_UNAVAILABLE" as const,
              message: semanticState.message,
            },
          }
        : {}),
    },
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

function sameSessionClient(left: SanaClient, right: SanaClient): boolean {
  const leftPending = left.pendingSignInChallenge();
  const rightPending = right.pendingSignInChallenge();
  return (
    sameSessionVersion(left.sessionVersion(), right.sessionVersion()) &&
    left.hasAuthCookie() === right.hasAuthCookie() &&
    leftPending?.email === rightPending?.email
  );
}

function statusIssueBindingMatches(
  binding: StatusIssueBinding,
  state: SyncState,
  version: ReturnType<SanaClient["sessionVersion"]>,
): boolean {
  return (
    binding.authGeneration === state.auth_generation &&
    binding.authPublicationToken === state.auth_publication_token &&
    binding.authUserId === state.auth_user_id &&
    binding.authWorkspaceId === state.auth_workspace_id &&
    binding.cacheUserId === state.cache_user_id &&
    binding.cacheWorkspaceId === state.cache_workspace_id &&
    binding.authGeneration === version.generation &&
    binding.authPublicationToken === version.publicationToken &&
    binding.authUserId === (version.userId ?? null) &&
    binding.authWorkspaceId === (version.workspaceId ?? null)
  );
}
