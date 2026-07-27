import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DAEMON_CONTROL_STALE_MS,
  DAEMON_STARTUP_ORPHAN_GRACE_MS,
  DAEMON_STARTUP_STALE_MS,
  DaemonControlUnavailableError,
  DaemonStopPublishedError,
  DaemonStopRequestRejectedError,
  bindDaemonStartupChild,
  claimDaemonStartup,
  clearDaemonControl,
  clearDeadLegacyDaemonControl,
  clearDaemonStartup,
  daemonControlReady,
  daemonStopRequested,
  observeDaemonControl,
  observeDaemonControlReadOnly,
  observeDaemonStartup,
  observeDaemonStartupReadOnly,
  publishDaemonControl,
  refreshDaemonControl,
  refreshDaemonStartup,
  requestDaemonStop,
  requestDaemonStopWith,
} from "../../src/sync/control.js";

const roots: string[] = [];
const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const UUID_C = "00000000-0000-4000-8000-000000000003";

function temporaryControlRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-control-"));
  roots.push(root);
  return root;
}

function numberedUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function writeNativeAclReceipt(directory: string): void {
  if (process.platform !== "win32") return;
  fs.writeFileSync(
    path.join(directory, ".sana-acl-setup-v1.json"),
    `${JSON.stringify({
      version: 1,
      root: fs.realpathSync.native(directory),
      setup: "complete",
    })}\n`,
    { mode: 0o600 },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cooperative daemon control", () => {
  test("startup claim is exclusive, child-bound, refreshed, and exact-cleaned", () => {
    const directory = temporaryControlRoot();
    let clock = 10_000;
    const options = {
      directory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: (pid: number) => pid === 1234 || pid === 5678,
    };
    const first = claimDaemonStartup(1234, options);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") throw new Error("claim was not acquired");
    expect(claimDaemonStartup(9999, {
      ...options,
      instanceId: UUID_B,
    })).toEqual({
      kind: "busy",
      claim: first.claim,
      freshness: "fresh",
    });

    clock++;
    const bound = bindDaemonStartupChild(UUID_A, 5678, options);
    expect(bound).toMatchObject({
      token: UUID_A,
      ownerPid: 1234,
      childPid: 5678,
      heartbeatMs: clock,
    });
    clock++;
    const refreshed = refreshDaemonStartup(bound, options);
    expect(refreshed.heartbeatMs).toBe(clock);

    clearDaemonStartup({ token: UUID_B }, options);
    expect(observeDaemonStartup(options).kind).toBe("starting");
    clearDaemonStartup(refreshed, options);
    expect(observeDaemonStartup(options)).toEqual({ kind: "missing" });
  });

  test("dead stale startup claim is replaced, while stale live ownership fails closed", () => {
    const directory = temporaryControlRoot();
    let clock = 100;
    const deadOptions = {
      directory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: () => false,
    };
    const first = claimDaemonStartup(1234, deadOptions);
    expect(first.kind).toBe("acquired");
    expect(
      claimDaemonStartup(5678, {
        ...deadOptions,
        instanceId: UUID_B,
      }),
    ).toMatchObject({ kind: "busy", freshness: "fresh" });
    clock += DAEMON_STARTUP_ORPHAN_GRACE_MS + 1;
    const replacement = claimDaemonStartup(5678, {
      ...deadOptions,
      instanceId: UUID_B,
    });
    expect(replacement).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B, ownerPid: 5678 },
    });

    clock += DAEMON_STARTUP_STALE_MS + 1;
    const live = claimDaemonStartup(9999, {
      ...deadOptions,
      pidAlive: (pid) => pid === 5678,
    });
    expect(live).toMatchObject({
      kind: "busy",
      freshness: "stale",
      claim: { token: UUID_B, ownerPid: 5678 },
    });
  });

  test("a late candidate cannot replace an already acquired fixed startup authority", () => {
    const directory = temporaryControlRoot();
    let clock = 2_000;
    let raced = false;
    const late = claimDaemonStartup(202, {
      directory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: (pid) => pid === 101 || pid === 202,
      beforeStartupAppend: (predecessor) => {
        if (predecessor !== null || raced) return;
        raced = true;
        // B already observed no root and is paused before its O_EXCL create.
        // A completes publication while B is paused.
        expect(claimDaemonStartup(101, {
          directory,
          instanceId: UUID_B,
          now: () => clock,
          pidAlive: (pid) => pid === 101,
        })).toMatchObject({ kind: "acquired" });
        // B resumes with a lower lexical token after A owns authority.
        clock++;
      },
    });
    expect(late).toMatchObject({
      kind: "busy",
      claim: { token: UUID_B, ownerPid: 101 },
    });
    expect(observeDaemonStartup({
      directory,
      now: () => clock,
      pidAlive: (pid) => pid === 101,
    })).toMatchObject({ claim: { token: UUID_B } });
  });

  test("superseded startup cannot bind or refresh after an orphan successor wins", () => {
    for (const operation of ["bind", "refresh"] as const) {
      const directory = temporaryControlRoot();
      let clock = 1_000;
      const first = claimDaemonStartup(101, {
        directory,
        instanceId: UUID_A,
        now: () => clock,
        pidAlive: () => false,
      });
      if (first.kind !== "acquired") throw new Error("missing first claim");
      clock += DAEMON_STARTUP_ORPHAN_GRACE_MS + 1;
      let replaced = false;
      const options = {
        directory,
        now: () => clock,
        pidAlive: () => false,
        beforeStartupMutation: (candidate: "bind" | "refresh") => {
          if (candidate !== operation || replaced) return;
          replaced = true;
          clearDaemonStartup(first.claim, {
            directory,
            pidAlive: () => false,
          });
          expect(claimDaemonStartup(202, {
            directory,
            instanceId: UUID_B,
            now: () => clock,
            pidAlive: (pid) => pid === 202,
          })).toMatchObject({
            kind: "acquired",
            claim: { token: UUID_B },
          });
        },
      };
      expect(() =>
        operation === "bind"
          ? bindDaemonStartupChild(UUID_A, 303, options)
          : refreshDaemonStartup(first.claim, options)
      ).toThrow(/startup claim changed/u);
      expect(observeDaemonStartup({
        directory,
        now: () => clock,
        pidAlive: (pid) => pid === 202,
      })).toMatchObject({
        claim: {
          token: UUID_B,
          ownerPid: 202,
          childPid: null,
        },
      });
    }
  });

  test("late cleanup and child writes stay token-addressed across fixed-directory ABA", () => {
    for (const operation of ["cleanup", "bind"] as const) {
      const directory = temporaryControlRoot();
      const first = claimDaemonStartup(101, {
        directory,
        instanceId: UUID_A,
        now: () => 1_000,
        pidAlive: () => false,
      });
      if (first.kind !== "acquired") throw new Error("missing first claim");
      let replaced = false;
      const interleave = (
        candidate: "bind" | "cleanup",
        token: string,
      ): void => {
        if (candidate !== operation || token !== UUID_A || replaced) return;
        replaced = true;
        clearDaemonStartup(first.claim, {
          directory,
          pidAlive: () => false,
        });
        expect(claimDaemonStartup(202, {
          directory,
          instanceId: UUID_B,
          now: () => 2_001,
          pidAlive: (pid) => pid === 202,
        })).toMatchObject({
          kind: "acquired",
          claim: { token: UUID_B },
        });
      };
      if (operation === "cleanup") {
        clearDaemonStartup(first.claim, {
          directory,
          pidAlive: () => false,
          beforeStartupArtifactCreate: interleave,
        });
      } else {
        expect(() =>
          bindDaemonStartupChild(UUID_A, 303, {
            directory,
            pidAlive: () => false,
            beforeStartupArtifactCreate: interleave,
          })
        ).toThrow(/startup claim changed/u);
      }
      expect(observeDaemonStartup({
        directory,
        now: () => 2_001,
        pidAlive: (pid) => pid === 202,
      })).toMatchObject({
        claim: {
          token: UUID_B,
          ownerPid: 202,
          childPid: null,
        },
      });
      expect(
        fs.readdirSync(
          path.join(directory, "daemon-startup-v2-authority"),
        ),
      ).toEqual(
        process.platform === "win32"
          ? [".sana-acl-setup-v1.json", "claim.json"]
          : ["claim.json"],
      );
      expect(
        fs.readdirSync(directory).some((entry) =>
          entry.includes(UUID_A)
        ),
      ).toBe(false);
    }
  });

  test("crashed cleanup is recovered without stealing a successor", () => {
    const directory = temporaryControlRoot();
    let clock = 1_000;
    const first = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: () => false,
    });
    if (first.kind !== "acquired") throw new Error("missing first claim");
    clock += DAEMON_STARTUP_ORPHAN_GRACE_MS + 1;
    expect(() =>
      clearDaemonStartup(first.claim, {
        directory,
        pidAlive: () => false,
        processIdentity: UUID_C,
        beforeExclusiveUnlink: () => {
          throw new Error("simulated cleanup crash");
        },
      })
    ).toThrow(/simulated cleanup crash/u);
    const replacement = claimDaemonStartup(202, {
      directory,
      instanceId: UUID_B,
      now: () => clock,
      pidAlive: (pid) => pid === 202,
      processIdentity: UUID_B,
    });
    expect(replacement).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B },
    });
    clearDaemonStartup(first.claim, {
      directory,
      pidAlive: () => false,
      processIdentity: UUID_B,
    });
    expect(observeDaemonStartup({
      directory,
      now: () => clock,
      pidAlive: (pid) => pid === 202,
    })).toMatchObject({ claim: { token: UUID_B } });

    const rotationDirectory = temporaryControlRoot();
    const rotating = claimDaemonStartup(303, {
      directory: rotationDirectory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: () => false,
    });
    if (rotating.kind !== "acquired") throw new Error("missing rotation claim");
    fs.renameSync(
      path.join(rotationDirectory, "daemon-startup-v2-authority"),
      path.join(
        rotationDirectory,
        `daemon-startup-v2-quarantine-${UUID_A}`,
      ),
    );
    expect(clearDaemonStartup(rotating.claim, {
      directory: rotationDirectory,
      processIdentity: UUID_A,
    })).toBe(true);
    expect(claimDaemonStartup(404, {
      directory: rotationDirectory,
      instanceId: UUID_C,
      now: () => clock,
      pidAlive: (pid) => pid === 404,
    })).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_C, ownerPid: 404 },
    });
  });

  test("cleanup PID reuse is actionable and never mistaken for the old cleaner", () => {
    const directory = temporaryControlRoot();
    const first = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (first.kind !== "acquired") throw new Error("missing first claim");
    expect(() =>
      clearDaemonStartup(first.claim, {
        directory,
        processIdentity: UUID_A,
        beforeExclusiveUnlink: () => {
          throw new Error("old cleaner crashed");
        },
      })
    ).toThrow(/old cleaner crashed/u);
    expect(fs.readdirSync(directory).filter((entry) =>
      entry.startsWith("daemon-startup-v2-cleanup-")
    )).toEqual([]);
    expect(claimDaemonStartup(202, {
      directory,
      instanceId: UUID_B,
      now: () => 2_001,
      processIdentity: UUID_B,
      pidAlive: (pid) => pid === 202,
    })).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B },
    });

    const quarantineDirectory = temporaryControlRoot();
    const quarantined = claimDaemonStartup(303, {
      directory: quarantineDirectory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (quarantined.kind !== "acquired") {
      throw new Error("missing quarantine claim");
    }
    expect(() =>
      clearDaemonStartup(quarantined.claim, {
        directory: quarantineDirectory,
        processIdentity: UUID_A,
        afterStartupAuthorityQuarantine: () => {
          throw new Error("crashed after quarantine");
        },
      })
    ).toThrow(/crashed after quarantine/u);
    expect(fs.readdirSync(quarantineDirectory).filter((entry) =>
      entry.startsWith("daemon-startup-v2-cleanup-")
    )).toHaveLength(1);
    expect(clearDaemonStartup(quarantined.claim, {
      directory: quarantineDirectory,
      processIdentity: UUID_A,
    })).toBe(true);
    expect(claimDaemonStartup(404, {
      directory: quarantineDirectory,
      instanceId: UUID_B,
      now: () => 2_001,
      processIdentity: UUID_B,
      pidAlive: (pid) => pid === 404,
    })).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B, ownerPid: 404 },
    });
  });

  test("fixed startup authority remains bounded across more than 1024 launches", () => {
    const directory = temporaryControlRoot();
    let clock = 1_000;
    // POSIX proves the >1024 bound. Native Windows separately exercises the
    // fixed inventory while every new authority performs a real ACL setup.
    const launches = process.platform === "win32" ? 3 : 1_100;
    for (let launch = 1; launch <= launches; launch++) {
      const token = numberedUuid(launch);
      const acquired = claimDaemonStartup(launch, {
        directory,
        instanceId: token,
        now: () => clock,
        pidAlive: () => false,
      });
      expect(acquired).toMatchObject({
        kind: "acquired",
        claim: { token },
      });
      if (acquired.kind !== "acquired") throw new Error("claim was busy");
      clearDaemonStartup(acquired.claim, {
        directory,
        pidAlive: () => false,
      });
      clock++;
    }
    expect(observeDaemonStartup({ directory })).toEqual({ kind: "missing" });
    expect(
      fs.readdirSync(directory).filter((entry) =>
        entry.startsWith("daemon-startup-v2-")
      ),
    ).toEqual([]);
  }, 60_000);

  test("ready control exposes freshness and exact stop targeting", () => {
    const directory = temporaryControlRoot();
    let clock = 20_000;
    const options = {
      directory,
      instanceId: UUID_A,
      now: () => clock,
    };
    const identity = publishDaemonControl(1234, options);
    expect(observeDaemonControl(options)).toEqual({
      kind: "ready",
      identity,
      heartbeatMs: clock,
      freshness: "fresh",
    });
    expect(daemonControlReady(1234, UUID_A, options)).toBe(true);

    clock += DAEMON_CONTROL_STALE_MS + 1;
    expect(observeDaemonControl(options)).toMatchObject({
      kind: "ready",
      freshness: "stale",
    });
    expect(daemonControlReady(1234, UUID_A, options)).toBe(false);
    refreshDaemonControl(identity, options);
    expect(daemonControlReady(1234, UUID_A, options)).toBe(true);

    expect(() =>
      requestDaemonStop({ pid: 1234, instanceId: UUID_B }, options),
    ).toThrow(/no matching cooperative control record/u);
    expect(
      fs.existsSync(
        path.join(directory, `daemon-stop-v2-${UUID_A}.json`),
      ),
    ).toBe(false);
    expect(requestDaemonStop(identity, options)).toEqual({
      identity,
      published: true,
      continuity: "confirmed",
    });
    expect(daemonStopRequested(UUID_A, options)).toBe(true);
    expect(daemonStopRequested(UUID_B, options)).toBe(false);
  });

  test("legacy protocol-one ready state remains explicitly observable", () => {
    const directory = temporaryControlRoot();
    fs.writeFileSync(
      path.join(directory, "daemon-control.json"),
      `${JSON.stringify({
        protocol: 1,
        pid: 1234,
        instanceId: UUID_A,
      })}\n`,
    );
    expect(observeDaemonControl({ directory })).toEqual({
      kind: "legacy",
      identity: { pid: 1234, instanceId: UUID_A },
    });
    expect(daemonControlReady(1234, UUID_A, { directory })).toBe(false);
    expect(
      requestDaemonStop(
        { pid: 1234, instanceId: UUID_A },
        { directory },
      ),
    ).toEqual({
      identity: { pid: 1234, instanceId: UUID_A },
      published: true,
      continuity: "confirmed",
    });
  });

  test("legacy request rejection never unlinks a same-path successor request", () => {
    const directory = temporaryControlRoot();
    const controlFile = path.join(directory, "daemon-control.json");
    const requestFile = path.join(directory, "daemon-stop.json");
    fs.writeFileSync(
      controlFile,
      `${JSON.stringify({
        protocol: 1,
        pid: 1234,
        instanceId: UUID_A,
      })}\n`,
    );
    expect(
      requestDaemonStop(
        { pid: 1234, instanceId: UUID_A },
        {
          directory,
          afterStopRequestPublication: (_instanceId, protocol) => {
            expect(protocol).toBe("legacy");
            fs.unlinkSync(controlFile);
            fs.writeFileSync(
              controlFile,
              `${JSON.stringify({
                protocol: 1,
                pid: 5678,
                instanceId: UUID_B,
              })}\n`,
            );
            fs.unlinkSync(requestFile);
            fs.writeFileSync(
              requestFile,
              `${JSON.stringify({
                protocol: 1,
                instanceId: UUID_B,
                operation: "stop",
              })}\n`,
            );
          },
        },
      ),
    ).toEqual({
      identity: { pid: 1234, instanceId: UUID_A },
      published: true,
      continuity: "changed",
    });
    expect(JSON.parse(fs.readFileSync(requestFile, "utf8"))).toMatchObject({
      instanceId: UUID_B,
    });
  });

  test("proven-dead legacy control retires exactly before new publication", () => {
    const directory = temporaryControlRoot();
    const controlFile = path.join(directory, "daemon-control.json");
    fs.writeFileSync(
      controlFile,
      `${JSON.stringify({
        protocol: 1,
        pid: 1234,
        instanceId: UUID_A,
      })}\n`,
    );
    expect(() =>
      clearDeadLegacyDaemonControl(
        { pid: 1234, instanceId: UUID_A },
        { directory, pidAlive: () => true },
      )
    ).toThrow(/live or its PID has been reused/u);
    expect(fs.existsSync(controlFile)).toBe(true);
    let nested = false;
    clearDeadLegacyDaemonControl(
      { pid: 1234, instanceId: UUID_A },
      {
        directory,
        pidAlive: () => false,
        beforeLegacyControlCapture: () => {
          if (nested) return;
          nested = true;
          expect(() =>
            clearDeadLegacyDaemonControl(
              { pid: 1234, instanceId: UUID_A },
              { directory, pidAlive: () => false },
            )
          ).toThrow(/still active/u);
          expect(() =>
            publishDaemonControl(5678, {
              directory,
              instanceId: UUID_B,
            })
          ).toThrow(/cleanup is in progress/u);
        },
      },
    );
    expect(fs.existsSync(controlFile)).toBe(false);
    expect(publishDaemonControl(5678, {
      directory,
      instanceId: UUID_B,
    })).toEqual({ pid: 5678, instanceId: UUID_B });
  });

  test("old cleanup cannot remove successor control or request", () => {
    const directory = temporaryControlRoot();
    const first = publishDaemonControl(1234, {
      directory,
      instanceId: UUID_A,
    });
    clearDaemonControl(first, { directory });
    const successor = publishDaemonControl(5678, {
      directory,
      instanceId: UUID_B,
    });
    requestDaemonStop(successor, { directory });

    clearDaemonControl(first, { directory });
    expect(observeDaemonControl({ directory })).toMatchObject({
      identity: successor,
    });
    expect(daemonStopRequested(UUID_B, { directory })).toBe(true);
  });

  test("two exact cleaners cannot remove successor startup, control, or request publications", () => {
    const startupDirectory = temporaryControlRoot();
    let clock = 1_000;
    const firstStartup = claimDaemonStartup(101, {
      directory: startupDirectory,
      instanceId: UUID_A,
      now: () => clock,
      pidAlive: () => false,
    });
    if (firstStartup.kind !== "acquired") throw new Error("missing claim");
    clock += DAEMON_STARTUP_ORPHAN_GRACE_MS + 1;
    let startupNested = false;
    clearDaemonStartup(firstStartup.claim, {
      directory: startupDirectory,
      beforeExclusiveUnlink: (kind) => {
        if (kind !== "startup" || startupNested) return;
        startupNested = true;
        expect(() =>
          clearDaemonStartup(firstStartup.claim, {
            directory: startupDirectory,
          })
        ).toThrow(/still active/u);
      },
    });
    expect(
      claimDaemonStartup(202, {
        directory: startupDirectory,
        instanceId: UUID_B,
        now: () => clock,
        pidAlive: (pid) => pid === 202,
      }),
    ).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B },
    });
    expect(observeDaemonStartup({
      directory: startupDirectory,
      now: () => clock,
    })).toMatchObject({ claim: { token: UUID_B } });
    clearDaemonStartup(firstStartup.claim, {
      directory: startupDirectory,
    });
    expect(observeDaemonStartup({
      directory: startupDirectory,
      now: () => clock,
    })).toMatchObject({ claim: { token: UUID_B } });

    const controlDirectory = temporaryControlRoot();
    const firstControl = publishDaemonControl(101, {
      directory: controlDirectory,
      instanceId: UUID_A,
    });
    let controlNested = false;
    clearDaemonControl(firstControl, {
      directory: controlDirectory,
      beforeExclusiveUnlink: (kind) => {
        if (kind !== "control" || controlNested) return;
        controlNested = true;
        clearDaemonControl(firstControl, { directory: controlDirectory });
        publishDaemonControl(202, {
          directory: controlDirectory,
          instanceId: UUID_B,
        });
      },
    });
    expect(observeDaemonControl({ directory: controlDirectory }))
      .toMatchObject({ identity: { instanceId: UUID_B } });

    const requestDirectory = temporaryControlRoot();
    const requestOwner = publishDaemonControl(101, {
      directory: requestDirectory,
      instanceId: UUID_A,
    });
    requestDaemonStop(requestOwner, { directory: requestDirectory });
    let requestNested = false;
    clearDaemonControl(requestOwner, {
      directory: requestDirectory,
      beforeExclusiveUnlink: (kind) => {
        if (kind !== "request" || requestNested) return;
        requestNested = true;
        clearDaemonControl(requestOwner, { directory: requestDirectory });
        const successor = publishDaemonControl(202, {
          directory: requestDirectory,
          instanceId: UUID_B,
        });
        requestDaemonStop(successor, { directory: requestDirectory });
      },
    });
    expect(observeDaemonControl({ directory: requestDirectory }))
      .toMatchObject({ identity: { instanceId: UUID_B } });
    expect(daemonStopRequested(UUID_B, {
      directory: requestDirectory,
    })).toBe(true);
  });

  test("malformed and multiple live identity-addressed publications fail closed", () => {
    const controlDirectory = temporaryControlRoot();
    publishDaemonControl(101, {
      directory: controlDirectory,
      instanceId: UUID_A,
    });
    fs.writeFileSync(
      path.join(
        controlDirectory,
        `daemon-control-v2-${UUID_B}.json`,
      ),
      `${JSON.stringify({
        protocol: 2,
        phase: "ready",
        pid: 202,
        instanceId: UUID_B,
        heartbeatMs: 1_000,
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => observeDaemonControl({
      directory: controlDirectory,
    })).toThrow(/Multiple daemon control authorities/u);

    const startupDirectory = temporaryControlRoot();
    const startupAuthority = path.join(
      startupDirectory,
      "daemon-startup-v2-authority",
    );
    fs.mkdirSync(startupAuthority);
    writeNativeAclReceipt(startupAuthority);
    fs.writeFileSync(
      path.join(
        startupDirectory,
        "daemon-startup-v2-authority",
        "claim.json",
      ),
      '{"protocol":1,"token":"invented"}\n',
    );
    expect(() => observeDaemonStartup({
      directory: startupDirectory,
    })).toThrow(/Invalid JSON/u);
  });

  test("stop publication rejects and cleans only its old request across a successor race", () => {
    const observations = [
      {
        kind: "ready" as const,
        identity: { pid: 1234, instanceId: UUID_A },
        heartbeatMs: 1,
        freshness: "fresh" as const,
      },
      {
        kind: "ready" as const,
        identity: { pid: 5678, instanceId: UUID_B },
        heartbeatMs: 2,
        freshness: "fresh" as const,
      },
    ];
    const published: string[] = [];
    expect(
      requestDaemonStopWith(
        { pid: 1234, instanceId: UUID_A },
        {
          observeControl: () => observations.shift()!,
          publishRequest: (instanceId) => published.push(instanceId),
        },
      ),
    ).toEqual({
      identity: { pid: 1234, instanceId: UUID_A },
      published: true,
      continuity: "changed",
    });
    expect(published).toEqual([UUID_A]);
  });

  test("malformed control and startup state fail closed and preserve evidence", () => {
    const directory = temporaryControlRoot();
    const control = path.join(directory, "daemon-control.json");
    fs.writeFileSync(control, '{"protocol":2,"phase":"ready","pid":0}\n');
    expect(() => observeDaemonControl({ directory })).toThrow(
      /Invalid JSON/u,
    );
    expect(fs.existsSync(`${control}.corrupt`)).toBe(true);

    fs.rmSync(control);
    const startup = path.join(directory, "daemon-startup.json");
    fs.writeFileSync(startup, '{"protocol":1,"token":"invented"}\n');
    expect(() => observeDaemonStartup({ directory })).toThrow(
      /Invalid JSON/u,
    );
    expect(fs.existsSync(`${startup}.corrupt`)).toBe(true);
  });

  test("read-only health observation never creates, repairs, or quarantines control state", () => {
    const absent = path.join(temporaryControlRoot(), "absent");
    expect(observeDaemonControlReadOnly({ directory: absent })).toEqual({
      kind: "missing",
    });
    expect(observeDaemonStartupReadOnly({ directory: absent })).toEqual({
      kind: "missing",
    });
    expect(fs.existsSync(absent)).toBe(false);

    const directory = temporaryControlRoot();
    const control = path.join(directory, "daemon-control.json");
    fs.writeFileSync(control, '{"protocol":2,"phase":"ready","pid":0}\n', {
      mode: 0o640,
    });
    const before = fs.statSync(control);
    expect(() =>
      observeDaemonControlReadOnly({ directory })
    ).toThrow(/invalid content.*preserved/u);
    const after = fs.statSync(control);
    expect(fs.readFileSync(control, "utf8")).toBe(
      '{"protocol":2,"phase":"ready","pid":0}\n',
    );
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.existsSync(`${control}.corrupt`)).toBe(false);

    fs.unlinkSync(control);
    fs.chmodSync(directory, 0o755);
    if (process.platform === "win32") {
      expect(observeDaemonControlReadOnly({ directory })).toEqual({
        kind: "missing",
      });
    } else {
      expect(() =>
        observeDaemonControlReadOnly({ directory })
      ).toThrow(/permissions are not private/u);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
    }

    if (process.platform !== "win32") {
      // Windows-shaped validation is deterministic on POSIX without requiring
      // Windows Developer Mode merely to construct the hostile link fixture.
      const windowsDirectory = temporaryControlRoot();
      const target = path.join(windowsDirectory, "target.json");
      const linked = path.join(windowsDirectory, "daemon-control.json");
      fs.writeFileSync(target, "{}\n");
      fs.symlinkSync(target, linked);
      expect(() =>
        observeDaemonControlReadOnly({
          directory: windowsDirectory,
          platform: "win32",
        })
      ).toThrow(/link, reparse point/u);
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    }
  });

  test("future-dated control, startup payloads, and startup mtimes fail clock integrity", () => {
    const controlDirectory = temporaryControlRoot();
    publishDaemonControl(101, {
      directory: controlDirectory,
      instanceId: UUID_A,
      now: () => 2_000,
    });
    expect(() =>
      observeDaemonControl({
        directory: controlDirectory,
        now: () => 1_999,
      })
    ).toThrow(/future.*clock integrity/u);

    const startupDirectory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory: startupDirectory,
      instanceId: UUID_A,
      now: () => 2_000,
      pidAlive: () => false,
    });
    expect(acquired.kind).toBe("acquired");
    expect(() =>
      observeDaemonStartup({
        directory: startupDirectory,
        now: () => 1_999,
      })
    ).toThrow(/future.*clock integrity/u);
    expect(() =>
      claimDaemonStartup(202, {
        directory: startupDirectory,
        instanceId: UUID_B,
        now: () => 1_999,
        pidAlive: () => false,
      })
    ).toThrow(/future.*clock integrity/u);
  });

  test("legacy cleanup atomically captures the shared path and restores a raced successor", () => {
    const directory = temporaryControlRoot();
    const control = path.join(directory, "daemon-control.json");
    fs.writeFileSync(control, `${JSON.stringify({
      protocol: 1,
      pid: 101,
      instanceId: UUID_A,
    })}\n`);
    const successor = {
      protocol: 1,
      pid: 202,
      instanceId: UUID_B,
    };
    clearDeadLegacyDaemonControl(
      { pid: 101, instanceId: UUID_A },
      {
        directory,
        pidAlive: () => false,
        beforeLegacyControlCapture: () => {
          fs.unlinkSync(control);
          fs.writeFileSync(control, `${JSON.stringify(successor)}\n`);
        },
      },
    );
    expect(JSON.parse(fs.readFileSync(control, "utf8"))).toEqual(successor);
    expect(observeDaemonControl({ directory })).toEqual({
      kind: "legacy",
      identity: { pid: 202, instanceId: UUID_B },
    });
  });

  test("crashed legacy capture journal is recovered before retry and publication", () => {
    const directory = temporaryControlRoot();
    fs.writeFileSync(
      path.join(directory, "daemon-control.json"),
      `${JSON.stringify({
        protocol: 1,
        pid: 101,
        instanceId: UUID_A,
      })}\n`,
    );
    expect(() =>
      clearDeadLegacyDaemonControl(
        { pid: 101, instanceId: UUID_A },
        {
          directory,
          pidAlive: () => false,
          processIdentity: UUID_C,
          afterLegacyControlCapture: () => {
            throw new Error("simulated cleaner crash");
          },
        },
      )
    ).toThrow("simulated cleaner crash");
    expect(fs.readdirSync(directory).some((entry) =>
      entry.startsWith("daemon-control-v1-cleanup-")
    )).toBe(true);
    expect(fs.readdirSync(directory).some((entry) =>
      entry.startsWith("daemon-control-v1-capture-")
    )).toBe(true);

    clearDeadLegacyDaemonControl(
      { pid: 101, instanceId: UUID_A },
      {
        directory,
        pidAlive: () => false,
        processIdentity: UUID_B,
      },
    );
    expect(observeDaemonControl({ directory })).toEqual({ kind: "missing" });
    expect(publishDaemonControl(202, {
      directory,
      instanceId: UUID_B,
      pidAlive: () => false,
    })).toEqual({ pid: 202, instanceId: UUID_B });
  });

  test("same-runtime legacy retry preserves recovery evidence when the target PID becomes live", () => {
    const directory = temporaryControlRoot();
    fs.writeFileSync(
      path.join(directory, "daemon-control.json"),
      `${JSON.stringify({
        protocol: 1,
        pid: 101,
        instanceId: UUID_A,
      })}\n`,
    );
    expect(() =>
      clearDeadLegacyDaemonControl(
        { pid: 101, instanceId: UUID_A },
        {
          directory,
          pidAlive: () => false,
          processIdentity: UUID_C,
          afterLegacyControlCapture: () => {
            throw new Error("simulated same-runtime crash");
          },
        },
      )
    ).toThrow("simulated same-runtime crash");

    let targetProbes = 0;
    expect(() =>
      clearDeadLegacyDaemonControl(
        { pid: 101, instanceId: UUID_A },
        {
          directory,
          processIdentity: UUID_C,
          pidAlive: (pid) => {
            if (pid !== 101) return false;
            targetProbes++;
            return targetProbes >= 2;
          },
        },
      )
    ).toThrow(/target PID 101 became live or was reused/u);
    expect(fs.readdirSync(directory).some((entry) =>
      entry.startsWith("daemon-control-v1-cleanup-")
    )).toBe(true);
    expect(fs.readdirSync(directory).some((entry) =>
      entry.startsWith("daemon-control-v1-capture-")
    )).toBe(true);

    clearDeadLegacyDaemonControl(
      { pid: 101, instanceId: UUID_A },
      {
        directory,
        processIdentity: UUID_C,
        pidAlive: () => false,
      },
    );
    expect(observeDaemonControl({ directory })).toEqual({ kind: "missing" });
  });

  test("recognized legacy startup authority refuses immediately without mutation", () => {
    const directory = temporaryControlRoot();
    const startup = path.join(directory, "daemon-startup.json");
    const legacy = {
      protocol: 1,
      token: UUID_A,
      ownerPid: 101,
      childPid: null,
      heartbeatMs: 1_000,
    };
    fs.writeFileSync(startup, `${JSON.stringify(legacy)}\n`);
    fs.utimesSync(startup, new Date(1_000), new Date(1_000));
    const bytes = fs.readFileSync(startup);
    expect(() =>
      claimDaemonStartup(202, {
        directory,
        instanceId: UUID_B,
        now: () => 20_000,
        pidAlive: () => false,
      })
    ).toThrow(/legacy.*verified installer replacement path/u);
    expect(fs.readFileSync(startup)).toEqual(bytes);
    expect(observeDaemonStartup({
      directory,
      now: () => 20_000,
    })).toMatchObject({
      kind: "starting",
      authority: "legacy",
      claim: { token: UUID_A },
    });
  });

  test("startup retirement releases its exact marker after EPERM and same-process retry succeeds", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    let attempts = 0;
    expect(() =>
      clearDaemonStartup(acquired.claim, {
        directory,
        processIdentity: UUID_C,
        beforeStartupAuthorityRetirement: () => {
          attempts++;
          const error = new Error("sharing violation") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      })
    ).toThrow(/retirement did not complete/u);
    expect(fs.readdirSync(directory).filter((entry) =>
      entry.startsWith("daemon-startup-v2-cleanup-")
    )).toEqual([]);
    expect(clearDaemonStartup(acquired.claim, {
      directory,
      processIdentity: UUID_C,
    })).toBe(true);
    expect(attempts).toBe(1);
    expect(observeDaemonStartup({ directory })).toEqual({ kind: "missing" });
  });

  test("startup retirement releases only its marker when authority changes to a successor", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    expect(clearDaemonStartup(acquired.claim, {
      directory,
      processIdentity: UUID_C,
      beforeExclusiveUnlink: () => {
        const authority = path.join(
          directory,
          "daemon-startup-v2-authority",
        );
        fs.rmSync(authority, { recursive: true });
        fs.mkdirSync(authority, { mode: 0o700 });
        writeNativeAclReceipt(authority);
        fs.writeFileSync(
          path.join(authority, "claim.json"),
          `${JSON.stringify({
            protocol: 1,
            token: UUID_B,
            ownerPid: 202,
            childPid: null,
            heartbeatMs: 1_000,
          })}\n`,
          { mode: 0o600 },
        );
        fs.utimesSync(
          path.join(authority, "claim.json"),
          new Date(1_000),
          new Date(1_000),
        );
      },
    })).toBe(false);
    expect(observeDaemonStartup({
      directory,
      now: () => 1_000,
    })).toMatchObject({ claim: { token: UUID_B } });
    expect(fs.readdirSync(directory).filter((entry) =>
      entry.startsWith("daemon-startup-v2-cleanup-")
    )).toEqual([]);
  });

  test("quarantined startup remains observable and blocks a concurrent launcher during handoff", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    expect(clearDaemonStartup(acquired.claim, {
      directory,
      processIdentity: UUID_A,
      now: () => 1_000,
      afterStartupAuthorityQuarantine: () => {
        expect(observeDaemonStartup({
          directory,
          now: () => 1_000,
        })).toMatchObject({
          kind: "starting",
          authority: "quarantine",
          claim: { token: UUID_A },
        });
        expect(() =>
          claimDaemonStartup(202, {
            directory,
            instanceId: UUID_B,
            processIdentity: UUID_B,
            now: () => 1_000,
            pidAlive: (pid) => pid === process.pid,
          })
        ).toThrow(/still active/u);
      },
    })).toBe(true);
    expect(observeDaemonStartup({ directory })).toEqual({ kind: "missing" });
  });

  test("released cleanup marker keeps quarantine visible and blocks launch until exact retirement finishes", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    let observedReleaseWindow = false;
    expect(clearDaemonStartup(acquired.claim, {
      directory,
      processIdentity: UUID_A,
      now: () => 1_000,
      afterStartupCleanupRelease: () => {
        observedReleaseWindow = true;
        expect(observeDaemonStartup({
          directory,
          now: () => 1_000,
        })).toMatchObject({
          kind: "starting",
          authority: "quarantine",
          claim: { token: UUID_A },
        });
        expect(() =>
          clearDaemonStartup(acquired.claim, {
            directory,
            processIdentity: UUID_A,
          })
        ).toThrow(/still active/u);
        expect(() =>
          claimDaemonStartup(202, {
            directory,
            instanceId: UUID_B,
            processIdentity: UUID_B,
            now: () => 1_000,
            pidAlive: (pid) => pid === process.pid,
          })
        ).toThrow(/still active/u);
      },
    })).toBe(true);
    expect(observedReleaseWindow).toBe(true);
    expect(claimDaemonStartup(202, {
      directory,
      instanceId: UUID_B,
      now: () => 1_000,
      pidAlive: () => false,
    })).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B },
    });
  });

  test("a later process recovers the self-describing post-commit crash window without the old token", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    const moduleUrl = new URL(
      "../../src/sync/control.ts",
      import.meta.url,
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--eval",
        `
          import { clearDaemonStartup } from ${JSON.stringify(moduleUrl)};
          clearDaemonStartup(
            { token: process.env.SANA_TEST_STARTUP_TOKEN },
            {
              directory: process.env.SANA_TEST_CONTROL_DIRECTORY,
              processIdentity: ${JSON.stringify(UUID_C)},
              pidAlive: () => false,
              afterStartupCleanupRelease: () => process.exit(86),
            },
          );
          process.exit(87);
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SANA_TEST_CONTROL_DIRECTORY: directory,
          SANA_TEST_STARTUP_TOKEN: UUID_A,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(86);
    const quarantine = path.join(
      directory,
      `daemon-startup-v2-quarantine-${UUID_A}`,
    );
    expect(fs.existsSync(quarantine)).toBe(true);
    expect(fs.readdirSync(quarantine).sort()).toEqual(
      process.platform === "win32"
        ? [
            ".sana-acl-setup-v1.json",
            "claim.json",
            "retirement.json",
          ]
        : ["claim.json", "retirement.json"],
    );
    expect(fs.readdirSync(directory).filter((entry) =>
      entry.startsWith("daemon-startup-v2-cleanup-")
    )).toEqual([]);

    expect(claimDaemonStartup(202, {
      directory,
      instanceId: UUID_B,
      processIdentity: UUID_B,
      now: () => 2_000,
      pidAlive: () => false,
    })).toMatchObject({
      kind: "acquired",
      claim: { token: UUID_B, ownerPid: 202 },
    });
    expect(fs.existsSync(quarantine)).toBe(false);
  });

  test("quarantine recovery preserves mismatched claims, corrupt retirement records, and unknown contents", () => {
    const cases = [
      {
        label: "mismatched claim",
        mutate: (quarantine: string) => {
          fs.writeFileSync(
            path.join(quarantine, "claim.json"),
            `${JSON.stringify({
              protocol: 1,
              token: UUID_B,
              ownerPid: 101,
              childPid: null,
              heartbeatMs: 1_000,
            })}\n`,
          );
        },
        expected: /does not exactly match/u,
      },
      {
        label: "corrupt retirement",
        mutate: (quarantine: string) => {
          fs.writeFileSync(
            path.join(quarantine, "retirement.json"),
            '{"phase":"committed","token":"not-a-uuid"}\n',
          );
        },
        expected: /invalid content.*preserved/u,
      },
      {
        label: "unknown content",
        mutate: (quarantine: string) => {
          fs.writeFileSync(
            path.join(quarantine, "unknown.bin"),
            "preserve hostile evidence\n",
          );
        },
        expected: /unrecognized.*preserved/iu,
      },
    ];
    for (const fixture of cases) {
      const directory = temporaryControlRoot();
      const acquired = claimDaemonStartup(101, {
        directory,
        instanceId: UUID_A,
        now: () => 1_000,
        pidAlive: () => false,
      });
      if (acquired.kind !== "acquired") throw new Error("missing claim");
      const quarantine = path.join(
        directory,
        `daemon-startup-v2-quarantine-${UUID_A}`,
      );
      expect(() =>
        clearDaemonStartup(acquired.claim, {
          directory,
          processIdentity: UUID_C,
          afterStartupAuthorityQuarantine: () => {
            fixture.mutate(quarantine);
            throw new Error(`forced ${fixture.label} crash`);
          },
        })
      ).toThrow(`forced ${fixture.label} crash`);
      const beforeEntries = fs.readdirSync(quarantine).sort();
      const marker = path.join(
        directory,
        `daemon-startup-v2-cleanup-${UUID_A}.json`,
      );
      expect(fs.existsSync(marker)).toBe(true);
      expect(() =>
        claimDaemonStartup(202, {
          directory,
          instanceId: UUID_B,
          processIdentity: UUID_B,
          now: () => 2_000,
          pidAlive: () => false,
        })
      ).toThrow(fixture.expected);
      expect(fs.readdirSync(quarantine).sort()).toEqual(beforeEntries);
      expect(fs.existsSync(marker)).toBe(true);
    }
  });

  test.skipIf(process.platform !== "win32")(
    "native Windows candidate, authority, and quarantine receipts bind to each exact path",
    () => {
      const directory = temporaryControlRoot();
      const receiptRoot = (target: string): string => {
        const receipt = JSON.parse(
          fs.readFileSync(
            path.join(target, ".sana-acl-setup-v1.json"),
            "utf8",
          ),
        ) as { root: string };
        return receipt.root;
      };
      const acquired = claimDaemonStartup(101, {
        directory,
        instanceId: UUID_A,
        now: () => 1_000,
        pidAlive: () => false,
        beforeStartupAppend: () => {
          const candidate = path.join(
            directory,
            `daemon-startup-v2-candidate-${UUID_A}`,
          );
          expect(receiptRoot(candidate)).toBe(
            fs.realpathSync.native(candidate),
          );
          expect(observeDaemonStartupReadOnly({
            directory,
            now: () => 1_000,
          })).toMatchObject({
            authority: "candidate",
            claim: { token: UUID_A },
          });
        },
      });
      if (acquired.kind !== "acquired") throw new Error("missing claim");
      const authority = path.join(
        directory,
        "daemon-startup-v2-authority",
      );
      expect(receiptRoot(authority)).toBe(
        fs.realpathSync.native(authority),
      );
      expect(clearDaemonStartup(acquired.claim, {
        directory,
        processIdentity: UUID_C,
        afterStartupAuthorityQuarantine: () => {
          const quarantine = path.join(
            directory,
            `daemon-startup-v2-quarantine-${UUID_A}`,
          );
          expect(receiptRoot(quarantine)).toBe(
            fs.realpathSync.native(quarantine),
          );
          expect(observeDaemonStartupReadOnly({
            directory,
            now: () => 1_000,
          })).toMatchObject({
            authority: "quarantine",
            claim: { token: UUID_A },
          });
        },
      })).toBe(true);

      const recoveryDirectory = temporaryControlRoot();
      const recoverable = claimDaemonStartup(202, {
        directory: recoveryDirectory,
        instanceId: UUID_B,
        now: () => 1_000,
        pidAlive: () => false,
      });
      if (recoverable.kind !== "acquired") {
        throw new Error("missing recoverable claim");
      }
      expect(() =>
        clearDaemonStartup(recoverable.claim, {
          directory: recoveryDirectory,
          processIdentity: UUID_C,
          beforeStartupQuarantineAclVerification: () => {
            throw new Error("crashed before quarantine ACL rebind");
          },
        })
      ).toThrow("crashed before quarantine ACL rebind");
      const recoveryQuarantine = path.join(
        recoveryDirectory,
        `daemon-startup-v2-quarantine-${UUID_B}`,
      );
      expect(receiptRoot(recoveryQuarantine).toLowerCase()).toBe(
        path.join(
          fs.realpathSync.native(recoveryDirectory),
          "daemon-startup-v2-authority",
        ).toLowerCase(),
      );
      expect(clearDaemonStartup(recoverable.claim, {
        directory: recoveryDirectory,
        processIdentity: UUID_C,
        pidAlive: () => false,
      })).toBe(true);
      expect(fs.existsSync(recoveryQuarantine)).toBe(false);
    },
  );

  test("startup retirement aggregates its primary failure with exact marker cleanup failure", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    let caught: unknown;
    try {
      clearDaemonStartup(acquired.claim, {
        directory,
        processIdentity: UUID_C,
        beforeExclusiveUnlink: () => {
          const markerFile = path.join(
            directory,
            `daemon-startup-v2-cleanup-${UUID_A}.json`,
          );
          const marker = JSON.parse(
            fs.readFileSync(markerFile, "utf8"),
          ) as Record<string, unknown>;
          fs.unlinkSync(markerFile);
          fs.writeFileSync(
            markerFile,
            `${JSON.stringify({
              ...marker,
              operationId: UUID_B,
            })}\n`,
            { mode: 0o600 },
          );
          throw new Error("forced primary retirement failure");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors as Error[];
    expect(errors.map((error) => error.message).join("\n"))
      .toContain("forced primary retirement failure");
    expect(errors.map((error) => error.message).join("\n"))
      .toContain("Startup cleanup marker changed during exact release");
    expect(fs.existsSync(path.join(
      directory,
      `daemon-startup-v2-cleanup-${UUID_A}.json`,
    ))).toBe(true);
  });

  test("Windows startup inventory accepts only an exact final-path ACL receipt", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => true,
    });
    expect(acquired.kind).toBe("acquired");
    const authority = path.join(
      directory,
      "daemon-startup-v2-authority",
    );
    const receipt = path.join(authority, ".sana-acl-setup-v1.json");
    fs.writeFileSync(receipt, `${JSON.stringify({
      version: 1,
      root: fs.realpathSync.native(authority),
      setup: "complete",
    })}\n`);
    expect(observeDaemonStartup({
      directory,
      platform: "win32",
      now: () => 1_000,
    })).toMatchObject({ claim: { token: UUID_A } });
    fs.writeFileSync(receipt, `${JSON.stringify({
      version: 1,
      root: fs.realpathSync.native(directory),
      setup: "complete",
    })}\n`);
    expect(() =>
      observeDaemonStartupReadOnly({
        directory,
        platform: "win32",
        now: () => 1_000,
      })
    ).toThrow(/does not validate this startup authority/u);
    if (process.platform === "win32") {
      fs.unlinkSync(receipt);
      const junctionTarget = temporaryControlRoot();
      fs.symlinkSync(junctionTarget, receipt, "junction");
      const junctionStats = fs.lstatSync(receipt) as fs.Stats & {
        reparsePointTag?: number;
      };
      expect(
        junctionStats.isSymbolicLink() ||
          (junctionStats.reparsePointTag ?? 0) !== 0,
      ).toBe(true);
      expect(() =>
        observeDaemonStartupReadOnly({
          directory,
          platform: "win32",
          now: () => 1_000,
        })
      ).toThrow(/ACL infrastructure receipt is unsafe/u);
      const preserved = fs.lstatSync(receipt) as fs.Stats & {
        reparsePointTag?: number;
      };
      expect(
        preserved.isSymbolicLink() ||
          (preserved.reparsePointTag ?? 0) !== 0,
      ).toBe(true);
      fs.unlinkSync(receipt);
      expect(fs.existsSync(receipt)).toBe(false);
      expect(fs.statSync(junctionTarget).isDirectory()).toBe(true);
    }
  });

  test("Windows startup ACL validation rejects missing, duplicate, swapped, and post-rename-failed receipts", () => {
    const directory = temporaryControlRoot();
    const acquired = claimDaemonStartup(101, {
      directory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => true,
    });
    expect(acquired.kind).toBe("acquired");
    const authority = path.join(
      directory,
      "daemon-startup-v2-authority",
    );
    const receipt = path.join(authority, ".sana-acl-setup-v1.json");
    if (fs.existsSync(receipt)) fs.unlinkSync(receipt);
    expect(() =>
      observeDaemonStartupReadOnly({
        directory,
        platform: "win32",
        now: () => 1_000,
      })
    ).toThrow(/exactly one canonical ACL receipt/u);

    const validReceipt = `${JSON.stringify({
      version: 1,
      root: fs.realpathSync.native(authority),
      setup: "complete",
    })}\n`;
    fs.writeFileSync(receipt, validReceipt, { mode: 0o600 });
    if (process.platform !== "win32") {
      const duplicate = path.join(
        authority,
        ".SANA-ACL-SETUP-V1.JSON",
      );
      fs.writeFileSync(duplicate, validReceipt, { mode: 0o600 });
      expect(() =>
        observeDaemonStartupReadOnly({
          directory,
          platform: "win32",
          now: () => 1_000,
        })
      ).toThrow(/exactly one canonical ACL receipt/u);
      fs.unlinkSync(duplicate);
    }

    const displaced = path.join(authority, "receipt.displaced");
    expect(() =>
      observeDaemonStartupReadOnly({
        directory,
        platform: "win32",
        now: () => 1_000,
        duringWindowsAclReceiptRead: () => {
          fs.renameSync(receipt, displaced);
          fs.writeFileSync(receipt, validReceipt, { mode: 0o600 });
        },
      })
    ).toThrow(/changed during read/u);
    expect(fs.readFileSync(displaced, "utf8")).toBe(validReceipt);

    const postRenameDirectory = temporaryControlRoot();
    expect(() =>
      claimDaemonStartup(202, {
        directory: postRenameDirectory,
        instanceId: UUID_B,
        now: () => 1_000,
        pidAlive: () => false,
        beforeStartupAuthorityAclVerification: () => {
          throw new Error("forced post-rename ACL failure");
        },
      })
    ).toThrow("forced post-rename ACL failure");
    if (process.platform === "win32") {
      expect(() =>
        observeDaemonStartup({
          directory: postRenameDirectory,
          now: () => 1_000,
        })
      ).toThrow(/does not validate this startup authority/u);
    } else {
      expect(observeDaemonStartup({
        directory: postRenameDirectory,
        now: () => 1_000,
      })).toMatchObject({
        kind: "starting",
        claim: { token: UUID_B },
      });
    }
    expect(fs.readdirSync(postRenameDirectory).some((entry) =>
      entry.startsWith("daemon-startup-v2-candidate-")
    )).toBe(false);
  });

  test("startup artifact cleanup refuses symlinks and native Windows junctions without touching targets", () => {
    const candidateDirectory = temporaryControlRoot();
    const candidateTarget = temporaryControlRoot();
    const targetEvidence = path.join(candidateTarget, "evidence.txt");
    fs.writeFileSync(targetEvidence, "preserve me\n");
    const candidate = path.join(
      candidateDirectory,
      `daemon-startup-v2-candidate-${UUID_A}`,
    );
    fs.symlinkSync(
      candidateTarget,
      candidate,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      claimDaemonStartup(101, {
        directory: candidateDirectory,
        instanceId: UUID_B,
        now: () => 1_000,
        pidAlive: () => false,
      })
    ).toThrow(/not an ordinary directory/u);
    expect(fs.readFileSync(targetEvidence, "utf8")).toBe("preserve me\n");
    const candidateStats = fs.lstatSync(candidate) as fs.Stats & {
      reparsePointTag?: number;
    };
    expect(
      candidateStats.isSymbolicLink() ||
        (candidateStats.reparsePointTag ?? 0) !== 0,
    ).toBe(true);

    const cleanupDirectory = temporaryControlRoot();
    const acquired = claimDaemonStartup(202, {
      directory: cleanupDirectory,
      instanceId: UUID_A,
      now: () => 1_000,
      pidAlive: () => false,
    });
    if (acquired.kind !== "acquired") throw new Error("missing claim");
    fs.renameSync(
      path.join(cleanupDirectory, "daemon-startup-v2-authority"),
      path.join(
        cleanupDirectory,
        `daemon-startup-v2-quarantine-${UUID_A}`,
      ),
    );
    const cleanupTarget = process.platform === "win32"
      ? temporaryControlRoot()
      : path.join(temporaryControlRoot(), "cleanup-target.json");
    if (process.platform !== "win32") {
      fs.writeFileSync(cleanupTarget, "{}\n");
    }
    const cleanupMarker = path.join(
      cleanupDirectory,
      `daemon-startup-v2-cleanup-${UUID_A}.json`,
    );
    fs.symlinkSync(
      cleanupTarget,
      cleanupMarker,
      process.platform === "win32" ? "junction" : "file",
    );
    expect(() =>
      claimDaemonStartup(303, {
        directory: cleanupDirectory,
        instanceId: UUID_B,
        now: () => 1_000,
        pidAlive: () => false,
      })
    ).toThrow(/link, reparse point|regular file/u);
    expect(fs.existsSync(cleanupTarget)).toBe(true);
    expect(fs.lstatSync(cleanupMarker).isSymbolicLink()).toBe(true);
  });

  test("stop request errors distinguish retryable prepublication from published unknown continuity", () => {
    expect(() =>
      requestDaemonStopWith(
        { pid: 101, instanceId: UUID_A },
        {
          observeControl: () => ({ kind: "missing" }),
          publishRequest: () => {
            throw new Error("must not publish");
          },
        },
      )
    ).toThrow(DaemonStopRequestRejectedError);

    let observations = 0;
    let caught: unknown;
    try {
      requestDaemonStopWith(
        { pid: 101, instanceId: UUID_A },
        {
          observeControl: () => {
            observations++;
            if (observations === 1) {
              return {
                kind: "ready",
                identity: { pid: 101, instanceId: UUID_A },
                heartbeatMs: 1_000,
                freshness: "fresh",
              };
            }
            throw new DaemonControlUnavailableError(
              "malformed successor control",
            );
          },
          publishRequest: () => {},
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DaemonStopPublishedError);
    expect(caught).toMatchObject({
      published: true,
      continuity: "unknown",
      identity: { pid: 101, instanceId: UUID_A },
    });
    expect((caught as Error).cause).toBeInstanceOf(
      DaemonControlUnavailableError,
    );
  });
});
