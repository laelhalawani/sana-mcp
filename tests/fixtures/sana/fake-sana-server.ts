import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type ServerMode = "source" | "native" | "daemon-restart";
type ServerScenario =
  | "happy"
  | "workspace-unavailable"
  | "email-mismatch";

interface ObservedFixture {
  response: {
    result: {
      data: {
        user: {
          id: string;
          email: string;
          displayName?: string;
          lastUsedWorkspaceId?: string;
        };
        workspace: null;
      };
    };
  };
}

interface RequestObservation {
  readonly index: number;
  readonly method: string;
  readonly pathname: string;
}

function requiredArgument(name: string): string {
  const indexes = process.argv.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  if (indexes.length !== 1) {
    throw new Error(`${name} must be provided exactly once`);
  }
  const index = indexes[0]!;
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (
    value === undefined ||
    value.startsWith("--") ||
    value.trim() === ""
  ) {
    throw new Error(`${name} requires a nonblank value`);
  }
  return value;
}

function optionalArgument(name: string): string | undefined {
  const indexes = process.argv.flatMap((value, index) =>
    value === name ? [index] : [],
  );
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1) {
    throw new Error(`${name} must not be provided more than once`);
  }
  const value = process.argv[indexes[0]! + 1];
  if (
    value === undefined ||
    value.startsWith("--") ||
    value.trim() === ""
  ) {
    throw new Error(`${name} requires a nonblank value`);
  }
  return value;
}

function exactChoice<Value extends string>(
  name: string,
  choices: readonly Value[],
): Value {
  const value = requiredArgument(name);
  if (!choices.includes(value as Value)) {
    throw new Error(`${name} must be one of ${choices.join(", ")}`);
  }
  return value as Value;
}

function positiveIntegerArgument(
  name: string,
  maximum: number,
): number {
  const value = requiredArgument(name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return parsed;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function jsonResponse(
  value: unknown,
  options: ResponseInit = {},
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...options, headers });
}

function assertHeader(
  request: Request,
  name: string,
  expected: string,
): void {
  const observed = request.headers.get(name) ?? "";
  if (observed !== expected) {
    throw new Error(
      `${name} header mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(observed)}`,
    );
  }
}

function assertJsonKeys(
  value: unknown,
  expected: Record<string, unknown>,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `JSON body mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}`,
    );
  }
}

const mode = exactChoice<ServerMode>("--mode", [
  "source",
  "native",
  "daemon-restart",
]);
const scenario = exactChoice<ServerScenario>("--scenario", [
  "happy",
  "workspace-unavailable",
  "email-mismatch",
]);
const readyFile = path.resolve(requiredArgument("--ready-file"));
const stateFile = path.resolve(requiredArgument("--state-file"));
const fixtureFile = path.resolve(requiredArgument("--fixture"));
const configuredNativeReleaseFile = optionalArgument(
  "--native-release-file",
);
const configuredFinalResponseReleaseFile = optionalArgument(
  "--final-response-release-file",
);
const parentPid = positiveIntegerArgument(
  "--parent-pid",
  Number.MAX_SAFE_INTEGER,
);
const lifetimeMs = positiveIntegerArgument("--lifetime-ms", 60_000);

function authorizeControlFile(
  optionName: string,
  configuredFile: string,
): string {
  if (!path.isAbsolute(configuredFile)) {
    throw new Error(`${optionName} must be an absolute path`);
  }

  const readyRoot = path.dirname(readyFile);
  const stateRoot = path.dirname(stateFile);
  if (readyRoot !== stateRoot) {
    throw new Error(
      "ready and state files must share one authorized temporary root",
    );
  }
  const rootStat = lstatSync(readyRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      "the authorized temporary root must be an ordinary directory",
    );
  }
  const authorizedRoot = realpathSync.native(readyRoot);
  const releaseFile = path.resolve(configuredFile);
  const releaseParent = path.dirname(releaseFile);
  const relative = path.relative(readyRoot, releaseFile);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `${optionName} must remain under the authorized temporary root`,
    );
  }
  const parentStat = lstatSync(releaseParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      `${optionName} parent must be an ordinary directory`,
    );
  }
  const authorizedReleaseParent = realpathSync.native(releaseParent);
  if (authorizedReleaseParent !== authorizedRoot) {
    throw new Error(
      `${optionName} parent must be the authorized temporary root`,
    );
  }
  const canonicalReleaseFile = path.join(
    authorizedReleaseParent,
    path.basename(releaseFile),
  );
  try {
    const existing = lstatSync(canonicalReleaseFile);
    if (existing.isSymbolicLink()) {
      throw new Error(
        `${optionName} must not be a symbolic link`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return canonicalReleaseFile;
    }
    throw error;
  }
  throw new Error(
    `${optionName} must not exist before its response gate`,
  );
}

function requireNativeReleaseFile(): string | undefined {
  if (mode === "source") {
    if (configuredNativeReleaseFile !== undefined) {
      throw new Error(
        `--native-release-file is forbidden when --mode is ${mode}`,
      );
    }
    return undefined;
  }
  if (configuredNativeReleaseFile === undefined) {
    throw new Error(
      `--native-release-file is required when --mode is ${mode}`,
    );
  }
  return authorizeControlFile(
    "--native-release-file",
    configuredNativeReleaseFile,
  );
}

const nativeReleaseFile = requireNativeReleaseFile();
const finalResponseReleaseFile =
  configuredFinalResponseReleaseFile === undefined
    ? undefined
    : authorizeControlFile(
        "--final-response-release-file",
        configuredFinalResponseReleaseFile,
      );
if (
  nativeReleaseFile !== undefined &&
  finalResponseReleaseFile === nativeReleaseFile
) {
  throw new Error(
    "native and final-response release files must be distinct",
  );
}
const fixture = JSON.parse(
  readFileSync(fixtureFile, "utf8"),
) as ObservedFixture;
const baseResponse = structuredClone(fixture.response);
const syntheticEmail = "synthetic@example.test";
const syntheticWorkspace = "synthetic-workspace";
const csrfToken = "synthetic-csrf-token";
const requestCookie = "sana-ai-session=request-session";
const freshCookie = "sana-ai-session=fresh-session";
const expectedCount =
  mode === "source" ? 4 : mode === "native" ? 6 : 2;
const configuredPort = optionalArgument("--port");
const serverPort = configuredPort === undefined ? 0 : Number(configuredPort);
if (
  !Number.isSafeInteger(serverPort) ||
  serverPort < 0 ||
  serverPort > 65_535
) {
  throw new Error("--port must be an integer between 0 and 65535");
}
const observations: RequestObservation[] = [];
let requestIndex = 0;
let restartAwaitingList = false;
let terminal = false;
const lifetimeDeadline = Date.now() + lifetimeMs;

function loginMeResponse(): ObservedFixture["response"] {
  const response = structuredClone(baseResponse);
  if (scenario === "workspace-unavailable") {
    delete response.result.data.user.lastUsedWorkspaceId;
  } else if (scenario === "email-mismatch") {
    response.result.data.user.email = "other@example.test";
  }
  return response;
}

function daemonMeResponse(): unknown {
  const response = structuredClone(baseResponse);
  response.result.data.workspace = {
    id: syntheticWorkspace,
  } as never;
  return response;
}

let server: ReturnType<typeof Bun.serve>;
let watchdog: ReturnType<typeof setInterval> | undefined;
let completionMonitor: ReturnType<typeof setInterval> | undefined;
let completionRequested = false;
let gracefulStopStarted = false;

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

function clearTerminalMonitors(): void {
  if (completionMonitor !== undefined) {
    clearInterval(completionMonitor);
    completionMonitor = undefined;
  }
  if (watchdog !== undefined) {
    clearInterval(watchdog);
    watchdog = undefined;
  }
}

function publishTerminalState(
  kind: "complete" | "failed",
  error?: unknown,
): void {
  clearTerminalMonitors();
  writeJsonAtomic(stateFile, {
    kind,
    mode,
    scenario,
    requests: observations,
    ...(error === undefined
      ? {}
      : {
          error: error instanceof Error ? error.message : String(error),
        }),
  });
}

function failTerminal(error: unknown): void {
  if (terminal) return;
  terminal = true;
  publishTerminalState("failed", error);
  void server.stop(true).catch(() => {
    // The durable failure state retains primary authority. Process cleanup is
    // independently bounded and verified by the owning test harness.
  });
}

async function completeAfterGracefulStop(): Promise<void> {
  if (terminal || gracefulStopStarted) return;
  gracefulStopStarted = true;
  if (completionMonitor !== undefined) {
    clearInterval(completionMonitor);
    completionMonitor = undefined;
  }
  try {
    await server.stop(false);
  } catch (error) {
    failTerminal(
      new Error("fake Sana server graceful completion failed", {
        cause: error,
      }),
    );
    return;
  }
  if (terminal) return;
  terminal = true;
  publishTerminalState("complete");
}

function publishDaemonBlocked(): void {
  writeJsonAtomic(stateFile, {
    kind: "daemon-blocked",
    mode,
    scenario,
    requests: observations,
  });
}

function publishRestartRunning(): void {
  writeJsonAtomic(stateFile, {
    kind: "restart-running",
    mode,
    scenario,
    requests: observations,
  });
}

async function awaitReleaseFile(
  releaseFile: string,
  description: string,
): Promise<void> {
  for (;;) {
    if (terminal) {
      throw new Error(
        `${description} terminated before authorization`,
      );
    }
    try {
      const stat = lstatSync(releaseFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(
          `the ${description} marker is not an ordinary file`,
        );
      }
      if (
        realpathSync.native(path.dirname(releaseFile)) !==
        realpathSync.native(path.dirname(stateFile))
      ) {
        throw new Error(
          `the ${description} marker escaped its authorized root`,
        );
      }
      if (readFileSync(releaseFile, "utf8") !== "release\n") {
        throw new Error(
          `the ${description} marker has invalid contents`,
        );
      }
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        await Bun.sleep(10);
        continue;
      }
      throw error;
    }
  }
}

function requestCompletionAfterResponse(): void {
  if (terminal || completionRequested) {
    throw new Error("fake Sana server completion was requested twice");
  }
  completionRequested = true;
  completionMonitor = setInterval(() => {
    if (terminal || server.pendingRequests !== 0) return;
    void completeAfterGracefulStop();
  }, 1);
}

function finalJsonResponse(value: unknown): Response {
  if (finalResponseReleaseFile === undefined) {
    return jsonResponse(value);
  }
  const body = JSON.stringify(value);
  const split = Math.max(1, Math.floor(body.length / 2));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, split)));
      void (async () => {
        await awaitReleaseFile(
          finalResponseReleaseFile,
          "final response release",
        );
        controller.enqueue(encoder.encode(body.slice(split)));
        controller.close();
      })().catch((error) => {
        controller.error(error);
        failTerminal(error);
      });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/json" },
  });
}

server = Bun.serve({
  hostname: "127.0.0.1",
  port: serverPort,
  development: false,
  async fetch(request): Promise<Response> {
    if (terminal) {
      return new Response("fake Sana server already completed", {
        status: 409,
      });
    }
    if (completionRequested) {
      const error = new Error(
        "unexpected request arrived while the final response was draining",
      );
      failTerminal(error);
      return jsonResponse({ error: error.message }, { status: 409 });
    }
    const url = new URL(request.url);
    const currentIndex = requestIndex++;
    observations.push({
      index: currentIndex,
      method: request.method,
      pathname: url.pathname,
    });
    try {
      assertHeader(request, "host", `127.0.0.1:${server.port}`);
      if (mode === "daemon-restart") {
        if (url.pathname === "/x-api/trpc/user.me") {
          if (
            request.method !== "GET" ||
            url.search !== ""
          ) {
            throw new Error(
              "restart request was not the exact daemon user.me query",
            );
          }
          assertHeader(request, "accept", "application/json");
          assertHeader(request, "cookie", freshCookie);
          assertHeader(
            request,
            "sana-ai-workspace-id",
            syntheticWorkspace,
          );
          restartAwaitingList = true;
          publishRestartRunning();
          if (nativeReleaseFile === undefined) {
            throw new Error(
              "restart daemon release authority is unavailable",
            );
          }
          await awaitReleaseFile(
            nativeReleaseFile,
            "restart daemon release",
          );
          return jsonResponse(daemonMeResponse());
        }
        if (url.pathname === "/x-api/trpc/asset.listRecent") {
          if (
            !restartAwaitingList ||
            request.method !== "GET" ||
            url.searchParams.size !== 1
          ) {
            throw new Error(
              "restart request was not the exact daemon meeting-list query",
            );
          }
          assertHeader(request, "accept", "application/json");
          assertHeader(request, "cookie", freshCookie);
          assertHeader(
            request,
            "sana-ai-workspace-id",
            syntheticWorkspace,
          );
          const input = JSON.parse(
            url.searchParams.get("input") ?? "null",
          );
          assertJsonKeys(input, {
            assetSourceTypes: ["sana-ai:meeting"],
            direction: "forward",
          });
          restartAwaitingList = false;
          publishRestartRunning();
          return jsonResponse({
            result: {
              data: {
                assets: [],
                nextCursor: null,
              },
            },
          });
        }
        throw new Error(
          `unexpected restart request ${currentIndex}: ${request.method} ${url.pathname}`,
        );
      }
      if (currentIndex === 0) {
        if (
          request.method !== "GET" ||
          url.pathname !== "/x-api/auth/csrf-token" ||
          url.search !== ""
        ) {
          throw new Error("request 0 was not the exact CSRF request");
        }
        assertHeader(request, "accept", "application/json");
        return jsonResponse(
          { csrfToken },
          {
            headers: {
              "set-cookie":
                "sana-ai-session=request-session; Path=/; HttpOnly",
            },
          },
        );
      }
      if (currentIndex === 1) {
        if (
          request.method !== "POST" ||
          url.pathname !== "/x-api/trpc/user.sendSignInLink" ||
          url.search !== ""
        ) {
          throw new Error(
            "request 1 was not the exact sign-in-link mutation",
          );
        }
        assertHeader(request, "accept", "application/json");
        assertHeader(request, "content-type", "application/json");
        assertHeader(request, "cookie", requestCookie);
        assertHeader(request, "sana-ai-workspace-id", "");
        assertJsonKeys(await request.json(), { email: syntheticEmail });
        return jsonResponse({
          result: { data: { accepted: true } },
        });
      }
      if (currentIndex === 2) {
        if (
          request.method !== "GET" ||
          url.pathname !== "/x-api/auth/magic-link" ||
          url.searchParams.size !== 3 ||
          url.searchParams.get("email") !== syntheticEmail ||
          url.searchParams.get("csrfToken") !== csrfToken ||
          url.searchParams.get("code") !== "123456"
        ) {
          throw new Error(
            "request 2 was not the exact magic-link challenge",
          );
        }
        assertHeader(request, "accept", "text/html,application/json");
        assertHeader(request, "cookie", "");
        assertHeader(request, "sana-ai-workspace-id", "");
        return new Response("authenticated", {
          status: 200,
          headers: {
            "set-cookie":
              "sana-ai-session=fresh-session; Path=/; HttpOnly",
          },
        });
      }
      if (currentIndex === 3) {
        if (
          request.method !== "GET" ||
          url.pathname !== "/x-api/trpc/user.me" ||
          url.search !== ""
        ) {
          throw new Error(
            "request 3 was not the exact post-login user.me query",
          );
        }
        assertHeader(request, "accept", "application/json");
        assertHeader(request, "cookie", freshCookie);
        assertHeader(request, "sana-ai-workspace-id", "");
        const response =
          mode === "source"
            ? finalJsonResponse(loginMeResponse())
            : jsonResponse(loginMeResponse());
        if (mode === "source") requestCompletionAfterResponse();
        return response;
      }
      if (currentIndex === 4 && mode === "native") {
        if (
          request.method !== "GET" ||
          url.pathname !== "/x-api/trpc/user.me" ||
          url.search !== ""
        ) {
          throw new Error(
            "request 4 was not the exact daemon user.me query",
          );
        }
        assertHeader(request, "accept", "application/json");
        assertHeader(request, "cookie", freshCookie);
        assertHeader(
          request,
          "sana-ai-workspace-id",
          syntheticWorkspace,
        );
        publishDaemonBlocked();
        if (nativeReleaseFile === undefined) {
          throw new Error("native daemon release authority is unavailable");
        }
        await awaitReleaseFile(
          nativeReleaseFile,
          "native daemon release",
        );
        return jsonResponse(daemonMeResponse());
      }
      if (currentIndex === 5 && mode === "native") {
        if (
          request.method !== "GET" ||
          url.pathname !== "/x-api/trpc/asset.listRecent" ||
          url.searchParams.size !== 1
        ) {
          throw new Error(
            "request 5 was not the exact daemon meeting-list query",
          );
        }
        assertHeader(request, "accept", "application/json");
        assertHeader(request, "cookie", freshCookie);
        assertHeader(
          request,
          "sana-ai-workspace-id",
          syntheticWorkspace,
        );
        const input = JSON.parse(url.searchParams.get("input") ?? "null");
        assertJsonKeys(input, {
          assetSourceTypes: ["sana-ai:meeting"],
          direction: "forward",
        });
        const response = finalJsonResponse({
          result: {
            data: {
              assets: [],
              nextCursor: null,
            },
          },
        });
        requestCompletionAfterResponse();
        return response;
      }
      throw new Error(
        `unexpected request ${currentIndex}; expected ${expectedCount} requests`,
      );
    } catch (error) {
      failTerminal(error);
      return jsonResponse(
        {
          error:
            error instanceof Error ? error.message : String(error),
        },
        { status: 409 },
      );
    }
  },
});

writeJsonAtomic(readyFile, {
  origin: `http://127.0.0.1:${server.port}`,
  pid: process.pid,
  parentPid,
  mode,
  scenario,
});

watchdog = setInterval(() => {
  if (!processAlive(parentPid)) {
    failTerminal(
      new Error(`owning parent process ${parentPid} is no longer alive`),
    );
    return;
  }
  if (Date.now() >= lifetimeDeadline) {
    failTerminal(
      new Error(`fake Sana server exceeded its ${lifetimeMs}ms lifetime`),
    );
  }
}, 50);
