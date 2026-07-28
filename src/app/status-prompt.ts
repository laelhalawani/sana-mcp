import {
  createPrompt,
  ExitPromptError,
  isEnterKey,
  useEffect,
  useKeypress,
  useRef,
  useState,
  type KeypressEvent,
} from "@inquirer/core";
import type { StatusInfo } from "../core/status.js";
import type { TerminalOutput, TerminalUi } from "./ui.js";

export type SyncStatusPromptResult = { action: "back" | "quit" };

export interface SyncStatusPromptConfig {
  getStatus(): StatusInfo;
  output: TerminalOutput;
  ui: TerminalUi;
  mode: "status" | "setup";
  setup?: {
    connectedClients: number;
    signedIn: boolean;
  };
}

interface PromptState {
  status: StatusInfo;
  frame: number;
  updatedAt: number;
  error: string | null;
}

function keyName(key: KeypressEvent): string {
  const sequence = (key as KeypressEvent & { sequence?: string }).sequence;
  return (key.name || sequence || "").toLowerCase();
}

function dimensions(output: TerminalOutput): { rows: number; columns: number } {
  return {
    rows: Number.isSafeInteger(output.rows) && output.rows! > 0 ? output.rows! : 1,
    columns:
      Number.isSafeInteger(output.columns) && output.columns! > 0
        ? output.columns!
        : 1,
  };
}

function phaseLabel(status: StatusInfo): string {
  if (status.authTransition) return "Authentication not ready";
  if (!status.session.loggedIn) {
    return status.session.expired ? "Sana session expired" : "Sign in required";
  }
  if (status.phase === "synced" && status.remaining === 0) return "Up to date";
  if (status.phase === "listing") return "Discovering meetings";
  if (status.phase === "needs_login") return "Sign in required";
  if (status.phase === "error") return "Sync needs attention";
  return "Syncing meetings";
}

function progressBar(done: number, total: number, width: number): string {
  if (total <= 0 || width < 8) return "";
  const filled = Math.max(0, Math.min(width, Math.floor((done / total) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

const statusPrompt = createPrompt<SyncStatusPromptResult, SyncStatusPromptConfig>(
  (config, done) => {
    const [state, setState] = useState<PromptState>(() => ({
      status: config.getStatus(),
      frame: 0,
      updatedAt: Date.now(),
      error: null,
    }));
    const stateRef = useRef(state);
    stateRef.current = state;

    const refreshStatus = () => {
      try {
        setState({
          status: config.getStatus(),
          frame: stateRef.current.frame + 1,
          updatedAt: Date.now(),
          error: null,
        });
      } catch (error) {
        setState({
          ...stateRef.current,
          frame: stateRef.current.frame + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    useEffect(() => {
      const timer = setInterval(refreshStatus, 1_000);
      return () => clearInterval(timer);
    }, []);

    useKeypress((key) => {
      const name = keyName(key);
      if (key.ctrl && name === "c") {
        done({ action: "quit" });
      } else if (isEnterKey(key) || name === "escape") {
        done({ action: "back" });
      } else if (name === "q" && config.mode === "status") {
        done({ action: "quit" });
      } else if (name === "r") {
        refreshStatus();
      }
    });

    const ui = config.ui;
    const measured = dimensions(config.output);
    const width = Math.max(1, measured.columns - 1);
    const availableRows = measured.columns === 1 ? Math.max(0, measured.rows - 1) : measured.rows;
    const status = state.status;
    const authProblem =
      !status.session.loggedIn || status.authTransition !== undefined;
    const complete =
      !authProblem && status.phase === "synced" && status.remaining === 0;
    const attention =
      authProblem || status.error !== null || status.syncUnavailable !== undefined;
    const glyph = complete
      ? ui.glyphs.ok
      : attention
        ? ui.glyphs.fail
        : ui.spinnerFrames[state.frame % ui.spinnerFrames.length]!;
    const body: string[] = [];
    const phaseLine = ui.truncate(`${glyph} ${phaseLabel(status)}`, width);
    body.push(
      complete
        ? ui.color.green(phaseLine).text
        : attention
          ? ui.color.red(phaseLine).text
          : ui.color.cyan(phaseLine).text,
    );

    if (config.mode === "setup" && config.setup) {
      const setup = config.setup;
      const sanaSignedIn =
        setup.signedIn &&
        status.session.loggedIn &&
        status.authTransition === undefined;
      body.push(
        "",
        ui.color.green(
          ui.truncate(
            `${ui.glyphs.ok} AI clients  ${setup.connectedClients} connected`,
            width,
          ),
        ).text,
        (sanaSignedIn ? ui.color.green : ui.color.yellow)(
          ui.truncate(
            `${sanaSignedIn ? ui.glyphs.ok : ui.glyphs.pending} Sana account  ${sanaSignedIn ? "signed in" : phaseLabel(status)}`,
            width,
          ),
        ).text,
      );
    }
    if (!authProblem && status.meetings !== null) {
      body.push(`  Meetings ready     ${status.meetings}`);
    }
    if (!authProblem && status.remaining !== null && status.remaining > 0) {
      body.push(
        `  Pending            ${status.remaining}${status.retrying ? ` (${status.retrying} retrying)` : ""}`,
      );
    }
    if (!authProblem && status.transcripts !== null) {
      body.push(`  Transcripts stored ${status.transcripts}`);
    }
    if (
      !authProblem &&
      status.meetings !== null &&
      status.meetingsTotal !== null &&
      status.meetingsTotal > 0 &&
      width >= 24
    ) {
      body.push(
        ui.color.cyan(
          ui.truncate(
            `  ${progressBar(status.meetings, status.meetingsTotal, Math.min(24, width - 4))}`,
            width,
          ),
        ).text,
      );
    }
    if (!authProblem && status.message) body.push("", status.message);
    if (config.mode === "status") {
      if (status.authTransition) {
        body.push("", `Authentication: ${status.authTransition.message}`);
      } else if (!status.session.loggedIn) {
        body.push(
          "",
          status.session.expired
            ? "Your Sana session has expired. Sign in again."
            : "You are not signed in to Sana.",
        );
      } else {
        body.push(
          "",
          "Sana session: signed in; access is checked before every sync cycle.",
        );
      }
      if (
        status.session.loggedIn &&
        !status.authTransition &&
        status.lastIncrementalMs
      ) {
        body.push(
          `Last completed sync: ${new Date(status.lastIncrementalMs).toLocaleString()}`,
        );
      }
      if (
        status.session.loggedIn &&
        !status.authTransition &&
        status.daemonHeartbeatMs
      ) {
        body.push(
          `Daemon heartbeat: ${new Date(status.daemonHeartbeatMs).toLocaleString()}`,
        );
      }
    }
    if (status.error) body.push("", `Sync error: ${status.error}`);
    if (status.syncUnavailable) {
      body.push("", `Background sync unavailable: ${status.syncUnavailable.message}`);
    }
    if (state.error) body.push("", `Status refresh failed: ${state.error}`);
    if (config.mode === "status") {
      body.push(
        "",
        ui.color.dim(
          ui.truncate(
            `Updated ${new Date(state.updatedAt).toLocaleTimeString()}`,
            width,
          ),
        ).text,
      );
    }

    const footer =
      config.mode === "setup"
        ? "Enter finish setup - sync continues in the background"
        : "auto-refreshing  r refresh  Enter/Esc menu  q quit";
    const title = ui.color.bold(
      ui.truncate(
        config.mode === "setup" ? "sana-mcp setup" : "Sync status",
        width,
      ),
    ).text;
    const bodyCapacity = Math.max(0, availableRows - 2);
    const visibleBody = body.slice(0, bodyCapacity);
    const rendered = [title, ...visibleBody];
    while (rendered.length < Math.max(1, availableRows - 1)) rendered.push("");
    if (availableRows >= 2) {
      rendered.push(ui.color.dim(ui.truncate(footer, width)).text);
    }
    return rendered
      .slice(0, availableRows)
      .map((line) => (line.includes("\x1b[") ? line : ui.truncate(line, width)))
      .join("\n");
  },
);

export function syncStatusPrompt(
  config: SyncStatusPromptConfig,
  context: Parameters<typeof statusPrompt>[1] = {},
): ReturnType<typeof statusPrompt> {
  return statusPrompt(config, { ...context, clearPromptOnDone: true }).catch(
    (error) => {
      if (error instanceof ExitPromptError) return { action: "quit" } as const;
      throw error;
    },
  );
}
