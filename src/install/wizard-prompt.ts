// A custom interactive toggle-list for the sana-mcp configurer.
// - Rows are the DETECTED clients, each a checkbox reflecting its CURRENT
//   registration state (on = registered).
// - up/down move, space toggles, enter confirms, esc/q cancels.
// - `v` reveals the non-detected clients as dimmed, unselectable rows.
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
  makeTheme,
  usePrefix,
  type Status,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";

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
}

// ANSI helpers (kept local so we don't depend on a color lib).
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
};

export const wizardPrompt = createPrompt<WizardResult, WizardConfig>((config, done) => {
  const theme = makeTheme({});
  const detected = useMemo(() => config.rows.filter((r) => r.detected), [config.rows]);
  const others = useMemo(() => config.rows.filter((r) => !r.detected), [config.rows]);

  const [status, setStatus] = useState<Status>("idle");
  const prefix = usePrefix({ status, theme });
  const [showAll, setShowAll] = useState(false);
  const [cursor, setCursor] = useState(0);
  // desired on/off state, seeded from current registration
  const [desired, setDesired] = useState<Record<string, boolean>>(() => {
    const d: Record<string, boolean> = {};
    for (const r of config.rows) d[r.id] = r.detected ? r.current : false;
    return d;
  });

  // Only detected rows are selectable.
  const selectable = detected;

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
    return `${prefix} ${config.message}`;
  }

  const lines: string[] = [`${prefix} ${c.bold(config.message)}`];

  if (selectable.length === 0) {
    lines.push(c.dim("  No supported AI clients detected on this machine."));
  }

  selectable.forEach((row, i) => {
    const active = i === cursor;
    const on = desired[row.id];
    const box = on ? c.green("[x]") : "[ ]";
    const pointer = active ? c.cyan(">") : " ";
    const label = active ? c.cyan(row.name) : row.name;
    const changed = on !== row.current ? c.yellow(on ? "  (will enable)" : "  (will disable)") : "";
    lines.push(`${pointer} ${box} ${label}${changed}`);
  });

  if (showAll && others.length) {
    lines.push(c.dim("  - not detected -"));
    for (const row of others) {
      lines.push(c.dim(`    [ ] ${row.name}`));
    }
  }

  // Persistent footer: keyboard shortcuts.
  const shortcuts = [
    `${c.bold("up/down")} move`,
    `${c.bold("space")} toggle`,
    `${c.bold("a")} all`,
    others.length ? `${c.bold("v")} ${showAll ? "hide" : "show"} undetected` : "",
    `${c.bold("enter")} confirm`,
    `${c.bold("esc/q")} cancel`,
  ]
    .filter(Boolean)
    .join(c.dim("  |  "));
  lines.push("");
  lines.push(c.dim(shortcuts));

  return `${lines.join("\n")}${cursorHide}`;
});
