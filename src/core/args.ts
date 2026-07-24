// Presentation-agnostic argument coercion, shared by the MCP dispatcher and the
// interactive CLI. No display strings here.
import type { MeetingListOpts } from "../store/db.js";

/**
 * Coerce a pagination arg to a positive integer, tolerating callers that pass
 * numbers as strings (e.g. "10"). Non-numeric/garbage falls back to `dflt`
 * rather than producing NaN, which would crash a strict SQLite LIMIT binding.
 */
export function posInt(v: unknown, dflt: number): number {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : dflt;
}

/** Accept an ISO date/datetime string or an epoch-ms number. */
export function parseDateMs(v: unknown, endOfDay = false): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
    const ms = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
    if (Number.isNaN(ms)) return undefined;
    return endOfDay && dateOnly ? ms + 86_400_000 - 1 : ms;
  }
  return undefined;
}

export interface ParsedFilters {
  status?: MeetingListOpts["status"];
  dateFrom?: number;
  dateTo?: number;
}

/** Extract status + date-range filters from a tool's args dict. */
export function parseFilters(args: Record<string, unknown>): ParsedFilters {
  const filter =
    args.filter && typeof args.filter === "object" ? (args.filter as Record<string, unknown>) : {};
  const status =
    filter.status === "ready" || filter.status === "downloading" || filter.status === "failed"
      ? filter.status
      : undefined;
  const date =
    filter.date && typeof filter.date === "object" ? (filter.date as Record<string, unknown>) : {};
  return {
    status,
    dateFrom: parseDateMs(date.from),
    dateTo: parseDateMs(date.to, true),
  };
}

/** meeting id from either `meeting_id` or `id`. */
export function argMeetingId(args: Record<string, unknown>): string {
  return typeof args.meeting_id === "string"
    ? args.meeting_id
    : typeof args.id === "string"
      ? args.id
      : "";
}

// ---- shared time formatting (used by both renderers) ---------------------

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** ~0.5s per transcript (request + polite delay); round up to a minute. */
export function estimateMinutes(remaining: number): number {
  return Math.max(1, Math.ceil((remaining * 0.5) / 60));
}
