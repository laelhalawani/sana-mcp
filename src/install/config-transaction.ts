import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  publishConfigAtomic,
  readConfigSnapshot,
  removeConfigAtomic,
  retryWindowsFileOperation,
  type ConfigSnapshot,
} from "./atomic-config.js";
import {
  planClientChange,
  type ApplyResult,
  type ClientChange,
  type DesiredRegistration,
} from "./apply.js";
import { CLIENTS, detectClient, type ClientDef } from "./clients.js";
import type { ServerTarget } from "./server-target.js";
import { applyFileChange } from "./writers.js";
import { boundedErrorText } from "./error-text.js";

export const CONFIG_TRANSACTION_PROTOCOL = 1 as const;
const TRANSACTION_PROTOCOL = CONFIG_TRANSACTION_PROTOCOL;
const JOURNAL_LEAF = "client-config-transaction.json";
const SERVER_NAME = "sana-mcp";

type TargetState =
  | "pending"
  | "applying"
  | "applied"
  | "noop"
  | "rolling-back"
  | "rolled-back"
  | "conflict"
  | "failed";

type JournalState =
  | "planned"
  | "applying"
  | "applied"
  | "rolling-back"
  | "failed-rolled-back"
  | "rollback-incomplete"
  | "conflict";

interface ImageToken {
  readonly exists: boolean;
  readonly sha256?: string;
  readonly size?: number;
  readonly mode?: number;
}

interface JournalImage {
  readonly exists: boolean;
  readonly bytesBase64?: string;
  readonly mode?: number;
  readonly token: ImageToken;
}

interface JournalTarget {
  readonly clientId: string;
  readonly clientName: string;
  readonly configPath: string;
  readonly desired: DesiredRegistration;
  readonly serverTargetDigest: string;
  readonly before: JournalImage;
  readonly after: JournalImage;
  state: TargetState;
  issue?: string;
}

interface ConfigTransactionJournal {
  readonly transactionProtocol: typeof TRANSACTION_PROTOCOL;
  readonly serverName: typeof SERVER_NAME;
  readonly serverTarget: ServerTarget;
  state: JournalState;
  readonly targets: JournalTarget[];
  issue?: string;
}

interface PreparedTarget {
  readonly journal: JournalTarget;
  readonly plan?: Extract<ClientChange, { state: "ready" }>["plan"];
  applyResult?: Extract<ApplyResult, { state: "applied" }>;
}

export interface ConfigTransactionMutation {
  readonly client: ClientDef;
  readonly desired: DesiredRegistration;
}

export type ConfigTransactionOutcome =
  | "applied"
  | "no-mutation"
  | "interaction-unavailable"
  | "configuration-unavailable"
  | "authentication-incomplete"
  | "failed-rolled-back"
  | "rollback-incomplete"
  | "conflict"
  | "journal-ambiguous"
  | "journal-persistence-unknown"
  | "journal-unavailable";

export interface ConfigTransactionResult {
  readonly transactionProtocol: typeof TRANSACTION_PROTOCOL;
  readonly operation: "apply" | "rollback";
  readonly outcome: ConfigTransactionOutcome;
  readonly appliedCount: number;
  readonly noopCount: number;
  readonly journal?: string;
  readonly errorCode?: string;
  readonly message?: string;
  readonly clientResults?: readonly ApplyResult[];
  readonly disposition?:
    | "configured"
    | "no-clients"
    | "no-changes"
    | "cancelled"
    | "interaction-unavailable"
    | "configuration-unavailable"
    | "authentication-incomplete";
  readonly authentication?:
    "not-attempted" | "ready" | "skipped" | "retained" | "unconfirmed";
  /** Process status for the hidden CLI adapter; omitted from serialized output. */
  readonly exitCode: 0 | 1 | 2;
}

export function noMutationConfigTransactionResult(
  disposition:
    "no-clients" | "no-changes" | "cancelled" | "interaction-unavailable",
): ConfigTransactionResult {
  const unavailable = disposition === "interaction-unavailable";
  return {
    transactionProtocol: TRANSACTION_PROTOCOL,
    operation: "apply",
    outcome: unavailable ? "interaction-unavailable" : "no-mutation",
    appliedCount: 0,
    noopCount: 0,
    disposition,
    authentication: "not-attempted",
    ...(unavailable
      ? {
          errorCode: "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE",
          message: "an interactive terminal is required for client selection",
        }
      : {}),
    exitCode: unavailable ? 1 : 0,
  };
}

export interface ApplyConfigTransactionOptions {
  readonly journalDirectory: string;
  readonly serverCommand: string;
  readonly yes?: boolean;
  readonly clients?: readonly ClientDef[];
  readonly mutations?: readonly ConfigTransactionMutation[];
  readonly preflight?: ConfigTransactionPreflight;
}

export interface RollbackConfigTransactionOptions {
  readonly journalDirectory: string;
}

export interface ConfigTransactionPreflight {
  readonly journalDirectory: string;
  readonly journalFile: string;
  readonly serverTarget: ServerTarget;
}

const errorText = boundedErrorText;

function serverTargetDigest(target: ServerTarget): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        command: target.command,
        args: [...target.args],
        ...(target.env === undefined ? {} : { env: target.env }),
      }),
      "utf8",
    )
    .digest("hex");
}

function tokenFor(bytes: Buffer | undefined, mode?: number): ImageToken {
  if (bytes === undefined) return { exists: false };
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    ...(process.platform === "win32" ? {} : { mode }),
  };
}

function imageFor(bytes: Buffer | undefined, mode?: number): JournalImage {
  const normalizedMode = process.platform === "win32" ? undefined : mode;
  return bytes === undefined
    ? { exists: false, token: tokenFor(undefined) }
    : {
        exists: true,
        bytesBase64: bytes.toString("base64"),
        ...(normalizedMode === undefined ? {} : { mode: normalizedMode }),
        token: tokenFor(bytes, normalizedMode),
      };
}

function bytesOf(image: JournalImage): Buffer | undefined {
  if (!image.exists) return undefined;
  return Buffer.from(image.bytesBase64!, "base64");
}

function sameImage(left: JournalImage, right: JournalImage): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return (
    bytesOf(left)!.equals(bytesOf(right)!) &&
    (process.platform === "win32" || left.mode === right.mode)
  );
}

function readImage(file: string): JournalImage {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return imageFor(undefined);
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Error(`${file} is a symbolic link or reparse point`);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  return imageFor(
    fs.readFileSync(file),
    process.platform === "win32" ? undefined : stat.mode & 0o777,
  );
}

function decodeUtf8(image: JournalImage, label: string): string {
  const bytes = bytesOf(image);
  if (bytes === undefined) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  )
    throw new Error(`${label} must be an absolute path`);
  const normalized = path.normalize(value);
  if (normalized !== value) throw new Error(`${label} must be normalized`);
  return value;
}

function validateServerCommand(command: string): string {
  const absolute = validateAbsolutePath(command, "server command");
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error("server command is a symbolic link or reparse point");
  if (!stat.isFile()) throw new Error("server command is not a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0)
    throw new Error("server command is not executable");
  if (
    fs.realpathSync.native(absolute) !==
    fs.realpathSync.native(process.execPath)
  )
    throw new Error(
      "server command does not identify the running standalone executable",
    );
  return absolute;
}

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inspectFutureJournalDirectory(directory: string): string {
  const absolute = validateAbsolutePath(directory, "journal directory");
  if (lstatIfPresent(absolute) !== undefined) {
    const canonical = openJournalDirectory(absolute);
    const file = journalPath(canonical);
    if (lstatIfPresent(file) !== undefined)
      throw new Error(
        "a config transaction journal path entry already exists; resolve it before applying again",
      );
    return canonical;
  }
  const leaves: string[] = [];
  let ancestor = absolute;
  while (lstatIfPresent(ancestor) === undefined) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor)
      throw new Error("journal directory has no authoritative existing parent");
    leaves.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory())
    throw new Error("journal directory parent is not a directory");
  return path.join(fs.realpathSync.native(ancestor), ...leaves);
}

export function preflightConfigTransaction(options: {
  journalDirectory: string;
  serverCommand: string;
}): ConfigTransactionPreflight {
  const journalDirectory = inspectFutureJournalDirectory(
    options.journalDirectory,
  );
  return {
    journalDirectory,
    journalFile: journalPath(journalDirectory),
    serverTarget: {
      command: validateServerCommand(options.serverCommand),
      args: ["mcp"],
    },
  };
}

function prepareJournalDirectory(directory: string): string {
  const absolute = validateAbsolutePath(directory, "journal directory");
  const existed = lstatIfPresent(absolute) !== undefined;
  if (!existed) fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error("journal directory is a symbolic link or reparse point");
  if (!stat.isDirectory())
    throw new Error("journal directory is not a directory");
  const canonical = fs.realpathSync.native(absolute);
  if (process.platform !== "win32") {
    if (!existed) fs.chmodSync(absolute, 0o700);
    if ((fs.statSync(canonical).mode & 0o077) !== 0)
      throw new Error("journal directory permissions are not private");
  }
  return canonical;
}

function openJournalDirectory(directory: string): string {
  const absolute = validateAbsolutePath(directory, "journal directory");
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error("journal directory is a symbolic link or reparse point");
  if (!stat.isDirectory())
    throw new Error("journal directory is not a directory");
  const canonical = fs.realpathSync.native(absolute);
  if (process.platform !== "win32") {
    if ((fs.statSync(canonical).mode & 0o077) !== 0)
      throw new Error("journal directory permissions are not private");
  }
  return canonical;
}

function journalPath(directory: string): string {
  return path.join(directory, JOURNAL_LEAF);
}

function flushDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertJournalLeaf(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink())
    throw new Error("config transaction journal is a symbolic link");
  if (!stat.isFile())
    throw new Error("config transaction journal is not a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error("config transaction journal permissions are not private");
}

function removeJournalTemporary(file: string): string | undefined {
  try {
    retryWindowsFileOperation(() => fs.unlinkSync(file));
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `temporary journal cleanup failed: ${errorText(error)}`;
  }
}

function writeJournal(file: string, journal: ConfigTransactionJournal): void {
  assertJournalLeaf(file);
  const expectedReceipt = fs.readFileSync(file);
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${JOURNAL_LEAF}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let owned = false;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    owned = true;
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(journal, null, 2)}\n`,
      "utf8",
    );
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    retryWindowsFileOperation(
      () => fs.renameSync(temporary, file),
      () => {
        assertJournalLeaf(file);
        if (!fs.readFileSync(file).equals(expectedReceipt))
          throw new Error(
            "config transaction journal changed while Windows was retrying publication",
          );
      },
    );
    owned = false;
    flushDirectory(directory);
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "journal update and descriptor cleanup both failed",
            )
          : error;
      }
    }
    if (owned) {
      const cleanup = removeJournalTemporary(temporary);
      if (cleanup) {
        const cleanupError = new Error(cleanup);
        failure = failure
          ? new AggregateError(
              [failure, cleanupError],
              "journal update and temporary cleanup both failed",
            )
          : cleanupError;
      }
    }
  }
  if (failure) throw failure;
}

class JournalPublicationAmbiguousError extends Error {
  constructor(cause: unknown) {
    super(
      `config transaction receipt publication could not be proven durable: ${errorText(cause)}`,
      { cause },
    );
    this.name = "JournalPublicationAmbiguousError";
  }
}

function createJournal(file: string, journal: ConfigTransactionJournal): void {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${JOURNAL_LEAF}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryOwned = false;
  let linked = false;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    temporaryOwned = true;
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(journal, null, 2)}\n`,
      "utf8",
    );
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // A hard-link publication gives the first transaction exclusive ownership
    // without a check-then-rename race or an overwrite of another receipt.
    fs.linkSync(temporary, file);
    linked = true;
    retryWindowsFileOperation(() => fs.unlinkSync(temporary));
    temporaryOwned = false;
    flushDirectory(directory);
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "journal creation and descriptor cleanup both failed",
            )
          : error;
      }
    }
    if (temporaryOwned) {
      const cleanup = removeJournalTemporary(temporary);
      if (cleanup && !linked) {
        const cleanupError = new Error(cleanup);
        failure = failure
          ? new AggregateError(
              [failure, cleanupError],
              "journal creation and temporary cleanup both failed",
            )
          : cleanupError;
      }
    }
  }
  if (failure)
    throw linked ? new JournalPublicationAmbiguousError(failure) : failure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseImage(value: unknown, label: string): JournalImage {
  if (!isRecord(value) || typeof value.exists !== "boolean")
    throw new Error(`${label} is invalid`);
  if (!isRecord(value.token) || value.token.exists !== value.exists)
    throw new Error(`${label} token is invalid`);
  if (!value.exists) {
    if (
      value.bytesBase64 !== undefined ||
      value.mode !== undefined ||
      value.token.sha256 !== undefined ||
      value.token.size !== undefined ||
      value.token.mode !== undefined
    )
      throw new Error(`${label} absent image contains invented state`);
    return { exists: false, token: { exists: false } };
  }
  if (
    typeof value.bytesBase64 !== "string" ||
    typeof value.token.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.token.sha256) ||
    !Number.isSafeInteger(value.token.size) ||
    (value.token.size as number) < 0 ||
    (process.platform === "win32"
      ? value.mode !== undefined || value.token.mode !== undefined
      : !Number.isSafeInteger(value.mode) ||
        (value.mode as number) < 0 ||
        (value.mode as number) > 0o777 ||
        value.token.mode !== value.mode)
  )
    throw new Error(`${label} populated image is invalid`);
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== value.bytesBase64 ||
    bytes.byteLength !== value.token.size ||
    tokenFor(bytes, value.mode as number | undefined).sha256 !==
      value.token.sha256
  )
    throw new Error(`${label} bytes do not match its token`);
  return {
    exists: true,
    bytesBase64: value.bytesBase64,
    ...(process.platform === "win32" ? {} : { mode: value.mode as number }),
    token: {
      exists: true,
      sha256: value.token.sha256,
      size: value.token.size as number,
      ...(process.platform === "win32"
        ? {}
        : { mode: value.token.mode as number }),
    },
  };
}

const TARGET_STATES = new Set<TargetState>([
  "pending",
  "applying",
  "applied",
  "noop",
  "rolling-back",
  "rolled-back",
  "conflict",
  "failed",
]);
const JOURNAL_STATES = new Set<JournalState>([
  "planned",
  "applying",
  "applied",
  "rolling-back",
  "failed-rolled-back",
  "rollback-incomplete",
  "conflict",
]);

function readJournal(file: string): ConfigTransactionJournal {
  assertJournalLeaf(file);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.transactionProtocol !== TRANSACTION_PROTOCOL ||
    value.serverName !== SERVER_NAME ||
    !isRecord(value.serverTarget) ||
    typeof value.serverTarget.command !== "string" ||
    !path.isAbsolute(value.serverTarget.command) ||
    !Array.isArray(value.serverTarget.args) ||
    value.serverTarget.args.length !== 1 ||
    value.serverTarget.args[0] !== "mcp" ||
    value.serverTarget.env !== undefined ||
    value.serverTarget.command.includes("\0") ||
    path.normalize(value.serverTarget.command) !== value.serverTarget.command ||
    typeof value.state !== "string" ||
    !JOURNAL_STATES.has(value.state as JournalState) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0 ||
    (value.issue !== undefined &&
      (typeof value.issue !== "string" ||
        value.issue.length === 0 ||
        value.issue.includes("\0")))
  )
    throw new Error("config transaction journal header is invalid");
  const seen = new Set<string>();
  const targets = value.targets.map((raw, index): JournalTarget => {
    if (
      !isRecord(raw) ||
      typeof raw.clientId !== "string" ||
      raw.clientId.length === 0 ||
      raw.clientId.includes("\0") ||
      typeof raw.clientName !== "string" ||
      raw.clientName.length === 0 ||
      raw.clientName.includes("\0") ||
      typeof raw.configPath !== "string" ||
      raw.configPath.includes("\0") ||
      !path.isAbsolute(raw.configPath) ||
      (raw.desired !== "present" && raw.desired !== "absent") ||
      typeof raw.serverTargetDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.serverTargetDigest) ||
      typeof raw.state !== "string" ||
      !TARGET_STATES.has(raw.state as TargetState) ||
      (raw.issue !== undefined &&
        (typeof raw.issue !== "string" ||
          raw.issue.length === 0 ||
          raw.issue.includes("\0")))
    )
      throw new Error(`config transaction target ${index} is invalid`);
    const normalized = path.normalize(raw.configPath);
    if (normalized !== raw.configPath)
      throw new Error(
        `config transaction target ${index} path is not normalized`,
      );
    if (seen.has(normalized))
      throw new Error("config transaction journal contains duplicate paths");
    seen.add(normalized);
    const before = parseImage(raw.before, `target ${index} preimage`);
    const after = parseImage(raw.after, `target ${index} postimage`);
    if (
      !after.exists &&
      !(raw.state === "noop" && raw.desired === "absent" && !before.exists)
    )
      throw new Error(
        `target ${index} absent postimage is not a coherent removal no-op`,
      );
    return {
      clientId: raw.clientId,
      clientName: raw.clientName,
      configPath: normalized,
      desired: raw.desired,
      serverTargetDigest: raw.serverTargetDigest,
      before,
      after,
      state: raw.state as TargetState,
      ...(raw.issue === undefined ? {} : { issue: raw.issue }),
    };
  });
  const serverTarget: ServerTarget = {
    command: value.serverTarget.command,
    args: ["mcp"],
  };
  const digest = serverTargetDigest(serverTarget);
  if (targets.some((target) => target.serverTargetDigest !== digest))
    throw new Error(
      "config transaction target does not match the server target",
    );
  if (
    targets.some(
      (target) =>
        (target.state === "conflict" || target.state === "failed") !==
        (target.issue !== undefined),
    )
  )
    throw new Error("config transaction target issue does not match its state");
  if (
    (value.state === "conflict" || value.state === "rollback-incomplete") !==
    (value.issue !== undefined)
  )
    throw new Error("config transaction issue does not match its state");
  if (
    targets.some(
      (target) =>
        target.state === "noop" && !sameImage(target.before, target.after),
    )
  )
    throw new Error("config transaction noop target changes its image");
  if (
    targets.some(
      (target) =>
        target.state !== "noop" && sameImage(target.before, target.after),
    )
  )
    throw new Error("config transaction mutating target has no image change");
  const states = new Set(targets.map((target) => target.state));
  const coherent =
    (value.state === "planned" &&
      targets.every(
        (target) => target.state === "pending" || target.state === "noop",
      )) ||
    (value.state === "applying" &&
      targets.every((target) =>
        ["pending", "applying", "applied", "noop"].includes(target.state),
      )) ||
    (value.state === "applied" &&
      targets.every(
        (target) => target.state === "applied" || target.state === "noop",
      )) ||
    (value.state === "rolling-back" &&
      targets.every((target) =>
        [
          "pending",
          "noop",
          "applying",
          "applied",
          "rolling-back",
          "rolled-back",
          "conflict",
          "failed",
        ].includes(target.state),
      )) ||
    (value.state === "failed-rolled-back" &&
      targets.every((target) =>
        ["pending", "noop", "rolled-back"].includes(target.state),
      )) ||
    (value.state === "conflict" &&
      states.has("conflict") &&
      targets.every((target) =>
        ["pending", "noop", "rolled-back", "conflict", "failed"].includes(
          target.state,
        ),
      )) ||
    (value.state === "rollback-incomplete" &&
      [...states].some((state) => ["failed", "conflict"].includes(state)) &&
      targets.every((target) =>
        ["pending", "noop", "rolled-back", "conflict", "failed"].includes(
          target.state,
        ),
      ));
  if (!coherent)
    throw new Error(
      "config transaction journal and target states are inconsistent",
    );
  return {
    transactionProtocol: TRANSACTION_PROTOCOL,
    serverName: SERVER_NAME,
    serverTarget,
    state: value.state as JournalState,
    targets,
    ...(typeof value.issue === "string" ? { issue: value.issue } : {}),
  };
}

function result(
  operation: "apply" | "rollback",
  outcome: ConfigTransactionOutcome,
  exitCode: 0 | 1 | 2,
  journal: string | undefined,
  targets: readonly JournalTarget[],
  errorCode?: string,
  message?: string,
  clientResults?: readonly ApplyResult[],
): ConfigTransactionResult {
  return {
    transactionProtocol: TRANSACTION_PROTOCOL,
    operation,
    outcome,
    appliedCount: targets.filter((target) => target.state === "applied").length,
    noopCount: targets.filter((target) => target.state === "noop").length,
    ...(journal === undefined ? {} : { journal }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(message === undefined ? {} : { message }),
    ...(clientResults === undefined ? {} : { clientResults }),
    exitCode,
  };
}

function failureBeforeMutation(
  operation: "apply",
  journal: string | undefined,
  code: string,
  message: string,
): ConfigTransactionResult {
  return result(operation, "failed-rolled-back", 1, journal, [], code, message);
}

function detectedMutations(
  clients: readonly ClientDef[],
): ConfigTransactionMutation[] {
  const detections = clients.map((client) => ({
    client,
    detection: detectClient(client),
  }));
  const detectionFailures = detections.filter(
    ({ detection }) => detection.state === "unavailable",
  );
  const selected = detections
    .filter(({ detection }) => detection.state === "present")
    .map(({ client }) => ({ client, desired: "present" as const }));
  if (selected.length === 0 && detectionFailures.length > 0)
    throw new Error(
      `no supported AI client could be selected; detection is unavailable for: ${detectionFailures
        .map(({ client }) => client.name)
        .join(", ")}`,
    );
  if (selected.length === 0)
    throw new Error("no supported AI clients were detected");
  return selected;
}

async function prepareTargets(
  mutations: readonly ConfigTransactionMutation[],
  target: ServerTarget,
): Promise<PreparedTarget[]> {
  if (mutations.length === 0)
    throw new Error("the requested client mutation set is empty");

  const prepared: PreparedTarget[] = [];
  const paths = new Set<string>();
  for (const { client, desired } of mutations) {
    let change = await planClientChange(client, SERVER_NAME, target, desired);
    if (change.state === "collision" || change.state === "unavailable")
      throw new Error(`${client.name}: ${change.reason}`);
    if (change.pathState !== "known")
      throw new Error(`${client.name}: client config path is unavailable`);
    const configPath = validateAbsolutePath(
      change.file,
      `${client.name} config path`,
    );
    if (paths.has(configPath))
      throw new Error(`multiple selected clients resolve to ${configPath}`);
    paths.add(configPath);
    let before = readImage(configPath);
    if (change.state === "noop") {
      const confirmed = await planClientChange(
        client,
        SERVER_NAME,
        target,
        desired,
      );
      if (
        confirmed.state !== "noop" ||
        confirmed.pathState !== "known" ||
        validateAbsolutePath(
          confirmed.file,
          `${client.name} confirmed config path`,
        ) !== configPath
      )
        throw new NoopPreconditionConflictError(client.name);
      const confirmedImage = readImage(configPath);
      if (!sameImage(before, confirmedImage))
        throw new NoopPreconditionConflictError(client.name);
      change = confirmed;
      before = confirmedImage;
    }
    const plannedBefore =
      change.state === "ready"
        ? change.plan.before
        : readConfigSnapshot(configPath);
    if (
      plannedBefore.exists !== before.exists ||
      (plannedBefore.exists &&
        (plannedBefore.raw !== decodeUtf8(before, `${client.name} config`) ||
          (process.platform !== "win32" && plannedBefore.mode !== before.mode)))
    )
      throw new Error(
        `${client.name}: config changed while selection was planned`,
      );
    const after =
      change.state === "ready"
        ? imageFor(
            Buffer.from(change.plan.after, "utf8"),
            process.platform === "win32" ? undefined : (before.mode ?? 0o600),
          )
        : before;
    prepared.push({
      journal: {
        clientId: client.id,
        clientName: client.name,
        configPath,
        desired,
        serverTargetDigest: serverTargetDigest(target),
        before,
        after,
        state: change.state === "noop" ? "noop" : "pending",
      },
      ...(change.state === "ready" ? { plan: change.plan } : {}),
    });
  }
  return prepared;
}

class NoopPreconditionConflictError extends Error {
  constructor(readonly clientName: string) {
    super(
      `${clientName}: client config changed after its no-op was authoritatively planned`,
    );
    this.name = "NoopPreconditionConflictError";
  }
}

function validateNoopPreconditions(prepared: readonly PreparedTarget[]): void {
  for (const item of prepared) {
    if (item.plan !== undefined) continue;
    if (
      item.journal.state !== "noop" ||
      !sameImage(readImage(item.journal.configPath), item.journal.before)
    )
      throw new NoopPreconditionConflictError(item.journal.clientName);
  }
}

function noopResult(item: PreparedTarget): ApplyResult {
  if (item.plan !== undefined || item.journal.state !== "noop")
    throw new Error(
      `${item.journal.clientName}: transaction result invariant expected an authoritative no-op`,
    );
  return {
    state: "noop",
    clientId: item.journal.clientId,
    clientName: item.journal.clientName,
    serverName: SERVER_NAME,
    desired: item.journal.desired,
    operation: item.journal.desired === "present" ? "register" : "remove",
    pathState: "known",
    file: item.journal.configPath,
  };
}

function snapshotFrom(image: JournalImage): ConfigSnapshot {
  return image.exists
    ? {
        exists: true,
        raw: decodeUtf8(image, "journal image"),
        ...(image.mode === undefined ? {} : { mode: image.mode }),
      }
    : { exists: false, raw: "" };
}

function restoreTarget(target: JournalTarget):
  | { ok: true }
  | {
      ok: false;
      conflict: boolean;
      reason: string;
    } {
  const current = readImage(target.configPath);
  if (sameImage(current, target.before)) return { ok: true };
  if (!sameImage(current, target.after))
    return {
      ok: false,
      conflict: true,
      reason: "client config differs from the recorded transaction postimage",
    };

  if (!target.before.exists) {
    const removed = removeConfigAtomic(
      target.configPath,
      snapshotFrom(target.after),
    );
    if (removed.state === "removed") return { ok: true };
    const reconciled = readImage(target.configPath);
    if (sameImage(reconciled, target.before)) return { ok: true };
    return {
      ok: false,
      conflict: removed.state === "conflict",
      reason: removed.reason,
    };
  }

  const restored = publishConfigAtomic(
    target.configPath,
    snapshotFrom(target.after),
    decodeUtf8(target.before, "journal preimage"),
    (raw) =>
      raw === decodeUtf8(target.before, "journal preimage")
        ? { ok: true }
        : { ok: false, reason: "restored bytes differ from the preimage" },
    undefined,
    target.before.mode!,
  );
  if (restored.state === "published") return { ok: true };
  const reconciled = readImage(target.configPath);
  if (sameImage(reconciled, target.before)) return { ok: true };
  return {
    ok: false,
    conflict: restored.state === "conflict",
    reason: restored.reason,
  };
}

function compensate(
  journalFile: string,
  journal: ConfigTransactionJournal,
): {
  outcome:
    | "failed-rolled-back"
    | "rollback-incomplete"
    | "conflict"
    | "journal-persistence-unknown";
  issue?: string;
} {
  // A retry reports only what remains unresolved in this attempt. The prior
  // aggregate is diagnostic history, not an input to the next outcome.
  delete journal.issue;
  for (const target of journal.targets)
    if (target.state !== "conflict" && target.state !== "failed")
      delete target.issue;
  const journalFailures: string[] = [];
  const persist = (): boolean => {
    try {
      writeJournal(journalFile, journal);
      return true;
    } catch (error) {
      journalFailures.push(
        `config transaction journal update failed: ${errorText(error)}`,
      );
      return false;
    }
  };
  journal.state = "rolling-back";
  persist();
  const issues: string[] = [];
  let conflict = false;
  for (let index = journal.targets.length - 1; index >= 0; index -= 1) {
    const target = journal.targets[index]!;
    if (
      target.state === "noop" ||
      target.state === "pending" ||
      target.state === "rolled-back"
    )
      continue;
    target.state = "rolling-back";
    delete target.issue;
    persist();
    try {
      const restored = restoreTarget(target);
      if (restored.ok) {
        target.state = "rolled-back";
      } else {
        target.state = restored.conflict ? "conflict" : "failed";
        target.issue = restored.reason;
        conflict ||= restored.conflict;
        issues.push(`${target.clientName}: ${restored.reason}`);
      }
    } catch (error) {
      target.state = "failed";
      target.issue = errorText(error);
      issues.push(`${target.clientName}: ${target.issue}`);
    }
    persist();
  }
  const outcome =
    issues.length === 0
      ? "failed-rolled-back"
      : conflict
        ? "conflict"
        : "rollback-incomplete";
  journal.state = outcome;
  if (issues.length === 0) delete journal.issue;
  else journal.issue = issues.join("; ");
  const finalPersisted = persist();
  if (!finalPersisted) {
    const combined = [...issues, ...journalFailures].join("; ");
    return outcome === "failed-rolled-back"
      ? { outcome: "journal-persistence-unknown", issue: combined }
      : { outcome, issue: combined };
  }
  const historicalJournalIssue =
    journalFailures.length === 0 ? undefined : journalFailures.join("; ");
  const reportedIssue =
    journal.issue === undefined
      ? historicalJournalIssue
      : historicalJournalIssue === undefined
        ? journal.issue
        : `${journal.issue}; ${historicalJournalIssue}`;
  return reportedIssue === undefined
    ? { outcome }
    : { outcome, issue: reportedIssue };
}

function compensationErrorCode(
  outcome: ReturnType<typeof compensate>["outcome"],
  compensatedCode: string,
): string {
  if (outcome === "failed-rolled-back") return compensatedCode;
  if (outcome === "journal-persistence-unknown")
    return "CONFIG_TRANSACTION_JOURNAL_PERSISTENCE_UNKNOWN";
  return "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE";
}

export async function applyConfigTransaction(
  options: ApplyConfigTransactionOptions,
): Promise<ConfigTransactionResult> {
  let publishedFile: string | undefined;
  let prepared: PreparedTarget[];
  let journal: ConfigTransactionJournal;
  try {
    if (options.mutations === undefined && options.yes !== true)
      throw new Error("explicit --yes consent is required");
    const initial =
      options.preflight ??
      preflightConfigTransaction({
        journalDirectory: options.journalDirectory,
        serverCommand: options.serverCommand,
      });
    if (initial.serverTarget.command !== options.serverCommand)
      throw new Error("preflight server command does not match the request");
    const serverTarget: ServerTarget = {
      command: validateServerCommand(options.serverCommand),
      args: ["mcp"],
    };
    const mutations =
      options.mutations ?? detectedMutations(options.clients ?? CLIENTS);
    prepared = await prepareTargets(mutations, serverTarget);
    try {
      validateNoopPreconditions(prepared);
    } catch (error) {
      if (error instanceof NoopPreconditionConflictError)
        return result(
          "apply",
          "conflict",
          2,
          undefined,
          prepared.map(({ journal: target }) => target),
          "CONFIG_TRANSACTION_CONFLICT",
          error.message,
        );
      throw error;
    }
    if (prepared.every((item) => item.plan === undefined))
      return {
        ...result(
          "apply",
          "no-mutation",
          0,
          undefined,
          prepared.map(({ journal: target }) => target),
          undefined,
          undefined,
          prepared.map(noopResult),
        ),
        disposition: "no-changes",
        authentication: "not-attempted",
      };
    const current = preflightConfigTransaction({
      journalDirectory: options.journalDirectory,
      serverCommand: options.serverCommand,
    });
    if (
      current.journalDirectory !== initial.journalDirectory ||
      serverTargetDigest(current.serverTarget) !==
        serverTargetDigest(initial.serverTarget)
    )
      throw new Error("config transaction preflight changed during selection");
    const directory = prepareJournalDirectory(current.journalDirectory);
    if (directory !== current.journalDirectory)
      throw new Error("journal directory identity changed during preparation");
    const candidateFile = journalPath(directory);
    if (lstatIfPresent(candidateFile) !== undefined)
      throw new Error(
        "a config transaction journal path entry already exists; resolve it before applying again",
      );
    journal = {
      transactionProtocol: TRANSACTION_PROTOCOL,
      serverName: SERVER_NAME,
      serverTarget,
      state: "planned",
      targets: prepared.map(({ journal: target }) => target),
    };
    try {
      createJournal(candidateFile, journal);
    } catch (error) {
      if (error instanceof JournalPublicationAmbiguousError)
        return result(
          "apply",
          "journal-ambiguous",
          2,
          undefined,
          journal.targets,
          "CONFIG_TRANSACTION_JOURNAL_AMBIGUOUS",
          error.message,
        );
      throw error;
    }
    publishedFile = candidateFile;
  } catch (error) {
    if (error instanceof NoopPreconditionConflictError)
      return result(
        "apply",
        "conflict",
        2,
        undefined,
        [],
        "CONFIG_TRANSACTION_CONFLICT",
        error.message,
      );
    return failureBeforeMutation(
      "apply",
      undefined,
      "CONFIG_TRANSACTION_PREPARATION_FAILED",
      errorText(error),
    );
  }
  if (publishedFile === undefined)
    return failureBeforeMutation(
      "apply",
      undefined,
      "CONFIG_TRANSACTION_PREPARATION_FAILED",
      "config transaction receipt publication was not confirmed",
    );
  try {
    validateNoopPreconditions(prepared);
  } catch (error) {
    if (error instanceof NoopPreconditionConflictError)
      return result(
        "apply",
        "conflict",
        2,
        publishedFile,
        journal.targets,
        "CONFIG_TRANSACTION_CONFLICT",
        error.message,
      );
    const rollback = compensate(publishedFile, journal);
    return result(
      "apply",
      rollback.outcome,
      rollback.outcome === "failed-rolled-back" ? 1 : 2,
      publishedFile,
      journal.targets,
      compensationErrorCode(
        rollback.outcome,
        "CONFIG_TRANSACTION_APPLY_FAILED",
      ),
      rollback.issue ??
        `no-op precondition could not be revalidated: ${errorText(error)}`,
    );
  }
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index]!;
      if (!item.plan) continue;
      item.journal.state = "applying";
      journal.state = "applying";
      writeJournal(publishedFile, journal);
      const applied = applyFileChange(item.plan);
      if (
        applied.state !== "applied" ||
        !sameImage(readImage(item.journal.configPath), item.journal.after)
      ) {
        item.journal.issue =
          applied.state === "applied"
            ? "published config bytes differ from the intended postimage"
            : applied.state === "noop"
              ? "client config became an unexpected no-op during apply"
              : applied.reason;
        const applyIssue = `${item.journal.clientName}: ${item.journal.issue}`;
        journal.issue = applyIssue;
        const rollback = compensate(publishedFile, journal);
        return result(
          "apply",
          rollback.outcome,
          rollback.outcome === "failed-rolled-back" ? 1 : 2,
          publishedFile,
          journal.targets,
          compensationErrorCode(
            rollback.outcome,
            "CONFIG_TRANSACTION_APPLY_FAILED",
          ),
          rollback.issue ?? applyIssue,
        );
      }
      item.journal.state = "applied";
      item.applyResult = {
        state: "applied",
        clientId: item.journal.clientId,
        clientName: item.journal.clientName,
        serverName: SERVER_NAME,
        desired: item.journal.desired,
        operation: item.journal.desired === "present" ? "register" : "remove",
        pathState: "known",
        file: item.journal.configPath,
        durability: applied.durability,
        ...(applied.warning === undefined ? {} : { warning: applied.warning }),
      };
      delete item.journal.issue;
      writeJournal(publishedFile, journal);
    }
    journal.state = "applied";
    delete journal.issue;
    writeJournal(publishedFile, journal);
    const clientResults: ApplyResult[] = prepared.map((item) => {
      if (item.plan === undefined) return noopResult(item);
      if (item.applyResult === undefined)
        throw new Error(
          `${item.journal.clientName}: transaction result invariant is missing an applied result`,
        );
      return item.applyResult;
    });
    return result(
      "apply",
      "applied",
      0,
      publishedFile,
      journal.targets,
      undefined,
      undefined,
      clientResults,
    );
  } catch (error) {
    const applyIssue = `client configuration apply was interrupted: ${errorText(error)}`;
    journal.issue = applyIssue;
    try {
      const rollback = compensate(publishedFile, journal);
      return result(
        "apply",
        rollback.outcome,
        rollback.outcome === "failed-rolled-back" ? 1 : 2,
        publishedFile,
        journal.targets,
        compensationErrorCode(
          rollback.outcome,
          "CONFIG_TRANSACTION_APPLY_FAILED",
        ),
        rollback.issue ?? applyIssue,
      );
    } catch (rollbackError) {
      return result(
        "apply",
        "rollback-incomplete",
        2,
        publishedFile,
        journal.targets,
        "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
        `${applyIssue}; rollback journal update failed: ${errorText(rollbackError)}`,
      );
    }
  }
}

export function rollbackConfigTransaction(
  options: RollbackConfigTransactionOptions,
): ConfigTransactionResult {
  let file: string | undefined;
  try {
    const directory = openJournalDirectory(options.journalDirectory);
    const candidateFile = journalPath(directory);
    const journal = readJournal(candidateFile);
    file = candidateFile;
    const rollback = compensate(file, journal);
    return result(
      "rollback",
      rollback.outcome,
      rollback.outcome === "failed-rolled-back" ? 0 : 2,
      file,
      journal.targets,
      rollback.outcome === "failed-rolled-back"
        ? undefined
        : rollback.outcome === "journal-persistence-unknown"
          ? "CONFIG_TRANSACTION_JOURNAL_PERSISTENCE_UNKNOWN"
          : "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
      rollback.issue,
    );
  } catch (error) {
    return result(
      "rollback",
      "journal-unavailable",
      1,
      file,
      [],
      "CONFIG_TRANSACTION_JOURNAL_UNAVAILABLE",
      errorText(error),
    );
  }
}

export function serializeConfigTransactionResult(
  value: ConfigTransactionResult,
): string {
  const { exitCode: _exitCode, clientResults: _clientResults, ...wire } = value;
  return `${JSON.stringify(wire)}\n`;
}
