// Presentation-agnostic transcript search: keyword BM25, or hybrid (BM25 +
// semantic vectors fused via Reciprocal Rank Fusion) when semantic is enabled.
// Returns typed rows; the MCP handler and CLI render their own output.
import {
  CacheOperationChangedError,
  type CacheOperationGuard,
  type SanaStore,
} from "../store/db.js";
import {
  semanticCapabilityState,
  embedQuery,
  searchKnn,
  SemanticUnavailableError,
  type SemanticHit,
} from "../semantic/semantic.js";
import type { SemanticCapabilityState } from "../semantic/semantic.js";
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
      degradation?:
        | {
            code: "SEMANTIC_CAPABILITY_UNAVAILABLE";
            message: string;
          }
        | {
            code: "SEMANTIC_RUNTIME_UNAVAILABLE" | "SEMANTIC_RUNTIME_ERROR";
            message?: string;
            cause:
              | { kind: "ERROR"; name: string; message: string }
              | { kind: "UNKNOWN_THROWN_VALUE" };
          };
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

export interface SearchRuntimeOverrides {
  /** @internal Deterministic semantic-failure injection for runtime tests. */
  readonly semanticState?: SemanticCapabilityState;
  readonly embedQuery?: typeof embedQuery;
  readonly searchKnn?: typeof searchKnn;
  readonly guard?: CacheOperationGuard;
  readonly signal?: AbortSignal;
}

export async function runSearch(
  store: SanaStore,
  args: Record<string, unknown>,
  runtime: SearchRuntimeOverrides = {},
): Promise<SearchResult> {
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
  const semanticState = runtime.semanticState ?? semanticCapabilityState();
  const useSemantic = semanticState.kind === "available";
  const checkpoint = (): void => {
    runtime.signal?.throwIfAborted();
    if (runtime.guard) store.assertCacheOperation(runtime.guard);
  };
  const fence = <Value>(operation: () => Value): Value =>
    runtime.guard
      ? store.withCacheOperation(runtime.guard, operation)
      : operation();
  const runKeyword = (
    degradation?: Extract<SearchResult, { kind: "ok" }>["degradation"],
  ): SearchResult => {
    try {
      const read = (): readonly [number, SearchRow[]] => [
        store.countLineMatches(match, { dateFrom, dateTo }),
        store.searchLines(match, {
          limit,
          offset,
          sort,
          dateFrom,
          dateTo,
        }),
      ];
      const [total, rows] = runtime.guard
        ? store.withCacheOperation(runtime.guard, read)
        : read();
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
        ...(degradation ? { degradation } : {}),
      };
    } catch (e) {
      if (e instanceof CacheOperationChangedError) throw e;
      return { kind: "error", query, message: (e as Error).message };
    }
  };
  if (!useSemantic) {
    return runKeyword(
      semanticState.kind === "unsupported"
        ? {
            code: "SEMANTIC_CAPABILITY_UNAVAILABLE",
            message: semanticState.message,
          }
        : undefined,
    );
  }

  // --- hybrid (BM25 + thematic chunks + detail chunks) --------------------
  const POOL = Math.min(300, Math.max(60, offset + limit * 3));
  const RRF_K = 60;
  let kw: SearchRow[];
  try {
    checkpoint();
    const read = () =>
      store.searchLines(match, {
        limit: POOL,
        offset: 0,
        sort: "best",
        dateFrom,
        dateTo,
        fusionPool: true,
      });
    kw = runtime.guard
      ? store.withCacheOperation(runtime.guard, read)
      : read();
  } catch (e) {
    if (e instanceof CacheOperationChangedError) throw e;
    if (runtime.signal?.aborted) throw runtime.signal.reason;
    return { kind: "error", query, message: (e as Error).message };
  }

  type Source = "bm25" | "large" | "small";
  interface Candidate {
    meetingId: string;
    lineNo: number;
    row: SearchRow | null;
    ranks: Partial<Record<Source, number>>;
  }
  const fused = new Map<string, Candidate>();
  const byMeeting = new Map<string, Set<number>>();
  const candidate = (meetingId: string, lineNo: number): Candidate => {
    const key = `${meetingId}:${lineNo}`;
    let current = fused.get(key);
    if (current === undefined) {
      current = { meetingId, lineNo, row: null, ranks: {} };
      fused.set(key, current);
      const lines = byMeeting.get(meetingId) ?? new Set<number>();
      lines.add(lineNo);
      byMeeting.set(meetingId, lines);
    }
    return current;
  };
  const add = (
    meetingId: string,
    lineNo: number,
    source: Source,
    rank: number,
    row?: SearchRow,
  ): void => {
    const current = candidate(meetingId, lineNo);
    const previous = current.ranks[source];
    if (previous === undefined || rank < previous) current.ranks[source] = rank;
    if (row !== undefined) current.row = row;
  };
  kw.forEach((row, index) =>
    add(row.meeting_id, row.line_no, "bm25", index + 1, row)
  );

  const project = (hit: SemanticHit, source: "large" | "small", rank: number): void => {
    const targets = [...(byMeeting.get(hit.meeting_id) ?? [])].filter(
      (lineNo) => lineNo >= hit.start_line && lineNo <= hit.end_line,
    );
    if (targets.length === 0) targets.push(hit.start_line);
    for (const lineNo of targets) add(hit.meeting_id, lineNo, source, rank);
  };

  try {
    checkpoint();
    const qv = await (runtime.embedQuery ?? embedQuery)(query, runtime.signal);
    checkpoint();
    const semanticSearch = runtime.searchKnn ?? searchKnn;
    const small = await semanticSearch(
      store.db,
      qv,
      { k: POOL, kind: "small", dateFrom, dateTo, fence, signal: runtime.signal },
    );
    checkpoint();
    small.forEach((hit, index) => project(hit, "small", index + 1));
    const large = await semanticSearch(
      store.db,
      qv,
      { k: POOL, kind: "large", dateFrom, dateTo, fence, signal: runtime.signal },
    );
    checkpoint();
    large.forEach((hit, index) => project(hit, "large", index + 1));

    const unresolved = [...fused.values()]
      .filter((item) => item.row === null)
      .map((item) => ({ meeting_id: item.meetingId, line_no: item.lineNo }));
    const resolveRows = () => store.resolveSearchLines(unresolved);
    const resolved = runtime.guard
      ? store.withCacheOperation(runtime.guard, resolveRows)
      : resolveRows();
    for (const row of resolved) {
      candidate(row.meeting_id, row.line_no).row = row;
    }
  } catch (e) {
    if (e instanceof CacheOperationChangedError) throw e;
    if (runtime.signal?.aborted) throw runtime.signal.reason;
    const cause =
      e instanceof Error
        ? { kind: "ERROR" as const, name: e.name, message: e.message }
        : { kind: "UNKNOWN_THROWN_VALUE" as const };
    return runKeyword({
      code:
        e instanceof SemanticUnavailableError
          ? "SEMANTIC_RUNTIME_UNAVAILABLE"
          : "SEMANTIC_RUNTIME_ERROR",
      ...(e instanceof Error ? { message: e.message } : {}),
      cause,
    });
  }

  const evidenceTier = (ranks: Candidate["ranks"]): number => {
    const bm25 = ranks.bm25 !== undefined;
    const large = ranks.large !== undefined;
    const small = ranks.small !== undefined;
    if (bm25 && large && small) return 4;
    if (large && small) return 3;
    if (bm25 && large) return 2;
    if (bm25 && small) return 1;
    return 0;
  };
  const score = (ranks: Candidate["ranks"]): number =>
    Object.values(ranks).reduce(
      (total, rank) => total + 1 / (RRF_K + rank),
      0,
    );
  const bestRank = (ranks: Candidate["ranks"]): number =>
    Math.min(...Object.values(ranks));
  const itemsAll = [...fused.values()]
    .filter((item): item is Candidate & { row: SearchRow } => item.row !== null)
    .map((item) => ({
      ...item,
      tier: evidenceTier(item.ranks),
      score: score(item.ranks),
      bestRank: bestRank(item.ranks),
    }));
  itemsAll.sort((a, b) =>
    sort === "newest"
      ? b.row.created_at_ms - a.row.created_at_ms
      : sort === "oldest"
        ? a.row.created_at_ms - b.row.created_at_ms
        : b.tier - a.tier ||
          b.score - a.score ||
          a.bestRank - b.bestRank ||
          b.row.created_at_ms - a.row.created_at_ms ||
          a.row.meeting_id.localeCompare(b.row.meeting_id) ||
          a.row.line_no - b.row.line_no
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
