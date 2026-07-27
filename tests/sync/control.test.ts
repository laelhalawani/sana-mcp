import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DAEMON_CONTROL_STALE_MS,
  DaemonControlUnavailableError,
  DaemonStopPublishedError,
  DaemonStopRequestRejectedError,
  clearDaemonControl,
  clearDeadLegacyDaemonControl,
  daemonControlReady,
  daemonStopRequested,
  observeDaemonControl,
  observeDaemonControlReadOnly,
  publishDaemonControl,
  refreshDaemonControl,
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cooperative daemon control", () => {
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

  test("two exact cleaners cannot remove successor control or request publications", () => {
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

  test("malformed and multiple live identity-addressed control publications fail closed", () => {
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

  test("malformed control state fails closed and preserves evidence", () => {
    const directory = temporaryControlRoot();
    const control = path.join(directory, "daemon-control.json");
    fs.writeFileSync(control, '{"protocol":2,"phase":"ready","pid":0}\n');
    expect(() => observeDaemonControl({ directory })).toThrow(
      /Invalid JSON/u,
    );
    expect(fs.existsSync(`${control}.corrupt`)).toBe(true);
  });

  test("read-only health observation never creates, repairs, or quarantines control state", () => {
    const absent = path.join(temporaryControlRoot(), "absent");
    expect(observeDaemonControlReadOnly({ directory: absent })).toEqual({
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

  test("future-dated control payloads fail clock integrity", () => {
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
