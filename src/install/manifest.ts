import { z } from "zod";
import {
  RELEASE_LIBC,
  RELEASE_MANIFEST_VERSION,
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  isReleaseSemver,
  isReleaseTag,
  isReleaseCommit,
  releaseAssetName,
  releaseTargetContract,
  type ReleaseDarwinTarget,
  type ReleaseGlibcTarget,
  type ReleaseLibc,
  type ReleaseMuslTarget,
  type ReleaseTarget,
  type ReleaseWindowsTarget,
} from "../release/contract.js";

export {
  RELEASE_LIBC,
  RELEASE_MANIFEST_VERSION,
  RELEASE_TARGETS,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
};
export type {
  ReleaseDarwinTarget,
  ReleaseGlibcTarget,
  ReleaseLibc,
  ReleaseMuslTarget,
  ReleaseTarget,
  ReleaseWindowsTarget,
};

export type ReleaseSemanticCapability =
  typeof STANDALONE_SEMANTIC_CAPABILITY;

interface ReleaseAssetFields {
  readonly assetName: string;
  readonly checksumFileName: string;
  readonly sha256: string;
}

export type ReleaseAsset = ReleaseAssetFields &
  (
    | Readonly<{ target: ReleaseGlibcTarget; libc: "glibc" }>
    | Readonly<{ target: ReleaseMuslTarget; libc: "musl" }>
    | Readonly<{ target: ReleaseDarwinTarget; libc?: never }>
    | Readonly<{ target: ReleaseWindowsTarget; libc?: never }>
  );

export interface ReleaseManifest {
  readonly manifestVersion: typeof RELEASE_MANIFEST_VERSION;
  readonly packageVersion: string;
  readonly releaseTag: string;
  readonly sourceCommit: string;
  readonly installerProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.installerProtocol;
  readonly lifecycleProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol;
  readonly inspectProtocol: typeof SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol;
  readonly semanticCapability: ReleaseSemanticCapability;
  readonly assets: readonly ReleaseAsset[];
}

const releaseAssetNamePattern =
  /^(?=.{1,255}$)(?!.*[. ]$)(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]*$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;

const releaseTargetSchema = z.enum(RELEASE_TARGETS);

const releaseAssetFields = {
  assetName: z
    .string()
    .regex(releaseAssetNamePattern, "must be a safe release asset basename"),
  checksumFileName: z
    .string()
    .regex(releaseAssetNamePattern, "must be a safe checksum asset basename"),
  sha256: z.string().regex(sha256Pattern, "must be a lowercase SHA-256 digest"),
} as const;

const releaseAssetSchema = z
  .object({
    target: releaseTargetSchema,
    libc: z.enum([RELEASE_LIBC.glibc, RELEASE_LIBC.musl]).optional(),
    ...releaseAssetFields,
  })
  .strict()
  .superRefine((asset, context) => {
    const targetContract = releaseTargetContract(asset.target);
    if (targetContract.libc === null) {
      if (Object.hasOwn(asset, "libc")) {
        context.addIssue({
          code: "custom",
          path: ["libc"],
          message: "must be omitted for a non-Linux target",
        });
      }
    } else if (asset.libc !== targetContract.libc) {
      context.addIssue({
        code: "custom",
        path: ["libc"],
        message: `must be ${targetContract.libc} for target ${asset.target}`,
      });
    }

    if (
      targetContract.platform === "win32" &&
      !asset.assetName.toLowerCase().endsWith(".exe")
    ) {
      context.addIssue({
        code: "custom",
        path: ["assetName"],
        message: "must have an .exe suffix for a Windows target",
      });
    }
    if (
      targetContract.platform !== "win32" &&
      asset.assetName.toLowerCase().endsWith(".exe")
    ) {
      context.addIssue({
        code: "custom",
        path: ["assetName"],
        message: "must not have an .exe suffix for a non-Windows target",
      });
    }

    if (asset.checksumFileName !== `${asset.assetName}.sha256`) {
      context.addIssue({
        code: "custom",
        path: ["checksumFileName"],
        message: "must name the declared asset followed by .sha256",
      });
    }
    const expectedAssetName = releaseAssetName(asset.target);
    if (asset.assetName !== expectedAssetName) {
      context.addIssue({
        code: "custom",
        path: ["assetName"],
        message: `must exactly equal ${expectedAssetName} for target ${asset.target}`,
      });
    }
  })
  .transform((asset): ReleaseAsset => asset as ReleaseAsset);

export interface ManifestValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class ReleaseManifestError extends Error {
  readonly code: "INVALID_MANIFEST_JSON" | "INVALID_RELEASE_MANIFEST";

  constructor(
    code: "INVALID_MANIFEST_JSON" | "INVALID_RELEASE_MANIFEST",
    readonly issues: readonly ManifestValidationIssue[],
  ) {
    super(
      code === "INVALID_MANIFEST_JSON"
        ? "Release manifest is not valid JSON"
        : "Release manifest is invalid",
    );
    this.name = "ReleaseManifestError";
    this.code = code;
  }
}

export type ManifestAssetResolution =
  | Readonly<{ state: "available"; asset: ReleaseAsset }>
  | Readonly<{ state: "unavailable"; reason: "target-not-published"; target: ReleaseTarget }>
  | Readonly<{ state: "invalid"; reason: "invalid-target" }>;

const releaseManifestSchema = z
  .object({
    manifestVersion: z.literal(RELEASE_MANIFEST_VERSION),
    packageVersion: z
      .string()
      .refine(isReleaseSemver, "must be a strict semantic version"),
    releaseTag: z
      .string()
      .refine(isReleaseTag, "must be a v-prefixed strict semantic version"),
    sourceCommit: z
      .string()
      .refine(isReleaseCommit, "must be a lowercase full Git commit SHA"),
    installerProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.installerProtocol),
    lifecycleProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol),
    inspectProtocol: z.literal(SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol),
    semanticCapability: z.literal(STANDALONE_SEMANTIC_CAPABILITY),
    assets: z.array(releaseAssetSchema).min(1).max(RELEASE_TARGETS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.releaseTag !== `v${manifest.packageVersion}`) {
      context.addIssue({
        code: "custom",
        path: ["releaseTag"],
        message: "must exactly equal v followed by packageVersion",
      });
    }

    const targets = new Set<string>();
    const releaseFileNames = new Set<string>();
    manifest.assets.forEach((asset, index) => {
      if (targets.has(asset.target)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "target"],
          message: "duplicates a previously declared target",
        });
      } else {
        targets.add(asset.target);
      }

      for (const [value, path] of [
        [asset.assetName, "assetName"],
        [asset.checksumFileName, "checksumFileName"],
      ] as const) {
        const portableName = value.toLowerCase();
        if (releaseFileNames.has(portableName)) {
          context.addIssue({
            code: "custom",
            path: ["assets", index, path],
            message: "duplicates a previously declared release filename",
          });
        } else {
          releaseFileNames.add(portableName);
        }
      }
    });
  });

function validationIssues(error: z.ZodError): readonly ManifestValidationIssue[] {
  return Object.freeze(
    error.issues.map((issue) =>
      Object.freeze({
        // These paths come solely from the static JSON object/array schema above,
        // so Zod's wider PropertyKey type cannot contain a symbol here.
        path: Object.freeze([...issue.path] as (string | number)[]),
        message: issue.message,
      }),
    ),
  );
}

function freezeManifest(manifest: z.output<typeof releaseManifestSchema>): ReleaseManifest {
  const assets = manifest.assets.map((asset) => Object.freeze({ ...asset }));
  return Object.freeze({ ...manifest, assets: Object.freeze(assets) });
}

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  const parsed = releaseManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ReleaseManifestError(
      "INVALID_RELEASE_MANIFEST",
      validationIssues(parsed.error),
    );
  }
  return freezeManifest(parsed.data);
}

export function parseReleaseManifestJson(input: string): ReleaseManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new ReleaseManifestError(
      "INVALID_MANIFEST_JSON",
      Object.freeze([
        Object.freeze({ path: Object.freeze([]), message: "JSON parsing failed" }),
      ]),
    );
  }
  return parseReleaseManifest(decoded);
}

export function resolveManifestAsset(
  manifest: ReleaseManifest,
  target: unknown,
): ManifestAssetResolution {
  const parsedTarget = releaseTargetSchema.safeParse(target);
  if (!parsedTarget.success) {
    return Object.freeze({ state: "invalid", reason: "invalid-target" });
  }
  const asset = manifest.assets.find(
    (candidate) => candidate.target === parsedTarget.data,
  );
  return asset === undefined
    ? Object.freeze({
        state: "unavailable",
        reason: "target-not-published",
        target: parsedTarget.data,
      })
    : Object.freeze({ state: "available", asset });
}
