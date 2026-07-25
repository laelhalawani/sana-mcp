import { describe, expect, test } from "bun:test";
import {
  BUILD_INFO,
  BuildCommandError,
  BuildIdentityError,
  createStandaloneBuildConfig,
  KEYWORD_STANDALONE_EXTERNALS,
  parseCompileTarget,
  resolveBuildInfo,
  serializeStandaloneBuildInfoProperties,
  SUPPORTED_COMPILE_TARGETS,
  type BuildMarkers,
} from "../../src/runtime/build-info.js";
import {
  RELEASE_TARGETS,
  SOURCE_SEMANTIC_CAPABILITY,
  STANDALONE_SEMANTIC_CAPABILITY,
  SUPPORTED_RELEASE_PROTOCOLS,
  releaseTargetContract,
  releaseTargetForRuntime,
  type ReleaseTarget,
} from "../../src/release/contract.js";

const completeMarkers = {
  standalone: true,
  version: BUILD_INFO.version,
  target: "bun-linux-x64",
  ...SUPPORTED_RELEASE_PROTOCOLS,
  semanticCapability: STANDALONE_SEMANTIC_CAPABILITY,
} as const;

describe("build identity", () => {
  test("preserves the compile-target re-export as the canonical frozen tuple", () => {
    expect(SUPPORTED_COMPILE_TARGETS).toBe(RELEASE_TARGETS);
    expect(Object.isFrozen(SUPPORTED_COMPILE_TARGETS)).toBe(true);
  });

  test("source execution has an authoritative package version and unavailable target", () => {
    const info = resolveBuildInfo({});
    expect(info.mode).toBe("source");
    expect(info.standalone).toBe(false);
    expect(info.version).toBe(BUILD_INFO.version);
    expect(info.target).toBeNull();
    expect(info.semanticCapability).toBe(SOURCE_SEMANTIC_CAPABILITY);
  });

  test("accepts a complete standalone marker set", () => {
    expect(resolveBuildInfo(completeMarkers)).toEqual({
      mode: "standalone",
      ...completeMarkers,
    });
  });

  test("serializes an exact standalone installer identity without fallback values", () => {
    expect(
      serializeStandaloneBuildInfoProperties(resolveBuildInfo(completeMarkers)),
    ).toBe(
      [
        "inspectProtocol=1",
        `version=${BUILD_INFO.version}`,
        "target=bun-linux-x64",
        "installerProtocol=1",
        "lifecycleProtocol=1",
        "semanticCapability=keyword",
        "",
      ].join("\n"),
    );
    expect(() =>
      serializeStandaloneBuildInfoProperties(resolveBuildInfo({})),
    ).toThrow(BuildIdentityError);
  });

  test("rejects every partial marker set instead of guessing missing identity", () => {
    for (const field of Object.keys(completeMarkers) as Array<keyof typeof completeMarkers>) {
      const partial: Record<string, unknown> = { ...completeMarkers };
      delete partial[field];
      expect(() => resolveBuildInfo(partial), `missing ${field}`).toThrow(
        BuildIdentityError,
      );
    }
  });

  test("rejects a marker version that differs from package metadata", () => {
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, version: "999.0.0" }),
    ).toThrow(BuildIdentityError);
  });

  test("rejects loose semantic-version forms before package comparison", () => {
    for (const version of [
      "01.2.3",
      "1.2",
      "1.2.3-",
      "1.2.3+",
      "1.2.3-01",
      "1.2.3-alpha..1",
      "1.2.3+meta..1",
      "1.2.3-alpha_1",
    ]) {
      expect(() =>
        resolveBuildInfo({ ...completeMarkers, version }),
      ).toThrow(BuildIdentityError);
    }
  });

  test("rejects unknown, empty, and invalid marker values", () => {
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, target: "" }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, target: "bun-linux-aarch64-modern" }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, installerProtocol: 0 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, installerProtocol: 2 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, lifecycleProtocol: 2 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, inspectProtocol: 2 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, semanticCapability: "invented" }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, semanticCapability: "source-semantic" }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({
        ...completeMarkers,
        unexpected: "value",
      } as BuildMarkers),
    ).toThrow(BuildIdentityError);
  });

  test("requires an explicit valid target for standalone compilation", () => {
    expect(parseCompileTarget(["compile", "--target=bun-linux-x64-musl"])).toBe(
      "bun-linux-x64-musl",
    );
    expect(parseCompileTarget(["compile", "--target", "bun-windows-x64"])).toBe(
      "bun-windows-x64",
    );
    for (const args of [
      [],
      ["compile"],
      ["compile", "--target="],
      ["compile", "--target=linux-x64"],
      ["compile", "--target=bun-linux-x64-glibc"],
      ["compile", "--target=bun-linux-aarch64"],
      ["compile", "--target=bun-windows-arm64"],
      ["compile", "--target=bun-linux-x64", "--extra"],
    ]) {
      expect(() => parseCompileTarget(args)).toThrow(BuildCommandError);
    }
  });

  test("maps runtime tuples only through the canonical target contract", () => {
    for (const target of RELEASE_TARGETS) {
      const contract = releaseTargetContract(target);
      expect(releaseTargetForRuntime(contract)).toBe(target);
    }
  });

  test("embeds every selected canonical target without translation", () => {
    for (const target of RELEASE_TARGETS) {
      const parsed: ReleaseTarget = parseCompileTarget([
        "compile",
        `--target=${target}`,
      ]);
      expect(parsed).toBe(target);

      const config = createStandaloneBuildConfig(parsed);
      const externals = config.external;
      if (externals === undefined) {
        throw new Error(`standalone build ${target} omitted its externals`);
      }
      expect(externals).toEqual([
        "@huggingface/transformers",
        "sqlite-vec",
      ]);
      expect(KEYWORD_STANDALONE_EXTERNALS).toEqual(externals);
      expect(config.compile).toEqual({
        target,
        outfile: "dist/sana-mcp",
        autoloadDotenv: false,
        autoloadBunfig: false,
      });
      expect(config.define).toMatchObject({
        __SANA_BUILD_STANDALONE__: "true",
        __SANA_BUILD_TARGET__: JSON.stringify(target),
        __SANA_INSTALLER_PROTOCOL__: String(
          SUPPORTED_RELEASE_PROTOCOLS.installerProtocol,
        ),
        __SANA_LIFECYCLE_PROTOCOL__: String(
          SUPPORTED_RELEASE_PROTOCOLS.lifecycleProtocol,
        ),
        __SANA_INSPECT_PROTOCOL__: String(
          SUPPORTED_RELEASE_PROTOCOLS.inspectProtocol,
        ),
        __SANA_SEMANTIC_CAPABILITY__: JSON.stringify(
          STANDALONE_SEMANTIC_CAPABILITY,
        ),
      });

      expect(
        resolveBuildInfo({
          ...completeMarkers,
          target,
        }).target,
      ).toBe(target);
    }
  });
});
