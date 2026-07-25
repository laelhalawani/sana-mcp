import type { TranscriptSegment } from "./types.js";

export class TranscriptDataError extends Error {
  readonly code = "TRANSCRIPT_DATA_CORRUPT";

  constructor(readonly path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "TranscriptDataError";
  }
}

function validateSegments(
  value: unknown,
): asserts value is TranscriptSegment[] {
  if (!Array.isArray(value)) {
    throw new TranscriptDataError("transcript", "must be an array");
  }
  for (let segmentIndex = 0; segmentIndex < value.length; segmentIndex++) {
    const segment = value[segmentIndex];
    const segmentPath = `transcript[${segmentIndex}]`;
    if (
      segment === null ||
      typeof segment !== "object" ||
      Array.isArray(segment)
    ) {
      throw new TranscriptDataError(segmentPath, "must be an object");
    }
    const record = segment as Record<string, unknown>;
    if (typeof record.speaker !== "string") {
      throw new TranscriptDataError(`${segmentPath}.speaker`, "must be a string");
    }
    if (
      record.language !== undefined &&
      typeof record.language !== "string"
    ) {
      throw new TranscriptDataError(
        `${segmentPath}.language`,
        "must be a string when present",
      );
    }
    if (!Array.isArray(record.words)) {
      throw new TranscriptDataError(`${segmentPath}.words`, "must be an array");
    }
    for (let wordIndex = 0; wordIndex < record.words.length; wordIndex++) {
      const word = record.words[wordIndex];
      const wordPath = `${segmentPath}.words[${wordIndex}]`;
      if (word === null || typeof word !== "object" || Array.isArray(word)) {
        throw new TranscriptDataError(wordPath, "must be an object");
      }
      const wordRecord = word as Record<string, unknown>;
      if (typeof wordRecord.text !== "string") {
        throw new TranscriptDataError(`${wordPath}.text`, "must be a string");
      }
      if (
        typeof wordRecord.start_timestamp !== "number" ||
        !Number.isFinite(wordRecord.start_timestamp) ||
        wordRecord.start_timestamp < 0
      ) {
        throw new TranscriptDataError(
          `${wordPath}.start_timestamp`,
          "must be a finite non-negative number",
        );
      }
      if (
        typeof wordRecord.end_timestamp !== "number" ||
        !Number.isFinite(wordRecord.end_timestamp) ||
        wordRecord.end_timestamp < wordRecord.start_timestamp
      ) {
        throw new TranscriptDataError(
          `${wordPath}.end_timestamp`,
          "must be finite and no earlier than start_timestamp",
        );
      }
    }
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    throw new TranscriptDataError(
      "transcript timestamp",
      "must be a finite non-negative number",
    );
  }
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function segmentText(seg: TranscriptSegment): string {
  return seg.words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** One addressable transcript line = one spoken turn. n is 1-based. */
export interface TranscriptLine {
  n: number;
  timeSec: number;
  time: string;
  speaker: string;
  text: string;
}

/** Turn raw segments into numbered lines (skipping empty turns). */
export function transcriptLines(segments: TranscriptSegment[]): TranscriptLine[] {
  validateSegments(segments);
  const out: TranscriptLine[] = [];
  let n = 0;
  for (const seg of segments) {
    const text = segmentText(seg);
    if (!text) continue;
    n++;
    const start = seg.words[0]!.start_timestamp;
    out.push({ n, timeSec: start, time: fmtTime(start), speaker: seg.speaker, text });
  }
  return out;
}

export function renderLines(
  lines: TranscriptLine[],
  opts: { timestamps?: boolean; numbers?: boolean } = {}
): string {
  const ts = opts.timestamps ?? true;
  const num = opts.numbers ?? true;
  return lines
    .map(
      (l) =>
        `${num ? `${l.n}\t` : ""}${ts ? `[${l.time}] ` : ""}${l.speaker}: ${l.text}`
    )
    .join("\n");
}

/** Flat transcript text (no line numbers) - used for storage and keyword prefilter. */
export function renderTranscript(
  segments: TranscriptSegment[],
  opts: { timestamps?: boolean } = {}
): string {
  return renderLines(transcriptLines(segments), {
    timestamps: opts.timestamps ?? true,
    numbers: false,
  });
}

export function countWords(segments: TranscriptSegment[]): number {
  validateSegments(segments);
  return segments.reduce((n, s) => n + s.words.length, 0);
}
