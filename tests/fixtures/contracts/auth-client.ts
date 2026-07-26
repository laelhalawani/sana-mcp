import {
  confirmedPublicationToken,
  contractUserId,
  contractWorkspaceId,
  initialPublicationToken,
  mutateContractCacheIdentity,
  recordContractEvent,
} from "./auth-model.js";

const scenario = process.env.SANA_TEST_AUTH_SCENARIO;
if (!scenario) throw new Error("SANA_TEST_AUTH_SCENARIO is required");

export class SanaInputValidationError extends Error {}
export class NoPendingLoginError extends Error {}
export class SignInChallengeRejectedError extends Error {}
export class SanaHttpError extends Error {
  constructor(readonly status: number) {
    super(`synthetic Sana HTTP ${status}`);
  }
}
export class AuthenticationOriginMismatchError extends Error {}
export class LegacyPartialSessionError extends Error {}

export class SanaClient {
  private generation = 2;
  private publicationToken = initialPublicationToken;
  private userId: string | null = contractUserId;
  private currentWorkspaceId: string | null = contractWorkspaceId;

  get workspaceId(): string | null {
    return this.currentWorkspaceId;
  }

  static load(): SanaClient {
    if (
      scenario === "origin-mismatch" ||
      scenario === "origin-baseline-recovery-failed"
    ) {
      throw new AuthenticationOriginMismatchError(
        "synthetic saved-origin mismatch",
      );
    }
    if (scenario === "legacy-partial-session") {
      throw new LegacyPartialSessionError(
        "synthetic partial legacy session",
      );
    }
    if (scenario === "local-auth-state-unavailable") {
      throw new Error("synthetic local authentication read failure");
    }
    return new SanaClient();
  }

  static loadForOriginChangeLogin(): Readonly<{
    client: SanaClient;
    baseline: "preserved-confirmed" | "reset-partial-legacy";
  }> {
    if (scenario === "origin-baseline-recovery-failed") {
      throw new Error("synthetic confirmed baseline recovery failure");
    }
    return {
      client: new SanaClient(),
      baseline:
        scenario === "legacy-partial-session"
          ? "reset-partial-legacy"
          : "preserved-confirmed",
    };
  }

  hasAuthCookie(): boolean {
    return scenario !== "signed-out";
  }

  pendingSignInChallenge(): null {
    return null;
  }

  sessionVersion(): Readonly<{
    generation: number;
    publicationToken: string;
    userId: string | null;
    workspaceId: string | null;
  }> {
    return {
      generation: this.generation,
      publicationToken: this.publicationToken,
      userId: this.userId,
      workspaceId: this.currentWorkspaceId,
    };
  }

  saveContractPublication(generation: number): void {
    if (generation !== this.generation + 1) {
      throw new Error(
        `contract publication skipped from ${this.generation} to ${generation}`,
      );
    }
    this.generation = generation;
    this.publicationToken = confirmedPublicationToken;
    recordContractEvent(`session-save:${generation}`);
  }

  async requestSignInCode(): Promise<void> {
    if (scenario === "request-preflight-rejected") {
      throw new SanaInputValidationError("synthetic request is invalid");
    }
    if (scenario === "request-remote-rejected") {
      throw new SignInChallengeRejectedError(
        "synthetic Sana request rejection",
      );
    }
    if (scenario === "request-remote-unknown") {
      throw new Error("synthetic uncertain Sana request failure");
    }
  }

  async submitSignInCode(): Promise<Readonly<{ email: string }>> {
    if (scenario === "verify-preflight-rejected") {
      throw new NoPendingLoginError("synthetic challenge is absent");
    }
    if (scenario === "verify-remote-rejected") {
      throw new SignInChallengeRejectedError(
        "synthetic Sana verification rejection",
      );
    }
    if (scenario === "verify-remote-unknown") {
      throw new Error("synthetic uncertain Sana verification failure");
    }
    if (scenario === "missing-authoritative-identity") {
      this.userId = null;
      this.currentWorkspaceId = null;
    }
    return { email: "auth@example.invalid" };
  }

  async getMeetingById(): Promise<
    Readonly<{ recordingUrl: string; fallbackRecordingUrl: null }>
  > {
    await Promise.resolve();
    recordContractEvent("recording-fetch-complete");
    if (scenario === "cache-recording-changed-after-await") {
      mutateContractCacheIdentity("recording-after-await");
    }
    return {
      recordingUrl: "https://recording.example.invalid/contract",
      fallbackRecordingUrl: null,
    };
  }
}
