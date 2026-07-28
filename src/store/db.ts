import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  dataDirectory,
  ensureDataDir,
  MAX_RETRY_DELAY_ATTEMPTS,
} from "../config.js";
import {
  ensureSecureDirectory,
  openSensitiveFile,
  repairSensitiveFilePermissions,
} from "../runtime/secure-files.js";
import { transcriptLines } from "../sana/transcript.js";

/** Named-parameter values accepted by bun:sqlite (object binding form). */
export type Bindings = Record<
  string,
  string | number | bigint | boolean | null | NodeJS.TypedArray
>;

export interface MeetingListOpts {
  limit?: number;
  offset?: number;
  query?: string;
  sort?: "newest" | "oldest";
  status?: "ready" | "downloading" | "processing" | "retrying";
  dateFrom?: number; // epoch ms, inclusive
  dateTo?: number; // epoch ms, inclusive
}

export type MeetingListRow = MeetingRow & {
  has_transcript: number;
  has_metadata: number;
  word_count: number | null;
  attempts: number;
  last_error: string | null;
  last_attempt_ms: number | null;
};

const RETRY_BASE_DELAY_MS = 10 * 60_000;
const RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;

/** Delay after an artifact failure; the attempt setting caps growth, not retries. */
export function retryDelayMs(attempts: number): number {
  const cappedAttempts = Math.min(
    Math.max(attempts, 1),
    MAX_RETRY_DELAY_ATTEMPTS,
  );
  // The six-hour ceiling is reached at attempt seven, so larger exponents never
  // need to be evaluated and cannot overflow.
  const safeExponent = Math.min(cappedAttempts - 1, 6);
  return Math.min(
    RETRY_BASE_DELAY_MS * 2 ** safeExponent,
    RETRY_MAX_DELAY_MS,
  );
}

export function databaseFile(): string {
  return path.join(dataDirectory(), "sana.db");
}

function existingRegularArtifact(file: string): boolean {
  try {
    const stats = fs.lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Database artifact is a link or non-regular file: ${file}`);
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export type SyncPhase =
  | "idle" // never synced
  | "listing" // fetching the meeting list
  | "downloading" // downloading transcripts
  | "synced" // fully caught up
  | "needs_login" // session expired / not logged in
  | "error";

export interface MeetingRow {
  id: string;
  external_id: string | null;
  name: string;
  source: string;
  created_at_ms: number;
  modified_at_ms: number | null;
  first_seen_ms: number;
  processing_phase: string | null; // "done" when Sana has finished processing
}

export const MAX_MEETING_LIST_LIMIT = 1000;

export interface TranscriptRow {
  meeting_id: string;
  text: string;
  json: string;
  word_count: number;
  segment_count: number;
  fetched_ms: number;
}

export interface SyncState {
  phase: SyncPhase;
  message: string;
  meetings_total: number;
  transcripts_done: number;
  transcripts_total: number;
  last_full_sync_ms: number | null;
  last_incremental_ms: number | null;
  daemon_pid: number | null;
  daemon_heartbeat_ms: number | null;
  daemon_instance_id: string | null;
  // 1 while a login-triggered catch-up sync is running; data tools are blocked
  // until it clears. Set on login, cleared by the daemon once fully caught up.
  blocking: number;
  // Legacy pre-generation catch-up marker retained only in the pre-1.0 schema.
  // Ordering and cache release use catchup_generation, never wall-clock time.
  catchup_epoch_ms: number | null;
  // 1 between cache isolation and confirmed session persistence. A sync cycle
  // must never unblock cache reads while this transition is incomplete.
  auth_pending: number;
  // Process holding the short begin -> session publish -> confirm boundary.
  // Null while no publication is active, including persistence-unknown states.
  auth_transition_pid: number | null;
  auth_generation: number;
  auth_publication_token: string | null;
  auth_user_id: string | null;
  auth_workspace_id: string | null;
  auth_transition_token: string | null;
  auth_transition_generation: number | null;
  auth_transition_kind: PersistedAuthPublicationKind | null;
  auth_transition_user_id: string | null;
  auth_transition_workspace_id: string | null;
  auth_issue_code: string | null;
  auth_issue_message: string | null;
  auth_issue_operation_token: string | null;
  auth_issue_generation: number | null;
  auth_issue_kind: PersistedAuthPublicationKind | null;
  catchup_generation: number | null;
  cache_user_id: string | null;
  cache_workspace_id: string | null;
  sync_issue_code: string | null;
  sync_issue_cause: string | null;
  sync_issue_message: string | null;
  error: string | null;
  updated_ms: number;
}

export type PersistedAuthIssue =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "issue"; code: string; message: string }>
  | Readonly<{
      kind: "malformed";
      code: "AUTH_STATE_MALFORMED";
      message: string;
    }>;

/**
 * Interpret the persisted authentication issue as one authoritative tuple.
 * A missing half is corrupt state, never permission to invent the other half.
 */
export function inspectPersistedAuthIssue(
  state: Pick<SyncState, "auth_issue_code" | "auth_issue_message">,
): PersistedAuthIssue {
  const { auth_issue_code: code, auth_issue_message: message } = state;
  if (code === null && message === null) return { kind: "none" };
  if (
    code === null ||
    message === null ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ||
    message.trim() === "" ||
    message.length > 1_000
  ) {
    return {
      kind: "malformed",
      code: "AUTH_STATE_MALFORMED",
      message: "Persisted authentication issue tuple is malformed",
    };
  }
  return { kind: "issue", code, message };
}

export type DaemonLeaseClaim =
  | Readonly<{
      kind: "acquired";
      replacedPid: number | null;
      instanceId: string;
    }>
  | Readonly<{
      kind: "busy";
      ownerPid: number;
      ownerHeartbeat: "recent" | "stale";
    }>;

export type AuthPublicationKind =
  | "request-code"
  | "login"
  | "refresh";
type PersistedAuthPublicationKind = AuthPublicationKind | "reset";

export interface SessionVersion {
  readonly generation: number;
  readonly publicationToken: string | null;
  readonly userId?: string | null;
  readonly workspaceId?: string | null;
}

export interface AuthPublicationIntent {
  readonly operationToken: string;
  readonly targetGeneration: number;
  readonly ownerPid: number;
  readonly kind: AuthPublicationKind;
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly sourceGeneration: number;
  readonly sourcePublicationToken: string | null;
  readonly sourceUserId: string | null;
  readonly sourceWorkspaceId: string | null;
}

export interface SyncCycleIdentity {
  readonly generation: number;
  readonly publicationToken: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface ConfirmedAuthTuple {
  readonly generation: number;
  readonly publicationToken: string;
  readonly userId: string | null;
  readonly workspaceId: string | null;
}

export type CacheOperationGuard = ConfirmedAuthTuple & {
  readonly userId: string;
  readonly workspaceId: string;
};

export class CacheOperationChangedError extends Error {
  readonly code = "CACHE_OPERATION_CHANGED";

  constructor() {
    super(
      "Authentication or active cache identity changed during the operation",
    );
    this.name = "CacheOperationChangedError";
  }
}

export class SyncGenerationChangedError extends Error {
  readonly code = "SYNC_GENERATION_CHANGED";

  constructor() {
    super(
      "Authentication changed while the sync cycle was running; stale writes were rejected",
    );
    this.name = "SyncGenerationChangedError";
  }
}

export type AuthPublicationClaim =
  | Readonly<{ kind: "acquired"; intent: AuthPublicationIntent }>
  | Readonly<{ kind: "busy"; ownerPid: number }>
  | Readonly<{ kind: "stale"; currentGeneration: number }>
  | Readonly<{ kind: "incomplete"; code: string; message: string }>;

export class SanaStore {
  readonly db: Database;
  readonly file: string;

  constructor(file?: string) {
    const usingDefaultFile = file === undefined;
    this.file = path.resolve(file ?? databaseFile());
    if (usingDefaultFile) ensureDataDir();
    else ensureSecureDirectory(path.dirname(this.file));

    const artifacts = [this.file, `${this.file}-wal`, `${this.file}-shm`];
    for (const artifact of artifacts) {
      if (existingRegularArtifact(artifact)) {
        repairSensitiveFilePermissions(artifact);
      }
    }
    if (!existingRegularArtifact(this.file)) {
      const descriptor = openSensitiveFile(this.file, "wx");
      fs.closeSync(descriptor);
    }

    let opened: Database | undefined;
    try {
      opened = new Database(this.file, { strict: true });
      this.db = opened;
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.migrate();
      for (const artifact of artifacts) {
        if (existingRegularArtifact(artifact)) {
          repairSensitiveFilePermissions(artifact);
        }
      }
    } catch (error) {
      const errors: unknown[] = [error];
      if (opened) {
        try {
          opened.close();
        } catch (closeError) {
          errors.push(closeError);
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Database construction and cleanup failed");
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        external_id TEXT,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        modified_at_ms INTEGER,
        first_seen_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS transcripts (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        json TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        segment_count INTEGER NOT NULL,
        fetched_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meeting_metadata (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        summary TEXT,
        summary_short TEXT,
        notes_json TEXT,
        participants_json TEXT,
        fetched_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fetch_failures (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_ms INTEGER
      );

      -- Marks meetings whose transcript lines have been embedded for semantic
      -- search (the vectors live in a sqlite-vec table created lazily elsewhere).
      CREATE TABLE IF NOT EXISTS line_embeddings (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        dim INTEGER NOT NULL,
        model TEXT NOT NULL,
        done_ms INTEGER NOT NULL
      );

      -- Full-text index over transcript lines (one row per spoken turn) for
      -- BM25-ranked keyword search. meeting_id/line_no are stored but not indexed.
      CREATE VIRTUAL TABLE IF NOT EXISTS line_fts USING fts5(
        text,
        meeting_id UNINDEXED,
        line_no UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS line_fts_state (
        meeting_id TEXT PRIMARY KEY REFERENCES transcripts(meeting_id) ON DELETE CASCADE,
        transcript_fetched_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        phase TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        meetings_total INTEGER NOT NULL DEFAULT 0,
        transcripts_done INTEGER NOT NULL DEFAULT 0,
        transcripts_total INTEGER NOT NULL DEFAULT 0,
        last_full_sync_ms INTEGER,
        last_incremental_ms INTEGER,
        daemon_pid INTEGER,
        daemon_heartbeat_ms INTEGER,
        daemon_instance_id TEXT,
        blocking INTEGER NOT NULL DEFAULT 1,
        catchup_epoch_ms INTEGER,
        auth_pending INTEGER NOT NULL DEFAULT 0,
        auth_transition_pid INTEGER,
        auth_generation INTEGER NOT NULL DEFAULT 0,
        auth_publication_token TEXT,
        auth_user_id TEXT,
        auth_workspace_id TEXT,
        auth_transition_token TEXT,
        auth_transition_generation INTEGER,
        auth_transition_kind TEXT,
        auth_transition_user_id TEXT,
        auth_transition_workspace_id TEXT,
        auth_issue_code TEXT,
        auth_issue_message TEXT,
        auth_issue_operation_token TEXT,
        auth_issue_generation INTEGER,
        auth_issue_kind TEXT,
        catchup_generation INTEGER,
        cache_user_id TEXT,
        cache_workspace_id TEXT,
        sync_issue_code TEXT,
        sync_issue_cause TEXT,
        sync_issue_message TEXT,
        error TEXT,
        updated_ms INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO sync_state (id, phase, updated_ms)
        VALUES (1, 'idle', 0);
    `);
    // --- lightweight column migrations for older DBs ---
    const hasCol = (table: string, col: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
        (c) => c.name === col
      );
    if (!hasCol("sync_state", "blocking"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1`);
    if (!hasCol("sync_state", "daemon_instance_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN daemon_instance_id TEXT`);
    if (!hasCol("sync_state", "catchup_epoch_ms"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN catchup_epoch_ms INTEGER`);
    if (!hasCol("sync_state", "auth_pending"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_pending INTEGER NOT NULL DEFAULT 0`);
    if (!hasCol("sync_state", "auth_transition_pid"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_pid INTEGER`);
    if (!hasCol("sync_state", "auth_generation"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT 0`);
    if (!hasCol("sync_state", "auth_publication_token"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_publication_token TEXT`);
    if (!hasCol("sync_state", "auth_user_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_user_id TEXT`);
    if (!hasCol("sync_state", "auth_workspace_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_workspace_id TEXT`);
    if (!hasCol("sync_state", "auth_transition_token"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_token TEXT`);
    if (!hasCol("sync_state", "auth_transition_generation"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_generation INTEGER`);
    if (!hasCol("sync_state", "auth_transition_kind"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_kind TEXT`);
    if (!hasCol("sync_state", "auth_transition_user_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_user_id TEXT`);
    if (!hasCol("sync_state", "auth_transition_workspace_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_transition_workspace_id TEXT`);
    if (!hasCol("sync_state", "auth_issue_code"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_issue_code TEXT`);
    if (!hasCol("sync_state", "auth_issue_message"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_issue_message TEXT`);
    if (!hasCol("sync_state", "auth_issue_operation_token"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_issue_operation_token TEXT`);
    if (!hasCol("sync_state", "auth_issue_generation"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_issue_generation INTEGER`);
    if (!hasCol("sync_state", "auth_issue_kind"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN auth_issue_kind TEXT`);
    if (!hasCol("sync_state", "catchup_generation"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN catchup_generation INTEGER`);
    if (!hasCol("sync_state", "cache_user_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN cache_user_id TEXT`);
    if (!hasCol("sync_state", "cache_workspace_id"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN cache_workspace_id TEXT`);
    if (!hasCol("sync_state", "sync_issue_code"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN sync_issue_code TEXT`);
    if (!hasCol("sync_state", "sync_issue_cause"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN sync_issue_cause TEXT`);
    if (!hasCol("sync_state", "sync_issue_message"))
      this.db.exec(`ALTER TABLE sync_state ADD COLUMN sync_issue_message TEXT`);
    if (!hasCol("meetings", "processing_phase"))
      this.db.exec(`ALTER TABLE meetings ADD COLUMN processing_phase TEXT`);
    if (!hasCol("meeting_metadata", "has_recording"))
      this.db.exec(`ALTER TABLE meeting_metadata ADD COLUMN has_recording INTEGER NOT NULL DEFAULT 0`);
  }

  // ---- meetings ----------------------------------------------------------

  upsertMeeting(m: {
    id: string;
    external_id?: string | null;
    name: string;
    source: string;
    created_at_ms: number;
    modified_at_ms?: number | null;
    processing_phase?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO meetings (id, external_id, name, source, created_at_ms, modified_at_ms, first_seen_ms, processing_phase)
         VALUES (@id, @external_id, @name, @source, @created_at_ms, @modified_at_ms, @first_seen_ms, @processing_phase)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           external_id = excluded.external_id,
           modified_at_ms = excluded.modified_at_ms,
           processing_phase = excluded.processing_phase`
      )
      .run({
        id: m.id,
        external_id: m.external_id ?? null,
        name: m.name,
        source: m.source,
        created_at_ms: m.created_at_ms,
        modified_at_ms: m.modified_at_ms ?? null,
        first_seen_ms: Date.now(),
        processing_phase: m.processing_phase ?? null,
      });
  }

  getMeeting(id: string): MeetingRow | null {
    return this.db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
      | MeetingRow
      | null;
  }

  /** Build a WHERE clause + params for the meeting filters. */
  private meetingFilter(opts: MeetingListOpts): {
    where: string;
    params: Bindings;
  } {
    const clauses: string[] = [];
    const params: Bindings = {};
    if (opts.query) {
      clauses.push("m.name LIKE @like");
      params.like = `%${opts.query}%`;
    }
    if (opts.dateFrom != null) {
      clauses.push("m.created_at_ms >= @dateFrom");
      params.dateFrom = opts.dateFrom;
    }
    if (opts.dateTo != null) {
      clauses.push("m.created_at_ms <= @dateTo");
      params.dateTo = opts.dateTo;
    }
    if (opts.status === "ready") {
      clauses.push("t.meeting_id IS NOT NULL AND mm.meeting_id IS NOT NULL");
    } else if (opts.status === "processing") {
      clauses.push(
        "(t.meeting_id IS NULL OR mm.meeting_id IS NULL) " +
          "AND m.processing_phase IS NOT NULL AND m.processing_phase <> 'done'",
      );
    } else if (opts.status === "retrying") {
      clauses.push(
        "(t.meeting_id IS NULL OR mm.meeting_id IS NULL) " +
          "AND (m.processing_phase IS NULL OR m.processing_phase = 'done') " +
          "AND COALESCE(ff.attempts, 0) > 0",
      );
    } else if (opts.status === "downloading") {
      clauses.push(
        "(t.meeting_id IS NULL OR mm.meeting_id IS NULL) " +
          "AND (m.processing_phase IS NULL OR m.processing_phase = 'done') " +
          "AND COALESCE(ff.attempts, 0) = 0",
      );
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listMeetings(opts: MeetingListOpts = {}): MeetingListRow[] {
    const limit = Math.min(
      Math.max(opts.limit ?? 50, 1),
      MAX_MEETING_LIST_LIMIT,
    );
    const offset = Math.max(opts.offset ?? 0, 0);
    const order = opts.sort === "oldest" ? "ASC" : "DESC";
    const { where, params } = this.meetingFilter(opts);
    return this.db
      .prepare(
         `SELECT m.*, (t.meeting_id IS NOT NULL) AS has_transcript,
                (mm.meeting_id IS NOT NULL) AS has_metadata, t.word_count,
                 COALESCE(ff.attempts, 0) AS attempts,
                 ff.last_error, ff.last_attempt_ms
         FROM meetings m
         LEFT JOIN transcripts t ON t.meeting_id = m.id
         LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
         LEFT JOIN fetch_failures ff ON ff.meeting_id = m.id
         ${where}
         ORDER BY m.created_at_ms ${order}
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset }) as MeetingListRow[];
  }

  countMeetings(opts: MeetingListOpts = {}): number {
    const { where, params } = this.meetingFilter(opts);
    const row = this.db
      .prepare(
         `SELECT COUNT(*) n FROM meetings m
         LEFT JOIN transcripts t ON t.meeting_id = m.id
         LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
         LEFT JOIN fetch_failures ff ON ff.meeting_id = m.id
         ${where}`
      )
      .get(params) as { n: number };
    return row.n;
  }

  /** Source-ready incomplete meetings whose retry delay has elapsed. */
  meetingsDue(now: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.created_at_ms, m.first_seen_ms,
                ff.meeting_id AS failure_id,
                COALESCE(ff.attempts, 0) AS attempts, ff.last_attempt_ms
         FROM meetings m
         LEFT JOIN transcripts t ON t.meeting_id = m.id
         LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
         LEFT JOIN fetch_failures ff ON ff.meeting_id = m.id
         WHERE (t.meeting_id IS NULL OR mm.meeting_id IS NULL)
           AND (m.processing_phase IS NULL OR m.processing_phase = 'done')`,
      )
      .all() as Array<{
      id: string;
      created_at_ms: number;
      first_seen_ms: number;
      failure_id: string | null;
      attempts: number;
      last_attempt_ms: number | null;
    }>;
    return rows
      .filter(
        (row) =>
          row.failure_id === null ||
          (row.last_attempt_ms !== null &&
            row.last_attempt_ms <= now - retryDelayMs(row.attempts)),
      )
      .sort((left, right) => {
        const leftDue =
          left.last_attempt_ms === null
            ? left.first_seen_ms
            : left.last_attempt_ms + retryDelayMs(left.attempts);
        const rightDue =
          right.last_attempt_ms === null
            ? right.first_seen_ms
            : right.last_attempt_ms + retryDelayMs(right.attempts);
        return (
          leftDue - rightDue ||
          left.created_at_ms - right.created_at_ms ||
          left.id.localeCompare(right.id)
        );
      })
      .map((row) => row.id);
  }

  /** All meetings missing a transcript or metadata, regardless of readiness. */
  countIncomplete(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM meetings m
           LEFT JOIN transcripts t ON t.meeting_id = m.id
           LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
           WHERE t.meeting_id IS NULL OR mm.meeting_id IS NULL`,
        )
        .get() as { n: number }
    ).n;
  }

  /** Source-ready incomplete meetings currently carrying retry history. */
  countRetrying(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM meetings m
           LEFT JOIN transcripts t ON t.meeting_id = m.id
           LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
           JOIN fetch_failures ff ON ff.meeting_id = m.id
           WHERE (t.meeting_id IS NULL OR mm.meeting_id IS NULL)
             AND (m.processing_phase IS NULL OR m.processing_phase = 'done')
             AND ff.attempts > 0`,
        )
        .get() as { n: number }
    ).n;
  }

  /** Meetings that have both a transcript and metadata. */
  countComplete(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n FROM meetings m
           JOIN transcripts t ON t.meeting_id = m.id
           JOIN meeting_metadata mm ON mm.meeting_id = m.id`
        )
        .get() as { n: number }
    ).n;
  }

  // ---- transcripts -------------------------------------------------------

  saveTranscript(row: Omit<TranscriptRow, "fetched_ms">): void {
    const fetchedMs = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transcripts (meeting_id, text, json, word_count, segment_count, fetched_ms)
           VALUES (@meeting_id, @text, @json, @word_count, @segment_count, @fetched_ms)
           ON CONFLICT(meeting_id) DO UPDATE SET
             text = excluded.text, json = excluded.json,
             word_count = excluded.word_count, segment_count = excluded.segment_count,
             fetched_ms = excluded.fetched_ms`
        )
        .run({ ...row, fetched_ms: fetchedMs });
      this.indexLines(row.meeting_id, row.json);
      this.markSearchIndexed(row.meeting_id, fetchedMs);
      // Transcript changed -> its embeddings are stale; force a re-embed.
      this.db.prepare(`DELETE FROM line_embeddings WHERE meeting_id = ?`).run(row.meeting_id);
    });
    tx();
  }

  /** Meetings that have a transcript but have not been embedded yet. */
  meetingsMissingEmbedding(): string[] {
    return (
      this.db
        .prepare(
          `SELECT t.meeting_id AS id FROM transcripts t
           LEFT JOIN line_embeddings e ON e.meeting_id = t.meeting_id
           JOIN meetings m ON m.id = t.meeting_id
           WHERE e.meeting_id IS NULL
           ORDER BY m.created_at_ms DESC`
         )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  markEmbedded(meetingId: string, dim: number, model: string): void {
    this.db
      .prepare(
        `INSERT INTO line_embeddings (meeting_id, dim, model, done_ms)
         VALUES (@id, @dim, @model, @ts)
         ON CONFLICT(meeting_id) DO UPDATE SET dim=@dim, model=@model, done_ms=@ts`
      )
      .run({ id: meetingId, dim, model, ts: Date.now() });
  }

  countEmbedded(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM line_embeddings`).get() as { n: number }).n;
  }

  /** (Re)index one meeting's transcript lines into the FTS table. */
  private indexLines(meetingId: string, json: string): void {
    this.db.prepare(`DELETE FROM line_fts WHERE meeting_id = ?`).run(meetingId);
    let lines: { n: number; text: string }[] = [];
    try {
      lines = transcriptLines(JSON.parse(json));
    } catch {
      return;
    }
    const ins = this.db.prepare(`INSERT INTO line_fts (text, meeting_id, line_no) VALUES (?, ?, ?)`);
    for (const l of lines) ins.run(l.text, meetingId, l.n);
  }

  private markSearchIndexed(meetingId: string, fetchedMs: number): void {
    this.db
      .prepare(
        `INSERT INTO line_fts_state (meeting_id, transcript_fetched_ms)
         VALUES (?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           transcript_fetched_ms = excluded.transcript_fetched_ms`,
      )
      .run(meetingId, fetchedMs);
  }

  getTranscript(meetingId: string): TranscriptRow | null {
    return this.db
      .prepare(`SELECT * FROM transcripts WHERE meeting_id = ?`)
      .get(meetingId) as TranscriptRow | null;
  }

  countTranscripts(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM transcripts`).get() as { n: number }).n;
  }

  // ---- per-meeting metadata (summary, notes, participants) ---------------

  saveMetadata(row: {
    meeting_id: string;
    summary: string | null;
    summary_short: string | null;
    notes_json: string | null;
    participants_json: string | null;
    has_recording: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO meeting_metadata (meeting_id, summary, summary_short, notes_json, participants_json, has_recording, fetched_ms)
         VALUES (@meeting_id, @summary, @summary_short, @notes_json, @participants_json, @has_recording, @fetched_ms)
         ON CONFLICT(meeting_id) DO UPDATE SET
           summary=excluded.summary, summary_short=excluded.summary_short,
           notes_json=excluded.notes_json, participants_json=excluded.participants_json,
           has_recording=excluded.has_recording, fetched_ms=excluded.fetched_ms`
      )
      .run({ ...row, fetched_ms: Date.now() });
  }

  getMetadata(meetingId: string):
    | {
        summary: string | null;
        summary_short: string | null;
        notes_json: string | null;
        participants_json: string | null;
        has_recording: number;
      }
    | null {
    return this.db
      .prepare(
        `SELECT summary, summary_short, notes_json, participants_json, has_recording FROM meeting_metadata WHERE meeting_id = ?`
      )
      .get(meetingId) as
      | {
          summary: string | null;
          summary_short: string | null;
          notes_json: string | null;
          participants_json: string | null;
          has_recording: number;
        }
      | null;
  }

  // ---- transcript fetch failures -----------------------------------------

  recordFailure(meetingId: string, error: string): void {
    this.db
      .prepare(
        `INSERT INTO fetch_failures (meeting_id, attempts, last_error, last_attempt_ms)
         VALUES (@id, 1, @err, @ts)
         ON CONFLICT(meeting_id) DO UPDATE SET
           attempts = attempts + 1, last_error = @err, last_attempt_ms = @ts`
      )
      .run({ id: meetingId, err: error.slice(0, 500), ts: Date.now() });
  }

  clearFailure(meetingId: string): void {
    this.db.prepare(`DELETE FROM fetch_failures WHERE meeting_id = ?`).run(meetingId);
  }

  /** Reset retry history so incomplete items are immediately eligible. */
  resetFailures(): void {
    this.db.prepare(`DELETE FROM fetch_failures`).run();
  }

  private searchIndexReady = false;

  /** Backfill transcripts that predate or are missing from the FTS index. */
  private ensureSearchIndex(): void {
    if (this.searchIndexReady) return;
    const repairs = this.db
      .prepare(
        `SELECT t.meeting_id, t.json, t.fetched_ms
         FROM transcripts t
         LEFT JOIN line_fts_state s ON s.meeting_id = t.meeting_id
         WHERE s.meeting_id IS NULL
            OR s.transcript_fetched_ms <> t.fetched_ms`,
      )
      .all() as Array<{
        meeting_id: string;
        json: string;
        fetched_ms: number;
      }>;
    if (repairs.length > 0) {
      const tx = this.db.transaction(() => {
        for (const repair of repairs) {
          this.indexLines(repair.meeting_id, repair.json);
          this.markSearchIndexed(repair.meeting_id, repair.fetched_ms);
        }
      });
      tx();
    }
    this.searchIndexReady = true;
  }

  /**
   * BM25-ranked full-text search over transcript lines. `match` is an FTS5
   * MATCH expression (built by the caller from sanitized terms).
   */
  private searchWhere(
    match: string,
    dateFrom?: number,
    dateTo?: number
  ): { where: string; params: Bindings } {
    const clauses = ["line_fts MATCH @match"];
    const params: Bindings = { match };
    if (dateFrom != null) {
      clauses.push("m.created_at_ms >= @dateFrom");
      params.dateFrom = dateFrom;
    }
    if (dateTo != null) {
      clauses.push("m.created_at_ms <= @dateTo");
      params.dateTo = dateTo;
    }
    return { where: clauses.join(" AND "), params };
  }

  countLineMatches(match: string, opts: { dateFrom?: number; dateTo?: number } = {}): number {
    this.ensureSearchIndex();
    const { where, params } = this.searchWhere(match, opts.dateFrom, opts.dateTo);
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM line_fts f JOIN meetings m ON m.id = f.meeting_id WHERE ${where}`
        )
        .get(params) as { c: number }
    ).c;
  }

  searchLines(
    match: string,
    opts: {
      limit?: number;
      offset?: number;
      sort?: "best" | "newest" | "oldest";
      dateFrom?: number;
      dateTo?: number;
    } = {}
  ): { meeting_id: string; line_no: number; text: string; created_at_ms: number; name: string }[] {
    this.ensureSearchIndex();
    const lim = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const off = Math.max(opts.offset ?? 0, 0);
    const { where, params } = this.searchWhere(match, opts.dateFrom, opts.dateTo);
    const order =
      opts.sort === "newest"
        ? "m.created_at_ms DESC"
        : opts.sort === "oldest"
          ? "m.created_at_ms ASC"
          : "bm25(line_fts) ASC"; // best (most relevant) first
    return this.db
      .prepare(
        `SELECT f.meeting_id AS meeting_id, CAST(f.line_no AS INTEGER) AS line_no, f.text AS text,
                m.created_at_ms AS created_at_ms, m.name AS name
         FROM line_fts f JOIN meetings m ON m.id = f.meeting_id
         WHERE ${where}
         ORDER BY ${order}
         LIMIT @lim OFFSET @off`
      )
      .all({ ...params, lim, off }) as {
      meeting_id: string;
      line_no: number;
      text: string;
      created_at_ms: number;
      name: string;
    }[];
  }

  // ---- sync state --------------------------------------------------------

  getSyncState(): SyncState {
    return this.db.prepare(`SELECT * FROM sync_state WHERE id = 1`).get() as SyncState;
  }

  private static readonly SYNC_COLS = [
    "phase", "message", "meetings_total", "transcripts_done", "transcripts_total",
    "last_full_sync_ms", "last_incremental_ms", "daemon_pid", "daemon_heartbeat_ms",
    "daemon_instance_id",
    "blocking", "catchup_epoch_ms", "auth_pending", "auth_transition_pid",
    "auth_generation", "auth_publication_token", "auth_user_id",
    "auth_workspace_id", "auth_transition_token",
    "auth_transition_generation", "auth_transition_kind",
    "auth_transition_user_id", "auth_transition_workspace_id",
    "auth_issue_code", "auth_issue_message", "auth_issue_operation_token",
    "auth_issue_generation", "auth_issue_kind", "catchup_generation",
    "cache_user_id", "cache_workspace_id", "sync_issue_code",
    "sync_issue_cause", "sync_issue_message", "error",
  ] as const;

  updateSyncState(patch: Partial<Omit<SyncState, "updated_ms">>): void {
    const sets: string[] = ["updated_ms = @updated_ms"];
    const params: Bindings = { updated_ms: Date.now() };
    for (const col of SanaStore.SYNC_COLS) {
      if (col in patch) {
        sets.push(`${col} = @${col}`);
        params[col] = (patch as Record<string, unknown>)[col] as Bindings[string];
      }
    }
    this.db.prepare(`UPDATE sync_state SET ${sets.join(", ")} WHERE id = 1`).run(params);
  }

  /**
   * Serialize daemon ownership in SQLite. A recent live owner wins; a missing,
   * dead, or same-process owner is replaced while the write lock is held.
   * A live owner with a stale heartbeat remains observable for manual recovery.
   */
  claimDaemonLease(
    candidatePid: number,
    candidateInstanceId: string,
    now: number,
    staleAfterMs: number,
    ownerAlive: (pid: number) => boolean,
  ): DaemonLeaseClaim {
    assertPositiveSafeInteger(candidatePid, "candidatePid");
    if (!isUuid(candidateInstanceId)) {
      throw new TypeError("candidateInstanceId must be a UUID");
    }
    assertNonNegativeSafeInteger(now, "now");
    assertPositiveSafeInteger(staleAfterMs, "staleAfterMs");

    return this.immediateTransaction(() => {
      const current = this.getSyncState();
      const ownerPid = current.daemon_pid;
      const heartbeat = current.daemon_heartbeat_ms;
      const recent =
        heartbeat !== null && now - heartbeat <= staleAfterMs;

      if (
        ownerPid !== null &&
        ownerPid !== candidatePid &&
        ownerAlive(ownerPid)
      ) {
        return {
          kind: "busy",
          ownerPid,
          ownerHeartbeat: recent ? "recent" : "stale",
        };
      }

      this.db
        .prepare(
          `UPDATE sync_state
           SET daemon_pid = @candidate_pid,
               daemon_heartbeat_ms = @heartbeat_ms,
               daemon_instance_id = @candidate_instance_id,
               updated_ms = @updated_ms
           WHERE id = 1`,
        )
        .run({
          candidate_pid: candidatePid,
          candidate_instance_id: candidateInstanceId,
          heartbeat_ms: now,
          updated_ms: now,
        });
      return {
        kind: "acquired",
        replacedPid: ownerPid,
        instanceId: candidateInstanceId,
      };
    });
  }

  renewDaemonLease(
    expectedPid: number,
    expectedInstanceId: string,
    now: number,
  ): "renewed" | "not-owner" {
    assertPositiveSafeInteger(expectedPid, "expectedPid");
    if (!isUuid(expectedInstanceId)) {
      throw new TypeError("expectedInstanceId must be a UUID");
    }
    assertNonNegativeSafeInteger(now, "now");
    const result = this.db
      .prepare(
        `UPDATE sync_state
         SET daemon_heartbeat_ms = @heartbeat_ms, updated_ms = @updated_ms
         WHERE id = 1
           AND daemon_pid = @expected_pid
           AND daemon_instance_id = @expected_instance_id`,
      )
      .run({
        heartbeat_ms: now,
        updated_ms: now,
        expected_pid: expectedPid,
        expected_instance_id: expectedInstanceId,
      });
    return result.changes === 1 ? "renewed" : "not-owner";
  }

  /**
   * Clear daemon identity only while it still belongs to the expected process.
   * The predicate and update are one SQLite operation so a successor cannot be
   * cleared by its predecessor.
   */
  clearDaemonIdentityIfOwned(
    expectedPid: number,
    expectedInstanceId: string,
  ): "cleared" | "not-owner" {
    assertPositiveSafeInteger(expectedPid, "expectedPid");
    if (!isUuid(expectedInstanceId)) {
      throw new TypeError("expectedInstanceId must be a UUID");
    }
    const result = this.db
      .prepare(
        `UPDATE sync_state
         SET daemon_pid = NULL,
             daemon_heartbeat_ms = NULL,
             daemon_instance_id = NULL,
             updated_ms = @updated_ms
         WHERE id = 1
           AND daemon_pid = @expected_pid
           AND daemon_instance_id = @expected_instance_id`,
      )
      .run({
        updated_ms: Date.now(),
        expected_pid: expectedPid,
        expected_instance_id: expectedInstanceId,
      });
    return result.changes === 1 ? "cleared" : "not-owner";
  }

  markNeedsLoginIfCurrent(
    observed: SessionVersion,
    message: string,
  ): "marked" | "stale" {
    validateSessionVersion(observed);
    if (message.trim() === "") {
      throw new TypeError("Needs-login message must not be empty");
    }
    return this.immediateTransaction(() => {
      const state = this.getSyncState();
      if (
        authStateInvariantIssue(state) !== null ||
        state.auth_transition_token !== null ||
        !confirmedTupleMatches(state, observed)
      ) {
        return "stale";
      }
      this.db
        .prepare(
          `UPDATE sync_state
           SET phase = 'needs_login',
               message = @message,
               error = NULL,
               updated_ms = @updated_ms
           WHERE id = 1`,
        )
        .run({ message, updated_ms: Date.now() });
      return "marked";
    });
  }

  claimAuthPublication(
    source: SessionVersion,
    target: Readonly<{ userId: string | null; workspaceId: string | null }>,
    publicationKind: AuthPublicationKind,
    operationToken: string,
    candidatePid: number,
    ownerAlive: (pid: number) => boolean,
  ): AuthPublicationClaim {
    validateSessionVersion(source);
    validatePublicationIdentity(target, publicationKind);
    validateOperationToken(operationToken);
    assertPositiveSafeInteger(candidatePid, "candidatePid");
    return this.immediateTransaction(() => {
      let current = this.getSyncState();
      const invariantIssue = authStateInvariantIssue(current);
      if (invariantIssue !== null) {
        this.persistAuthIssue(
          "AUTH_STATE_MALFORMED",
          invariantIssue,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_STATE_MALFORMED",
          message: invariantIssue,
        };
      }
      if (current.auth_transition_token !== null) {
        if (
          current.auth_transition_pid !== null &&
          ownerAlive(current.auth_transition_pid)
        ) {
          return {
            kind: "busy",
            ownerPid: current.auth_transition_pid,
          };
        }
        const recovery = interruptedPublicationRecovery(current, source);
        if (recovery === "target") {
          // Recovery is allowed only after the recorded owner is absent/dead.
          // A live publisher is the only actor allowed to explicitly confirm.
          this.confirmAuthPublicationRow(current, Date.now());
          current = this.getSyncState();
        } else if (
          recovery === "source" &&
          current.auth_transition_kind === "request-code"
        ) {
          this.abortRequestCodePublicationRow(current, Date.now());
          current = this.getSyncState();
        } else if (recovery === "source") {
          const abandonedLogin = current.auth_transition_kind === "login";
          this.db
            .prepare(
              `UPDATE sync_state
               SET auth_transition_pid = NULL,
                   auth_transition_token = NULL,
                   auth_transition_generation = NULL,
                   auth_transition_kind = NULL,
                   auth_transition_user_id = NULL,
                   auth_transition_workspace_id = NULL,
                   blocking = CASE WHEN @abandoned_login = 1 THEN 1 ELSE blocking END,
                   auth_pending = CASE WHEN @abandoned_login = 1 THEN 1 ELSE auth_pending END,
                   auth_issue_code = CASE
                     WHEN @abandoned_login = 1 THEN 'AUTH_PUBLICATION_ABORTED'
                     ELSE auth_issue_code END,
                   auth_issue_message = CASE
                     WHEN @abandoned_login = 1
                     THEN 'A login session publication stopped before persistence; sign in again.'
                     ELSE auth_issue_message END,
                   auth_issue_operation_token = CASE
                     WHEN @abandoned_login = 1 THEN @issue_token
                     ELSE auth_issue_operation_token END,
                   auth_issue_generation = CASE
                     WHEN @abandoned_login = 1 THEN @issue_generation
                     ELSE auth_issue_generation END,
                   auth_issue_kind = CASE
                     WHEN @abandoned_login = 1 THEN @issue_kind
                     ELSE auth_issue_kind END,
                   updated_ms = @updated_ms
               WHERE id = 1`,
            )
            .run({
              abandoned_login: abandonedLogin ? 1 : 0,
              issue_token: current.auth_transition_token,
              issue_generation: current.auth_transition_generation,
              issue_kind: current.auth_transition_kind,
              updated_ms: Date.now(),
            });
          current = this.getSyncState();
        } else {
          const message =
            "Persisted session identity does not match either the confirmed or pending publication";
          this.persistAuthIssue(
            "AUTH_PUBLICATION_INCOMPLETE",
            message,
            Date.now(),
          );
          return {
            kind: "incomplete",
            code: "AUTH_PUBLICATION_INCOMPLETE",
            message,
          };
        }
      }

      if (
        publicationKind === "request-code" &&
        current.auth_issue_code !== null
      ) {
        return {
          kind: "incomplete",
          code: current.auth_issue_code,
          message:
            current.auth_issue_message ??
            "Authentication transition is incomplete",
        };
      }
      if (
        source.generation < current.auth_generation
      ) {
        return {
          kind: "stale",
          currentGeneration: current.auth_generation,
        };
      }
      if (
        !confirmedTupleMatches(current, source)
      ) {
        const message =
          "Persisted session identity does not match the confirmed authentication generation";
        this.persistAuthIssue(
          "AUTH_GENERATION_MISMATCH",
          message,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_GENERATION_MISMATCH",
          message,
        };
      }
      if (
        publicationKind === "request-code" &&
        (target.userId !== current.auth_user_id ||
          target.workspaceId !== current.auth_workspace_id)
      ) {
        const message =
          "A code request cannot establish or change the authenticated identity";
        this.persistAuthIssue(
          "AUTH_IDENTITY_UNVALIDATED",
          message,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_IDENTITY_UNVALIDATED",
          message,
        };
      }
      if (
        publicationKind === "refresh" &&
        (target.userId !== current.auth_user_id ||
          target.workspaceId !== current.auth_workspace_id)
      ) {
        const message =
          "A session refresh cannot change the confirmed Sana identity";
        this.persistAuthIssue(
          "AUTH_REFRESH_IDENTITY_MISMATCH",
          message,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_REFRESH_IDENTITY_MISMATCH",
          message,
        };
      }
      if (
        publicationKind === "refresh" &&
        (current.auth_pending === 1 || current.auth_issue_code !== null)
      ) {
        return {
          kind: "incomplete",
          code: current.auth_issue_code ?? "AUTH_TRANSITION_PENDING",
          message:
            current.auth_issue_message ??
            "Authentication must be completed before the session can refresh",
        };
      }
      if (current.auth_generation === Number.MAX_SAFE_INTEGER) {
        throw new Error("Authentication generation sequence is exhausted");
      }
      const targetGeneration = current.auth_generation + 1;
      const login = publicationKind === "login";
      this.db
        .prepare(
          `UPDATE sync_state
           SET blocking = CASE WHEN @login = 1 THEN 1 ELSE blocking END,
               auth_pending = CASE WHEN @login = 1 THEN 1 ELSE auth_pending END,
               catchup_generation = CASE
                 WHEN @login = 1 THEN @target_generation
                 ELSE catchup_generation END,
               auth_transition_pid = @candidate_pid,
               auth_transition_token = @operation_token,
               auth_transition_generation = @target_generation,
               auth_transition_kind = @publication_kind,
               auth_transition_user_id = @transition_user_id,
               auth_transition_workspace_id = @transition_workspace_id,
               auth_issue_code = CASE WHEN @login = 1 THEN NULL ELSE auth_issue_code END,
               auth_issue_message = CASE WHEN @login = 1 THEN NULL ELSE auth_issue_message END,
               auth_issue_operation_token = CASE
                 WHEN @login = 1 THEN NULL ELSE auth_issue_operation_token END,
               auth_issue_generation = CASE
                 WHEN @login = 1 THEN NULL ELSE auth_issue_generation END,
               auth_issue_kind = CASE
                 WHEN @login = 1 THEN NULL ELSE auth_issue_kind END,
               updated_ms = @updated_ms
           WHERE id = 1`,
        )
        .run({
          login: login ? 1 : 0,
          target_generation: targetGeneration,
          candidate_pid: candidatePid,
          operation_token: operationToken,
          publication_kind: publicationKind,
          transition_user_id: target.userId,
          transition_workspace_id: target.workspaceId,
          updated_ms: Date.now(),
        });
      return {
        kind: "acquired",
        intent: {
          operationToken,
          targetGeneration,
          ownerPid: candidatePid,
          kind: publicationKind,
          userId: target.userId,
          workspaceId: target.workspaceId,
          sourceGeneration: source.generation,
          sourcePublicationToken: source.publicationToken,
          sourceUserId: source.userId ?? null,
          sourceWorkspaceId: source.workspaceId ?? null,
        },
      };
    });
  }

  confirmAuthPublication(
    intent: AuthPublicationIntent,
    now: number,
  ): "confirmed" | "not-current" {
    assertNonNegativeSafeInteger(now, "now");
    return this.immediateTransaction(() => {
      const current = this.getSyncState();
      if (authStateInvariantIssue(current) !== null) {
        this.persistAuthIssue(
          "AUTH_STATE_MALFORMED",
          "Persisted authentication state became malformed before publication confirmation",
          now,
        );
        return "not-current";
      }
      if (!authIntentMatches(current, intent)) return "not-current";
      this.confirmAuthPublicationRow(current, now);
      return "confirmed";
    });
  }

  markAuthPublicationIncomplete(
    intent: AuthPublicationIntent,
    code: string,
    message: string,
    now: number,
  ): "released" | "not-current" {
    validateIssue(code, message);
    assertNonNegativeSafeInteger(now, "now");
    if (intent.kind === "request-code") {
      const result = this.db
        .prepare(
          `UPDATE sync_state
           SET auth_transition_pid = NULL,
               updated_ms = @updated_ms
           WHERE id = 1
             AND auth_transition_token = @operation_token
             AND auth_transition_generation = @target_generation
             AND auth_transition_pid = @owner_pid
             AND auth_transition_kind = 'request-code'
             AND auth_transition_user_id IS @transition_user_id
             AND auth_transition_workspace_id IS @transition_workspace_id
             AND auth_generation = @source_generation
             AND auth_publication_token IS @source_publication_token
             AND auth_user_id IS @source_user_id
             AND auth_workspace_id IS @source_workspace_id`,
        )
        .run({
          updated_ms: now,
          operation_token: intent.operationToken,
          target_generation: intent.targetGeneration,
          owner_pid: intent.ownerPid,
          transition_user_id: intent.userId,
          transition_workspace_id: intent.workspaceId,
          source_generation: intent.sourceGeneration,
          source_publication_token: intent.sourcePublicationToken,
          source_user_id: intent.sourceUserId,
          source_workspace_id: intent.sourceWorkspaceId,
        });
      return result.changes === 1 ? "released" : "not-current";
    }
    const result = this.db
      .prepare(
        `UPDATE sync_state
         SET auth_transition_pid = NULL,
             blocking = 1,
             auth_pending = 1,
             auth_issue_code = @issue_code,
             auth_issue_message = @issue_message,
             auth_issue_operation_token = @operation_token,
             auth_issue_generation = @target_generation,
             auth_issue_kind = @publication_kind,
             updated_ms = @updated_ms
         WHERE id = 1
           AND auth_transition_token = @operation_token
           AND auth_transition_generation = @target_generation
           AND auth_transition_pid = @owner_pid
           AND auth_transition_kind = @publication_kind
           AND auth_transition_user_id IS @transition_user_id
           AND auth_transition_workspace_id IS @transition_workspace_id
           AND auth_generation = @source_generation
           AND auth_publication_token IS @source_publication_token
           AND auth_user_id IS @source_user_id
           AND auth_workspace_id IS @source_workspace_id`,
      )
      .run({
        issue_code: code,
        issue_message: message,
        updated_ms: now,
        operation_token: intent.operationToken,
        target_generation: intent.targetGeneration,
        owner_pid: intent.ownerPid,
        publication_kind: intent.kind,
        transition_user_id: intent.userId,
        transition_workspace_id: intent.workspaceId,
        source_generation: intent.sourceGeneration,
        source_publication_token: intent.sourcePublicationToken,
        source_user_id: intent.sourceUserId,
        source_workspace_id: intent.sourceWorkspaceId,
      });
    return result.changes === 1 ? "released" : "not-current";
  }

  reconcileAuthState(
    observed: SessionVersion,
    ownerAlive: (pid: number) => boolean,
  ):
    | Readonly<{ kind: "current"; generation: number }>
    | Readonly<{ kind: "incomplete"; code: string; message: string }> {
    validateSessionVersion(observed);
    return this.immediateTransaction(() => {
      let state = this.getSyncState();
      const invariantIssue = authStateInvariantIssue(state);
      if (invariantIssue !== null) {
        this.persistAuthIssue(
          "AUTH_STATE_MALFORMED",
          invariantIssue,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_STATE_MALFORMED",
          message: invariantIssue,
        };
      }
      if (state.auth_transition_token !== null) {
        if (
          state.auth_transition_pid !== null &&
          ownerAlive(state.auth_transition_pid)
        ) {
          return {
            kind: "incomplete",
            code: "AUTH_PUBLICATION_IN_PROGRESS",
            message: "Another local session publication is still in progress",
          };
        }
        const recovery = interruptedPublicationRecovery(state, observed);
        if (recovery === "target") {
          // Only a dead/absent owner's durable file may be recovered here.
          this.confirmAuthPublicationRow(state, Date.now());
          state = this.getSyncState();
        } else if (
          recovery === "source" &&
          state.auth_transition_kind === "request-code"
        ) {
          this.abortRequestCodePublicationRow(state, Date.now());
          state = this.getSyncState();
        } else if (recovery === "source") {
          const message =
            "A session publication stopped before persistence; sign in again.";
          this.db
            .prepare(
              `UPDATE sync_state
               SET auth_transition_pid = NULL,
                   auth_transition_token = NULL,
                   auth_transition_generation = NULL,
                   auth_transition_kind = NULL,
                   auth_transition_user_id = NULL,
                   auth_transition_workspace_id = NULL,
                   blocking = 1,
                   auth_pending = 1,
                   auth_issue_code = 'AUTH_PUBLICATION_ABORTED',
                   auth_issue_message = @issue_message,
                   auth_issue_operation_token = @issue_token,
                   auth_issue_generation = @issue_generation,
                   auth_issue_kind = @issue_kind,
                   updated_ms = @updated_ms
               WHERE id = 1`,
            )
            .run({
              issue_message: message,
              issue_token: state.auth_transition_token,
              issue_generation: state.auth_transition_generation,
              issue_kind: state.auth_transition_kind,
              updated_ms: Date.now(),
            });
          return {
            kind: "incomplete",
            code: "AUTH_PUBLICATION_ABORTED",
            message,
          };
        } else {
          const message =
            "Persisted session identity does not match the interrupted publication";
          this.persistAuthIssue(
            "AUTH_PUBLICATION_INCOMPLETE",
            message,
            Date.now(),
          );
          return {
            kind: "incomplete",
            code: "AUTH_PUBLICATION_INCOMPLETE",
            message,
          };
        }
      }
      if (state.auth_issue_code !== null) {
        return {
          kind: "incomplete",
          code: state.auth_issue_code,
          message:
            state.auth_issue_message ??
            "Authentication transition is incomplete",
        };
      }
      if (
        !confirmedTupleMatches(state, observed)
      ) {
        const message =
          "Persisted session is not the currently confirmed authentication generation";
        this.persistAuthIssue(
          "AUTH_GENERATION_MISMATCH",
          message,
          Date.now(),
        );
        return {
          kind: "incomplete",
          code: "AUTH_GENERATION_MISMATCH",
          message,
        };
      }
      return { kind: "current", generation: state.auth_generation };
    });
  }

  writeSyncGeneration<Value>(
    cycle: SyncCycleIdentity,
    operation: () => Value,
  ): Value {
    validateSyncCycleIdentity(cycle);
    return this.immediateTransaction(() => {
      const state = this.getSyncState();
      if (
        authStateInvariantIssue(state) !== null ||
        state.auth_transition_token !== null ||
        state.auth_issue_code !== null ||
        state.auth_generation !== cycle.generation ||
        state.auth_publication_token !== cycle.publicationToken ||
        state.auth_user_id !== cycle.userId ||
        state.auth_workspace_id !== cycle.workspaceId
      ) {
        throw new SyncGenerationChangedError();
      }
      const result = operation();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result
      ) {
        throw new TypeError(
          "Generation-fenced sync writes must be synchronous",
        );
      }
      return result;
    });
  }

  writeCacheGeneration<Value>(
    cycle: SyncCycleIdentity,
    operation: () => Value,
  ): Value {
    return this.writeSyncGeneration(cycle, () => {
      const state = this.getSyncState();
      if (
        state.cache_user_id !== cycle.userId ||
        state.cache_workspace_id !== cycle.workspaceId
      ) {
        throw new SyncGenerationChangedError();
      }
      return operation();
    });
  }

  assertSyncGeneration(cycle: SyncCycleIdentity): void {
    this.writeSyncGeneration(cycle, () => {});
  }

  releaseCurrentCache(cycle: SyncCycleIdentity): void {
    this.writeCacheGeneration(cycle, () => {
      this.db
        .prepare(
          `UPDATE sync_state
           SET blocking = 0,
               updated_ms = @updated_ms
           WHERE id = 1
             AND auth_generation = @cycle_auth_generation
             AND auth_publication_token = @cycle_publication_token
             AND auth_user_id = @cycle_user_id
             AND auth_workspace_id = @cycle_workspace_id
             AND cache_user_id = @cycle_user_id
             AND cache_workspace_id = @cycle_workspace_id
             AND auth_pending = 0
             AND auth_transition_token IS NULL
             AND auth_issue_code IS NULL
             AND (
               catchup_generation IS NULL OR
               catchup_generation <= @cycle_auth_generation
             )`,
        )
        .run({
          cycle_auth_generation: cycle.generation,
          cycle_publication_token: cycle.publicationToken,
          cycle_user_id: cycle.userId,
          cycle_workspace_id: cycle.workspaceId,
          updated_ms: Date.now(),
        });
    });
  }

  captureCacheOperation(
    tuple: ConfirmedAuthTuple,
  ): CacheOperationGuard {
    validateConfirmedAuthTuple(tuple);
    if (tuple.userId === null || tuple.workspaceId === null) {
      throw new CacheOperationChangedError();
    }
    return this.immediateTransaction(() => {
      this.assertCacheOperationRow(tuple);
      return {
        ...tuple,
        userId: tuple.userId!,
        workspaceId: tuple.workspaceId!,
      };
    });
  }

  withCacheOperation<Value>(
    guard: CacheOperationGuard,
    operation: () => Value,
  ): Value {
    return this.immediateTransaction(() => {
      this.assertCacheOperationRow(guard);
      const result = operation();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result
      ) {
        throw new TypeError(
          "Cache operation transactions must be synchronous",
        );
      }
      return result;
    });
  }

  assertCacheOperation(guard: CacheOperationGuard): void {
    this.immediateTransaction(() => {
      this.assertCacheOperationRow(guard);
    });
  }

  readConsistent<Value>(operation: () => Value): Value {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Consistent read and transaction rollback failed",
        );
      }
      throw error;
    }
  }

  activateCacheIdentity(cycle: SyncCycleIdentity): "unchanged" | "replaced" {
    return this.writeSyncGeneration(cycle, () => {
      const state = this.getSyncState();
      if (
        state.cache_user_id === cycle.userId &&
        state.cache_workspace_id === cycle.workspaceId
      ) {
        return "unchanged";
      }
      // Meeting data is a rebuildable cache. This transition runs only after
      // an authoritative identity and a successful complete list response.
      this.db.exec(`
        DELETE FROM line_fts;
        DELETE FROM line_fts_state;
        DELETE FROM line_embeddings;
        DELETE FROM meeting_metadata;
        DELETE FROM transcripts;
        DELETE FROM fetch_failures;
        DELETE FROM meetings;
      `);
      const vectorTable = this.db
        .prepare(
          `SELECT 1 AS present
           FROM sqlite_master
           WHERE type = 'table' AND name = 'vec_lines'`,
        )
        .get() as { present: number } | null;
      if (vectorTable !== null) {
        this.db.exec(`DELETE FROM vec_lines`);
      }
      this.searchIndexReady = true;
      this.db
        .prepare(
          `UPDATE sync_state
           SET cache_user_id = @user_id,
               cache_workspace_id = @workspace_id,
               meetings_total = 0,
               transcripts_done = 0,
               transcripts_total = 0,
               last_full_sync_ms = NULL,
               last_incremental_ms = NULL,
               updated_ms = @updated_ms
           WHERE id = 1`,
        )
        .run({
          user_id: cycle.userId,
          workspace_id: cycle.workspaceId,
          updated_ms: Date.now(),
        });
      return "replaced";
    });
  }

  recordSyncUnavailable(
    code: string,
    cause: string,
    message: string,
  ): void {
    validateIssue(code, message);
    if (cause.trim() === "" || cause.length > 200) {
      throw new TypeError("Sync unavailable cause is invalid");
    }
    this.db
      .prepare(
        `UPDATE sync_state
         SET sync_issue_code = @code,
             sync_issue_cause = @cause,
             sync_issue_message = @message,
             updated_ms = @updated_ms
         WHERE id = 1`,
      )
      .run({
        code,
        cause,
        message,
        updated_ms: Date.now(),
      });
  }

  resetFailuresIfCurrent(
    tuple: ConfirmedAuthTuple,
  ): "reset" | "stale" {
    return this.authTupleTransaction(tuple, () => {
      this.resetFailures();
      return "reset";
    });
  }

  recordSyncUnavailableIfCurrent(
    tuple: ConfirmedAuthTuple,
    code: string,
    cause: string,
    message: string,
  ): "recorded" | "stale" {
    return this.authTupleTransaction(tuple, () => {
      this.recordSyncUnavailable(code, cause, message);
      return "recorded";
    });
  }

  clearSyncUnavailableIfCurrent(
    tuple: ConfirmedAuthTuple,
  ): "cleared" | "stale" {
    return this.authTupleTransaction(tuple, () => {
      this.clearSyncUnavailable();
      return "cleared";
    });
  }

  clearSyncUnavailable(): void {
    this.db
      .prepare(
        `UPDATE sync_state
         SET sync_issue_code = NULL,
             sync_issue_cause = NULL,
             sync_issue_message = NULL,
             updated_ms = @updated_ms
         WHERE id = 1`,
      )
      .run({ updated_ms: Date.now() });
  }

  /**
   * Finalize from artifact counts read inside the current generation's write
   * transaction. A safe current cache is browsable while pending artifacts keep
   * syncing; stale generations can never release a newer login's cache.
   */
  finishSyncCycle(patch: {
    last_full_sync_ms: number | null;
    last_incremental_ms: number;
    cycle: SyncCycleIdentity;
  }): void {
    const result = this.writeSyncGeneration(patch.cycle, () => {
      const meetings = this.countMeetings();
      const transcripts = this.countTranscripts();
      const complete = this.countComplete();
      const pending = this.countIncomplete();
      const retrying = this.countRetrying();
      return this.db
        .prepare(
        `UPDATE sync_state SET
           phase = @phase,
           message = @message,
           meetings_total = @meetings_total,
           transcripts_total = @transcripts_total,
           transcripts_done = @transcripts_done,
           last_full_sync_ms = @last_full_sync_ms,
           last_incremental_ms = @last_incremental_ms,
           blocking = CASE
              WHEN auth_pending = 0
                AND auth_issue_code IS NULL
               AND auth_transition_token IS NULL
               AND auth_generation = @cycle_auth_generation
               AND auth_publication_token = @cycle_publication_token
               AND (
                 catchup_generation IS NULL OR
                 catchup_generation <= @cycle_auth_generation
               )
             THEN 0 ELSE blocking END,
           error = NULL,
           sync_issue_code = NULL,
           sync_issue_cause = NULL,
           sync_issue_message = NULL,
           updated_ms = @updated_ms
         WHERE id = 1
           AND auth_generation = @cycle_auth_generation
           AND auth_publication_token = @cycle_publication_token
           AND auth_user_id = @cycle_user_id
           AND auth_workspace_id = @cycle_workspace_id
           AND cache_user_id = @cycle_user_id
           AND cache_workspace_id = @cycle_workspace_id
           AND auth_transition_token IS NULL
           AND auth_issue_code IS NULL`
        )
        .run({
          phase: pending === 0 ? "synced" : "downloading",
          message:
             pending === 0
               ? `Up to date - ${meetings} meetings, ${complete} complete.`
               : `Sync continuing - ${complete}/${meetings} meetings ready; ${pending} pending${retrying > 0 ? ` (${retrying} waiting to retry)` : ""}. One meeting is processed at a time.`,
          meetings_total: meetings,
          transcripts_total: meetings,
          transcripts_done: transcripts,
          last_full_sync_ms: patch.last_full_sync_ms,
          last_incremental_ms: patch.last_incremental_ms,
          cycle_auth_generation: patch.cycle.generation,
          cycle_publication_token: patch.cycle.publicationToken,
          cycle_user_id: patch.cycle.userId,
          cycle_workspace_id: patch.cycle.workspaceId,
          updated_ms: Date.now(),
        });
    });
    if (result.changes !== 1) throw new SyncGenerationChangedError();
  }

  close(): void {
    const errors: unknown[] = [];
    try {
      this.db.close();
    } catch (closeError) {
      errors.push(closeError);
    }
    for (const artifact of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        if (existingRegularArtifact(artifact)) {
          repairSensitiveFilePermissions(artifact);
        }
      } catch (permissionError) {
        errors.push(permissionError);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Database close or permission repair failed");
    }
  }

  private confirmAuthPublicationRow(state: SyncState, now: number): void {
    if (
      state.auth_transition_token === null ||
      state.auth_transition_generation === null ||
      state.auth_transition_kind === null
    ) {
      throw new Error("Authentication publication transition is incomplete");
    }
    const login = state.auth_transition_kind === "login";
    const requestCode = state.auth_transition_kind === "request-code";
    const clearsOwnIssue =
      state.auth_issue_operation_token === state.auth_transition_token &&
      state.auth_issue_generation === state.auth_transition_generation &&
      state.auth_issue_kind === state.auth_transition_kind;
    const clearsIssue = login || clearsOwnIssue;
    this.db
      .prepare(
        `UPDATE sync_state
         SET auth_generation = @confirmed_generation,
             auth_publication_token = @confirmed_token,
             auth_user_id = auth_transition_user_id,
             auth_workspace_id = auth_transition_workspace_id,
             auth_transition_pid = NULL,
             auth_transition_token = NULL,
             auth_transition_generation = NULL,
             auth_transition_kind = NULL,
             auth_transition_user_id = NULL,
             auth_transition_workspace_id = NULL,
             phase = CASE WHEN @login = 1 THEN 'idle' ELSE phase END,
             message = CASE
               WHEN @login = 1 THEN 'Login confirmed; transcript sync is pending'
               ELSE message END,
             error = CASE WHEN @login = 1 THEN NULL ELSE error END,
             blocking = CASE
               WHEN @login = 1 OR @request_code = 1
                 OR auth_transition_user_id IS NOT cache_user_id
                 OR auth_transition_workspace_id IS NOT cache_workspace_id
               THEN 1 ELSE blocking END,
             catchup_generation = CASE
               WHEN @login = 1
                 OR auth_transition_user_id IS NOT cache_user_id
                 OR auth_transition_workspace_id IS NOT cache_workspace_id
               THEN @confirmed_generation ELSE catchup_generation END,
             auth_pending = CASE WHEN @clears_issue = 1 THEN 0 ELSE auth_pending END,
             auth_issue_code = CASE WHEN @clears_issue = 1 THEN NULL ELSE auth_issue_code END,
             auth_issue_message = CASE WHEN @clears_issue = 1 THEN NULL ELSE auth_issue_message END,
             auth_issue_operation_token = CASE
               WHEN @clears_issue = 1 THEN NULL ELSE auth_issue_operation_token END,
             auth_issue_generation = CASE
               WHEN @clears_issue = 1 THEN NULL ELSE auth_issue_generation END,
             auth_issue_kind = CASE
               WHEN @clears_issue = 1 THEN NULL ELSE auth_issue_kind END,
             updated_ms = @updated_ms
         WHERE id = 1`,
      )
      .run({
        confirmed_generation: state.auth_transition_generation,
        confirmed_token: state.auth_transition_token,
        login: login ? 1 : 0,
        request_code: requestCode ? 1 : 0,
        clears_issue: clearsIssue ? 1 : 0,
        updated_ms: now,
      });
  }

  private abortRequestCodePublicationRow(state: SyncState, now: number): void {
    if (
      state.auth_transition_token === null ||
      state.auth_transition_generation === null ||
      state.auth_transition_kind !== "request-code"
    ) {
      throw new Error("Request-code publication transition is incomplete");
    }
    const clearsOwnIssue =
      state.auth_issue_code !== null &&
      state.auth_issue_operation_token === state.auth_transition_token &&
      state.auth_issue_generation === state.auth_transition_generation &&
      state.auth_issue_kind === "request-code";
    this.db
      .prepare(
        `UPDATE sync_state
         SET auth_transition_pid = NULL,
             auth_transition_token = NULL,
             auth_transition_generation = NULL,
             auth_transition_kind = NULL,
             auth_transition_user_id = NULL,
             auth_transition_workspace_id = NULL,
             auth_pending = CASE
               WHEN @clears_own_issue = 1 THEN 0 ELSE auth_pending END,
             auth_issue_code = CASE
               WHEN @clears_own_issue = 1 THEN NULL ELSE auth_issue_code END,
             auth_issue_message = CASE
               WHEN @clears_own_issue = 1 THEN NULL ELSE auth_issue_message END,
             auth_issue_operation_token = CASE
               WHEN @clears_own_issue = 1
               THEN NULL ELSE auth_issue_operation_token END,
             auth_issue_generation = CASE
               WHEN @clears_own_issue = 1
               THEN NULL ELSE auth_issue_generation END,
             auth_issue_kind = CASE
               WHEN @clears_own_issue = 1 THEN NULL ELSE auth_issue_kind END,
             updated_ms = @updated_ms
         WHERE id = 1`,
      )
      .run({
        clears_own_issue: clearsOwnIssue ? 1 : 0,
        updated_ms: now,
      });
  }

  private persistAuthIssue(code: string, message: string, now: number): void {
    validateIssue(code, message);
    this.db
      .prepare(
        `UPDATE sync_state
         SET blocking = 1,
             auth_pending = 1,
             auth_issue_code = @issue_code,
             auth_issue_message = @issue_message,
             auth_issue_operation_token = NULL,
             auth_issue_generation = NULL,
             auth_issue_kind = NULL,
             updated_ms = @updated_ms
         WHERE id = 1`,
      )
      .run({
        issue_code: code,
        issue_message: message,
        updated_ms: now,
      });
  }

  private immediateTransaction<Value>(operation: () => Value): Value {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "SQLite operation and transaction rollback failed",
        );
      }
      throw error;
    }
  }

  private authTupleTransaction<Value>(
    tuple: ConfirmedAuthTuple,
    operation: () => Value,
  ): Value | "stale" {
    validateConfirmedAuthTuple(tuple);
    return this.immediateTransaction(() => {
      const state = this.getSyncState();
      if (
        state.auth_transition_token !== null ||
        state.auth_issue_code !== null ||
        state.auth_generation !== tuple.generation ||
        state.auth_publication_token !== tuple.publicationToken ||
        state.auth_user_id !== tuple.userId ||
        state.auth_workspace_id !== tuple.workspaceId
      ) {
        return "stale";
      }
      return operation();
    });
  }

  private assertCacheOperationRow(tuple: ConfirmedAuthTuple): void {
    const state = this.getSyncState();
    if (
      authStateInvariantIssue(state) !== null ||
      state.blocking !== 0 ||
      state.auth_pending !== 0 ||
      state.auth_transition_token !== null ||
      state.auth_issue_code !== null ||
      state.auth_generation !== tuple.generation ||
      state.auth_publication_token !== tuple.publicationToken ||
      state.auth_user_id !== tuple.userId ||
      state.auth_workspace_id !== tuple.workspaceId ||
      state.cache_user_id !== tuple.userId ||
      state.cache_workspace_id !== tuple.workspaceId
    ) {
      throw new CacheOperationChangedError();
    }
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function isCanonicalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim()
  );
}

function validateSessionVersion(version: SessionVersion): void {
  assertNonNegativeSafeInteger(version.generation, "session generation");
  if (
    version.publicationToken !== null &&
    !isUuid(version.publicationToken)
  ) {
    throw new TypeError("Session publication token must be a UUID or null");
  }
  if (
    (version.generation === 0) !==
    (version.publicationToken === null)
  ) {
    throw new TypeError(
      "Legacy generation zero requires no publication token, and published generations require one",
    );
  }
  const userId = version.userId ?? null;
  const workspaceId = version.workspaceId ?? null;
  if (
    (version.generation === 0 &&
      (userId !== null || workspaceId !== null)) ||
    (userId === null) !== (workspaceId === null) ||
    (userId !== null && !isCanonicalId(userId)) ||
    (workspaceId !== null && !isCanonicalId(workspaceId))
  ) {
    throw new TypeError(
      "Session user and workspace identities must be present together, non-empty, and without surrounding whitespace",
    );
  }
}

function validatePublicationIdentity(
  identity: Readonly<{ userId: string | null; workspaceId: string | null }>,
  kind: AuthPublicationKind,
): void {
  if (
    (identity.userId === null) !== (identity.workspaceId === null) ||
    (identity.userId !== null && !isCanonicalId(identity.userId)) ||
    (identity.workspaceId !== null &&
      !isCanonicalId(identity.workspaceId))
  ) {
    throw new TypeError(
      "Publication target identity must be present together, non-empty, and without surrounding whitespace",
    );
  }
  if (
    (kind === "login" || kind === "refresh") &&
    (identity.userId === null || identity.workspaceId === null)
  ) {
    throw new TypeError(
      `${kind} publication requires an authoritative user and workspace identity`,
    );
  }
}

function validateSyncCycleIdentity(cycle: SyncCycleIdentity): void {
  assertNonNegativeSafeInteger(cycle.generation, "sync generation");
  if (
    cycle.generation === 0 ||
    !isUuid(cycle.publicationToken) ||
    !isCanonicalId(cycle.userId) ||
    !isCanonicalId(cycle.workspaceId)
  ) {
    throw new TypeError(
      "Sync cycle requires a published generation and authoritative identity",
    );
  }
}

function validateConfirmedAuthTuple(tuple: ConfirmedAuthTuple): void {
  if (
    !Number.isSafeInteger(tuple.generation) ||
    tuple.generation <= 0 ||
    !isUuid(tuple.publicationToken) ||
    (tuple.userId === null) !== (tuple.workspaceId === null) ||
    (tuple.userId !== null && !isCanonicalId(tuple.userId)) ||
    (tuple.workspaceId !== null &&
      !isCanonicalId(tuple.workspaceId))
  ) {
    throw new TypeError("Confirmed authentication tuple is invalid");
  }
}

function confirmedTupleMatches(
  state: SyncState,
  observed: SessionVersion,
): boolean {
  return (
    observed.generation === state.auth_generation &&
    observed.publicationToken === state.auth_publication_token &&
    (observed.userId ?? null) === state.auth_user_id &&
    (observed.workspaceId ?? null) === state.auth_workspace_id
  );
}

function pendingTupleMatches(
  state: SyncState,
  observed: SessionVersion,
): boolean {
  return (
    observed.generation === state.auth_transition_generation &&
    observed.publicationToken === state.auth_transition_token &&
    (observed.userId ?? null) === state.auth_transition_user_id &&
    (observed.workspaceId ?? null) === state.auth_transition_workspace_id
  );
}

function interruptedPublicationRecovery(
  state: SyncState,
  observed: SessionVersion,
): "target" | "source" | "mismatch" {
  if (pendingTupleMatches(state, observed)) return "target";
  if (confirmedTupleMatches(state, observed)) return "source";
  return "mismatch";
}

function authStateInvariantIssue(state: SyncState): string | null {
  if (
    (state.blocking !== 0 && state.blocking !== 1) ||
    (state.auth_pending !== 0 && state.auth_pending !== 1)
  ) {
    return "Persisted authentication state flags are malformed";
  }
  const confirmedTokenValid =
    state.auth_publication_token === null ||
    isUuid(state.auth_publication_token);
  if (
    !Number.isSafeInteger(state.auth_generation) ||
    state.auth_generation < 0 ||
    !confirmedTokenValid ||
    (state.auth_generation === 0) !==
      (state.auth_publication_token === null)
  ) {
    return "Persisted confirmed authentication generation/token tuple is malformed";
  }
  if (
    (state.auth_generation === 0 &&
      (state.auth_user_id !== null ||
        state.auth_workspace_id !== null)) ||
    (state.auth_user_id === null) !==
      (state.auth_workspace_id === null) ||
    (state.auth_user_id !== null &&
      !isCanonicalId(state.auth_user_id)) ||
    (state.auth_workspace_id !== null &&
      !isCanonicalId(state.auth_workspace_id))
  ) {
    return "Persisted confirmed authentication identity tuple is malformed";
  }

  const transitionValues = [
    state.auth_transition_pid,
    state.auth_transition_token,
    state.auth_transition_generation,
    state.auth_transition_kind,
    state.auth_transition_user_id,
    state.auth_transition_workspace_id,
  ];
  const transitionPresent = state.auth_transition_token !== null;
  if (transitionPresent) {
    if (
      (state.auth_transition_pid === null
        ? state.auth_issue_code === null &&
          (state.auth_transition_kind !== "request-code" ||
            state.auth_pending !== 0)
        : !Number.isSafeInteger(state.auth_transition_pid) ||
          state.auth_transition_pid <= 0) ||
      state.auth_transition_generation !== state.auth_generation + 1 ||
      state.auth_transition_token === null ||
      !isUuid(state.auth_transition_token) ||
      (state.auth_transition_kind !== "request-code" &&
        state.auth_transition_kind !== "login" &&
        state.auth_transition_kind !== "refresh" &&
        state.auth_transition_kind !== "reset") ||
      (state.auth_transition_user_id === null) !==
        (state.auth_transition_workspace_id === null) ||
      (state.auth_transition_user_id !== null &&
        !isCanonicalId(state.auth_transition_user_id)) ||
      (state.auth_transition_workspace_id !== null &&
        !isCanonicalId(state.auth_transition_workspace_id)) ||
      ((state.auth_transition_kind === "login" ||
        state.auth_transition_kind === "refresh") &&
        (state.auth_transition_user_id === null ||
          state.auth_transition_workspace_id === null)) ||
      (state.auth_transition_kind === "reset" &&
        (state.auth_transition_user_id !== null ||
          state.auth_transition_workspace_id !== null))
    ) {
      return "Persisted pending authentication publication tuple is malformed";
    }
  } else if (transitionValues.some((value) => value !== null)) {
    return "Persisted authentication transition is only partially populated";
  }

  const persistedAuthIssue = inspectPersistedAuthIssue(state);
  if (persistedAuthIssue.kind === "malformed")
    return persistedAuthIssue.message;
  const issueProvenance = [
    state.auth_issue_operation_token,
    state.auth_issue_generation,
    state.auth_issue_kind,
  ];
  const hasIssueProvenance = issueProvenance.some(
    (value) => value !== null,
  );
  if (
    state.auth_issue_code === null
      ? hasIssueProvenance
      : hasIssueProvenance &&
        (state.auth_issue_operation_token === null ||
          !isUuid(state.auth_issue_operation_token) ||
          state.auth_issue_generation === null ||
          !Number.isSafeInteger(state.auth_issue_generation) ||
          state.auth_issue_generation <= 0 ||
          (state.auth_issue_kind !== "request-code" &&
            state.auth_issue_kind !== "login" &&
            state.auth_issue_kind !== "refresh" &&
            state.auth_issue_kind !== "reset"))
  ) {
    return "Persisted authentication issue provenance is malformed";
  }
  if (
    state.auth_issue_code !== null &&
    (state.blocking !== 1 || state.auth_pending !== 1)
  ) {
    return "Persisted authentication issue is not holding the cache block";
  }
  if (
    state.auth_pending === 1 &&
    state.auth_transition_token === null &&
    state.auth_issue_code === null
  ) {
    return "Persisted authentication pending flag has no transition or issue";
  }
  if (
    state.catchup_generation !== null &&
    (!Number.isSafeInteger(state.catchup_generation) ||
      state.catchup_generation <= 0)
  ) {
    return "Persisted catch-up generation is malformed";
  }
  if (
    (state.cache_user_id === null) !==
      (state.cache_workspace_id === null) ||
    (state.cache_user_id !== null &&
      !isCanonicalId(state.cache_user_id)) ||
    (state.cache_workspace_id !== null &&
      !isCanonicalId(state.cache_workspace_id))
  ) {
    return "Persisted cache identity tuple is malformed";
  }
  return null;
}

function validateOperationToken(token: string): void {
  if (!isUuid(token)) {
    throw new TypeError("Authentication operation token must be a UUID");
  }
}

function validateIssue(code: string, message: string): void {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
    throw new TypeError("Authentication issue code is invalid");
  }
  if (message.trim() === "" || message.length > 1_000) {
    throw new TypeError("Authentication issue message is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function authIntentMatches(
  state: SyncState,
  intent: AuthPublicationIntent,
): boolean {
  return (
    state.auth_generation === intent.sourceGeneration &&
    state.auth_publication_token === intent.sourcePublicationToken &&
    state.auth_user_id === intent.sourceUserId &&
    state.auth_workspace_id === intent.sourceWorkspaceId &&
    state.auth_transition_token === intent.operationToken &&
    state.auth_transition_generation === intent.targetGeneration &&
    state.auth_transition_pid === intent.ownerPid &&
    state.auth_transition_kind === intent.kind &&
    state.auth_transition_user_id === intent.userId &&
    state.auth_transition_workspace_id === intent.workspaceId
  );
}
