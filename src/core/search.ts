// Presentation-agnostic transcript search: keyword BM25, or hybrid (BM25 +
// semantic vectors fused via Reciprocal Rank Fusion) when semantic is enabled.
// Returns typed rows; the MCP handler and CLI render their own output.
import type { SanaStore } from "../store/db.js";
import { transcriptLines } from "../sana/transcript.js";
import {
  semanticEnabled,
  embedQuery,
  searchKnn,
  SemanticUnavailableError,
} from "../semantic/semantic.js";
import { posInt, parseFilters } from "./args.js";

export interface SearchRow {
  meeting_id: string;
  line_no: number;
  text: string;
  created_at_ms: number;
  name: string;
}

export type SearchSort = "best" | "newest" | "oldest";

export type SearchResult =
  | { kind: "no-query" }
  | { kind: "no-terms"; query: string }
  | { kind: "error"; query: string; message: string }
  | { kind: "semantic-unavailable"; query: string; message: string }
  | {
      kind: "ok";
      query: string;
      anchor: string;
      mode: "keyword" | "hybrid";
      sort: SearchSort;
      rows: SearchRow[];
      total: number;
      page: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };

/** Window of text around the first match, whitespace-collapsed, with ellipses. */
export function snippetAround(text: string, query: string, pad = 80): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, pad * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - pad);
  const end = Math.min(text.length, i + query.length + pad);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${core}${end < text.length ? "..." : ""}`;
}

export async function runSearch(store: SanaStore, args: Record<string, unknown>): Promise<SearchResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { kind: "no-query" };

  // Tokenize into unicode word terms, AND-ed as quoted FTS terms (safe from
  // FTS5 operator syntax; matches whole words).
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return { kind: "no-terms", query };
  const match = terms.map((t) => `"${t}"`).join(" ");
  const anchor = terms[0] ?? query;

  const limit = Math.min(posInt(args.limit, 10), 100);
  const page = posInt(args.page, 1);
  const offset = (page - 1) * limit;
  const sort: SearchSort =
    args.sort === "newest" || args.sort === "oldest" ? args.sort : "best";
  const { dateFrom, dateTo } = parseFilters(args);

  // --- keyword-only (BM25) when semantic search is disabled ---
  if (!semanticEnabled()) {
    let rows: SearchRow[], total: number;
    try {
      total = store.countLineMatches(match, { dateFrom, dateTo });
      rows = store.searchLines(match, { limit, offset, sort, dateFrom, dateTo });
    } catch (e) {
      return { kind: "error", query, message: (e as Error).message };
    }
    return {
      kind: "ok",
      query,
      anchor,
      mode: "keyword",
      sort,
      rows,
      total,
      page,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    };
  }

  // --- hybrid (BM25 + semantic vectors, fused via Reciprocal Rank Fusion) ---
  const POOL = 60;
  const RRF_K = 60;
  let kw: SearchRow[];
  try {
    kw = store.searchLines(match, { limit: POOL, offset: 0, sort: "best", dateFrom, dateTo });
  } catch (e) {
    return { kind: "error", query, message: (e as Error).message };
  }

  const meetingCache = new Map<string, ReturnType<typeof store.getMeeting>>();
  const linesCache = new Map<string, { n: number; text: string }[]>();
  const resolve = (mid: string, ln: number): SearchRow | null => {
    let m = meetingCache.get(mid);
    if (m === undefined) {
      m = store.getMeeting(mid);
      meetingCache.set(mid, m);
    }
    if (!m) return null;
    let lines = linesCache.get(mid);
    if (!lines) {
      const t = store.getTranscript(mid);
      try {
        lines = t ? transcriptLines(JSON.parse(t.json)).map((l) => ({ n: l.n, text: l.text })) : [];
      } catch {
        lines = [];
      }
      linesCache.set(mid, lines);
    }
    const line = lines.find((l) => l.n === ln);
    return line
      ? { meeting_id: mid, line_no: ln, text: line.text, created_at_ms: m.created_at_ms, name: m.name }
      : null;
  };

  const fused = new Map<string, { row: SearchRow; score: number }>();
  const add = (row: SearchRow, rank: number) => {
    const key = `${row.meeting_id}:${row.line_no}`;
    const inc = 1 / (RRF_K + rank);
    const cur = fused.get(key);
    if (cur) cur.score += inc;
    else fused.set(key, { row, score: inc });
  };
  kw.forEach((r, i) => add(r, i));

  try {
    const qv = await embedQuery(query);
    const knn = await searchKnn(store.db, qv, { k: POOL, dateFrom, dateTo });
    knn.forEach((h, i) => {
      const row = resolve(h.meeting_id, h.line_no);
      if (row) add(row, i);
    });
  } catch (e) {
    if (e instanceof SemanticUnavailableError)
      return { kind: "semantic-unavailable", query, message: e.message };
    // Any other embedding error: fall back to the keyword results already fused.
  }

  const itemsAll = [...fused.values()];
  itemsAll.sort((a, b) =>
    sort === "newest"
      ? b.row.created_at_ms - a.row.created_at_ms
      : sort === "oldest"
        ? a.row.created_at_ms - b.row.created_at_ms
        : b.score - a.score
  );
  const total = itemsAll.length;
  const rows = itemsAll.slice(offset, offset + limit).map((x) => x.row);
  return {
    kind: "ok",
    query,
    anchor,
    mode: "hybrid",
    sort,
    rows,
    total,
    page,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}
