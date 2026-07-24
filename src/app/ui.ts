// Shared rendering primitives for every human-facing surface (configurer, the
// interactive app, installer). Dependency-light: color/glyphs gated on TTY +
// NO_COLOR, layout helpers with a consistent gutter, and a Frame that redraws a
// tracked region in place (degrading to plain writes when not a TTY).
import { cursorHide, cursorShow, eraseLines } from "@inquirer/ansi";

// ---- capability detection (computed once) --------------------------------

const noColor = "NO_COLOR" in process.env || process.env.TERM === "dumb";
export const isTTY = !!process.stdout.isTTY;
export const isColor = isTTY && !noColor;
// Interactive = we may run prompts and redraw. CI is treated as non-interactive.
export const isInteractive = !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI;
// Unicode glyphs only where we are confident they render; else ASCII.
const unicodeOK =
  isTTY && (process.platform !== "win32" || !!process.env.WT_SESSION);

// ---- color ---------------------------------------------------------------

const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    isColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const color = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
  cyan: wrap(36, 39),
};

// ---- glyphs --------------------------------------------------------------

export const glyphs = unicodeOK
  ? { ok: "✔", disable: "−", noop: "=", skip: "·", fail: "✖", pending: "·", pointer: "❯", check: "◉", uncheck: "◯" }
  : { ok: "+", disable: "-", noop: "=", skip: "~", fail: "x", pending: ".", pointer: ">", check: "[x]", uncheck: "[ ]" };

export const spinnerFrames = unicodeOK
  ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  : ["-", "\\", "|", "/"];

export interface ApplyLike {
  status: "ok" | "noop" | "skipped" | "failed";
}

/** Status glyph for an apply result. `enabling=false` renders the ok case as a
 *  yellow "disabled/removed" mark. */
export function statusGlyph(r: ApplyLike, enabling = true): string {
  if (r.status === "ok") return enabling ? color.green(glyphs.ok) : color.yellow(glyphs.disable);
  if (r.status === "noop") return color.dim(glyphs.noop);
  if (r.status === "failed") return color.red(glyphs.fail);
  return color.dim(glyphs.skip);
}

// ---- layout helpers ------------------------------------------------------

export const GUTTER = "  ";

export function header(title: string, subtitle?: string): string[] {
  const out = [color.bold(title)];
  if (subtitle) out.push(color.dim(subtitle));
  return out;
}

export function row(glyph: string, label: string, detail?: string, hint?: string): string {
  let s = `${GUTTER}${glyph} ${label}`;
  if (detail) s += `: ${color.dim(detail)}`;
  if (hint) s += `  ${color.dim(`(${hint})`)}`;
  return s;
}

export function keyHint(key: string, action: string): string {
  return `${color.bold(key)} ${action}`;
}

export function footer(hints: string[]): string[] {
  return ["", color.dim(hints.join("  |  "))];
}

/** Assemble a whole screen with consistent spacing: one blank after the header,
 *  one blank before the footer. */
export function frame(parts: { header: string[]; body: string[]; footer?: string[] }): string[] {
  const out = [...parts.header, "", ...parts.body];
  if (parts.footer && parts.footer.length) out.push(...parts.footer);
  return out;
}

// ---- misc helpers --------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function clearAndHome(): void {
  if (isTTY) process.stdout.write("\x1b[2J\x1b[H");
}

/** Visual row count of a rendered line, accounting for wrap at terminal width. */
function visualRows(line: string, cols: number): number {
  const len = stripAnsi(line).length;
  if (cols <= 0) return 1;
  return Math.max(1, Math.ceil(len / cols));
}

// ---- Frame: in-place redraw of a tracked region --------------------------

let cursorRestoreHooked = false;
function hookCursorRestore(): void {
  if (cursorRestoreHooked) return;
  cursorRestoreHooked = true;
  const restore = () => {
    try {
      if (isTTY) process.stdout.write(cursorShow);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
}

export class Frame {
  private lastRows = 0;
  constructor(private stream: NodeJS.WriteStream = process.stdout) {}

  render(lines: string[]): void {
    if (!isTTY) {
      // Non-interactive: write once as plain lines, no erase/cursor codes.
      this.stream.write(lines.join("\n") + "\n");
      return;
    }
    hookCursorRestore();
    const cols = this.stream.columns || 80;
    if (this.lastRows > 0) this.stream.write(eraseLines(this.lastRows + 1));
    this.stream.write(cursorHide);
    this.stream.write(lines.join("\n") + "\n");
    this.lastRows = lines.reduce((n, l) => n + visualRows(l, cols), 0);
  }

  done(finalLines?: string[]): void {
    if (finalLines) this.render(finalLines);
    if (isTTY) this.stream.write(cursorShow);
    this.lastRows = 0;
  }
}
