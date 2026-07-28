import {
  createPrompt,
  isEnterKey,
  useKeypress,
  useRef,
  useState,
  type KeypressEvent,
} from "@inquirer/core";
import type { TerminalOutput, TerminalUi } from "./ui.js";

export type TextPromptResult =
  | { action: "submit"; value: string }
  | { action: "back" };

export interface TextPromptConfig {
  message: string;
  output: TerminalOutput;
  ui: TerminalUi;
}

function keyName(key: KeypressEvent): string {
  const sequence = (key as KeypressEvent & { sequence?: string }).sequence;
  return (key.name || sequence || "").toLowerCase();
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function removePreviousGrapheme(
  value: string,
  cursor: number,
): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  const segments = [...graphemeSegmenter.segment(value.slice(0, cursor))];
  const previous = segments.at(-1);
  if (!previous) return { value, cursor: 0 };
  return {
    value: value.slice(0, previous.index) + value.slice(cursor),
    cursor: previous.index,
  };
}

const textPrompt = createPrompt<TextPromptResult, TextPromptConfig>(
  (config, done) => {
    const [value, setValue] = useState("");
    const valueRef = useRef(value);
    const cursorRef = useRef(0);
    valueRef.current = value;

    useKeypress((key, rl) => {
      const editable = rl as typeof rl & { cursor: number };
      const name = keyName(key);
      if (isEnterKey(key)) {
        done({ action: "submit", value: valueRef.current });
        return;
      }
      if (name === "escape") {
        done({ action: "back" });
        return;
      }
      if (name === "backspace") {
        const next = removePreviousGrapheme(
          valueRef.current,
          cursorRef.current,
        );
        editable.line = next.value;
        editable.cursor = next.cursor;
        valueRef.current = next.value;
        cursorRef.current = next.cursor;
        setValue(next.value);
        return;
      }
      valueRef.current = editable.line;
      cursorRef.current = editable.cursor;
      setValue(editable.line);
    });

    const width = Math.max(
      1,
      (Number.isSafeInteger(config.output.columns) && config.output.columns! > 0
        ? config.output.columns!
        : 1) - 1,
    );
    const rows =
      Number.isSafeInteger(config.output.rows) && config.output.rows! > 0
        ? config.output.rows!
        : 1;
    const title = config.ui.color.bold(
      config.ui.truncate(config.message, width),
    ).text;
    const instructions = config.ui.color.dim(
      config.ui.truncate("Enter submit  Esc back", width),
    ).text;
    const input = config.ui.line("> ", value).text;
    if (rows === 1) return input;
    if (rows === 2) return [title, input].join("\n");
    return [title, instructions, input].join("\n");
  },
);

export function textInputPrompt(
  config: TextPromptConfig,
  context: Parameters<typeof textPrompt>[1] = {},
): ReturnType<typeof textPrompt> {
  return textPrompt(config, { ...context, clearPromptOnDone: true });
}
