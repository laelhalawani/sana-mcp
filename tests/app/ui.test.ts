import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  Frame,
  TerminalUi,
  createTerminalPolicy,
  displayWidth,
  sanitizeTerminalText,
  type TerminalEnvironment,
  withTerminalFrame,
} from "../../src/app/ui.js";

class Output extends EventEmitter {
  isTTY = true;
  columns: number | undefined = 10;
  rows: number | undefined = 24;
  output = "";

  write(value: string): boolean {
    this.output += value;
    return true;
  }
}

class Input {
  isTTY = true;
  isRaw = false;
  changes: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.changes.push(mode);
  }
}

class FlakyOutput extends Output {
  failCursorRestore = true;
  failListenerRemoval = true;

  override write(value: string): boolean {
    if (value === "\x1b[?25h" && this.failCursorRestore) {
      this.failCursorRestore = false;
      throw new Error("cursor restore blocked");
    }
    return super.write(value);
  }

  override off(event: "resize", listener: () => void): this {
    if (this.failListenerRemoval) {
      this.failListenerRemoval = false;
      throw new Error("listener removal blocked");
    }
    return super.off(event, listener);
  }
}

class FlakyInput extends Input {
  failRawRestore = true;

  override setRawMode(mode: boolean): void {
    if (!mode && this.failRawRestore) {
      this.failRawRestore = false;
      throw new Error("raw restore blocked");
    }
    super.setRawMode(mode);
  }
}

function frameOptions(
  output = new Output(),
  input = new Input(),
  env: TerminalEnvironment = { LANG: "C.UTF-8" }
) {
  return {
    output,
    input,
    options: {
      policy: { input, output, env, platform: "linux" as const },
      manageProcessSignals: false,
    },
  };
}

describe("terminal policy", () => {
  test("disables controls for redirects, dumb terminals, and CI", () => {
    const base = {
      input: { isTTY: true },
      output: { isTTY: true, columns: 90, rows: 30, write() {} },
      platform: "linux" as const,
    };
    expect(createTerminalPolicy({ ...base, env: { LANG: "C.UTF-8" } })).toMatchObject({
      interactive: true,
      control: true,
      color: true,
      unicode: true,
      columns: 90,
    });
    expect(
      createTerminalPolicy({ ...base, output: { ...base.output, isTTY: false }, env: {} })
    ).toMatchObject({ interactive: false, control: false, color: false, unicode: false });
    expect(createTerminalPolicy({ ...base, env: { TERM: "dumb" } }).control).toBe(false);
    expect(createTerminalPolicy({ ...base, env: { TERM: "dumb" } }).interactive).toBe(false);
    expect(createTerminalPolicy({ ...base, env: { CI: "true" } }).interactive).toBe(false);
    expect(createTerminalPolicy({ ...base, env: { NO_COLOR: "" } }).color).toBe(false);
  });

  test("is conservative for Windows Unicode and identifies WSL", () => {
    const input = { isTTY: true };
    const output = { isTTY: true, write() {} };
    expect(createTerminalPolicy({ input, output, env: {}, platform: "win32" }).unicode).toBe(false);
    expect(
      createTerminalPolicy({ input, output, env: { WT_SESSION: "id" }, platform: "win32" }).unicode
    ).toBe(true);
    expect(
      createTerminalPolicy({
        input,
        output,
        env: { WSL_DISTRO_NAME: "Ubuntu", LANG: "C.UTF-8" },
        platform: "linux",
      }).wsl
    ).toBe(true);
  });

  test("uses neutral no-op glyphs that cannot look like key-value output", () => {
    const base = {
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      platform: "linux" as const,
    };
    expect(
      new TerminalUi(
        createTerminalPolicy({ ...base, env: { LANG: "C.UTF-8" } }),
      ).glyphs.noop,
    ).toBe("·");
    expect(
      new TerminalUi(createTerminalPolicy({ ...base, env: { LANG: "C" } }))
        .glyphs.noop,
    ).toBe(".");
  });
});

describe("human UI sanitization", () => {
  test("only provenance-marked styles survive the public render sink", () => {
    const { output, options } = frameOptions();
    const subject = new Frame(options);
    const ui = subject.ui;
    const attack = "\x1b]8;;https://evil.test\u0007click\x1b]8;;\u0007\u202e\nforged";
    const screen = ui.frame({
      header: ui.header(attack, attack),
      body: [ui.row(attack, attack, attack, attack)],
    });
    subject.render([...screen, "\x1b[31muntrusted\x1b[0m"]);
    subject.done();
    const rendered = output.output;
    expect(rendered).not.toContain("\x1b]");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain("\nforged");
    expect(rendered).not.toContain("\x1b[31muntrusted");
    expect(rendered).toContain("\x1b[1mclick forged\x1b[0m");
    expect(rendered).toContain("\x1b[0m");
  });

  test("does not trust styled values created for another or changed policy", () => {
    const first = frameOptions();
    const second = frameOptions(new Output(), new Input(), { NO_COLOR: "" });
    const coloredFrame = new Frame(first.options);
    const plainFrame = new Frame(second.options);
    const foreign = coloredFrame.ui.color.red("foreign");
    const localBeforeRedirect = coloredFrame.ui.color.red("redirected");

    coloredFrame.render([foreign]);
    coloredFrame.render([localBeforeRedirect]);
    first.output.isTTY = false;
    coloredFrame.render([localBeforeRedirect]);
    plainFrame.render([foreign]);
    second.output.isTTY = false;
    const formerlyValid = plainFrame.ui.color.red("redirected");
    plainFrame.render([formerlyValid]);
    coloredFrame.done();
    plainFrame.done();

    expect(first.output.output).toContain("\x1b[31mforeign\x1b[0m");
    expect(first.output.output.match(/\x1b\[31m/g)).toHaveLength(2);
    expect(first.output.output).toContain("redirected\n");
    expect(second.output.output).not.toContain("\x1b[31m");
    expect(second.output.output).toContain("foreign");
    expect(second.output.output).toContain("redirected");
  });
});

describe("terminal text safety and width", () => {
  test("removes CSI, OSC, controls, and bidirectional overrides", () => {
    const source =
      "\x1b[31mred\x1b[0m\x1b]0;title\u0007\x1bPpayload\x1b\\\u0000\u202e\r\nnext";
    expect(sanitizeTerminalText(source)).toBe("red next");
    expect(
      sanitizeTerminalText("one\r\n\r\ntwo\rthree\tvalue", {
        multiline: true,
      }),
    ).toBe("one\n\ntwo\nthree\tvalue");
  });

  test("measures graphemes, wide characters, and combining marks", () => {
    expect(displayWidth("a")).toBe(1);
    expect(displayWidth("界")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👩‍💻")).toBe(2);
    expect(displayWidth("🇩🇪")).toBe(2);
    expect(displayWidth("1️⃣")).toBe(2);
  });

  test("truncates and wraps without splitting graphemes or overflowing", () => {
    const unicode = new TerminalUi(createTerminalPolicy({
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      env: { LANG: "C.UTF-8" },
      platform: "linux",
    }));
    expect(unicode.truncate("a界bc", 4)).toBe("a界…");
    expect(unicode.wrap("alpha betabetabeta", 6)).toEqual(["alpha", "betabe", "tabeta"]);
    for (const line of unicode.wrap("👩‍💻👩‍💻👩‍💻", 4)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(4);
    }
  });
});

describe("width-aware components", () => {
  test("fits tables and uses stacked rows when minimum columns cannot fit", () => {
    const columns = [
      { header: "Name", value: (item: { name: string; count: number }) => item.name, minWidth: 3 },
      {
        header: "Count",
        value: (item: { name: string; count: number }) => item.count,
        minWidth: 3,
        align: "right" as const,
      },
    ];
    const rows = [{ name: "A very long title", count: 42 }];
    const policy = createTerminalPolicy({
      input: { isTTY: false },
      output: { isTTY: false, write() {} },
      env: {},
      platform: "linux",
    });
    const ui = new TerminalUi(policy);
    for (const line of ui.table(columns, rows, 12)) expect(displayWidth(line)).toBeLessThanOrEqual(12);
    for (const line of ui.table(columns, rows, 5)) expect(displayWidth(line)).toBeLessThanOrEqual(5);
    expect(ui.table(columns, rows, 12)[1]).not.toContain("─");
  });

  test("renders bounded rules and panels in Unicode or ASCII", () => {
    const ascii = new TerminalUi(createTerminalPolicy({
      input: { isTTY: false },
      output: { isTTY: false, write() {} },
      env: {},
      platform: "linux",
    }));
    expect(ascii.rule(3)).toBe("---");
    const panel = ascii.panel(["content longer than line"], 10, "Title");
    expect(panel[0]).toStartWith("+");
    for (const line of panel) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(ascii.panel(["tiny"], 4)).toEqual(["tiny"]);

    const unicode = new TerminalUi(createTerminalPolicy({
      input: { isTTY: true },
      output: { isTTY: true, write() {} },
      env: { LANG: "C.UTF-8" },
      platform: "linux",
    }));
    expect(unicode.rule(3)).toBe("───");
    expect(unicode.truncationMarker).toBe("…");
    expect(ascii.truncationMarker).toBe("...");
  });
});

describe("Frame", () => {
  test("redraws from the model at the new width without moving above reflowed content", () => {
    const { output, options } = frameOptions();
    const subject = new Frame(options);
    const observedWidths: Array<number | null> = [];
    subject.renderModel((ui, policy) => {
      observedWidths.push(policy.columns);
      return [ui.text(`width=${policy.columns}`)];
    });
    const beforeResize = output.output.length;
    output.columns = 5;
    output.emit("resize");
    const resizeOutput = output.output.slice(beforeResize);
    subject.done(["settled"]);

    expect(resizeOutput).toContain("\x1b[?25h");
    expect(resizeOutput).toContain("\x1b[?25l");
    expect(resizeOutput).toContain("width=5");
    expect(resizeOutput).not.toMatch(/\x1b\[\d+A/);
    expect(observedWidths).toEqual([10, 5]);
    expect(output.output).toContain("\x1b[2A\x1b[G\x1b[J");
    expect(output.output).toEndWith("\x1b[?25h");
    expect(output.output).not.toContain("\x1b[2J");
    expect(output.listenerCount("resize")).toBe(0);
  });

  test("does not attach resize when the listener cannot be removed", () => {
    let listenersAdded = 0;
    const output = {
      isTTY: true,
      columns: 10,
      rows: 20,
      write() {},
      on() {
        listenersAdded += 1;
      },
    };
    const input = new Input();
    const subject = new Frame({
      policy: {
        input,
        output,
        env: { LANG: "C.UTF-8" },
        platform: "linux",
      },
      manageProcessSignals: false,
    });
    subject.render(["live"]);
    expect(listenersAdded).toBe(0);
    subject.restore();
  });

  test("restores raw mode and cursor when an operation throws", async () => {
    const output = new Output();
    const input = new Input();
    const subject = new Frame({
      policy: { input, output, env: { LANG: "C.UTF-8" }, platform: "linux" },
      manageProcessSignals: false,
    });

    await expect(
      withTerminalFrame(subject, () => {
        subject.enterRawMode();
        subject.render(["live"]);
        throw new Error("stop");
      })
    ).rejects.toThrow("stop");
    expect(input.changes).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(output.output).toEndWith("\x1b[?25h");
  });

  test("restores the terminal when a live redraw model throws", () => {
    const { output, options } = frameOptions();
    const subject = new Frame(options);
    subject.renderModel((ui) => [ui.text("live")]);
    expect(() =>
      subject.renderModel(() => {
        throw new Error("model failed");
      })
    ).toThrow("model failed");
    expect(output.output).toEndWith("\x1b[?25h");
    expect(output.listenerCount("resize")).toBe(0);
  });

  test("retains failed cleanup ownership and restores every resource on retry", () => {
    const output = new FlakyOutput();
    const input = new FlakyInput();
    const subject = new Frame({
      policy: { input, output, env: { LANG: "C.UTF-8" }, platform: "linux" },
      manageProcessSignals: false,
    });
    subject.enterRawMode();
    subject.render(["live"]);

    expect(() => subject.restore()).toThrow("terminal restoration failed");
    expect(input.isRaw).toBe(true);
    expect(output.listenerCount("resize")).toBe(1);

    subject.restore();
    expect(input.isRaw).toBe(false);
    expect(output.listenerCount("resize")).toBe(0);
    expect(output.output).toEndWith("\x1b[?25h");
  });

  test("reference-counts process hooks and reinstalls them for later frames", () => {
    const baseline = {
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    const make = () => {
      const { options } = frameOptions();
      return new Frame({ ...options, manageProcessSignals: true });
    };
    const first = make();
    const second = make();
    first.render(["first"]);
    second.render(["second"]);
    expect(process.listenerCount("exit")).toBe(baseline.exit + 1);
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm + 1);
    first.restore();
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1);
    second.restore();
    expect(process.listenerCount("exit")).toBe(baseline.exit);
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm);

    const later = make();
    later.render(["later"]);
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1);
    later.restore();
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint);
  });

  test("emits settled plain lines without controls when redirected", () => {
    const output = new Output();
    output.isTTY = false;
    const subject = new Frame({
      policy: { input: { isTTY: false }, output, env: {}, platform: "linux" },
      manageProcessSignals: false,
    });
    subject.render(["one"]);
    subject.render(["two"]);
    subject.done();
    expect(output.output).toBe("one\ntwo\n");
  });
});
