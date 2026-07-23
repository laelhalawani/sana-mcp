import type { TranscriptSegment } from "./types.js";

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function segmentText(seg: TranscriptSegment): string {
  return (seg.words || [])
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
  const out: TranscriptLine[] = [];
  let n = 0;
  for (const seg of segments) {
    const text = segmentText(seg);
    if (!text) continue;
    n++;
    const start = seg.words?.[0]?.start_timestamp ?? 0;
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
  return segments.reduce((n, s) => n + (s.words?.length || 0), 0);
}
