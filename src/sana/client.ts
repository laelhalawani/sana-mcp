import fs from "node:fs";
import { CookieJar } from "./cookies.js";
import {
  SessionExpiredError,
  type MeetingSummary,
  type SanaUser,
  type TranscriptSegment,
} from "./types.js";
import { SESSION_FILE, ensureDataDir, loadConfig } from "../config.js";

interface SessionData {
  cookies: Record<string, string>;
  workspaceId?: string;
  email?: string;
  // Carried between the two login calls.
  pendingLogin?: { email: string; csrfToken: string } | null;
}

const AUTH_COOKIE = "sana-ai-session";

export class SanaClient {
  private jar: CookieJar;
  private baseUrl: string;
  workspaceId?: string;
  email?: string;
  private pendingLogin?: { email: string; csrfToken: string } | null;

  constructor(data?: SessionData) {
    this.jar = CookieJar.fromJSON(data?.cookies);
    this.workspaceId = data?.workspaceId;
    this.email = data?.email;
    this.pendingLogin = data?.pendingLogin ?? null;
    this.baseUrl = loadConfig().baseUrl.replace(/\/$/, "");
  }

  // ---- persistence -------------------------------------------------------

  static load(): SanaClient {
    try {
      const raw = fs.readFileSync(SESSION_FILE, "utf8");
      return new SanaClient(JSON.parse(raw) as SessionData);
    } catch {
      return new SanaClient();
    }
  }

  save(): void {
    ensureDataDir();
    const data: SessionData = {
      cookies: this.jar.toJSON(),
      workspaceId: this.workspaceId,
      email: this.email,
      pendingLogin: this.pendingLogin,
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  }

  hasAuthCookie(): boolean {
    return this.jar.has(AUTH_COOKIE);
  }

  // ---- low-level fetch (cookie-aware, manual redirects) ------------------

  private commonHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      cookie: this.jar.header(),
      ...extra,
    };
    if (this.workspaceId) h["sana-ai-workspace-id"] = this.workspaceId;
    return h;
  }

  /** Fetch that ingests Set-Cookie and manually follows redirects so cookies
   * set mid-redirect (e.g. the magic-link 302) are captured. */
  private async raw(
    url: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
    maxRedirects = 5
  ): Promise<Response> {
    let current = url;
    let res = await fetch(current, { ...init, redirect: "manual" });
    this.jar.ingest(res);
    let hops = 0;
    while (
      res.status >= 300 &&
      res.status < 400 &&
      res.headers.get("location") &&
      hops < maxRedirects
    ) {
      const loc = res.headers.get("location")!;
      current = new URL(loc, current).toString();
      res = await fetch(current, {
        method: "GET",
        headers: { cookie: this.jar.header() },
        redirect: "manual",
      });
      this.jar.ingest(res);
      hops++;
    }
    return res;
  }

  private async trpcQuery<T>(proc: string, input?: unknown): Promise<T> {
    const qs = input
      ? `?input=${encodeURIComponent(JSON.stringify(input))}`
      : "";
    const res = await fetch(`${this.baseUrl}/x-api/trpc/${proc}${qs}`, {
      headers: this.commonHeaders(),
    });
    this.jar.ingest(res);
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
    const json = (await res.json()) as { result?: { data?: T } };
    return json.result?.data as T;
  }

  private async trpcMutation<T>(proc: string, input: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/x-api/trpc/${proc}`, {
      method: "POST",
      headers: this.commonHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    this.jar.ingest(res);
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
    const json = (await res.json()) as { result?: { data?: T } };
    return json.result?.data as T;
  }

  // ---- auth --------------------------------------------------------------

  /** Step 1: request a sign-in code by email. */
  async requestSignInCode(email: string, workspaceId?: string): Promise<void> {
    const csrfRes = await this.raw(`${this.baseUrl}/x-api/auth/csrf-token`, {
      headers: { accept: "application/json" },
    });
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

    const body: Record<string, string> = { email };
    const ws = workspaceId || this.workspaceId;
    if (ws) body.loginViaWorkspaceId = ws;

    const res = await fetch(`${this.baseUrl}/x-api/trpc/user.sendSignInLink`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        cookie: this.jar.header(),
      },
      body: JSON.stringify(body),
    });
    this.jar.ingest(res);
    if (!res.ok) {
      throw new Error(`sendSignInLink failed: HTTP ${res.status} ${await res.text()}`);
    }
    this.pendingLogin = { email, csrfToken };
    this.email = email;
    if (ws) this.workspaceId = ws;
  }

  /** Step 2: submit the emailed code to establish the session. */
  async submitSignInCode(email: string, code: string): Promise<SanaUser> {
    const csrfToken = this.pendingLogin?.csrfToken;
    if (!csrfToken || this.pendingLogin?.email !== email) {
      throw new Error(
        "No pending login for this email. Call login with just the email first."
      );
    }
    const u = new URL(`${this.baseUrl}/x-api/auth/magic-link`);
    u.searchParams.set("email", email);
    u.searchParams.set("csrfToken", csrfToken);
    u.searchParams.set("code", String(code));
    await this.raw(u.toString(), { headers: { accept: "text/html,application/json" } });

    this.pendingLogin = null;
    const me = await this.me();
    if (!me) throw new SessionExpiredError("Sign-in did not establish a session");
    return me;
  }

  // ---- data --------------------------------------------------------------

  async me(): Promise<SanaUser | null> {
    const data = await this.trpcQuery<{ user?: SanaUser; workspace?: { id: string } }>(
      "user.me"
    );
    if (!data?.user) return null;
    // Adopt the workspace so subsequent calls carry the right header.
    if (data.workspace?.id) this.workspaceId = data.workspace.id;
    else if (data.user.lastUsedWorkspaceId) this.workspaceId = data.user.lastUsedWorkspaceId;
    this.email = data.user.email;
    return data.user;
  }

  /** One page of meetings. */
  async listMeetingsPage(
    cursor?: number
  ): Promise<{ assets: MeetingSummary[]; nextCursor: number | null }> {
    const input: Record<string, unknown> = {
      assetSourceTypes: ["sana-ai:meeting"],
      direction: "forward",
    };
    if (cursor !== undefined) input.cursor = cursor;
    const data = await this.trpcQuery<{
      assets?: MeetingSummary[];
      nextCursor?: number | null;
    }>("asset.listRecent", input);
    return { assets: data?.assets ?? [], nextCursor: data?.nextCursor ?? null };
  }

  /**
   * Walk meeting pages newest-first, invoking onPage for each. Stops when the
   * server has no more pages, or when onPage returns false (used by the daemon
   * to stop early once it reaches already-known meetings).
   */
  async walkMeetings(
    onPage: (assets: MeetingSummary[]) => boolean | void
  ): Promise<void> {
    let cursor: number | undefined = undefined;
    for (let guard = 0; guard < 5000; guard++) {
      const { assets, nextCursor } = await this.listMeetingsPage(cursor);
      const cont = onPage(assets);
      if (cont === false) return;
      if (assets.length === 0 || typeof nextCursor !== "number") return;
      cursor = nextCursor;
    }
  }

  /** All meetings, following the server-provided nextCursor to the end. */
  async listMeetings(): Promise<MeetingSummary[]> {
    const out: MeetingSummary[] = [];
    await this.walkMeetings((assets) => {
      out.push(...assets);
    });
    return out;
  }

  async getTranscription(assetId: string): Promise<TranscriptSegment[]> {
    const data = await this.trpcQuery<TranscriptSegment[]>("meeting.getTranscription", {
      assetId,
    });
    return data ?? [];
  }

  async getMeetingData(assetId: string): Promise<unknown> {
    return this.trpcMutation("meeting.getMeetingData", { assetId });
  }

  /** Rich meeting metadata: summary, summaryShort, notes, actionItems, etc. */
  async getMeetingById(assetId: string): Promise<{
    summary?: string | null;
    summaryShort?: string | null;
    notes?: unknown;
    actionItems?: unknown;
    recordingUrl?: string | null;
    fallbackRecordingUrl?: string | null;
  } | null> {
    return this.trpcQuery("meeting.getById", { assetId });
  }

  async getMeetingParticipants(assetId: string): Promise<
    { id?: string; email?: string; displayName?: string; isHost?: boolean }[]
  > {
    const data = await this.trpcQuery<
      { id?: string; email?: string; displayName?: string; isHost?: boolean }[]
    >("meeting.getMeetingParticipants", { assetId });
    return data ?? [];
  }
}
