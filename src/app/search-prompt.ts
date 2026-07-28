import {
  createPrompt,
  ExitPromptError,
  isDownKey,
  isEnterKey,
  isUpKey,
  useKeypress,
  useRef,
  useState,
  type KeypressEvent,
} from "@inquirer/core";
import {
  snippetAround,
  type SearchResult,
  type SearchRow,
  type SearchSort,
} from "../core/search.js";
import type { StatusInfo } from "../core/status.js";
import type { AppRuntime } from "./runtime.js";
import {
  sanitizeTerminalText,
  type TerminalOutput,
  type TerminalUi,
} from "./ui.js";

export type SearchPromptResult = { action: "back" | "quit" };

export interface SearchPromptConfig {
  runtime: AppRuntime;
  output: TerminalOutput;
  ui: TerminalUi;
  /** Backend page size. Defaults to 10 and must be within the search API limit. */
  pageSize?: number;
}

interface SemanticCoverage {
  enabled: boolean;
  embedded: number | null;
  total: number | null;
}

interface TranscriptState {
  title: string;
  rawLines: string[];
  targetRawIndex: number;
  /** Null keeps the matching line centered as dimensions change. */
  scroll: number | null;
}

interface SearchModel {
  view: "query" | "running" | "results" | "transcript";
  editValue: string;
  inputError: string | null;
  query: string;
  page: number;
  sort: SearchSort;
  selected: number;
  listTop: number;
  response: SearchResult | null;
  failure: string | null;
  coverage: SemanticCoverage | null;
  transcript: TranscriptState | null;
}

interface CardLine {
  text: string;
  highlight: boolean;
}

interface ResultWindow {
  top: number;
  end: number;
}

interface PreparedTranscript {
  rawLines: string[];
  targetRawIndex: number;
  width: number;
  lines: string[];
  target: number;
}

const SORTS: readonly SearchSort[] = ["best", "newest", "oldest"];

function keyName(key: KeypressEvent): string {
  const sequence = (key as KeypressEvent & { sequence?: string }).sequence;
  return (key.name || sequence || "").toLowerCase();
}

function dimensions(output: TerminalOutput): { rows: number; columns: number } {
  const rows = Number.isSafeInteger(output.rows) && output.rows! > 0
    ? output.rows!
    : 1;
  const columns = Number.isSafeInteger(output.columns) && output.columns! > 0
    ? output.columns!
    : 1;
  return {
    rows: columns === 1 ? Math.max(0, rows - 1) : rows,
    columns,
  };
}

function semanticCoverage(runtime: AppRuntime): SemanticCoverage | null {
  try {
    const semantic = runtime.status().semantic;
    return {
      enabled: semantic.enabled,
      embedded: semantic.embedded,
      total: semantic.total,
    };
  } catch {
    return null;
  }
}

function coverageLabel(coverage: SemanticCoverage | null): string | null {
  if (coverage === null) return null;
  if (coverage.embedded !== null && coverage.total !== null) {
    return `semantic index ${coverage.embedded}/${coverage.total}${
      coverage.enabled ? "" : " (disabled)"
    }`;
  }
  return coverage.enabled ? "semantic index enabled" : null;
}

function clearInput(rl: { write: (...args: never[]) => void }): void {
  rl.write(null as never, { ctrl: true, name: "u" } as never);
}

function clearHandledShortcut(
  rl: { line?: string; write: (...args: never[]) => void },
): void {
  if (rl.line) clearInput(rl);
}

function beginInput(
  rl: { write: (...args: never[]) => void },
  value: string,
): void {
  clearInput(rl);
  if (value) rl.write(value as never);
}

function safeDate(value: number): string {
  if (!Number.isFinite(value)) return "Invalid date";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid date"
    : date.toISOString().slice(0, 10);
}

function queryTerms(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].sort(
    (left, right) => right.length - left.length,
  );
}

function literalPattern(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const escaped = terms.map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`(${escaped.join("|")})`, "giu");
}

function highlighted(
  ui: TerminalUi,
  value: string,
  pattern: RegExp | null,
): string {
  const text = sanitizeTerminalText(value);
  if (pattern === null) return text;
  pattern.lastIndex = 0;
  const parts: unknown[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push(ui.color.yellow(match[0]));
    offset = index + match[0].length;
  }
  if (offset === 0) return text;
  if (offset < text.length) parts.push(text.slice(offset));
  return ui.line(...parts).text;
}

function cardLines(
  row: SearchRow,
  selected: boolean,
  anchor: string,
  width: number,
  ui: TerminalUi,
): CardLine[] {
  const pointer = selected ? ui.glyphs.pointer : " ";
  const title = ui.truncate(`${pointer} ${row.name}`, width);
  const metadata = ui.truncate(
    `  ${safeDate(row.created_at_ms)}  line ${row.line_no}`,
    width,
  );
  const snippetWidth = Math.max(1, width - Math.min(2, width - 1));
  const prefix = width > 2 ? "  " : "";
  const snippet = ui
    .wrap(snippetAround(row.text, anchor), snippetWidth)
    .slice(0, 2)
    .map((line) => ({ text: prefix + line, highlight: true }));
  return [
    { text: title, highlight: false },
    { text: metadata, highlight: false },
    ...snippet,
    { text: "", highlight: false },
  ];
}

function cardHeight(
  row: SearchRow,
  anchor: string,
  width: number,
  ui: TerminalUi,
): number {
  return cardLines(row, false, anchor, width, ui).length;
}

function resultWindow(
  rows: readonly SearchRow[],
  requestedTop: number,
  selected: number,
  capacity: number,
  anchor: string,
  width: number,
  ui: TerminalUi,
): ResultWindow {
  if (rows.length === 0 || capacity <= 0) return { top: 0, end: 0 };
  let top = Math.max(0, Math.min(requestedTop, rows.length - 1));
  if (selected < top) top = selected;

  const fit = (start: number): number => {
    let used = 0;
    let end = start;
    while (end < rows.length) {
      const height = cardHeight(rows[end]!, anchor, width, ui);
      if (end > start && used + height > capacity) break;
      used += height;
      end += 1;
      if (used >= capacity) break;
    }
    return end;
  };

  let end = fit(top);
  if (selected >= end) {
    top = selected;
    end = fit(top);
  }
  return { top, end };
}

function transcriptProblemLines(
  result: Exclude<ReturnType<AppRuntime["transcript"]>, { kind: "ok" }>,
  id: string,
): { title: string; lines: string[] } {
  if (result.kind === "no-meeting") {
    return { title: "Transcript", lines: [`No meeting found with ID ${id}.`] };
  }
  if (result.kind === "still-listing") {
    return { title: "Transcript", lines: ["The meeting list is still syncing."] };
  }
  if (result.kind === "not-downloaded") {
    return {
      title: result.name,
      lines: [`Transcript is downloading (${result.done}/${result.total}).`],
    };
  }
  return {
    title: result.name ?? "Transcript",
    lines: [
      `The cached ${result.artifact} is ${result.kind} (${result.code}).`,
      ...(result.detail ? [result.detail] : []),
      "Re-sync the meeting cache before retrying.",
    ],
  };
}

function transcriptDocument(
  transcript: TranscriptState,
  width: number,
  ui: TerminalUi,
): { lines: string[]; target: number } {
  const lines: string[] = [];
  let target = 0;
  transcript.rawLines.forEach((line, index) => {
    if (index === transcript.targetRawIndex) target = lines.length;
    lines.push(...ui.wrap(sanitizeTerminalText(line), width));
  });
  return { lines, target };
}

function resultMode(result: Extract<SearchResult, { kind: "ok" }>): string {
  return result.degradation ? `degraded ${result.mode}` : result.mode;
}

function degradationMessage(
  result: Extract<SearchResult, { kind: "ok" }>,
): string | null {
  if (!result.degradation) return null;
  const detail = result.degradation.message;
  return detail
    ? `Semantic unavailable: ${result.degradation.code}: ${detail}`
    : `Semantic unavailable: ${result.degradation.code}`;
}

function padScreen(
  lines: string[],
  rows: number,
  footer: string,
  width: number,
  ui: TerminalUi,
): string {
  const rendered = lines.slice(0, Math.max(0, rows - 1));
  while (rendered.length < Math.max(0, rows - 1)) rendered.push("");
  if (rows >= 1) rendered.push(ui.color.dim(ui.truncate(footer, width)).text);
  return rendered.slice(0, rows).join("\n");
}

const searchPromptInternal = createPrompt<SearchPromptResult, SearchPromptConfig>(
  (config, done) => {
    const pageSize = config.pageSize ?? 10;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError("search pageSize must be an integer from 1 to 100");
    }

    const [model, setModel] = useState<SearchModel>(() => ({
      view: "query",
      editValue: "",
      inputError: null,
      query: "",
      page: 1,
      sort: "best",
      selected: 0,
      listTop: 0,
      response: null,
      failure: null,
      coverage: semanticCoverage(config.runtime),
      transcript: null,
    }));
    const modelRef = useRef(model);
    const editValueRef = useRef(model.editValue);
    const requestToken = useRef(0);
    const requestController = useRef<AbortController | null>(null);
    const requestStart = useRef<ReturnType<typeof setTimeout> | null>(null);
    const coverageRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
    const preparedTranscript = useRef<PreparedTranscript | null>(null);
    const pendingTranscriptScroll = useRef<{
      rawLines: string[];
      value: number;
    } | null>(null);
    const transcriptScrollCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
    modelRef.current = model;
    editValueRef.current = model.editValue;

    const transcriptLayout = (
      transcript: TranscriptState,
      width: number,
    ): PreparedTranscript => {
      const cached = preparedTranscript.current;
      if (
        cached !== null &&
        cached.rawLines === transcript.rawLines &&
        cached.targetRawIndex === transcript.targetRawIndex &&
        cached.width === width
      ) {
        return cached;
      }
      const document = transcriptDocument(transcript, width, config.ui);
      const prepared = {
        rawLines: transcript.rawLines,
        targetRawIndex: transcript.targetRawIndex,
        width,
        ...document,
      };
      preparedTranscript.current = prepared;
      return prepared;
    };

    const cancelTranscriptScroll = (): void => {
      if (transcriptScrollCommit.current !== null) {
        clearTimeout(transcriptScrollCommit.current);
      }
      transcriptScrollCommit.current = null;
      pendingTranscriptScroll.current = null;
    };

    const scheduleTranscriptScroll = (
      transcript: TranscriptState,
      value: number,
    ): void => {
      pendingTranscriptScroll.current = { rawLines: transcript.rawLines, value };
      if (transcriptScrollCommit.current !== null) return;
      transcriptScrollCommit.current = setTimeout(() => {
        transcriptScrollCommit.current = null;
        const pending = pendingTranscriptScroll.current;
        pendingTranscriptScroll.current = null;
        const latest = modelRef.current;
        if (
          pending === null ||
          latest.view !== "transcript" ||
          latest.transcript === null ||
          latest.transcript.rawLines !== pending.rawLines ||
          latest.transcript.scroll === pending.value
        ) {
          return;
        }
        setModel({
          ...latest,
          transcript: { ...latest.transcript, scroll: pending.value },
        });
      }, 0);
    };

    const scheduleCoverageRefresh = (token: number): void => {
      if (coverageRefresh.current !== null) clearTimeout(coverageRefresh.current);
      coverageRefresh.current = setTimeout(() => {
        coverageRefresh.current = null;
        if (requestToken.current !== token) return;
        const coverage = semanticCoverage(config.runtime);
        const latest = modelRef.current;
        if (
          latest.view !== "results" ||
          (latest.coverage?.enabled === coverage?.enabled &&
            latest.coverage?.embedded === coverage?.embedded &&
            latest.coverage?.total === coverage?.total)
        ) {
          return;
        }
        setModel({ ...latest, coverage });
      }, 0);
    };

    const runSearch = (
      query: string,
      page: number,
      sort: SearchSort,
    ): void => {
      if (requestStart.current !== null) clearTimeout(requestStart.current);
      requestStart.current = null;
      if (coverageRefresh.current !== null) clearTimeout(coverageRefresh.current);
      coverageRefresh.current = null;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const token = ++requestToken.current;
      const current = modelRef.current;
      setModel({
        ...current,
        view: "running",
        query,
        page,
        sort,
        selected: 0,
        listTop: 0,
        response: null,
        failure: null,
        inputError: null,
        coverage: current.coverage,
        transcript: null,
      });
      // Let Inquirer paint the loading state before any synchronous database
      // prefix in the runtime search occupies the event loop.
      requestStart.current = setTimeout(() => {
        requestStart.current = null;
        void config.runtime
          .search({ query, page, limit: pageSize, sort }, controller.signal)
          .then(
          (response) => {
            const latest = modelRef.current;
            if (
              requestToken.current !== token ||
              latest.view !== "running" ||
              latest.query !== query ||
              latest.page !== page ||
              latest.sort !== sort
            ) {
              return;
            }
            setModel({
              ...latest,
              view: "results",
              response,
              failure: null,
              page: response.kind === "ok" ? response.page : page,
              sort: response.kind === "ok" ? response.sort : sort,
              selected: 0,
              listTop: 0,
            });
            scheduleCoverageRefresh(token);
          },
          (error: unknown) => {
            const latest = modelRef.current;
            if (
              requestToken.current !== token ||
              latest.view !== "running" ||
              latest.query !== query ||
              latest.page !== page ||
              latest.sort !== sort
            ) {
              return;
            }
            setModel({
              ...latest,
              view: "results",
              response: null,
              failure: error instanceof Error ? error.message : String(error),
              selected: 0,
              listTop: 0,
            });
            scheduleCoverageRefresh(token);
          },
          );
      }, 0);
    };

    const editQuery = (rl: { write: (...args: never[]) => void }): void => {
      if (requestStart.current !== null) clearTimeout(requestStart.current);
      requestStart.current = null;
      requestController.current?.abort();
      requestController.current = null;
      requestToken.current += 1;
      const current = modelRef.current;
      beginInput(rl, current.query);
      editValueRef.current = current.query;
      setModel({
        ...current,
        view: "query",
        editValue: current.query,
        inputError: null,
        transcript: null,
      });
    };

    const openTranscript = (): void => {
      const current = modelRef.current;
      if (current.response?.kind !== "ok") return;
      const row = current.response.rows[current.selected];
      if (!row) return;
      let title: string;
      let rawLines: string[];
      let targetRawIndex = 0;
      try {
        const result = config.runtime.transcript(row.meeting_id);
        if (result.kind === "ok") {
          title = result.name;
          rawLines = result.lines.map(
            (line) => `${line.n} [${line.time}] ${line.speaker}: ${line.text}`,
          );
          const match = result.lines.findIndex((line) => line.n === row.line_no);
          targetRawIndex = match < 0 ? 0 : match;
        } else {
          const problem = transcriptProblemLines(result, row.meeting_id);
          title = problem.title;
          rawLines = problem.lines;
        }
      } catch (error) {
        title = "Transcript failed";
        rawLines = [error instanceof Error ? error.message : String(error)];
      }

      const draft: TranscriptState = {
        title,
        rawLines,
        targetRawIndex,
        scroll: null,
      };
      preparedTranscript.current = null;
      cancelTranscriptScroll();
      setModel({ ...current, view: "transcript", transcript: draft });
    };

    useKeypress((key, rl) => {
      const name = keyName(key);
      const current = modelRef.current;

      if (current.view === "query") {
        const editable = rl as typeof rl & { cursor: number };
        if (isEnterKey(key)) {
          const query = editValueRef.current.trim();
          if (!query) {
            setModel({
              ...current,
              editValue: editable.line,
              inputError: "Enter at least one word to search.",
            });
            return;
          }
          clearInput(rl);
          runSearch(query, 1, current.sort);
          return;
        }
        if (name === "escape") {
          requestController.current?.abort();
          requestController.current = null;
          requestToken.current += 1;
          clearInput(rl);
          done({ action: "back" });
          return;
        }
        editValueRef.current = editable.line;
        setModel({
          ...current,
          editValue: editable.line,
          inputError: null,
        });
        return;
      }

      if (key.ctrl && name === "c") {
        cancelTranscriptScroll();
        if (coverageRefresh.current !== null) clearTimeout(coverageRefresh.current);
        coverageRefresh.current = null;
        if (requestStart.current !== null) clearTimeout(requestStart.current);
        requestStart.current = null;
        requestController.current?.abort();
        requestController.current = null;
        requestToken.current += 1;
        done({ action: "quit" });
        return;
      }
      clearHandledShortcut(rl);
      if (name === "q") {
        cancelTranscriptScroll();
        if (coverageRefresh.current !== null) clearTimeout(coverageRefresh.current);
        coverageRefresh.current = null;
        if (requestStart.current !== null) clearTimeout(requestStart.current);
        requestStart.current = null;
        requestController.current?.abort();
        requestController.current = null;
        requestToken.current += 1;
        done({ action: "quit" });
        return;
      }

      if (current.view === "running") {
        if (name === "escape" || name === "/" || name === "e") editQuery(rl);
        return;
      }

      if (current.view === "transcript") {
        if (name === "escape") {
          cancelTranscriptScroll();
          setModel({ ...current, view: "results", transcript: null });
          return;
        }
        const transcript = current.transcript;
        if (transcript === null) return;
        const measured = dimensions(config.output);
        const width = Math.max(1, measured.columns - 1);
        const capacity = Math.max(1, measured.rows - 2);
        const document = transcriptLayout(transcript, width);
        const maximum = Math.max(0, document.lines.length - capacity);
        const pending = pendingTranscriptScroll.current;
        let scroll = pending?.rawLines === transcript.rawLines
          ? pending.value
          : transcript.scroll === null
          ? Math.max(
              0,
              Math.min(
                maximum,
                document.target - Math.floor(capacity / 2),
              ),
            )
          : transcript.scroll;
        const previousScroll = scroll;
        if (isUpKey(key) || name === "k") scroll -= 1;
        else if (isDownKey(key) || name === "j") scroll += 1;
        else if (name === "pageup") scroll -= capacity;
        else if (name === "pagedown") scroll += capacity;
        else if (name === "home") scroll = 0;
        else if (name === "end") scroll = maximum;
        else return;
        const nextScroll = Math.max(0, Math.min(maximum, scroll));
        if (nextScroll === previousScroll) return;
        scheduleTranscriptScroll(transcript, nextScroll);
        return;
      }

      if (name === "escape") {
        editQuery(rl);
        return;
      }
      if (name === "/" || name === "e") {
        editQuery(rl);
        return;
      }
      if (name === "r") {
        runSearch(current.query, current.page, current.sort);
        return;
      }
      if (name === "s") {
        const index = SORTS.indexOf(current.sort);
        const sort = SORTS[(index + 1) % SORTS.length]!;
        runSearch(current.query, 1, sort);
        return;
      }

      const response = current.response;
      if (response?.kind !== "ok") return;
      if (name === "[" && response.page > 1) {
        runSearch(current.query, response.page - 1, current.sort);
        return;
      }
      if (name === "]" && response.hasMore) {
        runSearch(current.query, response.page + 1, current.sort);
        return;
      }
      if (isEnterKey(key)) {
        openTranscript();
        return;
      }

      const rows = response.rows;
      if (rows.length === 0) return;
      const measured = dimensions(config.output);
      const width = Math.max(1, measured.columns - 1);
      const degradationRows = response.degradation ? 1 : 0;
      const capacity = Math.max(0, measured.rows - 2 - degradationRows);
      const window = resultWindow(
        rows,
        current.listTop,
        current.selected,
        capacity,
        response.anchor,
        width,
        config.ui,
      );
      const pageStep = Math.max(1, window.end - window.top);
      let selected = current.selected;
      if (isUpKey(key) || name === "k") selected -= 1;
      else if (isDownKey(key) || name === "j") selected += 1;
      else if (name === "pageup") selected -= pageStep;
      else if (name === "pagedown") selected += pageStep;
      else if (name === "home") selected = 0;
      else if (name === "end") selected = rows.length - 1;
      else return;
      selected = Math.max(0, Math.min(rows.length - 1, selected));
      const nextWindow = resultWindow(
        rows,
        window.top,
        selected,
        capacity,
        response.anchor,
        width,
        config.ui,
      );
      if (selected === current.selected && nextWindow.top === current.listTop) return;
      setModel({ ...current, selected, listTop: nextWindow.top });
    });

    const ui = config.ui;
    const measured = dimensions(config.output);
    const width = Math.max(1, measured.columns - 1);
    const rows = measured.rows;
    const coverage = coverageLabel(model.coverage);

    if (model.view === "query") {
      const inputLine = ui.line("> ", model.editValue).text;
      if (rows <= 1) return rows === 1 ? inputLine : "";
      if (rows === 2) {
        return [
          ui.color.bold(ui.truncate("Search transcripts", width)).text,
          inputLine,
        ].join("\n");
      }
      const lines: string[] = [];
      lines.push(ui.color.bold(ui.truncate("Search transcripts", width)).text);
      if (coverage && rows >= 4) lines.push(ui.color.dim(ui.truncate(coverage, width)).text);
      if (model.inputError && rows >= 4) {
        lines.push(ui.color.red(ui.truncate(model.inputError, width)).text);
      }
      while (lines.length < Math.max(0, rows - 2)) lines.push("");
      if (rows >= 2) {
        lines.push(ui.color.dim(ui.truncate("Enter - search | Esc - menu |", width)).text);
      }
      lines.push(inputLine);
      return lines.slice(0, rows).join("\n");
    }

    if (model.view === "running") {
      const lines = [
        ui.color.bold(ui.truncate("Search transcripts | loading", width)).text,
      ];
      if (rows >= 3) {
        lines.push(ui.truncate(`Searching for "${model.query}"...`, width));
      }
      if (coverage && rows >= 4) lines.push(ui.color.dim(ui.truncate(coverage, width)).text);
      return padScreen(lines, rows, "Esc - edit query | q - quit |", width, ui);
    }

    if (model.view === "transcript" && model.transcript !== null) {
      const transcript = model.transcript;
      const capacity = Math.max(0, rows - 2);
      const document = transcriptLayout(transcript, width);
      const maximum = Math.max(0, document.lines.length - capacity);
      const scroll = transcript.scroll === null
        ? Math.max(
            0,
            Math.min(
              maximum,
              document.target - Math.floor(capacity / 2),
            ),
          )
        : Math.max(0, Math.min(maximum, transcript.scroll));
      const pattern = literalPattern(queryTerms(model.query));
      const body = document.lines
        .slice(scroll, scroll + capacity)
        .map((line) => highlighted(ui, line, pattern));
      return padScreen(
        [ui.color.bold(ui.truncate(transcript.title, width)).text, ...body],
        rows,
        `${ui.policy.unicode ? "↑/↓" : "Up/Down"} - scroll | PgUp/PgDn - page | Esc - results | q - quit |`,
        width,
        ui,
      );
    }

    const response = model.response;
    let header = "Search transcripts";
    const body: string[] = [];
    let footer = "r - retry | / - edit | Esc - query | q - quit |";
    if (model.failure !== null) {
      header += " | error";
      body.push("Search failed:", model.failure);
    } else if (response === null) {
      header += " | error";
      body.push("Search did not return a result.");
    } else if (response.kind === "no-query" || response.kind === "no-terms") {
      header += " | empty query";
      body.push("Enter at least one word to search.");
    } else if (response.kind === "error") {
      header += " | error";
      body.push("Search failed:", response.message);
    } else {
      const pageCount = Math.max(1, Math.ceil(response.total / response.limit));
      header += ` | ${resultMode(response)} | ${response.sort} | page ${response.page}/${pageCount}`;
      const degradation = degradationMessage(response);
      if (degradation) body.push(ui.color.yellow(ui.truncate(degradation, width)).text);
      if (response.rows.length === 0) {
        body.push(
          response.total === 0
            ? `No transcript matches for "${model.query}".`
            : `No matches on page ${response.page}; ${response.total} matching lines exist.`,
        );
      } else {
        const capacity = Math.max(0, rows - 2 - body.length);
        const window = resultWindow(
          response.rows,
          model.listTop,
          model.selected,
          capacity,
          response.anchor,
          width,
          ui,
        );
        const pattern = literalPattern(queryTerms(model.query));
        for (let index = window.top; index < window.end; index += 1) {
          const available = Math.max(0, rows - 2 - body.length);
          const lines = cardLines(
            response.rows[index]!,
            index === model.selected,
            response.anchor,
            width,
            ui,
          ).slice(0, available);
          body.push(
            ...lines.map((line) =>
              line.highlight ? highlighted(ui, line.text, pattern) : line.text,
            ),
          );
        }
      }
      footer = `${ui.policy.unicode ? "↑/↓" : "Up/Down"} - navigate | Enter - open | s - sort | q - quit |`;
    }
    const safeBody = body.map((line) =>
      line.includes("\x1b[") ? line : ui.truncate(line, width),
    );
    return padScreen(
      [ui.color.bold(ui.truncate(header, width)).text, ...safeBody],
      rows,
      footer,
      width,
      ui,
    );
  },
);

export function searchPrompt(
  config: SearchPromptConfig,
  context: Parameters<typeof searchPromptInternal>[1] = {},
): ReturnType<typeof searchPromptInternal> {
  return searchPromptInternal(config, {
    ...context,
    clearPromptOnDone: true,
  }).catch((error) => {
    if (error instanceof ExitPromptError) return { action: "quit" } as const;
    throw error;
  });
}
