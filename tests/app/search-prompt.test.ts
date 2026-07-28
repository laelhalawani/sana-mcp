import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  searchPrompt,
  type SearchPromptResult,
} from "../../src/app/search-prompt.js";
import type { AppRuntime } from "../../src/app/runtime.js";
import {
  TerminalUi,
  createTerminalPolicy,
  displayWidth,
  stripAnsi,
} from "../../src/app/ui.js";
import type {
  MeetingPage,
  ParticipantsResult,
  RecordingResult,
  SummaryResult,
  TranscriptView,
} from "../../src/core/meetings.js";
import type {
  SearchResult,
  SearchRow,
  SearchSort,
} from "../../src/core/search.js";
import type { StatusInfo } from "../../src/core/status.js";

class TestInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
}

class TestOutput extends PassThrough {
  isTTY = true;
  columns = 72;
  rows = 14;
  readonly chunks: string[] = [];

  constructor() {
    super();
    this.on("data", (chunk) => this.chunks.push(String(chunk)));
  }
}

function status(): StatusInfo {
  return {
    session: { hasCookie: true, loggedIn: true, expired: false },
    blocking: false,
    phase: "synced",
    transcriptsDone: 5,
    transcriptsTotal: 5,
    remaining: 0,
    etaMinutes: null,
    meetings: 5,
    meetingsTotal: 5,
    retrying: 0,
    message: null,
    transcripts: 5,
    lastFullSyncMs: null,
    lastIncrementalMs: null,
    daemonHeartbeatMs: null,
    error: null,
    semantic: { enabled: true, embedded: 4, total: 5 },
  };
}

function row(
  meeting_id: string,
  name: string,
  line_no = 3,
  text = "The literal query appears in this transcript snippet.",
): SearchRow {
  return {
    meeting_id,
    line_no,
    text,
    created_at_ms: Date.UTC(2026, 0, Number(meeting_id.slice(-1)) || 1),
    name,
  };
}

type OkResult = Extract<SearchResult, { kind: "ok" }>;

function okResult(
  rows: SearchRow[],
  options: {
    query?: string;
    page?: number;
    limit?: number;
    total?: number;
    sort?: SearchSort;
    mode?: "keyword" | "hybrid";
    hasMore?: boolean;
    degradation?: OkResult["degradation"];
  } = {},
): OkResult {
  const query = options.query ?? "query";
  const page = options.page ?? 1;
  const limit = options.limit ?? 10;
  return {
    kind: "ok",
    query,
    anchor: query.match(/[\p{L}\p{N}]+/u)?.[0] ?? query,
    mode: options.mode ?? "hybrid",
    sort: options.sort ?? "best",
    rows,
    total: options.total ?? rows.length,
    page,
    limit,
    offset: (page - 1) * limit,
    hasMore: options.hasMore ?? false,
    ...(options.degradation ? { degradation: options.degradation } : {}),
  };
}

class FakeRuntime implements AppRuntime {
  searchCalls: Record<string, unknown>[] = [];
  searchSignals: AbortSignal[] = [];
  transcriptIds: string[] = [];
  searchHandler: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<SearchResult> = async (args) => {
    const query = String(args.query);
    return okResult([row("m1", "Alpha planning")], { query });
  };

  refresh(): void {}

  status(): StatusInfo {
    return status();
  }

  meetings(): MeetingPage {
    throw new Error("not used");
  }

  search(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    this.searchCalls.push(args);
    if (signal) this.searchSignals.push(signal);
    return this.searchHandler(args, signal);
  }

  transcript(id: string): TranscriptView {
    this.transcriptIds.push(id);
    return {
      kind: "ok",
      meeting: null,
      id,
      name: `Transcript ${id}`,
      dateMs: null,
      lineCount: 20,
      wordCount: 80,
      lines: Array.from({ length: 20 }, (_, index) => ({
        n: index + 1,
        timeSec: index,
        time: `00:${String(index).padStart(2, "0")}`,
        speaker: "Speaker",
        text: `transcript line ${index + 1} with query context`,
      })),
    };
  }

  summary(): SummaryResult {
    throw new Error("not used");
  }

  participants(): ParticipantsResult {
    throw new Error("not used");
  }

  async recording(): Promise<RecordingResult> {
    throw new Error("not used");
  }

  async requestCode(): Promise<never> {
    throw new Error("not used");
  }

  async verifyCode(): Promise<never> {
    throw new Error("not used");
  }

  async configure(): Promise<never> {
    throw new Error("not used");
  }

  close(): void {}
}

function wait(ms = 18): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function harness(
  runtime = new FakeRuntime(),
  dimensions: { rows?: number; columns?: number } = {},
  env: Record<string, string | undefined> = { LANG: "en_US.UTF-8" },
  pageSize = 10,
) {
  const input = new TestInput();
  const output = new TestOutput();
  Object.assign(output, dimensions);
  const ui = new TerminalUi(
    createTerminalPolicy({ input, output, env, platform: "linux" }),
  );
  const result = searchPrompt(
    { runtime, output, ui, pageSize },
    { input, output },
  );
  await wait();
  return {
    input,
    output,
    runtime,
    result,
    async key(value: string): Promise<void> {
      input.write(value);
      await wait(value === "\x1b" ? 550 : 18);
    },
  };
}

function latestFrame(output: TestOutput, marker: string): string {
  const frame = [...output.chunks]
    .reverse()
    .map(stripAnsi)
    .find((chunk) => chunk.includes(marker));
  if (frame === undefined) throw new Error(`no frame contains ${marker}`);
  return frame;
}

function latestRawFrame(output: TestOutput, marker: string): string {
  const frame = [...output.chunks]
    .reverse()
    .find((chunk) => stripAnsi(chunk).includes(marker));
  if (frame === undefined) throw new Error(`no frame contains ${marker}`);
  return frame;
}

describe("searchPrompt", () => {
  test("uses native query editing, treats q as text, and reports hybrid results and coverage", async () => {
    const app = await harness();
    expect(latestFrame(app.output, "Search transcripts")).toContain(
      "semantic index 4/5",
    );

    await app.key("q");
    expect(latestFrame(app.output, "Search transcripts")).toContain("> q");
    expect(app.runtime.searchCalls).toHaveLength(0);
    await app.key("uery");
    await app.key("\r");

    expect(app.runtime.searchCalls).toEqual([
      { query: "query", page: 1, limit: 10, sort: "best" },
    ]);
    expect(
      app.output.chunks.some((chunk) => stripAnsi(chunk).includes("loading")),
    ).toBe(true);
    const frame = latestFrame(app.output, "hybrid | best");
    expect(frame).toContain("Alpha planning");
    expect(frame).toContain("2026-01-01  line 3");
    expect(frame).toContain("literal query appears");
    expect(latestRawFrame(app.output, "hybrid | best")).toContain("\x1b[33mquery\x1b[0m");
    expect(frame).toContain(
      "↑/↓ - navigate | Enter - open | s - sort | q - quit |",
    );

    await app.key("q");
    expect(await app.result).toEqual({ action: "quit" });
    expect(app.input.isRaw).toBe(false);
  });

  test("navigates cards and backend pages, sorts, and returns from a centered transcript without losing selection", async () => {
    const runtime = new FakeRuntime();
    runtime.searchHandler = async (args) => {
      const page = Number(args.page);
      const sort = args.sort as SearchSort;
      return page === 1
        ? okResult(
            [row("m1", "First", 2), row("m2", "Second", 10)],
            { page, limit: 2, total: 3, hasMore: true, sort },
          )
        : okResult([row("m3", "Third", 4)], {
            page,
            limit: 2,
            total: 3,
            sort,
          });
    };
    const app = await harness(runtime, { rows: 14, columns: 76 }, undefined, 2);
    await app.key("query\r");
    await app.key("j");
    expect(latestFrame(app.output, "hybrid | best")).toMatch(/[>❯] Second/u);

    await app.key("\r");
    expect(runtime.transcriptIds).toEqual(["m2"]);
    const transcript = latestFrame(app.output, "Transcript m2");
    expect(transcript).toContain("10 [00:09]");
    expect(transcript).not.toContain("1 [00:00]");

    await app.key("\x1b");
    expect(latestFrame(app.output, "hybrid | best")).toMatch(/[>❯] Second/u);
    await app.key("]");
    expect(runtime.searchCalls.at(-1)).toMatchObject({ page: 2, sort: "best" });
    expect(latestFrame(app.output, "page 2/2")).toContain("Third");
    await app.key("[");
    expect(runtime.searchCalls.at(-1)).toMatchObject({ page: 1, sort: "best" });
    await app.key("s");
    expect(runtime.searchCalls.at(-1)).toMatchObject({ page: 1, sort: "newest" });
    expect(latestFrame(app.output, "hybrid | newest")).toContain("First");

    await app.key("q");
    await app.result;
  });

  test("invalidates an in-flight search when Escape returns to query editing", async () => {
    const runtime = new FakeRuntime();
    const pending: Array<{
      resolve(value: SearchResult): void;
      reject(error: unknown): void;
    }> = [];
    runtime.searchHandler = (args) =>
      new Promise<SearchResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    const app = await harness(runtime);

    await app.key("first\r");
    expect(latestFrame(app.output, "loading")).toContain("first");
    await app.key("\x1b");
    expect(latestFrame(app.output, "Search transcripts")).toContain("> first");
    await app.key("\x15second\r");
    expect(runtime.searchCalls).toHaveLength(2);

    pending[1]!.resolve(okResult([row("m2", "Fresh result")], { query: "second" }));
    await wait();
    expect(latestFrame(app.output, "hybrid | best")).toContain("Fresh result");
    pending[0]!.resolve(okResult([row("m1", "Stale result")], { query: "first" }));
    await wait();
    const latest = latestFrame(app.output, "hybrid | best");
    expect(latest).toContain("Fresh result");
    expect(latest).not.toContain("Stale result");

    await app.key("q");
    await app.result;
  });

  test("aborts an in-flight search before quitting", async () => {
    const runtime = new FakeRuntime();
    runtime.searchHandler = async (_args, signal) =>
      new Promise<SearchResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const app = await harness(runtime);

    await app.key("query\r");
    expect(runtime.searchSignals).toHaveLength(1);
    expect(runtime.searchSignals[0]!.aborted).toBe(false);
    await app.key("q");

    expect(runtime.searchSignals[0]!.aborted).toBe(true);
    expect(await app.result).toEqual({ action: "quit" });
  });

  test("renders degraded, empty, typed-error, thrown-error, and retry states honestly", async () => {
    const runtime = new FakeRuntime();
    const responses: Array<SearchResult | Error> = [
      okResult([row("m1", "Keyword match")], {
        mode: "keyword",
        degradation: {
          code: "SEMANTIC_RUNTIME_UNAVAILABLE",
          message: "model files are unavailable",
          cause: {
            kind: "ERROR",
            name: "SemanticUnavailableError",
            message: "model files are unavailable",
          },
        },
      }),
      { kind: "no-terms", query: "!!!" },
      okResult([], { query: "none", total: 0 }),
      { kind: "error", query: "none", message: "database read failed" },
      new Error("worker crashed"),
    ];
    runtime.searchHandler = async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("missing test response");
      return next;
    };
    const app = await harness(runtime);

    await app.key("query\r");
    const degraded = latestFrame(app.output, "degraded keyword");
    expect(degraded).toContain("SEMANTIC_RUNTIME_UNAVAILABLE");
    expect(degraded).toContain("model files are un");

    await app.key("e");
    await app.key("\x15!!!\r");
    expect(latestFrame(app.output, "empty query")).toContain(
      "Enter at least one word",
    );
    await app.key("/");
    await app.key("\x15none\r");
    expect(latestFrame(app.output, "hybrid | best")).toContain(
      'No transcript matches for "none"',
    );
    await app.key("r");
    expect(latestFrame(app.output, "| error")).toContain("database read failed");
    await app.key("r");
    expect(latestFrame(app.output, "| error")).toContain("worker crashed");

    await app.key("q");
    await app.result;
  });

  test("sanitizes hostile cards, remains bounded in narrow layouts, and cleans up every exit", async () => {
    const runtime = new FakeRuntime();
    runtime.searchHandler = async () =>
      okResult([
        row(
          "m1",
          "hostile\x1b[2J\nforged\u202e title",
          7,
          "query \x1b]8;;https://evil.test\u0007click\x1b]8;;\u0007 " +
            "longword".repeat(12),
        ),
      ]);
    const app = await harness(
      runtime,
      { rows: 5, columns: 18 },
      { NO_COLOR: "", LANG: "C" },
    );
    await app.key("query\r");
    const frame = latestFrame(app.output, "hostile").replaceAll("\r", "");
    expect(frame).not.toContain("\x1b[2J");
    expect(frame).not.toContain("\u202e");
    expect(frame).not.toContain("\nforged");
    for (const line of frame.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(17);
    }
    expect(app.output.chunks.join("")).not.toContain("\x1b[?1049h");

    await app.key("\x1b");
    expect(latestFrame(app.output, "> query")).toContain("> query");
    await app.key("\x1b");
    expect(await app.result).toEqual({ action: "back" });
    expect(app.input.isRaw).toBe(false);

    for (const key of ["q", "\x03"] as const) {
      const next = await harness();
      await next.key("query\r");
      await next.key(key);
      expect(await next.result).toEqual({
        action: "quit",
      } satisfies SearchPromptResult);
      expect(next.input.isRaw).toBe(false);
      expect(next.output.chunks.join("")).not.toContain("\x1b[?1049h");
    }
  });

  test("renders transcript availability and thrown failures as sanitized returnable views", async () => {
    const runtime = new FakeRuntime();
    runtime.transcript = () => ({
      kind: "not-downloaded",
      name: "Pending transcript",
      done: 2,
      total: 5,
    });
    const app = await harness(runtime);
    await app.key("query\r");
    await app.key("\r");
    expect(latestFrame(app.output, "Pending transcript")).toContain(
      "Transcript is downloading (2/5)",
    );

    await app.key("\x1b");
    runtime.transcript = () => {
      throw new Error("failed\x1b[2J\nforged\u202e detail");
    };
    await app.key("\r");
    const failed = latestFrame(app.output, "Transcript failed");
    expect(failed).toContain("failed forged detail");
    expect(failed).not.toContain("\x1b[2J");
    expect(failed).not.toContain("\u202e");
    await app.key("\x1b");
    expect(latestFrame(app.output, "hybrid | best")).toContain("Alpha planning");

    await app.key("q");
    await app.result;
  });

  test("keeps native input visible in a one-row terminal", async () => {
    const app = await harness(new FakeRuntime(), { rows: 1, columns: 12 });
    await app.key("q");
    expect(latestFrame(app.output, "> q")).toContain("> q");
    await app.key("\x1b");
    expect(await app.result).toEqual({ action: "back" });
  });

  test("handles burst transcript navigation without losing later input", async () => {
    const runtime = new FakeRuntime();
    runtime.transcript = (id): TranscriptView => ({
      kind: "ok",
      meeting: null,
      id,
      name: "Long transcript",
      dateMs: null,
      lineCount: 500,
      wordCount: 2_000,
      lines: Array.from({ length: 500 }, (_, index) => ({
        n: index + 1,
        timeSec: index,
        time: `00:${String(index).padStart(2, "0")}`,
        speaker: "Speaker",
        text: `transcript line ${index + 1} with query context`,
      })),
    });
    const app = await harness(runtime, { rows: 10, columns: 76 });

    await app.key("query\r");
    await app.key("\r");
    await app.key("\x1b[B".repeat(40));
    expect(latestFrame(app.output, "Long transcript")).toContain(
      "transcript line 41",
    );

    await app.key("j".repeat(100));
    await app.key("q");
    expect(await app.result).toEqual({ action: "quit" });
  });
});
