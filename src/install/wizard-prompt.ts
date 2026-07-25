// A custom interactive toggle-list for the sana-mcp configurer.
// - Detected clients and existing registrations are shown first.
// - `v` reveals safely configurable clients that were not detected.
// - up/down move, space toggles, enter confirms, esc/q cancels.
// - A persistent footer lists the keyboard shortcuts.
import {
  createPrompt,
  useState,
  useKeypress,
  useMemo,
  isUpKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  type Status,
} from "@inquirer/core";
import type { TerminalUi } from "../app/ui.js";

export interface WizardRow {
  id: string;
  name: string;
  detected: boolean;
  current: boolean; // currently registered?
  hint?: string; // reload hint, shown dimmed
}

export interface WizardResult {
  submitted: boolean; // false if the user cancelled
  desired: Record<string, boolean>; // id -> should be registered
}

interface WizardConfig {
  message: string;
  rows: WizardRow[];
  serverName: string;
  ui: TerminalUi;
}

export function wizardEmptyMessage(
  detectedCount: number,
  undetectedCount: number,
  showAll: boolean
): string | undefined {
  if (detectedCount + undetectedCount === 0)
    return "No safely configurable clients are available.";
  if (!showAll && detectedCount === 0 && undetectedCount > 0)
    return "No clients detected. Press v to review manual opt-in clients.";
  return undefined;
}

export const wizardPrompt = createPrompt<WizardResult, WizardConfig>((config, done) => {
  const ui = config.ui;
  const detected = useMemo(() => config.rows.filter((r) => r.detected), [config.rows]);
  const others = useMemo(() => config.rows.filter((r) => !r.detected), [config.rows]);

  const [status, setStatus] = useState<Status>("idle");
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState(0);
  // desired on/off state, seeded from current registration
  const [desired, setDesired] = useState<Record<string, boolean>>(() => {
    const d: Record<string, boolean> = {};
    for (const r of config.rows) d[r.id] = r.detected ? r.current : false;
    return d;
  });

  const selectable = showAll ? [...detected, ...others] : detected;

  useKeypress((key, rl) => {
    if (status !== "idle") return;
    if (isEnterKey(key)) {
      setStatus("done");
      done({ submitted: true, desired });
      return;
    }
    if (isUpKey(key)) {
      if (selectable.length) setCursor((cursor - 1 + selectable.length) % selectable.length);
      return;
    }
    if (isDownKey(key)) {
      if (selectable.length) setCursor((cursor + 1) % selectable.length);
      return;
    }
    if (isSpaceKey(key)) {
      const row = selectable[cursor];
      if (row) setDesired({ ...desired, [row.id]: !desired[row.id] });
      return;
    }
    const name = key.name?.toLowerCase();
    if (name === "v") {
      if (showAll && cursor >= detected.length)
        setCursor(Math.max(0, detected.length - 1));
      setShowAll(!showAll);
      return;
    }
    if (name === "a") {
      // toggle all detected on/off (on unless everything is already on)
      const allOn = selectable.every((r) => desired[r.id]);
      const next = { ...desired };
      for (const r of selectable) next[r.id] = !allOn;
      setDesired(next);
      return;
    }
    if (name === "escape" || name === "q") {
      setStatus("done");
      done({ submitted: false, desired });
      return;
    }
    // swallow other keypresses so they don't echo
    rl.clearLine(0);
  });

  if (status === "done") {
    return ui.line(config.message).text;
  }

  const lines: string[] = [ui.color.bold(config.message).text];

  const emptyMessage = wizardEmptyMessage(
    detected.length,
    others.length,
    showAll
  );
  if (emptyMessage)
    lines.push(ui.color.dim(`  ${emptyMessage}`).text);

  selectable.forEach((row, i) => {
    if (showAll && others.length > 0 && i === detected.length)
      lines.push(
        ui.color.dim("  Not detected (manual opt-in)").text
      );
    const active = i === cursor;
    const on = desired[row.id];
    const box = on
      ? ui.color.green(ui.glyphs.check)
      : ui.text(ui.glyphs.uncheck);
    const pointer = active
      ? ui.color.cyan(ui.glyphs.pointer)
      : ui.text(" ");
    const label = active ? ui.color.cyan(row.name) : ui.text(row.name);
    const changed =
      on !== row.current
        ? ui.color.yellow(on ? "  (will enable)" : "  (will disable)")
        : ui.text("");
    lines.push(ui.line(pointer, " ", box, " ", label, changed).text);
  });

  // Persistent footer: keyboard shortcuts.
  const shortcuts = [
    "up/down move",
    "space toggle",
    "a all shown",
    others.length ? `v ${showAll ? "hide" : "show"} undetected` : "",
    "enter confirm",
    "esc/q cancel",
  ]
    .filter(Boolean)
    .join("  |  ");
  lines.push("");
  lines.push(ui.color.dim(shortcuts).text);

  return lines.join("\n");
});
