import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ConfigurerPresentation } from "../../src/install/presentation.js";

test("configurer presentation uses shared terminal policy and sanitizes output", () => {
  const lines: string[] = [];
  const presentation = new ConfigurerPresentation({
    terminal: {
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      env: { NO_COLOR: "", LANG: "C.UTF-8" },
      platform: "linux",
    },
    writeLine: (line) => lines.push(line),
  });
  presentation.print(
    presentation.ui.color.red("failed"),
    ": ",
    "\u001b[2Jforged\nrow\u202e"
  );
  assert.equal(presentation.policy.interactive, true);
  assert.equal(presentation.policy.color, false);
  assert.equal(lines.join("\n"), "failed: forged row");
  assert.doesNotMatch(lines.join("\n"), /[\u001b\u202e]/u);
});

test("configurer prompt runtime uses injected streams and shared ASCII/no-color policy", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(input, { isTTY: true });
  Object.assign(output, { isTTY: true });
  const presentation = new ConfigurerPresentation({
    terminal: {
      input,
      output,
      env: { NO_COLOR: "", LANG: "C" },
      platform: "linux",
    },
  });

  const context = presentation.promptContext();
  assert.equal(context.input, input);
  assert.equal(context.output, output);
  assert.equal(context.clearPromptOnDone, true);

  const theme = presentation.promptTheme();
  assert.deepEqual(theme.spinner.frames, ["-", "\\", "|", "/"]);
  assert.equal(theme.prefix.idle, ">");
  assert.equal(theme.prefix.done, "+");
  assert.equal(theme.style.message("Heading"), "Heading");
  assert.equal(theme.style.answer("\u001b[31mvalue"), "value");

  const checkboxTheme = presentation.checkboxTheme();
  assert.equal(checkboxTheme.icon.checked, "[x]");
  assert.equal(checkboxTheme.icon.unchecked, "[ ]");
  assert.equal(
    checkboxTheme.style.keysHelpTip([["space", "toggle"], ["enter", "confirm"]]),
    "space toggle | enter confirm"
  );
  assert.doesNotMatch(
    JSON.stringify({ theme, checkboxTheme }),
    /\u001b\[/u
  );
});
