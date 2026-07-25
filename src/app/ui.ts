import {
  displayWidth,
  renderDisplayRow,
  renderPanel,
  renderRule,
  renderTable,
  sanitizeTerminalText,
  stripTerminalSequences,
  truncateText,
  wrapText,
  type DisplayRow,
  type TableColumn,
} from "./render.js";

export {
  displayWidth,
  sanitizeTerminalText,
  type DisplayRow,
  type TableColumn,
};

const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_LEFT = "\x1b[G";
const ERASE_TO_END = "\x1b[J";
interface TrustedTextMetadata {
  owner: object;
  color: boolean;
  unicode: boolean;
}
const trustedText = new WeakMap<object, TrustedTextMetadata>();

export interface RenderedText {
  readonly text: string;
}

function rendered(
  text: string,
  owner: object,
  policy: Pick<TerminalPolicy, "color" | "unicode">
): RenderedText {
  const value = Object.freeze({ text });
  trustedText.set(value, { owner, color: policy.color, unicode: policy.unicode });
  return value;
}

function serialize(
  value: unknown,
  owner: object,
  policy: Pick<TerminalPolicy, "color" | "unicode">
): string {
  if (typeof value !== "object" || value === null) return sanitizeTerminalText(value);
  const metadata = trustedText.get(value);
  if (
    metadata?.owner === owner &&
    metadata.color === policy.color &&
    metadata.unicode === policy.unicode
  ) {
    return (value as RenderedText).text;
  }
  return sanitizeTerminalText(
    typeof (value as Partial<RenderedText>).text === "string"
      ? (value as Partial<RenderedText>).text
      : value
  );
}

export interface TerminalEnvironment {
  readonly [name: string]: string | undefined;
}

export interface TerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): void;
}

export interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(value: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface TerminalPolicy {
  inputTTY: boolean;
  outputTTY: boolean;
  interactive: boolean;
  control: boolean;
  color: boolean;
  unicode: boolean;
  columns: number | null;
  rows: number | null;
  platform: NodeJS.Platform;
  wsl: boolean;
}

export interface TerminalPolicyInput {
  input: TerminalInput;
  output: TerminalOutput;
  env: TerminalEnvironment;
  platform: NodeJS.Platform;
}

function enabledEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function positiveDimension(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! > 0 ? value! : null;
}

export function createTerminalPolicy(source: TerminalPolicyInput): TerminalPolicy {
  const inputTTY = source.input.isTTY === true;
  const outputTTY = source.output.isTTY === true;
  const ci = enabledEnvironmentFlag(source.env.CI);
  const dumb = source.env.TERM?.trim().toLowerCase() === "dumb";
  const noColor = Object.prototype.hasOwnProperty.call(source.env, "NO_COLOR");
  const control = outputTTY && !ci && !dumb;
  const locale = source.env.LC_ALL ?? source.env.LC_CTYPE ?? source.env.LANG;
  const utfLocale = locale !== undefined && /utf-?8/i.test(locale);
  const wsl = source.env.WSL_DISTRO_NAME !== undefined || source.env.WSL_INTEROP !== undefined;
  const windowsUnicode =
    source.env.WT_SESSION !== undefined ||
    source.env.TERM_PROGRAM === "vscode" ||
    enabledEnvironmentFlag(source.env.ConEmuANSI);

  return {
    inputTTY,
    outputTTY,
    interactive: inputTTY && outputTTY && !ci && !dumb,
    control,
    color: control && !noColor,
    unicode: control && (source.platform === "win32" ? windowsUnicode : utfLocale),
    columns: positiveDimension(source.output.columns),
    rows: positiveDimension(source.output.rows),
    platform: source.platform,
    wsl,
  };
}

export interface GlyphSet {
  ok: string;
  disable: string;
  noop: string;
  skip: string;
  fail: string;
  pending: string;
  pointer: string;
  check: string;
  uncheck: string;
}

export interface ApplyLike {
  status: "ok" | "noop" | "skipped" | "failed";
}

export const GUTTER = "  ";

/**
 * All styling, glyph, and layout decisions derive from this one injected
 * policy. Trusted terminal sequences can only be created by this class.
 */
export class TerminalUi {
  readonly glyphs: GlyphSet;
  readonly spinnerFrames: readonly string[];
  readonly truncationMarker: string;
  readonly overflowMarker: string;

  constructor(readonly policy: TerminalPolicy, private readonly owner: object = {}) {
    this.glyphs = policy.unicode
      ? {
          ok: "✔", disable: "−", noop: "=", skip: "·", fail: "✖",
          pending: "·", pointer: "❯", check: "◉", uncheck: "◯",
        }
      : {
          ok: "+", disable: "-", noop: "=", skip: "~", fail: "x",
          pending: ".", pointer: ">", check: "[x]", uncheck: "[ ]",
        };
    this.spinnerFrames = policy.unicode
      ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
      : ["-", "\\", "|", "/"];
    this.truncationMarker = policy.unicode ? "…" : "...";
    this.overflowMarker = policy.unicode ? "…" : ".";
  }

  text(value: unknown): RenderedText {
    return rendered(sanitizeTerminalText(value), this.owner, this.policy);
  }

  private style(open: number, value: unknown): RenderedText {
    const text = sanitizeTerminalText(value);
    return rendered(
      this.policy.color ? `\x1b[${open}m${text}\x1b[0m` : text,
      this.owner,
      this.policy
    );
  }

  readonly color = {
    dim: (value: unknown) => this.style(2, value),
    bold: (value: unknown) => this.style(1, value),
    green: (value: unknown) => this.style(32, value),
    yellow: (value: unknown) => this.style(33, value),
    red: (value: unknown) => this.style(31, value),
    cyan: (value: unknown) => this.style(36, value),
  };

  line(...parts: readonly unknown[]): RenderedText {
    return rendered(
      parts.map((part) => serialize(part, this.owner, this.policy)).join(""),
      this.owner,
      this.policy
    );
  }

  statusGlyph(result: ApplyLike, enabling = true): RenderedText {
    if (result.status === "ok") {
      return enabling ? this.color.green(this.glyphs.ok) : this.color.yellow(this.glyphs.disable);
    }
    if (result.status === "noop") return this.color.dim(this.glyphs.noop);
    if (result.status === "failed") return this.color.red(this.glyphs.fail);
    return this.color.dim(this.glyphs.skip);
  }

  header(title: unknown, subtitle?: unknown): RenderedText[] {
    const output = [this.color.bold(title)];
    if (subtitle !== undefined) output.push(this.color.dim(subtitle));
    return output;
  }

  row(glyph: unknown, label: unknown, detail?: unknown, hint?: unknown): RenderedText {
    const parts: unknown[] = [GUTTER, glyph, " ", label];
    if (detail !== undefined) parts.push(": ", this.color.dim(detail));
    if (hint !== undefined) parts.push("  ", this.color.dim(`(${sanitizeTerminalText(hint)})`));
    return this.line(...parts);
  }

  keyHint(key: unknown, action: unknown): RenderedText {
    return this.line(this.color.bold(key), " ", action);
  }

  footer(hints: readonly unknown[]): RenderedText[] {
    return [
      this.text(""),
      this.color.dim(hints.map((hint) => sanitizeTerminalText(hint)).join("  |  ")),
    ];
  }

  frame(parts: {
    header: readonly RenderedText[];
    body: readonly RenderedText[];
    footer?: readonly RenderedText[];
  }): RenderedText[] {
    const output = [...parts.header, this.text(""), ...parts.body];
    if (parts.footer?.length) output.push(...parts.footer);
    return output;
  }

  truncate(value: unknown, width: number): string {
    return truncateText(value, width, { marker: this.truncationMarker });
  }

  wrap(value: unknown, width: number): string[] {
    return wrapText(value, width, { overflowMarker: this.overflowMarker });
  }

  table<Row>(
    columns: readonly TableColumn<Row>[],
    rows: readonly Row[],
    width: number
  ): string[] {
    return renderTable(columns, rows, width, {
      unicode: this.policy.unicode,
      truncationMarker: this.truncationMarker,
      overflowMarker: this.overflowMarker,
    });
  }

  rule(width: number): string {
    return renderRule(width, { unicode: this.policy.unicode });
  }

  panel(body: readonly unknown[], width: number, title?: string): string[] {
    return renderPanel(body, width, {
      title,
      unicode: this.policy.unicode,
      truncationMarker: this.truncationMarker,
      overflowMarker: this.overflowMarker,
    });
  }

  settledRow(value: DisplayRow, width: number, status: ApplyLike["status"] = "ok"): string {
    return renderDisplayRow(
      {
        ...value,
        marker: serialize(this.statusGlyph({ status }), this.owner, this.policy),
      },
      width,
      { truncationMarker: this.truncationMarker }
    );
  }

  liveRow(value: DisplayRow, width: number, frameIndex: number): string {
    if (!Number.isSafeInteger(frameIndex)) throw new RangeError("frame index must be a safe integer");
    const index =
      ((frameIndex % this.spinnerFrames.length) + this.spinnerFrames.length) %
      this.spinnerFrames.length;
    return renderDisplayRow(
      { ...value, marker: this.spinnerFrames[index]! },
      width,
      { truncationMarker: this.truncationMarker }
    );
  }
}

export function stripAnsi(value: string): string {
  return stripTerminalSequences(value);
}

function visualRows(line: string, columns: number | null): number {
  if (columns === null) return 1;
  return Math.max(1, Math.ceil(displayWidth(stripTerminalSequences(line)) / columns));
}

interface RestorableTerminal {
  restore(): void;
}

const activeTerminals = new Set<RestorableTerminal>();
let processHooksInstalled = false;

function restoreAllTerminals(): void {
  for (const terminal of [...activeTerminals]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        terminal.restore();
        break;
      } catch {
        // Retry once because restoration keeps failed resources owned.
      }
    }
  }
}

function handleTermination(signal: NodeJS.Signals): void {
  restoreAllTerminals();
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  process.kill(process.pid, signal);
}

function handleSigint(): void {
  handleTermination("SIGINT");
}

function handleSigterm(): void {
  handleTermination("SIGTERM");
}

function installProcessHooks(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.once("exit", restoreAllTerminals);
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
}

function uninstallProcessHooks(): void {
  if (!processHooksInstalled) return;
  process.removeListener("exit", restoreAllTerminals);
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  processHooksInstalled = false;
}

function registerTerminal(terminal: RestorableTerminal): void {
  const wasEmpty = activeTerminals.size === 0;
  activeTerminals.add(terminal);
  if (wasEmpty) installProcessHooks();
}

function unregisterTerminal(terminal: RestorableTerminal): void {
  activeTerminals.delete(terminal);
  if (activeTerminals.size === 0) uninstallProcessHooks();
}

export interface FrameOptions {
  policy: TerminalPolicyInput;
  manageProcessSignals?: boolean;
}

export type FrameRedraw = (
  ui: TerminalUi,
  policy: TerminalPolicy
) => readonly unknown[];

/**
 * In-place renderer for one tracked terminal region. Resize starts a fresh
 * owned region below the prior settled render, avoiding unsafe cursor movement
 * after terminal reflow.
 */
export class Frame implements RestorableTerminal {
  private readonly policyInput: TerminalPolicyInput;
  private readonly manageProcessSignals: boolean;
  private readonly styleOwner = {};
  private lastLines: readonly string[] = [];
  private redraw: FrameRedraw | null = null;
  private cursorHidden = false;
  private rawModeBefore: boolean | undefined;
  private rawModeOwned = false;
  private resizeListenerOwned = false;

  constructor(options: FrameOptions) {
    this.policyInput = options.policy;
    this.manageProcessSignals =
      options.manageProcessSignals ?? options.policy.output === process.stdout;
  }

  get policy(): TerminalPolicy {
    return createTerminalPolicy(this.policyInput);
  }

  get ui(): TerminalUi {
    return this.uiFor(this.policy);
  }

  private uiFor(policy: TerminalPolicy): TerminalUi {
    return new TerminalUi(policy, this.styleOwner);
  }

  private startLifecycle(): void {
    if (this.manageProcessSignals) registerTerminal(this);
    const output = this.policyInput.output;
    if (!this.resizeListenerOwned && output.on && output.off) {
      this.resizeListenerOwned = true;
      output.on("resize", this.onResize);
    }
  }

  private showCursor(): void {
    if (!this.cursorHidden) return;
    this.policyInput.output.write(CURSOR_SHOW);
    this.cursorHidden = false;
  }

  private readonly onResize = (): void => {
    if (this.lastLines.length === 0 && !this.redraw) return;
    try {
      // Never move upward through reflowed content. Settle it as scrollback and
      // ask the model to lay out a new owned region using the new policy.
      this.showCursor();
      this.lastLines = [];
      if (this.redraw) {
        const policy = this.policy;
        this.renderResolved(this.redraw(this.uiFor(policy), policy), policy);
      }
    } catch (error) {
      try {
        this.restore();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "terminal resize redraw and cleanup failed");
      }
      throw error;
    }
  };

  enterRawMode(): void {
    const input = this.policyInput.input;
    if (
      !this.policy.interactive ||
      !input.setRawMode ||
      typeof input.isRaw !== "boolean" ||
      this.rawModeOwned
    ) {
      return;
    }
    try {
      this.startLifecycle();
      this.rawModeBefore = input.isRaw;
      this.rawModeOwned = true;
      input.setRawMode(true);
    } catch (error) {
      this.cleanupAfterFailure(error, "raw-mode setup and cleanup failed");
    }
  }

  private clearOwnedRegion(): void {
    if (this.lastLines.length === 0) return;
    const rows = this.lastLines.reduce(
      (count, line) => count + visualRows(line, this.policy.columns),
      0
    );
    this.policyInput.output.write(`\x1b[${rows}A${CURSOR_LEFT}${ERASE_TO_END}`);
  }

  private renderFresh(lines: readonly string[]): void {
    const output = this.policyInput.output;
    if (!this.cursorHidden) {
      this.cursorHidden = true;
      output.write(CURSOR_HIDE);
    }
    output.write(lines.join("\r\n") + "\r\n");
    this.lastLines = lines;
  }

  private renderResolved(lines: readonly unknown[], policy = this.policy): void {
    const safeLines = lines.map((line) => serialize(line, this.styleOwner, policy));
    if (!policy.control) {
      this.policyInput.output.write(safeLines.join("\n") + "\n");
      return;
    }
    try {
      this.startLifecycle();
      this.clearOwnedRegion();
      this.renderFresh(safeLines);
    } catch (error) {
      this.cleanupAfterFailure(error, "terminal render and cleanup failed");
    }
  }

  /** Render a settled value. It is not replayed after resize. */
  render(lines: readonly unknown[]): void {
    this.redraw = null;
    this.renderResolved(lines);
  }

  /** Render live state and recompute it from the model after every resize. */
  renderModel(redraw: FrameRedraw): void {
    this.redraw = redraw;
    const policy = this.policy;
    let lines: readonly unknown[];
    try {
      lines = redraw(this.uiFor(policy), policy);
    } catch (error) {
      this.cleanupAfterFailure(error, "terminal model render and cleanup failed");
    }
    this.renderResolved(lines, policy);
  }

  private cleanupAfterFailure(error: unknown, message: string): never {
    try {
      this.restore();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], message);
    }
    throw error;
  }

  clearToEnd(): void {
    if (this.policy.control) this.policyInput.output.write(CURSOR_LEFT + ERASE_TO_END);
  }

  done(finalLines?: readonly unknown[]): void {
    if (finalLines) this.render(finalLines);
    this.redraw = null;
    this.restore();
  }

  cancel(finalLines?: readonly unknown[]): void {
    this.done(finalLines);
  }

  fail(finalLines?: readonly unknown[]): void {
    this.done(finalLines);
  }

  restore(): void {
    const errors: unknown[] = [];
    const input = this.policyInput.input;
    const output = this.policyInput.output;
    if (this.rawModeOwned && input.setRawMode) {
      try {
        input.setRawMode(this.rawModeBefore!);
        this.rawModeOwned = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.cursorHidden) {
      try {
        output.write(CURSOR_SHOW);
        this.cursorHidden = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.resizeListenerOwned && output.off) {
      try {
        output.off("resize", this.onResize);
        this.resizeListenerOwned = false;
      } catch (error) {
        errors.push(error);
      }
    }
    this.lastLines = [];
    this.redraw = null;
    if (!this.rawModeOwned && !this.cursorHidden && !this.resizeListenerOwned) {
      unregisterTerminal(this);
    }
    if (errors.length > 0) throw new AggregateError(errors, "terminal restoration failed");
  }
}

export async function withTerminalFrame<Value>(
  frame: Frame,
  operation: (frame: Frame) => Promise<Value> | Value
): Promise<Value> {
  let result: Value;
  try {
    result = await operation(frame);
  } catch (error) {
    try {
      frame.restore();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "terminal operation and cleanup failed");
    }
    throw error;
  }
  frame.restore();
  return result;
}
