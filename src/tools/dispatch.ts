// MCP/agent-facing dispatcher. Every handler renders LLM-facing strings from
// the presentation-agnostic core (src/core/*). The wording here is deliberately
// agent-oriented (it coaches an LLM to call meeting_transcripts(...)); the human
// CLI has its own renderers and must never reuse these strings.
import { z } from "zod";
import {
  AuthenticationOriginMismatchError,
  LegacyPartialSessionError,
  SanaClient,
} from "../sana/client.js";
import {
  CacheOperationChangedError,
  inspectPersistedAuthIssue,
  MAX_MEETING_LIST_LIMIT,
  type CacheOperationGuard,
  SanaStore,
  type SyncState,
} from "../store/db.js";
import { ensureDaemonRunning } from "../sync/spawn.js";
import { renderLines } from "../sana/transcript.js";
import { renderHelp, toolListLine } from "./help.js";
import {
  ArgumentValidationError,
  argMeetingId,
  fmtDate,
  fmtDateTime,
  parseMeetingListArguments,
  parseReadArguments,
  validateSearchArguments,
} from "../core/args.js";
import {
  requestCode,
  verifyCode,
  waitForSync,
  COUNT_WAIT_MS,
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  RequestCodeLocalTransitionError,
  RequestCodePreflightError,
  RequestCodeRemoteError,
  StaleSessionWriterError,
  VerifyCodeLocalTransitionError,
  VerifyCodePreflightError,
  VerifyCodeRemoteError,
} from "../core/login.js";
import {
  sessionInfo,
  isBlocking,
  captureStatusSnapshot,
  type BoundSyncUnavailableInfo,
  type StatusInfo,
} from "../core/status.js";
import {
  queryMeetings,
  getTranscriptView,
  getSummaryView,
  getParticipants,
  getRecordingLink,
  rowStatus,
  type ArtifactProblem,
} from "../core/meetings.js";
import { runSearch, snippetAround, type SearchRow, type SearchResult } from "../core/search.js";
import {
  inspectCurrentSession,
  stableSessionSnapshot,
} from "../sana/session-publication.js";

const LOGIN_HINT = 'Run meeting_transcripts("login", {"email":"you@example.com"}) to sign in.';
const EXPIRED_MSG = `Your login has expired. To login again run meeting_transcripts("login", {"email":"you@example.com"}).`;
const MISSING_LOGIN_EMAIL =
  'To sign in, provide the email connected to your Sana.ai subscription: meeting_transcripts("login", {"email":"you@example.com"}). A 6-digit code will be emailed to that address.';
const MISSING_READ_ID =
  'Provide a meeting id: meeting_transcripts("read", {"meeting_id":"..."}). Get ids from meeting_transcripts("list") or "search".';
const MISSING_SEARCH_QUERY =
  'Provide a search query: meeting_transcripts("search", {"query":"..."}). Optional: page, limit, sort, filter.';
const MISSING_SUMMARY_ID =
  'Provide a meeting id: meeting_transcripts("summary", {"meeting_id":"..."}).';
const MISSING_PARTICIPANTS_ID =
  'Provide a meeting id: meeting_transcripts("participants", {"meeting_id":"..."}).';
const MISSING_RECORDING_ID =
  'Provide a meeting id: meeting_transcripts("recording", {"meeting_id":"..."}).';
const LOGIN_EXPLAINER = [
  "You are not logged in.",
  "To sign in, use the email address of your Sana.ai subscription:",
  'call meeting_transcripts("login", {"email":"you@example.com"}) to get a 6-digit code by email,',
  'then call meeting_transcripts("login", {"email":"you@example.com", "confirmation_code": <the 6 digits>}).',
].join("\n");

function asSentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

class LocalStoreCleanupError extends Error {
  readonly code = "LOCAL_STORE_CLEANUP_FAILED";

  constructor(cause: unknown) {
    super("Local authentication storage cleanup failed", { cause });
    this.name = "LocalStoreCleanupError";
  }
}

/** @internal A stale CAS belongs to another session generation, not to status persistence. */
export function ephemeralSyncPersistenceIssue(
  persistenceError: unknown,
  currentCause: string,
  currentMessage: string,
):
  | { code: string; cause: string; message: string }
  | undefined {
  if (persistenceError instanceof CacheOperationChangedError) {
    return undefined;
  }
  const persistenceMessage =
    persistenceError instanceof Error
      ? persistenceError.message
      : String(persistenceError);
  return {
    code: "SYNC_STATUS_PERSISTENCE_FAILED",
    cause:
      persistenceError instanceof Error
        ? persistenceError.name
        : "UNKNOWN_PERSISTENCE_FAILURE",
    message:
      `Current sync failure (${currentCause}): ${asSentence(currentMessage)} ` +
      `Sync status persistence failed: ${asSentence(persistenceMessage)}`,
  };
}

function syncBlockedMessage(
  s: Pick<
    SyncState,
    | "transcripts_total"
    | "transcripts_done"
    | "auth_issue_code"
    | "auth_issue_message"
  >,
): string {
  const persistedAuthIssue = inspectPersistedAuthIssue(s);
  if (persistedAuthIssue.kind !== "none") {
    return (
      `Authentication is incomplete (${persistedAuthIssue.code}): ` +
      `${asSentence(persistedAuthIssue.message)} ` +
      `Meeting tools remain blocked; sign in again after resolving the local storage error.`
    );
  }
  const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
  const detail =
    s.transcripts_total > 0
      ? `${remaining} item(s) left`
      : "building the meeting list";
  return (
    `Sync in progress (${detail}). ` +
    `Meeting tools are unavailable until it completes. ` +
    `Check progress with meeting_transcripts("status").`
  );
}

/** @internal Re-read persisted authorization after an awaited daemon startup. */
export function refreshedAuthorization(
  store: Pick<SanaStore, "getSyncState" | "reconcileAuthState">,
  loadClient: () => SanaClient = SanaClient.load,
):
  | Readonly<{ kind: "authorized"; client: SanaClient; state: ReturnType<SanaStore["getSyncState"]> }>
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "blocked"; code: string; message: string }> {
  const snapshot = stableSessionSnapshot(store, loadClient);
  if (snapshot.kind !== "stable") {
    return {
      kind: "blocked",
      code: snapshot.code,
      message: snapshot.message,
    };
  }
  const { client, state } = snapshot;
  if (client.pendingSignInChallenge() !== null) {
    return { kind: "signed-out" };
  }
  const session = sessionInfo(client, state);
  if (!session.hasCookie) return { kind: "signed-out" };
  if (!session.loggedIn) return { kind: "expired" };
  if (
    state.auth_user_id === null ||
    state.auth_workspace_id === null ||
    state.cache_user_id !== state.auth_user_id ||
    state.cache_workspace_id !== state.auth_workspace_id
  ) {
    return {
      kind: "blocked",
      code: "CACHE_IDENTITY_PENDING",
      message:
        "The local meeting cache has not been rebuilt for the confirmed Sana identity",
    };
  }
  return { kind: "authorized", client, state };
}

async function handleLogin(args: Record<string, unknown>): Promise<string> {
  const email = (args.email as string).trim();
  const hasConfirmationCode = Object.prototype.hasOwnProperty.call(
    args,
    "confirmation_code",
  );
  const hasCode = Object.prototype.hasOwnProperty.call(args, "code");
  const codeRaw = hasConfirmationCode
    ? args.confirmation_code
    : hasCode
      ? args.code
      : undefined;
  const workspaceId = Object.prototype.hasOwnProperty.call(
    args,
    "workspace_id",
  )
    ? (args.workspace_id as string)
    : undefined;
  let client: SanaClient;
  let originReset = false;
  let originResetReason: string | undefined;
  try {
    client = SanaClient.load();
  } catch (error) {
    if (
      error instanceof AuthenticationOriginMismatchError ||
      error instanceof LegacyPartialSessionError
    ) {
      // A fresh login is the only valid migration across Sana origins. The
      // replacement is persisted only after Sana accepts the new challenge.
      try {
        const recovery = SanaClient.loadForOriginChangeLogin();
        client = recovery.client;
        if (recovery.baseline === "reset-partial-legacy") {
          originResetReason =
            "The saved legacy session had only a partial identity, so it was reset before this fresh sign-in.";
        }
      } catch (recoveryError) {
        return `Fresh sign-in could not preserve the confirmed authentication baseline. ${asSentence(
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError),
        )}`;
      }
      originReset = true;
    } else {
      return `Local authentication state is unavailable. ${asSentence(
        error instanceof Error ? error.message : String(error),
      )}`;
    }
  }

  if (codeRaw === undefined || codeRaw === null || `${codeRaw}` === "") {
    try {
      if (workspaceId === undefined) {
        await requestCode(client, email);
      } else {
        await requestCode(client, email, workspaceId);
      }
    } catch (e) {
      if (e instanceof RequestCodePreflightError) {
        return `No sign-in request was sent for ${email}. ${asSentence(e.message)}`;
      }
      if (e instanceof RequestCodeLocalTransitionError) {
        return (
          `A sign-in code was emailed to ${email}, but the local sign-in ` +
          `transition did not complete. ${asSentence(e.message)} Resolve the local storage error before requesting another code.`
        );
      }
      if (e instanceof RequestCodeRemoteError) {
        return e.remoteAccepted === false
          ? `${asSentence(e.message)} Request a new code for ${email} before retrying.`
          : `The sign-in request for ${email} did not complete, and it is unknown whether Sana accepted it. Request a new code before submitting a confirmation code.`;
      }
      return `Could not start sign-in for ${email}. ${asSentence(
        e instanceof Error ? e.message : String(e),
      )}`;
    }
    return [
      ...(originReset
        ? [
            originResetReason ??
              "The saved session belonged to a different Sana origin, so this sign-in starts a fresh session.",
            "",
          ]
        : []),
      `A 6-digit sign-in code was just emailed to ${email}.`,
      ``,
      `Next: get that code, then call`,
      `  meeting_transcripts("login", {"email":"${email}", "confirmation_code": <the 6 digits>})`,
      ``,
      `If you have an email-reading tool, read the most recent email from noreply@example.com titled "Sign in to Sana" to find the code. Otherwise, ask the user to read it to you.`,
    ].join("\n");
  }

  let store: SanaStore;
  try {
    store = new SanaStore();
  } catch (error) {
    const preflight = new VerifyCodePreflightError(
      "The sign-in code was not submitted because local authentication storage could not be opened",
      { cause: error },
    );
    return `No sign-in code was submitted to Sana. ${asSentence(preflight.message)} Resolve the local storage error, then retry.`;
  }
  const primary = await (async (): Promise<string> => {
    try {
    const result = await verifyCode(client, store, email, `${codeRaw}`);
    const { user } = result;

    const head = `Logged in as ${user.email}${client.workspaceId ? ` (workspace ${client.workspaceId})` : ""}.`;
    const tail = [
      ``,
      `Available tools: ${toolListLine()}.`,
      `Use meeting_transcripts("help", {"tool":"<name>"}) for details.`,
    ];
    const blockedLine = `Meeting tools are unavailable until it completes. Check progress with meeting_transcripts("status").`;

    if (result.kind === "sync-unavailable") {
      return [
        head,
        `Sign-in succeeded, but transcript sync is unavailable. ${asSentence(result.failure.message)}`,
        ...(result.failure.persistence
          ? [
              `The sync failure status could not be persisted. ${asSentence(
                result.failure.persistence.message,
              )}`,
            ]
          : []),
        `Meeting tools remain blocked to protect the existing local cache. Retry with meeting_transcripts("status") after resolving the sync error.`,
        ...tail,
      ].join("\n");
    }

    const res = await waitForSync(store, COUNT_WAIT_MS);
    if (res.done) {
      return [head, `Sync complete. Your transcripts are up to date and all tools are available.`, ...tail].join("\n");
    }
    if (res.count != null) {
      return [
        head,
        `Sync in progress: ${res.count} item(s) to download.`,
        blockedLine,
        ...tail,
      ].join("\n");
    }
    return [head, `Sync in progress.`, blockedLine, ...tail].join("\n");
    } catch (e) {
    if (e instanceof VerifyCodePreflightError) {
      return `No sign-in code was submitted to Sana. ${asSentence(e.message)} Request a new challenge with meeting_transcripts("login", {"email":"${email}"}).`;
    }
    if (e instanceof VerifyCodeLocalTransitionError) {
      return `${asSentence(e.message)} Meeting tools remain blocked because authentication is incomplete; sign in again after resolving the local storage error.`;
    }
    if (e instanceof VerifyCodeRemoteError) {
      return e.remoteAccepted === false
        ? `${asSentence(e.message)} Double-check the code, or request a new one with meeting_transcripts("login", {"email":"${email}"}).`
        : `The sign-in attempt did not complete, and it is unknown whether Sana accepted the code. Request a new code with meeting_transcripts("login", {"email":"${email}"}) before retrying.`;
    }
    if (e instanceof AuthTransitionIncompleteError) {
      return `${asSentence(e.message)} Meeting tools remain blocked because authentication is incomplete; sign in again after resolving the local storage error.`;
    }
    if (e instanceof AuthPublicationBusyError) {
      return `${asSentence(e.message)} Wait for that local sign-in operation to finish, then retry.`;
    }
    if (e instanceof StaleSessionWriterError) {
      return `Sana accepted the sign-in code, but a newer local authentication state superseded this operation. Retry sign-in.`;
    }
    return `Sign-in failed. ${asSentence(
      e instanceof Error ? e.message : String(e),
    )} Double-check the code, or request a new one with meeting_transcripts("login", {"email":"${email}"}).`;
    }
  })();
  let cleanupError: LocalStoreCleanupError | undefined;
  try {
    store.close();
  } catch (error) {
    cleanupError = new LocalStoreCleanupError(error);
  }
  return cleanupError
    ? `${primary}\n${asSentence(cleanupError.message)}`
    : primary;
}

function handleStatus(
  store: SanaStore,
  ephemeralSyncIssue?: BoundSyncUnavailableInfo,
): string {
  const snapshot = captureStatusSnapshot(store, ephemeralSyncIssue);
  if (snapshot.kind === "retry") {
    return [
      `Status snapshot changed (${snapshot.code}): ${asSentence(snapshot.message)}`,
      'Retry meeting_transcripts("status").',
    ].join("\n");
  }
  return renderStatusInfo(snapshot.status);
}

/** @internal Deterministic LLM-facing renderer for structured status. */
export function renderStatusInfo(
  st: StatusInfo,
): string {
  const lines: string[] = [];
  if (st.authTransition) {
    lines.push(
      `Authentication is incomplete (${st.authTransition.code}): ${asSentence(st.authTransition.message)}`,
    );
    lines.push(
      "Meeting tools remain blocked. Sign in again after resolving the local storage error.",
    );
  } else if (st.syncUnavailable) {
    const issue = st.syncUnavailable;
    lines.push(
      `Transcript sync is unavailable (${issue.code}/${issue.cause}): ${issue.message}`,
    );
    if (st.previousSyncUnavailable) {
      lines.push(
        `Previous persisted sync issue (${st.previousSyncUnavailable.code}/${st.previousSyncUnavailable.cause}): ${asSentence(st.previousSyncUnavailable.message)}`,
      );
    }
    lines.push(
      "The confirmed local cache remains available when it is current; retry status after resolving the daemon error.",
    );
  } else if (st.blocking) {
    lines.push(
      st.transcriptsTotal !== null && st.transcriptsDone !== null &&
      st.transcriptsTotal > 0
        ? `Sync in progress: ${st.transcriptsDone}/${st.transcriptsTotal} transcripts.`
        : `Sync in progress: building the meeting list.`
    );
    lines.push("Meeting tools are unavailable until it completes.");
  } else {
    lines.push(
      st.meetings !== null && st.transcripts !== null
        ? `Up to date. ${st.meetings} meetings, ${st.transcripts} transcripts stored.`
        : "Up to date.",
    );
    lines.push("New meetings sync automatically shortly after they end.");
  }
  if (st.lastFullSyncMs) lines.push(`Last sync: ${new Date(st.lastFullSyncMs).toISOString()}.`);
  if (
    st.semantic.enabled &&
    st.semantic.embedded !== null &&
    st.semantic.total !== null
  )
    lines.push(`Semantic search: on (${st.semantic.embedded}/${st.semantic.total} transcripts embedded).`);
  else if (st.semantic.enabled)
    lines.push("Semantic search: on; cache metrics are hidden while authentication is blocked.");
  else if (st.semantic.degradation)
    lines.push(
      `Semantic search: unavailable (${st.semantic.degradation.message}) Keyword search remains available.`,
    );
  return lines.join("\n");
}

function escCell(s: string): string {
  // Markdown table cell: only the pipe needs escaping; newlines flattened.
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function renderArtifactProblem(problem: ArtifactProblem): string {
  const subject =
    problem.name === undefined
      ? `meeting "${problem.id}"`
      : `${problem.artifact} for "${problem.name}"`;
  const state =
    problem.kind === "corrupt" ? "is corrupt" : "is unavailable";
  const detail = problem.detail ? ` ${asSentence(problem.detail)}` : "";
  return (
    `The cached ${subject} ${state} (${problem.code}).${detail} ` +
    `Re-sync the meeting cache before retrying.`
  );
}

function renderArgumentValidation(error: ArgumentValidationError): string {
  return `Invalid argument "${error.field}": ${asSentence(error.message)}`;
}

type CanonicalTool =
  | "help"
  | "login"
  | "status"
  | "list"
  | "read"
  | "search"
  | "summary"
  | "participants"
  | "recording";

const TOOL_ALIASES: Readonly<Record<string, CanonicalTool>> = Object.freeze({
  help: "help",
  login: "login",
  status: "status",
  list: "list",
  list_meetings: "list",
  read: "read",
  read_transcript: "read",
  search: "search",
  summary: "summary",
  participants: "participants",
  recording: "recording",
});

const HELP_TOOL_VALUES = new Set<CanonicalTool>(
  Object.values(TOOL_ALIASES),
);

type ToolPreflight =
  | {
      kind: "continue";
      name: CanonicalTool;
      args: Record<string, unknown>;
    }
  | { kind: "respond"; text: string };

function owns(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function requireAllowedArguments(
  tool: CanonicalTool,
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(args)) {
    if (!allowedSet.has(field)) {
      throw new ArgumentValidationError(
        field,
        `is not supported by "${tool}"`,
      );
    }
  }
}

function requireUnambiguousMeetingId(
  args: Record<string, unknown>,
): string {
  if (owns(args, "meeting_id") && owns(args, "id")) {
    throw new ArgumentValidationError(
      "meeting_id",
      'must not be combined with "id"',
    );
  }
  return argMeetingId(args);
}

/**
 * Pure public-tool boundary. It returns every unknown, missing, or malformed
 * request before session files, stores, migrations, daemons, or network paths
 * can be observed.
 */
export function preflightToolRequest(
  tool: string,
  args: Record<string, unknown>,
): ToolPreflight {
  const normalized = (tool || "help").trim().toLowerCase();
  const name = Object.prototype.hasOwnProperty.call(
    TOOL_ALIASES,
    normalized,
  )
    ? TOOL_ALIASES[normalized]
    : undefined;
  if (name === undefined) {
    return {
      kind: "respond",
      text: `Unknown tool "${tool}". ${renderHelp()}`,
    };
  }

  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return {
      kind: "respond",
      text: 'Invalid argument "args": must be an object.',
    };
  }
  let requestArgs: Record<string, unknown>;
  try {
    requestArgs = structuredClone(args);
  } catch {
    return {
      kind: "respond",
      text: 'Invalid argument "args": must contain cloneable values.',
    };
  }
  args = requestArgs;

  try {
    switch (name) {
      case "help": {
        requireAllowedArguments(name, args, ["tool"]);
        if (owns(args, "tool")) {
          if (
            typeof args.tool !== "string" ||
            args.tool.trim() === ""
          ) {
            throw new ArgumentValidationError(
              "tool",
              "must be a non-empty documented tool name",
            );
          }
          if (!HELP_TOOL_VALUES.has(args.tool as CanonicalTool)) {
            return {
              kind: "respond",
              text: renderHelp(args.tool),
            };
          }
        }
        break;
      }
      case "login": {
        requireAllowedArguments(name, args, [
          "email",
          "confirmation_code",
          "code",
          "workspace_id",
        ]);
        if (!owns(args, "email")) {
          return { kind: "respond", text: MISSING_LOGIN_EMAIL };
        }
        if (typeof args.email !== "string") {
          throw new ArgumentValidationError("email", "must be a string");
        }
        const email = args.email.trim();
        if (email === "") {
          return { kind: "respond", text: MISSING_LOGIN_EMAIL };
        }
        if (!z.string().email().safeParse(email.toLowerCase()).success) {
          return {
            kind: "respond",
            text:
              `No sign-in request was sent for ${email}. ` +
              `The sign-in code request was invalid before contacting Sana.`,
          };
        }
        if (owns(args, "confirmation_code") && owns(args, "code")) {
          throw new ArgumentValidationError(
            "confirmation_code",
            'must not be combined with "code"',
          );
        }
        const codeField = owns(args, "confirmation_code")
          ? "confirmation_code"
          : owns(args, "code")
            ? "code"
            : null;
        if (codeField !== null) {
          const code = args[codeField];
          const validCode =
            typeof code === "string"
              ? /^\d{6}$/.test(code)
              : typeof code === "number" &&
                Number.isSafeInteger(code) &&
                code >= 100000 &&
                code <= 999999;
          if (!validCode) {
            throw new ArgumentValidationError(
              codeField,
              "must be exactly six ASCII digits",
            );
          }
        }
        if (owns(args, "workspace_id")) {
          if (
            typeof args.workspace_id !== "string" ||
            args.workspace_id.trim() === "" ||
            args.workspace_id !== args.workspace_id.trim()
          ) {
            throw new ArgumentValidationError(
              "workspace_id",
              "must be a non-empty string without surrounding whitespace",
            );
          }
        }
        break;
      }
      case "status":
        requireAllowedArguments(name, args, []);
        break;
      case "list":
        requireAllowedArguments(name, args, [
          "page",
          "limit",
          "query",
          "sort",
          "filter",
        ]);
        parseMeetingListArguments(args, MAX_MEETING_LIST_LIMIT);
        break;
      case "read": {
        requireAllowedArguments(name, args, [
          "meeting_id",
          "id",
          "full",
          "lines",
          "timestamps",
        ]);
        const id = requireUnambiguousMeetingId(args);
        if (id === "") {
          return { kind: "respond", text: MISSING_READ_ID };
        }
        parseReadArguments(args);
        if (args.full === true && owns(args, "lines")) {
          throw new ArgumentValidationError(
            "lines",
            'must not be combined with "full": true',
          );
        }
        break;
      }
      case "search":
        requireAllowedArguments(name, args, [
          "query",
          "page",
          "limit",
          "sort",
          "filter",
        ]);
        validateSearchArguments(args);
        if (
          !owns(args, "query") ||
          (args.query as string).trim() === ""
        ) {
          return { kind: "respond", text: MISSING_SEARCH_QUERY };
        }
        break;
      case "summary":
      case "participants":
      case "recording": {
        requireAllowedArguments(name, args, ["meeting_id", "id"]);
        const id = requireUnambiguousMeetingId(args);
        if (id === "") {
          return {
            kind: "respond",
            text:
              name === "summary"
                ? MISSING_SUMMARY_ID
                : name === "participants"
                  ? MISSING_PARTICIPANTS_ID
                  : MISSING_RECORDING_ID,
          };
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof ArgumentValidationError) {
      return {
        kind: "respond",
        text: renderArgumentValidation(error),
      };
    }
    throw error;
  }

  return { kind: "continue", name, args };
}

function handleListMeetings(store: SanaStore, args: Record<string, unknown>): string {
  const p = queryMeetings(store, args);
  if (p.rows.length === 0) {
    if (p.total === 0) return "No meetings match those criteria.";
    return `No meetings on page ${p.page} (${p.total} match; ${Math.ceil(p.total / p.limit)} page(s)).`;
  }

  const n = p.rows.length;
  const before =
    n === p.total
      ? `Showing ${n} meeting transcripts.`
      : `Showing ${n} out of ${p.total} meeting transcripts.`;

  const table = [
    `| started_at (UTC, YYYY-MM-DD HH:MM) | id (string) | status (ready/downloading/processing/failed) | title (string) |`,
    `|---|---|---|---|`,
    ...p.rows.map(
      (r) => `| ${fmtDateTime(r.created_at_ms)} | ${r.id} | ${rowStatus(r)} | ${escCell(r.name)} |`
    ),
  ];

  const out = [before, "", ...table];
  if (p.hasMore) {
    out.push("", `Use meeting_transcripts("list", {"page":${p.page + 1}}) to see the next page.`);
  }
  out.push("", `Per meeting (by id): read (transcript), summary, participants, recording.`);
  return out.join("\n");
}

function handleReadTranscript(store: SanaStore, args: Record<string, unknown>): string {
  const id = argMeetingId(args);
  if (!id) return MISSING_READ_ID;
  const selection = parseReadArguments(args);
  const v = getTranscriptView(store, id);
  if (v.kind === "still-listing")
    return 'Still syncing the meeting list. Check meeting_transcripts("status") for current progress.';
  if (v.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (v.kind === "not-downloaded")
    return `The transcript for "${v.name}" hasn't been downloaded yet (${v.done}/${v.total} done). Check status for current progress.`;
  if (v.kind === "corrupt" || v.kind === "unavailable") {
    return renderArtifactProblem(v);
  }

  const withTs = selection.timestamps;
  const dateStr = v.dateMs != null ? fmtDate(v.dateMs) : "";
  const header = `# ${v.name}\n${dateStr} | ${v.lineCount} lines | ${v.wordCount} words`;

  const full = selection.full;
  const range = selection.lines;

  // No selection -> don't dump; report size and offer options.
  if (!full && range === null) {
    return [
      header,
      "",
      `This transcript has ${v.lineCount} lines. Choose how to read it:`,
      `- Whole thing:  meeting_transcripts("read", {"meeting_id":"${id}", "full":true})`,
      `- A range:      meeting_transcripts("read", {"meeting_id":"${id}", "lines":[start, end]})`,
      `  (one line = one thing said by a person; line numbers come from "search" or a prior read)`,
    ].join("\n");
  }

  let selected = v.lines;
  let rangeNote = "all lines";
  if (!full && range && range.length > 0) {
    const [start, end] = range;
    selected = v.lines.filter((l) => l.n >= start && l.n <= end);
    rangeNote = `lines ${start}-${end}`;
    if (selected.length === 0)
      return `${header}\n\nNo lines in ${rangeNote}. Valid range is 1-${v.lineCount}.`;
  }

  return `${header} | showing ${rangeNote}\n\n${renderLines(selected, {
    timestamps: withTs,
    numbers: true,
  })}`;
}

function handleSummary(store: SanaStore, args: Record<string, unknown>): string {
  const id = argMeetingId(args);
  if (!id) return MISSING_SUMMARY_ID;
  const r = getSummaryView(store, id);
  if (r.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (r.kind === "none") return `No summary available yet for "${r.name}".`;
  if (r.kind === "corrupt" || r.kind === "unavailable") {
    return renderArtifactProblem(r);
  }
  const v = r.view;

  const out: string[] = [`# ${v.name}`, v.dateMs != null ? fmtDate(v.dateMs) : ""];
  if (v.summaryShort) out.push("", `Short summary: ${v.summaryShort}`);
  if (v.summary) out.push("", "Summary:", v.summary);
  if (v.actionItems.length) {
    out.push("", "Action items:");
    for (const a of v.actionItems) {
      const tags = [a.assignedTo ? `assignee: ${a.assignedTo}` : "", a.dueDate ? `due: ${a.dueDate}` : ""]
        .filter(Boolean)
        .join("; ");
      out.push(`- ${a.action ?? ""}${tags ? ` (${tags})` : ""}`);
    }
  }
  if (v.notes.length) {
    out.push("", "Notes:");
    for (const nt of v.notes) out.push(`- ${nt.topic}: ${nt.notes.join(" ")}`);
  }
  return out.join("\n");
}

function handleParticipants(store: SanaStore, args: Record<string, unknown>): string {
  const id = argMeetingId(args);
  if (!id) return MISSING_PARTICIPANTS_ID;
  const r = getParticipants(store, id);
  if (r.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (r.kind === "none") return `No participant information for "${r.name}".`;
  if (r.kind === "corrupt" || r.kind === "unavailable") {
    return renderArtifactProblem(r);
  }
  const table = [
    `Participants for "${r.name}" (${r.participants.length}):`,
    "",
    `| name (string) | email (string) | host (yes/no) |`,
    `|---|---|---|`,
    ...r.participants.map(
      (p) => `| ${escCell(p.displayName)} | ${escCell(p.email ?? "")} | ${p.isHost ? "yes" : "no"} |`
    ),
  ];
  return table.join("\n");
}

function renderSearchResults(res: Extract<SearchResult, { kind: "ok" }>): string {
  const label =
    res.mode === "keyword"
      ? res.sort === "best"
        ? "keyword, ranked by relevance"
        : `keyword, ${res.sort}`
      : res.sort === "best"
        ? "hybrid: keyword + semantic"
        : `hybrid, ${res.sort}`;
  const { query, anchor, rows, total, page, offset } = res;
  const before =
    rows.length === total
      ? `Showing ${total} matching lines for "${query}" (${label}).`
      : `Showing ${rows.length} out of ${total} matching lines for "${query}" (${label}).`;
  const table = [
    `| started_at (UTC, YYYY-MM-DD HH:MM) | id (string) | line (int) | title (string) | snippet (string) |`,
    `|---|---|---|---|---|`,
    ...rows.map(
      (r: SearchRow) =>
        `| ${fmtDateTime(r.created_at_ms)} | ${r.meeting_id} | ${r.line_no} | ${escCell(r.name)} | ${escCell(
          snippetAround(r.text, anchor)
        )} |`
    ),
  ];
  const out = [
    before,
    ...(res.degradation
      ? [renderSemanticDegradation(res.degradation)]
      : []),
    ``,
    ...table,
  ];
  if (offset + rows.length < total) {
    out.push(
      ``,
      `Use meeting_transcripts("search", {"query":"${query.replace(/"/g, '\\"')}", "page":${page + 1}}) to see the next page.`
    );
  }
  out.push(``, `Read around a hit with meeting_transcripts("read", {"meeting_id":"<id>", "lines":[<line>-2, <line>+2]}).`);
  return out.join("\n");
}

function renderSemanticDegradation(
  degradation: NonNullable<Extract<SearchResult, { kind: "ok" }>["degradation"]>,
): string {
  return `Semantic search degraded (${degradation.code}): ${
    degradation.message ??
    ("cause" in degradation ? degradation.cause.kind : degradation.code)
  } Showing keyword results.`;
}

async function handleSearch(
  store: SanaStore,
  args: Record<string, unknown>,
  guard: CacheOperationGuard,
): Promise<string> {
  validateSearchArguments(args);
  const res = await runSearch(store, args, { guard });
  switch (res.kind) {
    case "no-query":
      return MISSING_SEARCH_QUERY;
    case "no-terms":
      return `No searchable words in "${res.query}".`;
    case "error":
      return `Could not run search for "${res.query}": ${res.message}`;
    case "ok": {
      if (res.rows.length === 0) {
        const empty =
          res.total === 0
            ? `No transcript lines match "${res.query}".`
            : `No results on page ${res.page} (${res.total} match${
          res.mode === "keyword" ? `; ${Math.ceil(res.total / res.limit)} page(s)` : ""
        }).`;
        return res.degradation
          ? `${empty}\n${renderSemanticDegradation(res.degradation)}`
          : empty;
      }
      return renderSearchResults(res);
    }
  }
}

async function handleRecording(
  client: SanaClient,
  store: SanaStore,
  args: Record<string, unknown>,
  guard: CacheOperationGuard,
): Promise<string> {
  const id = argMeetingId(args);
  if (!id) return MISSING_RECORDING_ID;
  const r = await getRecordingLink(client, store, id, guard);
  switch (r.kind) {
    case "ok":
      return `Recording for "${r.name}" (temporary signed URL, expires in a few hours):\n${r.url}`;
    case "none":
      return `No recording available for "${r.name}".`;
    case "no-meeting":
      return `No meeting with id "${r.id}". Use meeting_transcripts("list") to find valid ids.`;
    case "expired":
      return EXPIRED_MSG;
    case "error":
      return `Could not fetch the recording link: ${r.message}`;
  }
}

/**
 * Single entry point: sana(tool, args). Reads are served from the local store;
 * only login and the recording tool touch the network. Kicks the daemon awake.
 */
export async function sana(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const preflight = preflightToolRequest(tool, args);
  if (preflight.kind === "respond") return preflight.text;
  const name = preflight.name;
  args = preflight.args;

  if (name === "help") {
    let client: SanaClient;
    try {
      client = SanaClient.load();
    } catch (error) {
      if (
        error instanceof AuthenticationOriginMismatchError ||
        error instanceof LegacyPartialSessionError
      ) {
        return renderHelp(
          args.tool as string | undefined,
          `${asSentence(error.message)}\n${LOGIN_EXPLAINER}`,
        );
      }
      return `Local authentication state is unavailable. ${asSentence(
        error instanceof Error ? error.message : String(error),
      )}`;
    }
    let store: SanaStore;
    try {
      store = new SanaStore();
    } catch (error) {
      return `Local meeting storage is unavailable. ${asSentence(
        error instanceof Error ? error.message : String(error),
      )}`;
    }
    let notice: string | undefined;
    try {
      const reconciliation = inspectCurrentSession(store, client);
      const s = store.getSyncState();
      const sess = sessionInfo(client, s);
      if (reconciliation.kind === "incomplete")
        notice =
          `Authentication is incomplete (${reconciliation.code}): ` +
          `${asSentence(reconciliation.message)} ` +
          "Meeting tools remain blocked; sign in again after resolving the local storage error.";
      else if (!sess.loggedIn) notice = LOGIN_EXPLAINER;
      else if (isBlocking(s)) notice = syncBlockedMessage(s);
    } finally {
      store.close();
    }
    return renderHelp(args.tool as string | undefined, notice);
  }
  if (name === "login") return handleLogin(args);

  // Everything else requires a session and reads the local store.
  let client: SanaClient;
  try {
    client = SanaClient.load();
  } catch (error) {
    if (
      error instanceof AuthenticationOriginMismatchError ||
      error instanceof LegacyPartialSessionError
    ) {
      return `${asSentence(error.message)} ${LOGIN_HINT}`;
    }
    return `Local authentication state is unavailable. ${asSentence(
      error instanceof Error ? error.message : String(error),
    )}`;
  }
  let store: SanaStore;
  try {
    store = new SanaStore();
  } catch (error) {
    return `Local meeting storage is unavailable. ${asSentence(
      error instanceof Error ? error.message : String(error),
    )}`;
  }
  let ephemeralSyncIssue:
    | BoundSyncUnavailableInfo
    | undefined;
  try {
    let s = store.getSyncState();
    let sess = sessionInfo(client, s);
    if (client.pendingSignInChallenge() !== null) {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    if (!sess.hasCookie) {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    if (!sess.loggedIn) {
      return EXPIRED_MSG;
    }
    // Make sure the background syncer is alive (non-blocking).
    const beforeStart = stableSessionSnapshot(store);
    if (beforeStart.kind !== "stable") {
        return `Authentication is incomplete (${beforeStart.code}): ${asSentence(beforeStart.message)} Meeting tools remain blocked.`;
    }
    client = beforeStart.client;
    if (client.pendingSignInChallenge() !== null) {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    const beforeVersion = beforeStart.client.sessionVersion();
    if (
      beforeVersion.publicationToken === null ||
      beforeVersion.userId == null ||
      beforeVersion.workspaceId == null
    ) {
      return `Authentication is incomplete (AUTH_IDENTITY_UNAVAILABLE): The confirmed session has no authoritative identity. Meeting tools remain blocked.`;
    }
    const beforeTuple = {
      generation: beforeVersion.generation,
      publicationToken: beforeVersion.publicationToken,
      userId: beforeVersion.userId,
      workspaceId: beforeVersion.workspaceId,
    };
    try {
      await ensureDaemonRunning();
      store.clearSyncUnavailableIfCurrent(beforeTuple);
    } catch (error) {
      const cause =
        error instanceof Error &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : error instanceof Error
            ? error.name
            : "UNKNOWN_SYNC_FAILURE";
      const message =
        error instanceof Error ? error.message : String(error);
      try {
        const recorded = store.recordSyncUnavailableIfCurrent(
          beforeTuple,
          "SYNC_DAEMON_UNAVAILABLE",
          cause,
          message,
        );
        if (recorded !== "recorded") {
          throw new CacheOperationChangedError();
        }
      } catch (persistenceError) {
        const issue = ephemeralSyncPersistenceIssue(
          persistenceError,
          cause,
          message,
        );
        ephemeralSyncIssue =
          issue === undefined
            ? undefined
            : {
                issue,
                binding: {
                  authGeneration: beforeStart.state.auth_generation,
                  authPublicationToken:
                    beforeStart.state.auth_publication_token,
                  authUserId: beforeStart.state.auth_user_id,
                  authWorkspaceId:
                    beforeStart.state.auth_workspace_id,
                  cacheUserId: beforeStart.state.cache_user_id,
                  cacheWorkspaceId:
                    beforeStart.state.cache_workspace_id,
                },
              };
      }
    }

    if (name === "status") {
      return handleStatus(store, ephemeralSyncIssue);
    }

    // Startup can overlap logout, expiry, or a new catch-up request. Re-read
    // both persisted session and sync state before authorizing cache access.
    const refreshed = refreshedAuthorization(store);
    if (refreshed.kind === "signed-out") {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    if (refreshed.kind === "expired") {
      return EXPIRED_MSG;
    }
    if (refreshed.kind === "blocked") {
      return (
        `Authentication is incomplete (${refreshed.code}): ` +
        `${asSentence(refreshed.message)} Meeting tools remain blocked; sign in again if this does not resolve.`
      );
    }
    client = refreshed.client;
    s = refreshed.state;

    // status stays available during a catch-up sync; data tools do not.
    const blocked = isBlocking(s) ? syncBlockedMessage(s) : null;
    if (blocked !== null) return blocked;
    const version = client.sessionVersion();
    if (
      version.publicationToken === null ||
      version.userId == null ||
      version.workspaceId == null
    ) {
      return "Authentication is incomplete (AUTH_IDENTITY_UNAVAILABLE). Meeting tools remain blocked.";
    }
    let guard;
    try {
      guard = store.captureCacheOperation({
        generation: version.generation,
        publicationToken: version.publicationToken,
        userId: version.userId,
        workspaceId: version.workspaceId,
      });
    } catch (error) {
      if (error instanceof CacheOperationChangedError) {
        return "Authentication or the active meeting cache changed. Retry the operation.";
      }
      throw error;
    }
    const execute = () => {
    switch (name) {
      case "list":
        return handleListMeetings(store, args);
      case "read":
        return handleReadTranscript(store, args);
      case "search":
        return handleSearch(store, args, guard);
      case "summary":
        return handleSummary(store, args);
      case "participants":
        return handleParticipants(store, args);
      case "recording":
        return handleRecording(client, store, args, guard);
      default:
        throw new TypeError(
          "Validated non-executable tool reached the data dispatcher",
        );
    }
    };
    try {
      const result =
        name === "search" || name === "recording"
          ? await execute()
          : store.withCacheOperation(guard, execute);
      store.assertCacheOperation(guard);
      return result;
    } catch (error) {
      if (error instanceof CacheOperationChangedError) {
        return "Authentication or the active meeting cache changed during the operation. Retry it.";
      }
      if (error instanceof ArgumentValidationError) {
        return renderArgumentValidation(error);
      }
      throw error;
    }
  } finally {
    store.close();
  }
}
