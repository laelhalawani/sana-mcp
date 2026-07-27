import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_SERVER_LIFETIME_MS = 12_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const PROCESS_WATCHDOG_GRACE_MS = 1_000;
const TEST_ASSERTION_GRACE_MS = 2_000;
const SOURCE_SCENARIO_CHILD_TIMEOUT_MS = 15_000;
const SOURCE_SCENARIO_TEST_TIMEOUT_MS =
  SOURCE_SCENARIO_CHILD_TIMEOUT_MS +
  SOURCE_SERVER_LIFETIME_MS +
  PROCESS_WATCHDOG_GRACE_MS +
  TEST_ASSERTION_GRACE_MS;
const NATIVE_HELPER_LIFETIME_MS = 5_000;
const NATIVE_WATCHDOG_TEST_LIFETIME_MS = 3_000;
const AUTHORITY_CHILD_TIMEOUT_MS = 5_000;
const NATIVE_HELPER_TEST_TIMEOUT_MS =
  NATIVE_HELPER_LIFETIME_MS +
  DEFAULT_WAIT_TIMEOUT_MS +
  NATIVE_HELPER_LIFETIME_MS +
  PROCESS_WATCHDOG_GRACE_MS +
  TEST_ASSERTION_GRACE_MS;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 50,
      retryDelay: 100,
    });
    expect(fs.existsSync(root)).toBe(false);
  }
});

const childSource = String.raw`
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { mock } = await import("bun:test");

  const root = process.env.AUTH_TEST_ROOT;
  const scenario = process.env.AUTH_TEST_SCENARIO;
  const repository = process.env.AUTH_TEST_REPOSITORY;
  const serverLifetimeMs = process.env.AUTH_TEST_SERVER_LIFETIME_MS;
  if (!root || !scenario || !repository || !serverLifetimeMs) {
    throw new Error("isolated auth test environment is incomplete");
  }
  const readyFile = path.join(root, "fake-ready.json");
  const serverStateFile = path.join(root, "fake-state.json");
  const fixtureFile = path.join(
    repository,
    "tests",
    "fixtures",
    "sana",
    "user-me-workspace-null.json",
  );
  const fakeServerFile = path.join(
    repository,
    "tests",
    "fixtures",
    "sana",
    "fake-sana-server.ts",
  );
  const daemonMarker = path.join(root, "daemon-mock-called");
  const server = spawn(
    process.execPath,
    [
      fakeServerFile,
      "--mode",
      "source",
      "--scenario",
      scenario,
      "--ready-file",
      readyFile,
      "--state-file",
      serverStateFile,
      "--fixture",
      fixtureFile,
      "--parent-pid",
      String(process.pid),
      "--lifetime-ms",
      serverLifetimeMs,
    ],
    {
      cwd: repository,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let serverStdout = "";
  let serverStderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    serverStdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });

  const waitFor = async (predicate, description, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for " + description);
      }
      await Bun.sleep(10);
    }
  };
  const stopServer = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
    }
    await waitFor(
      () => server.exitCode !== null || server.signalCode !== null,
      "fake Sana server cleanup",
    );
  };
  let store;
  try {
    await waitFor(
      () => fs.existsSync(readyFile) || server.exitCode !== null,
      "fake Sana server readiness",
    );
    if (server.exitCode !== null) {
      throw new Error(
        "fake Sana server exited before readiness: " +
          serverStdout +
        serverStderr,
      );
    }
    const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    assert(
      typeof ready.origin === "string" &&
        ready.origin.startsWith("http://127.0.0.1:"),
      "fake Sana server did not publish an exact loopback origin",
    );
    process.env.SANA_BASE_URL = ready.origin;

    mock.module("./src/sync/spawn.js", () => ({
      ensureDaemonRunning: async () => {
        fs.writeFileSync(daemonMarker, "called\n", "utf8");
        return { alreadyRunning: false, spawned: true };
      },
    }));

    const {
      AuthoritativeWorkspaceUnavailableError,
      SanaClient,
      SignInChallengeRejectedError,
    } = await import("./src/sana/client.ts");
    const {
      VerifyCodeRemoteError,
      requestCode,
      verifyCode,
    } = await import("./src/sana/auth.ts");
    const { inspectCurrentSession } = await import(
      "./src/sana/session-publication.ts"
    );
    const { SanaStore } = await import("./src/store/db.ts");

    const initial = new SanaClient();
    const initialVersion = initial.sessionVersion();
    assert(
      initialVersion.generation === 0 &&
        initialVersion.publicationToken === null &&
        initialVersion.userId === null &&
        initialVersion.workspaceId === null,
      "auth scenario did not start at generation zero",
    );
    await requestCode(initial, "synthetic@example.test");

    const sessionFile = path.join(
      process.env.SANA_DATA_DIR,
      "session.json",
    );
    const generationOneBytes = fs.readFileSync(sessionFile);
    const generationOneSession = JSON.parse(
      generationOneBytes.toString("utf8"),
    );
    assert(
      generationOneSession.generation === 1 &&
        typeof generationOneSession.publicationToken === "string" &&
        generationOneSession.userId === undefined &&
        generationOneSession.workspaceId === undefined &&
        generationOneSession.cookies["sana-ai-session"] ===
          "request-session" &&
        generationOneSession.pendingLogin.email ===
          "synthetic@example.test" &&
        generationOneSession.pendingLogin.csrfToken ===
          "synthetic-csrf-token" &&
        generationOneSession.authenticatedOrigin === ready.origin,
      "request-code publication did not persist the exact pending session",
    );

    const client = SanaClient.load();
    store = new SanaStore();
    const generationOneState = store.getSyncState();
    const generationOneStateBytes = JSON.stringify(generationOneState);
    const generationOneVersion = client.sessionVersion();
    const clientMutableState = () => ({
      cookies: client["jar"].toJSON(),
      userId: client.userId,
      workspaceId: client.workspaceId,
      email: client.email,
      pendingLogin:
        client["pendingLogin"] === null ||
        client["pendingLogin"] === undefined
          ? client["pendingLogin"]
          : { ...client["pendingLogin"] },
      generation: client["generation"],
      publicationToken: client["publicationToken"],
      authenticatedOrigin: client["authenticatedOrigin"],
      version: client.sessionVersion(),
    });
    const generationOneClientState = clientMutableState();
    const generationOneClientStateBytes = JSON.stringify(
      generationOneClientState,
    );
    assert(
      generationOneVersion.generation === 1 &&
        generationOneVersion.publicationToken ===
          generationOneSession.publicationToken &&
        generationOneVersion.userId === null &&
        generationOneVersion.workspaceId === null &&
        client.pendingSignInChallenge()?.email ===
          "synthetic@example.test",
      "request-code publication did not reload at generation one",
    );
    const beforeReconciliation = inspectCurrentSession(store, client);
    assert(
      beforeReconciliation.kind === "current" &&
        beforeReconciliation.generation === 1,
      "generation-one session and store did not reconcile",
    );

    if (scenario === "happy") {
      const result = await verifyCode(
        client,
        store,
        "synthetic@example.test",
        "123456",
      );
      assert(result.kind === "ready", "happy login was not ready");
      assert(
        result.user.id === "synthetic-user" &&
          result.user.email === "synthetic@example.test" &&
          result.workspaceId === "synthetic-workspace" &&
          result.confirmation.generation === 2 &&
          result.confirmation.userId === "synthetic-user" &&
          result.confirmation.workspaceId === "synthetic-workspace",
        "happy login returned the wrong authoritative identity",
      );
      const savedBytes = fs.readFileSync(sessionFile);
      assert(
        Buffer.compare(savedBytes, generationOneBytes) !== 0,
        "successful login did not publish a new session",
      );
      const saved = JSON.parse(savedBytes.toString("utf8"));
      assert(
        saved.generation === 2 &&
          saved.publicationToken ===
            result.confirmation.publicationToken &&
          saved.userId === "synthetic-user" &&
          saved.workspaceId === "synthetic-workspace" &&
          saved.email === "synthetic@example.test" &&
          saved.pendingLogin === null &&
          saved.cookies["sana-ai-session"] === "fresh-session" &&
          saved.authenticatedOrigin === ready.origin,
        "successful login session publication was incomplete",
      );
      const reloaded = SanaClient.load();
      const reconciliation = inspectCurrentSession(store, reloaded);
      const state = store.getSyncState();
      assert(
        reconciliation.kind === "current" &&
          reconciliation.generation === 2 &&
          state.auth_generation === 2 &&
          state.auth_publication_token === saved.publicationToken &&
          state.auth_user_id === "synthetic-user" &&
          state.auth_workspace_id === "synthetic-workspace" &&
          state.auth_transition_pid === null &&
          state.auth_transition_token === null &&
          state.auth_transition_generation === null &&
          state.auth_transition_kind === null &&
          state.auth_transition_user_id === null &&
          state.auth_transition_workspace_id === null &&
          state.auth_issue_code === null &&
          state.auth_issue_message === null &&
          state.auth_issue_operation_token === null &&
          state.auth_issue_generation === null &&
          state.auth_issue_kind === null &&
          state.auth_pending === 0 &&
          state.blocking === 1 &&
          state.catchup_generation === 2 &&
          state.daemon_pid === null &&
          state.daemon_heartbeat_ms === null &&
          state.daemon_instance_id === null,
        "successful login did not leave a complete reconciled generation-two tuple",
      );
      assert(
        fs.readFileSync(daemonMarker, "utf8") === "called\n",
        "successful publication did not reach daemon launch",
      );
    } else {
      let caught;
      try {
        await verifyCode(
          client,
          store,
          "synthetic@example.test",
          "123456",
        );
      } catch (error) {
        caught = error;
      }
      assert(
        caught instanceof VerifyCodeRemoteError,
        "failed verified login did not retain its typed remote outcome",
      );
      if (scenario === "workspace-unavailable") {
        assert(
          caught.cause instanceof
            AuthoritativeWorkspaceUnavailableError,
          "missing response workspace was not typed unavailable",
        );
      } else {
        assert(
          caught.cause instanceof SignInChallengeRejectedError,
          "email mismatch was not rejected",
        );
      }
      assert(
        Buffer.compare(
          fs.readFileSync(sessionFile),
          generationOneBytes,
        ) === 0,
        "failed login changed the generation-one session bytes",
      );
      assert(
        JSON.stringify(store.getSyncState()) === generationOneStateBytes,
        "failed login changed the generation-one database tuple",
      );
      const restoredClientState = clientMutableState();
      assert(
        JSON.stringify(restoredClientState) ===
          generationOneClientStateBytes &&
          Object.keys(restoredClientState.cookies).length === 1 &&
          restoredClientState.cookies["sana-ai-session"] ===
            "request-session" &&
          !Object.values(restoredClientState.cookies).includes(
            "fresh-session",
          ) &&
          restoredClientState.userId === undefined &&
          restoredClientState.workspaceId === undefined &&
          restoredClientState.email === "synthetic@example.test" &&
          restoredClientState.pendingLogin?.email ===
            "synthetic@example.test" &&
          restoredClientState.pendingLogin?.csrfToken ===
            "synthetic-csrf-token" &&
          restoredClientState.authenticatedOrigin === ready.origin,
        "failed login did not restore the same client's complete mutable state",
      );
      const restoredVersion = client.sessionVersion();
      assert(
        restoredVersion.generation === 1 &&
          restoredVersion.publicationToken ===
            generationOneSession.publicationToken &&
          restoredVersion.userId === null &&
          restoredVersion.workspaceId === null &&
          client.pendingSignInChallenge()?.email ===
            "synthetic@example.test" &&
          !fs.existsSync(daemonMarker) &&
          !fs.existsSync(
            path.join(process.env.SANA_DATA_DIR, "daemon-control.json"),
          ) &&
          !fs.existsSync(
            path.join(process.env.SANA_DATA_DIR, "daemon-stop.json"),
          ) &&
          generationOneState.daemon_pid === null &&
          generationOneState.daemon_heartbeat_ms === null &&
          generationOneState.daemon_instance_id === null,
        "failed login exposed a fresh identity, generation, lease, or daemon",
      );
      const reconciliation = inspectCurrentSession(store, SanaClient.load());
      assert(
        reconciliation.kind === "current" &&
          reconciliation.generation === 1,
        "failed login did not retain current generation-one reconciliation",
      );
    }

    await waitFor(
      () =>
        fs.existsSync(serverStateFile) &&
        (server.exitCode !== null || server.signalCode !== null),
      "fake Sana server completion",
    );
    const serverState = JSON.parse(
      fs.readFileSync(serverStateFile, "utf8"),
    );
    assert(
      serverState.kind === "complete" &&
        serverState.mode === "source" &&
        serverState.scenario === scenario &&
        serverState.requests.length === 4,
      "fake Sana server did not complete the exact source request sequence: " +
        JSON.stringify(serverState),
    );
  } finally {
    if (store) store.close();
    await stopServer();
  }
`;

interface ScenarioResult {
  readonly child: ReturnType<typeof spawnSync>;
  readonly serverCleanupError?: string;
  readonly serverState?: Readonly<{
    kind?: unknown;
    error?: unknown;
  }>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    Atomics.wait(sleeper, 0, 0, 10);
  }
  return true;
}

function provePublishedServerStopped(
  root: string,
  configuredLifetimeMs: number,
): string | undefined {
  if (
    !Number.isSafeInteger(configuredLifetimeMs) ||
    configuredLifetimeMs <= 0 ||
    configuredLifetimeMs > 60_000
  ) {
    return "fake Sana server proof received an invalid configured lifetime";
  }
  const readyFile = path.join(root, "fake-ready.json");
  if (!fs.existsSync(readyFile)) {
    return "fake Sana server did not publish its PID";
  }
  let pid: number;
  try {
    const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
      pid?: unknown;
    };
    if (
      typeof ready.pid !== "number" ||
      !Number.isSafeInteger(ready.pid) ||
      ready.pid <= 0
    ) {
      return "fake Sana server published an invalid PID";
    }
    pid = ready.pid;
  } catch (error) {
    return `fake Sana server PID publication was unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (
    waitForProcessExit(
      pid,
      configuredLifetimeMs + PROCESS_WATCHDOG_GRACE_MS,
    )
  ) {
    return undefined;
  }
  return (
    `fake Sana server PID ${pid} remained alive beyond its configured ` +
    `${configuredLifetimeMs}ms lifetime and ${PROCESS_WATCHDOG_GRACE_MS}ms watchdog grace; ` +
    "no signal was sent to the file-derived PID"
  );
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await Bun.sleep(10);
  }
}

interface NativeHelper {
  readonly root: string;
  readonly readyFile: string;
  readonly stateFile: string;
  readonly releaseFile: string;
  readonly finalResponseReleaseFile?: string;
  readonly lifetimeMs: number;
  readonly child: ReturnType<typeof spawn>;
  readonly stderr: () => string;
}

async function startNativeHelper(
  lifetimeMs: number,
  options: Readonly<{ delayFinalResponse?: boolean }> = {},
): Promise<NativeHelper> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-auth-native-helper-"),
  );
  temporaryRoots.push(root);
  const readyFile = path.join(root, "fake-ready.json");
  const stateFile = path.join(root, "fake-state.json");
  const releaseFile = path.join(root, "native-release");
  const finalResponseReleaseFile = path.join(
    root,
    "final-response-release",
  );
  const helper = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "fake-sana-server.ts",
  );
  const fixture = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "user-me-workspace-null.json",
  );
  const child = spawn(
    process.execPath,
    [
      helper,
      "--mode",
      "native",
      "--scenario",
      "happy",
      "--ready-file",
      readyFile,
      "--state-file",
      stateFile,
      "--fixture",
      fixture,
      "--native-release-file",
      releaseFile,
      ...(options.delayFinalResponse === true
        ? [
            "--final-response-release-file",
            finalResponseReleaseFile,
          ]
        : []),
      "--parent-pid",
      String(process.pid),
      "--lifetime-ms",
      String(lifetimeMs),
    ],
    {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitFor(
    () => fs.existsSync(readyFile) || child.exitCode !== null,
    "native helper readiness",
  );
  if (child.exitCode !== null) {
    throw new Error(`native helper exited before readiness: ${stderr}`);
  }
  return {
    root,
    readyFile,
    stateFile,
    releaseFile,
    lifetimeMs,
    ...(options.delayFinalResponse === true
      ? { finalResponseReleaseFile }
      : {}),
    child,
    stderr: () => stderr,
  };
}

async function stopNativeHelper(helper: NativeHelper): Promise<void> {
  if (
    helper.child.exitCode === null &&
    helper.child.signalCode === null
  ) {
    helper.child.kill();
  }
  await waitFor(
    () =>
      helper.child.exitCode !== null ||
      helper.child.signalCode !== null,
    "native helper cleanup",
  );
  expect(
    provePublishedServerStopped(helper.root, helper.lifetimeMs),
  ).toBeUndefined();
}

function requestHeaders(
  accept: string,
  cookie = "",
  workspace = "",
): Headers {
  const headers = new Headers({ accept });
  if (cookie !== "") headers.set("cookie", cookie);
  if (workspace !== "") {
    headers.set("sana-ai-workspace-id", workspace);
  }
  return headers;
}

async function driveNativeHelperToDaemonGate(
  helper: NativeHelper,
): Promise<{
  readonly daemonResponse: Promise<Response>;
  readonly origin: string;
}> {
  const ready = JSON.parse(
    fs.readFileSync(helper.readyFile, "utf8"),
  ) as { origin: string };
  const origin = ready.origin;
  const csrf = await fetch(`${origin}/x-api/auth/csrf-token`, {
    headers: requestHeaders("application/json"),
  });
  expect(csrf.status).toBe(200);
  expect(await csrf.json()).toEqual({
    csrfToken: "synthetic-csrf-token",
  });
  expect(csrf.headers.get("set-cookie")).toContain(
    "sana-ai-session=request-session",
  );

  const sendLinkHeaders = requestHeaders(
    "application/json",
    "sana-ai-session=request-session",
  );
  sendLinkHeaders.set("content-type", "application/json");
  const sendLink = await fetch(
    `${origin}/x-api/trpc/user.sendSignInLink`,
    {
      method: "POST",
      headers: sendLinkHeaders,
      body: JSON.stringify({ email: "synthetic@example.test" }),
    },
  );
  expect(sendLink.status).toBe(200);
  expect(await sendLink.json()).toEqual({
    result: { data: { accepted: true } },
  });

  const magicLink = new URL(`${origin}/x-api/auth/magic-link`);
  magicLink.searchParams.set("email", "synthetic@example.test");
  magicLink.searchParams.set("csrfToken", "synthetic-csrf-token");
  magicLink.searchParams.set("code", "123456");
  const verified = await fetch(magicLink, {
    headers: requestHeaders("text/html,application/json"),
  });
  expect(verified.status).toBe(200);
  expect(await verified.text()).toBe("authenticated");
  expect(verified.headers.get("set-cookie")).toContain(
    "sana-ai-session=fresh-session",
  );

  const loginMe = await fetch(`${origin}/x-api/trpc/user.me`, {
    headers: requestHeaders(
      "application/json",
      "sana-ai-session=fresh-session",
    ),
  });
  expect(loginMe.status).toBe(200);
  const loginBody = (await loginMe.json()) as {
    result: { data: { workspace: unknown } };
  };
  expect(loginBody.result.data.workspace).toBeNull();

  const daemonResponse = fetch(`${origin}/x-api/trpc/user.me`, {
    headers: requestHeaders(
      "application/json",
      "sana-ai-session=fresh-session",
      "synthetic-workspace",
    ),
  });
  await waitFor(
    () => {
      if (!fs.existsSync(helper.stateFile)) return false;
      const state = JSON.parse(
        fs.readFileSync(helper.stateFile, "utf8"),
      ) as { kind?: unknown };
      return state.kind === "daemon-blocked";
    },
    "native daemon gate publication",
  );
  return { daemonResponse, origin };
}

function runScenario(
  scenario: "happy" | "workspace-unavailable" | "email-mismatch",
): ScenarioResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-auth-e2e-"));
  temporaryRoots.push(root);
  const directories = {
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    transcripts: path.join(root, "transcripts"),
    appData: path.join(root, "appdata"),
    localAppData: path.join(root, "localappdata"),
    tmp: path.join(root, "tmp"),
  };
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const executableDirectory = path.dirname(process.execPath);
  const environment: Record<string, string> = {
    AUTH_TEST_REPOSITORY: ROOT,
    AUTH_TEST_ROOT: root,
    AUTH_TEST_SCENARIO: scenario,
    AUTH_TEST_SERVER_LIFETIME_MS: String(
      SOURCE_SERVER_LIFETIME_MS,
    ),
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    XDG_CONFIG_HOME: path.join(directories.home, ".config"),
    XDG_CACHE_HOME: path.join(directories.home, ".cache"),
    SANA_DATA_DIR: directories.data,
    SANA_TRANSCRIPTS_DIR: directories.transcripts,
    SANA_SEMANTIC: "0",
    PATH: executableDirectory,
    TEMP: directories.tmp,
    TMP: directories.tmp,
    TMPDIR: directories.tmp,
  };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PSModulePath",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const child = spawnSync(process.execPath, ["-e", childSource], {
    cwd: ROOT,
    encoding: "utf8",
    env: environment,
    timeout: SOURCE_SCENARIO_CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  const serverCleanupError = provePublishedServerStopped(
    root,
    SOURCE_SERVER_LIFETIME_MS,
  );
  const serverStateFile = path.join(root, "fake-state.json");
  let serverState: ScenarioResult["serverState"];
  if (fs.existsSync(serverStateFile)) {
    try {
      serverState = JSON.parse(
        fs.readFileSync(serverStateFile, "utf8"),
      ) as ScenarioResult["serverState"];
    } catch {
      // The scenario assertions and cleanup result retain primary authority.
    }
  }
  return {
    child,
    ...(serverCleanupError === undefined
      ? {}
      : { serverCleanupError }),
    ...(serverState === undefined ? {} : { serverState }),
  };
}

test("observed null-workspace shape completes real auth publication", {
  timeout: SOURCE_SCENARIO_TEST_TIMEOUT_MS,
}, () => {
  const result = runScenario("happy");
  expect(result.serverCleanupError).toBeUndefined();
  expect(result.child.signal, result.child.stderr).toBeNull();
  expect(result.child.status, result.child.stderr).toBe(0);
});

test("missing response workspace rolls back the complete published challenge", {
  timeout: SOURCE_SCENARIO_TEST_TIMEOUT_MS,
}, () => {
  const result = runScenario("workspace-unavailable");
  expect(result.serverCleanupError).toBeUndefined();
  expect(result.child.signal, result.child.stderr).toBeNull();
  expect(result.child.status, result.child.stderr).toBe(0);
});

test("post-challenge email mismatch rolls back the complete published challenge", {
  timeout: SOURCE_SCENARIO_TEST_TIMEOUT_MS,
}, () => {
  const result = runScenario("email-mismatch");
  expect(result.serverCleanupError).toBeUndefined();
  expect(result.child.signal, result.child.stderr).toBeNull();
  expect(result.child.status, result.child.stderr).toBe(0);
});

test("native helper blocks after exact daemon request validation and releases the complete sequence", {
  timeout: NATIVE_HELPER_TEST_TIMEOUT_MS,
}, async () => {
  const helper = await startNativeHelper(NATIVE_HELPER_LIFETIME_MS);
  try {
    const { daemonResponse, origin } =
      await driveNativeHelperToDaemonGate(helper);
    const blocked = JSON.parse(
      fs.readFileSync(helper.stateFile, "utf8"),
    );
    expect(blocked).toEqual({
      kind: "daemon-blocked",
      mode: "native",
      scenario: "happy",
      requests: [
        {
          index: 0,
          method: "GET",
          pathname: "/x-api/auth/csrf-token",
        },
        {
          index: 1,
          method: "POST",
          pathname: "/x-api/trpc/user.sendSignInLink",
        },
        {
          index: 2,
          method: "GET",
          pathname: "/x-api/auth/magic-link",
        },
        {
          index: 3,
          method: "GET",
          pathname: "/x-api/trpc/user.me",
        },
        {
          index: 4,
          method: "GET",
          pathname: "/x-api/trpc/user.me",
        },
      ],
    });
    let daemonSettled = false;
    void daemonResponse.then(
      () => {
        daemonSettled = true;
      },
      () => {
        daemonSettled = true;
      },
    );
    await Bun.sleep(100);
    expect(daemonSettled).toBe(false);
    expect(fs.existsSync(helper.releaseFile)).toBe(false);

    fs.writeFileSync(helper.releaseFile, "release\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const daemonMe = await daemonResponse;
    expect(daemonMe.status).toBe(200);
    const daemonBody = (await daemonMe.json()) as {
      result: { data: { workspace: unknown } };
    };
    expect(daemonBody.result.data.workspace).toEqual({
      id: "synthetic-workspace",
    });

    const listUrl = new URL(`${origin}/x-api/trpc/asset.listRecent`);
    listUrl.searchParams.set(
      "input",
      JSON.stringify({
        assetSourceTypes: ["sana-ai:meeting"],
        direction: "forward",
      }),
    );
    const list = await fetch(listUrl, {
      headers: requestHeaders(
        "application/json",
        "sana-ai-session=fresh-session",
        "synthetic-workspace",
      ),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      result: {
        data: {
          assets: [],
          nextCursor: null,
        },
      },
    });
    await waitFor(
      () =>
        fs.existsSync(helper.stateFile) &&
        (helper.child.exitCode !== null ||
          helper.child.signalCode !== null),
      "native helper completion",
    );
    const complete = JSON.parse(
      fs.readFileSync(helper.stateFile, "utf8"),
    );
    expect(complete.kind).toBe("complete");
    expect(complete.mode).toBe("native");
    expect(complete.scenario).toBe("happy");
    expect(complete.requests).toEqual([
      ...blocked.requests,
      {
        index: 5,
        method: "GET",
        pathname: "/x-api/trpc/asset.listRecent",
      },
    ]);
    expect(helper.child.exitCode, helper.stderr()).toBe(0);
  } finally {
    await stopNativeHelper(helper);
  }
});

test("native completion waits for the streamed final response and shuts down gracefully", {
  timeout: NATIVE_HELPER_TEST_TIMEOUT_MS,
}, async () => {
  const helper = await startNativeHelper(NATIVE_HELPER_LIFETIME_MS, {
    delayFinalResponse: true,
  });
  try {
    const { daemonResponse, origin } =
      await driveNativeHelperToDaemonGate(helper);
    fs.writeFileSync(helper.releaseFile, "release\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const daemonMe = await daemonResponse;
    expect(daemonMe.status).toBe(200);
    await daemonMe.arrayBuffer();

    const listUrl = new URL(`${origin}/x-api/trpc/asset.listRecent`);
    listUrl.searchParams.set(
      "input",
      JSON.stringify({
        assetSourceTypes: ["sana-ai:meeting"],
        direction: "forward",
      }),
    );
    const list = await fetch(listUrl, {
      headers: requestHeaders(
        "application/json",
        "sana-ai-session=fresh-session",
        "synthetic-workspace",
      ),
    });
    expect(list.status).toBe(200);
    expect(list.body).not.toBeNull();
    const reader = list.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Uint8Array);
    await Bun.sleep(100);
    const stillBlocked = JSON.parse(
      fs.readFileSync(helper.stateFile, "utf8"),
    ) as { kind: string; requests: unknown[] };
    expect(stillBlocked.kind).toBe("daemon-blocked");
    expect(stillBlocked.requests).toHaveLength(5);
    expect(helper.child.exitCode).toBeNull();
    expect(helper.child.signalCode).toBeNull();
    expect(fs.existsSync(helper.finalResponseReleaseFile!)).toBe(false);

    fs.writeFileSync(
      helper.finalResponseReleaseFile!,
      "release\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    const chunks = [first.value!];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    expect(JSON.parse(body)).toEqual({
      result: {
        data: {
          assets: [],
          nextCursor: null,
        },
      },
    });
    await waitFor(
      () =>
        fs.existsSync(helper.stateFile) &&
        (
          JSON.parse(
            fs.readFileSync(helper.stateFile, "utf8"),
          ) as { kind?: unknown }
        ).kind === "complete",
      "post-shutdown native completion publication",
    );
    const complete = JSON.parse(
      fs.readFileSync(helper.stateFile, "utf8"),
    ) as { kind: string; requests: unknown[] };
    expect(complete.kind).toBe("complete");
    expect(complete.requests).toHaveLength(6);
    let postCompletionConnectionError: unknown;
    try {
      await fetch(`${origin}/x-api/auth/csrf-token`, {
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      postCompletionConnectionError = error;
    }
    expect(
      postCompletionConnectionError,
      "complete state was published before the server stopped accepting connections",
    ).toBeDefined();
    await waitFor(
      () =>
        helper.child.exitCode !== null ||
        helper.child.signalCode !== null,
      "post-completion native helper exit",
    );
    expect(helper.child.exitCode, helper.stderr()).toBe(0);
  } finally {
    await stopNativeHelper(helper);
  }
});

test("native helper gate remains bounded by the absolute lifetime watchdog", {
  timeout:
    DEFAULT_WAIT_TIMEOUT_MS +
    DEFAULT_WAIT_TIMEOUT_MS +
    DEFAULT_WAIT_TIMEOUT_MS +
    NATIVE_WATCHDOG_TEST_LIFETIME_MS +
    PROCESS_WATCHDOG_GRACE_MS +
    TEST_ASSERTION_GRACE_MS,
}, async () => {
  const helper = await startNativeHelper(
    NATIVE_WATCHDOG_TEST_LIFETIME_MS,
  );
  try {
    const { daemonResponse } =
      await driveNativeHelperToDaemonGate(helper);
    void daemonResponse.catch(() => undefined);
    expect(fs.existsSync(helper.releaseFile)).toBe(false);
    await waitFor(
      () =>
        fs.existsSync(helper.stateFile) &&
        (helper.child.exitCode !== null ||
          helper.child.signalCode !== null),
      "blocked native helper watchdog cleanup",
      DEFAULT_WAIT_TIMEOUT_MS,
    );
    const state = JSON.parse(
      fs.readFileSync(helper.stateFile, "utf8"),
    ) as { kind: string; error: string; requests: unknown[] };
    expect(state.kind).toBe("failed");
    expect(state.error).toContain(
      `exceeded its ${NATIVE_WATCHDOG_TEST_LIFETIME_MS}ms lifetime`,
    );
    expect(state.requests).toHaveLength(5);
    expect(helper.child.exitCode, helper.stderr()).toBe(0);
  } finally {
    await stopNativeHelper(helper);
  }
});

test("native release authority rejects missing, source-only, escaped, relative, and symlink paths", {
  timeout:
    5 * AUTHORITY_CHILD_TIMEOUT_MS +
    TEST_ASSERTION_GRACE_MS,
}, () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-auth-native-authority-"),
  );
  temporaryRoots.push(root);
  const readyFile = path.join(root, "ready.json");
  const stateFile = path.join(root, "state.json");
  const helper = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "fake-sana-server.ts",
  );
  const fixture = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "user-me-workspace-null.json",
  );
  const base = [
    helper,
    "--scenario",
    "happy",
    "--ready-file",
    readyFile,
    "--state-file",
    stateFile,
    "--fixture",
    fixture,
    "--parent-pid",
    String(process.pid),
    "--lifetime-ms",
    "1000",
  ];
  const run = (mode: "source" | "native", release?: string) =>
    spawnSync(
      process.execPath,
      [
        ...base,
        "--mode",
        mode,
        ...(release === undefined
          ? []
          : ["--native-release-file", release]),
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: AUTHORITY_CHILD_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  const failureOutput = (
    result: ReturnType<typeof spawnSync>,
  ): string =>
    [
      result.stdout,
      result.stderr,
      result.error?.message,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n");

  const missing = run("native");
  expect(missing.status).not.toBe(0);
  expect(failureOutput(missing)).toContain(
    "--native-release-file is required when --mode is native",
  );

  const sourceOnly = run("source", path.join(root, "release"));
  expect(sourceOnly.status).not.toBe(0);
  expect(failureOutput(sourceOnly)).toContain(
    "--native-release-file is forbidden when --mode is source",
  );

  const relative = run("native", "relative-release");
  expect(relative.status).not.toBe(0);
  expect(failureOutput(relative)).toContain(
    "--native-release-file must be an absolute path",
  );

  const escaped = run(
    "native",
    path.join(path.dirname(root), "escaped-release"),
  );
  expect(escaped.status).not.toBe(0);
  expect(failureOutput(escaped)).toContain(
    "--native-release-file must remain under the authorized temporary root",
  );

  const linkedRelease = path.join(root, "linked-release");
  const outsideTarget = path.join(root, "outside-target");
  fs.writeFileSync(outsideTarget, "outside\n", "utf8");
  try {
    fs.symlinkSync(outsideTarget, linkedRelease, "file");
  } catch {
    const outsideDirectory = path.join(root, "outside-directory");
    fs.mkdirSync(outsideDirectory);
    fs.symlinkSync(outsideDirectory, linkedRelease, "junction");
  }
  const linked = run("native", linkedRelease);
  expect(linked.status).not.toBe(0);
  expect(failureOutput(linked)).toContain(
    "--native-release-file must not be a symbolic link",
  );
});

test("published PID proof observes but never signals a file-derived live process", {
  timeout:
    PROCESS_WATCHDOG_GRACE_MS +
    DEFAULT_WAIT_TIMEOUT_MS +
    TEST_ASSERTION_GRACE_MS,
}, async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-auth-pid-proof-"),
  );
  temporaryRoots.push(root);
  const ownedSentinel = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  try {
    expect(ownedSentinel.pid).toBeDefined();
    fs.writeFileSync(
      path.join(root, "fake-ready.json"),
      `${JSON.stringify({ pid: ownedSentinel.pid })}\n`,
      "utf8",
    );
    const proof = provePublishedServerStopped(root, 1);
    expect(proof).toContain(
      "no signal was sent to the file-derived PID",
    );
    expect(ownedSentinel.exitCode).toBeNull();
    expect(ownedSentinel.signalCode).toBeNull();
  } finally {
    if (
      ownedSentinel.exitCode === null &&
      ownedSentinel.signalCode === null
    ) {
      ownedSentinel.kill();
    }
    await waitFor(
      () =>
        ownedSentinel.exitCode !== null ||
        ownedSentinel.signalCode !== null,
      "owned PID-proof sentinel cleanup",
    );
  }
});

test("fake Sana server publishes typed failure after its independent owner exits naturally", {
  timeout:
    2_000 +
    DEFAULT_WAIT_TIMEOUT_MS +
    DEFAULT_WAIT_TIMEOUT_MS +
    NATIVE_HELPER_LIFETIME_MS +
    PROCESS_WATCHDOG_GRACE_MS +
    TEST_ASSERTION_GRACE_MS,
}, async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-auth-owner-watchdog-"),
  );
  temporaryRoots.push(root);
  const ownerReadyFile = path.join(root, "owner-ready");
  const ownerReleaseFile = path.join(root, "owner-release");
  const readyFile = path.join(root, "fake-ready.json");
  const stateFile = path.join(root, "fake-state.json");
  const helperFile = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "fake-sana-server.ts",
  );
  const fixtureFile = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "user-me-workspace-null.json",
  );
  const ownerSource = String.raw`
    const fs = await import("node:fs");
    const readyFile = process.env.AUTH_OWNER_READY_FILE;
    const releaseFile = process.env.AUTH_OWNER_RELEASE_FILE;
    if (!readyFile || !releaseFile) {
      throw new Error("owner sentinel environment is incomplete");
    }
    fs.writeFileSync(readyFile, "ready\n", "utf8");
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(releaseFile)) {
      if (Date.now() >= deadline) {
        throw new Error("owner sentinel release was not published");
      }
      await Bun.sleep(10);
    }
  `;
  const owner = spawn(process.execPath, ["-e", ownerSource], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_OWNER_READY_FILE: ownerReadyFile,
      AUTH_OWNER_RELEASE_FILE: ownerReleaseFile,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let ownerStderr = "";
  owner.stderr.setEncoding("utf8");
  owner.stderr.on("data", (chunk) => {
    ownerStderr += chunk;
  });
  let helper: ReturnType<typeof spawn> | undefined;
  let helperStderr = "";
  try {
    await waitFor(
      () => fs.existsSync(ownerReadyFile) || owner.exitCode !== null,
      "owner sentinel readiness",
    );
    expect(owner.exitCode, ownerStderr).toBeNull();
    expect(owner.pid).toBeDefined();

    helper = spawn(
      process.execPath,
      [
        helperFile,
        "--mode",
        "source",
        "--scenario",
        "happy",
        "--ready-file",
        readyFile,
        "--state-file",
        stateFile,
        "--fixture",
        fixtureFile,
        "--parent-pid",
        String(owner.pid),
        "--lifetime-ms",
        String(NATIVE_HELPER_LIFETIME_MS),
      ],
      {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      helperStderr += chunk;
    });
    await waitFor(
      () => fs.existsSync(readyFile) || helper!.exitCode !== null,
      "owner-watchdog helper readiness",
    );
    expect(helper.exitCode, helperStderr).toBeNull();

    fs.writeFileSync(ownerReleaseFile, "release\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await waitFor(
      () => owner.exitCode !== null || owner.signalCode !== null,
      "natural owner sentinel exit",
    );
    expect(owner.signalCode, ownerStderr).toBeNull();
    expect(owner.exitCode, ownerStderr).toBe(0);

    await waitFor(
      () =>
        fs.existsSync(stateFile) &&
        (helper!.exitCode !== null || helper!.signalCode !== null),
      "typed owner-death helper failure and exit",
    );
    const state = JSON.parse(
      fs.readFileSync(stateFile, "utf8"),
    ) as {
      kind: unknown;
      mode: unknown;
      scenario: unknown;
      requests: unknown;
      error: unknown;
    };
    expect(state).toEqual({
      kind: "failed",
      mode: "source",
      scenario: "happy",
      requests: [],
      error: `owning parent process ${owner.pid} is no longer alive`,
    });
    expect(helper.signalCode, helperStderr).toBeNull();
    expect(helper.exitCode, helperStderr).toBe(0);
    expect(
      provePublishedServerStopped(
        root,
        NATIVE_HELPER_LIFETIME_MS,
      ),
    ).toBeUndefined();
  } finally {
    if (
      helper !== undefined &&
      helper.exitCode === null &&
      helper.signalCode === null
    ) {
      helper.kill();
    }
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill();
    }
    if (helper !== undefined) {
      await waitFor(
        () =>
          helper!.exitCode !== null ||
          helper!.signalCode !== null,
        "owned owner-watchdog helper cleanup",
      );
    }
    await waitFor(
      () => owner.exitCode !== null || owner.signalCode !== null,
      "owned owner sentinel cleanup",
    );
  }
});

test("fake Sana server enforces its absolute lifetime", {
  timeout:
    2_000 +
    100 +
    PROCESS_WATCHDOG_GRACE_MS +
    TEST_ASSERTION_GRACE_MS,
}, () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-auth-watchdog-"),
  );
  temporaryRoots.push(root);
  const readyFile = path.join(root, "fake-ready.json");
  const stateFile = path.join(root, "fake-state.json");
  const helper = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "fake-sana-server.ts",
  );
  const fixture = path.join(
    ROOT,
    "tests",
    "fixtures",
    "sana",
    "user-me-workspace-null.json",
  );
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "--mode",
      "source",
      "--scenario",
      "happy",
      "--ready-file",
      readyFile,
      "--state-file",
      stateFile,
      "--fixture",
      fixture,
      "--parent-pid",
      String(process.pid),
      "--lifetime-ms",
      "100",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    },
  );
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(provePublishedServerStopped(root, 100)).toBeUndefined();
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    kind: string;
    error: string;
  };
  expect(state.kind).toBe("failed");
  expect(state.error).toContain("exceeded its 100ms lifetime");
});
