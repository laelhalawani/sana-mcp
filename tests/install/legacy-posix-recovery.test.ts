import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
  inspectLegacyPosixRecovery,
  recoverLegacyPosixInstall,
  serializeLegacyPosixRecoveryResult,
  type LegacyLinuxProcess,
  type LegacyPosixRecoveryDependencies,
  type LegacyPosixReleaseIdentity,
  type LegacyProcessProvider,
} from "../../src/install/legacy-posix-recovery.js";

const VERSION = "0.4.17";
const TARGET = "bun-linux-x64";
const ASSET = "sana-mcp-linux-x64";
const SOURCE_COMMIT = "98947228419b354c80f73461123cd1cd2e5a23e9";
const UUID = "12345678-1234-4123-8123-123456789abc";

function sha256(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function pathBlock(installDir: string): Buffer {
  return Buffer.from(
    [
      "# >>> sana-mcp installer >>>",
      `export PATH='${installDir}':"$PATH"`,
      "# <<< sana-mcp installer <<<",
      "",
    ].join("\n"),
  );
}

function stagedProfile(canonical: Buffer | undefined, installDir: string): Buffer {
  if (canonical === undefined) return pathBlock(installDir);
  const separator =
    canonical.length > 0 && canonical[canonical.length - 1] !== 0x0a
      ? Buffer.from("\n\n")
      : Buffer.from("\n");
  return Buffer.concat([canonical, separator, pathBlock(installDir)]);
}

function fakeRelease(binaryDigest: string): LegacyPosixReleaseIdentity {
  return {
    version: VERSION,
    tag: `v${VERSION}`,
    target: TARGET,
    sourceCommit: SOURCE_COMMIT,
    installerProtocol: 1,
    lifecycleProtocol: 1,
    inspectProtocol: 1,
    stateCompatibility: 1,
    semanticCapability: "bundled",
    assetName: ASSET,
    sha256: binaryDigest,
  };
}

class FakeProcesses implements LegacyProcessProvider {
  readonly records = new Map<number, LegacyLinuxProcess>();
  readonly killed: Array<readonly [number, NodeJS.Signals]> = [];

  constructor(cohort: number) {
    this.records.set(4100, {
      pid: 4100,
      ppid: 3000,
      uid: process.getuid!(),
      command: "sh",
      executable: "/usr/bin/dash",
      argv: ["/bin/sh", "/tmp/install.sh"],
      state: "S",
      startToken: "987654",
      startedAtSecond: cohort - 30,
    });
    this.records.set(4101, {
      pid: 4101,
      ppid: 4100,
      uid: process.getuid!(),
      command: "sync",
      executable: "/usr/bin/sync",
      argv: ["sync"],
      state: "D",
      startToken: "987660",
      startedAtSecond: cohort,
    });
  }

  async scanSameUid(uid: number): Promise<readonly LegacyLinuxProcess[]> {
    return [...this.records.values()].filter((process) => process.uid === uid);
  }

  async read(pid: number): Promise<LegacyLinuxProcess | undefined> {
    return this.records.get(pid);
  }

  kill = (pid: number, signal: NodeJS.Signals): void => {
    this.killed.push([pid, signal]);
    if (pid === 4100) {
      this.records.delete(pid);
      const sync = this.records.get(4101);
      if (sync !== undefined) this.records.set(4101, { ...sync, ppid: 1 });
    }
  };
}

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly installDir: string;
  readonly profile: string;
  readonly stage: string;
  readonly binary: string;
  readonly installLock: string;
  readonly pathLock: string;
  readonly dataSentinel: string;
  readonly canonicalBody?: Buffer;
  readonly cohort: number;
  readonly binaryDigest: string;
  readonly processes: FakeProcesses;
  dependencies(overrides?: LegacyPosixRecoveryDependencies): LegacyPosixRecoveryDependencies;
}

function writeLock(directory: string, token: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, token), `${token}\n`, { mode: 0o600 });
  fs.chmodSync(directory, 0o700);
  fs.chmodSync(path.join(directory, token), 0o600);
}

function setCohort(targets: readonly string[], cohort: number): void {
  for (const target of targets) fs.utimesSync(target, cohort, cohort);
}

function shiftProcessWallTimes(processes: FakeProcesses, seconds: number): void {
  for (const [pid, process] of processes.records) {
    processes.records.set(pid, {
      ...process,
      startedAtSecond: process.startedAtSecond + seconds,
    });
  }
}

function procStat(
  pid: number,
  command: string,
  state: string,
  ppid: number,
  startToken: string,
): string {
  return `${pid} (${command}) ${[
    state,
    String(ppid),
    ...Array(17).fill("0"),
    startToken,
  ].join(" ")}\n`;
}

function createFixture(options: { profile?: "present" | "absent" } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-legacy-recovery-"));
  const home = path.join(root, "home");
  const installDir = path.join(home, ".local", "bin");
  fs.mkdirSync(installDir, { recursive: true });
  const profile = path.join(home, ".bashrc");
  const canonicalBody =
    options.profile === "absent" ? undefined : Buffer.from("# canonical profile\n");
  if (canonicalBody !== undefined) fs.writeFileSync(profile, canonicalBody, { mode: 0o644 });
  const stage = path.join(home, ".bashrc.sana-mcp.Ab12z9");
  fs.writeFileSync(stage, stagedProfile(canonicalBody, installDir), {
    mode: canonicalBody === undefined ? 0o600 : 0o644,
  });
  const binary = path.join(installDir, "sana-mcp");
  const binaryBody = Buffer.from("verified standalone fixture\n");
  const binaryDigest = sha256(binaryBody);
  fs.writeFileSync(binary, binaryBody, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  const installLock = path.join(installDir, ".sana-mcp-install-lock");
  const pathLock = path.join(home, ".sana-mcp-installer-path.lock");
  writeLock(installLock, "owner.A1b2C3");
  writeLock(pathLock, "owner.Z9y8X7");
  const cohort = 1_700_000_000;
  setCohort(
    [
      binary,
      stage,
      installLock,
      path.join(installLock, "owner.A1b2C3"),
      pathLock,
      path.join(pathLock, "owner.Z9y8X7"),
    ],
    cohort,
  );
  const dataDirectory = path.join(home, ".sana-mcp");
  fs.mkdirSync(dataDirectory);
  const dataSentinel = path.join(dataDirectory, "meeting.db");
  fs.writeFileSync(dataSentinel, "preserve-me\n");
  const processes = new FakeProcesses(cohort);
  const fixture = {
    root,
    home,
    installDir,
    profile,
    stage,
    binary,
    installLock,
    pathLock,
    dataSentinel,
    canonicalBody,
    cohort,
    binaryDigest,
    processes,
    dependencies(overrides: LegacyPosixRecoveryDependencies = {}) {
      return {
        platform: "linux",
        uid: process.getuid!(),
        resolveRelease: (digest) =>
          digest === fixture.binaryDigest ? fakeRelease(digest) : undefined,
        processProvider: processes,
        killProcess: processes.kill,
        waitForParentExit: async (expected, provider) => {
          const current = await provider.read(expected.pid);
          if (current?.startToken === expected.startToken) {
            throw new Error("parent survived");
          }
        },
        acquireGuard: () => ({ release() {} }),
        randomUUID: () => UUID,
        ...overrides,
      };
    },
  } satisfies Fixture;
  return fixture;
}

async function withFixture<T>(
  callback: (fixture: Fixture) => Promise<T>,
  options?: { profile?: "present" | "absent" },
): Promise<T> {
  const fixture = createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function fingerprint(fixture: Fixture): Promise<string> {
  const result = await inspectLegacyPosixRecovery(
    { home: fixture.home, installDir: fixture.installDir },
    fixture.dependencies(),
  );
  expect(result.status).toBe("confirmation-required");
  if (result.status !== "confirmation-required") throw new Error("missing fixture fingerprint");
  return result.fingerprint;
}

function journalPath(fixture: Fixture): string {
  return path.join(fixture.home, ".sana-mcp-legacy-posix-recovery.json");
}

function readJournal(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(journalPath(fixture), "utf8")) as Record<string, unknown>;
}

describe("legacy POSIX stuck-sync inspection", () => {
  test("detects only the exact historical footprint without mutating it", async () => {
    await withFixture(async (fixture) => {
      const beforeProfile = fixture.canonicalBody && fs.readFileSync(fixture.profile);
      const beforeStage = fs.readFileSync(fixture.stage);
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("confirmation-required");
      if (result.status !== "confirmation-required") return;
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.release.version).toBe(VERSION);
      expect(result.artifacts).toEqual([
        fixture.binary,
        fixture.stage,
        fixture.installLock,
        fixture.pathLock,
      ]);
      expect(result.processes).toEqual({ shellPid: 4100, syncPid: 4101 });
      expect(fixture.processes.records.get(4100)!.startedAtSecond).toBeLessThan(
        fixture.cohort,
      );
      expect(fs.readFileSync(fixture.stage)).toEqual(beforeStage);
      expect(fs.readFileSync(fixture.profile)).toEqual(beforeProfile!);
      expect(fs.existsSync(path.join(fixture.home, ".sana-mcp-legacy-posix-recovery.lock")))
        .toBe(false);
    });
  });

  test("accepts the exact absent-profile transformation", async () => {
    await withFixture(async (fixture) => {
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("confirmation-required");
      expect(fs.existsSync(fixture.profile)).toBe(false);
    }, { profile: "absent" });
  });

  test("accepts the bounded cross-second artifact publication sequence", async () => {
    await withFixture(async (fixture) => {
      setCohort(
        [fixture.pathLock, path.join(fixture.pathLock, "owner.Z9y8X7")],
        fixture.cohort + 1,
      );
      fs.utimesSync(fixture.binary, fixture.cohort + 2, fixture.cohort + 2);
      fs.utimesSync(fixture.stage, fixture.cohort + 3, fixture.cohort + 3);

      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("confirmation-required");
    });
  });

  test("refuses unsupported .profile staging instead of inferring a target", async () => {
    await withFixture(async (fixture) => {
      fs.renameSync(
        fixture.stage,
        path.join(fixture.home, ".profile.sana-mcp.Ab12z9"),
      );
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("INVALID_ARTIFACT");
    });
  });

  test("returns none for a normal receipt-backed install without recovery indicators", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-legacy-none-"));
    try {
      const home = path.join(root, "home");
      const installDir = path.join(home, ".local", "bin");
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, "sana-mcp"), "normal install\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(installDir, ".sana-mcp-install-v1"),
        "format=sana-mcp-install-v2\n",
      );
      let resolverCalls = 0;
      const result = await inspectLegacyPosixRecovery(
        { home, installDir },
        {
          platform: "linux",
          uid: process.getuid!(),
          processProvider: new FakeProcesses(1),
          resolveRelease: () => {
            resolverCalls += 1;
            return undefined;
          },
        },
      );
      expect(result).toEqual({ status: "none" });
      expect(resolverCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects foreign binary digests", async () => {
    await withFixture(async (fixture) => {
      const dependencies = fixture.dependencies();
      delete (dependencies as { resolveRelease?: unknown }).resolveRelease;
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        dependencies,
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") {
        expect(result.code).toBe("UNRECOGNIZED_LEGACY_BINARY");
      }
    });

    await withFixture(async (fixture) => {
      let resolverCalls = 0;
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies({
          resolveRelease: () => {
            resolverCalls += 1;
            return undefined;
          },
        }),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") {
        expect(result.code).toBe("UNRECOGNIZED_LEGACY_BINARY");
      }
      expect(resolverCalls).toBe(1);
    });
  });

  test("rejects malformed, extra, and symbolic lock state", async () => {
    for (const mutation of ["extra", "content", "symlink"] as const) {
      await withFixture(async (fixture) => {
        if (mutation === "extra") {
          fs.writeFileSync(path.join(fixture.installLock, "owner.extra1"), "owner.extra1\n");
        } else if (mutation === "content") {
          fs.writeFileSync(path.join(fixture.installLock, "owner.A1b2C3"), "wrong\n");
        } else {
          fs.rmSync(path.join(fixture.installLock, "owner.A1b2C3"));
          fs.symlinkSync(fixture.binary, path.join(fixture.installLock, "owner.A1b2C3"));
        }
        const result = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(result.status).toBe("blocked");
        if (result.status === "blocked") expect(result.code).toBe("INVALID_ARTIFACT");
      });
    }
  });

  test("rejects a staged mismatch and a profile edit", async () => {
    await withFixture(async (fixture) => {
      fs.appendFileSync(fixture.stage, "tamper\n");
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("INVALID_ARTIFACT");
    });
    await withFixture(async (fixture) => {
      fs.appendFileSync(fixture.profile, "# edited after staging\n");
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("INVALID_ARTIFACT");
    });
    await withFixture(async (fixture) => {
      fs.writeFileSync(
        path.join(fixture.home, ".zshrc.sana-mcp.not-a-mktemp-token"),
        "foreign stage\n",
      );
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("AMBIGUOUS_FOOTPRINT");
    });
    await withFixture(async (fixture) => {
      fs.writeFileSync(path.join(fixture.installDir, ".sana-mcp.foreign"), "foreign\n");
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("AMBIGUOUS_FOOTPRINT");
    });
  });

  test("rejects zero, multiple, wrong-parent, non-D, and wrong-time sync processes", async () => {
    const mutations: Array<(processes: FakeProcesses) => void> = [
      (processes) => processes.records.delete(4101),
      (processes) => processes.records.set(4102, { ...processes.records.get(4101)!, pid: 4102 }),
      (processes) => processes.records.set(4101, { ...processes.records.get(4101)!, ppid: 9999 }),
      (processes) => processes.records.set(4101, { ...processes.records.get(4101)!, state: "S" }),
      (processes) => processes.records.set(4101, {
        ...processes.records.get(4101)!,
        startedAtSecond: processes.records.get(4101)!.startedAtSecond + 3601,
      }),
      (processes) => processes.records.set(4100, {
        ...processes.records.get(4100)!,
        startedAtSecond: processes.records.get(4101)!.startedAtSecond - 3601,
      }),
    ];
    for (const mutate of mutations) {
      await withFixture(async (fixture) => {
        mutate(fixture.processes);
        const result = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(result.status).toBe("blocked");
        if (result.status === "blocked") expect(result.code).toBe("PROCESS_EVIDENCE_INVALID");
      });
    }
  });

  test("ignores unrelated sync processes when one qualifying pair exists", async () => {
    await withFixture(async (fixture) => {
      const validShell = fixture.processes.records.get(4100)!;
      const validSync = fixture.processes.records.get(4101)!;
      fixture.processes.records.set(4200, {
        ...validShell,
        pid: 4200,
        startToken: "887654",
      });
      fixture.processes.records.set(4201, {
        ...validSync,
        pid: 4201,
        ppid: 4200,
        startToken: "887660",
        startedAtSecond: validSync.startedAtSecond + 3601,
      });
      fixture.processes.records.set(4202, {
        ...validSync,
        pid: 4202,
        ppid: 9999,
        startToken: "887661",
      });
      fixture.processes.records.set(4203, {
        ...validSync,
        pid: 4203,
        state: "S",
        startToken: "887662",
      });

      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("confirmation-required");
      if (result.status === "confirmation-required") {
        expect(result.processes).toEqual({ shellPid: 4100, syncPid: 4101 });
      }
    });
  });

  test("rejects receipt appearance and an out-of-window artifact", async () => {
    await withFixture(async (fixture) => {
      let resolverCalls = 0;
      fs.writeFileSync(path.join(fixture.installDir, ".sana-mcp-install-v1"), "receipt\n");
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies({
          resolveRelease: () => {
            resolverCalls += 1;
            return undefined;
          },
        }),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("RECEIPT_PRESENT");
      expect(resolverCalls).toBe(0);
    });
    await withFixture(async (fixture) => {
      fs.utimesSync(fixture.stage, fixture.cohort + 31, fixture.cohort + 31);
      const result = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") expect(result.code).toBe("INVALID_ARTIFACT");
    });
  });

  test("skips bounded transient /proc disappearance and identity races", async () => {
    if (process.platform !== "linux") return;
    await withFixture(async (fixture) => {
      const originalReadFileSync = fs.readFileSync.bind(fs);
      const originalReadlinkSync = fs.readlinkSync.bind(fs);
      const originalReaddirSync = fs.readdirSync.bind(fs);
      const ticks = 100;
      const boot = fixture.cohort - 1_000;
      const syncToken = String((fixture.cohort - boot) * ticks);
      const shellToken = String((fixture.cohort - 30 - boot) * ticks);
      let raceStatReads = 0;
      let vanishedStatusReads = 0;
      const readFileMock = spyOn(fs, "readFileSync").mockImplementation(
        ((target: fs.PathOrFileDescriptor, options?: unknown) => {
          const file = String(target);
          const match = /^\/proc\/(4100|4101|4200|4300)\/(status|stat|cmdline)$/u.exec(
            file,
          );
          if (match === null) {
            return originalReadFileSync(
              target,
              options as Parameters<typeof fs.readFileSync>[1],
            );
          }
          const pid = Number(match[1]);
          const leaf = match[2];
          if (pid === 4300) {
            vanishedStatusReads += 1;
            throw Object.assign(new Error("vanished"), { code: "ENOENT" });
          }
          if (leaf === "status") {
            const uid = process.getuid!();
            return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
          }
          if (leaf === "cmdline") {
            const argv =
              pid === 4100
                ? ["/bin/sh", "/tmp/install.sh"]
                : pid === 4101
                  ? ["sync"]
                  : ["unrelated"];
            return Buffer.from(`${argv.join("\0")}\0`);
          }
          if (pid === 4100) return procStat(pid, "sh", "S", 3000, shellToken);
          if (pid === 4101) return procStat(pid, "sync", "D", 4100, syncToken);
          raceStatReads += 1;
          return procStat(pid, "other", "S", 1, String(7000 + raceStatReads));
        }) as typeof fs.readFileSync,
      );
      const readlinkMock = spyOn(fs, "readlinkSync").mockImplementation(
        ((target: fs.PathLike) => {
          const file = String(target);
          if (file === "/proc/4100/exe") return "/usr/bin/dash";
          if (file === "/proc/4101/exe") return "/usr/bin/sync";
          if (file === "/proc/4200/exe") return "/usr/bin/unrelated";
          return originalReadlinkSync(target);
        }) as typeof fs.readlinkSync,
      );
      const readdirMock = spyOn(fs, "readdirSync").mockImplementation(
        ((target: fs.PathLike, options?: unknown) =>
          String(target) === "/proc"
            ? ["4100", "4101", "4200", "4300"]
            : originalReaddirSync(
                target,
                options as Parameters<typeof fs.readdirSync>[1],
              )) as typeof fs.readdirSync,
      );
      try {
        const result = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies({
            processProvider: undefined,
            linuxProcessClock: {
              ticksPerSecond: BigInt(ticks),
              bootTimeSecond: BigInt(boot),
            },
          }),
        );
        expect(result.status).toBe("confirmation-required");
        expect(raceStatReads).toBe(4);
        expect(vanishedStatusReads).toBe(2);
      } finally {
        readdirMock.mockRestore();
        readlinkMock.mockRestore();
        readFileMock.mockRestore();
      }
    });
  });

  test("strictly validates injected legacy release recognition", async () => {
    const cases: Array<(fixture: Fixture) => LegacyPosixRecoveryDependencies> = [
      (fixture) => fixture.dependencies({
        resolveRelease: (digest) => ({
          ...fakeRelease(digest),
          sourceCommit: "0".repeat(40),
        }) as unknown as LegacyPosixReleaseIdentity,
      }),
      (fixture) => fixture.dependencies({
        resolveRelease: (digest) => ({
          ...fakeRelease(digest),
          sha256: "f".repeat(64),
        }),
      }),
      (fixture) => fixture.dependencies({
        resolveRelease: (digest) => ({
          ...fakeRelease(digest),
          target: "bun-linux-arm64",
        }) as LegacyPosixReleaseIdentity,
      }),
      (fixture) => fixture.dependencies({
        resolveRelease: (digest) => ({
          ...fakeRelease(digest),
          extra: "not allowed",
        }) as LegacyPosixReleaseIdentity,
      }),
    ];
    for (const buildDependencies of cases) {
      await withFixture(async (fixture) => {
        const result = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          buildDependencies(fixture),
        );
        expect(result.status).toBe("blocked");
        if (result.status === "blocked") expect(result.code).toBe("RELEASE_VERIFICATION_FAILED");
      });
    }
  });

  test("refuses non-Linux and noncanonical boundaries before inspection", async () => {
    await withFixture(async (fixture) => {
      const unsupported = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies({ platform: "darwin" }),
      );
      expect(unsupported.status).toBe("blocked");
      if (unsupported.status === "blocked") expect(unsupported.code).toBe("UNSUPPORTED_PLATFORM");

      const alias = path.join(fixture.root, "home-alias");
      fs.symlinkSync(fixture.home, alias);
      const aliased = await inspectLegacyPosixRecovery(
        { home: alias, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(aliased.status).toBe("blocked");
      if (aliased.status === "blocked") expect(aliased.code).toBe("INVALID_BOUNDARY");
    });
  });
});

describe("legacy POSIX stuck-sync recovery transaction", () => {
  test("requires explicit matching confirmation and rechecks under the guard", async () => {
    await withFixture(async (fixture) => {
      const confirmedFingerprint = await fingerprint(fixture);
      const unconfirmed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(unconfirmed.status).toBe("confirmation-required");
      expect(fs.existsSync(fixture.binary)).toBe(true);

      const mismatch = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: "0".repeat(64),
        },
        fixture.dependencies(),
      );
      expect(mismatch.status).toBe("blocked");
      if (mismatch.status === "blocked") expect(mismatch.code).toBe("CONFIRMATION_MISMATCH");

      const changed = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: confirmedFingerprint,
        },
        fixture.dependencies({
          acquireGuard: () => {
            fs.appendFileSync(fixture.profile, "# concurrent edit\n");
            return { release() {} };
          },
        }),
      );
      expect(changed.status).toBe("blocked");
      expect(fs.existsSync(fixture.binary)).toBe(true);
      expect(fs.existsSync(journalPath(fixture))).toBe(false);
    });
  });

  test("keeps confirmed process identity stable across WSL clock shifts and resume", async () => {
    await withFixture(async (fixture) => {
      const confirmedFingerprint = await fingerprint(fixture);
      let shiftedUnderGuard = false;
      let crashed = false;
      const first = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: confirmedFingerprint,
        },
        fixture.dependencies({
          acquireGuard: () => {
            if (!shiftedUnderGuard) {
              shiftedUnderGuard = true;
              shiftProcessWallTimes(fixture.processes, 120);
            }
            return { release() {} };
          },
          checkpoint: (name) => {
            if (name === "journal-created" && !crashed) {
              crashed = true;
              shiftProcessWallTimes(fixture.processes, 120);
              throw new Error("crash after journal publication");
            }
          },
        }),
      );
      expect(first.status).toBe("error");
      expect(fs.existsSync(journalPath(fixture))).toBe(true);

      const pending = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(pending.status).toBe("pending");
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("completed");
    });
  });

  test("kills only recorded identities and removes only exact legacy artifacts", async () => {
    await withFixture(async (fixture) => {
      const profileBefore = fs.readFileSync(fixture.profile);
      const otherHome = path.join(fixture.home, "unrelated.txt");
      const otherInstall = path.join(fixture.installDir, "unrelated.bin");
      fs.writeFileSync(otherHome, "home\n");
      fs.writeFileSync(otherInstall, "install\n");
      const result = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies(),
      );
      expect(result.status).toBe("completed");
      expect(fixture.processes.killed).toEqual([
        [4101, "SIGKILL"],
        [4100, "SIGKILL"],
      ]);
      expect(fixture.processes.records.get(4101)?.ppid).toBe(1);
      for (const artifact of [fixture.binary, fixture.stage, fixture.installLock, fixture.pathLock]) {
        expect(fs.existsSync(artifact)).toBe(false);
      }
      expect(fs.readFileSync(fixture.profile)).toEqual(profileBefore);
      expect(fs.readFileSync(fixture.dataSentinel, "utf8")).toBe("preserve-me\n");
      expect(fs.readFileSync(otherHome, "utf8")).toBe("home\n");
      expect(fs.readFileSync(otherInstall, "utf8")).toBe("install\n");
      expect(fs.existsSync(journalPath(fixture))).toBe(false);
      expect(
        fs.readdirSync(fixture.home).some((entry) => entry.startsWith(".sana-mcp-legacy-posix-recovery.")),
      ).toBe(false);
      expect(
        fs.readdirSync(fixture.installDir).some((entry) =>
          entry.startsWith(".sana-mcp-legacy-posix-recovery.")),
      ).toBe(false);
    });
  });

  test("resumes durable confirmation after crashes at every mutation checkpoint", async () => {
    const checkpoints = [
      "journal-created",
      "quarantines-prepared",
      "processes-signaled",
      "processes-killed",
      "moved-binary",
      "moved-profile",
      "moved-install-lock",
      "moved-path-lock",
      "quarantined",
      "cleaned-install-quarantine",
      "cleaned-home-quarantine",
      "cleanup-recorded",
    ];
    for (const checkpoint of checkpoints) {
      await withFixture(async (fixture) => {
        let crashed = false;
        const first = await recoverLegacyPosixInstall(
          {
            home: fixture.home,
            installDir: fixture.installDir,
            fingerprint: await fingerprint(fixture),
          },
          fixture.dependencies({
            checkpoint: (name) => {
              if (name === checkpoint && !crashed) {
                crashed = true;
                throw new Error(`crash at ${name}`);
              }
            },
          }),
        );
        expect(first.status).toBe("error");
        expect(fs.existsSync(journalPath(fixture))).toBe(true);
        const pending = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(pending.status).toBe("pending");
        const resumed = await recoverLegacyPosixInstall(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(resumed.status).toBe("completed");
        expect(fs.readFileSync(fixture.dataSentinel, "utf8")).toBe("preserve-me\n");
        if (fixture.canonicalBody !== undefined) {
          expect(fs.readFileSync(fixture.profile)).toEqual(fixture.canonicalBody);
        }
      });
    }
  }, 30_000);

  test("resumes move phases monotonically across repeated crashes", async () => {
    const cases = [
      {
        initialCheckpoint: "moved-profile",
        initialPhase: "profile-moved",
        resumedCheckpoint: "moved-install-lock",
        resumedPhase: "install-lock-moved",
      },
      {
        initialCheckpoint: "moved-install-lock",
        initialPhase: "install-lock-moved",
        resumedCheckpoint: "moved-path-lock",
        resumedPhase: "path-lock-moved",
      },
      {
        initialCheckpoint: "moved-path-lock",
        initialPhase: "path-lock-moved",
        resumedCheckpoint: "quarantined",
        resumedPhase: "quarantined",
      },
    ] as const;
    for (const item of cases) {
      await withFixture(async (fixture) => {
        let firstCrash = true;
        const first = await recoverLegacyPosixInstall(
          {
            home: fixture.home,
            installDir: fixture.installDir,
            fingerprint: await fingerprint(fixture),
          },
          fixture.dependencies({
            checkpoint: (name) => {
              if (name === item.initialCheckpoint && firstCrash) {
                firstCrash = false;
                throw new Error(`first crash at ${name}`);
              }
            },
          }),
        );
        expect(first.status).toBe("error");
        expect(readJournal(fixture).phase).toBe(item.initialPhase);

        let resumedCheckpoint: string | undefined;
        const second = await recoverLegacyPosixInstall(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies({
            checkpoint: (name) => {
              if (resumedCheckpoint === undefined) {
                resumedCheckpoint = name;
                throw new Error(`second crash at ${name}`);
              }
            },
          }),
        );
        expect(second.status).toBe("error");
        expect(resumedCheckpoint).toBe(item.resumedCheckpoint);
        expect(readJournal(fixture).phase).toBe(item.resumedPhase);

        const completed = await recoverLegacyPosixInstall(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(completed.status).toBe("completed");
      });
    }
  });

  test("resumes quarantined lock cleanup after each token unlink", async () => {
    for (const moveName of ["install-lock", "path-lock"] as const) {
      await withFixture(async (fixture) => {
        const checkpoint = `unlinked-${moveName}-token`;
        let crashed = false;
        const first = await recoverLegacyPosixInstall(
          {
            home: fixture.home,
            installDir: fixture.installDir,
            fingerprint: await fingerprint(fixture),
          },
          fixture.dependencies({
            checkpoint: (name) => {
              if (name === checkpoint && !crashed) {
                crashed = true;
                throw new Error(`crash after ${moveName} token unlink`);
              }
            },
          }),
        );
        expect(first.status).toBe("error");
        const journal = readJournal(fixture) as {
          phase: string;
          moves: Array<{ name: string; source: string; destination: string }>;
        };
        expect(journal.phase).toBe("quarantined");
        const lockMove = journal.moves.find((move) => move.name === moveName)!;
        expect(fs.existsSync(lockMove.source)).toBe(false);
        expect(fs.readdirSync(lockMove.destination)).toEqual([]);

        const pending = await inspectLegacyPosixRecovery(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(pending.status).toBe("pending");
        const resumed = await recoverLegacyPosixInstall(
          { home: fixture.home, installDir: fixture.installDir },
          fixture.dependencies(),
        );
        expect(resumed.status).toBe("completed");
      });
    }
  });

  test("accepts partial lock cleanup only when quarantined and conflict-free", async () => {
    await withFixture(async (fixture) => {
      let crashed = false;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "moved-install-lock" && !crashed) {
              crashed = true;
              throw new Error("crash before quarantined phase");
            }
          },
        }),
      );
      const journal = readJournal(fixture) as {
        phase: string;
        moves: Array<{ name: string; destination: string }>;
      };
      expect(journal.phase).toBe("install-lock-moved");
      const installLock = journal.moves.find(
        (move) => move.name === "install-lock",
      )!.destination;
      fs.unlinkSync(path.join(installLock, "owner.A1b2C3"));
      const inspected = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(inspected.status).toBe("blocked");
    });

    await withFixture(async (fixture) => {
      let crashed = false;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "unlinked-install-lock-token" && !crashed) {
              crashed = true;
              throw new Error("crash after token unlink");
            }
          },
        }),
      );
      const journal = readJournal(fixture) as {
        moves: Array<{ name: string; destination: string }>;
      };
      const installLock = journal.moves.find(
        (move) => move.name === "install-lock",
      )!.destination;
      fs.writeFileSync(path.join(installLock, "unexpected"), "conflict\n");
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("blocked");
      if (resumed.status === "blocked") {
        expect(resumed.code).toBe("QUARANTINE_CONFLICT");
      }
    });
  });

  test("resumes after shell exit with the exact reparented D-state sync child", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      const first = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "processes-signaled" && crash) {
              crash = false;
              throw new Error("crash after exact shell exit");
            }
          },
        }),
      );
      expect(first.status).toBe("error");
      expect((readJournal(fixture).phase as string)).toBe("prepared");
      expect(fixture.processes.records.has(4100)).toBe(false);
      expect(fixture.processes.records.get(4101)?.ppid).toBe(1);

      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("completed");
      expect(fixture.processes.killed).toEqual([
        [4101, "SIGKILL"],
        [4100, "SIGKILL"],
        [4101, "SIGKILL"],
      ]);
    });
  });

  test("stops on source/destination conflicts and preserves the journal", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "moved-binary" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      fs.writeFileSync(fixture.binary, "conflicting replacement\n", { mode: 0o755 });
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("blocked");
      if (resumed.status === "blocked") expect(resumed.code).toBe("QUARANTINE_CONFLICT");
      expect(fs.existsSync(journalPath(fixture))).toBe(true);
      const journal = readJournal(fixture);
      expect(fs.existsSync((journal.moves as Array<{ destination: string }>)[0]!.destination)).toBe(true);
    });

    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "moved-binary" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      const journal = readJournal(fixture);
      const destination = (journal.moves as Array<{ destination: string }>)[0]!.destination;
      fs.unlinkSync(destination);
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("blocked");
      expect(fs.existsSync(journalPath(fixture))).toBe(true);
    });
  });

  test("stops if a receipt appears after process termination", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "processes-killed" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      fs.writeFileSync(path.join(fixture.installDir, ".sana-mcp-install-v1"), "appeared\n");
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("blocked");
      if (resumed.status === "blocked") expect(resumed.code).toBe("RECEIPT_PRESENT");
      expect(fs.existsSync(fixture.binary)).toBe(true);
      expect(fs.existsSync(journalPath(fixture))).toBe(true);
    });
  });

  test("strictly rejects journal additions and path substitution", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "journal-created" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      const journal = readJournal(fixture);
      journal.extra = "not allowed";
      fs.writeFileSync(journalPath(fixture), `${JSON.stringify(journal, null, 2)}\n`);
      const inspected = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(inspected.status).toBe("blocked");
      if (inspected.status === "blocked") expect(inspected.code).toBe("JOURNAL_INVALID");
    });

    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "journal-created" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      const journal = readJournal(fixture);
      journal.installQuarantine = path.join(fixture.root, "outside");
      fs.writeFileSync(journalPath(fixture), `${JSON.stringify(journal, null, 2)}\n`);
      const inspected = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(inspected.status).toBe("blocked");
      if (inspected.status === "blocked") expect(inspected.code).toBe("JOURNAL_INVALID");
    });
  });

  test("rejects a syntactically valid journal with a nonofficial release identity", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      const first = await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "journal-created" && crash) {
              crash = false;
              throw new Error("leave planted journal");
            }
          },
        }),
      );
      expect(first.status).toBe("error");
      const dependencies = fixture.dependencies();
      delete (dependencies as { resolveRelease?: unknown }).resolveRelease;
      const inspected = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        dependencies,
      );
      expect(inspected.status).toBe("blocked");
      if (inspected.status === "blocked") expect(inspected.code).toBe("JOURNAL_INVALID");
      expect(fs.existsSync(journalPath(fixture))).toBe(true);
    });
  });

  test("reconciles an fsynced journal temp against fixed durable authority", async () => {
    await withFixture(async (fixture) => {
      let crash = true;
      await recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: await fingerprint(fixture),
        },
        fixture.dependencies({
          checkpoint: (name) => {
            if (name === "journal-created" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        }),
      );
      const temporary = `${journalPath(fixture)}.tmp`;
      fs.copyFileSync(journalPath(fixture), temporary);
      fs.chmodSync(temporary, 0o600);
      const inspected = await inspectLegacyPosixRecovery(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(inspected.status).toBe("pending");
      const resumed = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        fixture.dependencies(),
      );
      expect(resumed.status).toBe("completed");
      expect(fs.existsSync(temporary)).toBe(false);
    });
  });

  test("kernel flock excludes a concurrent recovery", async () => {
    if (process.platform !== "linux") return;
    await withFixture(async (fixture) => {
      const confirmedFingerprint = await fingerprint(fixture);
      let releaseCheckpoint!: () => void;
      let announceCheckpoint!: () => void;
      const reached = new Promise<void>((resolve) => {
        announceCheckpoint = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const productionLockDependencies = fixture.dependencies({
        acquireGuard: undefined,
        checkpoint: async (name) => {
          if (name === "journal-created") {
            announceCheckpoint();
            await blocked;
          }
        },
      });
      delete (productionLockDependencies as { acquireGuard?: unknown }).acquireGuard;
      const firstPromise = recoverLegacyPosixInstall(
        {
          home: fixture.home,
          installDir: fixture.installDir,
          fingerprint: confirmedFingerprint,
        },
        productionLockDependencies,
      );
      await reached;
      const contenderDependencies = fixture.dependencies();
      delete (contenderDependencies as { acquireGuard?: unknown }).acquireGuard;
      const contender = await recoverLegacyPosixInstall(
        { home: fixture.home, installDir: fixture.installDir },
        contenderDependencies,
      );
      releaseCheckpoint();
      const first = await firstPromise;
      expect(contender.status).toBe("blocked");
      if (contender.status === "blocked") expect(contender.code).toBe("RECOVERY_BUSY");
      expect(first.status).toBe("completed");
    });
  }, 15_000);

  test("serializes stable strict properties", () => {
    expect(
      serializeLegacyPosixRecoveryResult({
        status: "blocked",
        code: "RECOVERY_BUSY",
        message: "busy\nwithout raw framing",
      }),
    ).toBe(
      [
        "format=sana-mcp-legacy-posix-recovery-result-v1",
        "status=blocked",
        "code=RECOVERY_BUSY",
        `messageBase64=${Buffer.from("busy\nwithout raw framing").toString("base64")}`,
        "",
      ].join("\n"),
    );
  });
});
