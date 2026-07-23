export interface ToolDoc {
  name: string;
  summary: string;
  args: string; // human-readable arg description
  example: string;
}

export const TOOLS: ToolDoc[] = [
  {
    name: "login",
    summary:
      "Log in to Sana. Two steps: first with just your email to receive a 6-digit code, then again with the code.",
    args: 'email: string (required); confirmation_code: number/string (step 2); workspace_id: string (optional)',
    example:
      'Step 1 (request code): meeting_transcripts("login", {"email":"you@example.com"})\n' +
      '           Step 2 (verify):       meeting_transcripts("login", {"email":"you@example.com", "confirmation_code": 123456})',
  },
  {
    name: "status",
    summary:
      "Report background-sync progress: how many meetings and transcripts have been synced, and whether a sync is in progress.",
    args: "(none)",
    example: 'meeting_transcripts("status")',
  },
  {
    name: "list",
    summary:
      "List your meetings from the local store with id, timestamp, title, and transcript status (ready/downloading/failed).",
    args:
      'page: number (default 1); limit: number (page size, default 50); query: string (title filter); sort: "newest" (default) or "oldest"; filter: {status: "ready"|"downloading"|"failed", date: {from, to}} where from/to are ISO dates ("YYYY-MM-DD") or epoch ms',
    example: 'meeting_transcripts("list", {"sort":"oldest", "filter":{"date":{"from":"2026-06-01","to":"2026-06-30"}}})',
  },
  {
    name: "read",
    summary:
      "Read a meeting transcript as numbered lines. With no line selection it reports the line count and options; use full:true for the whole thing, or lines:[start,end] for a range. A line is one spoken turn. (Summary, participants and recording are separate tools.)",
    args:
      'meeting_id: string (required); full: boolean (read all); lines: [start,end] (1-based line range); timestamps: boolean (default true)',
    example: 'meeting_transcripts("read", {"meeting_id":"v72HzzJDZx9WqTmF", "lines":[22,26]})',
  },
  {
    name: "search",
    summary:
      "Search transcripts and get matching lines with meeting id and line number. Keyword (BM25, whole-word) by default; becomes hybrid keyword+semantic when semantic search is enabled (SANA_SEMANTIC=1).",
    args:
      'query: string (required); page: number (default 1); limit: number (page size, default 10); sort: "best" (default, relevance) or "newest" or "oldest"; filter: {date: {from, to}} where from/to are ISO dates ("YYYY-MM-DD") or epoch ms',
    example: 'meeting_transcripts("search", {"query":"pricing", "sort":"newest"})',
  },
  {
    name: "summary",
    summary: "Get a meeting's summary, plus notes (by topic) and action items.",
    args: "meeting_id: string (required)",
    example: 'meeting_transcripts("summary", {"meeting_id":"v72HzzJDZx9WqTmF"})',
  },
  {
    name: "participants",
    summary: "List a meeting's participants (name, email, host).",
    args: "meeting_id: string (required)",
    example: 'meeting_transcripts("participants", {"meeting_id":"v72HzzJDZx9WqTmF"})',
  },
  {
    name: "recording",
    summary:
      "Get a temporary link to a meeting's recording. Fetched live from Sana (the only tool that hits the network); the URL expires after a few hours.",
    args: "meeting_id: string (required)",
    example: 'meeting_transcripts("recording", {"meeting_id":"v72HzzJDZx9WqTmF"})',
  },
  {
    name: "help",
    summary: "Show this help, or details for one tool.",
    args: "tool: string (optional)",
    example: 'meeting_transcripts("help", {"tool":"list_meetings"})',
  },
];

export function renderHelp(toolName?: string, loginNotice?: string): string {
  if (toolName) {
    const t = TOOLS.find((x) => x.name === toolName);
    if (!t) return `Unknown tool "${toolName}". Run meeting_transcripts("help") to list tools.`;
    const lines: string[] = [];
    if (loginNotice) lines.push(loginNotice, "");
    lines.push(
      `meeting_transcripts("${t.name}", ...)`,
      ``,
      t.summary,
      ``,
      `Arguments: ${t.args}`,
      `Example:   ${t.example}`
    );
    return lines.join("\n");
  }
  const lines: string[] = [];
  if (loginNotice) lines.push(loginNotice, "");
  lines.push("Meeting transcripts tool. Call as meeting_transcripts(<tool>, <args>).", "", "Tools:");
  for (const t of TOOLS) {
    lines.push(`  - ${t.name} - ${t.summary}`);
    lines.push(`      args: ${t.args}`);
  }
  lines.push("", 'Get more detail on a specific tool with meeting_transcripts("help", {"tool":"<name>"}).');
  return lines.join("\n");
}

export function toolListLine(): string {
  return TOOLS.map((t) => t.name).join(", ");
}
