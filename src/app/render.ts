/**
 * Pure terminal layout helpers.
 *
 * These functions never add terminal control sequences. Inputs are treated as
 * untrusted display text and are sanitized before measurement or rendering.
 */

const BIDI_CONTROL_RE =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/gu;
const MARK_RE = /\p{Mark}/u;
const FORMAT_RE = /\p{Cf}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function consumeCsi(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return input.length;
}

function consumeControlString(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x07 || code === 0x9c) return i + 1;
    if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
}

/** Remove CSI, OSC, DCS, APC, PM, SOS, and two-byte escape sequences. */
export function stripTerminalSequences(input: string): string {
  let output = "";
  for (let i = 0; i < input.length; ) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = consumeCsi(input, i + 2);
      } else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = consumeControlString(input, i + 2);
      } else {
        i = Math.min(input.length, i + 2);
      }
      continue;
    }
    if (code === 0x9b) {
      i = consumeCsi(input, i + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      i = consumeControlString(input, i + 1);
      continue;
    }
    output += input[i];
    i += 1;
  }
  return output;
}

export interface SanitizeTextOptions {
  /** Preserve line boundaries. The default produces one safe display line. */
  multiline?: boolean;
}

/**
 * Convert untrusted content to inert terminal text.
 *
 * Tabs and single-line line breaks become spaces so content cannot move the
 * cursor or forge additional UI rows. Multiline text retains tabs and line
 * boundaries for terminal documents. Bidirectional controls are removed to
 * keep paths, identities, and errors visually ordered.
 */
export function sanitizeTerminalText(
  value: unknown,
  options: SanitizeTextOptions = {}
): string {
  const input = stripTerminalSequences(String(value)).replace(/\r\n?/gu, "\n");
  let output = "";
  for (const character of input) {
    const code = character.codePointAt(0)!;
    if (character === "\n") {
      if (options.multiline) output += "\n";
      else if (!output.endsWith(" ")) output += " ";
      continue;
    }
    if (character === "\t") {
      if (options.multiline) output += "\t";
      else if (!output.endsWith(" ")) output += " ";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    output += character;
  }
  return output.replace(BIDI_CONTROL_RE, "");
}

function graphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map(({ segment }) => segment);
  }
  const characters = Array.from(value);
  const output: string[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    let cluster = characters[index]!;
    const first = cluster.codePointAt(0)!;
    if (
      first >= 0x1f1e6 &&
      first <= 0x1f1ff &&
      characters[index + 1] !== undefined
    ) {
      const second = characters[index + 1]!.codePointAt(0)!;
      if (second >= 0x1f1e6 && second <= 0x1f1ff) {
        cluster += characters[++index]!;
      }
    }
    while (characters[index + 1] !== undefined) {
      const next = characters[index + 1]!;
      const code = next.codePointAt(0)!;
      if (
        MARK_RE.test(next) ||
        code === 0xfe0e ||
        code === 0xfe0f ||
        (code >= 0x1f3fb && code <= 0x1f3ff)
      ) {
        cluster += characters[++index]!;
        continue;
      }
      if (code === 0x200d && characters[index + 2] !== undefined) {
        cluster += characters[++index]!;
        cluster += characters[++index]!;
        continue;
      }
      break;
    }
    output.push(cluster);
  }
  return output;
}

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  const codePoints = Array.from(grapheme, (character) => character.codePointAt(0)!);
  const regionalIndicators = codePoints.filter(
    (code) => code >= 0x1f1e6 && code <= 0x1f1ff
  ).length;
  if (regionalIndicators >= 2 || codePoints.includes(0x20e3)) return 2;
  if (EXTENDED_PICTOGRAPHIC_RE.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) {
    if (character === "\u200d" || MARK_RE.test(character) || FORMAT_RE.test(character)) continue;
    const code = character.codePointAt(0)!;
    width = Math.max(width, isWideCodePoint(code) ? 2 : 1);
  }
  return width;
}

export function displayWidth(value: unknown): number {
  const text = sanitizeTerminalText(value);
  return graphemes(text).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

function assertWidth(width: number): void {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError("terminal width must be a positive safe integer");
  }
}

function takeWidth(value: string, width: number): string {
  let output = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width) break;
    output += grapheme;
    used += next;
  }
  return output;
}

export function truncateText(
  value: unknown,
  width: number,
  options: { marker: string }
): string {
  assertWidth(width);
  const text = sanitizeTerminalText(value);
  if (displayWidth(text) <= width) return text;
  const marker = sanitizeTerminalText(options.marker);
  const markerWidth = displayWidth(marker);
  if (markerWidth >= width) return takeWidth(marker, width);
  return takeWidth(text, width - markerWidth) + marker;
}

function hardWrapToken(
  token: string,
  width: number,
  overflowMarker: string
): [string, ...string[]] {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const grapheme of graphemes(token)) {
    const next = graphemeWidth(grapheme);
    if (current && used + next > width) {
      lines.push(current);
      current = "";
      used = 0;
    }
    if (next > width) {
      lines.push(takeWidth(overflowMarker, width));
      continue;
    }
    current += grapheme;
    used += next;
  }
  if (current || lines.length === 0) lines.push(current);
  return lines as [string, ...string[]];
}

export function wrapText(
  value: unknown,
  width: number,
  options: { overflowMarker: string }
): string[] {
  assertWidth(width);
  const text = sanitizeTerminalText(value, { multiline: true });
  const output: string[] = [];

  for (const sourceLine of text.split("\n")) {
    if (!sourceLine) {
      output.push("");
      continue;
    }
    let current = "";
    for (const token of sourceLine.split(/(\s+)/u).filter(Boolean)) {
      const normalized = /^\s+$/u.test(token) ? " " : token;
      if (normalized === " " && !current) continue;
      if (displayWidth(current + normalized) <= width) {
        current += normalized;
        continue;
      }
      if (current) {
        output.push(current.trimEnd());
        current = "";
      }
      if (normalized === " ") continue;
      const pieces = hardWrapToken(
        normalized,
        width,
        sanitizeTerminalText(options.overflowMarker)
      );
      output.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1]!;
    }
    output.push(current.trimEnd());
  }
  return output;
}

function pad(value: string, width: number, alignment: "left" | "right"): string {
  const missing = Math.max(0, width - displayWidth(value));
  return alignment === "right" ? " ".repeat(missing) + value : value + " ".repeat(missing);
}

export interface TableColumn<Row> {
  header: string;
  value: (row: Row) => unknown;
  align?: "left" | "right";
  minWidth?: number;
  maxWidth?: number;
}

function fitColumnWidths(preferred: number[], minimum: number[], budget: number): number[] {
  const widths = preferred.map((value, index) => Math.max(minimum[index]!, value));
  while (widths.reduce((sum, value) => sum + value, 0) > budget) {
    let candidate = -1;
    let room = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const candidateRoom = widths[index]! - minimum[index]!;
      if (candidateRoom > room) {
        room = candidateRoom;
        candidate = index;
      }
    }
    if (candidate < 0) break;
    widths[candidate]!--;
  }
  return widths;
}

/** Render a table that never exceeds `availableWidth`. */
export function renderTable<Row>(
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
  availableWidth: number,
  options: { unicode: boolean; truncationMarker: string; overflowMarker: string }
): string[] {
  assertWidth(availableWidth);
  if (columns.length === 0) return [];
  const separator = "  ";
  const separatorWidth = displayWidth(separator) * (columns.length - 1);
  const minimum = columns.map((column) => {
    const requested = column.minWidth ?? 1;
    assertWidth(requested);
    return requested;
  });

  if (minimum.reduce((sum, value) => sum + value, 0) + separatorWidth > availableWidth) {
    return rows.flatMap((row, rowIndex) => {
      const lines = columns.flatMap((column) =>
        wrapText(
          `${sanitizeTerminalText(column.header)}: ${sanitizeTerminalText(column.value(row))}`,
          availableWidth,
          { overflowMarker: options.overflowMarker }
        )
      );
      return rowIndex === rows.length - 1 ? lines : [...lines, ""];
    });
  }

  const preferred = columns.map((column, index) => {
    const contentWidth = Math.max(
      displayWidth(column.header),
      ...rows.map((row) => displayWidth(column.value(row)))
    );
    const maximum = column.maxWidth;
    if (maximum !== undefined) {
      assertWidth(maximum);
      if (maximum < minimum[index]!) {
        throw new RangeError("table maxWidth cannot be smaller than minWidth");
      }
      return Math.min(contentWidth, maximum);
    }
    return contentWidth;
  });
  const widths = fitColumnWidths(preferred, minimum, availableWidth - separatorWidth);
  const renderRow = (values: readonly unknown[]) =>
    values
      .map((value, index) => {
        const cell = truncateText(value, widths[index]!, { marker: options.truncationMarker });
        return pad(cell, widths[index]!, columns[index]!.align ?? "left");
      })
      .join(separator)
      .trimEnd();

  return [
    renderRow(columns.map((column) => column.header)),
    renderRow(widths.map((width) => (options.unicode === false ? "-" : "─").repeat(width))),
    ...rows.map((row) => renderRow(columns.map((column) => column.value(row)))),
  ];
}

export function renderRule(width: number, options: { unicode: boolean }): string {
  assertWidth(width);
  return (options.unicode === false ? "-" : "─").repeat(width);
}

export function renderPanel(
  body: readonly unknown[],
  width: number,
  options: {
    title?: string;
    unicode: boolean;
    truncationMarker: string;
    overflowMarker: string;
  }
): string[] {
  assertWidth(width);
  if (width < 5) {
    return body.flatMap((line) =>
      wrapText(line, width, { overflowMarker: options.overflowMarker })
    );
  }
  const unicode = options.unicode !== false;
  const glyph = unicode
    ? { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" }
    : { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" };
  const innerWidth = width - 4;
  const title = options.title === undefined ? "" : ` ${sanitizeTerminalText(options.title)} `;
  const topContent = truncateText(title, width - 2, { marker: options.truncationMarker });
  const top =
    glyph.topLeft +
    topContent +
    glyph.horizontal.repeat(width - 2 - displayWidth(topContent)) +
    glyph.topRight;
  const lines = body.flatMap((line) =>
    wrapText(line, innerWidth, { overflowMarker: options.overflowMarker })
  );
  return [
    top,
    ...lines.map((line) => `${glyph.vertical} ${pad(line, innerWidth, "left")} ${glyph.vertical}`),
    glyph.bottomLeft + glyph.horizontal.repeat(width - 2) + glyph.bottomRight,
  ];
}

export interface DisplayRow {
  marker: string;
  label: string;
  detail?: string;
}

export function renderDisplayRow(
  row: DisplayRow,
  width: number,
  options: { truncationMarker: string }
): string {
  assertWidth(width);
  const prefix = `${sanitizeTerminalText(row.marker)} ${sanitizeTerminalText(row.label)}`;
  const value = row.detail === undefined
    ? prefix
    : `${prefix}: ${sanitizeTerminalText(row.detail)}`;
  return truncateText(value, width, { marker: options.truncationMarker });
}
