// Human client configurer. Core registration and authentication APIs remain
// presentation-free; this module renders their typed results for a terminal.
import { ExitPromptError } from "@inquirer/core";
import { checkbox, confirm, input } from "@inquirer/prompts";
import path from "node:path";
import { sanitizeTerminalText, type TerminalUi } from "../app/ui.js";
import {
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  RequestCodeLocalTransitionError,
  RequestCodePreflightError,
  RequestCodeRemoteError,
  StaleSessionWriterError,
  VerifyCodeLocalTransitionError,
  VerifyCodePreflightError,
  VerifyCodeRemoteError,
  requestCode,
  verifyCode,
  type LoginResult,
} from "../core/login.js";
import { SanaClient } from "../sana/client.js";
import { inspectCurrentSession } from "../sana/session-publication.js";
import { SanaStore, type SessionVersion, type SyncState } from "../store/db.js";
import { CLIENTS, detectClient, type ClientDef } from "./clients.js";
import type { DetectionResult } from "./detect.js";
import { ConfigurerPresentation } from "./presentation.js";
import { serverTarget } from "./server-target.js";
import { registrationStatus } from "./status.js";
import {
  wizardPrompt,
  type WizardRow,
  type WizardResult,
} from "./wizard-prompt.js";
import {
  applyPlannedClientChanges,
  planClientChanges,
  validateServerName,
  type ApplyResult,
  type ConfigPathProvenance,
} from "./apply.js";
import type { ConfigurerPresentationOptions } from "./presentation.js";

export interface InstallOpts {
  dryRun?: boolean;
  yes?: boolean;
  name?: string;
}

export interface InstallerConfigMutation {
  readonly client: ClientDef;
  readonly desired: "present" | "absent";
}

export type InstallerFlowDisposition =
  | "configured"
  | "planned"
  | "no-clients"
  | "no-changes"
  | "cancelled"
  | "interaction-unavailable";

export interface InstallerFlowResult {
  readonly disposition: InstallerFlowDisposition;
  readonly authentication: "not-attempted" | "ready" | "skipped";
}

export type UninstallerFlowDisposition =
  | "completed"
  | "planned"
  | "no-registrations"
  | "no-selection"
  | "cancelled"
  | "interaction-unavailable";

export interface UninstallerFlowResult {
  readonly disposition: UninstallerFlowDisposition;
  readonly selectedCount: number;
}

export interface ConfigurerSessionInfo {
  hasCookie: boolean;
  loggedIn: boolean;
  expired: boolean;
}

export interface ConfigurerAuthObservation {
  readonly initialSessionVersion: SessionVersion;
  readonly reloadedSessionVersion: SessionVersion;
  readonly initialConfirmedVersion: SessionVersion;
  readonly confirmedVersion: SessionVersion;
  readonly initialAuthPending: number;
  readonly authPending: number;
  readonly initialTransition: Readonly<{
    pid: number | null;
    token: string | null;
    generation: number | null;
    kind: SyncState["auth_transition_kind"];
    userId: string | null;
    workspaceId: string | null;
  }>;
  readonly transition: Readonly<{
    pid: number | null;
    token: string | null;
    generation: number | null;
    kind: SyncState["auth_transition_kind"];
    userId: string | null;
    workspaceId: string | null;
  }>;
  readonly initialIssueCode: string | null;
  readonly initialIssueMessage: string | null;
  readonly issueCode: string | null;
  readonly issueMessage: string | null;
  readonly initialPhase: SyncState["phase"];
  readonly phase: SyncState["phase"];
}

export type ConfigurerAuthUnavailableReason =
  "publication" | "pending" | "issue" | "inconsistent" | "churn";

export type ConfigurerAuthState =
  | Readonly<{
      kind: "ready";
      generation: number;
      session: ConfigurerSessionInfo;
    }>
  | Readonly<{
      kind: "signed-out";
      generation: number;
      session: ConfigurerSessionInfo;
    }>
  | Readonly<{
      kind: "in-progress" | "incomplete";
      reason: ConfigurerAuthUnavailableReason;
      issueCode?: string;
      issueMessage?: string;
      observations: readonly ConfigurerAuthObservation[];
      session: ConfigurerSessionInfo;
    }>;

export interface ConfigurerAuthSession {
  inspect(): ConfigurerAuthState;
  requestCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<LoginResult>;
  close(): void;
}

export interface InstallInteraction extends ConfigurerPresentationOptions {
  promptDriver?: Partial<{
    wizard: typeof wizardPrompt;
    confirm: typeof confirm;
    input: typeof input;
    checkbox: typeof checkbox;
  }>;
  prompt?(options: {
    message: string;
    rows: WizardRow[];
    serverName: string;
    ui: TerminalUi;
  }): Promise<WizardResult>;
  isInteractiveInput?(): boolean;
  confirm?(message: string): Promise<boolean>;
  input?(message: string): Promise<string>;
  chooseClients?(
    message: string,
    clients: readonly ClientDef[],
  ): Promise<readonly string[]>;
  openAuthSession?(): ConfigurerAuthSession;
  applyBatch?(
    mutations: readonly InstallerConfigMutation[],
    options: {
      serverName: string;
      target: ReturnType<typeof serverTarget>;
    },
  ): Promise<readonly ApplyResult[]>;
  /** Installer-only phase observer for typed transaction error attribution. */
  onPhase?(
    phase:
      | "selection"
      | "applying"
      | "post-apply"
      | "authentication"
      | "post-auth-confirmed"
      | "post-auth-skipped",
  ): void;
  /** Installer-only validated target override; human/source calls omit it. */
  target?: ReturnType<typeof serverTarget>;
  clients?: readonly ClientDef[];
}

export class ClientConfigurationIncompleteError extends Error {
  readonly code = "CLIENT_CONFIGURATION_INCOMPLETE";

  constructor(
    readonly failedClients: readonly string[],
    options: { cause?: unknown } = {},
  ) {
    super(
      `Client configuration is incomplete for: ${failedClients.join(", ")}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ClientConfigurationIncompleteError";
  }
}

export class ClientAuthenticationPartialError extends Error {
  readonly code = "CLIENT_AUTHENTICATION_PARTIAL";

  constructor(
    readonly userEmail: string,
    readonly workspaceId: string,
    readonly confirmation: Extract<
      LoginResult,
      { kind: "sync-unavailable" }
    >["confirmation"],
    readonly failure: Extract<
      LoginResult,
      { kind: "sync-unavailable" }
    >["failure"],
  ) {
    super(failure.message, { cause: failure.cause });
    this.name = "ClientAuthenticationPartialError";
  }
}

export class ClientAuthenticationSessionCleanupError extends Error {
  readonly code = "CLIENT_AUTHENTICATION_SESSION_CLEANUP_FAILED";

  constructor(
    readonly outcome: LoginFlowResult | undefined,
    cause: unknown,
  ) {
    super("local authentication session cleanup failed", { cause });
    this.name = "ClientAuthenticationSessionCleanupError";
  }
}

class ClientAuthenticationSessionOpenError extends Error {
  constructor(cause: unknown) {
    super("local authentication session could not be opened", { cause });
    this.name = "ClientAuthenticationSessionOpenError";
  }
}

class UnknownThrownValueError extends Error {
  constructor(readonly observedValue: unknown) {
    const kind =
      observedValue === undefined
        ? "undefined"
        : observedValue === null
          ? "null"
          : observedValue === ""
            ? "empty string"
            : observedValue === false
              ? "boolean (false)"
              : Object.is(observedValue, 0)
                ? "number (0)"
                : typeof observedValue;
    super(`A non-Error value was thrown: ${kind}`);
    this.name = "UnknownThrownValueError";
  }
}

function normalizeCaughtValue(value: unknown): Error {
  return value instanceof Error ? value : new UnknownThrownValueError(value);
}

type MaybeLoginAuthoritativePhase =
  | "authentication"
  | "post-auth-confirmed"
  | "post-auth-skipped";

type MaybeLoginAuthDisposition =
  | "not-attempted"
  | "attempting"
  | "unconfirmed"
  | "skipped"
  | "confirmed";

class SanaSignInPromptCancelledError extends Error {
  constructor(cause: unknown) {
    super("Sana sign-in prompt was cancelled", { cause });
    this.name = "SanaSignInPromptCancelledError";
  }
}

const MAYBE_LOGIN_OUTCOME_ERROR = Symbol("MaybeLoginOutcomeError");
const MAYBE_LOGIN_SUCCESS_AUTHORITY = Symbol("MaybeLoginSuccessAuthority");

class MaybeLoginSuccessAuthority {
  readonly [MAYBE_LOGIN_SUCCESS_AUTHORITY] = true;

  constructor(
    readonly outcome: LoginFlowResult,
    readonly disposition: Extract<
      MaybeLoginAuthDisposition,
      "skipped" | "confirmed"
    >,
    readonly phase: Extract<
      MaybeLoginAuthoritativePhase,
      "post-auth-confirmed" | "post-auth-skipped"
    >,
  ) {
    const expectedDisposition =
      outcome === "skipped" ? "skipped" : "confirmed";
    const expectedPhase =
      outcome === "skipped"
        ? "post-auth-skipped"
        : "post-auth-confirmed";
    if (
      disposition !== expectedDisposition ||
      phase !== expectedPhase
    )
      throw new TypeError(
        "successful Sana authentication authority is inconsistent",
      );
  }
}

class MaybeLoginOutcomeError extends ClientConfigurationIncompleteError {
  readonly [MAYBE_LOGIN_OUTCOME_ERROR] = true;
  readonly #presentationFailures: Error[] = [];

  constructor(
    readonly details: Readonly<{
      phase: MaybeLoginAuthoritativePhase;
      disposition: MaybeLoginAuthDisposition;
      outcome?: LoginFlowResult;
      hasFlowFailure: boolean;
      flowFailure?: Error;
      cleanupFailure?: ClientAuthenticationSessionCleanupError;
      sessionOpenFailure?: ClientAuthenticationSessionOpenError;
    }>,
  ) {
    const cause =
      details.sessionOpenFailure ??
      (details.hasFlowFailure && details.cleanupFailure !== undefined
        ? new AggregateError(
            [details.flowFailure!, details.cleanupFailure],
            "Sana sign-in and local state cleanup both failed",
          )
        : details.hasFlowFailure
          ? details.flowFailure
          : details.cleanupFailure);
    super(["Sana sign-in"], cause === undefined ? {} : { cause });
    this.name = "MaybeLoginOutcomeError";
  }

  get presentationFailures(): readonly Error[] {
    return this.#presentationFailures;
  }

  recordPresentationFailure(value: unknown): void {
    this.#presentationFailures.push(normalizeCaughtValue(value));
  }
}

function postAuthPresentationError(
  authority: MaybeLoginSuccessAuthority,
  value: unknown,
): MaybeLoginOutcomeError {
  const error = new MaybeLoginOutcomeError({
    phase: authority.phase,
    disposition: authority.disposition,
    outcome: authority.outcome,
    hasFlowFailure: false,
  });
  error.recordPresentationFailure(value);
  return error;
}

export type ClientAuthenticationOperation =
  "initial-inspection" | "request-code" | "verify-code";

export class ClientAuthenticationOperationError extends Error {
  readonly code = "CLIENT_AUTHENTICATION_OPERATION_FAILED";

  constructor(
    readonly operation: ClientAuthenticationOperation,
    cause: unknown,
  ) {
    super(`Authentication operation failed: ${operation}`, { cause });
    this.name = "ClientAuthenticationOperationError";
  }
}

export class ClientAuthenticationStateUnavailableError extends Error {
  readonly code = "CLIENT_AUTHENTICATION_STATE_UNAVAILABLE";

  constructor(
    readonly state: "in-progress" | "incomplete",
    readonly reason: ConfigurerAuthUnavailableReason,
    readonly issueCode: string | undefined,
    readonly issueMessage: string | undefined,
    readonly observations: readonly ConfigurerAuthObservation[],
  ) {
    super(`Local authentication state is ${state}`);
    this.name = "ClientAuthenticationStateUnavailableError";
  }
}

export type ClientConfigurationCancellationStage =
  "client-selection" | "sana-sign-in" | "uninstall-selection";

/** Internal typed signal converted into a clean, successful CLI cancellation. */
export class ClientConfigurationCancelledError extends Error {
  readonly code = "CLIENT_CONFIGURATION_CANCELLED";

  constructor(
    readonly stage: ClientConfigurationCancellationStage,
    cause: unknown,
  ) {
    super("Client configuration was cancelled", { cause });
    this.name = "ClientConfigurationCancelledError";
  }
}

/** Handle the one expected configurer failure at the CLI process boundary. */
export function handleClientConfigurationCliError(error: unknown): boolean {
  if (!(error instanceof ClientConfigurationIncompleteError)) return false;
  process.exitCode = 1;
  return true;
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map((cause) => errorText(cause));
    return causes.length > 0
      ? `${error.message}: ${causes.join("; ")}`
      : error.message;
  }
  if (error instanceof MaybeLoginOutcomeError) {
    const details: string[] = [];
    if (error.details.sessionOpenFailure !== undefined)
      details.push(
        `${error.details.sessionOpenFailure.message}: ${errorText(error.details.sessionOpenFailure.cause)}`,
      );
    if (error.details.hasFlowFailure)
      details.push(errorText(error.details.flowFailure));
    if (error.details.cleanupFailure !== undefined)
      details.push(
        `${error.details.cleanupFailure.message}: ${errorText(error.details.cleanupFailure.cause)}`,
      );
    for (const failure of error.presentationFailures)
      details.push(`authentication failure presentation also failed: ${errorText(failure)}`);
    return details.length === 0
      ? error.message
      : `${error.message}: ${details.join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function publicationComponentText(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map((cause) =>
      publicationComponentText(cause),
    );
    return causes.length > 0 ? causes.join("; ") : error.message;
  }
  if (error instanceof AuthTransitionIncompleteError) {
    const cause =
      error.cause === undefined ? "" : `: ${errorText(error.cause)}`;
    return `the local authentication transition is incomplete (${sanitizeTerminalText(error.issueCode)})${cause}`;
  }
  if (error instanceof AuthPublicationBusyError)
    return `another local authentication transition is active in process ${error.ownerPid}`;
  if (error instanceof StaleSessionWriterError)
    return `the local session was superseded by authentication generation ${error.currentGeneration}`;
  return `local authentication publication failed: ${errorText(error)}`;
}

function publicationFailureText(
  operation: ClientAuthenticationOperation,
  error: unknown,
): string {
  if (error instanceof RequestCodeRemoteError) {
    return error.remoteAccepted === false
      ? `Sana rejected the sign-in code request: ${errorText(error.cause)}`
      : `The remote outcome of the sign-in code request is unknown: ${errorText(error.cause)}`;
  }
  if (error instanceof RequestCodePreflightError) {
    return `The sign-in code request was not sent to Sana: ${errorText(error.cause)}`;
  }
  if (error instanceof RequestCodeLocalTransitionError) {
    const storeFailure = error.failures.store;
    const publicationFailure = error.failures.publication;
    const cleanupFailure = error.failures.cleanup;
    if (
      storeFailure === undefined &&
      publicationFailure === undefined &&
      cleanupFailure !== undefined
    )
      return `Sana accepted the sign-in code request and local session publication completed, but local authentication store cleanup failed: ${errorText(cleanupFailure)}`;
    if (storeFailure !== undefined && publicationFailure === undefined)
      return `Sana accepted the sign-in code request, but local session publication could not begin because the authentication store could not be opened: ${errorText(storeFailure)}${cleanupFailure === undefined ? "" : `; local authentication store cleanup also failed: ${errorText(cleanupFailure)}`}`;
    const details: string[] =
      publicationFailure === undefined
        ? []
        : [publicationComponentText(publicationFailure)];
    if (cleanupFailure !== undefined)
      details.push(
        `local authentication store cleanup also failed: ${errorText(cleanupFailure)}`,
      );
    return details.length === 0
      ? "Sana accepted the sign-in code request, but the local transition reported no failure detail"
      : `Sana accepted the sign-in code request, but local session publication did not complete: ${details.join("; ")}`;
  }
  if (error instanceof VerifyCodeRemoteError) {
    return error.remoteAccepted === false
      ? `Sana rejected the sign-in code: ${errorText(error.cause)}`
      : `The remote outcome of submitting the sign-in code is unknown: ${errorText(error.cause)}`;
  }
  if (error instanceof VerifyCodePreflightError) {
    return `The sign-in code was not sent to Sana: ${errorText(error.cause)}`;
  }
  if (error instanceof VerifyCodeLocalTransitionError) {
    const storeFailure = error.failures.store;
    const publicationFailure = error.failures.publication;
    const syncFailure = error.failures.syncFailure;
    const cleanupFailure = error.failures.cleanup;
    const details: string[] = [];
    if (storeFailure !== undefined)
      details.push(
        `the local authentication store failed: ${errorText(storeFailure)}`,
      );
    if (publicationFailure !== undefined)
      details.push(publicationComponentText(publicationFailure));
    if (syncFailure !== undefined)
      details.push(`meeting sync failed: ${errorText(syncFailure)}`);
    if (cleanupFailure !== undefined)
      details.push(
        `local authentication store cleanup failed: ${errorText(cleanupFailure)}`,
      );
    if (storeFailure !== undefined || publicationFailure !== undefined)
      return `Sana accepted the code, but local session publication did not complete. Sign-in readiness and meeting sync were not confirmed: ${details.join("; ")}`;
    return details.length === 0
      ? "Sana accepted the code, but the local transition reported no failure detail. Sign-in readiness and meeting sync were not confirmed"
      : `Sana accepted the code and local session publication completed, but the local post-confirmation operation did not complete: ${details.join("; ")}`;
  }
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map((cause) =>
      publicationFailureText(operation, cause),
    );
    return causes.length > 0 ? causes.join("; ") : error.message;
  }
  if (error instanceof ClientAuthenticationStateUnavailableError) {
    const state =
      error.state === "in-progress" ? "still in progress" : "incomplete";
    const issue =
      error.issueCode === undefined
        ? ""
        : ` (${sanitizeTerminalText(error.issueCode)})`;
    const guidance =
      error.issueMessage === undefined
        ? ""
        : ` Guidance: ${sanitizeTerminalText(error.issueMessage)}`;
    const subject =
      error.reason === "churn"
        ? "session state changed during inspection"
        : error.reason === "inconsistent"
          ? "session and publication state are inconsistent"
          : `an authentication transition that is ${state}`;
    return `Local authentication inspection found ${subject}${issue}. Existing sign-in readiness and meeting sync were not confirmed.${guidance}`;
  }
  if (error instanceof AuthTransitionIncompleteError) {
    if (operation === "request-code") return publicationComponentText(error);
    if (operation === "verify-code")
      return `Sana accepted the code, but ${publicationComponentText(error)}. Sign-in readiness and meeting sync were not confirmed`;
    return `Local authentication inspection found ${publicationComponentText(error)}. Existing sign-in readiness and meeting sync were not confirmed`;
  }
  if (error instanceof AuthPublicationBusyError) {
    if (operation === "request-code")
      return `${publicationComponentText(error)} and prevented this request from becoming current`;
    if (operation === "verify-code")
      return `Sana accepted the code, but ${publicationComponentText(error)}. This attempt did not replace the active session, and meeting sync was not started`;
    return `Local authentication inspection found ${publicationComponentText(error)}. Existing sign-in readiness was not confirmed`;
  }
  if (error instanceof StaleSessionWriterError) {
    if (operation === "request-code") return publicationComponentText(error);
    if (operation === "verify-code")
      return `Sana accepted the code, but ${publicationComponentText(error)}. This attempt did not replace the newer session, and meeting sync was not started`;
    return `Local authentication inspection found ${publicationComponentText(error)}. Existing sign-in readiness was not confirmed`;
  }
  const detail = errorText(error);
  if (operation === "initial-inspection")
    return `Local authentication state could not be inspected: ${detail}`;
  if (operation === "request-code")
    return `A Sana sign-in code could not be requested: ${detail}`;
  return `Sana code verification could not be completed: ${detail}`;
}

function loginFailureText(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map((cause) => loginFailureText(cause));
    return causes.length > 0 ? causes.join("; ") : error.message;
  }
  if (error instanceof ClientAuthenticationPartialError) {
    const summary = error.failure.message;
    const cause = error.failure.cause;
    const detail = errorText(cause);
    const failureDetail =
      cause instanceof Error && cause.message === summary
        ? detail
        : detail === summary
          ? summary
          : `${summary}: ${detail}`;
    const persistence = error.failure.persistence;
    let persistenceDetail = "";
    if (persistence !== undefined) {
      const summary = sanitizeTerminalText(persistence.message);
      const detail = errorText(persistence.cause);
      persistenceDetail = ` The sync-unavailable status could not be persisted: ${
        persistence.cause instanceof Error &&
        persistence.cause.message === persistence.message
          ? detail
          : detail === summary
            ? summary
            : `${summary}: ${detail}`
      }`;
    }
    return `Signed in as ${error.userEmail} for workspace ${error.workspaceId}, but meeting sync is unavailable. Authentication generation ${error.confirmation.generation} is confirmed and the local meeting cache remains blocked: ${failureDetail}.${persistenceDetail}`;
  }
  if (error instanceof ClientAuthenticationSessionCleanupError) {
    const detail = errorText(error.cause);
    if (error.outcome === "signed-in")
      return `Sana sign-in succeeded, but local authentication session cleanup failed: ${detail}`;
    if (error.outcome === "already-signed-in")
      return `Sana was already signed in, but local authentication session cleanup failed: ${detail}`;
    if (error.outcome === "skipped")
      return `Sana sign-in was skipped, but local authentication session cleanup failed: ${detail}`;
    return `Local authentication session cleanup failed: ${detail}`;
  }
  if (error instanceof SanaSignInPromptCancelledError) {
    return "Sana sign-in was cancelled";
  }
  if (error instanceof ClientAuthenticationOperationError)
    return publicationFailureText(error.operation, error.cause);
  return `Sana sign-in could not be completed: ${errorText(error)}`;
}

function needsManualAction(result: ApplyResult): boolean {
  return (
    result.state === "collision" ||
    result.state === "unavailable" ||
    result.state === "conflict" ||
    result.state === "ambiguous" ||
    result.state === "failed"
  );
}

function installDisposition(
  results: readonly ApplyResult[],
  dryRun: boolean,
): InstallerFlowDisposition {
  if (dryRun && results.some((result) => result.state === "planned"))
    return "planned";
  return results.every((result) => result.state === "noop")
    ? "no-changes"
    : "configured";
}

function stopForIncompleteConfiguration(
  presentation: ConfigurerPresentation,
  failedClients: readonly string[],
): never {
  presentation.blank();
  presentation.print(
    presentation.ui.color.red("Configuration is incomplete."),
    " Review the client and config-path details above before trying again.",
  );
  throw new ClientConfigurationIncompleteError(failedClients);
}

function requireCompleteWizardResult(
  presentation: ConfigurerPresentation,
  rows: readonly WizardRow[],
  result: WizardResult,
): void {
  for (const row of rows) {
    if (
      !Object.prototype.hasOwnProperty.call(result.desired, row.id) ||
      typeof result.desired[row.id] !== "boolean"
    ) {
      presentation.blank();
      presentation.print(
        "Configuration result was incomplete; no changes were applied.",
      );
      throw new ClientConfigurationIncompleteError([
        "interactive client selection",
      ]);
    }
  }
}

function configPathDetail(result: ConfigPathProvenance): string {
  if (result.pathState === "known")
    return ` [config: ${sanitizeTerminalText(JSON.stringify(result.file))}]`;
  return ` [config path unavailable: ${sanitizeTerminalText(
    result.pathUnavailableReason,
  )}]`;
}

export function describeApplyResult(result: ApplyResult): string {
  const config = configPathDetail(result);
  switch (result.state) {
    case "applied":
      return result.warning
        ? `registered with warning: ${sanitizeTerminalText(
            result.warning,
          )}${config}`
        : `registered${config}`;
    case "planned":
      return `would register${config}`;
    case "noop":
      return `already registered (no change)${config}`;
    case "collision":
      return `blocked: ${sanitizeTerminalText(result.reason)}${config}`;
    case "unavailable":
      return `unavailable: ${sanitizeTerminalText(result.reason)}${config}`;
    case "conflict":
      return `conflict: ${sanitizeTerminalText(result.reason)}${config}`;
    case "ambiguous":
      return `outcome needs verification: ${sanitizeTerminalText(
        result.reason,
      )}${config}`;
    case "failed":
      return `failed: ${sanitizeTerminalText(result.reason)}${config}`;
  }
}

function describeRemove(result: ApplyResult): string {
  const config = configPathDetail(result);
  if (result.state === "planned") return `would remove${config}`;
  if (result.state === "applied")
    return result.warning
      ? `removed with warning: ${sanitizeTerminalText(result.warning)}${config}`
      : `removed${config}`;
  if (result.state === "noop")
    return `not registered (nothing to remove)${config}`;
  return describeApplyResult(result);
}

function applyStatus(
  result: ApplyResult,
): "ok" | "noop" | "skipped" | "failed" {
  if (result.state === "applied" || result.state === "planned") return "ok";
  if (result.state === "noop") return "noop";
  if (needsManualAction(result)) return "failed";
  return "skipped";
}

function printApplyResult(
  presentation: ConfigurerPresentation,
  client: ClientDef,
  result: ApplyResult,
  enabling: boolean,
): void {
  presentation.print(
    presentation.ui.row(
      presentation.ui.statusGlyph({ status: applyStatus(result) }, enabling),
      client.name,
      enabling ? describeApplyResult(result) : describeRemove(result),
      result.state === "applied" && client.reloadHint
        ? client.reloadHint
        : undefined,
    ),
  );
}

interface ConfigurerSessionClient {
  sessionVersion(): SessionVersion;
  hasAuthCookie(): boolean;
  pendingSignInChallenge(): Readonly<{ email: string }> | null;
}

function sameSessionVersion(
  left: SessionVersion,
  right: SessionVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.publicationToken === right.publicationToken &&
    (left.userId ?? null) === (right.userId ?? null) &&
    (left.workspaceId ?? null) === (right.workspaceId ?? null)
  );
}

function sameConfigurerSessionClient(
  left: ConfigurerSessionClient,
  right: ConfigurerSessionClient,
): boolean {
  const leftPending = left.pendingSignInChallenge();
  const rightPending = right.pendingSignInChallenge();
  return (
    sameSessionVersion(left.sessionVersion(), right.sessionVersion()) &&
    left.hasAuthCookie() === right.hasAuthCookie() &&
    leftPending?.email === rightPending?.email
  );
}

function sameAuthSnapshot(left: SyncState, right: SyncState): boolean {
  return (
    left.phase === right.phase &&
    left.auth_pending === right.auth_pending &&
    left.auth_generation === right.auth_generation &&
    left.auth_publication_token === right.auth_publication_token &&
    left.auth_user_id === right.auth_user_id &&
    left.auth_workspace_id === right.auth_workspace_id &&
    left.auth_transition_pid === right.auth_transition_pid &&
    left.auth_transition_token === right.auth_transition_token &&
    left.auth_transition_generation === right.auth_transition_generation &&
    left.auth_transition_kind === right.auth_transition_kind &&
    left.auth_transition_user_id === right.auth_transition_user_id &&
    left.auth_transition_workspace_id === right.auth_transition_workspace_id &&
    left.auth_issue_code === right.auth_issue_code &&
    left.auth_issue_message === right.auth_issue_message
  );
}

function authObservation(
  initialVersion: SessionVersion,
  reloadedClient: ConfigurerSessionClient,
  initialSync: SyncState,
  reloadedSync: SyncState,
): ConfigurerAuthObservation {
  const transition = (sync: SyncState) => ({
    pid: sync.auth_transition_pid,
    token: sync.auth_transition_token,
    generation: sync.auth_transition_generation,
    kind: sync.auth_transition_kind,
    userId: sync.auth_transition_user_id,
    workspaceId: sync.auth_transition_workspace_id,
  });
  return {
    initialSessionVersion: initialVersion,
    reloadedSessionVersion: reloadedClient.sessionVersion(),
    initialConfirmedVersion: {
      generation: initialSync.auth_generation,
      publicationToken: initialSync.auth_publication_token,
      userId: initialSync.auth_user_id,
      workspaceId: initialSync.auth_workspace_id,
    },
    confirmedVersion: {
      generation: reloadedSync.auth_generation,
      publicationToken: reloadedSync.auth_publication_token,
      userId: reloadedSync.auth_user_id,
      workspaceId: reloadedSync.auth_workspace_id,
    },
    initialAuthPending: initialSync.auth_pending,
    authPending: reloadedSync.auth_pending,
    initialTransition: transition(initialSync),
    transition: transition(reloadedSync),
    initialIssueCode: initialSync.auth_issue_code,
    initialIssueMessage: initialSync.auth_issue_message,
    issueCode: reloadedSync.auth_issue_code,
    issueMessage: reloadedSync.auth_issue_message,
    initialPhase: initialSync.phase,
    phase: reloadedSync.phase,
  };
}

function configurerSessionInfo(
  client: ConfigurerSessionClient,
  sync: SyncState,
): ConfigurerSessionInfo {
  const hasCookie = client.hasAuthCookie();
  const hasPendingChallenge =
    client.pendingSignInChallenge() !== null;
  const expired =
    hasCookie && !hasPendingChallenge && sync.phase === "needs_login";
  return {
    hasCookie,
    loggedIn: hasCookie && !hasPendingChallenge && !expired,
    expired,
  };
}

function unavailableAuthState(
  options: {
    kind: "in-progress" | "incomplete";
    reason: ConfigurerAuthUnavailableReason;
    issueCode?: string;
    issueMessage?: string;
  },
  observations: readonly ConfigurerAuthObservation[],
  session: ConfigurerSessionInfo,
): ConfigurerAuthState {
  return {
    kind: options.kind,
    reason: options.reason,
    ...(options.issueCode === undefined
      ? {}
      : { issueCode: options.issueCode }),
    ...(options.issueMessage === undefined
      ? {}
      : { issueMessage: options.issueMessage }),
    observations,
    session,
  };
}

export function inspectStableConfigurerAuthState<
  Client extends ConfigurerSessionClient,
>(
  store: Pick<SanaStore, "getSyncState" | "reconcileAuthState">,
  loadClient: () => Client,
  attempts = 3,
): Readonly<{ state: ConfigurerAuthState; client: Client }> {
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new RangeError("authentication inspection attempts must be positive");

  const observations: ConfigurerAuthObservation[] = [];
  let latestClient: Client | undefined;
  let latestSync: SyncState | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = loadClient();
    const beforeVersion = before.sessionVersion();
    const publication = inspectCurrentSession(store, before);
    const firstSync = store.getSyncState();
    const after = loadClient();
    const afterVersion = after.sessionVersion();
    const secondSync = store.getSyncState();
    latestClient = after;
    latestSync = secondSync;
    observations.push(
      authObservation(beforeVersion, after, firstSync, secondSync),
    );

    if (
      !sameConfigurerSessionClient(before, after) ||
      !sameAuthSnapshot(firstSync, secondSync)
    )
      continue;

    const session = configurerSessionInfo(after, secondSync);
    if (publication.kind === "incomplete") {
      return {
        state: unavailableAuthState(
          {
            kind:
              publication.code === "AUTH_PUBLICATION_IN_PROGRESS"
                ? "in-progress"
                : "incomplete",
            reason: "publication",
            issueCode: publication.code,
            issueMessage: publication.message,
          },
          observations,
          session,
        ),
        client: after,
      };
    }

    const transitionValues = [
      secondSync.auth_transition_pid,
      secondSync.auth_transition_token,
      secondSync.auth_transition_generation,
      secondSync.auth_transition_kind,
      secondSync.auth_transition_user_id,
      secondSync.auth_transition_workspace_id,
    ];
    const transitionCount = transitionValues.filter(
      (value) => value !== null,
    ).length;
    const issueCount = [
      secondSync.auth_issue_code,
      secondSync.auth_issue_message,
    ].filter((value) => value !== null).length;
    const confirmedTupleValid =
      (secondSync.auth_generation === 0 &&
        secondSync.auth_publication_token === null &&
        secondSync.auth_user_id === null &&
        secondSync.auth_workspace_id === null) ||
      (Number.isSafeInteger(secondSync.auth_generation) &&
        secondSync.auth_generation > 0 &&
        secondSync.auth_publication_token !== null &&
        ((secondSync.auth_user_id === null &&
          secondSync.auth_workspace_id === null) ||
          (secondSync.auth_user_id !== null &&
            secondSync.auth_user_id.trim() !== "" &&
            secondSync.auth_workspace_id !== null &&
            secondSync.auth_workspace_id.trim() !== "")));
    const exactConfirmedVersion = sameSessionVersion(afterVersion, {
      generation: secondSync.auth_generation,
      publicationToken: secondSync.auth_publication_token,
      userId: secondSync.auth_user_id,
      workspaceId: secondSync.auth_workspace_id,
    });
    const readyIdentityAvailable =
      !session.loggedIn ||
      (secondSync.auth_user_id !== null &&
        secondSync.auth_workspace_id !== null);

    if (
      transitionCount !== 0 ||
      issueCount !== 0 ||
      secondSync.auth_pending !== 0 ||
      !confirmedTupleValid ||
      !exactConfirmedVersion ||
      !readyIdentityAvailable
    ) {
      const inconsistent =
        (transitionCount !== 0 &&
          transitionCount !== transitionValues.length) ||
        issueCount === 1 ||
        (secondSync.auth_pending !== 0 && secondSync.auth_pending !== 1) ||
        !confirmedTupleValid ||
        !exactConfirmedVersion ||
        !readyIdentityAvailable;
      return {
        state: unavailableAuthState(
          {
            kind:
              transitionCount === transitionValues.length
                ? "in-progress"
                : "incomplete",
            reason: inconsistent
              ? "inconsistent"
              : transitionCount !== 0
                ? "publication"
                : issueCount !== 0
                  ? "issue"
                  : "pending",
            ...(secondSync.auth_issue_code === null
              ? {}
              : { issueCode: secondSync.auth_issue_code }),
            ...(secondSync.auth_issue_message === null
              ? {}
              : { issueMessage: secondSync.auth_issue_message }),
          },
          observations,
          session,
        ),
        client: after,
      };
    }

    return {
      state: session.loggedIn
        ? {
            kind: "ready",
            generation: publication.generation,
            session,
          }
        : {
            kind: "signed-out",
            generation: publication.generation,
            session,
          },
      client: after,
    };
  }

  if (latestClient === undefined || latestSync === undefined)
    throw new Error("authentication inspection produced no observation");
  return {
    state: unavailableAuthState(
      { kind: "incomplete", reason: "churn" },
      observations,
      configurerSessionInfo(latestClient, latestSync),
    ),
    client: latestClient,
  };
}

function createAuthSession(): ConfigurerAuthSession {
  let client = SanaClient.load();
  const store = new SanaStore();
  return {
    inspect: () => {
      const inspected = inspectStableConfigurerAuthState(store, () =>
        SanaClient.load(),
      );
      client = inspected.client;
      return inspected.state;
    },
    requestCode: async (email) => await requestCode(client, email),
    verifyCode: async (email, code) =>
      await verifyCode(client, store, email, code),
    close: () => store.close(),
  };
}

function presentationFor(
  interaction: InstallInteraction,
): ConfigurerPresentation {
  return new ConfigurerPresentation({
    ...(interaction.terminal ? { terminal: interaction.terminal } : {}),
    ...(interaction.writeLine ? { writeLine: interaction.writeLine } : {}),
  });
}

function isInteractive(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
): boolean {
  return interaction.isInteractiveInput?.() ?? presentation.policy.interactive;
}

/**
 * Show a brief, live-updating sync-progress display after login so the user
 * knows their meetings are syncing and can safely close the terminal.
 * Polls for up to ~12 seconds; prints a "you can close" message if still
 * syncing, or a "sync complete" message if it finishes in that window.
 */
async function showSyncProgress(
  presentation: ConfigurerPresentation,
): Promise<void> {
  const ui = presentation.ui;
  const stream = process.stderr;
  const maxWaitMs = 12_000;
  const startedAt = Date.now();

  let runtime: { refresh(): void; status(...args: unknown[]): unknown; close(): void } | undefined;
  try {
    const mod = await import("../app/runtime.js");
    runtime = new mod.LocalAppRuntime();
  } catch {
    return;
  }
  if (!runtime) return;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const s = (v: unknown): string => (typeof v === "number" ? String(v) : "?");

  try {
    stream.write("\n");
    for (;;) {
      runtime.refresh();
      const status = runtime.status() as Record<string, unknown>;
      const elapsed = Date.now() - startedAt;

      if (status.phase === "synced" || !status.blocking) {
        stream.write("\r\u001b[K");
        presentation.print(ui.color.green("✔ "), "Meeting sync complete.");
        presentation.print(
          ui.color.dim("Run "),
          ui.color.cyan("sana-mcp"),
          ui.color.dim(
            " to browse your meetings and transcripts, or use the meeting_transcripts tool from any registered AI client.",
          ),
        );
        return;
      }

      const done = s(status.transcriptsDone);
      const total = s(status.transcriptsTotal);
      const eta = status.etaMinutes ? ` ~${status.etaMinutes} min` : "";
      const dots = ".".repeat(Math.floor(elapsed / 1000) % 3 + 1);
      stream.write(
        `\r${ui.color.dim("Syncing")} ${done}/${total} transcripts${eta}${dots}   `,
      );

      if (elapsed >= maxWaitMs) {
        stream.write("\r\u001b[K");
        presentation.print(`Syncing ${done}/${total} transcripts${eta}…`);
        presentation.blank();
        presentation.print(
          ui.color.dim(
            "You can close this window or press Ctrl+C — the sync continues in the background.",
          ),
        );
        presentation.print(
          ui.color.dim("Run "),
          ui.color.cyan("sana-mcp status"),
          ui.color.dim(" to check progress at any time."),
        );
        return;
      }

      await sleep(1000);
    }
  } finally {
    runtime.close();
  }
}

async function promptWizard(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
  options: {
    message: string;
    rows: WizardRow[];
    serverName: string;
    ui: TerminalUi;
  },
): Promise<WizardResult> {
  try {
    return interaction.prompt
      ? await interaction.prompt(options)
      : await (interaction.promptDriver?.wizard ?? wizardPrompt)(
          options,
          presentation.promptContext(),
        );
  } catch (error) {
    throw normalizePromptCancellation(error, "client-selection");
  }
}

async function promptConfirm(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
  message: string,
): Promise<boolean> {
  const safe = presentation.ui.text(message).text;
  try {
    return interaction.confirm
      ? await interaction.confirm(safe)
      : await (interaction.promptDriver?.confirm ?? confirm)(
          {
            message: safe,
            default: true,
            theme: presentation.promptTheme(),
          },
          presentation.promptContext(),
        );
  } catch (error) {
    throw normalizePromptCancellation(error, "sana-sign-in");
  }
}

async function promptInput(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
  message: string,
): Promise<string> {
  const safe = presentation.ui.text(message).text;
  try {
    return interaction.input
      ? await interaction.input(safe)
      : await (interaction.promptDriver?.input ?? input)(
          { message: safe, theme: presentation.promptTheme() },
          presentation.promptContext(),
        );
  } catch (error) {
    throw normalizePromptCancellation(error, "sana-sign-in");
  }
}

function normalizePromptCancellation(
  error: unknown,
  stage: ClientConfigurationCancellationStage,
): unknown {
  if (
    error instanceof ExitPromptError ||
    (error instanceof Error && error.name === "ExitPromptError")
  )
    return stage === "sana-sign-in"
      ? new SanaSignInPromptCancelledError(error)
      : new ClientConfigurationCancelledError(stage, error);
  return error;
}

async function applyDirectMutations(
  mutations: readonly InstallerConfigMutation[],
  name: string,
  entry: ReturnType<typeof serverTarget>,
  dryRun: boolean,
): Promise<readonly ApplyResult[]> {
  const changes = await planClientChanges(
    mutations.map(({ client, desired }) => ({
      client,
      serverName: name,
      target: entry,
      desired,
    })),
  );
  return await applyPlannedClientChanges(changes, { dryRun });
}

function pathProvenance(client: ClientDef): ConfigPathProvenance {
  try {
    const resolution = client.install.path();
    return resolution.state === "available"
      ? { pathState: "known", file: resolution.path }
      : {
          pathState: "unavailable",
          pathUnavailableReason: resolution.reason,
        };
  } catch (error) {
    return {
      pathState: "unavailable",
      pathUnavailableReason: `client config path resolution failed: ${errorText(
        error,
      )}`,
    };
  }
}

function printUnavailableDetection(
  presentation: ConfigurerPresentation,
  client: ClientDef,
  reason: string,
): void {
  presentation.print(
    presentation.ui.row(
      presentation.ui.statusGlyph({ status: "skipped" }),
      client.name,
      `detection unavailable: ${sanitizeTerminalText(
        reason,
      )}${configPathDetail(pathProvenance(client))}`,
    ),
  );
}

interface InteractiveClients {
  rows: WizardRow[];
  actionable: ClientDef[];
  currentById: Map<string, boolean>;
  blockedClients: string[];
  discoveryIssues: string[];
}

async function collectInteractiveClients(
  detections: readonly {
    client: ClientDef;
    detection: DetectionResult;
  }[],
  presentation: ConfigurerPresentation,
  serverName: string,
  entry: ReturnType<typeof serverTarget>,
): Promise<InteractiveClients> {
  const rows: WizardRow[] = [];
  const actionable: ClientDef[] = [];
  const currentById = new Map<string, boolean>();
  const blockedClients: string[] = [];
  const discoveryIssues: string[] = [];

  for (const { client, detection } of detections) {
    const status = await registrationStatus(client, serverName, entry);
    if (detection.state === "unavailable" && status.state !== "owned")
      printUnavailableDetection(presentation, client, detection.reason);

    if (status.state === "foreign" || status.state === "unavailable") {
      presentation.print(
        presentation.ui.row(
          presentation.ui.statusGlyph({ status: "failed" }),
          client.name,
          `configuration unavailable: ${sanitizeTerminalText(
            status.reason,
          )}${configPathDetail(status)}`,
        ),
      );
      if (detection.state === "present") blockedClients.push(client.name);
      else discoveryIssues.push(client.name);
      continue;
    }

    const current = status.state === "owned";
    // An unavailable detector cannot disprove an exact owned registration.
    // Authoritative absence remains nonactionable until presence is known.
    if (detection.state === "unavailable" && !current) continue;
    currentById.set(client.id, current);
    actionable.push(client);
    rows.push({
      id: client.id,
      name: client.name,
      // Existing registrations remain visible even if executable detection is
      // absent so users can disconnect them without revealing hidden rows.
      detected: detection.state === "present" || current,
      current,
      hint: client.reloadHint,
    });
  }

  return {
    rows,
    actionable,
    currentById,
    blockedClients,
    discoveryIssues,
  };
}

type LoginFlowResult = "already-signed-in" | "signed-in" | "skipped";

async function runStructuredLogin(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
  auth: ConfigurerAuthSession,
  setDisposition: (disposition: MaybeLoginAuthDisposition) => void,
): Promise<LoginFlowResult> {
  let current: ConfigurerAuthState;
  try {
    current = auth.inspect();
  } catch (error) {
    throw new ClientAuthenticationOperationError("initial-inspection", error);
  }
  if (current.kind === "in-progress" || current.kind === "incomplete") {
    throw new ClientAuthenticationOperationError(
      "initial-inspection",
      new ClientAuthenticationStateUnavailableError(
        current.kind,
        current.reason,
        current.issueCode,
        current.issueMessage,
        current.observations,
      ),
    );
  }
  if (current.kind === "ready") {
    setDisposition("confirmed");
    interaction.onPhase?.("post-auth-confirmed");
    presentation.blank();
    presentation.print(presentation.ui.color.dim("Already signed in to Sana."));
    return "already-signed-in";
  }

  const wantsLogin = await promptConfirm(
    interaction,
    presentation,
    "Sign in to Sana now?",
  );
  if (!wantsLogin) {
    setDisposition("skipped");
    interaction.onPhase?.("post-auth-skipped");
    presentation.print(
      presentation.ui.color.dim(
        "Sign-in skipped. Run sana-mcp login when you are ready.",
      ),
    );
    return "skipped";
  }

  const email = (
    await promptInput(interaction, presentation, "Email for your Sana account:")
  ).trim();
  if (!email) {
    setDisposition("skipped");
    interaction.onPhase?.("post-auth-skipped");
    presentation.print(
      presentation.ui.color.dim(
        "No email entered. Run sana-mcp login when you are ready.",
      ),
    );
    return "skipped";
  }

  try {
    await auth.requestCode(email);
  } catch (error) {
    throw new ClientAuthenticationOperationError("request-code", error);
  }
  presentation.print("We emailed a 6-digit sign-in code to ", email, ".");
  const code = (
    await promptInput(interaction, presentation, "Enter the 6-digit code:")
  ).trim();
  if (!/^[0-9]{6}$/u.test(code)) {
    throw new Error("the sign-in code must contain exactly 6 digits");
  }

  let result: LoginResult;
  try {
    result = await auth.verifyCode(email, code);
  } catch (error) {
    throw new ClientAuthenticationOperationError("verify-code", error);
  }
  setDisposition("confirmed");
  if (result.kind === "sync-unavailable")
    throw new ClientAuthenticationPartialError(
      result.user.email,
      result.workspaceId,
      result.confirmation,
      result.failure,
    );
  interaction.onPhase?.("post-auth-confirmed");
  presentation.print("Signed in as ", result.user.email, ".");
  presentation.print(
    presentation.ui.color.dim(
      "Your meetings are syncing. Run sana-mcp status to check progress.",
    ),
  );
  return "signed-in";
}

async function maybeLogin(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
): Promise<MaybeLoginSuccessAuthority> {
  let authoritativePhase: MaybeLoginAuthoritativePhase = "authentication";
  let authDisposition: MaybeLoginAuthDisposition = "not-attempted";
  const loginInteraction: InstallInteraction = {
    ...interaction,
    onPhase: (phase) => {
      if (
        phase === "authentication" ||
        phase === "post-auth-confirmed" ||
        phase === "post-auth-skipped"
      )
        authoritativePhase = phase;
      interaction.onPhase?.(phase);
    },
  };
  let auth: ConfigurerAuthSession;
  try {
    auth = (interaction.openAuthSession ?? createAuthSession)();
  } catch (value) {
    const sessionOpenFailure = new ClientAuthenticationSessionOpenError(
      normalizeCaughtValue(value),
    );
    const authority = new MaybeLoginOutcomeError({
      phase: authoritativePhase,
      disposition: authDisposition,
      hasFlowFailure: false,
      sessionOpenFailure,
    });
    try {
      presentation.blank();
      presentation.print(
        presentation.ui.color.red("Sana sign-in is unavailable: "),
        errorText(sessionOpenFailure.cause),
      );
    } catch (presentationFailure) {
      authority.recordPresentationFailure(presentationFailure);
    }
    throw authority;
  }
  authDisposition = "attempting";

  let outcome: LoginFlowResult | undefined;
  let hasFlowFailure = false;
  let flowFailure: Error | undefined;
  try {
    outcome = await runStructuredLogin(
      loginInteraction,
      presentation,
      auth,
      (disposition) => {
        authDisposition = disposition;
      },
    );
  } catch (value) {
    hasFlowFailure = true;
    flowFailure = normalizeCaughtValue(value);
    const observedDisposition =
      authDisposition as MaybeLoginAuthDisposition;
    if (flowFailure instanceof SanaSignInPromptCancelledError)
      authDisposition = "skipped";
    else if (
      observedDisposition !== "confirmed" &&
      observedDisposition !== "skipped"
    )
      authDisposition = "unconfirmed";
  }
  let cleanupFailure: ClientAuthenticationSessionCleanupError | undefined;
  try {
    auth.close();
  } catch (value) {
    cleanupFailure = new ClientAuthenticationSessionCleanupError(
      outcome,
      normalizeCaughtValue(value),
    );
  }
  const failure =
    hasFlowFailure && cleanupFailure
      ? new AggregateError(
          [flowFailure!, cleanupFailure],
          "Sana sign-in and local state cleanup both failed",
        )
      : hasFlowFailure
        ? flowFailure!
        : cleanupFailure;
  if (failure !== undefined) {
    if (
      failure instanceof SanaSignInPromptCancelledError &&
      cleanupFailure === undefined
    )
      throw failure;
    const authority = new MaybeLoginOutcomeError({
      phase: authoritativePhase,
      disposition: authDisposition,
      outcome,
      hasFlowFailure,
      flowFailure,
      cleanupFailure,
    });
    try {
      presentation.blank();
      presentation.print(
        presentation.ui.color.red("Sana setup is incomplete: "),
        loginFailureText(failure),
      );
    } catch (presentationFailure) {
      authority.recordPresentationFailure(presentationFailure);
    }
    throw authority;
  }
  const finalDisposition = authDisposition as MaybeLoginAuthDisposition;
  const finalPhase = authoritativePhase as MaybeLoginAuthoritativePhase;
  if (
    outcome === undefined ||
    (finalDisposition !== "confirmed" && finalDisposition !== "skipped") ||
    (finalPhase !== "post-auth-confirmed" &&
      finalPhase !== "post-auth-skipped")
  )
    throw new TypeError(
      "successful Sana authentication flow returned incomplete authority",
    );
  return new MaybeLoginSuccessAuthority(
    outcome,
    finalDisposition,
    finalPhase,
  );
}

/**
 * Configure MCP clients and, for interactive non-dry-run use, offer structured
 * Sana authentication. `--yes` remains unattended and targets detected clients.
 */
export async function runInstall(
  opts: InstallOpts = {},
  interaction: InstallInteraction = {},
): Promise<InstallerFlowResult> {
  const presentation = presentationFor(interaction);
  const clients = interaction.clients ?? CLIENTS;
  const serverName = opts.name ?? "sana-mcp";
  validateServerName(serverName);
  const entry = interaction.target ?? serverTarget();
  const dryRun = opts.dryRun === true;
  const configuredBatch = interaction.applyBatch;
  const writableBatch = dryRun ? undefined : configuredBatch;
  interaction.onPhase?.("selection");

  if (dryRun) {
    presentation.print(
      "Dry run: client configs will remain read-only and Sana sign-in will not be attempted.",
    );
    presentation.blank();
  }

  const detections = clients.map((client) => ({
    client,
    detection: detectClient(client),
  }));
  const detected = detections
    .filter(({ detection }) => detection.state === "present")
    .map(({ client }) => client);
  const unavailable = detections.filter(
    ({ detection }) => detection.state === "unavailable",
  );

  if (opts.yes) {
    if (configuredBatch) {
      const inspected = detected.length === 0 ? clients : detected;
      const mutations: InstallerConfigMutation[] = [];
      const failedClients: string[] = [];
      for (const client of inspected) {
        const status = await registrationStatus(client, serverName, entry);
        if (status.state === "foreign" || status.state === "unavailable") {
          failedClients.push(client.name);
          continue;
        }
        if (
          status.state === "owned" ||
          detected.some((candidate) => candidate.id === client.id)
        )
          mutations.push({ client, desired: "present" });
      }
      if (failedClients.length > 0)
        throw new ClientConfigurationIncompleteError(failedClients);
      if (mutations.length === 0) {
        presentation.print("No supported AI clients detected.");
        return {
          disposition: "no-clients",
          authentication: "not-attempted",
        };
      }
      presentation.print(
        presentation.ui.color.bold(
          `Registering sana-mcp with ${mutations.length} detected or already configured client(s):`,
        ),
      );
      let results: readonly ApplyResult[];
      if (writableBatch) {
        interaction.onPhase?.("applying");
        results = await writableBatch(mutations, {
          serverName,
          target: entry,
        });
        interaction.onPhase?.("post-apply");
      } else {
        results = await applyDirectMutations(
          mutations,
          serverName,
          entry,
          true,
        );
      }
      if (writableBatch)
        await validateBatchResultProvenance(
          mutations,
          results,
          serverName,
          entry,
        );
      const incomplete: string[] = [];
      mutations.forEach(({ client }, index) => {
        const result = results[index]!;
        printApplyResult(presentation, client, result, true);
        if (needsManualAction(result)) incomplete.push(client.name);
      });
      if (incomplete.length > 0)
        stopForIncompleteConfiguration(presentation, incomplete);
      presentation.blank();
      presentation.print(
        dryRun
          ? "Dry run complete. No files were changed and Sana sign-in was not attempted."
          : "Client configuration complete. Run sana-mcp anytime to change it or sign in.",
      );
      return {
        disposition: installDisposition(results, dryRun),
        authentication: "not-attempted",
      };
    }
    if (detected.length === 0) {
      presentation.print("No supported AI clients detected.");
      for (const { client, detection } of unavailable)
        if (detection.state === "unavailable")
          printUnavailableDetection(presentation, client, detection.reason);
      return { disposition: "no-clients", authentication: "not-attempted" };
    }

    presentation.print(
      presentation.ui.color.bold(
        `Registering sana-mcp with ${detected.length} detected client(s):`,
      ),
    );
    const results = await applyDirectMutations(
      detected.map((client) => ({ client, desired: "present" })),
      serverName,
      entry,
      dryRun,
    );
    const failedClients: string[] = [];
    detected.forEach((client, index) => {
      const result = results[index]!;
      printApplyResult(presentation, client, result, true);
      if (needsManualAction(result)) failedClients.push(client.name);
    });
    for (const { client, detection } of unavailable)
      if (detection.state === "unavailable")
        printUnavailableDetection(presentation, client, detection.reason);

    if (failedClients.length > 0)
      stopForIncompleteConfiguration(presentation, failedClients);
    presentation.blank();
    presentation.print(
      dryRun
        ? "Dry run complete. No files were changed and Sana sign-in was not attempted."
        : "Client configuration complete. Run sana-mcp anytime to change it or sign in.",
    );
    return {
      disposition: installDisposition(results, dryRun),
      authentication: "not-attempted",
    };
  }

  const collected = await collectInteractiveClients(
    detections,
    presentation,
    serverName,
    entry,
  );
  if (collected.blockedClients.length > 0)
    stopForIncompleteConfiguration(presentation, [
      ...new Set(collected.blockedClients),
    ]);
  if (collected.rows.length === 0) {
    presentation.print(
      "No safely configurable supported clients are available.",
    );
    const discoveryFailures = [...collected.discoveryIssues];
    if (discoveryFailures.length > 0)
      stopForIncompleteConfiguration(presentation, [
        ...new Set(discoveryFailures),
      ]);
    return { disposition: "no-clients", authentication: "not-attempted" };
  }

  if (!isInteractive(interaction, presentation)) {
    presentation.print(
      "An interactive terminal is required to choose clients. Use sana-mcp install --yes to register every detected client.",
    );
    return {
      disposition: "interaction-unavailable",
      authentication: "not-attempted",
    };
  }

  let selection: WizardResult;
  try {
    selection = await promptWizard(interaction, presentation, {
      message: "Configure sana-mcp for your AI clients",
      rows: collected.rows,
      serverName,
      ui: presentation.ui,
    });
  } catch (error) {
    if (!(error instanceof ClientConfigurationCancelledError)) throw error;
    presentation.blank();
    presentation.print("Cancelled; no changes were made.");
    return { disposition: "cancelled", authentication: "not-attempted" };
  }
  if (!selection.submitted) {
    presentation.blank();
    presentation.print("Cancelled; no changes were made.");
    return { disposition: "cancelled", authentication: "not-attempted" };
  }
  requireCompleteWizardResult(presentation, collected.rows, selection);

  const acted: ClientDef[] = [];
  let results: readonly ApplyResult[] = [];
  const mutations: InstallerConfigMutation[] = [];
  for (const client of collected.actionable) {
    const desired = selection.desired[client.id];
    const current = collected.currentById.get(client.id);
    if (desired === undefined || current === undefined) {
      collected.blockedClients.push(client.name);
      break;
    }
    if (writableBatch) {
      acted.push(client);
      mutations.push({
        client,
        desired: desired ? "present" : "absent",
      });
    } else if (desired) {
      acted.push(client);
      mutations.push({ client, desired: "present" });
    } else if (current) {
      acted.push(client);
      mutations.push({ client, desired: "absent" });
    }
  }
  if (mutations.length > 0) {
    if (writableBatch) {
      interaction.onPhase?.("applying");
      results = await writableBatch(mutations, {
        serverName,
        target: entry,
      });
      await validateBatchResultProvenance(
        mutations,
        results,
        serverName,
        entry,
      );
      interaction.onPhase?.("post-apply");
    } else {
      results = await applyDirectMutations(
        mutations,
        serverName,
        entry,
        dryRun,
      );
    }
  }

  presentation.blank();
  if (acted.length === 0) {
    presentation.print("No client configuration changes selected.");
  } else {
    acted.forEach((client, index) => {
      const result = results[index]!;
      printApplyResult(
        presentation,
        client,
        result,
        selection.desired[client.id] === true,
      );
    });
  }

  const failedClients = [
    ...collected.blockedClients,
    ...results.filter(needsManualAction).map((result) => result.clientName),
  ];
  if (failedClients.length > 0)
    stopForIncompleteConfiguration(presentation, [...new Set(failedClients)]);

  if (dryRun) {
    presentation.blank();
    presentation.print(
      "Dry run complete. No files were changed and Sana sign-in was not attempted.",
    );
    return {
      disposition: installDisposition(results, true),
      authentication: "not-attempted",
    };
  }

  let login: MaybeLoginSuccessAuthority;
  try {
    interaction.onPhase?.("authentication");
    login = await maybeLogin(interaction, presentation);
  } catch (error) {
    if (!(error instanceof SanaSignInPromptCancelledError)) throw error;
    const cancellationAuthority = new MaybeLoginSuccessAuthority(
      "skipped",
      "skipped",
      "post-auth-skipped",
    );
    try {
      interaction.onPhase?.("post-auth-skipped");
      presentation.blank();
      presentation.print(
        "Sana sign-in cancelled. Client configuration changes were kept.",
      );
    } catch (presentationFailure) {
      throw postAuthPresentationError(
        cancellationAuthority,
        presentationFailure,
      );
    }
    return {
      disposition:
        acted.length === 0 || results.every((item) => item.state === "noop")
          ? "no-changes"
          : "configured",
      authentication: "skipped",
    };
  }
  try {
    presentation.blank();
    if (login.outcome === "skipped") {
      presentation.print("Client configuration complete. Sana sign-in was skipped.");
    } else {
      presentation.print("Client configuration and Sana sign-in are ready.");
      await showSyncProgress(presentation);
    }
  } catch (presentationFailure) {
    throw postAuthPresentationError(login, presentationFailure);
  }
  return {
    disposition:
      acted.length === 0 || results.every((item) => item.state === "noop")
        ? "no-changes"
        : "configured",
    authentication: login.outcome === "skipped" ? "skipped" : "ready",
  };
}

class InstallerBatchApplyError extends Error {
  constructor(
    readonly result: import("./config-transaction.js").ConfigTransactionResult,
  ) {
    super(result.message ?? "client configuration transaction failed");
    this.name = "InstallerBatchApplyError";
  }
}

class InstallerTransactionInvariantError extends Error {
  readonly code = "CONFIG_TRANSACTION_INVARIANT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "InstallerTransactionInvariantError";
  }
}

async function validateBatchResultProvenance(
  mutations: readonly InstallerConfigMutation[],
  results: readonly ApplyResult[],
  serverName: string,
  target: ReturnType<typeof serverTarget>,
): Promise<void> {
  if (results.length !== mutations.length)
    throw new InstallerTransactionInvariantError(
      "config transaction result cardinality does not match the submitted batch",
    );
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index]!;
    const result = results[index]!;
    let resolved: ReturnType<ClientDef["install"]["path"]>;
    try {
      resolved = mutation.client.install.path();
    } catch (error) {
      throw new InstallerTransactionInvariantError(
        `${mutation.client.name}: config path could not be revalidated: ${errorText(error)}`,
      );
    }
    const expectedOperation =
      mutation.desired === "present" ? "register" : "remove";
    if (
      resolved.state !== "available" ||
      !path.isAbsolute(resolved.path) ||
      path.normalize(resolved.path) !== resolved.path ||
      result.pathState !== "known" ||
      result.file !== resolved.path ||
      result.clientId !== mutation.client.id ||
      result.clientName !== mutation.client.name ||
      result.serverName !== serverName ||
      result.desired !== mutation.desired ||
      result.operation !== expectedOperation ||
      (result.state !== "applied" && result.state !== "noop")
    )
      throw new InstallerTransactionInvariantError(
        `${mutation.client.name}: config transaction result provenance is invalid`,
      );
    const status = await registrationStatus(
      mutation.client,
      serverName,
      target,
    );
    if (
      (mutation.desired === "present" && status.state !== "owned") ||
      (mutation.desired === "absent" && status.state !== "absent")
    )
      throw new InstallerTransactionInvariantError(
        `${mutation.client.name}: committed config does not match the requested server target`,
      );
  }
}

/**
 * Installer-only adapter: reuse the exact human selection/login flow while
 * committing every selected config change through one journaled batch.
 */
export async function runInstallerConfigTransaction(
  options: {
    journalDirectory: string;
    serverCommand: string;
    yes?: boolean;
  },
  interaction: InstallInteraction = {},
): Promise<import("./config-transaction.js").ConfigTransactionResult> {
  const {
    applyConfigTransaction,
    CONFIG_TRANSACTION_PROTOCOL,
    noMutationConfigTransactionResult,
    preflightConfigTransaction,
    rollbackConfigTransaction,
  } = await import("./config-transaction.js");
  type InstallerPhase =
    | "preflight"
    | "selection"
    | "applying"
    | "post-apply"
    | "authentication"
    | "post-auth-confirmed"
    | "post-auth-skipped";
  const phase: { current: InstallerPhase } = { current: "preflight" };
  let applied:
    import("./config-transaction.js").ConfigTransactionResult | undefined;
  try {
    const preflight = preflightConfigTransaction({
      journalDirectory: options.journalDirectory,
      serverCommand: options.serverCommand,
    });
    const flow = await runInstall(
      { yes: options.yes },
      {
        ...interaction,
        target: preflight.serverTarget,
        onPhase: (next) => {
          phase.current = next;
          interaction.onPhase?.(next);
        },
        applyBatch: async (mutations) => {
          applied = await applyConfigTransaction({
            journalDirectory: options.journalDirectory,
            serverCommand: options.serverCommand,
            mutations,
            preflight,
          });
          if (
            applied.outcome !== "applied" &&
            applied.outcome !== "no-mutation"
          )
            throw new InstallerBatchApplyError(applied);
          if (
            applied.clientResults === undefined ||
            applied.clientResults.length !== mutations.length
          )
            throw new InstallerTransactionInvariantError(
              "config transaction returned an invalid client result set",
            );
          return applied.clientResults;
        },
      },
    );
    if (flow.disposition === "planned")
      throw new InstallerTransactionInvariantError(
        "installer transaction returned a dry-run-only disposition",
      );
    if (applied === undefined) {
      if (
        flow.disposition === "configured" ||
        flow.disposition === "no-changes" ||
        flow.authentication === "ready" ||
        flow.authentication === "skipped"
      )
        throw new InstallerTransactionInvariantError(
          "installer flow completed configuration or authentication without an authoritative config batch",
        );
      const disposition = flow.disposition;
      return {
        ...noMutationConfigTransactionResult(disposition),
        authentication: flow.authentication,
      };
    }
    return {
      ...applied,
      disposition: flow.disposition,
      authentication: flow.authentication,
    };
  } catch (error) {
    if (error instanceof InstallerBatchApplyError)
      return {
        ...error.result,
        disposition: "configuration-unavailable",
        authentication: "not-attempted",
      };
    if (
      error instanceof InstallerTransactionInvariantError &&
      applied === undefined
    ) {
      const authentication =
        phase.current === "authentication" ||
        phase.current === "post-auth-confirmed" ||
        phase.current === "post-auth-skipped"
          ? ("unconfirmed" as const)
          : ("not-attempted" as const);
      return {
        transactionProtocol: CONFIG_TRANSACTION_PROTOCOL,
        operation: "apply",
        outcome: "configuration-unavailable",
        appliedCount: 0,
        noopCount: 0,
        disposition: "configuration-unavailable",
        authentication,
        errorCode: error.code,
        message: error.message,
        exitCode: 1,
      };
    }
    const beforeAuthentication = [
      "preflight",
      "selection",
      "applying",
      "post-apply",
    ].includes(phase.current);
    const unavailableDisposition =
      phase.current === "preflight" ||
      phase.current === "applying" ||
      error instanceof InstallerTransactionInvariantError ||
      error instanceof ClientConfigurationIncompleteError
        ? ("configuration-unavailable" as const)
        : ("interaction-unavailable" as const);
    if (beforeAuthentication && applied?.outcome !== "applied") {
      const counts =
        applied === undefined
          ? { appliedCount: 0, noopCount: 0 }
          : {
              appliedCount: applied.appliedCount,
              noopCount: applied.noopCount,
            };
      return {
        transactionProtocol: CONFIG_TRANSACTION_PROTOCOL,
        operation: "apply",
        outcome: unavailableDisposition,
        ...counts,
        disposition: unavailableDisposition,
        authentication: "not-attempted",
        errorCode:
          unavailableDisposition === "configuration-unavailable"
            ? "CONFIG_TRANSACTION_CONFIGURATION_UNAVAILABLE"
            : "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE",
        message: errorText(error),
        exitCode: 1,
      };
    }
    if (
      beforeAuthentication &&
      applied?.outcome === "applied" &&
      applied.journal !== undefined
    ) {
      const rollback = rollbackConfigTransaction({
        journalDirectory: path.dirname(applied.journal),
      });
      return {
        ...rollback,
        operation: "apply",
        exitCode: rollback.outcome === "failed-rolled-back" ? 1 : 2,
        disposition: unavailableDisposition,
        authentication: "not-attempted",
        errorCode:
          rollback.outcome === "failed-rolled-back"
            ? unavailableDisposition === "configuration-unavailable"
              ? "CONFIG_TRANSACTION_CONFIGURATION_UNAVAILABLE"
              : "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE"
            : rollback.outcome === "journal-persistence-unknown"
              ? "CONFIG_TRANSACTION_JOURNAL_PERSISTENCE_UNKNOWN"
              : "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
        message: `Client configuration setup did not complete: ${errorText(error)}`,
      };
    }
    const maybeLoginFailure =
      error instanceof MaybeLoginOutcomeError ? error : undefined;
    const authPhase = maybeLoginFailure?.details.phase;
    const authDisposition = maybeLoginFailure?.details.disposition;
    const cleanupFailure = maybeLoginFailure?.details.cleanupFailure;
    const directFlowFailure = maybeLoginFailure?.details.hasFlowFailure
      ? maybeLoginFailure.details.flowFailure
      : undefined;
    const directPromptCancellation =
      authDisposition === "skipped" &&
      directFlowFailure instanceof SanaSignInPromptCancelledError &&
      cleanupFailure?.outcome === undefined;
    const cleanupAuthentication =
      cleanupFailure !== undefined && authDisposition === "confirmed"
        ? ("retained" as const)
        : cleanupFailure !== undefined && authDisposition === "skipped"
          ? ("skipped" as const)
          : undefined;
    if (cleanupFailure !== undefined && cleanupAuthentication !== undefined) {
      if (applied === undefined) {
        const invariant = new InstallerTransactionInvariantError(
          "post-authentication cleanup has no authoritative config batch",
        );
        return {
          transactionProtocol: CONFIG_TRANSACTION_PROTOCOL,
          operation: "apply",
          outcome: "configuration-unavailable",
          appliedCount: 0,
          noopCount: 0,
          disposition: "configuration-unavailable",
          authentication: cleanupAuthentication,
          errorCode: invariant.code,
          message: invariant.message,
          exitCode: 1,
        };
      }
      const cleanupCause =
        cleanupFailure.cause === undefined
          ? cleanupFailure.message
          : errorText(cleanupFailure.cause);
      const primaryFailure =
        directFlowFailure === undefined
          ? ""
          : authDisposition === "confirmed" &&
              authPhase === "authentication"
            ? `Sana authentication was retained, but setup did not complete: ${loginFailureText(directFlowFailure)}. `
            : directPromptCancellation
              ? "Sana sign-in was cancelled. "
              : authPhase === "post-auth-confirmed"
                ? `Sana authentication was retained, but its final presentation did not complete: ${loginFailureText(directFlowFailure)}. `
                : authPhase === "post-auth-skipped"
                  ? `Sana authentication was skipped, but its final presentation did not complete: ${loginFailureText(directFlowFailure)}. `
                  : `Sana authentication did not complete: ${loginFailureText(directFlowFailure)}. `;
      const successfulFlow =
        directFlowFailure === undefined
          ? cleanupAuthentication === "retained"
            ? "Sana authentication completed, but "
            : "Sana authentication was skipped, but "
          : "";
      const presentationFailures = (
        maybeLoginFailure?.presentationFailures ?? []
      )
        .map(
          (failure) =>
            ` Authentication failure presentation also failed: ${errorText(failure)}.`,
        )
        .join("");
      return {
        ...applied,
        outcome: "authentication-incomplete",
        disposition: "authentication-incomplete",
        authentication: cleanupAuthentication,
        errorCode: "CONFIG_TRANSACTION_AUTH_SESSION_CLEANUP_FAILED",
        message: `${primaryFailure}${successfulFlow}the local authentication session could not be closed cleanly: ${cleanupCause}.${presentationFailures}`,
        exitCode: 1,
      };
    }
    if (
      (authDisposition === "confirmed" &&
        authPhase === "post-auth-confirmed") ||
      (authDisposition === "skipped" && authPhase === "post-auth-skipped")
    ) {
      const authentication =
        authDisposition === "confirmed"
          ? ("retained" as const)
          : ("skipped" as const);
      if (applied !== undefined)
        return {
          ...applied,
          outcome: "interaction-unavailable",
          disposition: "interaction-unavailable",
          authentication,
          errorCode: "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE",
          message: `Setup completed, but its final presentation failed: ${errorText(error)}`,
          exitCode: 1,
        };
      const invariant = new InstallerTransactionInvariantError(
        "post-authentication phase has no authoritative config batch",
      );
      return {
        transactionProtocol: CONFIG_TRANSACTION_PROTOCOL,
        operation: "apply",
        outcome: "configuration-unavailable",
        appliedCount: 0,
        noopCount: 0,
        disposition: "configuration-unavailable",
        authentication,
        errorCode: invariant.code,
        message: invariant.message,
        exitCode: 1,
      };
    }
    const authentication =
      authDisposition === "confirmed"
      ? ("retained" as const)
      : ("unconfirmed" as const);
    if (applied?.outcome === "no-mutation")
      return {
        ...applied,
        outcome: "authentication-incomplete",
        disposition: "authentication-incomplete",
        authentication,
        errorCode: "CONFIG_TRANSACTION_AUTHENTICATION_INCOMPLETE",
        message:
          authentication === "retained"
            ? `Sana authentication was retained, but setup did not complete: ${errorText(error)}`
            : `Sana authentication was not confirmed and setup did not complete: ${errorText(error)}`,
        exitCode: 1,
      };
    if (applied?.outcome === "applied" && applied.journal !== undefined) {
      const rollback = rollbackConfigTransaction({
        journalDirectory: path.dirname(applied.journal),
      });
      return {
        ...rollback,
        operation: "apply",
        exitCode: rollback.outcome === "failed-rolled-back" ? 1 : 2,
        disposition: "authentication-incomplete",
        authentication,
        errorCode:
          rollback.outcome === "failed-rolled-back"
            ? "CONFIG_TRANSACTION_AUTHENTICATION_INCOMPLETE"
            : rollback.outcome === "journal-persistence-unknown"
              ? "CONFIG_TRANSACTION_JOURNAL_PERSISTENCE_UNKNOWN"
              : "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
        message:
          authentication === "retained"
            ? `Sana authentication was retained, but setup did not complete: ${errorText(error)}`
            : `Sana authentication was not confirmed and setup did not complete: ${errorText(error)}`,
      };
    }
    const invariant = new InstallerTransactionInvariantError(
      "authentication phase has no authoritative config batch",
    );
    return {
      transactionProtocol: CONFIG_TRANSACTION_PROTOCOL,
      operation: "apply",
      outcome: "configuration-unavailable",
      appliedCount: 0,
      noopCount: 0,
      disposition: "configuration-unavailable",
      authentication,
      errorCode: invariant.code,
      message: invariant.message,
      exitCode: 1,
    };
  }
}

async function chooseUninstallClients(
  interaction: InstallInteraction,
  presentation: ConfigurerPresentation,
  serverName: string,
  clients: readonly ClientDef[],
): Promise<readonly string[]> {
  const message = `Remove "${sanitizeTerminalText(
    serverName,
  )}" from which clients?`;
  if (interaction.chooseClients) {
    try {
      return await interaction.chooseClients(message, clients);
    } catch (error) {
      throw normalizePromptCancellation(error, "uninstall-selection");
    }
  }
  try {
    return await (interaction.promptDriver?.checkbox ?? checkbox)<string>(
      {
        message: presentation.ui.text(message).text,
        choices: clients.map((client) => ({
          name: sanitizeTerminalText(client.name),
          value: client.id,
          checked: true,
        })),
        pageSize: 15,
        theme: presentation.checkboxTheme(),
      },
      presentation.promptContext(),
    );
  } catch (error) {
    throw normalizePromptCancellation(error, "uninstall-selection");
  }
}

interface UninstallClients {
  candidates: ClientDef[];
  discoveryIssues: string[];
}

async function collectUninstallClients(
  detections: readonly {
    client: ClientDef;
    detection: DetectionResult;
  }[],
  presentation: ConfigurerPresentation,
  serverName: string,
  entry: ReturnType<typeof serverTarget>,
): Promise<UninstallClients> {
  const candidates: ClientDef[] = [];
  const discoveryIssues: string[] = [];
  for (const { client, detection } of detections) {
    const status = await registrationStatus(client, serverName, entry);
    if (detection.state === "unavailable" && status.state !== "owned")
      printUnavailableDetection(presentation, client, detection.reason);

    if (status.state === "owned") {
      candidates.push(client);
      continue;
    }
    if (status.state === "foreign" || status.state === "unavailable") {
      presentation.print(
        presentation.ui.row(
          presentation.ui.statusGlyph({ status: "failed" }, false),
          client.name,
          `configuration unavailable: ${sanitizeTerminalText(
            status.reason,
          )}${configPathDetail(status)}`,
        ),
      );
      discoveryIssues.push(client.name);
      continue;
    }
    if (detection.state === "present") candidates.push(client);
  }
  return { candidates, discoveryIssues };
}

export async function runUninstall(
  opts: InstallOpts = {},
  interaction: InstallInteraction = {},
): Promise<UninstallerFlowResult> {
  const presentation = presentationFor(interaction);
  const clients = interaction.clients ?? CLIENTS;
  const serverName = opts.name ?? "sana-mcp";
  validateServerName(serverName);
  const dryRun = opts.dryRun === true;
  const entry = serverTarget();
  if (dryRun) {
    presentation.print("Dry run: no client config files will be changed.");
    presentation.blank();
  }
  const detections = clients.map((client) => ({
    client,
    detection: detectClient(client),
  }));
  const discovered = await collectUninstallClients(
    detections,
    presentation,
    serverName,
    entry,
  );

  if (discovered.candidates.length === 0) {
    if (discovered.discoveryIssues.length > 0) {
      presentation.print(
        "Managed registration state could not be determined for every client.",
      );
      stopForIncompleteConfiguration(presentation, [
        ...new Set(discovered.discoveryIssues),
      ]);
    }
    presentation.print("No managed client registrations were found.");
    return { disposition: "no-registrations", selectedCount: 0 };
  }

  if (!opts.yes && !isInteractive(interaction, presentation)) {
    presentation.print(
      "An interactive terminal is required to choose clients. Use sana-mcp uninstall --yes to remove every detected or proven-managed registration.",
    );
    return { disposition: "interaction-unavailable", selectedCount: 0 };
  }

  if (discovered.discoveryIssues.length > 0) {
    presentation.print(
      "Managed registration state could not be determined for every client.",
    );
    stopForIncompleteConfiguration(presentation, [
      ...new Set(discovered.discoveryIssues),
    ]);
  }

  let ids: readonly string[];
  try {
    ids = opts.yes
      ? discovered.candidates.map((client) => client.id)
      : await chooseUninstallClients(
          interaction,
          presentation,
          serverName,
          discovered.candidates,
        );
  } catch (error) {
    if (!(error instanceof ClientConfigurationCancelledError)) throw error;
    presentation.print("Cancelled; no changes were made.");
    return { disposition: "cancelled", selectedCount: 0 };
  }
  const chosen = discovered.candidates.filter((client) =>
    ids.includes(client.id),
  );
  if (chosen.length === 0) {
    presentation.print("Nothing selected; no changes were made.");
    return { disposition: "no-selection", selectedCount: 0 };
  }

  const results = await applyDirectMutations(
    chosen.map((client) => ({ client, desired: "absent" })),
    serverName,
    entry,
    dryRun,
  );
  const failedClients: string[] = [];
  chosen.forEach((client, index) => {
    const result = results[index]!;
    printApplyResult(presentation, client, result, false);
    if (needsManualAction(result)) failedClients.push(client.name);
  });
  if (failedClients.length > 0)
    stopForIncompleteConfiguration(presentation, failedClients);
  presentation.blank();
  presentation.print(
    dryRun
      ? "Dry run complete. No client config files were changed."
      : "Client registrations removed.",
  );
  return {
    disposition:
      dryRun && results.some((result) => result.state === "planned")
        ? "planned"
        : "completed",
    selectedCount: chosen.length,
  };
}
