// Presentation-agnostic meeting queries: list, read, summary, participants,
// recording. Each returns typed view-models; the MCP handlers and the CLI
// screens render their own strings from these. No display strings here.
import type { SanaClient } from "../sana/client.js";
import { SessionExpiredError } from "../sana/types.js";
import { z } from "zod";
import {
  CacheOperationChangedError,
  type CacheOperationGuard,
  type SanaStore,
  type MeetingListOpts,
  type MeetingListRow,
  type MeetingRow,
  MAX_MEETING_LIST_LIMIT,
} from "../store/db.js";
import {
  countWords,
  transcriptLines,
  type TranscriptLine,
} from "../sana/transcript.js";
import { MAX_TRANSCRIPT_ATTEMPTS } from "../config.js";
import {
  parseMeetingListArguments,
} from "./args.js";

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
  const {
    limit,
    page,
    offset,
    query,
    sort,
    status,
    dateFrom,
    dateTo,
  } = parseMeetingListArguments(args, MAX_MEETING_LIST_LIMIT);
  const filter: MeetingListOpts = { query, sort, status, dateFrom, dateTo };
  const rows = store.listMeetings({ ...filter, limit, offset });
  const total = store.countMeetings(filter);
  return { rows, total, page, limit, offset, hasMore: offset + rows.length < total, filter };
}

// ---- read ----------------------------------------------------------------

export type TranscriptView =
  | { kind: "no-meeting"; id: string }
  | { kind: "still-listing"; id: string }
  | { kind: "not-downloaded"; name: string; done: number; total: number }
  | ArtifactProblem
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

interface ArtifactProblemBase {
  id: string;
  name?: string;
  artifact: "meeting" | "transcript" | "summary" | "participants";
  code:
    | "CACHE_ARTIFACT_CORRUPT"
    | "CACHE_ARTIFACT_WITHOUT_MEETING"
    | "CACHE_ARTIFACT_MISSING";
  action: "resync";
  detail?: string;
}

export type ArtifactProblem = ArtifactProblemBase &
  ({ kind: "corrupt" } | { kind: "unavailable" });

function artifactProblem(
  kind: ArtifactProblem["kind"],
  artifact: ArtifactProblem["artifact"],
  id: string,
  name: string | undefined,
  code: ArtifactProblem["code"],
  error?: unknown,
): ArtifactProblem {
  return {
    kind,
    id,
    ...(name === undefined ? {} : { name }),
    artifact,
    code,
    action: "resync",
    ...(error instanceof Error ? { detail: error.message } : {}),
  };
}

/** Load a transcript into structured lines, or a typed not-ready reason. */
export function getTranscriptView(store: SanaStore, id: string): TranscriptView {
  const meeting = store.getMeeting(id);
  const t = store.getTranscript(id);
  if (!meeting && !t) {
    const s = store.getSyncState();
    if (s.phase === "listing" || s.phase === "idle") return { kind: "still-listing", id };
    return { kind: "no-meeting", id };
  }
  if (!meeting) {
    return artifactProblem(
      "unavailable",
      "meeting",
      id,
      undefined,
      "CACHE_ARTIFACT_WITHOUT_MEETING",
    );
  }
  const name = meeting.name;
  if (!t) {
    const s = store.getSyncState();
    if (s.phase === "downloading")
      return {
        kind: "not-downloaded",
        name,
        done: s.transcripts_done,
        total: s.transcripts_total,
      };
    return artifactProblem(
      "unavailable",
      "transcript",
      id,
      name,
      "CACHE_ARTIFACT_MISSING",
    );
  }
  let lines: TranscriptLine[];
  let wordCount: number;
  try {
    const parsed: unknown = JSON.parse(t.json);
    lines = transcriptLines(parsed as never);
    wordCount = countWords(parsed as never);
    if (
      !Number.isSafeInteger(t.word_count) ||
      t.word_count < 0 ||
      t.word_count !== wordCount ||
      !Number.isSafeInteger(t.segment_count) ||
      t.segment_count < 0 ||
      !Array.isArray(parsed) ||
      t.segment_count !== parsed.length
    ) {
      throw new TypeError(
        "cached transcript counts do not match the validated transcript data",
      );
    }
  } catch (error) {
    return artifactProblem(
      "corrupt",
      "transcript",
      id,
      name,
      "CACHE_ARTIFACT_CORRUPT",
      error,
    );
  }
  return {
    kind: "ok",
    meeting,
    id,
    name,
    dateMs: meeting ? meeting.created_at_ms : null,
    lineCount: lines.length,
    wordCount,
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
  | ArtifactProblem
  | { kind: "ok"; view: SummaryView };

const cachedSummarySchema = z
  .object({
    notes: z
      .array(
        z
          .object({
            topic: z.string().min(1),
            notes: z.array(z.string()),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    actionItems: z
      .array(
        z
          .object({
            assignedTo: z.string().nullable().optional(),
            action: z.string(),
            dueDate: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .strict();

export function getSummaryView(store: SanaStore, id: string): SummaryResult {
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return { kind: "no-meeting", id };
  if (!meeting) {
    return artifactProblem(
      "unavailable",
      "meeting",
      id,
      undefined,
      "CACHE_ARTIFACT_WITHOUT_MEETING",
    );
  }
  const name = meeting.name;
  if (!meta) {
    return artifactProblem(
      "unavailable",
      "summary",
      id,
      name,
      "CACHE_ARTIFACT_MISSING",
    );
  }
  if (
    (meta.summary !== null && typeof meta.summary !== "string") ||
    (meta.summary_short !== null &&
      typeof meta.summary_short !== "string")
  ) {
    return artifactProblem(
      "corrupt",
      "summary",
      id,
      name,
      "CACHE_ARTIFACT_CORRUPT",
      new TypeError(
        "cached summary and summary_short must be strings or null",
      ),
    );
  }

  let actionItems: ActionItem[] = [];
  let notes: NoteTopic[] = [];
  if (meta.notes_json !== null) {
    try {
      const parsed = cachedSummarySchema.parse(JSON.parse(meta.notes_json));
      actionItems = (parsed.actionItems ?? []).filter(
        (item) => item.action || item.assignedTo || item.dueDate,
      );
      notes = (parsed.notes ?? []).filter((topic) => topic.notes.length);
    } catch (error) {
      return artifactProblem(
        "corrupt",
        "summary",
        id,
        name,
        "CACHE_ARTIFACT_CORRUPT",
        error,
      );
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
  displayName: string;
  email: string;
  isHost: boolean;
}

export type ParticipantsResult =
  | { kind: "no-meeting"; id: string }
  | { kind: "none"; name: string }
  | ArtifactProblem
  | { kind: "ok"; name: string; participants: Participant[] };

const cachedParticipantsSchema = z.array(
  z
    .object({
      id: z
        .string()
        .refine(
          (value) =>
            value.trim() !== "" && value === value.trim(),
          "id must be a non-empty string without surrounding whitespace",
        )
        .optional(),
      displayName: z
        .string()
        .min(1)
        .refine(
          (displayName) => displayName.trim() !== "",
          "displayName must contain a non-whitespace character",
        ),
      email: z.string().email(),
      isHost: z.boolean(),
    })
    .passthrough(),
);

export function getParticipants(store: SanaStore, id: string): ParticipantsResult {
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return { kind: "no-meeting", id };
  if (!meeting) {
    return artifactProblem(
      "unavailable",
      "meeting",
      id,
      undefined,
      "CACHE_ARTIFACT_WITHOUT_MEETING",
    );
  }
  const name = meeting.name;
  if (meta === null || meta.participants_json === null) {
    return artifactProblem(
      "unavailable",
      "participants",
      id,
      name,
      "CACHE_ARTIFACT_MISSING",
    );
  }
  let ps: Participant[] = [];
  try {
    ps = cachedParticipantsSchema.parse(
      JSON.parse(meta.participants_json),
    );
  } catch (error) {
    return artifactProblem(
      "corrupt",
      "participants",
      id,
      name,
      "CACHE_ARTIFACT_CORRUPT",
      error,
    );
  }
  if (!ps.length) return { kind: "none", name };
  return { kind: "ok", name, participants: ps };
}

// ---- recording (network) -------------------------------------------------

export type RecordingResult =
  | { kind: "ok"; name: string; url: string }
  | { kind: "none"; name: string }
  | { kind: "no-meeting"; id: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export async function getRecordingLink(
  client: SanaClient,
  store: SanaStore,
  id: string,
  guard?: CacheOperationGuard,
): Promise<RecordingResult> {
  const meeting = guard
    ? store.withCacheOperation(
        guard,
        () => store.getMeeting(id),
      )
    : store.getMeeting(id);
  if (!meeting) return { kind: "no-meeting", id };
  const name = meeting.name;
  try {
    if (guard) store.assertCacheOperation(guard);
    const info = await client.getMeetingById(id);
    if (guard) store.assertCacheOperation(guard);
    const url = info?.recordingUrl ?? info?.fallbackRecordingUrl;
    if (!url) return { kind: "none", name };
    return { kind: "ok", name, url };
  } catch (e) {
    if (e instanceof CacheOperationChangedError) throw e;
    if (e instanceof SessionExpiredError) return { kind: "expired" };
    return { kind: "error", message: (e as Error).message };
  }
}
