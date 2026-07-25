import { describe, expect, test } from "bun:test";
import {
  getParticipants,
  getSummaryView,
  getTranscriptView,
  queryMeetings,
} from "../../src/core/meetings.js";
import type {
  MeetingRow,
  SanaStore,
  TranscriptRow,
} from "../../src/store/db.js";

const meeting: MeetingRow = {
  id: "meeting-a",
  external_id: null,
  name: "Weekly sync",
  source: "sana-ai:meeting",
  created_at_ms: Date.parse("2026-01-03T12:00:00Z"),
  modified_at_ms: null,
  first_seen_ms: Date.parse("2026-01-03T12:00:01Z"),
  processing_phase: "done",
};

const transcriptSegments = [
  {
    speaker: "Alex",
    words: [
      { text: "Hello", start_timestamp: 3, end_timestamp: 3.5 },
      { text: "team", start_timestamp: 3.5, end_timestamp: 4 },
    ],
  },
];

function transcript(patch: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    meeting_id: meeting.id,
    text: "[0:03] Alex: Hello team",
    json: JSON.stringify(transcriptSegments),
    word_count: 2,
    segment_count: 1,
    fetched_ms: Date.now(),
    ...patch,
  };
}

function store(overrides: Record<string, unknown>): SanaStore {
  return {
    getMeeting: () => meeting,
    getTranscript: () => transcript(),
    getMetadata: () => null,
    getSyncState: () => ({ phase: "synced" }),
    ...overrides,
  } as unknown as SanaStore;
}

describe("meeting artifact integrity", () => {
  test("healthy transcript preserves the structured view", () => {
    const result = getTranscriptView(store({}), meeting.id);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.name).toBe("Weekly sync");
      expect(result.wordCount).toBe(2);
      expect(result.lines[0]).toMatchObject({
        n: 1,
        timeSec: 3,
        time: "0:03",
        speaker: "Alex",
        text: "Hello team",
      });
    }
  });

  test("malformed transcript JSON, segments, and cached counts are typed corrupt", () => {
    const rows = [
      transcript({ json: "{" }),
      transcript({ json: JSON.stringify([{ speaker: "Alex", words: [{}] }]) }),
      transcript({ word_count: 0 }),
      transcript({ segment_count: 0 }),
    ];
    for (const row of rows) {
      const result = getTranscriptView(
        store({ getTranscript: () => row }),
        meeting.id,
      );
      expect(result).toMatchObject({
        kind: "corrupt",
        artifact: "transcript",
        code: "CACHE_ARTIFACT_CORRUPT",
        action: "resync",
        name: "Weekly sync",
      });
    }
  });

  test("orphaned transcript state is unavailable, not given an invented title", () => {
    const result = getTranscriptView(
      store({ getMeeting: () => null }),
      meeting.id,
    );
    expect(result).toEqual({
      kind: "unavailable",
      id: meeting.id,
      artifact: "meeting",
      code: "CACHE_ARTIFACT_WITHOUT_MEETING",
      action: "resync",
    });
  });

  test("missing completed transcript is actionable unavailable, not benign none", () => {
    const result = getTranscriptView(
      store({
        getTranscript: () => null,
        getSyncState: () => ({ phase: "synced" }),
      }),
      meeting.id,
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      artifact: "transcript",
      code: "CACHE_ARTIFACT_MISSING",
      action: "resync",
    });
  });

  test("malformed notes never disappear or receive an invented topic", () => {
    const malformed = [
      "",
      "{",
      JSON.stringify({ notes: [{ notes: ["missing topic"] }] }),
      JSON.stringify({ notes: [{ topic: "Topic", notes: "not an array" }] }),
      JSON.stringify({ actionItems: [{ assignedTo: "Alex" }] }),
    ];
    for (const notes_json of malformed) {
      const result = getSummaryView(
        store({
          getMetadata: () => ({
            summary: null,
            summary_short: null,
            notes_json,
            participants_json: null,
            has_recording: 0,
          }),
        }),
        meeting.id,
      );
      expect(result).toMatchObject({
        kind: "corrupt",
        artifact: "summary",
        action: "resync",
      });
    }
  });

  test("healthy summary retains notes and action items", () => {
    const result = getSummaryView(
      store({
        getMetadata: () => ({
          summary: "Long summary",
          summary_short: "Short summary",
          notes_json: JSON.stringify({
            notes: [{ topic: "Coverage", notes: ["Keep exact contracts."] }],
            actionItems: [
              {
                action: "Review",
                assignedTo: "Alex",
                dueDate: "2026-01-04",
              },
            ],
          }),
          participants_json: null,
          has_recording: 0,
        }),
      }),
      meeting.id,
    );
    expect(result).toMatchObject({
      kind: "ok",
      view: {
        summary: "Long summary",
        summaryShort: "Short summary",
        notes: [{ topic: "Coverage", notes: ["Keep exact contracts."] }],
        actionItems: [
          {
            action: "Review",
            assignedTo: "Alex",
            dueDate: "2026-01-04",
          },
        ],
      },
    });
  });

  test("missing metadata and invalid cached summary scalars are observable", () => {
    expect(getSummaryView(store({}), meeting.id)).toMatchObject({
      kind: "unavailable",
      artifact: "summary",
      code: "CACHE_ARTIFACT_MISSING",
      action: "resync",
    });
    for (const patch of [
      { summary: 4, summary_short: null },
      { summary: null, summary_short: false },
    ]) {
      expect(
        getSummaryView(
          store({
            getMetadata: () => ({
              ...patch,
              notes_json: null,
              participants_json: "[]",
              has_recording: 0,
            }),
          }),
          meeting.id,
        ),
      ).toMatchObject({
        kind: "corrupt",
        artifact: "summary",
        code: "CACHE_ARTIFACT_CORRUPT",
      });
    }
  });

  test("malformed participants are corrupt while an authoritative empty array is none", () => {
    for (const participants_json of [
      "{",
      JSON.stringify({ displayName: "Alex" }),
      JSON.stringify([{}]),
      JSON.stringify([{ id: "participant-a" }]),
      JSON.stringify([
        {
          id: " padded-participant ",
          displayName: "Alex",
          email: "alex@example.test",
          isHost: false,
        },
      ]),
      JSON.stringify([
        {
          displayName: "   ",
          email: "alex@example.test",
          isHost: false,
        },
      ]),
      JSON.stringify([
        {
          displayName: "Alex",
          email: "alex@example.test",
        },
      ]),
      JSON.stringify([{ displayName: 3 }]),
      JSON.stringify([{ email: "not-an-email" }]),
    ]) {
      expect(
        getParticipants(
          store({
            getMetadata: () => ({
              summary: null,
              summary_short: null,
              notes_json: null,
              participants_json,
              has_recording: 0,
            }),
          }),
          meeting.id,
        ),
      ).toMatchObject({
        kind: "corrupt",
        artifact: "participants",
        action: "resync",
      });
    }
    expect(
      getParticipants(
        store({
          getMetadata: () => ({
            summary: null,
            summary_short: null,
            notes_json: null,
            participants_json: "[]",
            has_recording: 0,
          }),
        }),
        meeting.id,
      ),
    ).toEqual({ kind: "none", name: "Weekly sync" });

    expect(
      getParticipants(
        store({
          getMetadata: () => ({
            summary: null,
            summary_short: null,
            notes_json: null,
            participants_json: JSON.stringify([
              {
                displayName: "Alex",
                email: "alex@example.test",
                isHost: false,
              },
            ]),
            has_recording: 0,
          }),
        }),
        meeting.id,
      ),
    ).toEqual({
      kind: "ok",
      name: "Weekly sync",
      participants: [
        {
          displayName: "Alex",
          email: "alex@example.test",
          isHost: false,
        },
      ],
    });
  });

  test("missing participant artifact is actionable unavailable", () => {
    expect(getParticipants(store({}), meeting.id)).toMatchObject({
      kind: "unavailable",
      artifact: "participants",
      code: "CACHE_ARTIFACT_MISSING",
      action: "resync",
    });
    expect(
      getParticipants(
        store({
          getMetadata: () => ({
            summary: null,
            summary_short: null,
            notes_json: null,
            participants_json: null,
            has_recording: 0,
          }),
        }),
        meeting.id,
      ),
    ).toMatchObject({
      kind: "unavailable",
      artifact: "participants",
      code: "CACHE_ARTIFACT_MISSING",
      action: "resync",
    });
  });
});

describe("meeting query arguments", () => {
  test("invalid open-record values fail before any store query", () => {
    let reads = 0;
    const queryStore = store({
      listMeetings: () => {
        reads++;
        return [];
      },
      countMeetings: () => {
        reads++;
        return 0;
      },
    });
    for (const args of [
      { page: "2" },
      { limit: 1.5 },
      { limit: 1001 },
      { sort: "recent" },
      { query: 7 },
      { filter: { status: "processing" } },
      { filter: { date: { from: "not-a-date" } } },
    ]) {
      expect(() => queryMeetings(queryStore, args)).toThrow();
    }
    expect(reads).toBe(0);
  });

  test("canonical maximum page size is passed through without store clamping", () => {
    let received: Record<string, unknown> | undefined;
    const queryStore = store({
      listMeetings: (args: Record<string, unknown>) => {
        received = args;
        return [];
      },
      countMeetings: () => 0,
    });
    const result = queryMeetings(queryStore, { page: 2, limit: 1000 });
    expect(result).toMatchObject({
      page: 2,
      limit: 1000,
      offset: 1000,
    });
    expect(received).toMatchObject({ limit: 1000, offset: 1000 });
  });
});
