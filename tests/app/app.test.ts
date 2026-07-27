import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  meetingBrowserPrompt,
  type MeetingBrowserResult,
} from "../../src/app/browser-prompt.js";
import type { AppRuntime } from "../../src/app/runtime.js";
import {
  TerminalUi,
  createTerminalPolicy,
  stripAnsi,
} from "../../src/app/ui.js";
import type {
  MeetingPage,
  ParticipantsResult,
  RecordingResult,
  SummaryResult,
  TranscriptView,
} from "../../src/core/meetings.js";
import type { StatusInfo } from "../../src/core/status.js";
import type { MeetingListRow } from "../../src/store/db.js";

class TestInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
}

class TestOutput extends PassThrough {
  isTTY = true;
  columns = 60;
  rows = 8;
  readonly chunks: string[] = [];

  constructor() {
    super();
    this.on("data", (chunk) => this.chunks.push(String(chunk)));
  }
}

function status(blocking = false): StatusInfo {
  return {
    session: { hasCookie: true, loggedIn: true, expired: false },
    blocking,
    phase: blocking ? "listing" : "synced",
    transcriptsDone: blocking ? null : 2,
    transcriptsTotal: blocking ? null : 2,
    remaining: blocking ? null : 0,
    etaMinutes: null,
    meetings: blocking ? null : 2,
    transcripts: blocking ? null : 2,
    lastFullSyncMs: null,
    lastIncrementalMs: null,
    daemonHeartbeatMs: null,
    error: null,
    semantic: { enabled: false, embedded: null, total: null },
  };
}

function row(id: string, name = `Meeting ${id}`): MeetingListRow {
  return {
    id,
    name,
    external_id: null,
    source: "sana-ai:meeting",
    created_at_ms: Date.UTC(2026, 0, Number.parseInt(id, 10) || 1),
    modified_at_ms: null,
    first_seen_ms: 1,
    processing_phase: "done",
    has_transcript: 1,
    has_metadata: 1,
    word_count: 1,
    attempts: 0,
  };
}

class FakeRuntime implements AppRuntime {
  currentStatus = status();
  rows: MeetingListRow[] = [row("1"), row("2")];
  meetingCalls: Record<string, unknown>[] = [];
  transcriptIds: string[] = [];
  summaryIds: string[] = [];
  participantIds: string[] = [];
  recordingIds: string[] = [];
  onRefresh?: () => void;

  refresh(): void {
    this.onRefresh?.();
  }

  status(): StatusInfo {
    return this.currentStatus;
  }

  meetings(args: Record<string, unknown>): MeetingPage {
    this.meetingCalls.push(args);
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const rows = query
      ? this.rows.filter((item) => item.name.toLowerCase().includes(query))
      : this.rows;
    return {
      rows,
      total: rows.length,
      page: 1,
      limit: 1000,
      offset: 0,
      hasMore: false,
      filter: query ? { query } : {},
    };
  }

  async search(): Promise<never> {
    throw new Error("not used");
  }

  transcript(id: string): TranscriptView {
    this.transcriptIds.push(id);
    return {
      kind: "ok",
      meeting: null,
      id,
      name: `Transcript ${id}`,
      dateMs: null,
      lineCount: 10,
      wordCount: 10,
      lines: Array.from({ length: 10 }, (_, index) => ({
        n: index + 1,
        timeSec: index,
        time: `00:0${index}`,
        speaker: "Speaker",
        text: `transcript line ${index + 1}`,
      })),
    };
  }

  summary(id: string): SummaryResult {
    this.summaryIds.push(id);
    return {
      kind: "ok",
      view: {
        meeting: null,
        id,
        name: `Summary ${id}`,
        dateMs: null,
        summaryShort: "Short summary",
        summary: null,
        actionItems: [],
        notes: [],
      },
    };
  }

  participants(id: string): ParticipantsResult {
    this.participantIds.push(id);
    return {
      kind: "ok",
      name: `Participants ${id}`,
      participants: [
        { displayName: "Person", email: "person@example.test", isHost: true },
      ],
    };
  }

  async recording(id: string): Promise<RecordingResult> {
    this.recordingIds.push(id);
    return { kind: "ok", name: `Recording ${id}`, url: "https://example.test/r" };
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

function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 12));
}

async function harness(
  runtime = new FakeRuntime(),
  dimensions: { rows?: number; columns?: number } = {},
) {
  const input = new TestInput();
  const output = new TestOutput();
  Object.assign(output, dimensions);
  const ui = new TerminalUi(
    createTerminalPolicy({
      input,
      output,
      env: { NO_COLOR: "", LANG: "C" },
      platform: "linux",
    }),
  );
  const result = meetingBrowserPrompt(
    { runtime, output, ui },
    { input, output },
  );
  await wait();
  return {
    input,
    output,
    runtime,
    result,
    async key(value: string) {
      input.write(value);
      if (value === "\x1b") {
        await new Promise((resolve) => setTimeout(resolve, 550));
      } else {
        await wait();
      }
    },
  };
}

function latestFrame(output: TestOutput, marker: string): string {
  const chunk = [...output.chunks]
    .reverse()
    .map(stripAnsi)
    .find((value) => value.includes(marker));
  if (chunk === undefined) throw new Error(`no rendered frame containing ${marker}`);
  return chunk;
}

test("cache-blocked browser performs no meeting query and refreshes into the list", async () => {
  const runtime = new FakeRuntime();
  runtime.currentStatus = status(true);
  runtime.onRefresh = () => {
    runtime.currentStatus = status(false);
  };
  const app = await harness(runtime);

  expect(runtime.meetingCalls).toHaveLength(0);
  expect(latestFrame(app.output, "preparing meeting cache")).toContain("listing");
  await app.key("r");
  expect(runtime.meetingCalls).toHaveLength(1);
  expect(latestFrame(app.output, "Meetings (2)")).toContain("Meeting 1");
  await app.key("q");
  expect(await app.result).toEqual({ action: "quit" });
});

test("selection dispatches the highlighted meeting to every direct action", async () => {
  const app = await harness();
  await app.key("\x1b[B");
  await app.key("\r");
  expect(app.runtime.transcriptIds).toEqual(["2"]);
  await app.key("\x1b");
  await app.key("s");
  expect(app.runtime.summaryIds).toEqual(["2"]);
  await app.key("\x1b");
  await app.key("p");
  expect(app.runtime.participantIds).toEqual(["2"]);
  await app.key("\x1b");
  await app.key("o");
  expect(app.runtime.recordingIds).toEqual(["2"]);
  await app.key("\x1b");
  await app.key("q");
  expect(await app.result).toEqual({ action: "quit" });
});

test("list and transcript viewports page and clamp within the current rows", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = Array.from({ length: 10 }, (_, index) =>
    row(String(index + 1)),
  );
  const app = await harness(runtime, { rows: 5, columns: 48 });

  await app.key("\x1b[F");
  await app.key("\x1b[5~");
  await app.key("\r");
  expect(runtime.transcriptIds).toEqual(["7"]);
  expect(latestFrame(app.output, "Transcript 7")).toContain("transcript line 1");
  await app.key("\x1b[6~");
  const paged = latestFrame(app.output, "Transcript 7");
  expect(paged).toContain("transcript line 4");
  expect(paged).not.toContain("transcript line 1");
  await app.key("\x1b[F");
  expect(latestFrame(app.output, "Transcript 7")).toContain("transcript line 8");
  await app.key("q");
  await app.result;
});

test("filter input owns shortcut letters until Enter applies the title query", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [row("1", "First"), row("2", "Second")];
  const app = await harness(runtime);

  await app.key("/");
  await app.key("s");
  expect(runtime.summaryIds).toEqual([]);
  await app.key("econd");
  await app.key("\r");
  expect(runtime.meetingCalls.at(-1)).toMatchObject({ query: "second" });
  expect(latestFrame(app.output, "filter: second")).toContain("Second");
  await app.key("/");
  await app.key("ignored");
  await app.key("\x1b");
  expect(runtime.meetingCalls).toHaveLength(2);
  await app.key("q");
  await app.result;
});

test("help scrolls and short-terminal filter input remains visible", async () => {
  const app = await harness(new FakeRuntime(), { rows: 3, columns: 40 });
  await app.key("?");
  expect(latestFrame(app.output, "Keyboard help")).toContain("up/down or j/k");
  await app.key("\x1b[B");
  expect(latestFrame(app.output, "Keyboard help")).toContain("enter/t transcript");
  await app.key("\x1b");

  app.output.rows = 2;
  await app.key("/");
  await app.key("s");
  expect(latestFrame(app.output, "Filter: s")).toContain("enter apply");
  expect(app.runtime.summaryIds).toEqual([]);
  await app.key("\x1b");
  await app.key("q");
  await app.result;
});

test("frames fit terminal rows, sanitize hostile titles, redraw, and clear on typed exits", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [
    row(
      "1",
      "hostile\x1b[2J\nforged\u202e " + "very-long-title-".repeat(8),
    ),
    row("2", "Safe meeting"),
  ];
  const app = await harness(runtime, { rows: 4, columns: 32 });
  const initial = latestFrame(app.output, "Meetings (2)");
  expect(initial.split("\n")).toHaveLength(4);
  expect(initial).not.toContain("\x1b[2J");
  expect(initial).not.toContain("\u202e");
  expect(initial).not.toContain("\nforged");

  const chunksBefore = app.output.chunks.length;
  await app.key("j");
  expect(app.output.chunks.length).toBeGreaterThan(chunksBefore);
  expect(app.output.chunks.slice(chunksBefore).join("")).toContain("\x1b[");
  await app.key("c");
  expect(await app.result).toEqual({ action: "configure" });
  expect(app.output.chunks.join("")).not.toContain("\x1b[?1049h");
  expect(app.input.isRaw).toBe(false);

  for (const [key, action] of [
    ["a", "account"],
    ["q", "quit"],
    ["\x1b", "quit"],
  ] as const) {
    const next = await harness(new FakeRuntime());
    await next.key(key);
    expect(await next.result).toEqual({ action } satisfies MeetingBrowserResult);
    expect(next.input.isRaw).toBe(false);
  }
});
