import { SanaClient } from "../sana/client.js";
import { SessionExpiredError } from "../sana/types.js";
import { SanaStore, type SyncState, type MeetingListOpts } from "../store/db.js";
import { ensureDaemonRunning } from "../sync/spawn.js";
import { transcriptLines, renderLines } from "../sana/transcript.js";
import { renderHelp, toolListLine } from "./help.js";
import { MAX_TRANSCRIPT_ATTEMPTS } from "../config.js";

const LOGIN_HINT = 'Run meeting_transcripts("login", {"email":"you@example.com"}) to sign in.';
const EXPIRED_MSG = `Your login has expired. To login again run meeting_transcripts("login", {"email":"you@example.com"}).`;
const LOGIN_EXPLAINER = [
  "You are not logged in.",
  "To sign in, use the email address of your Sana.ai subscription:",
  'call meeting_transcripts("login", {"email":"you@example.com"}) to get a 6-digit code by email,',
  'then call meeting_transcripts("login", {"email":"you@example.com", "confirmation_code": <the 6 digits>}).',
].join("\n");

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function estimateMinutes(remaining: number): number {
  // ~0.5s per transcript (request + polite delay); round up to a minute.
  return Math.max(1, Math.ceil((remaining * 0.5) / 60));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The meeting count only appears after the daemon's brief "listing" phase.
// Wait up to half the 60s MCP default so login can report it, but never risk
// the client's request timeout.
const COUNT_WAIT_MS = Number(process.env.SANA_COUNT_WAIT_MS ?? 30_000);

/**
 * Wait (up to timeoutMs) for the login-triggered sync to finish, tracking how
 * many items remain. Returns done=true if it completes in time, otherwise the
 * last-known remaining count (or null if not even that resolved).
 */
async function waitForSync(
  store: SanaStore,
  timeoutMs: number
): Promise<{ done: boolean; count: number | null }> {
  const end = Date.now() + timeoutMs;
  let count: number | null = null;
  for (;;) {
    const s = store.getSyncState();
    if (!syncBlocking(s)) return { done: true, count: 0 };
    if (s.phase === "downloading" || s.phase === "synced")
      count = Math.max(0, s.transcripts_total - s.transcripts_done);
    if (s.phase === "needs_login" || s.phase === "error") return { done: false, count };
    if (Date.now() >= end) return { done: false, count };
    await sleep(300);
  }
}

/** Whether the session looks usable without doing a network call. */
function sessionUsable(client: SanaClient, s: SyncState): boolean {
  return client.hasAuthCookie() && s.phase !== "needs_login";
}

/**
 * Data tools are blocked while a login-triggered catch-up sync runs. This is
 * set on every login and cleared by the daemon once fully caught up, so a
 * returning user always gets fresh content before tools respond. Ongoing
 * incremental syncs do NOT set this and stay invisible to the agent.
 */
function syncBlocking(s: SyncState): boolean {
  return s.blocking === 1;
}

function syncBlockedMessage(s: SyncState): string {
  const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
  const detail =
    s.transcripts_total > 0
      ? `${remaining} item(s) left, about ${estimateMinutes(remaining)} min`
      : "building the meeting list";
  return (
    `Sync in progress (${detail}). ` +
    `Meeting tools are unavailable until it completes. ` +
    `Check progress with meeting_transcripts("status").`
  );
}

function fmtDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

async function handleLogin(args: Record<string, unknown>): Promise<string> {
  const email = typeof args.email === "string" ? args.email.trim() : "";
  if (!email) {
    return 'To sign in, provide the email connected to your Sana.ai subscription: meeting_transcripts("login", {"email":"you@example.com"}). A 6-digit code will be emailed to that address.';
  }
  const codeRaw = args.confirmation_code ?? args.code;
  const client = SanaClient.load();

  if (codeRaw === undefined || codeRaw === null || `${codeRaw}` === "") {
    try {
      await client.requestSignInCode(email, args.workspace_id as string | undefined);
      client.save();
    } catch (e) {
      return `Could not start sign-in for ${email}: ${(e as Error).message}`;
    }
    return [
      `A 6-digit sign-in code was just emailed to ${email}.`,
      ``,
      `Next: get that code, then call`,
      `  meeting_transcripts("login", {"email":"${email}", "confirmation_code": <the 6 digits>})`,
      ``,
      `If you have an email-reading tool, read the most recent email from noreply@sana.ai titled "Sign in to Sana" to find the code. Otherwise, ask the user to read it to you.`,
    ].join("\n");
  }

  try {
    const user = await client.submitSignInCode(email, `${codeRaw}`);
    client.save();

    const store = new SanaStore();
    try {
      // Every login triggers a fresh catch-up sync; block data tools until done.
      // Reset failure counters so previously-failed transcripts are retried.
      store.resetFailures();
      store.updateSyncState({ blocking: 1 });
      ensureDaemonRunning();

      const head = `Logged in as ${user.email}${client.workspaceId ? ` (workspace ${client.workspaceId})` : ""}.`;
      const tail = [
        ``,
        `Available tools: ${toolListLine()}.`,
        `Use meeting_transcripts("help", {"tool":"<name>"}) for details.`,
      ];
      const blockedLine =
        `Meeting tools are unavailable until it completes. Check progress with meeting_transcripts("status").`;

      const res = await waitForSync(store, COUNT_WAIT_MS);
      if (res.done) {
        return [head, `Sync complete. Your transcripts are up to date and all tools are available.`, ...tail].join("\n");
      }
      if (res.count != null) {
        return [
          head,
          `Sync in progress: ${res.count} item(s) to download (about ${estimateMinutes(res.count)} min).`,
          blockedLine,
          ...tail,
        ].join("\n");
      }
      return [head, `Sync in progress.`, blockedLine, ...tail].join("\n");
    } finally {
      store.close();
    }
  } catch (e) {
    return `Sign-in failed: ${(e as Error).message}. Double-check the code, or request a new one with meeting_transcripts("login", {"email":"${email}"}).`;
  }
}

function handleStatus(store: SanaStore): string {
  const s = store.getSyncState();
  const lines: string[] = [];
  if (syncBlocking(s)) {
    const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
    lines.push(
      s.transcripts_total > 0
        ? `Sync in progress: ${s.transcripts_done}/${s.transcripts_total} transcripts (~${estimateMinutes(
            remaining
          )} min remaining).`
        : `Sync in progress: building the meeting list.`
    );
    lines.push("Meeting tools are unavailable until it completes.");
  } else {
    lines.push(
      `Up to date. ${store.countMeetings()} meetings, ${store.countTranscripts()} transcripts stored.`
    );
    lines.push("New meetings sync automatically shortly after they end.");
  }
  if (s.last_full_sync_ms) lines.push(`Last sync: ${new Date(s.last_full_sync_ms).toISOString()}.`);
  return lines.join("\n");
}

function escCell(s: string): string {
  // Markdown table cell: only the pipe needs escaping; newlines flattened.
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** Accept an ISO date/datetime string or an epoch-ms number. */
function parseDateMs(v: unknown, endOfDay = false): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
    const ms = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
    if (Number.isNaN(ms)) return undefined;
    return endOfDay && dateOnly ? ms + 86_400_000 - 1 : ms;
  }
  return undefined;
}

/** Extract sort/filter (date range, status) from a tool's args dict. */
function parseFilters(args: Record<string, unknown>): {
  status?: MeetingListOpts["status"];
  dateFrom?: number;
  dateTo?: number;
} {
  const filter =
    args.filter && typeof args.filter === "object" ? (args.filter as Record<string, unknown>) : {};
  const status =
    filter.status === "ready" || filter.status === "downloading" || filter.status === "failed"
      ? filter.status
      : undefined;
  const date = filter.date && typeof filter.date === "object" ? (filter.date as Record<string, unknown>) : {};
  return {
    status,
    dateFrom: parseDateMs(date.from),
    dateTo: parseDateMs(date.to, true),
  };
}

function rowStatus(r: { has_transcript: number; attempts: number; processing_phase: string | null }): string {
  if (r.has_transcript) return "ready";
  if (r.processing_phase && r.processing_phase !== "done") return "processing";
  return r.attempts >= MAX_TRANSCRIPT_ATTEMPTS ? "failed" : "downloading";
}

function handleListMeetings(store: SanaStore, args: Record<string, unknown>): string {
  const limit = Math.max(1, Number(args.limit ?? 50));
  const page = Math.max(1, Number(args.page ?? 1));
  const offset = (page - 1) * limit;
  const query = typeof args.query === "string" ? args.query : undefined;
  const sort: MeetingListOpts["sort"] = args.sort === "oldest" ? "oldest" : "newest";
  const { status, dateFrom, dateTo } = parseFilters(args);
  const filter: MeetingListOpts = { query, sort, status, dateFrom, dateTo };

  const rows = store.listMeetings({ ...filter, limit, offset });
  const total = store.countMeetings(filter);
  if (rows.length === 0) {
    if (total === 0) return "No meetings match those criteria.";
    return `No meetings on page ${page} (${total} match; ${Math.ceil(total / limit)} page(s)).`;
  }

  const n = rows.length;
  const before =
    n === total
      ? `Showing ${n} meeting transcripts.`
      : `Showing ${n} out of ${total} meeting transcripts.`;

  const table = [
    `| started_at (UTC, YYYY-MM-DD HH:MM) | id (string) | status (ready/downloading/processing/failed) | title (string) |`,
    `|---|---|---|---|`,
    ...rows.map(
      (r) => `| ${fmtDateTime(r.created_at_ms)} | ${r.id} | ${rowStatus(r)} | ${escCell(r.name)} |`
    ),
  ];

  const out = [before, "", ...table];
  if (offset + n < total) {
    out.push("", `Use meeting_transcripts("list", {"page":${page + 1}}) to see the next page.`);
  }
  out.push(
    "",
    `Per meeting (by id): read (transcript), summary, participants, recording.`
  );
  return out.join("\n");
}

function handleReadTranscript(store: SanaStore, args: Record<string, unknown>): string {
  const id = typeof args.meeting_id === "string" ? args.meeting_id : typeof args.id === "string" ? args.id : "";
  if (!id)
    return 'Provide a meeting id: meeting_transcripts("read", {"meeting_id":"..."}). Get ids from meeting_transcripts("list") or "search".';
  const meeting = store.getMeeting(id);
  const t = store.getTranscript(id);
  if (!meeting && !t) {
    const s = store.getSyncState();
    if (s.phase === "listing" || s.phase === "idle")
      return "Still syncing the meeting list. Try again in a few seconds.";
    return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  }
  if (!t) {
    const s = store.getSyncState();
    const remaining = Math.max(0, s.transcripts_total - s.transcripts_done);
    if (s.phase === "downloading")
      return `The transcript for "${meeting?.name ?? id}" hasn't been downloaded yet (${s.transcripts_done}/${s.transcripts_total} done). Check back in ~${estimateMinutes(
        remaining
      )} min.`;
    return `No transcript available for "${meeting?.name ?? id}".`;
  }

  const lines = transcriptLines(JSON.parse(t.json));
  const withTs = args.timestamps === undefined ? true : Boolean(args.timestamps);
  const title = meeting?.name ?? id;
  const dateStr = meeting ? fmtDate(meeting.created_at_ms) : "";

  const header = `# ${title}\n${dateStr} | ${lines.length} lines | ${t.word_count} words`;

  const full = args.full === true;
  const range = Array.isArray(args.lines) ? (args.lines as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : null;

  // No selection -> don't dump; report size and offer options.
  if (!full && (!range || range.length === 0)) {
    return [
      header,
      "",
      `This transcript has ${lines.length} lines. Choose how to read it:`,
      `- Whole thing:  meeting_transcripts("read", {"meeting_id":"${id}", "full":true})`,
      `- A range:      meeting_transcripts("read", {"meeting_id":"${id}", "lines":[start, end]})`,
      `  (one line = one thing said by a person; line numbers come from "search" or a prior read)`,
    ].join("\n");
  }

  let selected = lines;
  let rangeNote = "all lines";
  if (!full && range && range.length > 0) {
    const start = Math.max(1, range[0]);
    const end = range.length >= 2 ? Math.max(start, range[1]) : start;
    selected = lines.filter((l) => l.n >= start && l.n <= end);
    rangeNote = `lines ${start}-${end}`;
    if (selected.length === 0)
      return `${header}\n\nNo lines in ${rangeNote}. Valid range is 1-${lines.length}.`;
  }

  return `${header} | showing ${rangeNote}\n\n${renderLines(selected, {
    timestamps: withTs,
    numbers: true,
  })}`;
}

function argMeetingId(args: Record<string, unknown>): string {
  return typeof args.meeting_id === "string" ? args.meeting_id : typeof args.id === "string" ? args.id : "";
}

function handleSummary(store: SanaStore, args: Record<string, unknown>): string {
  const id = argMeetingId(args);
  if (!id) return 'Provide a meeting id: meeting_transcripts("summary", {"meeting_id":"..."}).';
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (!meta) return `No summary available yet for "${meeting?.name ?? id}".`;

  const out: string[] = [`# ${meeting?.name ?? id}`, meeting ? fmtDate(meeting.created_at_ms) : ""];
  if (meta.summary_short) out.push("", `Short summary: ${meta.summary_short}`);
  if (meta.summary) out.push("", "Summary:", meta.summary);
  if (meta.notes_json) {
    try {
      const parsed = JSON.parse(meta.notes_json) as {
        notes?: { topic?: string; notes?: string[] }[] | null;
        actionItems?: { assignedTo?: string | null; action?: string; dueDate?: string | null }[] | null;
      };
      const ai = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
      if (ai.length) {
        out.push("", "Action items:");
        for (const a of ai) {
          const tags = [a.assignedTo ? `assignee: ${a.assignedTo}` : "", a.dueDate ? `due: ${a.dueDate}` : ""]
            .filter(Boolean)
            .join("; ");
          out.push(`- ${a.action ?? ""}${tags ? ` (${tags})` : ""}`);
        }
      }
      const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
      if (notes.length) {
        out.push("", "Notes:");
        for (const nt of notes) {
          out.push(`- ${nt.topic ?? "Topic"}: ${Array.isArray(nt.notes) ? nt.notes.join(" ") : ""}`);
        }
      }
    } catch {
      // ignore malformed metadata
    }
  }
  if (out.filter((l) => l).length <= 2) return `No summary available for "${meeting?.name ?? id}".`;
  return out.join("\n");
}

function handleParticipants(store: SanaStore, args: Record<string, unknown>): string {
  const id = argMeetingId(args);
  if (!id) return 'Provide a meeting id: meeting_transcripts("participants", {"meeting_id":"..."}).';
  const meeting = store.getMeeting(id);
  const meta = store.getMetadata(id);
  if (!meeting && !meta) return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  let ps: { displayName?: string; email?: string; isHost?: boolean }[] = [];
  try {
    ps = meta?.participants_json ? JSON.parse(meta.participants_json) : [];
  } catch {
    ps = [];
  }
  if (!ps.length) return `No participant information for "${meeting?.name ?? id}".`;
  const table = [
    `Participants for "${meeting?.name ?? id}" (${ps.length}):`,
    "",
    `| name (string) | email (string) | host (yes/no) |`,
    `|---|---|---|`,
    ...ps.map(
      (p) => `| ${escCell(p.displayName || "")} | ${escCell(p.email || "")} | ${p.isHost ? "yes" : "no"} |`
    ),
  ];
  return table.join("\n");
}

function snippetAround(text: string, query: string, pad = 80): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, pad * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - pad);
  const end = Math.min(text.length, i + query.length + pad);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${core}${end < text.length ? "..." : ""}`;
}

function handleSearch(store: SanaStore, args: Record<string, unknown>): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return 'Provide a search query: meeting_transcripts("search", {"query":"..."}). Optional: limit, sort, filter.';
  }
  // Tokenize into unicode word/number terms and AND them as quoted FTS terms.
  // This keeps user input safe from FTS5 operator syntax and matches on word
  // boundaries (all terms must appear in a line).
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return `No searchable words in "${query}".`;
  const match = terms.map((t) => `"${t}"`).join(" ");

  const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 100);
  const page = Math.max(1, Number(args.page ?? 1));
  const offset = (page - 1) * limit;
  const sort = args.sort === "newest" || args.sort === "oldest" ? args.sort : "best";
  const { dateFrom, dateTo } = parseFilters(args);

  let rows, total: number;
  try {
    total = store.countLineMatches(match, { dateFrom, dateTo });
    rows = store.searchLines(match, { limit, offset, sort, dateFrom, dateTo });
  } catch (e) {
    return `Could not run search for "${query}": ${(e as Error).message}`;
  }
  if (rows.length === 0) {
    if (total === 0) return `No transcript lines match "${query}".`;
    return `No results on page ${page} (${total} match; ${Math.ceil(total / limit)} page(s)).`;
  }

  const n = rows.length;
  const ranked = sort === "best" ? "relevance" : sort;
  const before =
    n === total
      ? `Showing ${n} matching lines for "${query}" (ranked by ${ranked}).`
      : `Showing ${n} out of ${total} matching lines for "${query}" (ranked by ${ranked}).`;

  const anchor = terms[0] ?? query;
  const table = [
    `| started_at (UTC, YYYY-MM-DD HH:MM) | id (string) | line (int) | title (string) | snippet (string) |`,
    `|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${fmtDateTime(r.created_at_ms)} | ${r.meeting_id} | ${r.line_no} | ${escCell(r.name)} | ${escCell(
          snippetAround(r.text, anchor)
        )} |`
    ),
  ];
  const out = [before, ``, ...table];
  if (offset + n < total) {
    out.push(
      ``,
      `Use meeting_transcripts("search", {"query":"${query.replace(/"/g, '\\"')}", "page":${page + 1}}) to see the next page.`
    );
  }
  out.push(``, `Read around a hit with meeting_transcripts("read", {"meeting_id":"<id>", "lines":[<line>-2, <line>+2]}).`);
  return out.join("\n");
}

/**
 * Fetch a fresh, temporary recording link on demand. This is the only data
 * tool that hits the network (recording URLs are signed and expire), keeping
 * read/list/search fully local.
 */
async function handleRecording(
  client: SanaClient,
  store: SanaStore,
  args: Record<string, unknown>
): Promise<string> {
  const id = typeof args.meeting_id === "string" ? args.meeting_id : typeof args.id === "string" ? args.id : "";
  if (!id) return 'Provide a meeting id: meeting_transcripts("recording", {"meeting_id":"..."}).';
  const name = store.getMeeting(id)?.name ?? id;
  try {
    const info = await client.getMeetingById(id);
    const url = info?.recordingUrl || info?.fallbackRecordingUrl;
    if (!url) return `No recording available for "${name}".`;
    return `Recording for "${name}" (temporary signed URL, expires in a few hours):\n${url}`;
  } catch (e) {
    if (e instanceof SessionExpiredError) return EXPIRED_MSG;
    return `Could not fetch the recording link: ${(e as Error).message}`;
  }
}

/**
 * Single entry point: sana(tool, args). Reads are served from the local store;
 * only login and the recording tool touch the network. Kicks the daemon awake.
 */
export async function sana(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const name = (tool || "help").trim().toLowerCase();

  if (name === "help") {
    const client = SanaClient.load();
    const store = new SanaStore();
    let notice: string | undefined;
    try {
      const s = store.getSyncState();
      const loggedIn = client.hasAuthCookie() && s.phase !== "needs_login";
      if (!loggedIn) notice = LOGIN_EXPLAINER;
      else if (syncBlocking(s)) notice = syncBlockedMessage(s);
    } finally {
      store.close();
    }
    return renderHelp(args.tool as string | undefined, notice);
  }
  if (name === "login") return handleLogin(args);

  // Everything else requires a session and reads the local store.
  const client = SanaClient.load();
  const store = new SanaStore();
  try {
    const s = store.getSyncState();
    if (!client.hasAuthCookie()) {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    if (!sessionUsable(client, s)) {
      return EXPIRED_MSG;
    }
    // Make sure the background syncer is alive (non-blocking).
    ensureDaemonRunning();

    // status stays available during a catch-up sync; data tools do not.
    const blocked = syncBlocking(s) ? syncBlockedMessage(s) : null;
    switch (name) {
      case "status":
        return handleStatus(store);
      case "list_meetings":
      case "list":
        return blocked ?? handleListMeetings(store, args);
      case "read_transcript":
      case "read":
        return blocked ?? handleReadTranscript(store, args);
      case "search":
        return blocked ?? handleSearch(store, args);
      case "summary":
        return blocked ?? handleSummary(store, args);
      case "participants":
        return blocked ?? handleParticipants(store, args);
      case "recording":
        return blocked ?? (await handleRecording(client, store, args));
      default:
        return `Unknown tool "${tool}". ${renderHelp()}`;
    }
  } finally {
    store.close();
  }
}
