import {
  createPrompt,
  ExitPromptError,
  isDownKey,
  isEnterKey,
  isUpKey,
  useEffect,
  useKeypress,
  useRef,
  useState,
  type KeypressEvent,
} from "@inquirer/core";
import { rowStatus, type ArtifactProblem } from "../core/meetings.js";
import {
  retryDelayMs,
  type MeetingListOpts,
  type MeetingListRow,
} from "../store/db.js";
import type { AppRuntime } from "./runtime.js";
import type { TerminalOutput, TerminalUi } from "./ui.js";

export type MeetingBrowserResult =
  | { action: "quit" }
  | { action: "back" };

export interface MeetingBrowserConfig {
  runtime: AppRuntime;
  output: TerminalOutput;
  ui: TerminalUi;
}

type BrowserView =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "sync"; id: string }
  | { kind: "actions"; id: string; title: string; selected: number }
  | { kind: "detail"; id: string; title: string; lines: string[]; loading: boolean };

type StatusFilter = NonNullable<MeetingListOpts["status"]>;
type StatusFilterChoice = StatusFilter | "all";
const STATUS_FILTERS: readonly StatusFilterChoice[] = [
  "all",
  "ready",
  "downloading",
  "processing",
  "retrying",
];
const MEETING_ACTIONS = [
  { label: "Transcript", value: "transcript" },
  { label: "Summary", value: "summary" },
  { label: "Participants", value: "participants" },
  { label: "Recording", value: "recording" },
  { label: "Sync details", value: "sync" },
  { label: "Back to meetings", value: "back" },
] as const;

interface BrowserModel {
  status: ReturnType<AppRuntime["status"]>;
  page: ReturnType<AppRuntime["meetings"]> | null;
  selectedId: string | null;
  filter: string;
  filterInput: string | null;
  statusFilter: StatusFilter | null;
  statusFilterInput: StatusFilterChoice | null;
  listTop: number;
  scroll: number;
  refreshError: string | null;
  updatedAt: number;
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

function meetingArgs(
  filter: string,
  statusFilter: StatusFilter | null,
): Record<string, unknown> {
  return {
    limit: 1000,
    page: 1,
    ...(filter ? { query: filter } : {}),
    ...(statusFilter ? { filter: { status: statusFilter } } : {}),
  };
}

function initialModel(runtime: AppRuntime): BrowserModel {
  const status = runtime.status();
  const page =
    status.session.loggedIn && !status.blocking
      ? runtime.meetings(meetingArgs("", null))
      : null;
  return {
    status,
    page,
    selectedId: page?.rows[0]?.id ?? null,
    filter: "",
    filterInput: null,
    statusFilter: null,
    statusFilterInput: null,
    listTop: 0,
    scroll: 0,
    refreshError: null,
    updatedAt: Date.now(),
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

function syncDetailLines(row: MeetingListRow | undefined): string[] {
  if (!row) return ["This meeting is no longer present in the current filter."];
  const status = rowStatus(row);
  const lines = [
    `Status: ${status}`,
    `Transcript: ${row.has_transcript ? "ready" : "missing"}`,
    `Metadata: ${row.has_metadata ? "ready" : "missing"}`,
  ];
  if (status === "ready") {
    lines.push("This meeting is fully downloaded and available.");
    return lines;
  }
  if (status === "processing") {
    lines.push("Sana is still processing this meeting; it is not in the download queue yet.");
    return lines;
  }
  lines.push("Queue: meetings are processed one at a time.");
  if (row.attempts > 0) lines.push(`Attempts: ${row.attempts}`);
  if (row.last_attempt_ms !== null) {
    lines.push(`Last attempt: ${new Date(row.last_attempt_ms).toLocaleString()}`);
    const retryAt = row.last_attempt_ms + retryDelayMs(row.attempts);
    lines.push(
      retryAt > Date.now()
        ? `Next retry: ${new Date(retryAt).toLocaleString()}`
        : "Retry eligibility: ready now; waiting for its turn in the queue.",
    );
  }
  if (row.last_error) lines.push(`Last error: ${row.last_error}`);
  if (status === "downloading") {
    lines.push("Waiting for its turn in the sequential download queue.");
  }
  return lines;
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
        (participant) => {
          const label =
            participant.displayName ??
            participant.email ??
            "Unnamed participant";
          return `${label}${participant.displayName && participant.email ? `  ${participant.email}` : ""}${
            participant.isHost ? "  (host)" : ""
          }`;
        },
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
  if (status.authTransition) {
    return [`Authentication is not ready: ${status.authTransition.message}`];
  }
  return [
    "Sana session: signed in; access is checked before every sync cycle.",
    `Sync: ${status.phase.replaceAll("_", " ")}`,
    ...(status.meetings === null ? [] : [`Meetings ready: ${status.meetings}`]),
    ...(status.remaining === null || status.remaining === 0
      ? []
      : [
          `Pending: ${status.remaining}${status.retrying ? ` (${status.retrying} retrying)` : ""}`,
        ]),
    ...(status.transcriptsDone === null || status.transcriptsTotal === null
      ? []
        : [`Transcripts stored: ${status.transcriptsDone}/${status.transcriptsTotal}`]),
    ...(status.message ? [status.message] : []),
    ...(status.lastIncrementalMs
      ? [`Last completed sync: ${new Date(status.lastIncrementalMs).toLocaleString()}`]
      : []),
    ...(status.daemonHeartbeatMs
      ? [`Daemon heartbeat: ${new Date(status.daemonHeartbeatMs).toLocaleString()}`]
      : []),
    ...(status.error ? [`Sync error: ${status.error}`] : []),
    ...(status.syncUnavailable
      ? [`Background sync unavailable: ${status.syncUnavailable.message}`]
      : []),
  ];
}

const HELP_LINES = [
  "up/down or j/k move; pgup/pgdn/home/end jump",
  "enter meeting actions; t transcript; s summary; p participants; o recording",
  "/ filter name; f filter status; c clear filters; r refresh; i status",
  "esc menu; q quit",
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
    const refresh = (view?: BrowserView, showError = false) => {
      const current = modelRef.current;
      try {
        config.runtime.refresh();
        const status = config.runtime.status();
        const page =
          status.session.loggedIn && !status.blocking
            ? config.runtime.meetings(
                meetingArgs(current.filter, current.statusFilter),
              )
            : null;
        setModel({
          ...current,
          status,
          page,
          selectedId: keepSelection(
            page?.rows ?? [],
            current.selectedId,
          ),
          refreshError: null,
          updatedAt: Date.now(),
          view: view ?? current.view,
        });
      } catch (error) {
        if (!showError) {
          setModel({
            ...current,
            refreshError: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        setModel({
          ...current,
          scroll: 0,
          view: detail(
            current.selectedId ?? "",
            "Refresh failed",
            [error instanceof Error ? error.message : String(error)],
          ),
        });
      }
    };

    useEffect(() => {
      const timer = setInterval(() => {
        const current = modelRef.current;
        if (
          current.filterInput === null &&
          current.statusFilterInput === null
        ) {
          refresh(undefined, false);
        }
      }, 1_000);
      return () => clearInterval(timer);
    }, []);

    const openSelected = (
      kind: "transcript" | "summary" | "participants",
      requestedId?: string,
    ) => {
      const id = requestedId ?? modelRef.current.selectedId;
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

    const openRecording = async (requestedId?: string) => {
      const id = requestedId ?? modelRef.current.selectedId;
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

      if (key.ctrl && name === "c") {
        requestToken.current += 1;
        done({ action: "quit" });
        return;
      }

      if (current.filterInput !== null) {
        if (isEnterKey(key)) {
          const filter = current.filterInput.trim();
          clearInput(rl);
          if (current.status.blocking) {
            setModel({ ...current, filterInput: null });
            return;
          }
          try {
            const page = config.runtime.meetings(
              meetingArgs(filter, current.statusFilter),
            );
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

      if (current.statusFilterInput !== null) {
        const index = STATUS_FILTERS.indexOf(current.statusFilterInput);
        if (isEnterKey(key)) {
          const statusFilter =
            current.statusFilterInput === "all"
              ? null
              : current.statusFilterInput;
          try {
            const page = config.runtime.meetings(
              meetingArgs(current.filter, statusFilter),
            );
            setModel({
              ...current,
              page,
              selectedId: keepSelection(page.rows, current.selectedId),
              statusFilter,
              statusFilterInput: null,
              listTop: 0,
            });
          } catch (error) {
            setModel({
              ...current,
              statusFilterInput: null,
              scroll: 0,
              view: detail(current.selectedId ?? "", "Status filter failed", [
                error instanceof Error ? error.message : String(error),
              ]),
            });
          }
          return;
        }
        if (name === "escape") {
          setModel({ ...current, statusFilterInput: null });
          return;
        }
        if (isUpKey(key) || isDownKey(key) || name === "j" || name === "k") {
          const delta = isUpKey(key) || name === "k" ? -1 : 1;
          const next =
            (index + delta + STATUS_FILTERS.length) % STATUS_FILTERS.length;
          setModel({ ...current, statusFilterInput: STATUS_FILTERS[next]! });
        }
        return;
      }

      if (name === "q") {
        requestToken.current += 1;
        done({ action: "quit" });
        return;
      }
      if (name === "r") {
        refresh(undefined, true);
        return;
      }
      if (name === "i") {
        refresh({ kind: "status" }, true);
        return;
      }
      if (name === "?") {
        requestToken.current += 1;
        setModel({ ...current, view: { kind: "help" }, scroll: 0 });
        return;
      }

      if (current.view.kind === "actions") {
        if (name === "escape") {
          setModel({ ...current, view: { kind: "list" }, scroll: 0 });
          return;
        }
        if (name === "t") {
          openSelected("transcript", current.view.id);
          return;
        }
        if (name === "s") {
          openSelected("summary", current.view.id);
          return;
        }
        if (name === "p") {
          openSelected("participants", current.view.id);
          return;
        }
        if (name === "o") {
          await openRecording(current.view.id);
          return;
        }
        if (isUpKey(key) || isDownKey(key) || name === "j" || name === "k") {
          const delta = isUpKey(key) || name === "k" ? -1 : 1;
          const selected = Math.max(
            0,
            Math.min(MEETING_ACTIONS.length - 1, current.view.selected + delta),
          );
          setModel({
            ...current,
            view: { ...current.view, selected },
          });
          return;
        }
        if (isEnterKey(key)) {
          const action = MEETING_ACTIONS[current.view.selected]!.value;
          if (action === "back") {
            setModel({ ...current, view: { kind: "list" }, scroll: 0 });
          } else if (action === "recording") {
            await openRecording(current.view.id);
          } else if (action === "sync") {
            setModel({
              ...current,
              view: { kind: "sync", id: current.view.id },
              scroll: 0,
            });
          } else {
            openSelected(action, current.view.id);
          }
        }
        return;
      }

      if (current.view.kind !== "list") {
        if (name === "escape") {
          requestToken.current += 1;
          setModel({ ...current, view: { kind: "list" }, scroll: 0 });
          return;
        }
        const syncId = current.view.kind === "sync" ? current.view.id : null;
        const viewLines =
          current.view.kind === "detail"
            ? current.view.lines
            : current.view.kind === "sync"
              ? syncDetailLines(
                  current.page?.rows.find((row) => row.id === syncId),
                )
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
        if (name === "escape") done({ action: "back" });
        return;
      }
      if (name === "escape") {
        done({ action: "back" });
        return;
      }
      if (name === "/") {
        clearInput(rl);
        if (current.filter) rl.write(current.filter as never);
        setModel({ ...current, filterInput: current.filter });
        return;
      }
      if (name === "f") {
        setModel({
          ...current,
          statusFilterInput: current.statusFilter ?? "all",
        });
        return;
      }
      if (name === "c") {
        if ((!current.filter && !current.statusFilter) || current.status.blocking) {
          return;
        }
        try {
          const page = config.runtime.meetings(meetingArgs("", null));
          setModel({
            ...current,
            page,
            selectedId: keepSelection(page.rows, current.selectedId),
            filter: "",
            filterInput: null,
            statusFilter: null,
            listTop: 0,
          });
        } catch (error) {
          setModel({
            ...current,
            view: detail(current.selectedId ?? "", "Clear filters failed", [
              error instanceof Error ? error.message : String(error),
            ]),
          });
        }
        return;
      }
      if (name === "d") {
        if (current.selectedId !== null) {
          setModel({
            ...current,
            view: { kind: "sync", id: current.selectedId },
            scroll: 0,
          });
        }
        return;
      }
      if (isEnterKey(key) || name === "t") {
        if (isEnterKey(key) && current.selectedId !== null) {
          const selected = current.page?.rows.find(
            (row) => row.id === current.selectedId,
          );
          setModel({
            ...current,
            view: {
              kind: "actions",
              id: current.selectedId,
              title: selected?.name ?? current.selectedId,
              selected: 0,
            },
            scroll: 0,
          });
        } else {
          openSelected("transcript");
        }
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
    let footer = "esc menu  q quit";

    if (model.filterInput !== null) {
      header =
        capacity === 0
          ? `Filter: ${model.filterInput}`
          : "Filter meetings";
      body =
        capacity > 1
          ? ["Type part of a meeting title", `/ ${model.filterInput}`]
          : capacity > 0
            ? [`/ ${model.filterInput}`]
            : [];
      footer = "enter apply  esc cancel";
    } else if (model.statusFilterInput !== null) {
      const selectedIndex = STATUS_FILTERS.indexOf(model.statusFilterInput);
      const top = Math.max(
        0,
        Math.min(
          selectedIndex - Math.max(0, capacity - 1),
          Math.max(0, STATUS_FILTERS.length - capacity),
        ),
      );
      header = `Filter meetings by status (${selectedIndex + 1}/${STATUS_FILTERS.length})`;
      body = STATUS_FILTERS.slice(top, top + capacity).map((status) => {
        const selected = status === model.statusFilterInput;
        const label = status === "all" ? "All statuses" : status;
        return `${selected ? ui.glyphs.pointer : " "} ${label}`;
      });
      footer = "up/down choose  enter apply  esc cancel";
    } else if (model.view.kind === "status") {
      header = "Sync status";
      body = statusLines(model.status).slice(model.scroll, model.scroll + capacity);
      if (model.refreshError) body.push(`Refresh failed: ${model.refreshError}`);
      footer = "auto-refreshing  r refresh  esc meetings  q quit";
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
    } else if (model.view.kind === "actions") {
      const selected = model.view.selected;
      const top = Math.max(
        0,
        Math.min(
          selected - Math.max(0, capacity - 1),
          Math.max(0, MEETING_ACTIONS.length - capacity),
        ),
      );
      header = model.view.title;
      body = MEETING_ACTIONS.slice(top, top + capacity).map((action, index) => {
        const active = top + index === selected;
        return `${active ? ui.glyphs.pointer : " "} ${action.label}`;
      });
      footer = "up/down choose  enter open  t transcript  s summary  p participants  esc back";
    } else if (model.view.kind === "sync") {
      const syncId = model.view.id;
      const row = model.page?.rows.find((item) => item.id === syncId);
      header = `Sync details | ${row?.name ?? syncId}`;
      const lines = syncDetailLines(row);
      const maximum = Math.max(0, lines.length - capacity);
      const scroll = Math.max(0, Math.min(maximum, model.scroll));
      body = lines.slice(scroll, scroll + capacity);
      footer = "auto-refreshing  pgup/pgdn page  esc meetings  q quit";
    } else if (model.status.blocking) {
      header = "sana-mcp | preparing meeting cache";
      body = statusLines(model.status).slice(0, capacity);
      footer = "auto-refreshing  r refresh  i status  esc menu  q quit";
    } else {
      const meetingRows = model.page?.rows ?? [];
      header = `Meetings | ${model.status.meetings ?? 0} ready${
        model.status.remaining ? ` | ${model.status.remaining} syncing` : ""
      }${model.filter ? ` | name: ${model.filter}` : ""}${
        model.statusFilter ? ` | status: ${model.statusFilter}` : ""
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
        const date = new Date(row.created_at_ms).toISOString().slice(0, 10);
        const status = rowStatus(row);
        const statusToken = `[${status.padEnd(11)}]`;
        const raw = ui.truncate(
          `${pointer} ${date}  ${statusToken} ${row.name}`,
          renderWidth,
        );
        const styledStatus =
          status === "ready"
            ? ui.color.green(statusToken).text
            : status === "downloading"
              ? ui.color.cyan(statusToken).text
              : ui.color.yellow(statusToken).text;
        const withStatus = raw.replace(statusToken, styledStatus);
        return row.id === model.selectedId
          ? withStatus.replace(pointer, ui.color.cyan(pointer).text)
          : withStatus;
      });
      if (body.length === 0 && capacity > 0) {
        body = [
          model.filter || model.statusFilter
            ? "No meetings match the current filters. Press / or f to edit, or c to clear."
            : "No ready or syncing meetings found.",
        ];
      }
      footer = "Enter actions  t transcript  s summary  p participants  PgUp/PgDn page  / filter by name  f filter by status";
    }

    const rendered: string[] = [];
    if (availableRows >= 1) {
      rendered.push(ui.color.bold(ui.truncate(header, renderWidth)).text);
    }
    if (availableRows >= 3) {
      rendered.push(
        ...body
          .slice(0, capacity)
          .map((line) =>
            line.includes("\x1b[") ? line : ui.truncate(line, renderWidth),
          ),
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
  return browserPrompt(config, { ...context, clearPromptOnDone: true }).catch(
    (error) => {
      if (error instanceof ExitPromptError) return { action: "quit" } as const;
      throw error;
    },
  );
}
