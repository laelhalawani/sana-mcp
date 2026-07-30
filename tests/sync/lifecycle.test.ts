import { expect, test } from "bun:test";
import {
  DaemonStopRequestRejectedError,
  type DaemonControlIdentity,
  type DaemonControlObservation,
} from "../../src/sync/control.js";
import {
  runDaemonLifecycleWith,
  type DaemonLifecycleDependencies,
} from "../../src/sync/lifecycle.js";

const A: DaemonControlIdentity = {
  pid: 101,
  instanceId: "00000000-0000-4000-8000-000000000001",
};

function dependencies(
  overrides: Partial<DaemonLifecycleDependencies> & {
    control?: DaemonControlObservation[];
  } = {},
): DaemonLifecycleDependencies {
  let clock = 1_000;
  const controls = overrides.control ?? [{ kind: "missing" }];
  let controlIndex = 0;
  const defaultStop = (identity: DaemonControlIdentity) => ({
    identity,
    published: true as const,
    continuity: "confirmed" as const,
  });
  const base: DaemonLifecycleDependencies = {
    observeControl: () => {
      const observed = controls[Math.min(controlIndex, controls.length - 1)];
      controlIndex += 1;
      return observed;
    },
    requestStop: defaultStop,
    clearControl: () => {},
    clearLegacyControl: () => {},
    terminateStale: () => {},
    ensureRunning: async () => ({ alreadyRunning: false, spawned: true }),
    pidAlive: () => false,
    monotonicNow: () => clock,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 1_000,
    pollMs: 10,
    stoppedObservations: 3,
  };
  return { ...base, ...overrides, requestStop: overrides.requestStop ?? defaultStop };
}

test("health reports stopped when no control record is present", async () => {
  const result = await runDaemonLifecycleWith("health", dependencies());
  expect(result).toEqual({ state: "stopped", changed: false });
});

test("health reports running for a live ready control record", async () => {
  const result = await runDaemonLifecycleWith(
    "health",
    dependencies({
      control: [
        {
          kind: "ready",
          identity: A,
          heartbeatMs: 1_000,
          freshness: "fresh",
        },
      ],
      pidAlive: () => true,
    }),
  );
  expect(result.state).toBe("running");
});

test("health reports stopped for a dead ready control record", async () => {
  const result = await runDaemonLifecycleWith(
    "health",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "fresh" },
      ],
      pidAlive: () => false,
    }),
  );
  expect(result.state).toBe("stopped");
});

test("health fails closed for a stale-live control record", async () => {
  await expect(
    runDaemonLifecycleWith(
      "health",
      dependencies({
        control: [
          { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "stale" },
        ],
        pidAlive: () => true,
      }),
    ),
  ).rejects.toThrow(/stale while process/u);
});

test("verified installer health classifies a stale live daemon as running", async () => {
  const result = await runDaemonLifecycleWith(
    "health",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "stale" },
      ],
      pidAlive: () => true,
    }),
    { allowStaleRunning: true },
  );
  expect(result).toEqual({ state: "running", changed: false });
});

test("health rejects a future-dated control heartbeat", async () => {
  await expect(
    runDaemonLifecycleWith(
      "health",
      dependencies({
        control: [
          { kind: "ready", identity: A, heartbeatMs: 2_000, freshness: "fresh" },
        ],
        pidAlive: () => true,
      }),
    ),
  ).rejects.toThrow(/future/u);
});

test("start delegates to the launcher and preserves changed semantics", async () => {
  let called = false;
  const result = await runDaemonLifecycleWith(
    "start",
    dependencies({
      ensureRunning: async () => {
        called = true;
        return { alreadyRunning: false, spawned: true };
      },
    }),
  );
  expect(called).toBe(true);
  expect(result).toEqual({ state: "running", changed: true });
});

test("stop publishes a stop request and reaches a stable stopped state", async () => {
  const stopped: DaemonControlIdentity[] = [];
  let alive = true;
  const result = await runDaemonLifecycleWith(
    "stop",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "fresh" },
        { kind: "missing" },
        { kind: "missing" },
        { kind: "missing" },
      ],
      pidAlive: () => alive,
      requestStop: (identity) => {
        stopped.push(identity);
        alive = false;
        return { identity, published: true, continuity: "confirmed" };
      },
    }),
  );
  expect(stopped).toEqual([A]);
  expect(result.state).toBe("stopped");
  expect(result.changed).toBe(true);
});

test("stop publishes an authenticated request for a stale live daemon", async () => {
  const stopped: DaemonControlIdentity[] = [];
  let alive = true;
  const result = await runDaemonLifecycleWith(
    "stop",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "stale" },
        { kind: "missing" },
        { kind: "missing" },
        { kind: "missing" },
      ],
      pidAlive: () => alive,
      requestStop: (identity) => {
        stopped.push(identity);
        alive = false;
        return { identity, published: true, continuity: "confirmed" };
      },
    }),
  );
  expect(stopped).toEqual([A]);
  expect(result).toEqual({ state: "stopped", changed: true });
});

test("verified installer stop terminates only the exact stale identity", async () => {
  const terminated: DaemonControlIdentity[] = [];
  let alive = true;
  const result = await runDaemonLifecycleWith(
    "stop",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "stale" },
        { kind: "missing" },
        { kind: "missing" },
        { kind: "missing" },
      ],
      pidAlive: () => alive,
      requestStop: (identity) => ({
        identity,
        published: true,
        continuity: "confirmed",
      }),
      terminateStale: (identity, expectedExecutable) => {
        terminated.push(identity);
        expect(expectedExecutable).toBe("/verified/sana-mcp");
        alive = false;
      },
    }),
    {
      allowStaleTerminate: true,
      staleExecutablePath: "/verified/sana-mcp",
    },
  );
  expect(terminated).toEqual([A]);
  expect(result).toEqual({ state: "stopped", changed: true });
});

test("stop retries a transient rejection until the request is published", async () => {
  let attempts = 0;
  let alive = true;
  const result = await runDaemonLifecycleWith(
    "stop",
    dependencies({
      control: [
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "fresh" },
        { kind: "ready", identity: A, heartbeatMs: 1_000, freshness: "fresh" },
        { kind: "missing" },
        { kind: "missing" },
        { kind: "missing" },
      ],
      pidAlive: () => alive,
      requestStop: (identity) => {
        attempts += 1;
        if (attempts === 1) throw new DaemonStopRequestRejectedError();
        alive = false;
        return { identity, published: true, continuity: "confirmed" };
      },
    }),
  );
  expect(result.state).toBe("stopped");
});

test("unknown lifecycle operation is rejected", async () => {
  await expect(
    runDaemonLifecycleWith("reboot", dependencies()),
  ).rejects.toThrow(/health, stop, or start/u);
});
