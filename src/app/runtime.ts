import {
  getParticipants,
  getRecordingLink,
  getSummaryView,
  getTranscriptView,
  queryMeetings,
  type MeetingPage,
  type ParticipantsResult,
  type RecordingResult,
  type SummaryResult,
  type TranscriptView,
} from "../core/meetings.js";
import {
  requestCode,
  verifyCode,
  type LoginResult,
} from "../core/login.js";
import {
  runSearch,
  type SearchResult,
} from "../core/search.js";
import { computeStatus, type StatusInfo } from "../core/status.js";
import { runInstall, type InstallerFlowResult } from "../install/install.js";
import {
  AuthenticationOriginMismatchError,
  LegacyPartialSessionError,
  SanaClient,
} from "../sana/client.js";
import {
  CacheOperationChangedError,
  SanaStore,
  type CacheOperationGuard,
} from "../store/db.js";

/** Small structured boundary used by the terminal app and its tests. */
export interface AppRuntime {
  refresh(): void;
  status(): StatusInfo;
  meetings(args: Record<string, unknown>): MeetingPage;
  search(args: Record<string, unknown>, signal?: AbortSignal): Promise<SearchResult>;
  transcript(id: string): TranscriptView;
  summary(id: string): SummaryResult;
  participants(id: string): ParticipantsResult;
  recording(id: string): Promise<RecordingResult>;
  requestCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<LoginResult>;
  configure(): Promise<InstallerFlowResult>;
  close(): void;
}

export class LocalAppRuntime implements AppRuntime {
  private readonly store: SanaStore;
  private client: SanaClient;

  constructor() {
    this.client = this.loadClientForApp();
    this.store = new SanaStore();
  }

  private loadClientForApp(): SanaClient {
    try {
      return SanaClient.load();
    } catch (error) {
      if (
        error instanceof AuthenticationOriginMismatchError ||
        error instanceof LegacyPartialSessionError
      ) {
        return SanaClient.loadForOriginChangeLogin().client;
      }
      throw error;
    }
  }

  refresh(): void {
    this.client = this.loadClientForApp();
  }

  private captureGuard(): CacheOperationGuard {
    if (this.client.pendingSignInChallenge() !== null) {
      throw new CacheOperationChangedError();
    }
    const version = this.client.sessionVersion();
    if (
      version.publicationToken === null ||
      version.userId == null ||
      version.workspaceId == null
    ) {
      throw new Error("Authentication identity is incomplete. Sign in again.");
    }
    return this.store.captureCacheOperation({
      generation: version.generation,
      publicationToken: version.publicationToken,
      userId: version.userId,
      workspaceId: version.workspaceId,
    });
  }

  status(): StatusInfo {
    return computeStatus(this.client, this.store);
  }

  meetings(args: Record<string, unknown>): MeetingPage {
    const guard = this.captureGuard();
    return this.store.withCacheOperation(
      guard,
      () => queryMeetings(this.store, args),
    );
  }

  async search(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const guard = this.captureGuard();
    const result = await runSearch(this.store, args, { guard, signal });
    this.store.assertCacheOperation(guard);
    return result;
  }

  transcript(id: string): TranscriptView {
    const guard = this.captureGuard();
    return this.store.withCacheOperation(
      guard,
      () => getTranscriptView(this.store, id),
    );
  }

  summary(id: string): SummaryResult {
    const guard = this.captureGuard();
    return this.store.withCacheOperation(
      guard,
      () => getSummaryView(this.store, id),
    );
  }

  participants(id: string): ParticipantsResult {
    const guard = this.captureGuard();
    return this.store.withCacheOperation(
      guard,
      () => getParticipants(this.store, id),
    );
  }

  recording(id: string): Promise<RecordingResult> {
    return getRecordingLink(
      this.client,
      this.store,
      id,
      this.captureGuard(),
    );
  }

  requestCode(email: string): Promise<void> {
    return requestCode(this.client, email);
  }

  verifyCode(email: string, code: string): Promise<LoginResult> {
    return verifyCode(this.client, this.store, email, code);
  }

  async configure(): Promise<InstallerFlowResult> {
    const result = await runInstall();
    this.refresh();
    return result;
  }

  close(): void {
    this.store.close();
  }
}
