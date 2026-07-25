// Structured login core shared by the MCP handler and the interactive CLI.
// Performs the side-effects (request code, verify code, stamp the catch-up
// sync, spawn the daemon) and returns typed results. No display strings: each
// caller renders its own audience-appropriate text.
import {
  NoPendingLoginError,
  SanaClient,
  SanaHttpError,
  SanaInputValidationError,
  SignInChallengeRejectedError,
} from "./client.js";
import { SessionExpiredError, type SanaUser } from "./types.js";
import { SanaStore } from "../store/db.js";
import { ensureDaemonRunning } from "../sync/spawn.js";
import {
  publishClientSession,
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  StaleSessionWriterError,
  type AuthConfirmation,
} from "./session-publication.js";

interface LoginIdentity {
  user: SanaUser;
  workspaceId: string;
  confirmation: AuthConfirmation;
}

export type LoginResult =
  | (LoginIdentity & {
      kind: "ready";
    })
  | (LoginIdentity & {
      kind: "sync-unavailable";
      failure: {
        code: "LOGIN_SYNC_UNAVAILABLE";
        message: string;
        cause: unknown;
        persistence?: {
          code: "SYNC_STATUS_PERSISTENCE_FAILED";
          message: string;
          cause: unknown;
        };
      };
    });

export class RequestCodeRemoteError extends Error {
  readonly code = "REQUEST_CODE_REMOTE_FAILED";
  readonly stage = "remote";
  readonly remoteAccepted: false | "unknown";

  constructor(cause: unknown) {
    const remoteAccepted = remoteAcceptance(cause);
    super(
      remoteAccepted === false
        ? "Sana rejected the sign-in code request"
        : "It is unknown whether Sana accepted the sign-in code request",
      { cause },
    );
    this.remoteAccepted = remoteAccepted;
    this.name = "RequestCodeRemoteError";
  }
}

export class RequestCodePreflightError extends Error {
  readonly code = "REQUEST_CODE_PREFLIGHT_FAILED";
  readonly stage = "preflight";
  readonly remoteAccepted = false;

  constructor(options: ErrorOptions) {
    super("The sign-in code request was invalid before contacting Sana", options);
    this.name = "RequestCodePreflightError";
  }
}

export class RequestCodeLocalTransitionError extends Error {
  readonly code = "REQUEST_CODE_LOCAL_TRANSITION_FAILED";
  readonly stage = "local";
  readonly remoteAccepted = true;

  constructor(
    readonly failures: Readonly<{
      store?: unknown;
      publication?: unknown;
      cleanup?: unknown;
    }>,
  ) {
    const causes = [
      failures.store,
      failures.publication,
      failures.cleanup,
    ].filter((failure) => failure !== undefined);
    super(
      "Sana accepted the sign-in code request, but local session publication did not complete",
      {
        cause:
          causes.length === 1
            ? causes[0]
            : new AggregateError(
                causes,
                "Local sign-in request transition failed",
              ),
      },
    );
    this.name = "RequestCodeLocalTransitionError";
  }
}

export class VerifyCodeRemoteError extends Error {
  readonly code = "VERIFY_CODE_REMOTE_FAILED";
  readonly stage = "remote";
  readonly remoteAccepted: false | "unknown";

  constructor(cause: unknown) {
    const remoteAccepted = remoteAcceptance(cause);
    super(
      remoteAccepted === false
        ? "Sana rejected the sign-in code"
        : "It is unknown whether Sana accepted the sign-in code",
      { cause },
    );
    this.remoteAccepted = remoteAccepted;
    this.name = "VerifyCodeRemoteError";
  }
}

export class VerifyCodePreflightError extends Error {
  readonly code = "VERIFY_CODE_PREFLIGHT_FAILED";
  readonly stage = "preflight";
  readonly remoteAccepted = false;

  constructor(
    message = "The sign-in code could not be submitted because no matching challenge is pending",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerifyCodePreflightError";
  }
}

export class VerifyCodeLocalTransitionError extends Error {
  readonly code = "VERIFY_CODE_LOCAL_TRANSITION_FAILED";
  readonly stage = "local";
  readonly remoteAccepted = true;

  constructor(
    readonly failures: Readonly<{
      store?: unknown;
      publication?: unknown;
      syncFailure?: unknown;
      cleanup?: unknown;
    }>,
  ) {
    const causes = [
      failures.store,
      failures.publication,
      failures.syncFailure,
      failures.cleanup,
    ].filter((failure) => failure !== undefined);
    super(
      "Sana accepted the sign-in code, but the local authentication transition did not complete",
      {
        cause:
          causes.length === 1
            ? causes[0]
            : new AggregateError(
                causes,
                "Local verified sign-in transition failed",
              ),
      },
    );
    this.name = "VerifyCodeLocalTransitionError";
  }
}

/**
 * Step 1: request a 6-digit sign-in code by email. Wraps
 * client.requestSignInCode + coordinated session publication. Throws on failure; the caller
 * renders the error in its own words.
 */
export function requestCode(
  client: SanaClient,
  email: string,
): Promise<void>;
export function requestCode(
  client: SanaClient,
  email: string,
  workspaceId: string,
): Promise<void>;
export async function requestCode(
  client: SanaClient,
  email: string,
  ...workspaceArgument: [] | [unknown]
): Promise<void> {
  const sourceVersion = client.sessionVersion();
  try {
    if (workspaceArgument.length === 0) {
      await client.requestSignInCode(email);
    } else {
      await client.requestSignInCode(
        email,
        workspaceArgument[0] as string,
      );
    }
  } catch (error) {
    if (error instanceof SanaInputValidationError) {
      throw new RequestCodePreflightError({ cause: error });
    }
    throw new RequestCodeRemoteError(error);
  }
  let store: SanaStore;
  try {
    store = new SanaStore();
  } catch (error) {
    throw new RequestCodeLocalTransitionError({ store: error });
  }
  let publicationFailure: unknown;
  try {
    publishClientSession(store, client, "request-code", sourceVersion);
  } catch (error) {
    publicationFailure = error;
  }
  let cleanupFailure: unknown;
  try {
    store.close();
  } catch (error) {
    cleanupFailure = error;
  }
  if (
    publicationFailure !== undefined ||
    cleanupFailure !== undefined
  ) {
    throw new RequestCodeLocalTransitionError({
      ...(publicationFailure === undefined
        ? {}
        : { publication: publicationFailure }),
      ...(cleanupFailure === undefined ? {} : { cleanup: cleanupFailure }),
    });
  }
}

/**
 * Step 2: verify the code and establish the session, then trigger a fresh
 * catch-up sync. This is the single home for the post-login side-effects that
 * both the MCP handler and the CLI depend on:
 *   - submit code + save session
 *   - resetFailures (retry previously-failed downloads)
 *   - blocking:1 + a confirmed catch-up generation (hold data tools until caught up)
 *   - ensureDaemonRunning
 * Throws on a bad/expired code; the caller renders the error.
 */
export async function verifyCode(
  client: SanaClient,
  store: SanaStore,
  email: string,
  code: string
): Promise<LoginResult> {
  const sourceVersion = client.sessionVersion();
  let user: SanaUser;
  try {
    user = await client.submitSignInCode(email, code);
  } catch (error) {
    if (
      error instanceof SanaInputValidationError ||
      error instanceof NoPendingLoginError
    ) {
      throw new VerifyCodePreflightError(undefined, { cause: error });
    }
    throw new VerifyCodeRemoteError(error);
  }
  let confirmation: AuthConfirmation;
  try {
    confirmation = publishClientSession(
      store,
      client,
      "login",
      sourceVersion,
    );
  } catch (error) {
    if (
      error instanceof AuthPublicationBusyError ||
      error instanceof StaleSessionWriterError ||
      error instanceof AuthTransitionIncompleteError
    ) {
      throw error;
    }
    throw new VerifyCodeLocalTransitionError({ publication: error });
  }
  if (
    confirmation.userId === null ||
    confirmation.workspaceId === null
  ) {
    throw new VerifyCodeLocalTransitionError({
      publication: new Error(
        "Confirmed login publication is missing its authoritative identity",
      ),
    });
  }
  const workspaceId = confirmation.workspaceId;

  try {
    if (store.resetFailuresIfCurrent(confirmation) !== "reset") {
      throw new StaleSessionWriterError(confirmation.generation);
    }
    await ensureDaemonRunning();
    if (
      store.clearSyncUnavailableIfCurrent(confirmation) !== "cleared"
    ) {
      throw new StaleSessionWriterError(confirmation.generation);
    }
  } catch (error) {
    if (error instanceof StaleSessionWriterError) throw error;
    const cause =
      error instanceof Error && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.name
          : "UNKNOWN_SYNC_FAILURE";
    let persistence:
      | {
          code: "SYNC_STATUS_PERSISTENCE_FAILED";
          message: string;
          cause: unknown;
        }
      | undefined;
    try {
      const recorded = store.recordSyncUnavailableIfCurrent(
        confirmation,
        "LOGIN_SYNC_UNAVAILABLE",
        cause,
        errorMessage(error),
      );
      if (recorded !== "recorded") {
        throw new StaleSessionWriterError(confirmation.generation);
      }
    } catch (persistenceError) {
      if (persistenceError instanceof StaleSessionWriterError) {
        throw persistenceError;
      }
      persistence = {
        code: "SYNC_STATUS_PERSISTENCE_FAILED",
        message: errorMessage(persistenceError),
        cause: persistenceError,
      };
    }
    return {
      kind: "sync-unavailable",
      user,
      confirmation,
      workspaceId,
      failure: {
        code: "LOGIN_SYNC_UNAVAILABLE",
        message: errorMessage(error),
        cause: error,
        ...(persistence === undefined ? {} : { persistence }),
      },
    };
  }
  return {
    kind: "ready",
    user,
    confirmation,
    workspaceId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteAcceptance(error: unknown): false | "unknown" {
  if (
    error instanceof SignInChallengeRejectedError ||
    error instanceof SessionExpiredError ||
    (error instanceof SanaHttpError && error.status >= 400 && error.status < 500)
  ) {
    return false;
  }
  return "unknown";
}

export {
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  StaleSessionWriterError,
};
