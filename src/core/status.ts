// Presentation-agnostic session + sync status. Replaces the string-scraping the
// installer used to do (regex over the LLM status string) and feeds both the
// MCP status handler and the CLI status screen.
import type { SanaClient } from "../sana/client.js";
import type { SanaStore, SyncState, SyncPhase } from "../store/db.js";
import { semanticEnabled } from "../semantic/semantic.js";
import { estimateMinutes } from "./args.js";

export interface SessionInfo {
  hasCookie: boolean;
  loggedIn: boolean; // hasCookie && phase !== "needs_login"
  expired: boolean; // hasCookie but phase === "needs_login"
}

export function sessionInfo(client: SanaClient, s: SyncState): SessionInfo {
  const hasCookie = client.hasAuthCookie();
  const needsLogin = s.phase === "needs_login";
  return {
    hasCookie,
    loggedIn: hasCookie && !needsLogin,
    expired: hasCookie && needsLogin,
  };
}

/** Whether the session looks usable without doing a network call. */
export function sessionUsable(client: SanaClient, s: SyncState): boolean {
  return client.hasAuthCookie() && s.phase !== "needs_login";
}

/** A login-triggered catch-up sync is holding data tools. */
export function isBlocking(s: SyncState): boolean {
  return s.blocking === 1;
}

export interface StatusInfo {
  session: SessionInfo;
  blocking: boolean;
  phase: SyncPhase;
  transcriptsDone: number;
  transcriptsTotal: number;
  remaining: number;
  etaMinutes: number;
  meetings: number;
  transcripts: number;
  lastFullSyncMs: number | null;
  lastIncrementalMs: number | null;
  daemonHeartbeatMs: number | null;
  error: string | null;
  semantic: { enabled: boolean; embedded: number; total: number };
}

export function computeStatus(client: SanaClient, store: SanaStore): StatusInfo {
  const s = store.getSyncState();
  const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
  const semanticOn = semanticEnabled();
  const transcripts = store.countTranscripts();
  return {
    session: sessionInfo(client, s),
    blocking: isBlocking(s),
    phase: s.phase,
    transcriptsDone: s.transcripts_done,
    transcriptsTotal: s.transcripts_total,
    remaining,
    etaMinutes: estimateMinutes(remaining),
    meetings: store.countMeetings(),
    transcripts,
    lastFullSyncMs: s.last_full_sync_ms,
    lastIncrementalMs: s.last_incremental_ms,
    daemonHeartbeatMs: s.daemon_heartbeat_ms,
    error: s.error,
    semantic: { enabled: semanticOn, embedded: semanticOn ? store.countEmbedded() : 0, total: transcripts },
  };
}
