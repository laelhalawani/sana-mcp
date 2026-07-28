import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  meetingBrowserPrompt,
  type MeetingBrowserResult,
} from "../../src/app/browser-prompt.js";
import { runApp } from "../../src/app/app.js";
import {
  TerminalAppPrompts,
  type AppPrompts,
} from "../../src/app/prompts.js";
import { syncStatusPrompt } from "../../src/app/status-prompt.js";
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
import { rowStatus } from "../../src/core/meetings.js";
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
    meetingsTotal: blocking ? null : 2,
    retrying: blocking ? null : 0,
    message: blocking ? "Discovering meetings." : "Up to date.",
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
    last_error: null,
    last_attempt_ms: null,
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
    const statusFilter =
      args.filter && typeof args.filter === "object"
        ? (args.filter as { status?: string }).status
        : undefined;
    let rows = query
      ? this.rows.filter((item) => item.name.toLowerCase().includes(query))
      : this.rows;
    if (statusFilter) {
      rows = rows.filter((item) => rowStatus(item) === statusFilter);
    }
    return {
      rows,
      total: rows.length,
      page: 1,
      limit: 1000,
      offset: 0,
      hasMore: false,
      filter: {
        ...(query ? { query } : {}),
        ...(statusFilter ? { status: statusFilter as never } : {}),
      },
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
  env: Record<string, string | undefined> = { NO_COLOR: "", LANG: "C" },
) {
  const input = new TestInput();
  const output = new TestOutput();
  Object.assign(output, dimensions);
  const ui = new TerminalUi(
    createTerminalPolicy({
      input,
      output,
      env,
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
  expect(latestFrame(app.output, "Meetings | 2 ready")).toContain("Meeting 1");
  await app.key("q");
  expect(await app.result).toEqual({ action: "quit" });
});

test("Enter opens meeting actions while t, s, and p remain direct shortcuts", async () => {
  const app = await harness();
  await app.key("\x1b[B");
  await app.key("\r");
  const actions = latestFrame(app.output, "Meeting 2");
  expect(actions).toContain("Transcript");
  expect(actions).toContain("Summary");
  expect(actions).toContain("Participants");
  await app.key("\r");
  expect(app.runtime.transcriptIds).toEqual(["2"]);
  await app.key("\x1b");
  await app.key("t");
  expect(app.runtime.transcriptIds).toEqual(["2", "2"]);
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

test("meeting actions retain their original meeting across list refresh", async () => {
  const runtime = new FakeRuntime();
  const app = await harness(runtime);
  await app.key("\x1b[B");
  await app.key("\r");
  expect(latestFrame(app.output, "Meeting 2")).toContain("Summary");
  runtime.onRefresh = () => {
    runtime.rows = [row("1")];
  };
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await app.key("s");
  expect(runtime.summaryIds).toEqual(["2"]);
  await app.key("q");
  await app.result;
});

test("list and transcript viewports page and clamp within the current rows", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = Array.from({ length: 10 }, (_, index) =>
    row(String(index + 1)),
  );
  const app = await harness(runtime, { rows: 5, columns: 120 });
  expect(latestFrame(app.output, "Meetings | 2 ready")).toContain(
    "PgUp/PgDn page",
  );

  await app.key("\x1b[F");
  await app.key("\x1b[5~");
  await app.key("\r");
  expect(latestFrame(app.output, "Meeting 7")).toContain("Transcript");
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
  expect(latestFrame(app.output, "Filter meetings")).toContain(
    "Type part of a meeting title",
  );
  await app.key("s");
  expect(runtime.summaryIds).toEqual([]);
  await app.key("econd");
  await app.key("\r");
  expect(runtime.meetingCalls.at(-1)).toMatchObject({ query: "second" });
  expect(latestFrame(app.output, "name: second")).toContain("Second");
  await app.key("/");
  await app.key("ignored");
  const callsAfterApply = runtime.meetingCalls.length;
  await app.key("\x1b");
  expect(
    runtime.meetingCalls
      .slice(callsAfterApply)
      .every((args) => args.query === "second"),
  ).toBe(true);
  await app.key("c");
  expect(runtime.meetingCalls.at(-1)).not.toHaveProperty("query");
  expect(latestFrame(app.output, "Meetings | 2 ready")).not.toContain("name:");
  await app.key("q");
  await app.result;
});

test("automatic refresh pauses while the name filter is being typed", async () => {
  const runtime = new FakeRuntime();
  const app = await harness(runtime);
  await app.key("/");
  await app.key("weekly review");
  const calls = runtime.meetingCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  expect(runtime.meetingCalls).toHaveLength(calls);
  expect(latestFrame(app.output, "Filter meetings")).toContain("weekly review");
  await app.key("\x1b");
  await app.key("q");
  await app.result;
});

test("help scrolls and short-terminal filter input remains visible", async () => {
  const app = await harness(new FakeRuntime(), { rows: 3, columns: 40 });
  await app.key("?");
  expect(latestFrame(app.output, "Keyboard help")).toContain("up/down or j/k");
  await app.key("\x1b[B");
  expect(latestFrame(app.output, "Keyboard help")).toContain(
    "enter meeting actions",
  );
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
  const initial = latestFrame(app.output, "Meetings | 2 ready");
  expect(initial.split("\n")).toHaveLength(4);
  expect(initial).not.toContain("\x1b[2J");
  expect(initial).not.toContain("\u202e");
  expect(initial).not.toContain("\nforged");

  const chunksBefore = app.output.chunks.length;
  await app.key("j");
  expect(app.output.chunks.length).toBeGreaterThan(chunksBefore);
  expect(app.output.chunks.slice(chunksBefore).join("")).toContain("\x1b[");
  await app.key("\x1b");
  expect(await app.result).toEqual({ action: "back" });
  expect(app.output.chunks.join("")).not.toContain("\x1b[?1049h");
  expect(app.input.isRaw).toBe(false);

  for (const [key, action] of [
    ["q", "quit"],
    ["\x03", "quit"],
    ["\x1b", "back"],
  ] as const) {
    const next = await harness(new FakeRuntime());
    await next.key(key);
    expect(await next.result).toEqual({ action } satisfies MeetingBrowserResult);
    expect(next.input.isRaw).toBe(false);
  }
});

test("name and status filters combine and clear together", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [
    row("1", "Weekly ready"),
    {
      ...row("2", "Weekly retry"),
      has_metadata: 0,
      attempts: 2,
      last_error: "participants unavailable",
      last_attempt_ms: Date.UTC(2026, 0, 2),
    },
    { ...row("3", "Other retry"), has_metadata: 0, attempts: 1 },
  ];
  const app = await harness(runtime, { rows: 10, columns: 72 });
  await app.key("/");
  await app.key("weekly");
  await app.key("\r");
  await app.key("f");
  expect(latestFrame(app.output, "Filter meetings by status")).toContain(
    "All statuses",
  );
  for (let index = 0; index < 4; index++) await app.key("\x1b[B");
  await app.key("\r");
  expect(runtime.meetingCalls.at(-1)).toMatchObject({
    query: "weekly",
    filter: { status: "retrying" },
  });
  const filtered = latestFrame(app.output, "status: retrying");
  expect(filtered).toContain("Weekly retry");
  expect(filtered).not.toContain("Weekly ready");
  await app.key("c");
  expect(runtime.meetingCalls.at(-1)).not.toHaveProperty("query");
  expect(runtime.meetingCalls.at(-1)).not.toHaveProperty("filter");
  await app.key("q");
  await app.result;
});

test("retrying meeting details show sequential queue timing and the actual error", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [
    {
      ...row("1", "Retrying meeting"),
      has_metadata: 0,
      attempts: 2,
      last_error: "participant display name was missing",
      last_attempt_ms: Date.UTC(2026, 0, 1, 12),
    },
  ];
  const app = await harness(runtime, { rows: 10, columns: 72 });
  await app.key("d");
  const frame = latestFrame(app.output, "Sync details");
  expect(frame).toContain("Status: retrying");
  expect(frame).toContain("Metadata: missing");
  expect(frame).toContain("Queue: meetings are processed one at a time.");
  expect(frame).toContain("Attempts: 2");
  expect(frame).toContain("Retry eligibility: ready now");
  expect(frame).toContain("participant display name was missing");
  await app.key("q");
  await app.result;
});

test("q exits the in-browser status view after automatic refresh", async () => {
  const app = await harness();
  await app.key("i");
  expect(latestFrame(app.output, "Sync status")).toContain(
    "access is checked before",
  );
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await app.key("q");
  expect(await app.result).toEqual({ action: "quit" });
  expect(app.input.isRaw).toBe(false);
});

test("short status filter picker keeps the active choice visible", async () => {
  const app = await harness(new FakeRuntime(), { rows: 3, columns: 40 });
  await app.key("f");
  for (let index = 0; index < 4; index++) await app.key("\x1b[B");
  const frame = latestFrame(app.output, "Filter meetings by status (5/5)");
  expect(frame).toContain("retrying");
  await app.key("\r");
  expect(app.runtime.meetingCalls.at(-1)).toMatchObject({
    filter: { status: "retrying" },
  });
  expect(latestFrame(app.output, "status: retrying")).toContain(
    "No meetings match the current",
  );
  await app.key("q");
  await app.result;
});

test("meeting browser polls and redraws changing sync status", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [
    {
      ...row("1"),
      has_metadata: 0,
      attempts: 1,
    },
  ];
  runtime.currentStatus = {
    ...status(),
    phase: "downloading",
    meetings: 0,
    meetingsTotal: 1,
    remaining: 1,
    retrying: 1,
    message: "1 meeting pending.",
  };
  runtime.onRefresh = () => {
    runtime.rows = [row("1")];
    runtime.currentStatus = {
      ...status(),
      meetings: 1,
      meetingsTotal: 1,
      transcriptsDone: 1,
      transcriptsTotal: 1,
      transcripts: 1,
    };
  };
  const app = await harness(runtime);
  expect(latestFrame(app.output, "0 ready")).toContain("retrying");
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  expect(latestFrame(app.output, "1 ready")).toContain("ready");
  await app.key("q");
  await app.result;
});

test("meeting browser colors selection and artifact statuses in color terminals", async () => {
  const runtime = new FakeRuntime();
  runtime.rows = [
    row("1", "Ready"),
    { ...row("2", "Retrying"), has_metadata: 0, attempts: 1 },
  ];
  const app = await harness(runtime, {}, { LANG: "en_US.UTF-8" });
  const frame = [...app.output.chunks]
    .reverse()
    .find((chunk) => chunk.includes("Meetings |"));
  expect(frame).toContain("\x1b[36m");
  expect(frame).toContain("\x1b[32m");
  expect(frame).toContain("\x1b[33m");
  await app.key("q");
  await app.result;
});

test("participant detail uses an authoritative email when display name is absent", async () => {
  const runtime = new FakeRuntime();
  runtime.participants = () => ({
    kind: "ok",
    name: "Participants",
    participants: [
      { email: "unnamed@example.test", isHost: false },
      { isHost: true },
    ],
  });
  const app = await harness(runtime);
  await app.key("p");
  const frame = latestFrame(app.output, "Participants");
  expect(frame).toContain("unnamed@example.test");
  expect(frame).toContain("Unnamed participant  (host)");
  expect(frame).not.toContain("undefined");
  await app.key("q");
  await app.result;
});

test("signed-in app starts at the menu and returns there from meetings", async () => {
  const runtime = new FakeRuntime();
  const selected: string[][] = [];
  let selects = 0;
  const prompts: AppPrompts = {
    interactive: true,
    select: async (options) => {
      selected.push(options.choices.map((choice) => choice.name));
      return (selects++ === 0 ? "list" : "quit") as never;
    },
    input: async () => "",
    meetingBrowser: async () => ({ action: "back" }),
    syncStatus: async () => ({ action: "back" }),
  };

  await runApp(runtime, prompts);
  expect(selected[0]).toEqual([
    "Meetings",
    "Search transcripts",
    "Sync status",
    "Sana account",
    "Configuration",
    "Quit",
  ]);
  expect(selected).toHaveLength(2);
});

test("signed-in menu does not offer transcript search while cache access is blocked", async () => {
  const runtime = new FakeRuntime();
  runtime.currentStatus = status(true);
  let choices: string[] = [];
  const prompts: AppPrompts = {
    interactive: true,
    select: async (options) => {
      choices = options.choices.map((choice) => choice.name);
      return "quit" as never;
    },
    input: async () => "",
    meetingBrowser: async () => ({ action: "back" }),
    syncStatus: async () => ({ action: "back" }),
  };
  await runApp(runtime, prompts);
  expect(choices).not.toContain("Search transcripts");
  expect(choices).toContain("Meetings (syncing)");
  expect(choices).toContain("Sync status");
});

test("signed-in account screen is inspectable and Back never starts login", async () => {
  const runtime = new FakeRuntime();
  const messages: string[] = [];
  let selects = 0;
  let inputCalls = 0;
  const prompts: AppPrompts = {
    interactive: true,
    select: async (options) => {
      messages.push(options.message);
      const result = selects === 0 ? "login" : selects === 1 ? "back" : "quit";
      selects++;
      return result as never;
    },
    input: async () => {
      inputCalls++;
      return null;
    },
    meetingBrowser: async () => ({ action: "back" }),
    syncStatus: async () => ({ action: "back" }),
  };
  await runApp(runtime, prompts);
  expect(messages).toContain("Sana account - signed in");
  expect(inputCalls).toBe(0);
  expect(selects).toBe(3);
});

test("text entry stays visible and supports submit or Escape back", async () => {
  for (const action of ["submit", "back"] as const) {
    const input = new TestInput();
    const output = new TestOutput();
    const prompts = new TerminalAppPrompts({
      input,
      output,
      env: { NO_COLOR: "", LANG: "C" },
      platform: "win32",
    });
    const result = prompts.input("Search transcripts");
    await wait();
    input.write("weekly review");
    await wait();
    expect(latestFrame(output, "Search transcripts")).toContain(
      "> weekly review",
    );
    input.write(action === "submit" ? "\r" : "\x1b");
    expect(await result).toBe(action === "submit" ? "weekly review" : null);
    expect(input.isRaw).toBe(false);
  }
});

test("text entry keeps long pasted input visible and submits it intact", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.columns = 20;
  const prompts = new TerminalAppPrompts({
    input,
    output,
    env: { NO_COLOR: "", LANG: "C" },
    platform: "win32",
  });
  const expected = `${"long-search-".repeat(8)}END`;
  const result = prompts.input("Search transcripts");
  await wait();
  input.write(expected);
  await wait();
  expect(
    latestFrame(output, "Search transcripts").replaceAll("\n", ""),
  ).toContain("END");
  input.write("\r");
  expect(await result).toBe(expected);
  expect(input.isRaw).toBe(false);
});

test("text entry preserves native cursor editing and grapheme backspace", async () => {
  const makePrompt = () => {
    const input = new TestInput();
    const output = new TestOutput();
    const prompts = new TerminalAppPrompts({
      input,
      output,
      env: { NO_COLOR: "", LANG: "en_US.UTF-8" },
      platform: "win32",
    });
    return { input, result: prompts.input("Search transcripts") };
  };

  const edited = makePrompt();
  await wait();
  edited.input.write("ac\x1b[Db\r");
  expect(await edited.result).toBe("abc");

  const grapheme = makePrompt();
  await wait();
  grapheme.input.write("👨‍👩‍👧‍👦\x7f\r");
  expect(await grapheme.result).toBe("");
});

test("setup status keeps live-sync exit guidance visible", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const ui = new TerminalUi(
    createTerminalPolicy({
      input,
      output,
      env: { NO_COLOR: "", LANG: "C" },
      platform: "win32",
    }),
  );
  const result = syncStatusPrompt(
    {
      getStatus: () => ({
        ...status(),
        phase: "downloading",
        meetings: 1,
        meetingsTotal: 2,
        remaining: 1,
        retrying: 1,
        message: "Downloading meetings.",
      }),
      output,
      ui,
      mode: "setup",
      setup: { connectedClients: 2, signedIn: true },
    },
    { input, output },
  );
  await wait();
  const frame = latestFrame(output, "sana-mcp setup");
  expect(frame).toContain("AI clients  2 connected");
  expect(frame).toContain(
    "Enter finish setup - sync continues in the background",
  );
  input.write("\r");
  expect(await result).toEqual({ action: "back" });
  expect(input.isRaw).toBe(false);
});

test("colored setup status never exceeds a narrow terminal width", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.columns = 30;
  output.rows = 8;
  const ui = new TerminalUi(
    createTerminalPolicy({
      input,
      output,
      env: { LANG: "en_US.UTF-8" },
      platform: "win32",
    }),
  );
  const result = syncStatusPrompt(
    {
      getStatus: () => ({
        ...status(),
        phase: "downloading",
        meetings: 139,
        meetingsTotal: 238,
        remaining: 99,
        retrying: 99,
        message: "Downloading a very long meeting synchronization status.",
      }),
      output,
      ui,
      mode: "setup",
      setup: { connectedClients: 20, signedIn: true },
    },
    { input, output },
  );
  await wait();
  const frame = [...output.chunks]
    .reverse()
    .find((chunk) => stripAnsi(chunk).includes("sana-mcp setup"));
  expect(frame).toBeDefined();
  for (const line of frame!.split("\n")) {
    expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(29);
  }
  input.write("\r");
  await result;
});

test("short setup status prioritizes sync state over configuration rows", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  output.columns = 40;
  output.rows = 4;
  const ui = new TerminalUi(
    createTerminalPolicy({
      input,
      output,
      env: { NO_COLOR: "", LANG: "C" },
      platform: "win32",
    }),
  );
  const result = syncStatusPrompt(
    {
      getStatus: () => ({
        ...status(),
        phase: "downloading",
        meetings: 1,
        meetingsTotal: 2,
        remaining: 1,
      }),
      output,
      ui,
      mode: "setup",
      setup: { connectedClients: 2, signedIn: true },
    },
    { input, output },
  );
  await wait();
  expect(latestFrame(output, "sana-mcp setup")).toContain("Syncing meetings");
  input.write("\r");
  await result;
});

test("live status never claims signed-in access during auth failure", async () => {
  for (const currentStatus of [
    {
      ...status(),
      session: { hasCookie: true, loggedIn: false, expired: true },
      phase: "needs_login" as const,
      blocking: true,
      meetings: null,
      meetingsTotal: null,
      transcripts: null,
      transcriptsDone: null,
      transcriptsTotal: null,
      remaining: null,
      retrying: null,
      message: "238 meetings from a stale cache",
    },
    {
      ...status(),
      blocking: true,
      meetings: null,
      meetingsTotal: null,
      transcripts: null,
      transcriptsDone: null,
      transcriptsTotal: null,
      remaining: null,
      retrying: null,
      message: "238 meetings from a blocked cache",
      authTransition: {
        code: "AUTH_PUBLICATION_IN_PROGRESS",
        message: "Authentication publication is in progress",
      },
    },
  ]) {
    const input = new TestInput();
    const output = new TestOutput();
    const ui = new TerminalUi(
      createTerminalPolicy({
        input,
        output,
        env: { NO_COLOR: "", LANG: "C" },
        platform: "win32",
      }),
    );
    const result = syncStatusPrompt(
      { getStatus: () => currentStatus, output, ui, mode: "status" },
      { input, output },
    );
    await wait();
    const frame = latestFrame(output, "Sync status");
    expect(frame).not.toContain("Sana session: signed in");
    expect(frame).not.toContain("238 meetings");
    input.write("q");
    await result;
  }
});

test("standalone live status exits with q and Ctrl+C while refresh is active", async () => {
  for (const key of ["q", "\x03"]) {
    const input = new TestInput();
    const output = new TestOutput();
    const ui = new TerminalUi(
      createTerminalPolicy({
        input,
        output,
        env: { NO_COLOR: "", LANG: "C" },
        platform: "win32",
      }),
    );
    const result = syncStatusPrompt(
      {
        getStatus: () => status(),
        output,
        ui,
        mode: "status",
      },
      { input, output },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    input.write(key);
    expect(await result).toEqual({ action: "quit" });
    expect(input.isRaw).toBe(false);
  }
});
