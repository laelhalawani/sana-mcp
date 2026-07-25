import { describe, expect, test } from "bun:test";
import {
  TranscriptDataError,
  countWords,
  renderTranscript,
  transcriptLines,
} from "../../src/sana/transcript.js";

const healthy = [
  {
    speaker: "Alex",
    words: [
      { text: "Hello", start_timestamp: 65, end_timestamp: 65.4 },
      { text: ",", start_timestamp: 65.4, end_timestamp: 65.5 },
      { text: "team", start_timestamp: 65.5, end_timestamp: 66 },
    ],
  },
];

describe("transcript runtime validation", () => {
  test("healthy data keeps the established line and timestamp format", () => {
    expect(transcriptLines(healthy)).toEqual([
      {
        n: 1,
        timeSec: 65,
        time: "1:05",
        speaker: "Alex",
        text: "Hello, team",
      },
    ]);
    expect(renderTranscript(healthy)).toBe("[1:05] Alex: Hello, team");
    expect(countWords(healthy)).toBe(3);
  });

  test("valid authoritative zero remains zero without being a fallback", () => {
    const lines = transcriptLines([
      {
        speaker: "Alex",
        words: [{ text: "Start", start_timestamp: 0, end_timestamp: 0.2 }],
      },
    ]);
    expect(lines[0]?.time).toBe("0:00");
    expect(lines[0]?.timeSec).toBe(0);
  });

  test("malformed segments and words throw a typed corruption error", () => {
    const values: unknown[] = [
      {},
      [null],
      [{ speaker: "Alex" }],
      [{ speaker: 2, words: [] }],
      [{ speaker: "Alex", words: [{}] }],
      [
        {
          speaker: "Alex",
          words: [{ text: "x", start_timestamp: -1, end_timestamp: 0 }],
        },
      ],
      [
        {
          speaker: "Alex",
          words: [{ text: "x", start_timestamp: 2, end_timestamp: 1 }],
        },
      ],
    ];
    for (const value of values) {
      expect(() => transcriptLines(value as never)).toThrow(
        TranscriptDataError,
      );
      expect(() => countWords(value as never)).toThrow(TranscriptDataError);
    }
  });

  test("an explicitly empty word list is a valid empty spoken turn", () => {
    expect(transcriptLines([{ speaker: "Alex", words: [] }])).toEqual([]);
    expect(countWords([{ speaker: "Alex", words: [] }])).toBe(0);
  });
});
