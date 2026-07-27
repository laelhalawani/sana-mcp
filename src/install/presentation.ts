import {
  TerminalUi,
  createTerminalPolicy,
  type RenderedText,
  type TerminalEnvironment,
  type TerminalInput,
  type TerminalOutput,
  type TerminalPolicy,
} from "../app/ui.js";

export interface ConfigurerTerminal {
  input: TerminalInput;
  output: TerminalOutput;
  env: TerminalEnvironment;
  platform: NodeJS.Platform;
}

export interface ConfigurerPresentationOptions {
  terminal?: ConfigurerTerminal;
  writeLine?: (line: string) => void;
}

export interface ConfigurerPromptContext {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  clearPromptOnDone: boolean;
}

function processTerminal(): ConfigurerTerminal {
  return {
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    platform: process.platform,
  };
}

/**
 * The sole output boundary for the human configurer.
 *
 * Styling and glyph choices come from the shared app terminal policy. Dynamic
 * values are sanitized by TerminalUi before reaching the output sink.
 */
export class ConfigurerPresentation {
  readonly policy: TerminalPolicy;
  readonly ui: TerminalUi;
  readonly terminal: ConfigurerTerminal;
  private readonly writeLine: (line: string) => void;

  constructor(options: ConfigurerPresentationOptions = {}) {
    this.terminal = options.terminal ?? processTerminal();
    this.policy = createTerminalPolicy(this.terminal);
    this.ui = new TerminalUi(this.policy);
    this.writeLine =
      options.writeLine ??
      ((line) => {
        this.terminal.output.write(`${line}\n`);
      });
  }

  print(...parts: readonly unknown[]): void {
    this.writeLine(this.ui.line(...parts).text);
  }

  blank(): void {
    this.writeLine("");
  }

  rendered(value: RenderedText): string {
    return value.text;
  }

  /** Runtime streams used by every production Inquirer prompt. */
  promptContext(): ConfigurerPromptContext {
    return {
      input: this.terminal.input as NodeJS.ReadableStream,
      output: this.terminal.output as NodeJS.WritableStream,
      clearPromptOnDone: true,
    };
  }

  /** Base Inquirer theme derived from the same terminal policy as all output. */
  promptTheme() {
    const ui = this.ui;
    return {
      prefix: {
        idle: ui.color.cyan(ui.glyphs.pointer).text,
        done: ui.color.green(ui.glyphs.ok).text,
      },
      spinner: {
        interval: 80,
        frames: [...ui.spinnerFrames],
      },
      style: {
        answer: (text: string) => ui.color.cyan(text).text,
        message: (text: string) => ui.color.bold(text).text,
        error: (text: string) => ui.color.red(`> ${text}`).text,
        defaultAnswer: (text: string) => ui.color.dim(`(${text})`).text,
        help: (text: string) => ui.color.dim(text).text,
        highlight: (text: string) => ui.color.cyan(text).text,
        key: (text: string) => ui.color.cyan(`<${text}>`).text,
      },
    };
  }

  /** Checkbox-specific additions avoid Inquirer's unconditional ANSI/glyph defaults. */
  checkboxTheme() {
    const ui = this.ui;
    const base = this.promptTheme();
    return {
      ...base,
      icon: {
        checked: ui.color.green(ui.glyphs.check).text,
        unchecked: ui.glyphs.uncheck,
        cursor: ui.glyphs.pointer,
        disabledChecked: ui.color.dim(ui.glyphs.check).text,
        disabledUnchecked: ui.color.dim(ui.glyphs.uncheck).text,
      },
      style: {
        ...base.style,
        disabled: (text: string) => ui.color.dim(text).text,
        description: (text: string) => ui.color.dim(text).text,
        keysHelpTip: (keys: [key: string, action: string][]) =>
          ui.color
            .dim(keys.map(([key, action]) => `${key} ${action}`).join(" | "))
            .text,
      },
    };
  }
}
