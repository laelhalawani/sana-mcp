// Presentation-agnostic meeting queries: list, read, summary, participants,
// recording. Each returns typed view-models; the MCP handlers and the CLI
// screens render their own strings from these. No display strings here.
import type { SanaClient } from "../sana/client.js";
import { SessionExpiredError } from "../sana/types.js";
import type { SanaStore, MeetingListOpts, MeetingListRow, MeetingRow } from "../store/db.js";
import { transcriptLines, type TranscriptLine } from "../sana/transcript.js";
import { MAX_TRANSCRIPT_ATTEMPTS } from "../config.js";
import { posInt, parseFilters } from "./args.js";

export type RowStatus = "ready" | "downloading" | "processing" | "failed";

export function rowStatus(r: {
  has_transcript: number;
  attempts: number;
  processing_phase: string | null;
}): RowStatus {
  if (r.has_transcript) return "ready";
  if (r.processing_phase && r.processing_phase !== "done") return "processing";
  return r.attempts >= MAX_TRANSCRIPT_ATTEMPTS ? "failed" : "downloading";
}

// ---- list ----------------------------------------------------------------

export interface MeetingPage {
  rows: MeetingListRow[];
  total: number;
  page: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  filter: MeetingListOpts;
}

export function queryMeetings(store: SanaStore, args: Record<string, unknown>): MeetingPage {
  const limit = posInt(args.limit, 50);
  const page = posInt(args.page, 1);
  const offset = (page - 1) * limit;
  const query = typeof args.query === "string" ? args.query : undefined;
  const sort: MeetingListOpts["sort"] = args.sort === "oldest" ? "oldest" : "newest";
  const { status, dateFrom, dateTo } = parseFilters(args);
  const filter: MeetingListOpts = { query, sort, status, dateFrom, dateTo };
  const rows = store.listMeetings({ ...filter, limit, offset });
  const total = store.countMeetings(filter);
  return { rows, total, page, limit, offset, hasMore: offset + rows.length < total, filter };
}

// ---- read ----------------------------------------------------------------

export type TranscriptView =
  | { kind: "no-meeting"; id: string }
  | { kind: "still-listing"; id: string }
  | { kind: "not-downloaded"; name: string; done: number; total: number; etaMinutes: number }
  | { kind: "no-transcript"; name: string }
  | {
      kind: "ok";
      meeting: MeetingRow | null;
      id: string;
      name: string;
      dateMs: number | null;
      lineCount: number;
      wordCount: number;
      lines: TranscriptLine[];
    };

/** Load a transcript into structured lines, or a typed not-ready reason. */
export function getTranscriptView(store: SanaStore, id: string): TranscriptView {
  const meeting = store.getMeeting(id);
  const t = store.getTranscript(id);
  if (!meeting && !t) {
    const s = store.getSyncState();
    if (s.phase === "listing" || s.phase === "idle") return { kind: "still-listing", id };
    return { kind: "no-meeting", id };
  }
  const name = meeting?.name ?? id;
  if (!t) {
    const s = store.getSyncState();
    if (s.phase === "downloading")
      return {
        kind: "not-downloaded",
        name,
        done: s.transcripts_done,
        total: s.transcripts_total,
        etaMinutes: Math.max(1, Math.ceil((Math.max(0, s.transcripts_total - s.transcripts_done) * 0.5) / 60)),
      };
    return { kind: "no-transcript", name };
  }
  let lines: TranscriptLine[] = [];
  try {
    lines = transcriptLines(JSON.parse(t.json));
  } catch {
    lines = [];
  }
  return {
    kind: "ok",
    meeting,
    id,
    name,
    dateMs: meeting ? meeting.created_at_ms : null,
    lineCount: lines.length,
    wordCount: t.word_count,
    lines,
  };
}

// ---- summary -------------------------------------------------------------

export interface ActionItem {
  action: string;
  assignedTo?: string | null;
  dueDate?: string | null;
}
export interface NoteTopic {
  topic: string;
  notes: string[];
}
export interface SummaryView {
  meeting: MeetingRow | null;
  id: string;
  name: string;
  dateMs: number | null;
  summaryShort: string | null;
  summary: string | null;
  actionItems: ActionItem[];
  notes: NoteTopic[];
}

export type SummaryResult =
  | { kind: "no-meeting"; id: string }
  | { kind: "none"; name: string }
  | { kind: "ok"; view: SummaryView };

export function getSummaryView(store: SanaStore, id: string): SummaryResult {
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return { kind: "no-meeting", id };
  const name = meeting?.name ?? id;
  if (!meta) return { kind: "none", name };

  let actionItems: ActionItem[] = [];
  let notes: NoteTopic[] = [];
  if (meta.notes_json) {
    try {
      const parsed = JSON.parse(meta.notes_json) as {
        notes?: { topic?: string; notes?: string[] }[] | null;
        actionItems?: { assignedTo?: string | null; action?: string; dueDate?: string | null }[] | null;
      };
      actionItems = (Array.isArray(parsed.actionItems) ? parsed.actionItems : [])
        .map((a) => ({ action: a.action ?? "", assignedTo: a.assignedTo, dueDate: a.dueDate }))
        .filter((a) => a.action || a.assignedTo || a.dueDate);
      notes = (Array.isArray(parsed.notes) ? parsed.notes : [])
        .map((n) => ({ topic: n.topic ?? "Topic", notes: Array.isArray(n.notes) ? n.notes : [] }))
        .filter((n) => n.notes.length);
    } catch {
      /* malformed metadata -> no notes */
    }
  }

  const view: SummaryView = {
    meeting,
    id,
    name,
    dateMs: meeting ? meeting.created_at_ms : null,
    summaryShort: meta.summary_short,
    summary: meta.summary,
    actionItems,
    notes,
  };
  if (!view.summaryShort && !view.summary && !actionItems.length && !notes.length)
    return { kind: "none", name };
  return { kind: "ok", view };
}

// ---- participants --------------------------------------------------------

export interface Participant {
  displayName?: string;
  email?: string;
  isHost?: boolean;
}

export type ParticipantsResult =
  | { kind: "no-meeting"; id: string }
  | { kind: "none"; name: string }
  | { kind: "ok"; name: string; participants: Participant[] };

export function getParticipants(store: SanaStore, id: string): ParticipantsResult {
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return { kind: "no-meeting", id };
  const name = meeting?.name ?? id;
  let ps: Participant[] = [];
  try {
    ps = meta?.participants_json ? (JSON.parse(meta.participants_json) as Participant[]) : [];
  } catch {
    ps = [];
  }
  if (!ps.length) return { kind: "none", name };
  return { kind: "ok", name, participants: ps };
}

// ---- recording (network) -------------------------------------------------

export type RecordingResult =
  | { kind: "ok"; name: string; url: string }
  | { kind: "none"; name: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export async function getRecordingLink(
  client: SanaClient,
  store: SanaStore,
  id: string
): Promise<RecordingResult> {
  const name = store.getMeeting(id)?.name ?? id;
  try {
    const info = await client.getMeetingById(id);
    const url = info?.recordingUrl || info?.fallbackRecordingUrl;
    if (!url) return { kind: "none", name };
    return { kind: "ok", name, url };
  } catch (e) {
    if (e instanceof SessionExpiredError) return { kind: "expired" };
    return { kind: "error", message: (e as Error).message };
  }
}
