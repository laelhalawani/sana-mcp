import { Database } from "bun:sqlite";
import path from "node:path";
import { DATA_DIR, ensureDataDir, MAX_TRANSCRIPT_ATTEMPTS } from "../config.js";
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
  readonly db: Database;

  constructor(file: string = DB_FILE) {
    ensureDataDir();
    this.db = new Database(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
        .run({ ...row, fetched_ms: Date.now() });
      this.indexLines(row.meeting_id, row.json);
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

  /** Reset all failure counters so failed items are retried (used on login). */
  resetFailures(): void {
    this.db.prepare(`DELETE FROM fetch_failures`).run();
  }

  private searchIndexReady = false;

  /** Backfill the FTS index from existing transcripts if it is empty. */
  private ensureSearchIndex(): void {
    if (this.searchIndexReady) return;
    const n = (this.db.prepare(`SELECT COUNT(*) c FROM line_fts`).get() as { c: number }).c;
    if (n === 0) {
      const rows = this.db.prepare(`SELECT meeting_id, json FROM transcripts`).all() as {
        meeting_id: string;
        json: string;
      }[];
      const tx = this.db.transaction(() => {
        for (const r of rows) this.indexLines(r.meeting_id, r.json);
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
