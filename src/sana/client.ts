import { z } from "zod";
import { CookieJar } from "./cookies.js";
import {
  SessionExpiredError,
  type MeetingSummary,
  type SanaUser,
  type TranscriptSegment,
} from "./types.js";
import { loadConfig, sessionFile } from "../config.js";
import { readJsonFile, writeJsonAtomic } from "../runtime/secure-files.js";

interface SessionData {
  cookies: Record<string, string>;
  userId?: string;
  workspaceId?: string;
  email?: string;
  generation?: number;
  publicationToken?: string;
  authenticatedOrigin?: string;
  // Carried between the two login calls.
  pendingLogin?: { email: string; csrfToken: string } | null;
}

export interface PendingSignInChallenge {
  readonly email: string;
}

const authoritativeIdSchema = z
  .string()
  .refine(
    (value) => value.trim() !== "" && value === value.trim(),
    "must be a non-empty string without surrounding whitespace",
  );

const sessionDataSchema = z
  .object({
    cookies: z.record(z.string(), z.string()),
    userId: authoritativeIdSchema.optional(),
    workspaceId: authoritativeIdSchema.optional(),
    email: z.string().min(1).optional(),
    generation: z.number().int().nonnegative().optional(),
    publicationToken: z.string().uuid().optional(),
    authenticatedOrigin: z.string().url().optional(),
    pendingLogin: z
      .object({
        email: z.string().min(1),
        csrfToken: z.string().min(1),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((data, context) => {
    const hasGeneration = data.generation !== undefined;
    const hasPublicationToken = data.publicationToken !== undefined;
    if (hasGeneration !== hasPublicationToken) {
      context.addIssue({
        code: "custom",
        message:
          "generation and publicationToken must either both be present or both be absent",
      });
    }
    if (data.generation === 0) {
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message:
          "generation zero is reserved for legacy session files without publication metadata",
      });
    }
    if (
      (data.userId === undefined) !==
      (data.workspaceId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "authoritative userId and workspaceId must be present together",
      });
    }
    if (
      data.generation === undefined &&
      (data.userId !== undefined ||
        data.workspaceId !== undefined ||
        data.pendingLogin != null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "generation-less sessions cannot contain identity or pending authentication state",
      });
    }
  });

const legacyPartialSessionSchema = z
  .object({
    cookies: z.record(z.string(), z.string()),
    userId: authoritativeIdSchema.optional(),
    workspaceId: authoritativeIdSchema.optional(),
    email: z.string().min(1).optional(),
    authenticatedOrigin: z.string().url().optional(),
    pendingLogin: z
      .object({
        email: z.string().min(1),
        csrfToken: z.string().min(1),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.userId !== undefined ||
      data.workspaceId !== undefined ||
      data.pendingLogin != null,
    "legacy session must contain identity or pending authentication state",
  );

const sessionFileSchema = z.union([
  sessionDataSchema,
  legacyPartialSessionSchema,
]);

const AUTH_COOKIE = "sana-ai-session";
// Intentional primary network bound for Sana requests. Redirect chains are
// additionally bounded by raw()'s hop limit.
export const SANA_HTTP_TIMEOUT_MS = 30_000;

const renderableEpochMsSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(
    (value) => Number.isFinite(new Date(value).getTime()),
    "must be a valid JavaScript Date epoch-millisecond value",
  );

const sanaUserSchema = z
  .object({
    id: authoritativeIdSchema,
    email: z.string().email(),
    displayName: z.string().optional(),
    lastUsedWorkspaceId: authoritativeIdSchema.optional(),
  })
  .passthrough();

const workspaceSchema = z
  .object({
    id: authoritativeIdSchema,
  })
  .passthrough();

const meetingSummarySchema = z
  .object({
    id: authoritativeIdSchema,
    externalId: authoritativeIdSchema.nullable().optional(),
    name: z.string(),
    createdAtEpochMs: renderableEpochMsSchema,
    modifiedAtEpochMs: renderableEpochMsSchema.nullable().optional(),
    source: z.string().min(1),
    processingPhase: z.string().nullable().optional(),
  })
  .passthrough();

const transcriptWordSchema = z
  .object({
    text: z.string(),
    start_timestamp: z.number().finite().nonnegative(),
    end_timestamp: z.number().finite().nonnegative(),
  })
  .refine(
    (word) => word.end_timestamp >= word.start_timestamp,
    "end_timestamp must not be earlier than start_timestamp",
  )
  .passthrough();

const transcriptSegmentSchema = z
  .object({
    language: z.string().optional(),
    speaker: z.string(),
    words: z.array(transcriptWordSchema),
  })
  .passthrough();

const meetingMetadataSchema = z
  .object({
    summary: z.string().nullable().optional(),
    summaryShort: z.string().nullable().optional(),
    notes: z
      .array(
        z
          .object({
            topic: z.string().min(1),
            notes: z.array(z.string()),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    actionItems: z
      .array(
        z
          .object({
            assignedTo: z.string().nullable().optional(),
            action: z.string(),
            dueDate: z
              .union([z.string(), z.number().finite().transform(String)])
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    recordingUrl: z.string().url().nullable().optional(),
    fallbackRecordingUrl: z.string().url().nullable().optional(),
  })
  .passthrough();

const participantSchema = z
  .object({
    id: authoritativeIdSchema.optional(),
    email: z.string().email().nullish(),
    displayName: z
      .string()
      .min(1)
      .refine(
        (displayName) => displayName.trim() !== "",
        "displayName must contain a non-whitespace character",
      )
      .optional(),
    isHost: z.boolean(),
  })
  .passthrough();

type RawRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

interface MutableClientState {
  cookies: Record<string, string>;
  userId?: string;
  workspaceId?: string;
  email?: string;
  pendingLogin?: { email: string; csrfToken: string } | null;
  generation: number;
  publicationToken: string | null;
  authenticatedOrigin: string | null;
}

export class SanaClient {
  private jar: CookieJar;
  private readonly baseUrl: string;
  userId?: string;
  workspaceId?: string;
  email?: string;
  private pendingLogin?: { email: string; csrfToken: string } | null;
  private generation: number;
  private publicationToken: string | null;
  private authenticatedOrigin: string | null;

  constructor(data?: SessionData) {
    this.jar = CookieJar.fromJSON(data?.cookies);
    this.userId = data?.userId;
    this.workspaceId = data?.workspaceId;
    this.email = data?.email;
    this.pendingLogin = data?.pendingLogin ?? null;
    // Generation-zero remains the explicit baseline for a session file that
    // predates durable authentication publication. SQLite validation rejects
    // it if the durable store has already advanced.
    this.generation = data?.generation ?? 0;
    this.publicationToken = data?.publicationToken ?? null;
    this.baseUrl = loadConfig().baseUrl.replace(/\/$/, "");
    this.authenticatedOrigin = data?.authenticatedOrigin ?? null;
    const configuredOrigin = new URL(this.baseUrl).origin;
    if (
      this.jar.has(AUTH_COOKIE) &&
      this.authenticatedOrigin !== configuredOrigin
    ) {
      throw new AuthenticationOriginMismatchError(
        this.authenticatedOrigin,
        configuredOrigin,
      );
    }
  }

  // ---- persistence -------------------------------------------------------

  static load(): SanaClient {
    const result = readJsonFile(sessionFile(), sessionFileSchema);
    if (result.kind === "missing") return new SanaClient();
    if (isLegacyPartialSession(result.value)) {
      throw new LegacyPartialSessionError();
    }
    return new SanaClient(result.value);
  }

  /**
   * Build the explicit fresh-login state for a saved session whose authenticated
   * origin no longer matches configuration. The confirmed publication baseline
   * remains intact for the SQLite CAS; credentials and pending challenges do not.
   */
  static loadForOriginChangeLogin(): Readonly<{
    client: SanaClient;
    baseline: "preserved" | "reset-partial-legacy";
  }> {
    const result = readJsonFile(sessionFile(), sessionFileSchema);
    if (result.kind === "missing") {
      throw new OriginChangeRecoveryError(
        "The origin-mismatched session disappeared before fresh-login recovery",
      );
    }
    const saved = result.value;
    const savedCookies = CookieJar.fromJSON(saved.cookies);
    if (isLegacyPartialSession(saved)) {
      return {
        client: new SanaClient(),
        baseline: "reset-partial-legacy",
      };
    }
    const canonical = saved as SessionData;
    const configuredOrigin = new URL(
      loadConfig().baseUrl.replace(/\/$/, ""),
    ).origin;
    if (
      !savedCookies.has(AUTH_COOKIE) ||
      canonical.authenticatedOrigin === configuredOrigin
    ) {
      throw new OriginChangeRecoveryError(
        "The saved session no longer proves an authentication-origin mismatch",
      );
    }
    const generation = canonical.generation ?? 0;
    const publicationToken = canonical.publicationToken ?? null;
    const userId = canonical.userId ?? null;
    const workspaceId = canonical.workspaceId ?? null;
    if (
      (generation === 0) !== (publicationToken === null) ||
      (generation === 0 && (userId !== null || workspaceId !== null)) ||
      (userId === null) !== (workspaceId === null)
    ) {
      throw new OriginChangeRecoveryError(
        "The origin-mismatched session has no valid confirmed CAS baseline",
      );
    }
    const {
      cookies: _cookies,
      pendingLogin: _pendingLogin,
      authenticatedOrigin: _authenticatedOrigin,
      ...baseline
    } = canonical;
    return {
      client: new SanaClient({
        ...baseline,
        cookies: {},
        pendingLogin: null,
      }),
      baseline: "preserved",
    };
  }

  sessionVersion(): Readonly<{
    generation: number;
    publicationToken: string | null;
    userId?: string | null;
    workspaceId?: string | null;
  }> {
    const hasAuthoritativeIdentity =
      this.userId !== undefined && this.workspaceId !== undefined;
    return {
      generation: this.generation,
      publicationToken: this.publicationToken,
      userId: hasAuthoritativeIdentity ? this.userId! : null,
      workspaceId: hasAuthoritativeIdentity ? this.workspaceId! : null,
    };
  }

  private snapshotMutableState(): MutableClientState {
    return {
      cookies: this.jar.toJSON(),
      userId: this.userId,
      workspaceId: this.workspaceId,
      email: this.email,
      pendingLogin: this.pendingLogin
        ? { ...this.pendingLogin }
        : this.pendingLogin,
      generation: this.generation,
      publicationToken: this.publicationToken,
      authenticatedOrigin: this.authenticatedOrigin,
    };
  }

  private restoreMutableState(previous: MutableClientState): void {
    this.jar = CookieJar.fromJSON(previous.cookies);
    this.userId = previous.userId;
    this.workspaceId = previous.workspaceId;
    this.email = previous.email;
    this.pendingLogin = previous.pendingLogin
      ? { ...previous.pendingLogin }
      : previous.pendingLogin;
    this.generation = previous.generation;
    this.publicationToken = previous.publicationToken;
    this.authenticatedOrigin = previous.authenticatedOrigin;
  }

  savePublication(generation: number, publicationToken: string): void {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= this.generation
    ) {
      throw new TypeError(
        "Session publication generation must advance monotonically",
      );
    }
    if (!z.string().uuid().safeParse(publicationToken).success) {
      throw new TypeError("Session publication token must be a UUID");
    }
    const data: SessionData = {
      cookies: this.jar.toJSON(),
      pendingLogin: this.pendingLogin,
      generation,
      publicationToken,
    };
    if (this.jar.has(AUTH_COOKIE)) {
      const configuredOrigin = new URL(this.baseUrl).origin;
      if (this.authenticatedOrigin !== configuredOrigin) {
        throw new AuthenticationOriginMismatchError(
          this.authenticatedOrigin,
          configuredOrigin,
        );
      }
      data.authenticatedOrigin = this.authenticatedOrigin;
    }
    if (this.userId !== undefined) data.userId = this.userId;
    if (this.workspaceId !== undefined) data.workspaceId = this.workspaceId;
    if (this.email !== undefined) data.email = this.email;
    writeJsonAtomic(sessionFile(), data);
    // The in-memory version is observable by later coordinator calls, so it
    // must advance only after the durable atomic write has succeeded.
    this.generation = generation;
    this.publicationToken = publicationToken;
  }

  hasAuthCookie(): boolean {
    return this.jar.has(AUTH_COOKIE);
  }

  pendingSignInChallenge(): Readonly<PendingSignInChallenge> | null {
    return this.pendingLogin === null || this.pendingLogin === undefined
      ? null
      : Object.freeze({ email: this.pendingLogin.email });
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

  private async boundedFetch(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(SANA_HTTP_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      if (
        timeoutSignal.aborted ||
        (error instanceof Error &&
          error.name === "TimeoutError")
      ) {
        throw new SanaRequestTimeoutError(operation, SANA_HTTP_TIMEOUT_MS, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async requireOk(res: Response, operation: string): Promise<void> {
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpiredError();
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 500).trim();
      } catch {
        // The HTTP status remains authoritative if an error body is unreadable.
      }
      throw new SanaHttpError(operation, res.status, detail);
    }
  }

  private async parseJson(
    res: Response,
    operation: string,
  ): Promise<unknown> {
    try {
      return await res.json();
    } catch (error) {
      throw new SanaResponseValidationError(
        operation,
        "response was not valid JSON",
        { cause: error },
      );
    }
  }

  private async trpcData<T>(
    res: Response,
    operation: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    await this.requireOk(res, operation);
    const json = await this.parseJson(res, operation);
    const envelope = z
      .object({
        result: z.object({ data: z.unknown() }).passthrough(),
      })
      .passthrough()
      .safeParse(json);
    if (
      !envelope.success ||
      !Object.prototype.hasOwnProperty.call(envelope.data.result, "data")
    ) {
      throw new SanaResponseValidationError(
        operation,
        "response did not contain a successful tRPC result.data envelope",
      );
    }
    const parsed = schema.safeParse(envelope.data.result.data);
    if (!parsed.success) {
      throw new SanaResponseValidationError(
        operation,
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; "),
      );
    }
    return parsed.data;
  }

  /** Fetch that ingests Set-Cookie and manually follows redirects so cookies
   * set mid-redirect (e.g. the magic-link 302) are captured. */
  private async raw(
    url: string,
    init: RawRequestInit = {},
    maxRedirects = 5,
    operation = "authentication request",
  ): Promise<Response> {
    let current = url;
    let currentInit: RawRequestInit = {
      ...init,
      headers: { ...(init.headers ?? {}) },
    };
    this.assertAuthenticationOrigin(current);
    let res = await this.boundedFetch(
      current,
      { ...currentInit, redirect: "manual" },
      operation,
    );
    this.jar.ingest(res);
    let hops = 0;
    while (
      isFollowableRedirect(res.status) &&
      res.headers.get("location")
    ) {
      if (hops >= maxRedirects) {
        throw new SanaRedirectError(maxRedirects);
      }
      const loc = res.headers.get("location")!;
      current = new URL(loc, current).toString();
      this.assertAuthenticationOrigin(current);
      currentInit = redirectRequest(
        currentInit,
        res.status,
        this.jar.header(),
      );
      res = await this.boundedFetch(
        current,
        { ...currentInit, redirect: "manual" },
        `${operation} redirect`,
      );
      this.jar.ingest(res);
      hops++;
    }
    await this.requireOk(res, operation);
    return res;
  }

  private assertAuthenticationOrigin(url: string): void {
    const parsed = new URL(url);
    const configured = new URL(this.baseUrl);
    const configuredTransportAllowed =
      configured.protocol === "https:" ||
      (configured.protocol === "http:" &&
        isExactLoopbackHost(configured.hostname));
    if (
      !configuredTransportAllowed ||
      parsed.origin !== configured.origin
    ) {
      throw new AuthenticationRedirectOriginError(
        parsed.origin,
        configured.origin,
      );
    }
  }

  private async trpcQuery<T>(
    proc: string,
    schema: z.ZodType<T>,
    input?: unknown,
  ): Promise<T> {
    const qs = input
      ? `?input=${encodeURIComponent(JSON.stringify(input))}`
      : "";
    const res = await this.raw(
      `${this.baseUrl}/x-api/trpc/${proc}${qs}`,
      { headers: this.commonHeaders() },
      5,
      proc,
    );
    this.jar.ingest(res);
    return this.trpcData(res, proc, schema);
  }

  private async trpcMutation<T>(
    proc: string,
    input: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.raw(
      `${this.baseUrl}/x-api/trpc/${proc}`,
      {
        method: "POST",
        headers: this.commonHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      },
      5,
      proc,
    );
    this.jar.ingest(res);
    return this.trpcData(res, proc, schema);
  }

  // ---- auth --------------------------------------------------------------

  /** Step 1: request a sign-in code by email. */
  async requestSignInCode(email: string): Promise<void>;
  async requestSignInCode(
    email: string,
    workspaceId: string,
  ): Promise<void>;
  async requestSignInCode(
    email: string,
    ...workspaceArgument: [] | [unknown]
  ): Promise<void> {
    const normalizedEmail = normalizeAuthEmail(email);
    let selectedWorkspaceId: string | undefined;
    if (workspaceArgument.length === 1) {
      const workspaceId = workspaceArgument[0];
      if (
        typeof workspaceId !== "string" ||
        workspaceId.trim() === "" ||
        workspaceId !== workspaceId.trim()
      ) {
        throw new SanaInputValidationError(
          "Sign-in workspace_id must be a non-empty string without surrounding whitespace",
        );
      }
      selectedWorkspaceId = workspaceId;
    } else {
      selectedWorkspaceId = this.workspaceId;
    }
    const csrfRes = await this.raw(`${this.baseUrl}/x-api/auth/csrf-token`, {
      headers: { accept: "application/json" },
    });
    const csrf = z
      .object({ csrfToken: z.string().min(1) })
      .passthrough()
      .safeParse(await this.parseJson(csrfRes, "auth.csrf-token"));
    if (!csrf.success) {
      throw new SanaResponseValidationError(
        "auth.csrf-token",
        csrf.error.message,
      );
    }
    const { csrfToken } = csrf.data;

    const body: Record<string, string> = { email: normalizedEmail };
    if (selectedWorkspaceId !== undefined) {
      body.loginViaWorkspaceId = selectedWorkspaceId;
    }

    await this.trpcMutation(
      "user.sendSignInLink",
      body,
      z.unknown(),
    );
    // Sana may establish the request-code session during the CSRF/sign-in-link
    // exchange. raw() has already constrained every request and redirect to
    // this exact, transport-approved origin, so bind that cookie before the
    // pending challenge is made durable.
    if (this.jar.has(AUTH_COOKIE)) {
      this.authenticatedOrigin = new URL(this.baseUrl).origin;
    }
    this.pendingLogin = { email: normalizedEmail, csrfToken };
    this.email = normalizedEmail;
  }

  /** Step 2: submit the emailed code to establish the session. */
  async submitSignInCode(email: string, code: string): Promise<SanaUser> {
    const normalizedEmail = normalizeAuthEmail(email);
    const pendingLogin = this.pendingLogin;
    const csrfToken = pendingLogin?.csrfToken;
    if (
      !csrfToken ||
      !pendingLogin ||
      normalizeAuthEmail(pendingLogin.email) !== normalizedEmail
    ) {
      throw new NoPendingLoginError(
        "No pending login for this email. Call login with just the email first."
      );
    }
    const u = new URL(`${this.baseUrl}/x-api/auth/magic-link`);
    u.searchParams.set("email", normalizedEmail);
    u.searchParams.set("csrfToken", csrfToken);
    u.searchParams.set("code", String(code));
    const previous = this.snapshotMutableState();
    this.jar.delete(AUTH_COOKIE);
    try {
      await this.raw(u.toString(), {
        headers: { accept: "text/html,application/json" },
      });
      if (!this.jar.has(AUTH_COOKIE)) {
        throw new SignInChallengeRejectedError(
          "Sana did not issue a new authenticated session for this sign-in code",
        );
      }
      this.authenticatedOrigin = new URL(this.baseUrl).origin;
      const me = await this.me();
      if (normalizeAuthEmail(me.email) !== normalizedEmail) {
        throw new SignInChallengeRejectedError(
          "The authenticated Sana session does not match the requested email",
        );
      }
      this.pendingLogin = null;
      return me;
    } catch (error) {
      this.restoreMutableState(previous);
      throw error;
    }
  }

  // ---- data --------------------------------------------------------------

  async me(): Promise<SanaUser> {
    const previous = this.snapshotMutableState();
    try {
      const data = await this.trpcQuery(
        "user.me",
        z
          .object({
            user: sanaUserSchema,
            workspace: workspaceSchema.nullable().optional(),
          })
          .passthrough(),
      );
      const workspaceId =
        data.workspace?.id ?? data.user.lastUsedWorkspaceId;
      if (workspaceId === undefined) {
        throw new AuthoritativeWorkspaceUnavailableError();
      }
      // Both candidates come from the fully validated authenticated response.
      // The active workspace wins when Sana supplies it; Sana's validated
      // last-used workspace is the routing identity when that projection is
      // explicitly null or absent.
      this.userId = data.user.id;
      this.workspaceId = workspaceId;
      this.email = data.user.email;
      return data.user;
    } catch (error) {
      this.restoreMutableState(previous);
      throw error;
    }
  }

  /** One page of meetings. */
  async listMeetingsPage(
    cursor?: number
  ): Promise<{ assets: MeetingSummary[]; nextCursor?: number | null }> {
    const input: Record<string, unknown> = {
      assetSourceTypes: ["sana-ai:meeting"],
      direction: "forward",
    };
    if (cursor !== undefined) input.cursor = cursor;
    return this.trpcQuery(
      "asset.listRecent",
      z
        .object({
          assets: z.array(meetingSummarySchema),
          nextCursor: z.number().finite().nonnegative().nullable().optional(),
        })
        .passthrough(),
      input,
    );
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
    const seenCursors = new Set<number>();
    for (let guard = 0; guard < 5000; guard++) {
      const { assets, nextCursor } = await this.listMeetingsPage(cursor);
      const cont = onPage(assets);
      if (cont === false) return;
      if (assets.length === 0 || typeof nextCursor !== "number") return;
      if (seenCursors.has(nextCursor)) {
        throw new SanaResponseValidationError(
          "asset.listRecent",
          "pagination cursor repeated",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new SanaResponseValidationError(
      "asset.listRecent",
      "pagination exceeded the documented safety bound",
    );
  }

  async getTranscription(assetId: string): Promise<TranscriptSegment[]> {
    return this.trpcQuery(
      "meeting.getTranscription",
      z.array(transcriptSegmentSchema),
      { assetId },
    );
  }

  /** Rich meeting metadata: summary, summaryShort, notes, actionItems, etc. */
  async getMeetingById(assetId: string): Promise<{
    summary?: string | null;
    summaryShort?: string | null;
    notes?: { topic: string; notes: string[] }[] | null;
    actionItems?: {
      assignedTo?: string | null;
      action: string;
      dueDate?: string | null;
    }[] | null;
    recordingUrl?: string | null;
    fallbackRecordingUrl?: string | null;
  }> {
    return this.trpcQuery(
      "meeting.getById",
      meetingMetadataSchema,
      { assetId },
    );
  }

  async getMeetingParticipants(assetId: string): Promise<
    { id?: string; email?: string | null; displayName?: string; isHost: boolean }[]
  > {
    return this.trpcQuery(
      "meeting.getMeetingParticipants",
      z.array(participantSchema),
      { assetId },
    );
  }
}

function isExactLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function isFollowableRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function redirectRequest(
  previous: RawRequestInit,
  status: number,
  cookie: string,
): RawRequestInit & { headers: Record<string, string> } {
  const previousMethod = (previous.method ?? "GET").toUpperCase();
  // Match conventional Fetch/browser behavior: 303 always becomes GET, while
  // 301/302 rewrite POST to GET. 307/308 preserve method and replayable body.
  const becomesGet =
    status === 303 ||
    ((status === 301 || status === 302) && previousMethod === "POST");
  const headers: Record<string, string> = {
    ...(previous.headers ?? {}),
    cookie,
  };
  if (becomesGet) {
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (
        normalized === "content-type" ||
        normalized === "content-length"
      ) {
        delete headers[name];
      }
    }
    return {
      ...previous,
      method: "GET",
      body: undefined,
      headers,
    };
  }
  return {
    ...previous,
    method: previousMethod,
    headers,
  };
}

export class AuthoritativeWorkspaceUnavailableError extends Error {
  readonly code = "AUTHORITATIVE_WORKSPACE_UNAVAILABLE";

  constructor() {
    super(
      "Sana authenticated the user but did not return an authoritative active workspace",
    );
    this.name = "AuthoritativeWorkspaceUnavailableError";
  }
}

export class SanaHttpError extends Error {
  readonly code = "SANA_HTTP_ERROR";

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly responseDetail: string,
  ) {
    super(
      `${operation} failed with HTTP ${status}${
        responseDetail ? `: ${responseDetail}` : ""
      }`,
    );
    this.name = "SanaHttpError";
  }
}

export class SanaResponseValidationError extends Error {
  readonly code = "SANA_RESPONSE_INVALID";

  constructor(
    readonly operation: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${operation} returned an invalid response: ${detail}`, options);
    this.name = "SanaResponseValidationError";
  }
}

export class SanaRequestTimeoutError extends Error {
  readonly code = "SANA_REQUEST_TIMEOUT";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`, options);
    this.name = "SanaRequestTimeoutError";
  }
}

export class SanaRedirectError extends Error {
  readonly code = "SANA_REDIRECT_INVALID";

  constructor(readonly maxRedirects: number) {
    super(
      `Sana authentication did not reach a successful terminal response within ${maxRedirects} redirects`,
    );
    this.name = "SanaRedirectError";
  }
}

export class SignInChallengeRejectedError extends Error {
  readonly code = "SIGN_IN_CHALLENGE_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "SignInChallengeRejectedError";
  }
}

export class AuthenticationOriginMismatchError extends Error {
  readonly code = "AUTHENTICATION_ORIGIN_MISMATCH";

  constructor(
    readonly authenticatedOrigin: string | null,
    readonly configuredOrigin: string,
  ) {
    super(
      "The saved Sana session is not bound to the configured Sana origin; sign in again",
    );
    this.name = "AuthenticationOriginMismatchError";
  }
}

export class OriginChangeRecoveryError extends Error {
  readonly code = "ORIGIN_CHANGE_RECOVERY_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OriginChangeRecoveryError";
  }
}

export class LegacyPartialSessionError extends Error {
  readonly code = "LEGACY_PARTIAL_SESSION";

  constructor() {
    super(
      "The saved legacy Sana session has only a partial identity and requires a fresh sign-in",
    );
    this.name = "LegacyPartialSessionError";
  }
}

export class AuthenticationRedirectOriginError extends Error {
  readonly code = "AUTHENTICATION_REDIRECT_ORIGIN_REJECTED";

  constructor(
    readonly redirectOrigin: string,
    readonly configuredOrigin: string,
  ) {
    super(
      "Sana authentication attempted to redirect credentials to a different or disallowed origin",
    );
    this.name = "AuthenticationRedirectOriginError";
  }
}

function normalizeAuthEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!z.string().email().safeParse(normalized).success) {
    throw new SanaInputValidationError(
      "Sign-in email must be a valid email address",
    );
  }
  return normalized;
}

export class SanaInputValidationError extends Error {
  readonly code = "SANA_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SanaInputValidationError";
  }
}

export class NoPendingLoginError extends Error {
  readonly code = "NO_PENDING_LOGIN";

  constructor(message: string) {
    super(message);
    this.name = "NoPendingLoginError";
  }
}

function isLegacyPartialSession(
  data: z.infer<typeof sessionFileSchema>,
): boolean {
  return (
    !("generation" in data) &&
    (data.userId !== undefined ||
      data.workspaceId !== undefined ||
      data.pendingLogin != null)
  );
}
