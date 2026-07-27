import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILD_INFO,
  BuildCommandError,
  BuildIdentityError,
  assertReleaseBuildHost,
  assertWindowsReleaseSourceRoot,
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

const ROOT = path.resolve(import.meta.dir, "../..");
const windowsX64Test =
  process.platform === "win32" && process.arch === "x64" ? test : test.skip;

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
    expect(info.stateCompatibility).toBe(
      SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
    );
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
        "stateCompatibility=1",
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
      resolveBuildInfo({ ...completeMarkers, stateCompatibility: 0 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, stateCompatibility: 2 }),
    ).toThrow(BuildIdentityError);
    expect(() =>
      resolveBuildInfo({ ...completeMarkers, stateCompatibility: "1" }),
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

  test("requires the canonical Windows Bun host identity", () => {
    const target = "bun-windows-x64";
    const contract = releaseTargetContract(target);

    expect(() =>
      assertReleaseBuildHost(target, {
        platform: contract.platform,
        architecture: contract.architecture,
        workingDirectory: "C:\\sana-mcp",
      }),
    ).not.toThrow();

    for (const identity of [
      {
        platform: "linux",
        architecture: contract.architecture,
        workingDirectory: "/workspace/sana-mcp",
      },
      {
        platform: contract.platform,
        architecture: "arm64",
        workingDirectory: "C:\\sana-mcp",
      },
    ]) {
      try {
        assertReleaseBuildHost(target, identity);
        throw new Error(`accepted invalid host ${identity.platform}/${identity.architecture}`);
      } catch (error) {
        expect(error).toBeInstanceOf(BuildCommandError);
        const commandError = error as BuildCommandError;
        expect(commandError.code).toBe("INVALID_BUILD_COMMAND");
        expect(commandError.details).toEqual({
          kind: "host-mismatch",
          target,
          expectedPlatform: contract.platform,
          expectedArchitecture: contract.architecture,
          actualPlatform: identity.platform,
          actualArchitecture: identity.architecture,
        });
        expect(commandError.message).toContain(
          `from Bun host ${identity.platform}/${identity.architecture}`,
        );
        expect(commandError.message).toContain(
          `expected Bun host ${contract.platform}/${contract.architecture}`,
        );
      }
    }

    for (const workingDirectory of [
      "\\\\wsl.localhost\\Ubuntu\\home\\person\\sana-mcp",
      "\\\\WSL$\\Ubuntu\\home\\person\\sana-mcp",
      "//wsl.localhost/Ubuntu/home/person/sana-mcp",
      "\\\\build-server\\source\\sana-mcp",
    ]) {
      try {
        assertReleaseBuildHost(target, {
          platform: contract.platform,
          architecture: contract.architecture,
          workingDirectory,
        });
        throw new Error(`accepted unsupported WSL source root ${workingDirectory}`);
      } catch (error) {
        expect(error).toBeInstanceOf(BuildCommandError);
        const commandError = error as BuildCommandError;
        expect(commandError.code).toBe("INVALID_BUILD_COMMAND");
        expect(commandError.details).toEqual({
          kind: "unsupported-windows-source-root",
          target,
          workingDirectory,
          reason: "the source path is a UNC path",
        });
        expect(commandError.message).toContain("the source path is a UNC path");
        expect(commandError.message).toContain(
          "Copy the source to an ordinary directory on a local NTFS volume",
        );
      }
    }

    expect(() =>
      assertReleaseBuildHost(target, {
        platform: contract.platform,
        architecture: contract.architecture,
        workingDirectory: "\\\\?\\C:\\sana-mcp",
      }),
    ).not.toThrow();
  });

  test("leaves every non-Windows canonical target unaffected by host identity", () => {
    const identities = [
      {
        platform: "linux",
        architecture: "x64",
        workingDirectory: "/workspace/sana-mcp",
      },
      {
        platform: "win32",
        architecture: "arm64",
        workingDirectory: "\\\\wsl.localhost\\Ubuntu\\workspace",
      },
      {
        platform: "unsupported-platform",
        architecture: "unsupported-architecture",
        workingDirectory: "",
      },
    ];
    for (const target of RELEASE_TARGETS) {
      if (releaseTargetContract(target).platform === "win32") continue;
      for (const identity of identities) {
        expect(() => assertReleaseBuildHost(target, identity)).not.toThrow();
      }
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
      expect(config.bytecode).toBe(true);
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
        __SANA_STATE_COMPATIBILITY__: String(
          SUPPORTED_RELEASE_PROTOCOLS.stateCompatibility,
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

  test("both official build frontends reject Windows compilation before artifact mutation", () => {
    if (process.platform === "win32" && process.arch === "x64") return;

    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-build-host-guard-"),
    );
    try {
      const compileCwd = path.join(temporaryRoot, "compile-cwd");
      fs.mkdirSync(compileCwd);
      const compileDist = path.join(compileCwd, "dist");
      const compile = spawnSync(
        process.execPath,
        [
          path.join(ROOT, "src/runtime/build-info.ts"),
          "compile",
          "--target=bun-windows-x64",
        ],
        {
          cwd: compileCwd,
          encoding: "utf8",
          env: { ...process.env },
          timeout: 10_000,
        },
      );
      expect(compile.error).toBeUndefined();
      expect(compile.status).not.toBe(0);
      expect(compile.stderr).toContain("BuildCommandError");
      expect(compile.stderr).toContain("INVALID_BUILD_COMMAND");
      expect(compile.stderr).toContain(
        `from Bun host ${process.platform}/${process.arch}`,
      );
      expect(compile.stderr).toContain("expected Bun host win32/x64");
      expect(fs.existsSync(compileDist)).toBe(false);

      const releaseCwd = path.join(temporaryRoot, "release-cwd");
      fs.mkdirSync(releaseCwd);
      const releaseParent = path.join(temporaryRoot, "missing-release-parent");
      const releaseOutfile = path.join(releaseParent, "sana-mcp-windows-x64.exe");
      const release = spawnSync(
        process.execPath,
        [
          path.join(ROOT, "scripts/release.ts"),
          "build",
          "--target",
          "bun-windows-x64",
          "--outfile",
          releaseOutfile,
        ],
        {
          cwd: releaseCwd,
          encoding: "utf8",
          env: { ...process.env },
          timeout: 10_000,
        },
      );
      expect(release.error).toBeUndefined();
      expect(release.status).not.toBe(0);
      expect(release.stderr).toContain("BuildCommandError");
      expect(release.stderr).toContain("INVALID_BUILD_COMMAND");
      expect(release.stderr).toContain(
        `from Bun host ${process.platform}/${process.arch}`,
      );
      expect(release.stderr).toContain("expected Bun host win32/x64");
      expect(fs.existsSync(releaseParent)).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  windowsX64Test(
    "both official frontends reject UNC, mapped, SUBST, and junction source aliases before output mutation",
    () => {
      const systemRoot = process.env.SystemRoot;
      if (systemRoot === undefined) {
        throw new Error("Windows did not provide SystemRoot");
      }
      const substExecutable = path.win32.join(
        systemRoot,
        "System32",
        "subst.exe",
      );
      const netExecutable = path.win32.join(systemRoot, "System32", "net.exe");
      const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "sana-native-source-guard-"),
      );
      const source = path.join(temporaryRoot, "ordinary-source");
      const junction = path.join(temporaryRoot, "junction-source");
      const attackerSystemRoot = path.join(temporaryRoot, "attacker-windows");
      const attackerPowerShell = path.join(
        attackerSystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      fs.mkdirSync(source);
      fs.symlinkSync(source, junction, "junction");
      fs.mkdirSync(path.dirname(attackerPowerShell), { recursive: true });
      fs.copyFileSync(
        path.win32.join(systemRoot, "System32", "cmd.exe"),
        attackerPowerShell,
      );
      const hostileEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            ![
              "SANA_RELEASE_SOURCE_ROOT",
              "SYSTEMROOT",
              "WINDIR",
            ].includes(name.toUpperCase()),
        ),
      );
      hostileEnvironment.sana_release_source_root = source;
      hostileEnvironment.SystemRoot = systemRoot;
      hostileEnvironment.WINDIR = systemRoot;

      const sourceRoot = path.parse(source).root;
      const driveLetter = sourceRoot.slice(0, 1).toLowerCase();
      const sourceRelative = path.relative(sourceRoot, source);
      const administrativeShare = `\\\\localhost\\${driveLetter}$`;
      const operationDeadline = performance.now() + 85_000;
      const cleanupDeadline = performance.now() + 115_000;
      const runBounded = (
        executable: string,
        args: readonly string[],
        deadline: number,
        maximumMs = 10_000,
      ) => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) {
          throw new Error(
            `native source-guard outer deadline expired before ${path.basename(executable)} ${args.join(" ")}`,
          );
        }
        return spawnSync(executable, args, {
          encoding: "utf8",
          windowsHide: true,
          timeout: Math.max(1, Math.min(maximumMs, remaining)),
        });
      };
      const querySubst = (_drive: string, deadline: number) =>
        runBounded(substExecutable, [], deadline);
      const queryMapping = (drive: string, deadline: number) =>
        runBounded(netExecutable, ["use", drive], deadline);
      const exactSubstAuthority = (
        result: ReturnType<typeof spawnSync>,
        drive: string,
      ): boolean =>
        result.error === undefined &&
        result.status === 0 &&
        result.stdout
          .replaceAll("/", "\\")
          .split(/\r?\n/u)
          .map((line) => line.trim().toUpperCase())
          .includes(
            `${drive.toUpperCase()}\\: => ${source
              .replaceAll("/", "\\")
              .toUpperCase()}`,
          );
      const exactMappingAuthority = (
        result: ReturnType<typeof spawnSync>,
      ): boolean =>
        result.error === undefined &&
        result.status === 0 &&
        result.stdout
          .replaceAll("/", "\\")
          .toUpperCase()
          .split(/\s+/u)
          .includes(administrativeShare.toUpperCase());
      const unusedDrives = ["Z:", "Y:", "X:", "W:", "V:", "U:"].filter(
        (drive) =>
          !fs.existsSync(`${drive}\\`) &&
          !exactSubstAuthority(
            querySubst(drive, operationDeadline),
            drive,
          ) &&
          queryMapping(drive, operationDeadline).status !== 0,
      );
      const substDrive = unusedDrives[0];
      const mappedDrive = unusedDrives[1];
      if (substDrive === undefined || mappedDrive === undefined) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw new Error("two authoritatively unused drive letters are required");
      }
      const uncSource = path.win32.join(administrativeShare, sourceRelative);
      const mappedSource = path.win32.join(`${mappedDrive}\\`, sourceRelative);
      let substCreated = false;
      let mappingCreated = false;
      let primaryFailure: unknown;

      try {
        const createSubst = runBounded(
          substExecutable,
          [substDrive, source],
          operationDeadline,
        );
        if (createSubst.error !== undefined || createSubst.status !== 0) {
          throw new Error(
            `could not create isolated SUBST alias: ${createSubst.error?.message ?? createSubst.stderr}`,
          );
        }
        substCreated = true;
        const substAuthority = querySubst(substDrive, operationDeadline);
        if (!exactSubstAuthority(substAuthority, substDrive)) {
          throw new Error(
            "SUBST setup did not publish the exact queried source authority",
          );
        }
        const createMapping = runBounded(
          netExecutable,
          ["use", mappedDrive, administrativeShare, "/persistent:no"],
          operationDeadline,
        );
        if (createMapping.error !== undefined || createMapping.status !== 0) {
          throw new Error(
            `could not create isolated mapped-network alias: ${createMapping.error?.message ?? createMapping.stderr}`,
          );
        }
        mappingCreated = true;
        const mappingAuthority = queryMapping(mappedDrive, operationDeadline);
        if (!exactMappingAuthority(mappingAuthority)) {
          throw new Error(
            "mapped-drive setup did not publish the exact queried share authority",
          );
        }
        const originalSystemRoot = process.env.SystemRoot;
        const originalSourceRoot = process.env.SANA_RELEASE_SOURCE_ROOT;
        try {
          process.env.systemroot = attackerSystemRoot;
          process.env.sana_release_source_root = source;
          expect(() =>
            assertWindowsReleaseSourceRoot("bun-windows-x64", {
              platform: "win32",
              workingDirectory: `\\\\?\\${source}`,
            }),
          ).not.toThrow();
          expect(() =>
            assertWindowsReleaseSourceRoot("bun-windows-x64", {
              platform: "win32",
              workingDirectory: junction,
            }),
          ).toThrow(BuildCommandError);
        } finally {
          if (originalSystemRoot === undefined) {
            delete process.env.SystemRoot;
          } else {
            process.env.SystemRoot = originalSystemRoot;
          }
          if (originalSourceRoot === undefined) {
            delete process.env.SANA_RELEASE_SOURCE_ROOT;
          } else {
            process.env.SANA_RELEASE_SOURCE_ROOT = originalSourceRoot;
          }
        }

        for (const [aliasName, workingDirectory] of [
          ["subst", `${substDrive}\\`],
          ["junction", junction],
          ["unc", uncSource],
          ["mapped", mappedSource],
        ] as const) {
          const compileDist = path.join(workingDirectory, "dist");
          const compileRemaining = Math.floor(
            operationDeadline - performance.now(),
          );
          if (compileRemaining <= 0) {
            throw new Error("native source-guard deadline expired before compile");
          }
          const boundedCompile = spawnSync(
            process.execPath,
            [
              path.join(ROOT, "src/runtime/build-info.ts"),
              "compile",
              "--target=bun-windows-x64",
            ],
            {
              cwd: workingDirectory,
              encoding: "utf8",
              env: hostileEnvironment,
              timeout: Math.min(30_000, compileRemaining),
              windowsHide: true,
            },
          );
          expect(boundedCompile.error, `${aliasName} compile spawn`).toBeUndefined();
          expect(boundedCompile.status, `${aliasName} compile status`).not.toBe(0);
          expect(boundedCompile.stderr).toContain("ordinary directory on a local NTFS volume");
          expect(fs.existsSync(compileDist)).toBe(false);

          const releaseParent = path.join(
            temporaryRoot,
            `missing-${aliasName}-release-parent`,
          );
          const releaseRemaining = Math.floor(
            operationDeadline - performance.now(),
          );
          if (releaseRemaining <= 0) {
            throw new Error("native source-guard deadline expired before release build");
          }
          const release = spawnSync(
            process.execPath,
            [
              path.join(ROOT, "scripts/release.ts"),
              "build",
              "--target",
              "bun-windows-x64",
              "--outfile",
              path.join(releaseParent, "sana-mcp-windows-x64.exe"),
            ],
            {
              cwd: workingDirectory,
              encoding: "utf8",
              env: hostileEnvironment,
              timeout: Math.min(30_000, releaseRemaining),
              windowsHide: true,
            },
          );
          expect(release.error, `${aliasName} release spawn`).toBeUndefined();
          expect(release.status, `${aliasName} release status`).not.toBe(0);
          expect(release.stderr).toContain("ordinary directory on a local NTFS volume");
          expect(fs.existsSync(releaseParent)).toBe(false);
        }
      } catch (error) {
        primaryFailure = error;
      } finally {
        const cleanupFailures: Error[] = [];
        if (mappingCreated) {
          try {
            const authority = queryMapping(mappedDrive, cleanupDeadline);
            if (!exactMappingAuthority(authority)) {
              throw new Error(
                "refusing to remove mapped drive without its exact queried share authority",
              );
            }
            const removeMapping = runBounded(
              netExecutable,
              ["use", mappedDrive, "/delete", "/y"],
              cleanupDeadline,
            );
            if (removeMapping.error !== undefined || removeMapping.status !== 0) {
              throw new Error(
                `could not remove isolated mapped-network alias: ${removeMapping.error?.message ?? removeMapping.stderr}`,
              );
            }
            if (
              exactMappingAuthority(
                queryMapping(mappedDrive, cleanupDeadline),
              )
            ) {
              throw new Error(
                "exact mapped-drive authority remained after cleanup",
              );
            }
          } catch (error) {
            cleanupFailures.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        if (substCreated) {
          try {
            const authority = querySubst(substDrive, cleanupDeadline);
            if (!exactSubstAuthority(authority, substDrive)) {
              throw new Error(
                "refusing to remove SUBST drive without its exact queried source authority",
              );
            }
            const removeSubst = runBounded(
              substExecutable,
              [substDrive, "/D"],
              cleanupDeadline,
            );
            if (removeSubst.error !== undefined || removeSubst.status !== 0) {
              throw new Error(
                `could not remove isolated SUBST alias: ${removeSubst.error?.message ?? removeSubst.stderr}`,
              );
            }
            if (
              exactSubstAuthority(
                querySubst(substDrive, cleanupDeadline),
                substDrive,
              )
            ) {
              throw new Error("exact SUBST authority remained after cleanup");
            }
          } catch (error) {
            cleanupFailures.push(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        try {
          fs.rmSync(temporaryRoot, { recursive: true, force: true });
        } catch (error) {
          cleanupFailures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        const failures = [
          ...(primaryFailure === undefined ? [] : [primaryFailure]),
          ...cleanupFailures,
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            `native source guard test and cleanup both failed: ${failures
              .map((failure) =>
                failure instanceof Error ? failure.message : String(failure),
              )
              .join("; ")}`,
          );
        }
      }
    },
    120_000,
  );
});
