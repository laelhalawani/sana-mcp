export const RELEASE_MANIFEST_VERSION = 1 as const;

export const SUPPORTED_RELEASE_PROTOCOLS = Object.freeze({
  installerProtocol: 1,
  lifecycleProtocol: 1,
  inspectProtocol: 1,
} as const);

export const SOURCE_SEMANTIC_CAPABILITY = "source-semantic" as const;
export const STANDALONE_SEMANTIC_CAPABILITY = "keyword" as const;

export type SemanticCapability =
  | typeof SOURCE_SEMANTIC_CAPABILITY
  | typeof STANDALONE_SEMANTIC_CAPABILITY;

const RELEASE_SEMVER_CORE =
  String.raw`(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)` +
  String.raw`(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)` +
  String.raw`(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?` +
  String.raw`(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?`;

export const RELEASE_SEMVER_PATTERN_SOURCE =
  `^${RELEASE_SEMVER_CORE}$` as const;
export const RELEASE_TAG_PATTERN_SOURCE =
  `^v${RELEASE_SEMVER_CORE}$` as const;

export const RELEASE_SEMVER_PATTERN = Object.freeze(
  new RegExp(RELEASE_SEMVER_PATTERN_SOURCE),
);
export const RELEASE_TAG_PATTERN = Object.freeze(
  new RegExp(RELEASE_TAG_PATTERN_SOURCE),
);
export const RELEASE_COMMIT_PATTERN_SOURCE = "^[a-f0-9]{40}$" as const;
export const RELEASE_COMMIT_PATTERN = Object.freeze(
  new RegExp(RELEASE_COMMIT_PATTERN_SOURCE),
);

export function isReleaseSemver(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RELEASE_SEMVER_PATTERN.test(value)
  );
}

export function isReleaseTag(value: unknown): value is string {
  return typeof value === "string" && RELEASE_TAG_PATTERN.test(value);
}

export function isReleaseCommit(value: unknown): value is string {
  return typeof value === "string" && RELEASE_COMMIT_PATTERN.test(value);
}

export const RELEASE_LIBC = Object.freeze({
  glibc: "glibc",
  musl: "musl",
} as const);

export type ReleaseLibc = (typeof RELEASE_LIBC)[keyof typeof RELEASE_LIBC];

const releaseTargetContracts = [
  {
    target: "bun-linux-x64",
    platform: "linux",
    architecture: "x64",
    libc: RELEASE_LIBC.glibc,
  },
  {
    target: "bun-linux-x64-musl",
    platform: "linux",
    architecture: "x64",
    libc: RELEASE_LIBC.musl,
  },
  {
    target: "bun-linux-arm64",
    platform: "linux",
    architecture: "arm64",
    libc: RELEASE_LIBC.glibc,
  },
  {
    target: "bun-linux-arm64-musl",
    platform: "linux",
    architecture: "arm64",
    libc: RELEASE_LIBC.musl,
  },
  {
    target: "bun-darwin-x64",
    platform: "darwin",
    architecture: "x64",
    libc: null,
  },
  {
    target: "bun-darwin-arm64",
    platform: "darwin",
    architecture: "arm64",
    libc: null,
  },
  {
    target: "bun-windows-x64",
    platform: "win32",
    architecture: "x64",
    libc: null,
  },
] as const;

for (const contract of releaseTargetContracts) Object.freeze(contract);

export const RELEASE_TARGET_CONTRACTS = Object.freeze(releaseTargetContracts);

export type ReleaseTargetContract =
  (typeof RELEASE_TARGET_CONTRACTS)[number];
export type ReleaseTarget = ReleaseTargetContract["target"];
export type ReleaseArchitecture = ReleaseTargetContract["architecture"];
export type ReleasePlatform = ReleaseTargetContract["platform"];

type RuntimeIdentity<T extends ReleaseTargetContract> = T extends unknown
  ? Readonly<Pick<T, "platform" | "architecture" | "libc">>
  : never;

export type ReleaseRuntimeIdentity =
  RuntimeIdentity<ReleaseTargetContract>;

type TargetTuple<
  T extends readonly ReleaseTargetContract[],
> = Readonly<{
  [Index in keyof T]: T[Index] extends ReleaseTargetContract
    ? T[Index]["target"]
    : never;
}>;

function projectReleaseTargets<
  const T extends readonly ReleaseTargetContract[],
>(contracts: T): TargetTuple<T> {
  return Object.freeze(
    contracts.map((contract) => contract.target),
  ) as TargetTuple<T>;
}

export const RELEASE_TARGETS = projectReleaseTargets(
  RELEASE_TARGET_CONTRACTS,
);

export type ReleaseGlibcTarget = Extract<
  ReleaseTargetContract,
  { libc: "glibc" }
>["target"];
export type ReleaseMuslTarget = Extract<
  ReleaseTargetContract,
  { libc: "musl" }
>["target"];
export type ReleaseDarwinTarget = Extract<
  ReleaseTargetContract,
  { platform: "darwin" }
>["target"];
export type ReleaseWindowsTarget = Extract<
  ReleaseTargetContract,
  { platform: "win32" }
>["target"];

export class ReleaseTargetContractError extends Error {
  readonly code = "UNSUPPORTED_RELEASE_TARGET";

  constructor(
    message: string,
    readonly identity:
      | Readonly<{ target: unknown }>
      | Readonly<{
          platform: unknown;
          architecture: unknown;
          libc: unknown;
        }>,
  ) {
    super(message);
    this.name = "ReleaseTargetContractError";
  }
}

export function isReleaseTarget(value: unknown): value is ReleaseTarget {
  return RELEASE_TARGET_CONTRACTS.some(
    (contract) => contract.target === value,
  );
}

export function releaseTargetContract(
  target: ReleaseTarget,
): ReleaseTargetContract {
  const contract = RELEASE_TARGET_CONTRACTS.find(
    (candidate) => candidate.target === target,
  );
  if (contract === undefined) {
    throw new ReleaseTargetContractError(
      "The release target is not present in the canonical target contract",
      { target },
    );
  }
  return contract;
}

export function releaseTargetForRuntime(
  identity: ReleaseRuntimeIdentity,
): ReleaseTarget {
  const contract = RELEASE_TARGET_CONTRACTS.find(
    (candidate) =>
      candidate.platform === identity.platform &&
      candidate.architecture === identity.architecture &&
      candidate.libc === identity.libc,
  );
  if (contract === undefined) {
    throw new ReleaseTargetContractError(
      "The runtime tuple is not a supported release target",
      identity,
    );
  }
  return contract.target;
}

export function releaseAssetName(target: ReleaseTarget): string {
  const suffix = target.slice("bun-".length);
  return `sana-mcp-${suffix}${target.startsWith("bun-windows-") ? ".exe" : ""}`;
}

export function releaseMetadataFileName(target: ReleaseTarget): string {
  return `manifest-${target}.properties`;
}
