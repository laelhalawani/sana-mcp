import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  useKeypress,
  useRef,
  useState,
  type KeypressEvent,
} from "@inquirer/core";
import { rowStatus, type ArtifactProblem } from "../core/meetings.js";
import type { MeetingListRow } from "../store/db.js";
import type { AppRuntime } from "./runtime.js";
import type { TerminalOutput, TerminalUi } from "./ui.js";

export type MeetingBrowserResult =
  | { action: "quit" }
  | { action: "account" }
  | { action: "configure" };

export interface MeetingBrowserConfig {
  runtime: AppRuntime;
  output: TerminalOutput;
  ui: TerminalUi;
}

type BrowserView =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "detail"; id: string; title: string; lines: string[]; loading: boolean };

interface BrowserModel {
  status: ReturnType<AppRuntime["status"]>;
  page: ReturnType<AppRuntime["meetings"]> | null;
  selectedId: string | null;
  filter: string;
  filterInput: string | null;
  listTop: number;
  scroll: number;
  view: BrowserView;
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

function layoutDimensions(
  output: TerminalOutput,
): { rows: number; columns: number } {
  const measured = dimensions(output);
  return {
    ...measured,
    rows:
      measured.columns === 1
        ? Math.max(0, measured.rows - 1)
        : measured.rows,
  };
}

function meetingArgs(filter: string): Record<string, unknown> {
  return {
    limit: 1000,
    page: 1,
    ...(filter ? { query: filter } : {}),
  };
}

function initialModel(runtime: AppRuntime): BrowserModel {
  const status = runtime.status();
  const page =
    status.session.loggedIn && !status.blocking
      ? runtime.meetings(meetingArgs(""))
      : null;
  return {
    status,
    page,
    selectedId: page?.rows[0]?.id ?? null,
    filter: "",
    filterInput: null,
    listTop: 0,
    scroll: 0,
    view: { kind: "list" },
  };
}

function selectedIndex(model: BrowserModel): number {
  if (model.page === null || model.page.rows.length === 0) return -1;
  const index = model.page.rows.findIndex((row) => row.id === model.selectedId);
  return index < 0 ? 0 : index;
}

function keepSelection(
  rows: readonly MeetingListRow[],
  selectedId: string | null,
): string | null {
  if (selectedId !== null && rows.some((row) => row.id === selectedId)) {
    return selectedId;
  }
  return rows[0]?.id ?? null;
}

function artifactLines(problem: ArtifactProblem): string[] {
  const subject =
    problem.name === undefined
      ? `meeting ${problem.id}`
      : `${problem.artifact} for ${problem.name}`;
  return [
    `The cached ${subject} is ${problem.kind} (${problem.code}).`,
    ...(problem.detail ? [problem.detail] : []),
    "Re-sync the meeting cache before retrying.",
  ];
}

function transcriptDetail(runtime: AppRuntime, id: string): BrowserView {
  const result = runtime.transcript(id);
  if (result.kind === "ok") {
    return {
      kind: "detail",
      id,
      title: result.name,
      loading: false,
      lines: result.lines.map(
        (line) => `${line.n} [${line.time}] ${line.speaker}: ${line.text}`,
      ),
    };
  }
  if (result.kind === "no-meeting") {
    return detail(id, "Transcript", [`No meeting found with ID ${id}.`]);
  }
  if (result.kind === "still-listing") {
    return detail(id, "Transcript", ["The meeting list is still syncing."]);
  }
  if (result.kind === "not-downloaded") {
    return detail(id, result.name, [
      `Transcript is downloading (${result.done}/${result.total}).`,
    ]);
  }
  return detail(id, result.name ?? "Transcript", artifactLines(result));
}

function summaryDetail(runtime: AppRuntime, id: string): BrowserView {
  const result = runtime.summary(id);
  if (result.kind === "ok") {
    const view = result.view;
    return detail(id, view.name, [
      ...(view.summaryShort ? [view.summaryShort] : []),
      ...(view.summary ? [view.summary] : []),
      ...view.actionItems.map(
        (item) => `- ${item.action}${item.assignedTo ? ` - ${item.assignedTo}` : ""}`,
      ),
      ...view.notes.flatMap((topic) => [
        topic.topic,
        ...topic.notes.map((note) => `- ${note}`),
      ]),
    ]);
  }
  if (result.kind === "no-meeting") {
    return detail(id, "Summary", [`No meeting found with ID ${id}.`]);
  }
  if (result.kind === "none") {
    return detail(id, result.name, ["No summary is available."]);
  }
  return detail(id, result.name ?? "Summary", artifactLines(result));
}

function participantsDetail(runtime: AppRuntime, id: string): BrowserView {
  const result = runtime.participants(id);
  if (result.kind === "ok") {
    return detail(
      id,
      result.name,
      result.participants.map(
        (participant) =>
          `${participant.displayName}${participant.email ? `  ${participant.email}` : ""}${
            participant.isHost ? "  (host)" : ""
          }`,
      ),
    );
  }
  if (result.kind === "no-meeting") {
    return detail(id, "Participants", [`No meeting found with ID ${id}.`]);
  }
  if (result.kind === "none") {
    return detail(id, result.name, ["No participants are available."]);
  }
  return detail(id, result.name ?? "Participants", artifactLines(result));
}

function detail(id: string, title: string, lines: string[]): BrowserView {
  return { kind: "detail", id, title, lines, loading: false };
}

function recordingLines(
  id: string,
  result: Awaited<ReturnType<AppRuntime["recording"]>>,
): BrowserView {
  if (result.kind === "ok") return detail(id, result.name, [result.url]);
  if (result.kind === "none") {
    return detail(id, result.name, ["No recording is available."]);
  }
  if (result.kind === "no-meeting") {
    return detail(id, "Recording", [`No meeting found with ID ${id}.`]);
  }
  if (result.kind === "expired") {
    return detail(id, "Recording", ["Your Sana session has expired. Sign in again."]);
  }
  return detail(id, "Recording", [
    `Could not load the recording link: ${result.message}`,
  ]);
}

function statusLines(status: BrowserModel["status"]): string[] {
  if (!status.session.loggedIn) {
    return [
      status.session.expired
        ? "Your Sana session has expired. Sign in again."
        : "You are not signed in to Sana.",
    ];
  }
  return [
    `Sync: ${status.phase.replaceAll("_", " ")}`,
    ...(status.meetings === null ? [] : [`Meetings: ${status.meetings}`]),
    ...(status.transcriptsDone === null || status.transcriptsTotal === null
      ? []
      : [`Transcripts: ${status.transcriptsDone}/${status.transcriptsTotal}`]),
    ...(status.authTransition
      ? [`Authentication: ${status.authTransition.message}`]
      : []),
    ...(status.error ? [`Sync error: ${status.error}`] : []),
    ...(status.syncUnavailable
      ? [`Background sync unavailable: ${status.syncUnavailable.message}`]
      : []),
  ];
}

const HELP_LINES = [
  "up/down or j/k move; pgup/pgdn/home/end jump",
  "enter/t transcript; s summary; p participants; o recording",
  "/ filter titles; r refresh; i status; a account; c configure",
  "esc back; q quit",
];

function clearInput(rl: { write: (...args: never[]) => void }): void {
  rl.write(null as never, { ctrl: true, name: "u" } as never);
}

function keyName(key: KeypressEvent): string {
  const sequence = (key as KeypressEvent & { sequence?: string }).sequence;
  return (key.name || sequence || "").toLowerCase();
}

const browserPrompt = createPrompt<MeetingBrowserResult, MeetingBrowserConfig>(
  (config, done) => {
    const [model, setModel] = useState<BrowserModel>(() =>
      initialModel(config.runtime),
    );
    const modelRef = useRef(model);
    const requestToken = useRef(0);
    modelRef.current = model;

    const bodyRows = () =>
      Math.max(0, layoutDimensions(config.output).rows - 2);
    const refresh = () => {
      requestToken.current += 1;
      try {
        config.runtime.refresh();
        const status = config.runtime.status();
        const page =
          status.session.loggedIn && !status.blocking
            ? config.runtime.meetings(meetingArgs(modelRef.current.filter))
            : null;
        setModel({
          ...modelRef.current,
          status,
          page,
          selectedId: keepSelection(
            page?.rows ?? [],
            modelRef.current.selectedId,
          ),
          listTop: 0,
          scroll: 0,
          view: { kind: "list" },
        });
      } catch (error) {
        setModel({
          ...modelRef.current,
          scroll: 0,
          view: detail(
            modelRef.current.selectedId ?? "",
            "Refresh failed",
            [error instanceof Error ? error.message : String(error)],
          ),
        });
      }
    };

    const openSelected = (kind: "transcript" | "summary" | "participants") => {
      const id = modelRef.current.selectedId;
      if (id === null) return;
      requestToken.current += 1;
      try {
        const view =
          kind === "transcript"
            ? transcriptDetail(config.runtime, id)
            : kind === "summary"
              ? summaryDetail(config.runtime, id)
              : participantsDetail(config.runtime, id);
        setModel({ ...modelRef.current, view, scroll: 0 });
      } catch (error) {
        setModel({
          ...modelRef.current,
          view: detail(id, kind, [
            error instanceof Error ? error.message : String(error),
          ]),
          scroll: 0,
        });
      }
    };

    const openRecording = async () => {
      const id = modelRef.current.selectedId;
      if (id === null) return;
      const token = ++requestToken.current;
      setModel({
        ...modelRef.current,
        scroll: 0,
        view: {
          kind: "detail",
          id,
          title: "Recording",
          lines: ["Loading recording..."],
          loading: true,
        },
      });
      try {
        const result = await config.runtime.recording(id);
        const current = modelRef.current;
        if (
          requestToken.current !== token ||
          current.selectedId !== id ||
          current.view.kind !== "detail" ||
          current.view.id !== id
        ) {
          return;
        }
        setModel({ ...current, view: recordingLines(id, result), scroll: 0 });
      } catch (error) {
        const current = modelRef.current;
        if (
          requestToken.current !== token ||
          current.selectedId !== id ||
          current.view.kind !== "detail" ||
          current.view.id !== id
        ) {
          return;
        }
        setModel({
          ...current,
          view: detail(id, "Recording", [
            error instanceof Error ? error.message : String(error),
          ]),
          scroll: 0,
        });
      }
    };

    useKeypress(async (key, rl) => {
      const name = keyName(key);
      const current = modelRef.current;

      if (current.filterInput !== null) {
        if (isEnterKey(key)) {
          const filter = current.filterInput.trim();
          clearInput(rl);
          if (current.status.blocking) {
            setModel({ ...current, filterInput: null });
            return;
          }
          try {
            const page = config.runtime.meetings(meetingArgs(filter));
            setModel({
              ...current,
              page,
              selectedId: keepSelection(page.rows, current.selectedId),
              filter,
              filterInput: null,
              listTop: 0,
            });
          } catch (error) {
            setModel({
              ...current,
              filterInput: null,
              scroll: 0,
              view: detail(current.selectedId ?? "", "Filter failed", [
                error instanceof Error ? error.message : String(error),
              ]),
            });
          }
          return;
        }
        if (name === "escape") {
          clearInput(rl);
          setModel({ ...current, filterInput: null });
          return;
        }
        setModel({ ...current, filterInput: rl.line });
        return;
      }

      if (name === "q") {
        requestToken.current += 1;
        done({ action: "quit" });
        return;
      }
      if (name === "a") {
        requestToken.current += 1;
        done({ action: "account" });
        return;
      }
      if (name === "c") {
        requestToken.current += 1;
        done({ action: "configure" });
        return;
      }
      if (name === "r") {
        refresh();
        return;
      }
      if (name === "i") {
        requestToken.current += 1;
        setModel({ ...current, view: { kind: "status" }, scroll: 0 });
        return;
      }
      if (name === "?") {
        requestToken.current += 1;
        setModel({ ...current, view: { kind: "help" }, scroll: 0 });
        return;
      }

      if (current.view.kind !== "list") {
        if (name === "escape") {
          requestToken.current += 1;
          setModel({ ...current, view: { kind: "list" }, scroll: 0 });
          return;
        }
        const viewLines =
          current.view.kind === "detail"
            ? current.view.lines
            : current.view.kind === "status"
              ? statusLines(current.status)
              : HELP_LINES;
        const capacity = Math.max(1, bodyRows());
        const maximum = Math.max(0, viewLines.length - capacity);
        const delta = isUpKey(key)
          ? -1
          : isDownKey(key)
            ? 1
            : name === "pageup"
              ? -capacity
              : name === "pagedown"
                ? capacity
                : 0;
        if (delta !== 0 || name === "home" || name === "end") {
          setModel({
            ...current,
            scroll:
              name === "home"
                ? 0
                : name === "end"
                  ? maximum
                  : Math.max(0, Math.min(maximum, current.scroll + delta)),
          });
        }
        return;
      }

      if (current.status.blocking) {
        if (name === "escape") done({ action: "quit" });
        return;
      }
      if (name === "escape") {
        done({ action: "quit" });
        return;
      }
      if (name === "/") {
        clearInput(rl);
        setModel({ ...current, filterInput: "" });
        return;
      }
      if (isEnterKey(key) || name === "t") {
        openSelected("transcript");
        return;
      }
      if (name === "s") {
        openSelected("summary");
        return;
      }
      if (name === "p") {
        openSelected("participants");
        return;
      }
      if (name === "o") {
        await openRecording();
        return;
      }

      const rows = current.page?.rows ?? [];
      if (rows.length === 0) return;
      const index = selectedIndex(current);
      const capacity = Math.max(1, bodyRows());
      let next = index;
      if (isUpKey(key) || name === "k") next -= 1;
      else if (isDownKey(key) || name === "j") next += 1;
      else if (name === "pageup") next -= capacity;
      else if (name === "pagedown") next += capacity;
      else if (name === "home") next = 0;
      else if (name === "end") next = rows.length - 1;
      else return;
      next = Math.max(0, Math.min(rows.length - 1, next));
      let listTop = Math.max(
        0,
        Math.min(current.listTop, Math.max(0, rows.length - capacity)),
      );
      if (next < listTop) listTop = next;
      if (next >= listTop + capacity) listTop = next - capacity + 1;
      setModel({ ...current, selectedId: rows[next]!.id, listTop });
    });

    const ui = config.ui;
    const measured = layoutDimensions(config.output);
    const columns = measured.columns;
    const availableRows = measured.rows;
    // Leave one column unused so Inquirer never adds a wrap-protection row.
    const renderWidth = Math.max(1, columns - 1);
    const capacity = Math.max(0, availableRows - 2);
    let header = "sana-mcp";
    let body: string[] = [];
    let footer = "q quit  a account  c configure";

    if (model.filterInput !== null) {
      header =
        capacity === 0
          ? `Filter: ${model.filterInput}`
          : "Filter meetings";
      body = capacity > 0 ? [`/ ${model.filterInput}`] : [];
      footer = "enter apply  esc cancel";
    } else if (model.view.kind === "status") {
      header = "Sync status";
      body = statusLines(model.status).slice(model.scroll, model.scroll + capacity);
      footer = "r refresh  esc meetings  a account  c configure  q quit";
    } else if (model.view.kind === "help") {
      header = "Keyboard help";
      body = HELP_LINES.slice(model.scroll, model.scroll + capacity);
      footer = "up/down scroll  esc meetings  q quit";
    } else if (model.view.kind === "detail") {
      header = `${model.view.loading ? "Loading: " : ""}${model.view.title}`;
      const maximum = Math.max(0, model.view.lines.length - capacity);
      const scroll = Math.max(0, Math.min(maximum, model.scroll));
      body = model.view.lines.slice(scroll, scroll + capacity);
      footer = "up/down scroll  pgup/pgdn page  esc meetings  q quit";
    } else if (model.status.blocking) {
      header = "sana-mcp | preparing meeting cache";
      body = statusLines(model.status).slice(0, capacity);
      footer = "r refresh  i status  a account  c configure  q quit";
    } else {
      const meetingRows = model.page?.rows ?? [];
      header = `Meetings (${model.page?.total ?? 0})${
        model.filter ? ` | filter: ${model.filter}` : ""
      }`;
      const index = selectedIndex(model);
      let top = Math.max(
        0,
        Math.min(model.listTop, Math.max(0, meetingRows.length - capacity)),
      );
      if (capacity > 0 && index >= 0) {
        if (index < top) top = index;
        if (index >= top + capacity) top = index - capacity + 1;
      }
      body = meetingRows.slice(top, top + capacity).map((row) => {
        const pointer = row.id === model.selectedId ? ui.glyphs.pointer : " ";
        const date = new Date(row.created_at_ms).toLocaleDateString();
        return `${pointer} ${date}  ${row.name}  [${rowStatus(row)}]`;
      });
      if (body.length === 0 && capacity > 0) body = ["No synced meetings found."];
      footer = "/ filter  enter transcript  s summary  p people  o recording  ? help";
    }

    const rendered: string[] = [];
    if (availableRows >= 1) {
      rendered.push(ui.color.bold(ui.truncate(header, renderWidth)).text);
    }
    if (availableRows >= 3) {
      rendered.push(
        ...body
          .slice(0, capacity)
          .map((line) => ui.truncate(line, renderWidth)),
      );
      while (rendered.length < availableRows - 1) rendered.push("");
    }
    if (availableRows >= 2) {
      rendered.push(ui.color.dim(ui.truncate(footer, renderWidth)).text);
    }
    return rendered.slice(0, availableRows).join("\n");
  },
);

export function meetingBrowserPrompt(
  config: MeetingBrowserConfig,
  context: Parameters<typeof browserPrompt>[1] = {},
): ReturnType<typeof browserPrompt> {
  return browserPrompt(config, { ...context, clearPromptOnDone: true });
}
