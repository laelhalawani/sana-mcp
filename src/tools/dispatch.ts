// MCP/agent-facing dispatcher. Every handler renders LLM-facing strings from
// the presentation-agnostic core (src/core/*). The wording here is deliberately
// agent-oriented (it coaches an LLM to call meeting_transcripts(...)); the human
// CLI has its own renderers and must never reuse these strings.
import { SanaClient } from "../sana/client.js";
import { SanaStore } from "../store/db.js";
import { ensureDaemonRunning } from "../sync/spawn.js";
import { renderLines } from "../sana/transcript.js";
import { renderHelp, toolListLine } from "./help.js";
import { semanticEnabled } from "../semantic/semantic.js";
import { argMeetingId, fmtDate, fmtDateTime, estimateMinutes } from "../core/args.js";
import { requestCode, verifyCode, waitForSync, COUNT_WAIT_MS } from "../core/login.js";
import { sessionInfo, isBlocking, computeStatus } from "../core/status.js";
import { queryMeetings, getTranscriptView, getSummaryView, getParticipants, getRecordingLink, rowStatus } from "../core/meetings.js";
import { runSearch, snippetAround, type SearchRow, type SearchResult } from "../core/search.js";

const LOGIN_HINT = 'Run meeting_transcripts("login", {"email":"you@example.com"}) to sign in.';
const EXPIRED_MSG = `Your login has expired. To login again run meeting_transcripts("login", {"email":"you@example.com"}).`;
const LOGIN_EXPLAINER = [
  "You are not logged in.",
  "To sign in, use the email address of your Sana.ai subscription:",
  'call meeting_transcripts("login", {"email":"you@example.com"}) to get a 6-digit code by email,',
  'then call meeting_transcripts("login", {"email":"you@example.com", "confirmation_code": <the 6 digits>}).',
].join("\n");

function syncBlockedMessage(s: { transcripts_total: number; transcripts_done: number }): string {
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

async function handleLogin(args: Record<string, unknown>): Promise<string> {
  const email = typeof args.email === "string" ? args.email.trim() : "";
  if (!email) {
    return 'To sign in, provide the email connected to your Sana.ai subscription: meeting_transcripts("login", {"email":"you@example.com"}). A 6-digit code will be emailed to that address.';
  }
  const codeRaw = args.confirmation_code ?? args.code;
  const client = SanaClient.load();

  if (codeRaw === undefined || codeRaw === null || `${codeRaw}` === "") {
    try {
      await requestCode(client, email, args.workspace_id as string | undefined);
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

  const store = new SanaStore();
  try {
    const { user } = await verifyCode(client, store, email, `${codeRaw}`);

    const head = `Logged in as ${user.email}${client.workspaceId ? ` (workspace ${client.workspaceId})` : ""}.`;
    const tail = [
      ``,
      `Available tools: ${toolListLine()}.`,
      `Use meeting_transcripts("help", {"tool":"<name>"}) for details.`,
    ];
    const blockedLine = `Meeting tools are unavailable until it completes. Check progress with meeting_transcripts("status").`;

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
  } catch (e) {
    return `Sign-in failed: ${(e as Error).message}. Double-check the code, or request a new one with meeting_transcripts("login", {"email":"${email}"}).`;
  } finally {
    store.close();
  }
}

function handleStatus(client: SanaClient, store: SanaStore): string {
  const st = computeStatus(client, store);
  const lines: string[] = [];
  if (st.blocking) {
    lines.push(
      st.transcriptsTotal > 0
        ? `Sync in progress: ${st.transcriptsDone}/${st.transcriptsTotal} transcripts (~${st.etaMinutes} min remaining).`
        : `Sync in progress: building the meeting list.`
    );
    lines.push("Meeting tools are unavailable until it completes.");
  } else {
    lines.push(`Up to date. ${st.meetings} meetings, ${st.transcripts} transcripts stored.`);
    lines.push("New meetings sync automatically shortly after they end.");
  }
  if (st.lastFullSyncMs) lines.push(`Last sync: ${new Date(st.lastFullSyncMs).toISOString()}.`);
  if (st.semantic.enabled)
    lines.push(`Semantic search: on (${st.semantic.embedded}/${st.semantic.total} transcripts embedded).`);
  return lines.join("\n");
}

function escCell(s: string): string {
  // Markdown table cell: only the pipe needs escaping; newlines flattened.
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
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
  if (!id)
    return 'Provide a meeting id: meeting_transcripts("read", {"meeting_id":"..."}). Get ids from meeting_transcripts("list") or "search".';
  const v = getTranscriptView(store, id);
  if (v.kind === "still-listing") return "Still syncing the meeting list. Try again in a few seconds.";
  if (v.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (v.kind === "not-downloaded")
    return `The transcript for "${v.name}" hasn't been downloaded yet (${v.done}/${v.total} done). Check back in ~${v.etaMinutes} min.`;
  if (v.kind === "no-transcript") return `No transcript available for "${v.name}".`;

  const withTs = args.timestamps === undefined ? true : Boolean(args.timestamps);
  const dateStr = v.dateMs != null ? fmtDate(v.dateMs) : "";
  const header = `# ${v.name}\n${dateStr} | ${v.lineCount} lines | ${v.wordCount} words`;

  const full = args.full === true;
  const range = Array.isArray(args.lines)
    ? (args.lines as unknown[]).map(Number).filter((n) => Number.isFinite(n))
    : null;

  // No selection -> don't dump; report size and offer options.
  if (!full && (!range || range.length === 0)) {
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
    const start = Math.max(1, range[0]);
    const end = range.length >= 2 ? Math.max(start, range[1]) : start;
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
  if (!id) return 'Provide a meeting id: meeting_transcripts("summary", {"meeting_id":"..."}).';
  const r = getSummaryView(store, id);
  if (r.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (r.kind === "none") return `No summary available yet for "${r.name}".`;
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
  if (!id) return 'Provide a meeting id: meeting_transcripts("participants", {"meeting_id":"..."}).';
  const r = getParticipants(store, id);
  if (r.kind === "no-meeting") return `No meeting with id "${id}". Use meeting_transcripts("list") to find valid ids.`;
  if (r.kind === "none") return `No participant information for "${r.name}".`;
  const table = [
    `Participants for "${r.name}" (${r.participants.length}):`,
    "",
    `| name (string) | email (string) | host (yes/no) |`,
    `|---|---|---|`,
    ...r.participants.map(
      (p) => `| ${escCell(p.displayName || "")} | ${escCell(p.email || "")} | ${p.isHost ? "yes" : "no"} |`
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
  const out = [before, ``, ...table];
  if (offset + rows.length < total) {
    out.push(
      ``,
      `Use meeting_transcripts("search", {"query":"${query.replace(/"/g, '\\"')}", "page":${page + 1}}) to see the next page.`
    );
  }
  out.push(``, `Read around a hit with meeting_transcripts("read", {"meeting_id":"<id>", "lines":[<line>-2, <line>+2]}).`);
  return out.join("\n");
}

async function handleSearch(store: SanaStore, args: Record<string, unknown>): Promise<string> {
  const res = await runSearch(store, args);
  switch (res.kind) {
    case "no-query":
      return 'Provide a search query: meeting_transcripts("search", {"query":"..."}). Optional: page, limit, sort, filter.';
    case "no-terms":
      return `No searchable words in "${res.query}".`;
    case "error":
      return `Could not run search for "${res.query}": ${res.message}`;
    case "semantic-unavailable":
      return `Semantic search is enabled but unavailable: ${res.message} Set SANA_SEMANTIC=0 to use keyword search.`;
    case "ok": {
      if (res.rows.length === 0) {
        if (res.total === 0) return `No transcript lines match "${res.query}".`;
        return `No results on page ${res.page} (${res.total} match${
          res.mode === "keyword" ? `; ${Math.ceil(res.total / res.limit)} page(s)` : ""
        }).`;
      }
      return renderSearchResults(res);
    }
  }
}

async function handleRecording(
  client: SanaClient,
  store: SanaStore,
  args: Record<string, unknown>
): Promise<string> {
  const id = argMeetingId(args);
  if (!id) return 'Provide a meeting id: meeting_transcripts("recording", {"meeting_id":"..."}).';
  const r = await getRecordingLink(client, store, id);
  switch (r.kind) {
    case "ok":
      return `Recording for "${r.name}" (temporary signed URL, expires in a few hours):\n${r.url}`;
    case "none":
      return `No recording available for "${r.name}".`;
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
  const name = (tool || "help").trim().toLowerCase();

  if (name === "help") {
    const client = SanaClient.load();
    const store = new SanaStore();
    let notice: string | undefined;
    try {
      const s = store.getSyncState();
      const sess = sessionInfo(client, s);
      if (!sess.loggedIn) notice = LOGIN_EXPLAINER;
      else if (isBlocking(s)) notice = syncBlockedMessage(s);
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
    const sess = sessionInfo(client, s);
    if (!sess.hasCookie) {
      return `You are not logged in. ${LOGIN_HINT}`;
    }
    if (!sess.loggedIn) {
      return EXPIRED_MSG;
    }
    // Make sure the background syncer is alive (non-blocking).
    ensureDaemonRunning();

    // status stays available during a catch-up sync; data tools do not.
    const blocked = isBlocking(s) ? syncBlockedMessage(s) : null;
    switch (name) {
      case "status":
        return handleStatus(client, store);
      case "list_meetings":
      case "list":
        return blocked ?? handleListMeetings(store, args);
      case "read_transcript":
      case "read":
        return blocked ?? handleReadTranscript(store, args);
      case "search":
        return blocked ?? (await handleSearch(store, args));
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
