import Database from "better-sqlite3";
import path from "node:path";
import { DATA_DIR, ensureDataDir, MAX_TRANSCRIPT_ATTEMPTS } from "../config.js";

export interface MeetingListOpts {
  limit?: number;
  offset?: number;
  query?: string;
  sort?: "newest" | "oldest";
  status?: "ready" | "downloading" | "failed";
  dateFrom?: number; // epoch ms, inclusive
  dateTo?: number; // epoch ms, inclusive
}

export type MeetingListRow = MeetingRow & {
  has_transcript: number;
  word_count: number | null;
  attempts: number;
};

export const DB_FILE = path.join(DATA_DIR, "sana.db");

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
  // 1 while a login-triggered catch-up sync is running; data tools are blocked
  // until it clears. Set on login, cleared by the daemon once fully caught up.
  blocking: number;
  error: string | null;
  updated_ms: number;
}

export class SanaStore {
  readonly db: Database.Database;

  constructor(file: string = DB_FILE) {
    ensureDataDir();
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
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
        blocking INTEGER NOT NULL DEFAULT 1,
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

  getMeeting(id: string): MeetingRow | undefined {
    return this.db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
      | MeetingRow
      | undefined;
  }

  /** Build a WHERE clause + params for the meeting filters. */
  private meetingFilter(opts: MeetingListOpts): {
    where: string;
    params: Record<string, unknown>;
  } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
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
      clauses.push("t.meeting_id IS NOT NULL");
    } else if (opts.status === "downloading") {
      clauses.push("t.meeting_id IS NULL AND COALESCE(ff.attempts, 0) < @maxAtt");
      params.maxAtt = MAX_TRANSCRIPT_ATTEMPTS;
    } else if (opts.status === "failed") {
      clauses.push("t.meeting_id IS NULL AND COALESCE(ff.attempts, 0) >= @maxAtt");
      params.maxAtt = MAX_TRANSCRIPT_ATTEMPTS;
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listMeetings(opts: MeetingListOpts = {}): MeetingListRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const order = opts.sort === "oldest" ? "ASC" : "DESC";
    const { where, params } = this.meetingFilter(opts);
    return this.db
      .prepare(
        `SELECT m.*, (t.meeting_id IS NOT NULL) AS has_transcript, t.word_count,
                COALESCE(ff.attempts, 0) AS attempts
         FROM meetings m
         LEFT JOIN transcripts t ON t.meeting_id = m.id
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
         LEFT JOIN fetch_failures ff ON ff.meeting_id = m.id
         ${where}`
      )
      .get(params) as { n: number };
    return row.n;
  }

  /**
   * Meeting ids that are incomplete (missing transcript OR metadata) and still
   * retriable, newest first. A complete meeting has both a transcript and its
   * metadata.
   */
  meetingsIncomplete(): string[] {
    return (
      this.db
        .prepare(
          `SELECT m.id FROM meetings m
           LEFT JOIN transcripts t ON t.meeting_id = m.id
           LEFT JOIN meeting_metadata mm ON mm.meeting_id = m.id
           LEFT JOIN fetch_failures ff ON ff.meeting_id = m.id
           WHERE (t.meeting_id IS NULL OR mm.meeting_id IS NULL)
             AND COALESCE(ff.attempts, 0) < @maxAtt
             AND (m.processing_phase IS NULL OR m.processing_phase = 'done')
           ORDER BY m.created_at_ms DESC`
        )
        .all({ maxAtt: MAX_TRANSCRIPT_ATTEMPTS }) as { id: string }[]
    ).map((r) => r.id);
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
    this.db
      .prepare(
        `INSERT INTO transcripts (meeting_id, text, json, word_count, segment_count, fetched_ms)
         VALUES (@meeting_id, @text, @json, @word_count, @segment_count, @fetched_ms)
         ON CONFLICT(meeting_id) DO UPDATE SET
           text = excluded.text, json = excluded.json,
           word_count = excluded.word_count, segment_count = excluded.segment_count,
           fetched_ms = excluded.fetched_ms`
      )
      .run({ ...row, fetched_ms: Date.now() });
  }

  getTranscript(meetingId: string): TranscriptRow | undefined {
    return this.db
      .prepare(`SELECT * FROM transcripts WHERE meeting_id = ?`)
      .get(meetingId) as TranscriptRow | undefined;
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
    | undefined {
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
      | undefined;
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

  /** Reset all failure counters so failed items are retried (used on login). */
  resetFailures(): void {
    this.db.prepare(`DELETE FROM fetch_failures`).run();
  }

  /**
   * Meetings whose transcript text contains the query (case-insensitive),
   * newest first. Returns segment JSON so the caller can locate matching lines.
   */
  searchCandidates(
    query: string,
    limit = 50
  ): { id: string; name: string; created_at_ms: number; json: string }[] {
    const lim = Math.min(Math.max(limit, 1), 500);
    return this.db
      .prepare(
        `SELECT m.id, m.name, m.created_at_ms, t.json
         FROM transcripts t JOIN meetings m ON m.id = t.meeting_id
         WHERE t.text LIKE @like
         ORDER BY m.created_at_ms DESC
         LIMIT @lim`
      )
      .all({ like: `%${query}%`, lim }) as {
      id: string;
      name: string;
      created_at_ms: number;
      json: string;
    }[];
  }

  // ---- sync state --------------------------------------------------------

  getSyncState(): SyncState {
    return this.db.prepare(`SELECT * FROM sync_state WHERE id = 1`).get() as SyncState;
  }

  updateSyncState(patch: Partial<Omit<SyncState, "updated_ms">>): void {
    const cur = this.getSyncState();
    const next = { ...cur, ...patch, updated_ms: Date.now() };
    this.db
      .prepare(
        `UPDATE sync_state SET
           phase=@phase, message=@message, meetings_total=@meetings_total,
           transcripts_done=@transcripts_done, transcripts_total=@transcripts_total,
           last_full_sync_ms=@last_full_sync_ms, last_incremental_ms=@last_incremental_ms,
           daemon_pid=@daemon_pid, daemon_heartbeat_ms=@daemon_heartbeat_ms,
           blocking=@blocking, error=@error, updated_ms=@updated_ms
         WHERE id = 1`
      )
      .run(next);
  }

  close(): void {
    this.db.close();
  }
}
