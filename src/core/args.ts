// Presentation-agnostic argument coercion, shared by the MCP dispatcher and the
// interactive CLI. No display strings here.
import type { MeetingListOpts } from "../store/db.js";

export class ArgumentValidationError extends Error {
  readonly code = "INVALID_ARGUMENT";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ArgumentValidationError";
  }
}

function owns(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1]!;
}

/** Use the primary default only when the argument is absent. */
export function posInt(v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    throw new ArgumentValidationError(
      "pagination",
      "page and limit must be positive safe integers",
    );
  }
  return v;
}

export function positiveIntegerArgument(
  args: Record<string, unknown>,
  field: string,
  dflt: number,
): number {
  if (!owns(args, field)) return dflt;
  if (args[field] === undefined) {
    throw new ArgumentValidationError(
      field,
      "must be a positive safe integer",
    );
  }
  try {
    return posInt(args[field], dflt);
  } catch (error) {
    if (error instanceof ArgumentValidationError) {
      throw new ArgumentValidationError(
        field,
        "must be a positive safe integer",
      );
    }
    throw error;
  }
}

/** Accept an ISO date/datetime string or an epoch-ms number. */
export function parseDateMs(
  v: unknown,
  endOfDay = false,
  field = "filter.date",
): number | undefined {
  if (v === undefined) return undefined;
  if (
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    Number.isFinite(new Date(v).getTime())
  ) {
    return v;
  }
  if (typeof v === "string") {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
    const dateTime =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        v,
      );
    if (!dateOnly && !dateTime) {
      throw new ArgumentValidationError(
        field,
        "must be an ISO date, an ISO datetime with timezone, or an epoch-ms safe integer",
      );
    }
    const ms = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
    if (
      Number.isNaN(ms) ||
      !validCalendarDate(v) ||
      (dateOnly && new Date(ms).toISOString().slice(0, 10) !== v)
    ) {
      throw new ArgumentValidationError(field, "is not a valid calendar date");
    }
    return endOfDay && dateOnly ? ms + 86_400_000 - 1 : ms;
  }
  throw new ArgumentValidationError(
    field,
    "must be an ISO date, an ISO datetime with timezone, or an epoch-ms safe integer",
  );
}

export interface ParsedFilters {
  status?: MeetingListOpts["status"];
  dateFrom?: number;
  dateTo?: number;
}

export interface ParsedMeetingListArguments {
  page: number;
  limit: number;
  offset: number;
  query?: string;
  sort: NonNullable<MeetingListOpts["sort"]>;
  status?: MeetingListOpts["status"];
  dateFrom?: number;
  dateTo?: number;
}

/** Extract status + date-range filters from a tool's args dict. */
export function parseFilters(args: Record<string, unknown>): ParsedFilters {
  if (!owns(args, "filter")) return {};
  if (
    args.filter === null ||
    typeof args.filter !== "object" ||
    Array.isArray(args.filter)
  ) {
    throw new ArgumentValidationError("filter", "must be an object");
  }
  const filter = args.filter as Record<string, unknown>;
  for (const key of Object.keys(filter)) {
    if (key !== "status" && key !== "date") {
      throw new ArgumentValidationError(
        `filter.${key}`,
        "is not a supported filter",
      );
    }
  }
  let status: MeetingListOpts["status"] | undefined;
  if (owns(filter, "status")) {
    if (
      filter.status !== "ready" &&
      filter.status !== "downloading" &&
      filter.status !== "processing" &&
      filter.status !== "retrying"
    ) {
      throw new ArgumentValidationError(
        "filter.status",
        'must be "ready", "downloading", "processing", or "retrying"',
      );
    }
    status = filter.status;
  }
  if (!owns(filter, "date")) return { status };
  if (
    filter.date === null ||
    typeof filter.date !== "object" ||
    Array.isArray(filter.date)
  ) {
    throw new ArgumentValidationError("filter.date", "must be an object");
  }
  const date = filter.date as Record<string, unknown>;
  for (const key of Object.keys(date)) {
    if (key !== "from" && key !== "to") {
      throw new ArgumentValidationError(
        `filter.date.${key}`,
        "is not a supported date bound",
      );
    }
  }
  if (owns(date, "from") && date.from === undefined) {
    throw new ArgumentValidationError(
      "filter.date.from",
      "must be an ISO date, an ISO datetime with timezone, or an epoch-ms safe integer",
    );
  }
  if (owns(date, "to") && date.to === undefined) {
    throw new ArgumentValidationError(
      "filter.date.to",
      "must be an ISO date, an ISO datetime with timezone, or an epoch-ms safe integer",
    );
  }
  const dateFrom = owns(date, "from")
    ? parseDateMs(date.from, false, "filter.date.from")
    : undefined;
  const dateTo = owns(date, "to")
    ? parseDateMs(date.to, true, "filter.date.to")
    : undefined;
  if (
    dateFrom !== undefined &&
    dateTo !== undefined &&
    dateFrom > dateTo
  ) {
    throw new ArgumentValidationError(
      "filter.date",
      "from must not be later than to",
    );
  }
  return { status, dateFrom, dateTo };
}

export function parseMeetingListArguments(
  args: Record<string, unknown>,
  maxLimit: number,
): ParsedMeetingListArguments {
  const limit = positiveIntegerArgument(args, "limit", 50);
  if (limit > maxLimit) {
    throw new ArgumentValidationError(
      "limit",
      `must not exceed ${maxLimit}`,
    );
  }
  const page = positiveIntegerArgument(args, "page", 1);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset)) {
    throw new ArgumentValidationError(
      "pagination",
      "page and limit produce an unsafe offset",
    );
  }
  let query: string | undefined;
  if (owns(args, "query")) {
    if (typeof args.query !== "string") {
      throw new ArgumentValidationError("query", "must be a string");
    }
    query = args.query;
  }
  let sort: NonNullable<MeetingListOpts["sort"]> = "newest";
  if (owns(args, "sort")) {
    if (args.sort !== "newest" && args.sort !== "oldest") {
      throw new ArgumentValidationError(
        "sort",
        'must be "newest" or "oldest"',
      );
    }
    sort = args.sort;
  }
  const { status, dateFrom, dateTo } = parseFilters(args);
  return {
    page,
    limit,
    offset,
    query,
    sort,
    status,
    dateFrom,
    dateTo,
  };
}

/** meeting id from either `meeting_id` or `id`. */
export function argMeetingId(args: Record<string, unknown>): string {
  const field = owns(args, "meeting_id")
    ? "meeting_id"
    : owns(args, "id")
      ? "id"
      : null;
  if (field === null) return "";
  const value = args[field];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim()
  ) {
    throw new ArgumentValidationError(
      field,
      "must be a non-empty string without surrounding whitespace",
    );
  }
  return value;
}

export interface ReadArguments {
  full: boolean;
  timestamps: boolean;
  lines: readonly [number, number] | null;
}

/** Validate the runtime-open MCP args record without truthiness coercion. */
export function parseReadArguments(
  args: Record<string, unknown>,
): ReadArguments {
  let full = false;
  if (owns(args, "full")) {
    if (typeof args.full !== "boolean") {
      throw new ArgumentValidationError("full", "must be a boolean");
    }
    full = args.full;
  }

  let timestamps = true;
  if (owns(args, "timestamps")) {
    if (typeof args.timestamps !== "boolean") {
      throw new ArgumentValidationError("timestamps", "must be a boolean");
    }
    timestamps = args.timestamps;
  }

  let lines: readonly [number, number] | null = null;
  if (owns(args, "lines")) {
    if (!Array.isArray(args.lines) || args.lines.length !== 2) {
      throw new ArgumentValidationError(
        "lines",
        "must be a two-element [start, end] range",
      );
    }
    const [start, end] = args.lines;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start
    ) {
      throw new ArgumentValidationError(
        "lines",
        "start and end must be positive safe integers with start no greater than end",
      );
    }
    lines = [start, end];
  }
  return { full, timestamps, lines };
}

export function validateSearchArguments(
  args: Record<string, unknown>,
): void {
  if (owns(args, "query") && typeof args.query !== "string") {
    throw new ArgumentValidationError("query", "must be a string");
  }
  const limit = positiveIntegerArgument(args, "limit", 10);
  if (limit > 100) {
    throw new ArgumentValidationError("limit", "must not exceed 100");
  }
  const page = positiveIntegerArgument(args, "page", 1);
  if (!Number.isSafeInteger((page - 1) * limit)) {
    throw new ArgumentValidationError(
      "pagination",
      "page and limit produce an unsafe offset",
    );
  }
  if (
    owns(args, "sort") &&
    args.sort !== "best" &&
    args.sort !== "newest" &&
    args.sort !== "oldest"
  ) {
    throw new ArgumentValidationError(
      "sort",
      'must be "best", "newest", or "oldest"',
    );
  }
  const parsed = parseFilters(args);
  if (parsed.status !== undefined) {
    throw new ArgumentValidationError(
      "filter.status",
      "is not supported by search",
    );
  }
}

// ---- shared time formatting (used by both renderers) ---------------------

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
