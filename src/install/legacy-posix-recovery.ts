import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const RECEIPT_LEAF = ".sana-mcp-install-v1";
const INSTALL_LOCK_LEAF = ".sana-mcp-install-lock";
const PATH_LOCK_LEAF = ".sana-mcp-installer-path.lock";
const JOURNAL_LEAF = ".sana-mcp-legacy-posix-recovery.json";
const JOURNAL_TEMP_LEAF = `${JOURNAL_LEAF}.tmp`;
const GUARD_LEAF = ".sana-mcp-legacy-posix-recovery.lock";
const QUARANTINE_PREFIX = ".sana-mcp-legacy-posix-recovery.";
const JOURNAL_FORMAT = "sana-mcp-legacy-posix-recovery-v1";
const EVIDENCE_FORMAT = "sana-mcp-legacy-posix-evidence-v1";
const RESULT_FORMAT = "sana-mcp-legacy-posix-recovery-result-v1";
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 512 * 1024;
const PARENT_EXIT_TIMEOUT_MS = 5_000;
// v0.4.17 publishes these local artifacts sequentially. Allow slow filesystems
// to cross second boundaries without accepting artifacts from separate runs.
const MAX_ARTIFACT_PUBLICATION_SPREAD_SECONDS = 30;
// WSL can shift its derived boot wall clock while a process remains blocked.
// The exact footprint and process tree remain authoritative; this bound only
// rejects processes from a clearly different installer session.
const SYNC_COHORT_TOLERANCE_SECONDS = 60 * 60;
// v0.4.17's installer downloads and retries were bounded. This excludes an
// unrelated long-lived shell while retaining slow but finite installer runs.
const MAX_INSTALLER_LIFETIME_SECONDS = 60 * 60;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const LEGACY_ASSET_NAMES = Object.freeze({
  "bun-linux-x64": "sana-mcp-linux-x64",
  "bun-linux-x64-musl": "sana-mcp-linux-x64-musl",
  "bun-linux-arm64": "sana-mcp-linux-arm64",
  "bun-linux-arm64-musl": "sana-mcp-linux-arm64-musl",
} as const);

export type LegacyPosixReleaseTarget = keyof typeof LEGACY_ASSET_NAMES;

export interface LegacyPosixReleaseIdentity {
  readonly version: "0.4.17";
  readonly tag: "v0.4.17";
  readonly target: LegacyPosixReleaseTarget;
  readonly sourceCommit: "98947228419b354c80f73461123cd1cd2e5a23e9";
  readonly installerProtocol: 1;
  readonly lifecycleProtocol: 1;
  readonly inspectProtocol: 1;
  readonly stateCompatibility: 1;
  readonly semanticCapability: "bundled";
  readonly assetName: (typeof LEGACY_ASSET_NAMES)[LegacyPosixReleaseTarget];
  readonly sha256: string;
}

function legacyReleaseIdentity(
  target: LegacyPosixReleaseTarget,
  digest: string,
): Readonly<LegacyPosixReleaseIdentity> {
  return Object.freeze({
    version: "0.4.17",
    tag: "v0.4.17",
    target,
    sourceCommit: "98947228419b354c80f73461123cd1cd2e5a23e9",
    installerProtocol: 1,
    lifecycleProtocol: 1,
    inspectProtocol: 1,
    stateCompatibility: 1,
    semanticCapability: "bundled",
    assetName: LEGACY_ASSET_NAMES[target],
    sha256: digest,
  });
}

const OFFICIAL_LEGACY_RELEASES: Readonly<
  Record<string, Readonly<LegacyPosixReleaseIdentity>>
> = Object.freeze({
  "4374c217c8f22e1430b2ccfd46d30a585655aa166503e8c388f6c7d45e356a70":
    legacyReleaseIdentity(
      "bun-linux-x64",
      "4374c217c8f22e1430b2ccfd46d30a585655aa166503e8c388f6c7d45e356a70",
    ),
  "2221f2256444dc396f2f133ecfb90e1ff3590e4f87e8c64277a826e2ada95b0e":
    legacyReleaseIdentity(
      "bun-linux-x64-musl",
      "2221f2256444dc396f2f133ecfb90e1ff3590e4f87e8c64277a826e2ada95b0e",
    ),
  "c5ba9d1b0e6f1b0b89f873f9efa4a8fb76d112241cc6be5f16de64ace56f8bd7":
    legacyReleaseIdentity(
      "bun-linux-arm64",
      "c5ba9d1b0e6f1b0b89f873f9efa4a8fb76d112241cc6be5f16de64ace56f8bd7",
    ),
  "875036b02f616452ed938d703022b3fad414d61e74f5c6c691bd5adcf81b7e4b":
    legacyReleaseIdentity(
      "bun-linux-arm64-musl",
      "875036b02f616452ed938d703022b3fad414d61e74f5c6c691bd5adcf81b7e4b",
    ),
});

type RecoveryPhase =
  | "preparing"
  | "prepared"
  | "processes-killed"
  | "binary-moved"
  | "profile-moved"
  | "install-lock-moved"
  | "path-lock-moved"
  | "quarantined"
  | "cleanup";

type FailureKind = "blocked" | "error";

export type LegacyPosixRecoveryCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_BOUNDARY"
  | "AMBIGUOUS_FOOTPRINT"
  | "INVALID_ARTIFACT"
  | "EVIDENCE_CHANGED"
  | "RECEIPT_PRESENT"
  | "UNRECOGNIZED_LEGACY_BINARY"
  | "RELEASE_VERIFICATION_FAILED"
  | "PROCESS_EVIDENCE_INVALID"
  | "CONFIRMATION_MISMATCH"
  | "RECOVERY_BUSY"
  | "LOCK_UNAVAILABLE"
  | "JOURNAL_INVALID"
  | "QUARANTINE_CONFLICT"
  | "PROCESS_TERMINATION_FAILED"
  | "DURABILITY_FAILED"
  | "RECOVERY_FAILED";

export interface LegacyPosixRecoveryOptions {
  readonly home: string;
  readonly installDir: string;
}

export interface LegacyPosixRecoverOptions extends LegacyPosixRecoveryOptions {
  readonly fingerprint?: string;
}

export interface LegacyLinuxProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly command: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly state: string;
  readonly startToken: string;
  readonly startedAtSecond: number;
}

export interface LegacyProcessProvider {
  scanSameUid(uid: number): Promise<readonly LegacyLinuxProcess[]>;
  read(pid: number): Promise<LegacyLinuxProcess | undefined>;
}

export interface LegacyRecoveryGuard {
  release(): void;
}

export interface LegacyPosixRecoveryDependencies {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly linuxProcessClock?: Readonly<{
    ticksPerSecond: bigint;
    bootTimeSecond: bigint;
  }>;
  readonly resolveRelease?: (
    sha256: string,
  ) => Readonly<LegacyPosixReleaseIdentity> | undefined;
  readonly processProvider?: LegacyProcessProvider;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForParentExit?: (
    process: Readonly<ProcessEvidence>,
    provider: LegacyProcessProvider,
  ) => Promise<void>;
  readonly acquireGuard?: (file: string, uid: number) => LegacyRecoveryGuard;
  readonly randomUUID?: () => string;
  readonly checkpoint?: (name: string) => Promise<void> | void;
}

export type LegacyPosixInspectionResult =
  | Readonly<{ status: "none" }>
  | Readonly<{
      status: "confirmation-required";
      fingerprint: string;
      release: Readonly<LegacyPosixReleaseIdentity>;
      artifacts: readonly string[];
      processes: Readonly<{ shellPid: number; syncPid: number }>;
    }>
  | Readonly<{
      status: "pending";
      fingerprint: string;
      phase: RecoveryPhase;
      journal: string;
    }>
  | Readonly<{
      status: "blocked" | "error";
      code: LegacyPosixRecoveryCode;
      message: string;
    }>;

export type LegacyPosixRecoveryResult =
  | LegacyPosixInspectionResult
  | Readonly<{
      status: "completed";
      fingerprint: string;
      recoveredArtifacts: readonly string[];
    }>;

interface StatIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface FileEvidence {
  readonly path: string;
  readonly stat: StatIdentity;
  readonly sha256: string;
}

interface LockEvidence {
  readonly path: string;
  readonly stat: StatIdentity;
  readonly sha256: string;
  readonly token: FileEvidence & Readonly<{ name: string }>;
}

interface AbsentProfileEvidence {
  readonly path: string;
  readonly exists: false;
}

interface PresentProfileEvidence extends FileEvidence {
  readonly exists: true;
}

type ProfileEvidence = AbsentProfileEvidence | PresentProfileEvidence;

interface ProcessEvidence {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly command: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly state: string;
  readonly startToken: string;
  readonly startedAtSecond: number;
}

interface RecoveryEvidence {
  readonly format: typeof EVIDENCE_FORMAT;
  readonly home: string;
  readonly installDir: string;
  readonly artifactStartSecond: number;
  readonly artifactEndSecond: number;
  readonly homeBoundary: StatIdentity;
  readonly installBoundary: StatIdentity;
  readonly binary: FileEvidence;
  readonly stagedProfile: FileEvidence;
  readonly canonicalProfile: ProfileEvidence;
  readonly installLock: LockEvidence;
  readonly pathLock: LockEvidence;
  readonly shell: ProcessEvidence;
  readonly sync: ProcessEvidence;
  readonly release: LegacyPosixReleaseIdentity;
}

interface MoveRecord {
  readonly name: "binary" | "profile" | "install-lock" | "path-lock";
  readonly source: string;
  readonly destination: string;
  readonly kind: "file" | "lock";
  readonly stat: StatIdentity;
  readonly sha256: string;
}

interface QuarantineIdentity {
  readonly install: StatIdentity | null;
  readonly home: StatIdentity | null;
}

interface RecoveryJournal {
  readonly format: typeof JOURNAL_FORMAT;
  readonly transactionId: string;
  readonly home: string;
  readonly installDir: string;
  readonly fingerprint: string;
  readonly confirmation: true;
  phase: RecoveryPhase;
  readonly installQuarantine: string;
  readonly homeQuarantine: string;
  quarantineIdentity: QuarantineIdentity;
  readonly evidence: RecoveryEvidence;
  readonly moves: readonly MoveRecord[];
}

interface ResolvedDependencies {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly resolveRelease: (
    sha256: string,
  ) => Readonly<LegacyPosixReleaseIdentity> | undefined;
  readonly processProvider: LegacyProcessProvider;
  readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForParentExit: (
    process: Readonly<ProcessEvidence>,
    provider: LegacyProcessProvider,
  ) => Promise<void>;
  readonly acquireGuard: (file: string, uid: number) => LegacyRecoveryGuard;
  readonly randomUUID: () => string;
  readonly checkpoint: (name: string) => Promise<void>;
}

class RecoveryFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: LegacyPosixRecoveryCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyPosixRecoveryError";
  }
}

function blocked(code: LegacyPosixRecoveryCode, message: string): never {
  throw new RecoveryFailure("blocked", code, message);
}

function unavailable(
  code: LegacyPosixRecoveryCode,
  message: string,
  cause?: unknown,
): never {
  throw new RecoveryFailure(
    "error",
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function failureResult(error: unknown): Extract<
  LegacyPosixInspectionResult,
  { status: "blocked" | "error" }
> {
  if (error instanceof RecoveryFailure) {
    return { status: error.kind, code: error.code, message: error.message };
  }
  return {
    status: "error",
    code: "RECOVERY_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function lstatOptional(target: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function statIdentity(stat: fs.BigIntStats): StatIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function boundaryIdentity(stat: fs.BigIntStats): StatIdentity {
  return {
    ...statIdentity(stat),
    nlink: "0",
    size: "0",
    mtimeNs: "0",
    ctimeNs: "0",
  };
}

function sameStableStat(current: fs.BigIntStats, expected: StatIdentity): boolean {
  return (
    String(current.dev) === expected.dev &&
    String(current.ino) === expected.ino &&
    Number(current.mode & 0o7777n) === expected.mode &&
    Number(current.uid) === expected.uid &&
    Number(current.gid) === expected.gid &&
    String(current.nlink) === expected.nlink
  );
}

function sameDirectoryStat(current: fs.BigIntStats, expected: StatIdentity): boolean {
  return (
    String(current.dev) === expected.dev &&
    String(current.ino) === expected.ino &&
    Number(current.mode & 0o7777n) === expected.mode &&
    Number(current.uid) === expected.uid &&
    Number(current.gid) === expected.gid
  );
}

function sameFullStat(current: fs.BigIntStats, expected: StatIdentity): boolean {
  return (
    sameStableStat(current, expected) &&
    String(current.size) === expected.size &&
    String(current.mtimeNs) === expected.mtimeNs &&
    String(current.ctimeNs) === expected.ctimeNs
  );
}

function assertFullStat(
  target: string,
  expected: StatIdentity,
  kind: "file" | "directory",
): fs.BigIntStats {
  const current = lstatOptional(target);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    (kind === "file" ? !current.isFile() : !current.isDirectory()) ||
    !sameFullStat(current, expected)
  ) {
    blocked("EVIDENCE_CHANGED", `recovery evidence changed at ${target}`);
  }
  return current;
}

function assertStableStat(
  target: string,
  expected: StatIdentity,
  kind: "file" | "directory",
): fs.BigIntStats {
  const current = lstatOptional(target);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    (kind === "file" ? !current.isFile() : !current.isDirectory()) ||
    !(kind === "directory"
      ? sameDirectoryStat(current, expected)
      : sameStableStat(current, expected))
  ) {
    blocked("QUARANTINE_CONFLICT", `quarantined identity changed at ${target}`);
  }
  return current;
}

function openVerifiedFile(target: string, expected: fs.BigIntStats): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow === undefined) {
    unavailable("DURABILITY_FAILED", "Linux O_NOFOLLOW is unavailable");
  }
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      !sameFullStat(opened, statIdentity(expected))
    ) {
      blocked("EVIDENCE_CHANGED", `file changed while opening ${target}`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function hashDescriptor(descriptor: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (length === 0) break;
    hash.update(buffer.subarray(0, length));
    position += length;
  }
  return hash.digest("hex");
}

function hashFileAt(target: string, expected: fs.BigIntStats): string {
  const descriptor = openVerifiedFile(target, expected);
  try {
    const digest = hashDescriptor(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatOptional(target);
    if (
      !sameFullStat(openedAfter, statIdentity(expected)) ||
      pathAfter === undefined ||
      pathAfter.isSymbolicLink() ||
      !sameFullStat(pathAfter, statIdentity(expected))
    ) {
      blocked("EVIDENCE_CHANGED", `file changed while hashing ${target}`);
    }
    return digest;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readFileAt(
  target: string,
  expected: fs.BigIntStats,
  maximumBytes: number,
): Buffer {
  if (expected.size > BigInt(maximumBytes)) {
    blocked("INVALID_ARTIFACT", `${target} exceeds the recovery size limit`);
  }
  const descriptor = openVerifiedFile(target, expected);
  try {
    const body = Buffer.alloc(Number(expected.size));
    let offset = 0;
    while (offset < body.length) {
      const length = fs.readSync(
        descriptor,
        body,
        offset,
        body.length - offset,
        offset,
      );
      if (length === 0) {
        blocked("EVIDENCE_CHANGED", `file became short while reading ${target}`);
      }
      offset += length;
    }
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatOptional(target);
    if (
      !sameFullStat(openedAfter, statIdentity(expected)) ||
      pathAfter === undefined ||
      pathAfter.isSymbolicLink() ||
      !sameFullStat(pathAfter, statIdentity(expected))
    ) {
      blocked("EVIDENCE_CHANGED", `file changed while reading ${target}`);
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function inspectBoundary(target: string, label: string, uid: number): fs.BigIntStats {
  if (
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    path.normalize(target) !== target ||
    target === path.parse(target).root
  ) {
    blocked("INVALID_BOUNDARY", `${label} must be a normalized absolute non-root path`);
  }
  const lexical = lstatOptional(target);
  if (
    lexical === undefined ||
    lexical.isSymbolicLink() ||
    !lexical.isDirectory() ||
    Number(lexical.uid) !== uid
  ) {
    blocked("INVALID_BOUNDARY", `${label} must be a same-owner real directory`);
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch (error) {
    blocked(
      "INVALID_BOUNDARY",
      `${label} could not be resolved canonically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonical !== target) {
    blocked("INVALID_BOUNDARY", `${label} must not traverse symbolic-link aliases`);
  }
  return lexical;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function inspectRoots(
  options: LegacyPosixRecoveryOptions,
  dependencies: ResolvedDependencies,
): { home: fs.BigIntStats; install: fs.BigIntStats } {
  if (dependencies.platform !== "linux") {
    blocked(
      "UNSUPPORTED_PLATFORM",
      "legacy stuck-sync recovery is available only on Linux and WSL",
    );
  }
  const home = inspectBoundary(options.home, "HOME", dependencies.uid);
  const install = inspectBoundary(
    options.installDir,
    "installation directory",
    dependencies.uid,
  );
  if (
    options.home === options.installDir ||
    within(options.installDir, options.home) ||
    options.installDir === path.join(options.home, ".sana-mcp") ||
    within(path.join(options.home, ".sana-mcp"), options.installDir)
  ) {
    blocked(
      "INVALID_BOUNDARY",
      "installation directory overlaps HOME or protected Sana state",
    );
  }
  if (/[':\r\n]/u.test(options.installDir)) {
    blocked(
      "INVALID_BOUNDARY",
      "installation directory cannot be represented by the legacy PATH block",
    );
  }
  return { home, install };
}

function requireOwnedRegular(
  target: string,
  uid: number,
  label: string,
  singleLink = true,
): fs.BigIntStats {
  const stat = lstatOptional(target);
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    Number(stat.uid) !== uid ||
    (singleLink && stat.nlink !== 1n)
  ) {
    blocked("INVALID_ARTIFACT", `${label} is not an owned regular non-symlink file`);
  }
  return stat;
}

function inspectLock(target: string, uid: number, label: string): LockEvidence {
  const stat = lstatOptional(target);
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    Number(stat.uid) !== uid ||
    Number(stat.mode & 0o777n) !== 0o700
  ) {
    blocked("INVALID_ARTIFACT", `${label} is not an exact private lock directory`);
  }
  const entries = fs.readdirSync(target);
  if (entries.length !== 1 || !/^owner\.[A-Za-z0-9]{6}$/u.test(entries[0]!)) {
    blocked("INVALID_ARTIFACT", `${label} does not contain exactly one owner token`);
  }
  const name = entries[0]!;
  const tokenPath = path.join(target, name);
  const tokenStat = requireOwnedRegular(tokenPath, uid, `${label} owner token`);
  if (Number(tokenStat.mode & 0o777n) !== 0o600) {
    blocked("INVALID_ARTIFACT", `${label} owner token is not private`);
  }
  const tokenBody = readFileAt(tokenPath, tokenStat, 1024);
  if (!tokenBody.equals(Buffer.from(`${name}\n`, "utf8"))) {
    blocked("INVALID_ARTIFACT", `${label} owner token content is not exact`);
  }
  const tokenDigest = sha256(tokenBody);
  if (
    !sameFullStat(fs.lstatSync(target, { bigint: true }), statIdentity(stat)) ||
    !sameFullStat(
      fs.lstatSync(tokenPath, { bigint: true }),
      statIdentity(tokenStat),
    )
  ) {
    blocked("EVIDENCE_CHANGED", `${label} changed while it was inspected`);
  }
  return {
    path: target,
    stat: statIdentity(stat),
    sha256: sha256(`${name}\n${tokenDigest}\n`),
    token: {
      name,
      path: tokenPath,
      stat: statIdentity(tokenStat),
      sha256: tokenDigest,
    },
  };
}

function stagedProfileCandidates(home: string): string[] {
  return fs
    .readdirSync(home)
    .filter((entry) => /^\.(?:bashrc|zshrc|profile)\.sana-mcp\./u.test(entry))
    .map((entry) => path.join(home, entry));
}

function profileForStage(stage: string, home: string): string {
  const match = /^\.(bashrc|zshrc)\.sana-mcp\.[A-Za-z0-9]{6}$/u.exec(
    path.basename(stage),
  );
  if (match === null) {
    blocked("INVALID_ARTIFACT", "staged profile has an invalid legacy name");
  }
  return path.join(home, `.${match[1]}`);
}

function expectedStagedProfile(
  canonical: Buffer | undefined,
  installDir: string,
): Buffer {
  const block = Buffer.from(
    [
      "# >>> sana-mcp installer >>>",
      `export PATH='${installDir}':"$PATH"`,
      "# <<< sana-mcp installer <<<",
      "",
    ].join("\n"),
    "utf8",
  );
  if (canonical === undefined) return block;
  const separator =
    canonical.length > 0 && canonical[canonical.length - 1] !== 0x0a
      ? Buffer.from("\n\n")
      : Buffer.from("\n");
  return Buffer.concat([canonical, separator, block]);
}

function inspectCanonicalProfile(
  target: string,
  uid: number,
): { evidence: ProfileEvidence; body?: Buffer; mode?: number } {
  const stat = lstatOptional(target);
  if (stat === undefined) return { evidence: { path: target, exists: false } };
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    Number(stat.uid) !== uid ||
    stat.nlink !== 1n
  ) {
    blocked("INVALID_ARTIFACT", "canonical shell profile is not an owned regular file");
  }
  const body = readFileAt(target, stat, MAX_PROFILE_BYTES);
  if (body.includes(0)) {
    blocked("INVALID_ARTIFACT", "canonical shell profile contains non-text NUL bytes");
  }
  const text = body.toString("utf8");
  if (
    text.split("\n").some(
      (line) =>
        line.includes("# >>> sana-mcp installer >>>") ||
        line.includes("# <<< sana-mcp installer <<<"),
    )
  ) {
    blocked(
      "INVALID_ARTIFACT",
      "canonical shell profile already contains a managed PATH marker",
    );
  }
  return {
    evidence: {
      path: target,
      exists: true,
      stat: statIdentity(stat),
      sha256: sha256(body),
    },
    body,
    mode: Number(stat.mode & 0o777n),
  };
}

const RELEASE_IDENTITY_KEYS = [
  "version",
  "tag",
  "target",
  "sourceCommit",
  "installerProtocol",
  "lifecycleProtocol",
  "inspectProtocol",
  "stateCompatibility",
  "semanticCapability",
  "assetName",
  "sha256",
] as const;

function isLegacyReleaseTarget(value: unknown): value is LegacyPosixReleaseTarget {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(LEGACY_ASSET_NAMES, value)
  );
}

function isExactLegacyReleaseIdentity(
  value: unknown,
  digest: string,
): value is LegacyPosixReleaseIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expectedKeys = [...RELEASE_IDENTITY_KEYS].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    item.version === "0.4.17" &&
    item.tag === "v0.4.17" &&
    isLegacyReleaseTarget(item.target) &&
    item.sourceCommit === "98947228419b354c80f73461123cd1cd2e5a23e9" &&
    item.installerProtocol === 1 &&
    item.lifecycleProtocol === 1 &&
    item.inspectProtocol === 1 &&
    item.stateCompatibility === 1 &&
    item.semanticCapability === "bundled" &&
    item.assetName === LEGACY_ASSET_NAMES[item.target] &&
    item.sha256 === digest &&
    /^[a-f0-9]{64}$/u.test(digest)
  );
}

function resolveLegacyRelease(
  digest: string,
  resolver: ResolvedDependencies["resolveRelease"],
): LegacyPosixReleaseIdentity {
  let release: Readonly<LegacyPosixReleaseIdentity> | undefined;
  try {
    release = resolver(digest);
  } catch (error) {
    unavailable(
      "RELEASE_VERIFICATION_FAILED",
      "legacy release recognition failed",
      error,
    );
  }
  if (release === undefined) {
    blocked(
      "UNRECOGNIZED_LEGACY_BINARY",
      "receiptless binary digest is not an official recoverable v0.4.17 Linux asset",
    );
  }
  if (!isExactLegacyReleaseIdentity(release, digest)) {
    blocked(
      "RELEASE_VERIFICATION_FAILED",
      "legacy release resolver returned an invalid identity",
    );
  }
  return Object.freeze({ ...release });
}

function processEvidence(process: LegacyLinuxProcess): ProcessEvidence {
  return {
    pid: process.pid,
    ppid: process.ppid,
    uid: process.uid,
    command: process.command,
    executable: process.executable,
    argv: [...process.argv],
    state: process.state,
    startToken: process.startToken,
    startedAtSecond: process.startedAtSecond,
  };
}

function exactSync(process: LegacyLinuxProcess, uid: number): boolean {
  return (
    process.uid === uid &&
    process.command === "sync" &&
    path.basename(process.executable) === "sync" &&
    process.argv.length === 1 &&
    path.basename(process.argv[0]!) === "sync"
  );
}

function exactShell(process: LegacyLinuxProcess, uid: number): boolean {
  const shells = new Set(["sh", "dash", "bash"]);
  return (
    process.uid === uid &&
    shells.has(process.command) &&
    shells.has(path.basename(process.executable)) &&
    process.argv.length >= 1 &&
    shells.has(path.basename(process.argv[0]!)) &&
    process.state !== "Z" &&
    process.state !== "X"
  );
}

function processTimingMatchesCohort(
  shell: Pick<LegacyLinuxProcess, "startedAtSecond">,
  sync: Pick<LegacyLinuxProcess, "startedAtSecond">,
  artifactStartSecond: number,
  artifactEndSecond: number,
): boolean {
  const installerLifetime = sync.startedAtSecond - shell.startedAtSecond;
  return (
    Number.isSafeInteger(shell.startedAtSecond) &&
    Number.isSafeInteger(sync.startedAtSecond) &&
    Number.isSafeInteger(artifactStartSecond) &&
    Number.isSafeInteger(artifactEndSecond) &&
    artifactEndSecond >= artifactStartSecond &&
    artifactEndSecond - artifactStartSecond <=
      MAX_ARTIFACT_PUBLICATION_SPREAD_SECONDS &&
    sync.startedAtSecond >=
      artifactStartSecond - SYNC_COHORT_TOLERANCE_SECONDS &&
    sync.startedAtSecond <= artifactEndSecond + SYNC_COHORT_TOLERANCE_SECONDS &&
    installerLifetime >= 0 &&
    installerLifetime <= MAX_INSTALLER_LIFETIME_SECONDS
  );
}

async function inspectProcesses(
  dependencies: ResolvedDependencies,
  artifactStartSecond: number,
  artifactEndSecond: number,
): Promise<{ shell: ProcessEvidence; sync: ProcessEvidence }> {
  let processes: readonly LegacyLinuxProcess[];
  try {
    processes = await dependencies.processProvider.scanSameUid(dependencies.uid);
  } catch (error) {
    unavailable(
      "PROCESS_EVIDENCE_INVALID",
      "same-UID process evidence could not be scanned",
      error,
    );
  }
  const candidates = processes.flatMap((sync) => {
    if (!exactSync(sync, dependencies.uid) || sync.state !== "D") return [];
    const parents = processes.filter(
      (process) =>
        process.pid === sync.ppid && exactShell(process, dependencies.uid),
    );
    if (parents.length !== 1) return [];
    const shell = parents[0]!;
    return processTimingMatchesCohort(
      shell,
      sync,
      artifactStartSecond,
      artifactEndSecond,
    )
      ? [{ shell, sync }]
      : [];
  });
  if (candidates.length !== 1) {
    blocked(
      "PROCESS_EVIDENCE_INVALID",
      `expected exactly one qualifying legacy sync/shell pair, found ${candidates.length}`,
    );
  }
  const { shell, sync } = candidates[0]!;
  return { shell: processEvidence(shell), sync: processEvidence(sync) };
}

function wholeSecond(stat: StatIdentity): number {
  const second = BigInt(stat.mtimeNs) / 1_000_000_000n;
  const value = Number(second);
  if (!Number.isSafeInteger(value)) {
    blocked("INVALID_ARTIFACT", "artifact mtime is outside the supported range");
  }
  return value;
}

function fingerprintFor(evidence: RecoveryEvidence): string {
  const stableProcess = (
    process: ProcessEvidence,
  ): Omit<ProcessEvidence, "startedAtSecond"> => ({
    pid: process.pid,
    ppid: process.ppid,
    uid: process.uid,
    command: process.command,
    executable: process.executable,
    argv: process.argv,
    state: process.state,
    startToken: process.startToken,
  });
  return sha256(
    JSON.stringify({
      ...evidence,
      shell: stableProcess(evidence.shell),
      sync: stableProcess(evidence.sync),
    }),
  );
}

function inspectRecoveryIndicators(home: string, installDir: string): boolean {
  const installLock = lstatOptional(path.join(installDir, INSTALL_LOCK_LEAF));
  const pathLock = lstatOptional(path.join(home, PATH_LOCK_LEAF));
  const stages = stagedProfileCandidates(home);
  return installLock !== undefined || pathLock !== undefined || stages.length > 0;
}

function orphanQuarantines(home: string, installDir: string): string[] {
  const found: string[] = [];
  for (const root of new Set([home, installDir])) {
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith(QUARANTINE_PREFIX) && entry !== GUARD_LEAF) {
        found.push(path.join(root, entry));
      }
    }
  }
  return found;
}

function revalidateInitialEvidence(
  evidence: RecoveryEvidence,
  dependencies: ResolvedDependencies,
): void {
  const roots = inspectRoots(evidence, dependencies);
  if (
    !sameDirectoryStat(roots.home, evidence.homeBoundary) ||
    !sameDirectoryStat(roots.install, evidence.installBoundary)
  ) {
    blocked("EVIDENCE_CHANGED", "recovery root identity changed during inspection");
  }
  if (lstatOptional(path.join(evidence.installDir, RECEIPT_LEAF)) !== undefined) {
    blocked("RECEIPT_PRESENT", "an installer receipt appeared during inspection");
  }
  const candidates = stagedProfileCandidates(evidence.home);
  if (candidates.length !== 1 || candidates[0] !== evidence.stagedProfile.path) {
    blocked("EVIDENCE_CHANGED", "staged profile inventory changed during inspection");
  }
  for (const file of [evidence.binary, evidence.stagedProfile]) {
    const stat = assertFullStat(file.path, file.stat, "file");
    if (hashFileAt(file.path, stat) !== file.sha256) {
      blocked("EVIDENCE_CHANGED", `artifact digest changed at ${file.path}`);
    }
  }
  const installLock = inspectLock(
    evidence.installLock.path,
    dependencies.uid,
    "install lock",
  );
  const pathLock = inspectLock(
    evidence.pathLock.path,
    dependencies.uid,
    "HOME installer lock",
  );
  if (
    JSON.stringify(installLock) !== JSON.stringify(evidence.installLock) ||
    JSON.stringify(pathLock) !== JSON.stringify(evidence.pathLock)
  ) {
    blocked("EVIDENCE_CHANGED", "installer lock evidence changed during inspection");
  }
  assertCanonicalProfile(evidence.canonicalProfile);
}

async function buildEvidence(
  options: LegacyPosixRecoveryOptions,
  dependencies: ResolvedDependencies,
): Promise<RecoveryEvidence> {
  const roots = inspectRoots(options, dependencies);
  const receipt = path.join(options.installDir, RECEIPT_LEAF);
  if (lstatOptional(receipt) !== undefined) {
    blocked("RECEIPT_PRESENT", "an installer receipt appeared beside the binary");
  }
  const unexpectedInstallerArtifacts = fs
    .readdirSync(options.installDir)
    .filter(
      (entry) =>
        entry.startsWith(".sana-mcp") && entry !== INSTALL_LOCK_LEAF,
    );
  if (unexpectedInstallerArtifacts.length > 0) {
    blocked(
      "AMBIGUOUS_FOOTPRINT",
      "installation directory contains additional installer artifacts",
    );
  }
  const installLock = inspectLock(
    path.join(options.installDir, INSTALL_LOCK_LEAF),
    dependencies.uid,
    "install lock",
  );
  const pathLock = inspectLock(
    path.join(options.home, PATH_LOCK_LEAF),
    dependencies.uid,
    "HOME installer lock",
  );
  const candidates = stagedProfileCandidates(options.home);
  if (candidates.length !== 1) {
    blocked(
      "AMBIGUOUS_FOOTPRINT",
      `expected exactly one staged profile, found ${candidates.length}`,
    );
  }
  const stagedPath = candidates[0]!;
  const stagedStat = requireOwnedRegular(
    stagedPath,
    dependencies.uid,
    "staged shell profile",
  );
  const stagedBody = readFileAt(stagedPath, stagedStat, MAX_PROFILE_BYTES);
  const canonicalPath = profileForStage(stagedPath, options.home);
  const canonical = inspectCanonicalProfile(canonicalPath, dependencies.uid);
  if (
    canonical.mode !== undefined &&
    Number(stagedStat.mode & 0o777n) !== canonical.mode
  ) {
    blocked("INVALID_ARTIFACT", "staged profile mode does not match its canonical source");
  }
  if (
    canonical.mode === undefined &&
    Number(stagedStat.mode & 0o777n) !== 0o600
  ) {
    blocked("INVALID_ARTIFACT", "new staged profile is not private");
  }
  if (!stagedBody.equals(expectedStagedProfile(canonical.body, options.installDir))) {
    blocked(
      "INVALID_ARTIFACT",
      "staged profile is not the exact legacy installer transformation",
    );
  }
  const binaryPath = path.join(options.installDir, "sana-mcp");
  const binaryStat = requireOwnedRegular(
    binaryPath,
    dependencies.uid,
    "installed binary",
  );
  if ((binaryStat.mode & 0o111n) === 0n) {
    blocked("INVALID_ARTIFACT", "installed binary is not executable");
  }
  const binaryDigest = hashFileAt(binaryPath, binaryStat);
  const artifactStats = [
    statIdentity(binaryStat),
    statIdentity(stagedStat),
    installLock.stat,
    installLock.token.stat,
    pathLock.stat,
    pathLock.token.stat,
  ];
  const artifactSeconds = artifactStats.map(wholeSecond);
  const artifactStartSecond = Math.min(...artifactSeconds);
  const artifactEndSecond = Math.max(...artifactSeconds);
  if (
    artifactEndSecond - artifactStartSecond >
    MAX_ARTIFACT_PUBLICATION_SPREAD_SECONDS
  ) {
    blocked(
      "INVALID_ARTIFACT",
      "legacy artifact publication times exceed the allowed launch window",
    );
  }
  const release = resolveLegacyRelease(binaryDigest, dependencies.resolveRelease);
  assertFullStat(binaryPath, statIdentity(binaryStat), "file");
  assertFullStat(stagedPath, statIdentity(stagedStat), "file");
  const processes = await inspectProcesses(
    dependencies,
    artifactStartSecond,
    artifactEndSecond,
  );
  const evidence: RecoveryEvidence = {
    format: EVIDENCE_FORMAT,
    home: options.home,
    installDir: options.installDir,
    artifactStartSecond,
    artifactEndSecond,
    homeBoundary: boundaryIdentity(roots.home),
    installBoundary: boundaryIdentity(roots.install),
    binary: {
      path: binaryPath,
      stat: statIdentity(binaryStat),
      sha256: binaryDigest,
    },
    stagedProfile: {
      path: stagedPath,
      stat: statIdentity(stagedStat),
      sha256: sha256(stagedBody),
    },
    canonicalProfile: canonical.evidence,
    installLock,
    pathLock,
    shell: processes.shell,
    sync: processes.sync,
    release,
  };
  revalidateInitialEvidence(evidence, dependencies);
  return evidence;
}

function journalFile(home: string): string {
  return path.join(home, JOURNAL_LEAF);
}

function guardFile(home: string): string {
  return path.join(home, GUARD_LEAF);
}

function journalTemporaryFile(home: string): string {
  return path.join(home, JOURNAL_TEMP_LEAF);
}

function strictKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    blocked("JOURNAL_INVALID", `${label} has unknown or missing fields`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    blocked("JOURNAL_INVALID", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function validStat(value: unknown, label: string): StatIdentity {
  const item = objectValue(value, label);
  strictKeys(
    item,
    ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"],
    label,
  );
  for (const key of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"] as const) {
    if (typeof item[key] !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(item[key])) {
      blocked("JOURNAL_INVALID", `${label}.${key} is invalid`);
    }
  }
  for (const key of ["mode", "uid", "gid"] as const) {
    if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0) {
      blocked("JOURNAL_INVALID", `${label}.${key} is invalid`);
    }
  }
  return item as unknown as StatIdentity;
}

function validDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    blocked("JOURNAL_INVALID", `${label} is not a SHA-256 digest`);
  }
  return value;
}

function validAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    blocked("JOURNAL_INVALID", `${label} is not a canonical absolute path`);
  }
  return value;
}

function validFileEvidence(value: unknown, label: string): FileEvidence {
  const item = objectValue(value, label);
  strictKeys(item, ["path", "stat", "sha256"], label);
  return {
    path: validAbsolute(item.path, `${label}.path`),
    stat: validStat(item.stat, `${label}.stat`),
    sha256: validDigest(item.sha256, `${label}.sha256`),
  };
}

function validLockEvidence(value: unknown, label: string): LockEvidence {
  const item = objectValue(value, label);
  strictKeys(item, ["path", "stat", "sha256", "token"], label);
  const tokenObject = objectValue(item.token, `${label}.token`);
  strictKeys(tokenObject, ["name", "path", "stat", "sha256"], `${label}.token`);
  if (
    typeof tokenObject.name !== "string" ||
    !/^owner\.[A-Za-z0-9]{6}$/u.test(tokenObject.name)
  ) {
    blocked("JOURNAL_INVALID", `${label}.token.name is invalid`);
  }
  const lock: LockEvidence = {
    path: validAbsolute(item.path, `${label}.path`),
    stat: validStat(item.stat, `${label}.stat`),
    sha256: validDigest(item.sha256, `${label}.sha256`),
    token: {
      name: tokenObject.name,
      path: validAbsolute(tokenObject.path, `${label}.token.path`),
      stat: validStat(tokenObject.stat, `${label}.token.stat`),
      sha256: validDigest(tokenObject.sha256, `${label}.token.sha256`),
    },
  };
  if (lock.token.path !== path.join(lock.path, lock.token.name)) {
    blocked("JOURNAL_INVALID", `${label} token escapes its lock directory`);
  }
  return lock;
}

function validProcessEvidence(value: unknown, label: string): ProcessEvidence {
  const item = objectValue(value, label);
  strictKeys(
    item,
    [
      "pid",
      "ppid",
      "uid",
      "command",
      "executable",
      "argv",
      "state",
      "startToken",
      "startedAtSecond",
    ],
    label,
  );
  if (
    !Number.isSafeInteger(item.pid) ||
    (item.pid as number) <= 0 ||
    !Number.isSafeInteger(item.ppid) ||
    (item.ppid as number) < 0 ||
    !Number.isSafeInteger(item.uid) ||
    (item.uid as number) < 0 ||
    !Number.isSafeInteger(item.startedAtSecond) ||
    typeof item.command !== "string" ||
    typeof item.executable !== "string" ||
    !path.isAbsolute(item.executable) ||
    typeof item.state !== "string" ||
    !/^[A-Z]$/u.test(item.state) ||
    typeof item.startToken !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(item.startToken) ||
    !Array.isArray(item.argv) ||
    item.argv.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    blocked("JOURNAL_INVALID", `${label} is invalid`);
  }
  return item as unknown as ProcessEvidence;
}

function validReleaseEvidence(
  value: unknown,
  resolver: ResolvedDependencies["resolveRelease"],
): LegacyPosixReleaseIdentity {
  const item = objectValue(value, "journal release");
  strictKeys(item, RELEASE_IDENTITY_KEYS, "journal release");
  const digest = validDigest(item.sha256, "journal release digest");
  if (!isExactLegacyReleaseIdentity(item, digest)) {
    blocked("JOURNAL_INVALID", "journal release identity is invalid");
  }
  let official: Readonly<LegacyPosixReleaseIdentity> | undefined;
  try {
    official =
      resolver === defaultResolveRelease
        ? OFFICIAL_LEGACY_RELEASES[digest]
        : resolver(digest);
  } catch {
    blocked("JOURNAL_INVALID", "journal release identity could not be verified");
  }
  if (
    official === undefined ||
    !isExactLegacyReleaseIdentity(official, digest) ||
    RELEASE_IDENTITY_KEYS.some((key) => official[key] !== item[key])
  ) {
    blocked("JOURNAL_INVALID", "journal release identity is not officially recognized");
  }
  return item as unknown as LegacyPosixReleaseIdentity;
}

function validEvidence(
  value: unknown,
  resolver: ResolvedDependencies["resolveRelease"],
): RecoveryEvidence {
  const item = objectValue(value, "journal evidence");
  strictKeys(
    item,
    [
      "format",
      "home",
      "installDir",
      "artifactStartSecond",
      "artifactEndSecond",
      "homeBoundary",
      "installBoundary",
      "binary",
      "stagedProfile",
      "canonicalProfile",
      "installLock",
      "pathLock",
      "shell",
      "sync",
      "release",
    ],
    "journal evidence",
  );
  if (
    item.format !== EVIDENCE_FORMAT ||
    !Number.isSafeInteger(item.artifactStartSecond) ||
    !Number.isSafeInteger(item.artifactEndSecond)
  ) {
    blocked("JOURNAL_INVALID", "journal evidence header is invalid");
  }
  const canonicalObject = objectValue(item.canonicalProfile, "canonical profile");
  let canonicalProfile: ProfileEvidence;
  if (canonicalObject.exists === false) {
    strictKeys(canonicalObject, ["path", "exists"], "canonical profile");
    canonicalProfile = {
      path: validAbsolute(canonicalObject.path, "canonical profile path"),
      exists: false,
    };
  } else if (canonicalObject.exists === true) {
    strictKeys(
      canonicalObject,
      ["path", "exists", "stat", "sha256"],
      "canonical profile",
    );
    canonicalProfile = {
      path: validAbsolute(canonicalObject.path, "canonical profile path"),
      exists: true,
      stat: validStat(canonicalObject.stat, "canonical profile stat"),
      sha256: validDigest(canonicalObject.sha256, "canonical profile digest"),
    };
  } else {
    blocked("JOURNAL_INVALID", "canonical profile state is invalid");
  }
  const evidence: RecoveryEvidence = {
    format: EVIDENCE_FORMAT,
    home: validAbsolute(item.home, "evidence HOME"),
    installDir: validAbsolute(item.installDir, "evidence install directory"),
    artifactStartSecond: item.artifactStartSecond as number,
    artifactEndSecond: item.artifactEndSecond as number,
    homeBoundary: validStat(item.homeBoundary, "HOME boundary"),
    installBoundary: validStat(item.installBoundary, "install boundary"),
    binary: validFileEvidence(item.binary, "binary evidence"),
    stagedProfile: validFileEvidence(item.stagedProfile, "staged profile evidence"),
    canonicalProfile,
    installLock: validLockEvidence(item.installLock, "install lock evidence"),
    pathLock: validLockEvidence(item.pathLock, "path lock evidence"),
    shell: validProcessEvidence(item.shell, "shell evidence"),
    sync: validProcessEvidence(item.sync, "sync evidence"),
    release: validReleaseEvidence(item.release, resolver),
  };
  const owner = evidence.shell.uid;
  const artifactOwners = [
    evidence.homeBoundary.uid,
    evidence.installBoundary.uid,
    evidence.binary.stat.uid,
    evidence.stagedProfile.stat.uid,
    evidence.installLock.stat.uid,
    evidence.installLock.token.stat.uid,
    evidence.pathLock.stat.uid,
    evidence.pathLock.token.stat.uid,
    ...(evidence.canonicalProfile.exists
      ? [evidence.canonicalProfile.stat.uid]
      : []),
  ];
  const artifactSeconds = [
    evidence.binary.stat,
    evidence.stagedProfile.stat,
    evidence.installLock.stat,
    evidence.installLock.token.stat,
    evidence.pathLock.stat,
    evidence.pathLock.token.stat,
  ].map((stat) => Number(BigInt(stat.mtimeNs) / 1_000_000_000n));
  if (
    artifactSeconds.some((second) => !Number.isSafeInteger(second)) ||
    Math.min(...artifactSeconds) !== evidence.artifactStartSecond ||
    Math.max(...artifactSeconds) !== evidence.artifactEndSecond ||
    evidence.artifactEndSecond - evidence.artifactStartSecond >
      MAX_ARTIFACT_PUBLICATION_SPREAD_SECONDS ||
    evidence.binary.path !== path.join(evidence.installDir, "sana-mcp") ||
    evidence.installLock.path !== path.join(evidence.installDir, INSTALL_LOCK_LEAF) ||
    evidence.pathLock.path !== path.join(evidence.home, PATH_LOCK_LEAF) ||
    path.dirname(evidence.stagedProfile.path) !== evidence.home ||
    profileForStage(evidence.stagedProfile.path, evidence.home) !==
      evidence.canonicalProfile.path ||
    evidence.sync.ppid !== evidence.shell.pid ||
    evidence.sync.uid !== owner ||
    !exactShell(evidence.shell, owner) ||
    !exactSync(evidence.sync, owner) ||
    evidence.sync.state !== "D" ||
    !processTimingMatchesCohort(
      evidence.shell,
      evidence.sync,
      evidence.artifactStartSecond,
      evidence.artifactEndSecond,
    ) ||
    evidence.release.sha256 !== evidence.binary.sha256 ||
    artifactOwners.some((uid) => uid !== owner)
  ) {
    blocked("JOURNAL_INVALID", "journal evidence relationships are invalid");
  }
  return evidence;
}

const PHASES = new Set<RecoveryPhase>([
  "preparing",
  "prepared",
  "processes-killed",
  "binary-moved",
  "profile-moved",
  "install-lock-moved",
  "path-lock-moved",
  "quarantined",
  "cleanup",
]);

function validateJournal(
  value: unknown,
  options: LegacyPosixRecoveryOptions,
  resolver: ResolvedDependencies["resolveRelease"],
): RecoveryJournal {
  const item = objectValue(value, "recovery journal");
  strictKeys(
    item,
    [
      "format",
      "transactionId",
      "home",
      "installDir",
      "fingerprint",
      "confirmation",
      "phase",
      "installQuarantine",
      "homeQuarantine",
      "quarantineIdentity",
      "evidence",
      "moves",
    ],
    "recovery journal",
  );
  if (
    item.format !== JOURNAL_FORMAT ||
    typeof item.transactionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      item.transactionId,
    ) ||
    item.confirmation !== true ||
    typeof item.phase !== "string" ||
    !PHASES.has(item.phase as RecoveryPhase)
  ) {
    blocked("JOURNAL_INVALID", "recovery journal header is invalid");
  }
  const home = validAbsolute(item.home, "journal HOME");
  const installDir = validAbsolute(item.installDir, "journal install directory");
  const fingerprint = validDigest(item.fingerprint, "journal fingerprint");
  const evidence = validEvidence(item.evidence, resolver);
  if (
    home !== options.home ||
    installDir !== options.installDir ||
    evidence.home !== home ||
    evidence.installDir !== installDir ||
    fingerprintFor(evidence) !== fingerprint
  ) {
    blocked("JOURNAL_INVALID", "recovery journal authority does not match its roots");
  }
  const installQuarantine = validAbsolute(
    item.installQuarantine,
    "install quarantine",
  );
  const homeQuarantine = validAbsolute(item.homeQuarantine, "HOME quarantine");
  const expectedLeaf = `${QUARANTINE_PREFIX}${item.transactionId}`;
  if (
    installQuarantine !== path.join(installDir, expectedLeaf) ||
    homeQuarantine !== path.join(home, expectedLeaf)
  ) {
    blocked("JOURNAL_INVALID", "recovery quarantine paths are not transaction-private");
  }
  const quarantineObject = objectValue(item.quarantineIdentity, "quarantine identity");
  strictKeys(quarantineObject, ["install", "home"], "quarantine identity");
  const quarantineIdentity: QuarantineIdentity = {
    install:
      quarantineObject.install === null
        ? null
        : validStat(quarantineObject.install, "install quarantine identity"),
    home:
      quarantineObject.home === null
        ? null
        : validStat(quarantineObject.home, "HOME quarantine identity"),
  };
  if (
    (item.phase === "preparing") !==
    (quarantineIdentity.install === null && quarantineIdentity.home === null)
  ) {
    blocked("JOURNAL_INVALID", "recovery quarantine identity phase is invalid");
  }
  if (!Array.isArray(item.moves) || item.moves.length !== 4) {
    blocked("JOURNAL_INVALID", "recovery journal move inventory is invalid");
  }
  const expectedMoves = createMoves(evidence, installQuarantine, homeQuarantine);
  const moves = item.moves.map((move, index) => {
    const candidate = objectValue(move, `move ${index}`);
    strictKeys(
      candidate,
      ["name", "source", "destination", "kind", "stat", "sha256"],
      `move ${index}`,
    );
    const parsed: MoveRecord = {
      name: candidate.name as MoveRecord["name"],
      source: validAbsolute(candidate.source, `move ${index} source`),
      destination: validAbsolute(candidate.destination, `move ${index} destination`),
      kind: candidate.kind as MoveRecord["kind"],
      stat: validStat(candidate.stat, `move ${index} stat`),
      sha256: validDigest(candidate.sha256, `move ${index} digest`),
    };
    if (JSON.stringify(parsed) !== JSON.stringify(expectedMoves[index])) {
      blocked("JOURNAL_INVALID", `move ${index} does not match derived authority`);
    }
    return parsed;
  });
  return {
    format: JOURNAL_FORMAT,
    transactionId: item.transactionId,
    home,
    installDir,
    fingerprint,
    confirmation: true,
    phase: item.phase as RecoveryPhase,
    installQuarantine,
    homeQuarantine,
    quarantineIdentity,
    evidence,
    moves,
  };
}

function renderJournal(journal: RecoveryJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function inspectJournalLeaf(file: string, uid: number): fs.BigIntStats {
  const stat = requireOwnedRegular(file, uid, "recovery journal");
  if (Number(stat.mode & 0o777n) !== 0o600) {
    blocked("JOURNAL_INVALID", "recovery journal permissions are not private");
  }
  if (stat.size > BigInt(MAX_JOURNAL_BYTES)) {
    blocked("JOURNAL_INVALID", "recovery journal exceeds its size limit");
  }
  return stat;
}

function readCanonicalJournal(
  file: string,
  options: LegacyPosixRecoveryOptions,
  uid: number,
  resolver: ResolvedDependencies["resolveRelease"],
): RecoveryJournal {
  const verified = inspectJournalLeaf(file, uid);
  const raw = readFileAt(file, verified, MAX_JOURNAL_BYTES).toString("utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    blocked("JOURNAL_INVALID", "recovery journal is not valid JSON");
  }
  const journal = validateJournal(decoded, options, resolver);
  if (renderJournal(journal) !== raw) {
    blocked("JOURNAL_INVALID", "recovery journal is not in canonical strict form");
  }
  return journal;
}

const JOURNAL_PHASE_ORDER: readonly RecoveryPhase[] = [
  "preparing",
  "prepared",
  "processes-killed",
  "binary-moved",
  "profile-moved",
  "install-lock-moved",
  "path-lock-moved",
  "quarantined",
  "cleanup",
];

function coherentJournalTemporary(
  current: RecoveryJournal,
  temporary: RecoveryJournal,
): boolean {
  const currentPhase = JOURNAL_PHASE_ORDER.indexOf(current.phase);
  const temporaryPhase = JOURNAL_PHASE_ORDER.indexOf(temporary.phase);
  const sameAuthority =
    current.transactionId === temporary.transactionId &&
    current.home === temporary.home &&
    current.installDir === temporary.installDir &&
    current.fingerprint === temporary.fingerprint &&
    current.installQuarantine === temporary.installQuarantine &&
    current.homeQuarantine === temporary.homeQuarantine &&
    JSON.stringify(current.evidence) === JSON.stringify(temporary.evidence) &&
    JSON.stringify(current.moves) === JSON.stringify(temporary.moves);
  const quarantineCoherent =
    JSON.stringify(current.quarantineIdentity) ===
      JSON.stringify(temporary.quarantineIdentity) ||
    (current.phase === "preparing" && temporary.phase === "prepared");
  return (
    sameAuthority &&
    quarantineCoherent &&
    temporaryPhase >= currentPhase &&
    temporaryPhase <= currentPhase + 1
  );
}

function unlinkJournalTemporary(
  temporary: string,
  expected: fs.BigIntStats,
  home: string,
  homeIdentity?: StatIdentity,
): void {
  const current = inspectJournalLeaf(temporary, Number(expected.uid));
  if (!sameFullStat(current, statIdentity(expected))) {
    blocked("JOURNAL_INVALID", "recovery journal temporary changed before cleanup");
  }
  fs.unlinkSync(temporary);
  flushDirectory(home, homeIdentity);
}

function readJournal(
  options: LegacyPosixRecoveryOptions,
  dependencies: ResolvedDependencies,
  reconcileTemporary = false,
): RecoveryJournal | undefined {
  const file = journalFile(options.home);
  const temporary = journalTemporaryFile(options.home);
  const fixedStat = lstatOptional(file);
  const temporaryStat = lstatOptional(temporary);
  if (fixedStat === undefined) {
    if (temporaryStat === undefined) return undefined;
    inspectJournalLeaf(temporary, dependencies.uid);
    if (!reconcileTemporary) {
      blocked("JOURNAL_INVALID", "an unpublished recovery journal temporary exists");
    }
    unlinkJournalTemporary(temporary, temporaryStat, options.home);
    return undefined;
  }
  const journal = readCanonicalJournal(
    file,
    options,
    dependencies.uid,
    dependencies.resolveRelease,
  );
  if (temporaryStat === undefined) return journal;
  inspectJournalLeaf(temporary, dependencies.uid);
  let pending: RecoveryJournal | undefined;
  try {
    pending = readCanonicalJournal(
      temporary,
      options,
      dependencies.uid,
      dependencies.resolveRelease,
    );
  } catch (error) {
    if (!(error instanceof RecoveryFailure)) throw error;
    // A partial temp is non-authoritative; the fixed journal remains complete.
  }
  if (pending !== undefined && !coherentJournalTemporary(journal, pending)) {
    blocked("JOURNAL_INVALID", "recovery journal temporary conflicts with authority");
  }
  if (reconcileTemporary) {
    unlinkJournalTemporary(
      temporary,
      temporaryStat,
      options.home,
      journal.evidence.homeBoundary,
    );
  }
  return journal;
}

function openDirectoryVerified(target: string, expected?: StatIdentity): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryFlag = fs.constants.O_DIRECTORY;
  if (noFollow === undefined || directoryFlag === undefined) {
    unavailable("DURABILITY_FAILED", "Linux directory safety flags are unavailable");
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | noFollow | directoryFlag,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isDirectory() ||
      (expected !== undefined && !sameDirectoryStat(opened, expected))
    ) {
      blocked("EVIDENCE_CHANGED", `directory changed while opening ${target}`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function flushDirectory(target: string, expected?: StatIdentity): void {
  const descriptor = openDirectoryVerified(target, expected);
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    unavailable("DURABILITY_FAILED", `could not durably sync ${target}`, error);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeJournal(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
  creating: boolean,
): void {
  const file = journalFile(journal.home);
  const temporary = journalTemporaryFile(journal.home);
  if (lstatOptional(temporary) !== undefined) {
    blocked("JOURNAL_INVALID", "a recovery journal temporary file already exists");
  }
  const before = lstatOptional(file);
  let expectedJournalBody: string | undefined;
  if (creating ? before !== undefined : before === undefined) {
    blocked("JOURNAL_INVALID", "recovery journal publication state changed");
  }
  if (before !== undefined) inspectJournalLeaf(file, dependencies.uid);
  if (before !== undefined) {
    const currentBody = readFileAt(file, before, MAX_JOURNAL_BYTES).toString("utf8");
    expectedJournalBody = currentBody;
    let currentValue: unknown;
    try {
      currentValue = JSON.parse(currentBody);
    } catch {
      blocked("JOURNAL_INVALID", "recovery journal changed before update");
    }
    const currentJournal = validateJournal(
      currentValue,
      {
        home: journal.home,
        installDir: journal.installDir,
      },
      dependencies.resolveRelease,
    );
    if (renderJournal(currentJournal) !== currentBody) {
      blocked("JOURNAL_INVALID", "recovery journal changed before update");
    }
  }
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    fs.writeFileSync(descriptor, renderJournal(journal), "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!creating) {
      const current = inspectJournalLeaf(file, dependencies.uid);
      if (
        !sameFullStat(current, statIdentity(before!)) ||
        readFileAt(file, current, MAX_JOURNAL_BYTES).toString("utf8") !==
          expectedJournalBody
      ) {
        blocked("JOURNAL_INVALID", "recovery journal changed before update");
      }
    } else if (lstatOptional(file) !== undefined) {
      blocked("JOURNAL_INVALID", "recovery journal appeared before publication");
    }
    fs.renameSync(temporary, file);
    temporaryExists = false;
    inspectJournalLeaf(file, dependencies.uid);
    flushDirectory(journal.home, journal.evidence.homeBoundary);
  } catch (error) {
    if (error instanceof RecoveryFailure) throw error;
    unavailable("DURABILITY_FAILED", "recovery journal could not be persisted", error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryExists) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A retained temporary causes the next invocation to stop safely.
      }
    }
  }
}

function createMoves(
  evidence: RecoveryEvidence,
  installQuarantine: string,
  homeQuarantine: string,
): readonly MoveRecord[] {
  return [
    {
      name: "binary",
      source: evidence.binary.path,
      destination: path.join(installQuarantine, "binary"),
      kind: "file",
      stat: evidence.binary.stat,
      sha256: evidence.binary.sha256,
    },
    {
      name: "profile",
      source: evidence.stagedProfile.path,
      destination: path.join(homeQuarantine, "staged-profile"),
      kind: "file",
      stat: evidence.stagedProfile.stat,
      sha256: evidence.stagedProfile.sha256,
    },
    {
      name: "install-lock",
      source: evidence.installLock.path,
      destination: path.join(installQuarantine, "install-lock"),
      kind: "lock",
      stat: evidence.installLock.stat,
      sha256: evidence.installLock.sha256,
    },
    {
      name: "path-lock",
      source: evidence.pathLock.path,
      destination: path.join(homeQuarantine, "path-lock"),
      kind: "lock",
      stat: evidence.pathLock.stat,
      sha256: evidence.pathLock.sha256,
    },
  ];
}

function createJournalFromEvidence(
  evidence: RecoveryEvidence,
  fingerprint: string,
  transactionId: string,
): RecoveryJournal {
  const leaf = `${QUARANTINE_PREFIX}${transactionId}`;
  const installQuarantine = path.join(evidence.installDir, leaf);
  const homeQuarantine = path.join(evidence.home, leaf);
  return {
    format: JOURNAL_FORMAT,
    transactionId,
    home: evidence.home,
    installDir: evidence.installDir,
    fingerprint,
    confirmation: true,
    phase: "preparing",
    installQuarantine,
    homeQuarantine,
    quarantineIdentity: { install: null, home: null },
    evidence,
    moves: createMoves(evidence, installQuarantine, homeQuarantine),
  };
}

function prepareOneQuarantine(
  target: string,
  parent: string,
  parentIdentity: StatIdentity,
  uid: number,
): StatIdentity {
  const existing = lstatOptional(target);
  if (existing === undefined) {
    fs.mkdirSync(target, { mode: 0o700 });
    flushDirectory(parent, parentIdentity);
  }
  const stat = lstatOptional(target);
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    Number(stat.uid) !== uid ||
    Number(stat.mode & 0o777n) !== 0o700 ||
    fs.readdirSync(target).length !== 0
  ) {
    blocked("QUARANTINE_CONFLICT", `private quarantine is not exact at ${target}`);
  }
  flushDirectory(target, statIdentity(stat));
  return statIdentity(stat);
}

function prepareQuarantines(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
): void {
  if (journal.phase !== "preparing") return;
  const installIdentity = prepareOneQuarantine(
    journal.installQuarantine,
    journal.installDir,
    journal.evidence.installBoundary,
    dependencies.uid,
  );
  const homeIdentity = prepareOneQuarantine(
    journal.homeQuarantine,
    journal.home,
    journal.evidence.homeBoundary,
    dependencies.uid,
  );
  journal.quarantineIdentity = {
    install: installIdentity,
    home: homeIdentity,
  };
  journal.phase = "prepared";
  writeJournal(journal, dependencies, false);
}

function assertCanonicalProfile(evidence: ProfileEvidence): void {
  const current = lstatOptional(evidence.path);
  if (!evidence.exists) {
    if (current !== undefined) {
      blocked("EVIDENCE_CHANGED", "canonical shell profile appeared during recovery");
    }
    return;
  }
  const stat = assertFullStat(evidence.path, evidence.stat, "file");
  if (hashFileAt(evidence.path, stat) !== evidence.sha256) {
    blocked("EVIDENCE_CHANGED", "canonical shell profile changed during recovery");
  }
}

function assertReceiptAbsent(journal: RecoveryJournal): void {
  if (lstatOptional(path.join(journal.installDir, RECEIPT_LEAF)) !== undefined) {
    blocked("RECEIPT_PRESENT", "an installer receipt appeared during recovery");
  }
}

function assertJournalRoots(journal: RecoveryJournal): void {
  const home = inspectBoundary(journal.home, "HOME", journal.evidence.shell.uid);
  const install = inspectBoundary(
    journal.installDir,
    "installation directory",
    journal.evidence.shell.uid,
  );
  if (
    !sameDirectoryStat(home, journal.evidence.homeBoundary) ||
    !sameDirectoryStat(install, journal.evidence.installBoundary)
  ) {
    blocked("EVIDENCE_CHANGED", "recovery root identity changed");
  }
  assertCanonicalProfile(journal.evidence.canonicalProfile);
  assertReceiptAbsent(journal);
}

function lockForMove(journal: RecoveryJournal, move: MoveRecord): LockEvidence {
  return move.name === "install-lock"
    ? journal.evidence.installLock
    : journal.evidence.pathLock;
}

function verifyMovePath(
  journal: RecoveryJournal,
  move: MoveRecord,
  target: string,
  source: boolean,
): void {
  if (move.kind === "file") {
    const stat = source
      ? assertFullStat(target, move.stat, "file")
      : assertStableStat(target, move.stat, "file");
    if (hashFileAt(target, stat) !== move.sha256) {
      blocked("EVIDENCE_CHANGED", `artifact digest changed at ${target}`);
    }
    return;
  }
  const expected = lockForMove(journal, move);
  const observed = inspectLock(target, journal.evidence.shell.uid, move.name);
  const rootStat = fs.lstatSync(target, { bigint: true });
  if (
    (source
      ? !sameFullStat(rootStat, move.stat)
      : !sameStableStat(rootStat, move.stat)) ||
    observed.sha256 !== expected.sha256 ||
    observed.token.name !== expected.token.name ||
    observed.token.sha256 !== expected.token.sha256 ||
    !sameFullStat(
      fs.lstatSync(observed.token.path, { bigint: true }),
      expected.token.stat,
    )
  ) {
    blocked("EVIDENCE_CHANGED", `lock artifact changed at ${target}`);
  }
}

type MoveLocation = "source" | "destination" | "absent";

function moveLocation(journal: RecoveryJournal, move: MoveRecord): MoveLocation {
  const source = lstatOptional(move.source);
  const destination = lstatOptional(move.destination);
  if (source !== undefined && destination !== undefined) {
    blocked("QUARANTINE_CONFLICT", `${move.name} exists at source and destination`);
  }
  if (source !== undefined) {
    verifyMovePath(journal, move, move.source, true);
    return "source";
  }
  if (destination !== undefined) {
    verifyMovePath(journal, move, move.destination, false);
    return "destination";
  }
  return "absent";
}

function quarantinedMoveLocation(
  journal: RecoveryJournal,
  move: MoveRecord,
): MoveLocation {
  const source = lstatOptional(move.source);
  const destination = lstatOptional(move.destination);
  if (source !== undefined && destination !== undefined) {
    blocked("QUARANTINE_CONFLICT", `${move.name} exists at source and destination`);
  }
  if (source !== undefined) {
    verifyMovePath(journal, move, move.source, true);
    return "source";
  }
  if (destination === undefined) return "absent";
  if (move.kind === "file") {
    verifyMovePath(journal, move, move.destination, false);
    return "destination";
  }
  const destinationStat = assertStableStat(
    move.destination,
    move.stat,
    "directory",
  );
  if (!sameStableStat(destinationStat, move.stat)) {
    blocked(
      "QUARANTINE_CONFLICT",
      `lock quarantine identity changed at ${move.destination}`,
    );
  }
  const expected = lockForMove(journal, move);
  const entries = fs.readdirSync(move.destination);
  if (entries.length === 0) return "destination";
  if (entries.length !== 1 || entries[0] !== expected.token.name) {
    blocked(
      "QUARANTINE_CONFLICT",
      `lock quarantine has unexpected entries at ${move.destination}`,
    );
  }
  verifyMovePath(journal, move, move.destination, false);
  return "destination";
}

function phaseMoveCount(phase: RecoveryPhase): number {
  switch (phase) {
    case "preparing":
    case "prepared":
    case "processes-killed":
      return 0;
    case "binary-moved":
      return 1;
    case "profile-moved":
      return 2;
    case "install-lock-moved":
      return 3;
    case "path-lock-moved":
    case "quarantined":
      return 4;
    case "cleanup":
      return 0;
  }
}

function validateJournalLocations(journal: RecoveryJournal): void {
  if (journal.phase === "preparing") {
    for (const target of [journal.installQuarantine, journal.homeQuarantine]) {
      const stat = lstatOptional(target);
      if (
        stat !== undefined &&
        (stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          Number(stat.uid) !== journal.evidence.shell.uid ||
          Number(stat.mode & 0o777n) !== 0o700 ||
          fs.readdirSync(target).length !== 0)
      ) {
        blocked("QUARANTINE_CONFLICT", `preparing quarantine is not exact at ${target}`);
      }
    }
    for (const move of journal.moves) {
      if (moveLocation(journal, move) !== "source") {
        blocked("JOURNAL_INVALID", "preparing journal no longer has all source artifacts");
      }
    }
    return;
  }
  if (journal.phase === "cleanup") {
    if (
      lstatOptional(journal.installQuarantine) !== undefined ||
      lstatOptional(journal.homeQuarantine) !== undefined
    ) {
      blocked("JOURNAL_INVALID", "cleanup journal still has a quarantine directory");
    }
    for (const move of journal.moves) {
      if (moveLocation(journal, move) !== "absent") {
        blocked("JOURNAL_INVALID", "cleanup journal still has an artifact");
      }
    }
    return;
  }
  verifyQuarantineInventory(journal, journal.installQuarantine);
  verifyQuarantineInventory(journal, journal.homeQuarantine);
  if (
    journal.phase !== "quarantined" &&
    (lstatOptional(journal.installQuarantine) === undefined ||
      lstatOptional(journal.homeQuarantine) === undefined)
  ) {
    blocked("JOURNAL_INVALID", "recovery quarantine directory is missing before cleanup");
  }
  const locations = journal.moves.map((move) =>
    journal.phase === "quarantined"
      ? quarantinedMoveLocation(journal, move)
      : moveLocation(journal, move),
  );
  if (journal.phase === "quarantined") {
    if (locations.some((location) => location === "source")) {
      blocked("JOURNAL_INVALID", "quarantined journal has a canonical source artifact");
    }
    return;
  }
  if (locations.some((location) => location === "absent")) {
    blocked("JOURNAL_INVALID", "recovery artifact is missing from source and quarantine");
  }
  const moved = locations.filter((location) => location === "destination").length;
  if (
    locations.some(
      (location, index) =>
        (index < moved && location !== "destination") ||
        (index >= moved && location !== "source"),
    )
  ) {
    blocked("JOURNAL_INVALID", "recovery moves are not a contiguous prefix");
  }
  const recorded = phaseMoveCount(journal.phase);
  if (moved < recorded || moved > recorded + 1) {
    blocked("JOURNAL_INVALID", "recovery move state is inconsistent with its phase");
  }
}

function sameRecordedProcess(
  current: LegacyLinuxProcess,
  expected: ProcessEvidence,
  requireState: boolean,
  requireParent = true,
): boolean {
  return (
    current.pid === expected.pid &&
    (!requireParent || current.ppid === expected.ppid) &&
    current.uid === expected.uid &&
    current.startToken === expected.startToken &&
    current.command === expected.command &&
    current.executable === expected.executable &&
    JSON.stringify(current.argv) === JSON.stringify(expected.argv) &&
    (!requireState || current.state === expected.state)
  );
}

async function killRecordedProcesses(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
): Promise<void> {
  if (journal.phase !== "prepared") return;
  const observedShell = await dependencies.processProvider.read(
    journal.evidence.shell.pid,
  );
  const shell =
    observedShell?.startToken === journal.evidence.shell.startToken
      ? observedShell
      : undefined;
  const observedSync = await dependencies.processProvider.read(
    journal.evidence.sync.pid,
  );
  const sync =
    observedSync?.startToken === journal.evidence.sync.startToken
      ? observedSync
      : undefined;
  if (
    shell !== undefined &&
    !sameRecordedProcess(shell, journal.evidence.shell, false)
  ) {
    blocked("PROCESS_EVIDENCE_INVALID", "recorded shell PID changed identity");
  }
  if (
    sync !== undefined &&
    !sameRecordedProcess(
      sync,
      journal.evidence.sync,
      true,
      shell !== undefined,
    )
  ) {
    blocked("PROCESS_EVIDENCE_INVALID", "recorded sync PID changed identity");
  }
  try {
    if (sync !== undefined) dependencies.killProcess(sync.pid, "SIGKILL");
    if (shell !== undefined) {
      const shellBeforeKill = await dependencies.processProvider.read(shell.pid);
      if (shellBeforeKill?.startToken === journal.evidence.shell.startToken) {
        if (!sameRecordedProcess(shellBeforeKill, journal.evidence.shell, false)) {
          blocked("PROCESS_EVIDENCE_INVALID", "shell identity changed before SIGKILL");
        }
        dependencies.killProcess(shellBeforeKill.pid, "SIGKILL");
      }
    }
    await dependencies.waitForParentExit(
      journal.evidence.shell,
      dependencies.processProvider,
    );
    await dependencies.checkpoint("processes-signaled");
  } catch (error) {
    if (error instanceof RecoveryFailure) throw error;
    unavailable(
      "PROCESS_TERMINATION_FAILED",
      "exact legacy installer processes could not be terminated",
      error,
    );
  }
  journal.phase = "processes-killed";
  writeJournal(journal, dependencies, false);
}

const MOVE_PHASES: readonly RecoveryPhase[] = [
  "binary-moved",
  "profile-moved",
  "install-lock-moved",
  "path-lock-moved",
];

function moveArtifact(
  journal: RecoveryJournal,
  move: MoveRecord,
): void {
  assertJournalRoots(journal);
  const location = moveLocation(journal, move);
  if (location === "absent") {
    blocked("QUARANTINE_CONFLICT", `${move.name} is absent at both allowed paths`);
  }
  if (location === "source") {
    if (lstatOptional(move.destination) !== undefined) {
      blocked("QUARANTINE_CONFLICT", `${move.name} quarantine destination exists`);
    }
    verifyMovePath(journal, move, move.source, true);
    fs.renameSync(move.source, move.destination);
    const sourceParentIdentity =
      path.dirname(move.source) === journal.installDir
        ? journal.evidence.installBoundary
        : journal.evidence.homeBoundary;
    flushDirectory(path.dirname(move.source), sourceParentIdentity);
    const quarantineIdentity =
      path.dirname(move.destination) === journal.installQuarantine
        ? journal.quarantineIdentity.install
        : journal.quarantineIdentity.home;
    if (quarantineIdentity === null) {
      blocked("JOURNAL_INVALID", "quarantine identity is unavailable during move");
    }
    flushDirectory(path.dirname(move.destination), quarantineIdentity);
    verifyMovePath(journal, move, move.destination, false);
  }
}

async function quarantineArtifacts(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
): Promise<void> {
  if (
    journal.phase === "preparing" ||
    journal.phase === "prepared" ||
    journal.phase === "cleanup" ||
    journal.phase === "quarantined"
  ) {
    return;
  }
  const durableCount = phaseMoveCount(journal.phase);
  let completedCount = durableCount;
  if (
    completedCount < journal.moves.length &&
    moveLocation(journal, journal.moves[completedCount]!) === "destination"
  ) {
    completedCount += 1;
  }
  if (completedCount > durableCount) {
    const completedMove = journal.moves[completedCount - 1]!;
    journal.phase = MOVE_PHASES[completedCount - 1]!;
    writeJournal(journal, dependencies, false);
    await dependencies.checkpoint(`moved-${completedMove.name}`);
  }
  for (let index = completedCount; index < journal.moves.length; index++) {
    const move = journal.moves[index]!;
    moveArtifact(journal, move);
    journal.phase = MOVE_PHASES[index]!;
    writeJournal(journal, dependencies, false);
    await dependencies.checkpoint(`moved-${move.name}`);
  }
  journal.phase = "quarantined";
  writeJournal(journal, dependencies, false);
}

function allowedQuarantineEntries(journal: RecoveryJournal, root: string): Set<string> {
  return new Set(
    journal.moves
      .filter((move) => path.dirname(move.destination) === root)
      .map((move) => path.basename(move.destination)),
  );
}

function verifyQuarantineInventory(journal: RecoveryJournal, root: string): void {
  const stat = lstatOptional(root);
  if (stat === undefined) return;
  const expected =
    root === journal.installQuarantine
      ? journal.quarantineIdentity.install
      : journal.quarantineIdentity.home;
  if (expected === null) {
    blocked("JOURNAL_INVALID", "quarantine inventory has no directory identity");
  }
  assertStableStat(root, expected, "directory");
  const allowed = allowedQuarantineEntries(journal, root);
  for (const entry of fs.readdirSync(root)) {
    if (!allowed.has(entry)) {
      blocked("QUARANTINE_CONFLICT", `unexpected quarantine entry ${path.join(root, entry)}`);
    }
  }
}

function cleanupFileMove(journal: RecoveryJournal, move: MoveRecord): void {
  const stat = lstatOptional(move.destination);
  if (stat === undefined) return;
  verifyMovePath(journal, move, move.destination, false);
  fs.unlinkSync(move.destination);
}

async function cleanupLockMove(
  journal: RecoveryJournal,
  move: MoveRecord,
  dependencies: ResolvedDependencies,
): Promise<void> {
  const root = lstatOptional(move.destination);
  if (root === undefined) return;
  assertStableStat(move.destination, move.stat, "directory");
  const expected = lockForMove(journal, move);
  const entries = fs.readdirSync(move.destination);
  if (
    entries.length > 1 ||
    (entries.length === 1 && entries[0] !== expected.token.name)
  ) {
    blocked("QUARANTINE_CONFLICT", `lock quarantine has unexpected entries at ${move.destination}`);
  }
  if (entries.length === 1) {
    const token = path.join(move.destination, expected.token.name);
    const tokenStat = assertFullStat(token, expected.token.stat, "file");
    if (hashFileAt(token, tokenStat) !== expected.token.sha256) {
      blocked("QUARANTINE_CONFLICT", `lock token changed at ${token}`);
    }
    fs.unlinkSync(token);
    flushDirectory(move.destination, move.stat);
    await dependencies.checkpoint(`unlinked-${move.name}-token`);
  }
  assertStableStat(move.destination, move.stat, "directory");
  fs.rmdirSync(move.destination);
}

async function cleanupQuarantineRoot(
  journal: RecoveryJournal,
  root: string,
  dependencies: ResolvedDependencies,
): Promise<void> {
  if (lstatOptional(root) === undefined) return;
  verifyQuarantineInventory(journal, root);
  for (const move of journal.moves.filter(
    (candidate) => path.dirname(candidate.destination) === root,
  )) {
    if (lstatOptional(move.source) !== undefined) {
      blocked("QUARANTINE_CONFLICT", `${move.name} reappeared at its canonical source`);
    }
    if (move.kind === "file") cleanupFileMove(journal, move);
    else await cleanupLockMove(journal, move, dependencies);
  }
  verifyQuarantineInventory(journal, root);
  const remaining = fs.readdirSync(root);
  if (remaining.length !== 0) {
    blocked("QUARANTINE_CONFLICT", `quarantine is not empty at ${root}`);
  }
  const expected =
    root === journal.installQuarantine
      ? journal.quarantineIdentity.install
      : journal.quarantineIdentity.home;
  if (expected === null) blocked("JOURNAL_INVALID", "quarantine identity is missing");
  assertStableStat(root, expected, "directory");
  fs.rmdirSync(root);
  flushDirectory(
    path.dirname(root),
    root === journal.installQuarantine
      ? journal.evidence.installBoundary
      : journal.evidence.homeBoundary,
  );
}

async function cleanupQuarantines(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
): Promise<void> {
  if (journal.phase === "cleanup") return;
  if (journal.phase !== "quarantined") {
    blocked("JOURNAL_INVALID", "cleanup began before every artifact was quarantined");
  }
  assertJournalRoots(journal);
  await cleanupQuarantineRoot(
    journal,
    journal.installQuarantine,
    dependencies,
  );
  await dependencies.checkpoint("cleaned-install-quarantine");
  assertJournalRoots(journal);
  await cleanupQuarantineRoot(journal, journal.homeQuarantine, dependencies);
  await dependencies.checkpoint("cleaned-home-quarantine");
  assertJournalRoots(journal);
  journal.phase = "cleanup";
  writeJournal(journal, dependencies, false);
}

function removeJournal(journal: RecoveryJournal, uid: number): void {
  if (journal.phase !== "cleanup") {
    blocked("JOURNAL_INVALID", "recovery journal cannot be removed before cleanup");
  }
  assertJournalRoots(journal);
  for (const move of journal.moves) {
    if (lstatOptional(move.source) !== undefined || lstatOptional(move.destination) !== undefined) {
      blocked("JOURNAL_INVALID", "artifact remained when removing recovery journal");
    }
  }
  if (
    lstatOptional(journal.installQuarantine) !== undefined ||
    lstatOptional(journal.homeQuarantine) !== undefined
  ) {
    blocked("JOURNAL_INVALID", "private quarantine remained after cleanup");
  }
  const file = journalFile(journal.home);
  inspectJournalLeaf(file, uid);
  fs.unlinkSync(file);
  flushDirectory(journal.home, journal.evidence.homeBoundary);
}

async function resumeJournal(
  journal: RecoveryJournal,
  dependencies: ResolvedDependencies,
): Promise<LegacyPosixRecoveryResult> {
  assertJournalRoots(journal);
  validateJournalLocations(journal);
  if (journal.phase === "preparing") {
    prepareQuarantines(journal, dependencies);
    await dependencies.checkpoint("quarantines-prepared");
  }
  if (journal.phase === "prepared") {
    await killRecordedProcesses(journal, dependencies);
    await dependencies.checkpoint("processes-killed");
  }
  await quarantineArtifacts(journal, dependencies);
  if (journal.phase === "path-lock-moved") {
    journal.phase = "quarantined";
    writeJournal(journal, dependencies, false);
  }
  if (journal.phase === "quarantined") {
    await dependencies.checkpoint("quarantined");
    await cleanupQuarantines(journal, dependencies);
    await dependencies.checkpoint("cleanup-recorded");
  }
  if (journal.phase !== "cleanup") {
    blocked("JOURNAL_INVALID", `unsupported recovery resume phase ${journal.phase}`);
  }
  const result: LegacyPosixRecoveryResult = {
    status: "completed",
    fingerprint: journal.fingerprint,
    recoveredArtifacts: journal.moves.map((move) => move.source),
  };
  removeJournal(journal, dependencies.uid);
  return result;
}

function parseProcStat(pid: number, body: string): {
  command: string;
  state: string;
  ppid: number;
  startToken: string;
} {
  const prefix = `${pid} (`;
  const end = body.lastIndexOf(") ");
  if (!body.startsWith(prefix) || end < prefix.length || !body.endsWith("\n")) {
    throw new Error(`process ${pid} published malformed /proc stat`);
  }
  const command = body.slice(prefix.length, end);
  const fields = body.slice(end + 2).trim().split(/\s+/u);
  const state = fields[0];
  const ppidText = fields[1];
  const startToken = fields[19];
  if (
    state === undefined ||
    !/^[A-Z]$/u.test(state) ||
    ppidText === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(ppidText) ||
    startToken === undefined ||
    !/^(?:0|[1-9][0-9]*)$/u.test(startToken)
  ) {
    throw new Error(`process ${pid} published invalid /proc identity fields`);
  }
  const ppid = Number(ppidText);
  if (!Number.isSafeInteger(ppid)) {
    throw new Error(`process ${pid} parent PID is outside the safe range`);
  }
  return { command, state, ppid, startToken };
}

function readProcUid(pid: number): number {
  const body = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const lines = body.split("\n").filter((line) => line.startsWith("Uid:"));
  if (lines.length !== 1) throw new Error(`process ${pid} has ambiguous UID state`);
  const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/u.exec(
    lines[0]!,
  );
  if (match === null || new Set(match.slice(1)).size !== 1) {
    throw new Error(`process ${pid} has changing or malformed UID state`);
  }
  const uid = Number(match[1]);
  if (!Number.isSafeInteger(uid)) throw new Error(`process ${pid} UID is invalid`);
  return uid;
}

function clockTicksPerSecond(): bigint {
  for (const executable of ["/usr/bin/getconf", "/bin/getconf"]) {
    const stat = lstatOptional(executable);
    if (
      stat === undefined ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o111n) === 0n
    ) {
      continue;
    }
    const result = spawnSync(executable, ["CLK_TCK"], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
      env: { LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value = result.stdout.trim();
    if (result.status === 0 && /^[1-9][0-9]*$/u.test(value)) return BigInt(value);
  }
  throw new Error("authoritative Linux clock tick rate is unavailable");
}

function bootTimeSecond(): bigint {
  const body = fs.readFileSync("/proc/stat", "utf8");
  const values = [...body.matchAll(/^btime ([0-9]+)$/gmu)];
  if (values.length !== 1) throw new Error("Linux boot time is unavailable");
  return BigInt(values[0]![1]!);
}

function parseCmdline(body: Buffer): string[] {
  if (body.length === 0 || body[body.length - 1] !== 0) return [];
  const fields = body.subarray(0, -1).toString("utf8").split("\0");
  return fields.some((field) => field === "") ? [] : fields;
}

class ProcIdentityChanged extends Error {}

function defaultProcessProvider(
  clock?: LegacyPosixRecoveryDependencies["linuxProcessClock"],
): LegacyProcessProvider {
  const ticks = clock?.ticksPerSecond ?? clockTicksPerSecond();
  const boot = clock?.bootTimeSecond ?? bootTimeSecond();
  if (ticks <= 0n || boot < 0n) {
    throw new Error("Linux process clock metadata is invalid");
  }
  const readOnce = (pid: number): LegacyLinuxProcess => {
    const uid = readProcUid(pid);
    const parsed = parseProcStat(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    const argv = parseCmdline(fs.readFileSync(`/proc/${pid}/cmdline`));
    let executable = "";
    try {
      executable = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES") {
        throw error;
      }
    }
    const finalUid = readProcUid(pid);
    const finalParsed = parseProcStat(
      pid,
      fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
    const finalArgv = parseCmdline(fs.readFileSync(`/proc/${pid}/cmdline`));
    let finalExecutable = "";
    try {
      finalExecutable = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES") {
        throw error;
      }
    }
    if (
      finalUid !== uid ||
      finalParsed.startToken !== parsed.startToken ||
      finalParsed.command !== parsed.command ||
      finalParsed.ppid !== parsed.ppid ||
      finalExecutable !== executable ||
      JSON.stringify(finalArgv) !== JSON.stringify(argv)
    ) {
      throw new ProcIdentityChanged(
        `process ${pid} changed identity while /proc was inspected`,
      );
    }
    const started = boot + BigInt(parsed.startToken) / ticks;
    const startedAtSecond = Number(started);
    if (!Number.isSafeInteger(startedAtSecond)) {
      throw new Error(`process ${pid} start time is outside the safe range`);
    }
    return {
      pid,
      ppid: parsed.ppid,
      uid,
      command: parsed.command,
      executable,
      argv,
      state: finalParsed.state,
      startToken: parsed.startToken,
      startedAtSecond,
    };
  };
  const read = async (pid: number): Promise<LegacyLinuxProcess | undefined> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return readOnce(pid);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (
          !(error instanceof ProcIdentityChanged) &&
          code !== "ENOENT" &&
          code !== "ESRCH"
        ) {
          throw error;
        }
        if (attempt === 1) {
          if (error instanceof ProcIdentityChanged) throw error;
          return undefined;
        }
      }
    }
    return undefined;
  };
  return {
    read,
    async scanSameUid(uid: number): Promise<readonly LegacyLinuxProcess[]> {
      const processes: LegacyLinuxProcess[] = [];
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[1-9][0-9]*$/u.test(entry)) continue;
        const pid = Number(entry);
        let process: LegacyLinuxProcess | undefined;
        try {
          process = await read(pid);
        } catch (error) {
          if (error instanceof ProcIdentityChanged) continue;
          throw error;
        }
        if (process?.uid === uid) processes.push(process);
      }
      return processes;
    },
  };
}

function lazyDefaultProcessProvider(
  clock?: LegacyPosixRecoveryDependencies["linuxProcessClock"],
): LegacyProcessProvider {
  let provider: LegacyProcessProvider | undefined;
  const get = (): LegacyProcessProvider => {
    provider ??= defaultProcessProvider(clock);
    return provider;
  };
  return {
    async read(pid: number): Promise<LegacyLinuxProcess | undefined> {
      return await get().read(pid);
    },
    async scanSameUid(uid: number): Promise<readonly LegacyLinuxProcess[]> {
      return await get().scanSameUid(uid);
    },
  };
}

function defaultResolveRelease(
  digest: string,
): Readonly<LegacyPosixReleaseIdentity> | undefined {
  return OFFICIAL_LEGACY_RELEASES[digest];
}

interface LibcFlock {
  flock(descriptor: number, operation: number): number;
  close(): void;
}

let cachedLibcFlock: LibcFlock | undefined;

function openLibcFlock(): LibcFlock {
  if (cachedLibcFlock !== undefined) return cachedLibcFlock;
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  const candidates = [
    "libc.so.6",
    `libc.musl-${architecture}.so.1`,
    `/lib/libc.musl-${architecture}.so.1`,
    "libc.so",
  ];
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const library = dlopen(candidate, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      cachedLibcFlock = {
        flock: library.symbols.flock,
        // Keep libc loaded for process lifetime. Closing one of two Bun dlopen
        // handles can invalidate the other handle's generated FFI trampoline.
        close: () => {
          void library;
        },
      };
      return cachedLibcFlock;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "Linux libc flock symbol is unavailable");
}

function defaultAcquireGuard(file: string, uid: number): LegacyRecoveryGuard {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow === undefined) unavailable("LOCK_UNAVAILABLE", "Linux O_NOFOLLOW is unavailable");
  const existed = lstatOptional(file) !== undefined;
  let descriptor: number | undefined;
  let library: ReturnType<typeof openLibcFlock> | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_CREAT |
        fs.constants.O_RDWR |
        noFollow,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const lexical = fs.lstatSync(file, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      Number(opened.uid) !== uid ||
      Number(opened.mode & 0o777n) !== 0o600 ||
      lexical.isSymbolicLink() ||
      lexical.dev !== opened.dev ||
      lexical.ino !== opened.ino
    ) {
      blocked("LOCK_UNAVAILABLE", "recovery guard is not an exact private owned file");
    }
    if (!existed) {
      fs.fsyncSync(descriptor);
      flushDirectory(path.dirname(file));
    }
    library = openLibcFlock();
    if (library.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
      blocked("RECOVERY_BUSY", "another legacy recovery holds the kernel guard");
    }
    const lockedPath = fs.lstatSync(file, { bigint: true });
    if (
      lockedPath.isSymbolicLink() ||
      lockedPath.dev !== opened.dev ||
      lockedPath.ino !== opened.ino ||
      lockedPath.nlink !== 1n ||
      Number(lockedPath.uid) !== uid ||
      Number(lockedPath.mode & 0o777n) !== 0o600
    ) {
      blocked("LOCK_UNAVAILABLE", "recovery guard path changed while locking it");
    }
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        const unlockResult = library!.flock(descriptor!, LOCK_UN);
        fs.closeSync(descriptor!);
        library!.close();
        descriptor = undefined;
        library = undefined;
        if (unlockResult !== 0) throw new Error("kernel recovery guard could not be unlocked");
      },
    };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    library?.close();
    if (error instanceof RecoveryFailure) throw error;
    unavailable("LOCK_UNAVAILABLE", "kernel advisory flock is unavailable", error);
  }
}

async function defaultWaitForParentExit(
  expected: Readonly<ProcessEvidence>,
  provider: LegacyProcessProvider,
): Promise<void> {
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const current = await provider.read(expected.pid);
    if (current === undefined || current.startToken !== expected.startToken) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("recorded installer shell did not exit after SIGKILL");
}

function resolveDependencies(
  dependencies: LegacyPosixRecoveryDependencies = {},
): ResolvedDependencies {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux") {
    blocked(
      "UNSUPPORTED_PLATFORM",
      "legacy stuck-sync recovery is available only on Linux and WSL",
    );
  }
  const uid = dependencies.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    unavailable("INVALID_BOUNDARY", "current Linux user identity is unavailable");
  }
  const provider =
    dependencies.processProvider ??
    lazyDefaultProcessProvider(dependencies.linuxProcessClock);
  return {
    platform,
    uid,
    resolveRelease: dependencies.resolveRelease ?? defaultResolveRelease,
    processProvider: provider,
    killProcess: dependencies.killProcess ?? ((pid, signal) => process.kill(pid, signal)),
    waitForParentExit: dependencies.waitForParentExit ?? defaultWaitForParentExit,
    acquireGuard: dependencies.acquireGuard ?? defaultAcquireGuard,
    randomUUID: dependencies.randomUUID ?? randomUUID,
    checkpoint: async (name) => {
      await dependencies.checkpoint?.(name);
    },
  };
}

async function inspectInternal(
  options: LegacyPosixRecoveryOptions,
  dependencies: ResolvedDependencies,
): Promise<LegacyPosixInspectionResult> {
  inspectRoots(options, dependencies);
  const journal = readJournal(options, dependencies);
  if (journal !== undefined) {
    assertJournalRoots(journal);
    validateJournalLocations(journal);
    return {
      status: "pending",
      fingerprint: journal.fingerprint,
      phase: journal.phase,
      journal: journalFile(options.home),
    };
  }
  const orphans = orphanQuarantines(options.home, options.installDir);
  if (orphans.length > 0) {
    blocked("QUARANTINE_CONFLICT", "private recovery quarantine exists without a journal");
  }
  if (!inspectRecoveryIndicators(options.home, options.installDir)) {
    return { status: "none" };
  }
  const evidence = await buildEvidence(options, dependencies);
  const fingerprint = fingerprintFor(evidence);
  return {
    status: "confirmation-required",
    fingerprint,
    release: evidence.release,
    artifacts: [
      evidence.binary.path,
      evidence.stagedProfile.path,
      evidence.installLock.path,
      evidence.pathLock.path,
    ],
    processes: { shellPid: evidence.shell.pid, syncPid: evidence.sync.pid },
  };
}

export async function inspectLegacyPosixRecovery(
  options: LegacyPosixRecoveryOptions,
  dependencies: LegacyPosixRecoveryDependencies = {},
): Promise<LegacyPosixInspectionResult> {
  try {
    return await inspectInternal(options, resolveDependencies(dependencies));
  } catch (error) {
    return failureResult(error);
  }
}

export async function recoverLegacyPosixInstall(
  options: LegacyPosixRecoverOptions,
  dependencies: LegacyPosixRecoveryDependencies = {},
): Promise<LegacyPosixRecoveryResult> {
  let guard: LegacyRecoveryGuard | undefined;
  try {
    const resolved = resolveDependencies(dependencies);
    inspectRoots(options, resolved);
    guard = resolved.acquireGuard(guardFile(options.home), resolved.uid);
    let journal = readJournal(options, resolved, true);
    if (journal !== undefined) {
      if (
        options.fingerprint !== undefined &&
        options.fingerprint !== journal.fingerprint
      ) {
        blocked(
          "CONFIRMATION_MISMATCH",
          "provided fingerprint does not match the durable confirmed recovery",
        );
      }
      return await resumeJournal(journal, resolved);
    }
    const inspected = await inspectInternal(options, resolved);
    if (inspected.status !== "confirmation-required") return inspected;
    if (options.fingerprint === undefined) return inspected;
    if (options.fingerprint !== inspected.fingerprint) {
      blocked(
        "CONFIRMATION_MISMATCH",
        "recovery evidence changed or the fingerprint does not match",
      );
    }
    const evidence = await buildEvidence(options, resolved);
    const fingerprint = fingerprintFor(evidence);
    if (fingerprint !== options.fingerprint) {
      blocked("EVIDENCE_CHANGED", "recovery evidence changed under the kernel guard");
    }
    const transactionId = resolved.randomUUID();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        transactionId,
      )
    ) {
      unavailable("DURABILITY_FAILED", "secure recovery transaction UUID is invalid");
    }
    journal = createJournalFromEvidence(evidence, fingerprint, transactionId);
    writeJournal(journal, resolved, true);
    await resolved.checkpoint("journal-created");
    return await resumeJournal(journal, resolved);
  } catch (error) {
    return failureResult(error);
  } finally {
    try {
      guard?.release();
    } catch {
      // Closing the descriptor has already released the kernel lock.
    }
  }
}

export function serializeLegacyPosixRecoveryResult(
  result: LegacyPosixRecoveryResult,
): string {
  const lines = [`format=${RESULT_FORMAT}`, `status=${result.status}`];
  if ("fingerprint" in result) lines.push(`fingerprint=${result.fingerprint}`);
  if (result.status === "pending") lines.push(`phase=${result.phase}`);
  if (result.status === "blocked" || result.status === "error") {
    lines.push(`code=${result.code}`);
    lines.push(`messageBase64=${Buffer.from(result.message, "utf8").toString("base64")}`);
  }
  if (result.status === "completed") {
    lines.push(`recoveredCount=${result.recoveredArtifacts.length}`);
  }
  return `${lines.join("\n")}\n`;
}
