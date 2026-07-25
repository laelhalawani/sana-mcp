import { input, select } from "@inquirer/prompts";
import {
  TerminalUi,
  createTerminalPolicy,
  type TerminalEnvironment,
  type TerminalInput,
  type TerminalOutput,
} from "./ui.js";

export interface AppPromptChoice<Value extends string> {
  readonly name: string;
  readonly value: Value;
}

export interface AppPrompts {
  readonly interactive: boolean;
  select<Value extends string>(options: {
    message: string;
    choices: readonly AppPromptChoice<Value>[];
    pageSize?: number;
  }): Promise<Value>;
  input(message: string): Promise<string>;
}

/** Apply the shared terminal policy to every interactive app prompt. */
export class TerminalAppPrompts implements AppPrompts {
  readonly interactive: boolean;
  private readonly inputStream: TerminalInput;
  private readonly outputStream: TerminalOutput;
  private readonly theme: ReturnType<TerminalAppPrompts["createTheme"]>;

  constructor(
    terminal: {
      input: TerminalInput;
      output: TerminalOutput;
      env: TerminalEnvironment;
      platform: NodeJS.Platform;
    } = {
      input: process.stdin,
      output: process.stdout,
      env: process.env,
      platform: process.platform,
    },
  ) {
    this.inputStream = terminal.input;
    this.outputStream = terminal.output;
    const policy = createTerminalPolicy(terminal);
    this.interactive = policy.interactive;
    const ui = new TerminalUi(policy);
    this.theme = this.createTheme(ui);
  }

  private createTheme(ui: TerminalUi) {
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
        disabled: (text: string) => ui.color.dim(text).text,
        description: (text: string) => ui.color.dim(text).text,
        keysHelpTip: (keys: [key: string, action: string][]) =>
          ui.color
            .dim(keys.map(([key, action]) => `${key} ${action}`).join(" | "))
            .text,
      },
    };
  }

  select<Value extends string>(options: {
    message: string;
    choices: readonly AppPromptChoice<Value>[];
    pageSize?: number;
  }): Promise<Value> {
    return select<Value>(
      {
        message: options.message,
        choices: [...options.choices],
        pageSize: options.pageSize,
        theme: this.theme,
      },
      {
        input: this.inputStream as NodeJS.ReadableStream,
        output: this.outputStream as NodeJS.WritableStream,
      },
    );
  }

  input(message: string): Promise<string> {
    return input(
      { message, theme: this.theme },
      {
        input: this.inputStream as NodeJS.ReadableStream,
        output: this.outputStream as NodeJS.WritableStream,
      },
    );
  }
}
