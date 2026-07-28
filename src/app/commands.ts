import { z } from "zod";
import {
  getParticipants,
  getRecordingLink,
  getSummaryView,
  getTranscriptView,
  queryMeetings,
  rowStatus,
} from "../core/meetings.js";
import { requestCode, verifyCode } from "../core/login.js";
import { runSearch, snippetAround } from "../core/search.js";
import { computeStatus } from "../core/status.js";
import {
  argMeetingId,
  ArgumentValidationError,
  parseMeetingListArguments,
  parseReadArguments,
  validateSearchArguments,
} from "../core/args.js";
import {
  AuthenticationOriginMismatchError,
  LegacyPartialSessionError,
  SanaClient,
} from "../sana/client.js";
import {
  MAX_MEETING_LIST_LIMIT,
  SanaStore,
  type CacheOperationGuard,
} from "../store/db.js";
import type { ArtifactProblem } from "../core/meetings.js";

const COMMANDS = [
  "help",
  "login",
  "status",
  "list",
  "read",
  "search",
  "summary",
  "participants",
  "recording",
] as const;

export class UnknownHumanCommandError extends Error {
  readonly code = "UNKNOWN_HUMAN_COMMAND";

  constructor(command: string) {
    super(`Unknown command "${command}".\n\n${help()}`);
    this.name = "UnknownHumanCommandError";
  }
}

function help(command?: string): string {
  if (command) {
    const usage: Record<string, string[]> = {
      login: [
        "sana-mcp login --email <email>",
        "sana-mcp login --email <email> --code <code>",
      ],
      status: ["sana-mcp status"],
      list: [
        "sana-mcp list [--page <n>] [--limit <n>] [--query <title>]",
      ],
      search: [
        "sana-mcp search --query <words> [--page <n>] [--limit <n>]",
      ],
      read: [
        "sana-mcp read --id <meeting-id>",
        "sana-mcp read '{\"id\":\"<meeting-id>\",\"full\":true}'",
        "sana-mcp read '{\"id\":\"<meeting-id>\",\"lines\":[1,20],\"timestamps\":false}'",
      ],
      summary: ["sana-mcp summary --id <meeting-id>"],
      participants: ["sana-mcp participants --id <meeting-id>"],
      recording: ["sana-mcp recording --id <meeting-id>"],
      install: ["sana-mcp install", "sana-mcp config", "sana-mcp configure"],
      uninstall: ["sana-mcp uninstall"],
    };
    const lines = usage[command];
    return lines
      ? [`Usage for ${command}:`, ...lines.map((line) => `  ${line}`)].join(
          "\n",
        )
      : `Unknown command "${command}".\n\n${help()}`;
  }
  return [
    "sana-mcp commands:",
    "  sana-mcp                         open the interactive app",
    "  sana-mcp login --email <email>  request a sign-in code",
    "  sana-mcp login --email <email> --code <code>",
    "  sana-mcp status",
    "  sana-mcp list [--page <n>] [--limit <n>] [--query <title>]",
    "  sana-mcp search --query <words>",
    "  sana-mcp read --id <meeting-id>",
    "  sana-mcp summary --id <meeting-id>",
    "  sana-mcp participants --id <meeting-id>",
    "  sana-mcp recording --id <meeting-id>",
    "  sana-mcp install | config | configure",
    "  sana-mcp uninstall",
    "",
    "Run sana-mcp <command> --help for command-line options.",
  ].join("\n");
}

function requiredString(
  args: Record<string, unknown>,
  names: readonly string[],
  display: string,
): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new Error(`${display} is required.`);
}

function authoritativeString(
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim()
  ) {
    throw new ArgumentValidationError(
      name,
      "must be a non-empty string without surrounding whitespace",
    );
  }
  return value;
}

function allowedArguments(
  tool: string,
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const name of Object.keys(args)) {
    if (!allowedSet.has(name)) {
      throw new ArgumentValidationError(
        name,
        `is not supported by the ${tool} command`,
      );
    }
  }
}

function meetingId(args: Record<string, unknown>): string {
  if (
    Object.hasOwn(args, "meeting_id") &&
    Object.hasOwn(args, "id")
  ) {
    throw new ArgumentValidationError(
      "meeting_id",
      'must not be combined with "id"',
    );
  }
  const id = argMeetingId(args);
  if (!id) throw new Error("--id is required.");
  return id;
}

function confirmationCode(args: Record<string, unknown>): string {
  if (
    Object.hasOwn(args, "confirmation_code") &&
    Object.hasOwn(args, "code")
  ) {
    throw new ArgumentValidationError(
      "confirmation_code",
      'must not be combined with "code"',
    );
  }
  const field = Object.hasOwn(args, "confirmation_code")
    ? "confirmation_code"
    : "code";
  const value = args[field];
  const code =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new ArgumentValidationError(
      field,
      "must be exactly six ASCII digits",
    );
  }
  return code;
}

function validateAllowedArguments(
  tool: string,
  args: Record<string, unknown>,
): void {
  const allowed: Record<string, readonly string[]> = {
    login: ["email", "confirmation_code", "code", "workspace_id"],
    status: [],
    list: ["page", "limit", "query", "sort", "filter"],
    search: ["query", "page", "limit", "sort", "filter"],
    read: ["meeting_id", "id", "full", "lines", "timestamps"],
    summary: ["meeting_id", "id"],
    participants: ["meeting_id", "id"],
    recording: ["meeting_id", "id"],
  };
  allowedArguments(tool, args, allowed[tool] ?? []);

  if (tool === "login") {
    const email = requiredString(args, ["email"], "--email");
    if (!z.string().email().safeParse(email.toLowerCase()).success) {
      throw new ArgumentValidationError(
        "email",
        "must be a valid email address",
      );
    }
    if (Object.hasOwn(args, "workspace_id")) {
      authoritativeString(args, "workspace_id");
    }
    if (
      Object.hasOwn(args, "confirmation_code") ||
      Object.hasOwn(args, "code")
    ) {
      confirmationCode(args);
    }
  } else if (tool === "list") {
    parseMeetingListArguments(args, MAX_MEETING_LIST_LIMIT);
  } else if (tool === "search") {
    validateSearchArguments(args);
    if (
      typeof args.query !== "string" ||
      !/[\p{L}\p{N}]/u.test(args.query)
    ) {
      throw new ArgumentValidationError(
        "query",
        "is required and must contain at least one word",
      );
    }
  } else if (tool === "read") {
    meetingId(args);
    const selection = parseReadArguments(args);
    if (selection.full && selection.lines !== null) {
      throw new ArgumentValidationError(
        "lines",
        'must not be combined with "full": true',
      );
    }
  } else if (
    tool === "summary" ||
    tool === "participants" ||
    tool === "recording"
  ) {
    meetingId(args);
  }
}

function humanClient(tool: string): SanaClient {
  try {
    return SanaClient.load();
  } catch (error) {
    if (
      tool === "login" &&
      (error instanceof AuthenticationOriginMismatchError ||
        error instanceof LegacyPartialSessionError)
    ) {
      return SanaClient.loadForOriginChangeLogin().client;
    }
    throw error;
  }
}

function renderArtifactIssue(problem: ArtifactProblem): string {
  const subject =
    problem.name === undefined
      ? `meeting "${problem.id}"`
      : `${problem.artifact} for "${problem.name}"`;
  const state =
    problem.kind === "corrupt" ? "is corrupt" : "is unavailable";
  const detail = problem.detail ? ` ${problem.detail}` : "";
  return (
    `The cached ${subject} ${state} (${problem.code}).${detail} ` +
    "Re-sync the meeting cache before retrying."
  );
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function renderStatus(client: SanaClient, store: SanaStore): string {
  const status = computeStatus(client, store);
  if (!status.session.loggedIn) {
    return status.session.expired
      ? "Your Sana session has expired. Run: sana-mcp login --email <email>"
      : "You are not signed in. Run: sana-mcp login --email <email>";
  }
  const lines = [`Sync status: ${status.phase.replaceAll("_", " ")}`];
  if (status.authTransition) {
    lines.push(`Authentication: ${status.authTransition.message}`);
  }
  if (status.meetings !== null) lines.push(`Meetings ready: ${status.meetings}`);
  if (status.remaining !== null && status.remaining > 0) {
    lines.push(
      `Pending: ${status.remaining}${status.retrying ? ` (${status.retrying} retrying)` : ""}`,
    );
  }
  if (
    status.transcriptsDone !== null &&
    status.transcriptsTotal !== null
  ) {
    lines.push(
      `Transcripts stored: ${status.transcriptsDone}/${status.transcriptsTotal}`,
    );
  }
  if (status.etaMinutes !== null && status.blocking) {
    lines.push(`Estimated time remaining: ${status.etaMinutes} min`);
  }
  if (status.error) lines.push(`Sync error: ${status.error}`);
  if (status.syncUnavailable) {
    lines.push(
      `Background sync unavailable: ${status.syncUnavailable.message}`,
    );
  }
  if (!status.blocking && status.phase !== "synced") {
    lines.push("Your current meeting cache is available while syncing continues.");
  }
  return lines.join("\n");
}

function captureDataGuard(
  client: SanaClient,
  store: SanaStore,
): CacheOperationGuard {
  const status = computeStatus(client, store);
  if (!status.session.loggedIn) {
    throw new Error(
      status.session.expired
        ? "Your Sana session has expired. Sign in again."
        : "You are not signed in. Run: sana-mcp login --email <email>",
    );
  }
  if (status.authTransition) {
    throw new Error(`Authentication is not ready: ${status.authTransition.message}`);
  }
  if (status.blocking) {
    throw new Error("Your meetings are still syncing. Run: sana-mcp status");
  }
  const version = client.sessionVersion();
  if (
    version.publicationToken === null ||
    version.userId == null ||
    version.workspaceId == null
  ) {
    throw new Error("Authentication identity is incomplete. Sign in again.");
  }
  return store.captureCacheOperation({
    generation: version.generation,
    publicationToken: version.publicationToken,
    userId: version.userId,
    workspaceId: version.workspaceId,
  });
}

function renderList(store: SanaStore, args: Record<string, unknown>): string {
  const result = queryMeetings(store, args);
  if (result.rows.length === 0) {
    if (result.total > 0) {
      return (
        `No meetings on page ${result.page}. ${result.total} match across ` +
        `${Math.ceil(result.total / result.limit)} page(s).`
      );
    }
    const filtered =
      result.filter.query !== undefined ||
      result.filter.status !== undefined ||
      result.filter.dateFrom !== undefined ||
      result.filter.dateTo !== undefined;
    return filtered
      ? "No meetings match those criteria."
      : "No synced meetings found.";
  }
  const lines = result.rows.map(
    (meeting) =>
      `${formatDate(meeting.created_at_ms)}  ${meeting.name}  ` +
      `[${rowStatus(meeting)}]  ${meeting.id}`,
  );
  if (result.hasMore) {
    lines.push(
      `Showing ${result.rows.length} of ${result.total}. ` +
        `Next page: sana-mcp list '{"page":${result.page + 1}}'`,
    );
  }
  return lines.join("\n");
}

function renderTranscript(
  store: SanaStore,
  id: string,
  args: Record<string, unknown>,
): string {
  const result = getTranscriptView(store, id);
  if (result.kind === "no-meeting") return `No meeting found with ID ${id}.`;
  if (result.kind === "still-listing") {
    return "The meeting list is still syncing. Check status and try again.";
  }
  if (result.kind === "not-downloaded") {
    return (
      `The transcript for "${result.name}" is still downloading ` +
      `(${result.done}/${result.total}). Check status for current progress.`
    );
  }
  if (result.kind === "corrupt" || result.kind === "unavailable") {
    return renderArtifactIssue(result);
  }
  const selection = parseReadArguments(args);
  if (selection.full && selection.lines !== null) {
    throw new Error('"full": true cannot be combined with "lines".');
  }
  const header =
    `${result.name} - ${result.lineCount} lines, ${result.wordCount} words`;
  if (!selection.full && selection.lines === null) {
    return [
      header,
      "",
      "Choose what to read:",
      `  all:    sana-mcp read '{"id":${JSON.stringify(id)},"full":true}'`,
      `  range:  sana-mcp read '{"id":${JSON.stringify(id)},"lines":[1,20]}'`,
    ].join("\n");
  }
  let lines = result.lines;
  if (!selection.full && selection.lines !== null) {
    const [start, end] = selection.lines;
    lines = lines.filter((line) => line.n >= start && line.n <= end);
    if (lines.length === 0) {
      return `${header}\n\nNo lines in ${start}-${end}. Valid range is 1-${result.lineCount}.`;
    }
  }
  return [
    header,
    "",
    ...lines.map(
      (line) =>
        `${line.n}  ${selection.timestamps ? `[${line.time}] ` : ""}` +
        `${line.speaker}: ${line.text}`,
    ),
  ].join("\n");
}

function renderSummary(store: SanaStore, id: string): string {
  const result = getSummaryView(store, id);
  if (result.kind === "no-meeting") return `No meeting found with ID ${id}.`;
  if (result.kind === "none") return `No summary is available for ${result.name}.`;
  if (result.kind === "corrupt" || result.kind === "unavailable") {
    return renderArtifactIssue(result);
  }
  const lines = [result.view.name];
  if (result.view.summaryShort) lines.push("", result.view.summaryShort);
  if (result.view.summary) lines.push("", result.view.summary);
  if (result.view.actionItems.length) {
    lines.push(
      "",
      "Action items:",
      ...result.view.actionItems.map(
        (item) =>
          `- ${item.action}${item.assignedTo ? ` - ${item.assignedTo}` : ""}`,
      ),
    );
  }
  for (const topic of result.view.notes) {
    lines.push("", topic.topic, ...topic.notes.map((note) => `- ${note}`));
  }
  return lines.join("\n");
}

function renderParticipants(store: SanaStore, id: string): string {
  const result = getParticipants(store, id);
  if (result.kind === "no-meeting") return `No meeting found with ID ${id}.`;
  if (result.kind === "none") {
    return `No participants are available for ${result.name}.`;
  }
  if (result.kind === "corrupt" || result.kind === "unavailable") {
    return renderArtifactIssue(result);
  }
  return [
    result.name,
    "",
    ...result.participants.map(
      (participant) =>
        `${participant.displayName ?? participant.email ?? "Unnamed participant"}` +
          `${participant.displayName && participant.email ? `  ${participant.email}` : ""}` +
        `${participant.isHost ? "  (host)" : ""}`,
    ),
  ].join("\n");
}

async function renderSearch(
  store: SanaStore,
  args: Record<string, unknown>,
  guard: CacheOperationGuard,
): Promise<string> {
  const result = await runSearch(store, args, { guard });
  store.assertCacheOperation(guard);
  if (result.kind === "no-query" || result.kind === "no-terms") {
    return "A search query is required. Run: sana-mcp search --query <words>";
  }
  if (result.kind === "error") {
    throw new Error(`Search failed: ${result.message}`);
  }
  const lines: string[] = [];
  if (result.rows.length === 0) {
    lines.push(
      result.total === 0
        ? `No transcript matches for "${result.query}".`
        : `No matches on page ${result.page}. ${result.total} matching line(s) exist across ${Math.ceil(result.total / result.limit)} page(s).`,
    );
  }
  for (const match of result.rows) {
    lines.push(
      `${formatDate(match.created_at_ms)}  ${match.name}  line ${match.line_no}`,
      `  ${snippetAround(match.text, result.anchor)}`,
    );
  }
  if (result.degradation) {
    const detail =
      result.degradation.message === undefined
        ? result.degradation.code
        : `${result.degradation.code}: ${result.degradation.message}`;
    lines.push(
      ...(lines.length > 0 ? [""] : []),
      `Semantic search unavailable (${detail}); showing keyword results.`,
    );
  }
  if (result.hasMore) {
    lines.push("", `Next page: sana-mcp search '{"query":${JSON.stringify(
      result.query,
    )},"page":${result.page + 1}}'`);
  }
  return lines.join("\n");
}

export async function runHumanCommand(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool === "help") {
    allowedArguments(tool, args, ["command"]);
    if (
      Object.hasOwn(args, "command") &&
      (typeof args.command !== "string" ||
        args.command.trim() === "")
    ) {
      throw new ArgumentValidationError(
        "command",
        "must be a non-empty string",
      );
    }
    const command =
      typeof args.command === "string" ? args.command.trim() : undefined;
    return help(command || undefined);
  }
  if (!COMMANDS.includes(tool as (typeof COMMANDS)[number])) {
    throw new UnknownHumanCommandError(tool);
  }

  validateAllowedArguments(tool, args);
  const client = humanClient(tool);
  if (
    tool === "login" &&
    !Object.hasOwn(args, "confirmation_code") &&
    !Object.hasOwn(args, "code")
  ) {
    const email = requiredString(args, ["email"], "--email");
    if (Object.hasOwn(args, "workspace_id")) {
      const workspaceId = authoritativeString(args, "workspace_id");
      await requestCode(client, email, workspaceId);
    } else {
      await requestCode(client, email);
    }
    return [
      `We emailed a 6-digit code to ${email}.`,
      `Finish signing in: sana-mcp login --email ${email} --code <code>`,
    ].join("\n");
  }

  const store = new SanaStore();
  try {
    if (tool === "login") {
      const email = requiredString(args, ["email"], "--email");
      const code = confirmationCode(args);
      const result = await verifyCode(client, store, email, code);
      if (result.kind === "sync-unavailable") {
        const persistence =
          result.failure.persistence === undefined
            ? ""
            : `; the sync failure status could not be persisted: ${result.failure.persistence.message}`;
        throw new Error(
          `Signed in as ${result.user.email}, but background sync could not start: ${result.failure.message}${persistence}`,
        );
      }
      return `Signed in as ${result.user.email}. Your meetings are syncing.`;
    }
    if (tool === "status") {
      return renderStatus(client, store);
    }
    const guard = captureDataGuard(client, store);
    if (tool === "list") {
      return store.withCacheOperation(guard, () => renderList(store, args));
    }
    if (tool === "search") {
      return await renderSearch(store, args, guard);
    }
    const id = meetingId(args);
    if (tool === "read") {
      return store.withCacheOperation(
        guard,
        () => renderTranscript(store, id, args),
      );
    }
    if (tool === "summary") {
      return store.withCacheOperation(guard, () => renderSummary(store, id));
    }
    if (tool === "participants") {
      return store.withCacheOperation(
        guard,
        () => renderParticipants(store, id),
      );
    }
    const result = await getRecordingLink(client, store, id, guard);
    if (result.kind === "ok") return `${result.name}\n${result.url}`;
    if (result.kind === "none") {
      return `No recording is available for ${result.name}.`;
    }
    if (result.kind === "no-meeting") {
      return `No meeting found with ID ${id}.`;
    }
    if (result.kind === "expired") {
      throw new Error("Your Sana session has expired. Sign in again.");
    }
    throw new Error(`Could not load the recording link: ${result.message}`);
  } finally {
    store.close();
  }
}
