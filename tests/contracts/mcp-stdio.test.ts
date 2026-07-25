import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStandaloneBuildConfig,
} from "../../src/runtime/build-info.js";
import {
  releaseTargetForRuntime,
  type ReleaseTarget,
} from "../../src/release/contract.js";
import { renderStatusInfo } from "../../src/tools/dispatch.js";
import packageInfo from "../../package.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NETWORK_PRELOAD = fileURLToPath(
  new URL("../fixtures/contracts/block-network.ts", import.meta.url)
);
const SEED_STORE = fileURLToPath(new URL("../fixtures/contracts/seed-store.ts", import.meta.url));
const DISPATCH_CALL = fileURLToPath(
  new URL("../fixtures/contracts/dispatch-call.ts", import.meta.url)
);
const SEMANTIC_RUNTIME_FAILURE = fileURLToPath(
  new URL("../fixtures/contracts/semantic-runtime-failure.ts", import.meta.url)
);
const AUTH_PUBLICATION_PROBE = fileURLToPath(
  new URL("../fixtures/contracts/auth-publication-probe.ts", import.meta.url)
);
const AUTH_CACHE_PROBE = fileURLToPath(
  new URL("../fixtures/contracts/auth-cache-probe.ts", import.meta.url)
);
const BUILD_ENTRYPOINT = fileURLToPath(
  new URL("../fixtures/contracts/build-entrypoint.ts", import.meta.url)
);
const GUARD_PROBE = fileURLToPath(new URL("../fixtures/contracts/guard-probe.ts", import.meta.url));
const SET_SYNC_PROGRESS = fileURLToPath(
  new URL("../fixtures/contracts/set-sync-progress.ts", import.meta.url)
);
const SET_IDLE_LISTING = fileURLToPath(
  new URL("../fixtures/contracts/set-idle-listing.ts", import.meta.url)
);
const FIXED_NOW_MS = Date.parse("2026-01-03T12:05:00Z");
const temporaryRoots: string[] = [];
const liveDataAliasRoots = new Set<string>();
const PROCESS_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const BUILD_PHASE_BUDGET_MS = 30_000;
const OUTER_WATCHDOG_MARGIN_MS = 5_000;
const PROCESS_CHILD_BUDGET_MS = PROCESS_TIMEOUT_MS + CLEANUP_TIMEOUT_MS;
const BUILD_CHILD_BUDGET_MS =
  BUILD_PHASE_BUDGET_MS + CLEANUP_TIMEOUT_MS;
// The MCP child can consume initialize, EOF/exit, normal drain, termination,
// and post-termination drain budgets in series before its helper settles.
const MCP_CHILD_BUDGET_MS =
  PROCESS_TIMEOUT_MS * 2 + CLEANUP_TIMEOUT_MS * 3;

function outerTestBudget(
  processes: number,
  mcpExchanges = 0,
  builds = 0,
): number {
  return (
    processes * PROCESS_CHILD_BUDGET_MS +
    mcpExchanges * MCP_CHILD_BUDGET_MS +
    builds * BUILD_CHILD_BUDGET_MS +
    OUTER_WATCHDOG_MARGIN_MS
  );
}
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SERVER_NAME = "sana-mcp";
if (packageInfo.name !== MCP_SERVER_NAME) {
  throw new Error(
    `package name ${JSON.stringify(packageInfo.name)} does not match the MCP server contract`,
  );
}
const MCP_SERVER_VERSION = packageInfo.version;
if (
  typeof MCP_SERVER_VERSION !== "string" ||
  MCP_SERVER_VERSION.length === 0
) {
  throw new Error("package version must provide the MCP server version");
}

interface ToolCall {
  id: number;
  tool: string;
  args?: Record<string, unknown>;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface McpResult extends ProcessResult {
  messages: Array<Record<string, unknown>>;
}

type SemanticFailure = "unavailable" | "error" | "non-error";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), "utf8").replace(
    /\r?\n$/,
    ""
  );
}

function copyHostVariable(target: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (value !== undefined) target[key] = value;
}

function isolatedEnvironment(
  dataDir: string,
  semanticRequested = false,
  semanticFailure?: SemanticFailure,
  extra?: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const isolatedHome = path.join(dataDir, "home");
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(dataDir, "xdg-config"),
    XDG_DATA_HOME: path.join(dataDir, "xdg-data"),
    XDG_CACHE_HOME: path.join(dataDir, "xdg-cache"),
    APPDATA: path.join(dataDir, "appdata"),
    LOCALAPPDATA: path.join(dataDir, "localappdata"),
    TMP: path.join(dataDir, "tmp"),
    TEMP: path.join(dataDir, "tmp"),
    TMPDIR: path.join(dataDir, "tmp"),
    PATH: path.dirname(process.execPath),
    SANA_DATA_DIR: dataDir,
    SANA_BASE_URL: "https://sana.ai",
    SANA_TRANSCRIPTS_DIR: path.join(dataDir, "transcripts"),
    SANA_SEMANTIC: semanticRequested ? "1" : "0",
    SANA_TEST_FORBIDDEN_DATA_DIR: path.join(ROOT, "data"),
    SANA_TEST_DAEMON_PID: String(process.pid),
    SANA_TEST_FIXED_NOW_MS: String(FIXED_NOW_MS),
    NO_COLOR: "1",
    TERM: "dumb",
    TZ: "UTC",
  };
  if (semanticFailure !== undefined) {
    env.SANA_TEST_SEMANTIC_FAILURE = semanticFailure;
  }
  if (liveDataAliasRoots.has(dataDir)) {
    env.SANA_TEST_LIVE_DATA_ALIAS = path.join(dataDir, "live-data-alias");
  }
  for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR"]) copyHostVariable(env, key);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key !== "SANA_TEST_AUTH_SCENARIO") {
        throw new Error(`unsupported isolated contract environment key: ${key}`);
      }
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

function createDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sana-mcp-contract-"));
  temporaryRoots.push(dir);
  for (const child of [
    "appdata",
    "home",
    "localappdata",
    "tmp",
    "xdg-cache",
    "xdg-config",
    "xdg-data",
  ]) {
    mkdirSync(path.join(dir, child));
  }
  return dir;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateAndThrow(
  primary: unknown,
  label: string,
  terminate: () => void,
  closed: Promise<unknown>,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    terminate();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await withTimeout(
      closed,
      CLEANUP_TIMEOUT_MS,
      `${label} did not close after termination`,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primary, ...cleanupErrors],
      `${label} failed and cleanup was incomplete`,
    );
  }
  throw primary;
}

async function runProcess(
  args: string[],
  dataDir: string,
  stdin?: string,
  semanticRequested = false,
  semanticFailure?: SemanticFailure,
  extraEnvironment?: Readonly<NodeJS.ProcessEnv>,
  operationTimeoutMs = PROCESS_TIMEOUT_MS,
): Promise<ProcessResult> {
  const child = spawn(process.execPath, ["--preload", NETWORK_PRELOAD, ...args], {
    cwd: ROOT,
    env: isolatedEnvironment(
      dataDir,
      semanticRequested,
      semanticFailure,
      extraEnvironment,
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.stdin.end(stdin);

  const closed = new Promise<ProcessResult>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  const failed = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
  });
  try {
    return await withTimeout(
      Promise.race([closed, failed]),
      operationTimeoutMs,
      `timed out waiting for ${args.join(" ")}`,
    );
  } catch (error) {
    return await terminateAndThrow(
      error,
      "contract child process",
      () => {
        child.kill("SIGKILL");
      },
      closed,
    );
  }
}

function linuxLibcFromRuntimeReport(): "glibc" | "musl" {
  const runtimeReport = process.report?.getReport();
  if (!runtimeReport || typeof runtimeReport !== "object") {
    throw new Error("contract test cannot identify Linux libc: runtime report is unavailable");
  }
  const header =
    "header" in runtimeReport &&
      runtimeReport.header &&
      typeof runtimeReport.header === "object"
      ? runtimeReport.header
      : undefined;
  if (!header) {
    throw new Error("contract test cannot identify Linux libc: runtime report header is absent");
  }
  if ("glibcVersionRuntime" in header) {
    const glibcVersion = header.glibcVersionRuntime;
    if (
      typeof glibcVersion !== "string" ||
      !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}$/.test(glibcVersion)
    ) {
      throw new Error(
        "contract test cannot identify Linux libc: glibcVersionRuntime is invalid"
      );
    }
    return "glibc";
  }
  const sharedObjects =
    "sharedObjects" in runtimeReport && Array.isArray(runtimeReport.sharedObjects)
      ? runtimeReport.sharedObjects
      : undefined;
  if (
    sharedObjects?.some(
      (library): library is string =>
        typeof library === "string" &&
        /(?:^|[/\\])(?:ld-musl-[^/\\]+|libc\.musl-[^/\\]+)\.so\.1$/.test(library)
    )
  ) {
    return "musl";
  }
  throw new Error(
    "contract test cannot identify Linux libc: no validated glibc or musl evidence"
  );
}

function standaloneTargetForRuntime(
  platform: NodeJS.Platform,
  architecture: string,
  linuxLibc?: "glibc" | "musl",
): ReleaseTarget {
  if (
    platform === "linux" &&
    (architecture === "x64" || architecture === "arm64")
  ) {
    if (linuxLibc === undefined) {
      throw new Error("contract test requires validated libc for a Linux target");
    }
    return releaseTargetForRuntime({
      platform: "linux",
      architecture,
      libc: linuxLibc,
    });
  }
  if (platform === "darwin" && architecture === "x64") {
    return releaseTargetForRuntime({
      platform: "darwin",
      architecture: "x64",
      libc: null,
    });
  }
  if (platform === "darwin" && architecture === "arm64") {
    return releaseTargetForRuntime({
      platform: "darwin",
      architecture: "arm64",
      libc: null,
    });
  }
  if (platform === "win32" && architecture === "x64") {
    return releaseTargetForRuntime({
      platform: "win32",
      architecture: "x64",
      libc: null,
    });
  }
  throw new Error(
    `contract test has no canonical standalone target for ${platform}/${architecture}`,
  );
}

function currentStandaloneTarget(): ReleaseTarget {
  return standaloneTargetForRuntime(
    process.platform,
    process.arch,
    process.platform === "linux" ? linuxLibcFromRuntimeReport() : undefined,
  );
}

async function writeDispatcherBundle(
  dataDir: string,
  filename: string,
  options: {
    define?: Record<string, string>;
    external?: string[];
    semanticModule?: string;
  }
): Promise<string> {
  const outfile = path.join(dataDir, filename);
  const result = await runProcess(
    [
      BUILD_ENTRYPOINT,
      JSON.stringify({
        mode: "semantic",
        entrypoint: DISPATCH_CALL,
        outfile,
        external: options.external ?? [],
        define: options.define,
        semanticModule: options.semanticModule,
      }),
    ],
    dataDir,
    undefined,
    false,
    undefined,
    undefined,
    BUILD_PHASE_BUDGET_MS,
  );
  if (result.code !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(
      `could not build isolated contract dispatcher: ${JSON.stringify(result)}`,
    );
  }
  return outfile;
}

async function buildStandaloneDispatcher(dataDir: string): Promise<string> {
  const production = createStandaloneBuildConfig(currentStandaloneTarget());
  return await writeDispatcherBundle(dataDir, "standalone-dispatch.js", {
    external: [...(production.external ?? [])],
    define: production.define,
  });
}

async function buildSourceFailureDispatcher(dataDir: string): Promise<string> {
  return await writeDispatcherBundle(dataDir, "source-failure-dispatch.js", {
    semanticModule: SEMANTIC_RUNTIME_FAILURE,
  });
}

async function buildAuthContractEntrypoint(
  dataDir: string,
  entrypoint: string,
  filename: string,
): Promise<string> {
  const outfile = path.join(dataDir, filename);
  const result = await runProcess(
    [
      BUILD_ENTRYPOINT,
      JSON.stringify({
        mode: "auth",
        entrypoint,
        outfile,
        external: ["@huggingface/transformers", "sqlite-vec"],
      }),
    ],
    dataDir,
    undefined,
    false,
    undefined,
    undefined,
    BUILD_PHASE_BUDGET_MS,
  );
  if (result.code !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(
      `could not build isolated auth contract entrypoint: ${JSON.stringify(result)}`,
    );
  }
  return outfile;
}

async function seedStore(dataDir: string): Promise<void> {
  const seeded = await runProcess([SEED_STORE], dataDir);
  expect(seeded).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });
}

function parseJsonRpcLine(line: string): Record<string, unknown> {
  if (line.length === 0 || line.trim().length === 0) {
    throw new Error("empty JSON-RPC stdout frame");
  }
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error(`non-JSON-RPC stdout frame: ${line}`);
  const isResponse =
    Object.hasOwn(message, "id") &&
    !Object.hasOwn(message, "method") &&
    (Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"));
  const isNotification =
    typeof message.method === "string" &&
    !Object.hasOwn(message, "id") &&
    !Object.hasOwn(message, "result") &&
    !Object.hasOwn(message, "error");
  if (!isResponse && !isNotification) throw new Error(`invalid JSON-RPC stdout frame: ${line}`);
  return message;
}

function consumeJsonRpcChunk(
  buffer: string,
  text: string,
  onMessage: (message: Record<string, unknown>) => void,
): string {
  const lines = `${buffer}${text}`.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) onMessage(parseJsonRpcLine(line));
  return remainder;
}

function finishJsonRpcStream(buffer: string): void {
  if (buffer !== "") {
    throw new Error("unterminated or trailing JSON-RPC stdout frame");
  }
}

function plainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateInitializeResponse(message: Record<string, unknown>): void {
  if (Object.hasOwn(message, "error")) {
    throw new Error(`MCP initialization failed: ${JSON.stringify(message.error)}`);
  }
  const result = plainObject(message.result, "MCP initialize result");
  if (
    Object.keys(result).length !== 3 ||
    !Object.hasOwn(result, "protocolVersion") ||
    !Object.hasOwn(result, "capabilities") ||
    !Object.hasOwn(result, "serverInfo")
  ) {
    throw new Error(
      "MCP initialize result must contain exactly protocolVersion, capabilities, and serverInfo",
    );
  }
  if (result.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error(
      `MCP server negotiated unsupported protocol ${JSON.stringify(result.protocolVersion)}`,
    );
  }
  const capabilities = plainObject(
    result.capabilities,
    "MCP server capabilities",
  );
  if (
    Object.keys(capabilities).length !== 1 ||
    !Object.hasOwn(capabilities, "tools")
  ) {
    throw new Error("MCP server must advertise exactly the tools capability");
  }
  const tools = plainObject(capabilities.tools, "MCP tools capability");
  if (
    Object.keys(tools).length !== 1 ||
    tools.listChanged !== true
  ) {
    throw new Error(
      "MCP tools capability must advertise exactly listChanged=true",
    );
  }
  const serverInfo = plainObject(result.serverInfo, "MCP server info");
  if (
    Object.keys(serverInfo).length !== 2 ||
    !Object.hasOwn(serverInfo, "name") ||
    !Object.hasOwn(serverInfo, "version")
  ) {
    throw new Error(
      "MCP server info must contain exactly name and version",
    );
  }
  if (serverInfo.name !== MCP_SERVER_NAME) {
    throw new Error(
      `MCP server name must be ${JSON.stringify(MCP_SERVER_NAME)}`,
    );
  }
  if (serverInfo.version !== MCP_SERVER_VERSION) {
    throw new Error(
      `MCP server version must match package version ${JSON.stringify(MCP_SERVER_VERSION)}`,
    );
  }
}

type McpProtocolPhase = "initializing" | "ready";

function acceptMcpResponse(
  message: Record<string, unknown>,
  expectedIds: ReadonlySet<number>,
  seenResponses: Set<number>,
  phase: McpProtocolPhase,
): McpProtocolPhase {
  if (Object.hasOwn(message, "method")) {
    throw new Error(`unexpected MCP notification: ${JSON.stringify(message)}`);
  }
  const id = message.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new Error(`MCP response has an invalid ID: ${JSON.stringify(message)}`);
  }
  if (!expectedIds.has(id)) {
    throw new Error(`unexpected MCP response ID ${id}`);
  }
  if (seenResponses.has(id)) {
    throw new Error(`duplicate MCP response ID ${id}`);
  }
  if (phase === "initializing" && id !== 1) {
    throw new Error(`MCP response ID ${id} arrived before initialization`);
  }
  if (phase === "ready" && id === 1) {
    throw new Error("MCP initialize response arrived after initialization");
  }
  if (id === 1) validateInitializeResponse(message);
  seenResponses.add(id);
  return id === 1 ? "ready" : phase;
}

async function mcpExchange(
  dataDir: string,
  calls: ToolCall[],
  serverEntrypoint = path.join(ROOT, "src/mcp.ts"),
  extraEnvironment?: Readonly<NodeJS.ProcessEnv>,
): Promise<McpResult> {
  const messages: Array<Record<string, unknown>> = [];
  const expectedIdList = [1, 2, ...calls.map((call) => call.id)];
  const expectedIds = new Set(expectedIdList);
  if (expectedIds.size !== expectedIdList.length) {
    throw new Error("MCP contract calls must use unique IDs other than 1 and 2");
  }

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "contract-test", version: "0" },
    },
  };
  const afterInitialize: Array<Record<string, unknown>> = [{
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }];
  for (const call of calls) {
    afterInitialize.push({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: {
        name: "meeting_transcripts",
        arguments: { tool: call.tool, args: call.args ?? {} },
      },
    });
  }

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--preload",
      NETWORK_PRELOAD,
      serverEntrypoint,
    ],
    cwd: ROOT,
    env: isolatedEnvironment(dataDir, false, undefined, extraEnvironment),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = child.exited;

  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let protocolError: unknown;
  let resolveInitialized!: () => void;
  const initialized = new Promise<void>((resolve) => {
    resolveInitialized = resolve;
  });
  let rejectProtocol!: (error: unknown) => void;
  const protocolFailure = new Promise<never>((_resolve, reject) => {
    rejectProtocol = reject;
  });
  void protocolFailure.catch(() => {});
  const exitedBeforeInitialize = exited.then((code): never => {
    throw new Error(
      `MCP server exited before initialization (code=${code}, signal=${String(child.signalCode)})`,
    );
  });
  void exitedBeforeInitialize.catch(() => {});

  const seenResponses = new Set<number>();
  let protocolPhase: McpProtocolPhase = "initializing";
  const failProtocol = (error: unknown): void => {
    if (protocolError !== undefined) return;
    protocolError = error;
    rejectProtocol(error);
  };
  const acceptMessage = (message: Record<string, unknown>): void => {
    try {
      protocolPhase = acceptMcpResponse(
        message,
        expectedIds,
        seenResponses,
        protocolPhase,
      );
    } catch (error) {
      failProtocol(error);
      return;
    }
    messages.push(message);
    if (message.id === 1) resolveInitialized();
  };

  const stdoutDrain = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      stdout += text;
      if (protocolError === undefined) {
        try {
          stdoutBuffer = consumeJsonRpcChunk(stdoutBuffer, text, acceptMessage);
        } catch (error) {
          failProtocol(error);
        }
      }
    }
    const tail = decoder.decode();
    stdout += tail;
    if (protocolError === undefined) {
      try {
        stdoutBuffer = consumeJsonRpcChunk(stdoutBuffer, tail, acceptMessage);
        finishJsonRpcStream(stdoutBuffer);
      } catch (error) {
        failProtocol(error);
      }
    }
  })();
  const stderrDrain = (async () => {
    stderr = await new Response(child.stderr).text();
  })();

  const send = async (outbound: readonly Record<string, unknown>[]): Promise<void> => {
    child.stdin.write(
      outbound.map((message) => `${JSON.stringify(message)}\n`).join(""),
    );
    await child.stdin.flush();
  };

  let code: number | undefined;
  let primaryError: unknown;
  try {
    await send([initialize]);
    await withTimeout(
      Promise.race([
        initialized,
        protocolFailure,
        exitedBeforeInitialize,
      ]),
      PROCESS_TIMEOUT_MS,
      "MCP server did not answer initialize",
    );
    await send(afterInitialize);
    child.stdin.end();

    code = await withTimeout(
      Promise.race([exited, protocolFailure]),
      PROCESS_TIMEOUT_MS,
      "MCP server did not close after stdin EOF",
    );
    await withTimeout(
      Promise.race([
        Promise.all([stdoutDrain, stderrDrain]),
        protocolFailure,
      ]),
      CLEANUP_TIMEOUT_MS,
      "MCP output pipes did not close after process exit",
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      child.stdin.end();
    } catch {
      // The pipe can already be closed after a normal EOF.
    }
  }

  if (primaryError !== undefined) {
    const cleanupErrors: unknown[] = [];
    try {
      child.kill("SIGKILL");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await withTimeout(
        exited,
        CLEANUP_TIMEOUT_MS,
        "MCP process did not exit after termination",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const drainResults = await withTimeout(
        Promise.allSettled([stdoutDrain, stderrDrain]),
        CLEANUP_TIMEOUT_MS,
        "MCP output pipes did not drain after termination",
      );
      for (const result of drainResults) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "MCP exchange failed and cleanup was incomplete",
      );
    }
    throw primaryError;
  }

  if (code !== 0 || child.signalCode !== null) {
    throw new Error(
      `MCP server exited uncleanly (code=${String(code)}, signal=${String(child.signalCode)})`,
    );
  }
  if (protocolError !== undefined) throw protocolError;
  if (
    messages.length !== expectedIds.size ||
    seenResponses.size !== expectedIds.size
  ) {
    const missing = expectedIdList.filter((id) => !seenResponses.has(id));
    throw new Error(`MCP server closed without exactly one response for IDs: ${missing.join(", ")}`);
  }
  const processResult: ProcessResult = {
    code: code!,
    signal: child.signalCode,
    stdout,
    stderr,
  };
  return { ...processResult, messages };
}

function toolText(messages: Array<Record<string, unknown>>, id: number): string {
  const response = messages.find((message) => message.id === id) as
    | { result?: { content?: Array<{ type?: string; text?: string; }>; }; }
    | undefined;
  const content = response?.result?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) {
    throw new Error(`response ${id} is not one text content block`);
  }
  return content[0].text;
}

async function runDispatcherBatch(
  dataDir: string,
  calls: ReadonlyArray<Pick<ToolCall, "tool" | "args">>,
  entrypoint = DISPATCH_CALL,
  semanticRequested = false,
  semanticFailure?: SemanticFailure,
  extraEnvironment?: Readonly<NodeJS.ProcessEnv>,
): Promise<string[]> {
  const result = await runProcess(
    [entrypoint, JSON.stringify(calls.map((call) => ({
      tool: call.tool,
      args: call.args ?? {},
    })))],
    dataDir,
    undefined,
    semanticRequested,
    semanticFailure,
    extraEnvironment,
  );
  if (result.code !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`dispatcher batch failed: ${JSON.stringify(result)}`);
  }
  const output: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(output) ||
    output.length !== calls.length ||
    output.some((value) => typeof value !== "string")
  ) {
    throw new Error("dispatcher batch did not return one string per request");
  }
  return output as string[];
}

async function runAuthDispatch(
  entrypoint: string,
  dataDir: string,
  scenario: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const [output] = await runDispatcherBatch(
    dataDir,
    [{ tool, args }],
    entrypoint,
    false,
    undefined,
    { SANA_TEST_AUTH_SCENARIO: scenario },
  );
  return output!;
}

afterAll(() => {
  for (const dir of temporaryRoots) rmSync(dir, { recursive: true, force: true });
});

describe.serial("MCP stdio contract", () => {
  test("isolates live data and blocks the app's network and daemon paths", async () => {
    const dataDir = createDataDir();
    const canCreateRepositoryAlias =
      process.platform !== "win32" || !ROOT.startsWith("\\\\");
    if (canCreateRepositoryAlias) {
      symlinkSync(
        path.join(ROOT, "data"),
        path.join(dataDir, "live-data-alias"),
        process.platform === "win32" ? "junction" : "dir"
      );
      liveDataAliasRoots.add(dataDir);
    }
    const result = await runProcess([GUARD_PROBE], dataDir);
    if (result.code !== 0) {
      throw new Error(`guard probe failed: ${JSON.stringify(result)}`);
    }
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const expected = [
      "live data metadata",
    ];
    if (canCreateRepositoryAlias) {
      expected.push(
        "live data alias metadata",
        "live data alias SQLite read-only",
      );
    }
    expected.push("Sana client fetch", "production daemon spawn");
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }, outerTestBudget(1));

  test("rejects runtimes outside the canonical standalone target set", () => {
    expect(() => standaloneTargetForRuntime("win32", "arm64")).toThrow(
      "contract test has no canonical standalone target for win32/arm64",
    );
  });

  test(
    "terminates and reaps a timed-out isolated build worker",
    async () => {
      const dataDir = createDataDir();
      const outfile = path.join(dataDir, "must-not-exist.js");
      await expect(
        runProcess(
          [
            BUILD_ENTRYPOINT,
            JSON.stringify({
              mode: "semantic",
              entrypoint: DISPATCH_CALL,
              outfile,
              external: [],
              testHang: true,
            }),
          ],
          dataDir,
          undefined,
          false,
          undefined,
          undefined,
          25,
        ),
      ).rejects.toThrow(
        `timed out waiting for ${BUILD_ENTRYPOINT}`,
      );
      expect(existsSync(outfile)).toBe(false);
    },
    outerTestBudget(0, 0, 1),
  );

  test("rejects blank, whitespace, arbitrary, double, late, and unterminated frames", () => {
    expect(() => parseJsonRpcLine("")).toThrow("empty JSON-RPC stdout frame");
    expect(() => parseJsonRpcLine(" \t")).toThrow("empty JSON-RPC stdout frame");
    expect(() => parseJsonRpcLine('{"message":"not json-rpc"}')).toThrow(
      "non-JSON-RPC stdout frame"
    );
    const messages: Array<Record<string, unknown>> = [];
    expect(() =>
      consumeJsonRpcChunk(
        "",
        '{"jsonrpc":"2.0","id":1,"result":{}}\n\n',
        (message) => messages.push(message),
      )
    ).toThrow("empty JSON-RPC stdout frame");
    expect(() => finishJsonRpcStream(" ")).toThrow(
      "unterminated or trailing JSON-RPC stdout frame"
    );
    expect(() =>
      finishJsonRpcStream('{"jsonrpc":"2.0","id":1,"result":{}}')
    ).toThrow("unterminated or trailing JSON-RPC stdout frame");
  });

  test("requires a complete initialize result at the requested protocol version", () => {
    const valid = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
        },
      },
    };
    expect(() => validateInitializeResponse(valid)).not.toThrow();
    expect(() =>
      validateInitializeResponse({ ...valid, result: undefined })
    ).toThrow("MCP initialize result must be an object");
    expect(() =>
      validateInitializeResponse({
        ...valid,
        result: { ...valid.result, extra: true },
      })
    ).toThrow(
      "MCP initialize result must contain exactly protocolVersion, capabilities, and serverInfo",
    );
    expect(() =>
      validateInitializeResponse({
        ...valid,
        result: { ...valid.result, protocolVersion: "unsupported" },
      })
    ).toThrow("MCP server negotiated unsupported protocol");

    for (const capabilities of [undefined, null, []]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: { ...valid.result, capabilities },
        })
      ).toThrow("MCP server capabilities must be an object");
    }
    for (const capabilities of [
      {},
      { prompts: {} },
      { tools: { listChanged: true }, prompts: {} },
    ]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: { ...valid.result, capabilities },
        })
      ).toThrow("MCP server must advertise exactly the tools capability");
    }
    for (const tools of [
      undefined,
      null,
      [],
      {},
      { listChanged: false },
      { listChanged: true, extra: true },
    ]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: {
            ...valid.result,
            capabilities: { tools },
          },
        })
      ).toThrow(/MCP tools capability/);
    }
    for (const serverInfo of [undefined, null, []]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: { ...valid.result, serverInfo },
        })
      ).toThrow("MCP server info must be an object");
    }
    expect(() =>
      validateInitializeResponse({
        ...valid,
        result: {
          ...valid.result,
          serverInfo: { ...valid.result.serverInfo, extra: true },
        },
      })
    ).toThrow("MCP server info must contain exactly name and version");
    for (const name of [undefined, "", "other-server"]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: {
            ...valid.result,
            serverInfo: { ...valid.result.serverInfo, name },
          },
        })
      ).toThrow("MCP server name must be");
    }
    for (const version of [undefined, "", "0.0.0"]) {
      expect(() =>
        validateInitializeResponse({
          ...valid,
          result: {
            ...valid.result,
            serverInfo: { ...valid.result.serverInfo, version },
          },
        })
      ).toThrow("MCP server version must match package version");
    }
  });

  test("rejects every response before validated initialization except ID 1", () => {
    const expectedIds = new Set([1, 2, 3]);
    const response = (id: number): Record<string, unknown> => ({
      jsonrpc: "2.0",
      id,
      result: {},
    });

    for (const id of [2, 3]) {
      expect(() =>
        acceptMcpResponse(
          response(id),
          expectedIds,
          new Set(),
          "initializing",
        )
      ).toThrow(`MCP response ID ${id} arrived before initialization`);
    }
    expect(() =>
      acceptMcpResponse(response(99), expectedIds, new Set(), "initializing")
    ).toThrow("unexpected MCP response ID 99");

    const seen = new Set<number>();
    const validInitialize = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
        },
      },
    };
    expect(() =>
      acceptMcpResponse(
        { ...validInitialize, result: {} },
        expectedIds,
        seen,
        "initializing",
      )
    ).toThrow();
    expect(seen.size).toBe(0);

    const phase = acceptMcpResponse(
      validInitialize,
      expectedIds,
      seen,
      "initializing",
    );
    expect(phase).toBe("ready");
    expect(acceptMcpResponse(response(2), expectedIds, seen, phase)).toBe(
      "ready",
    );
  });

  test("fails immediately when the server exits before initialization", async () => {
    const dataDir = createDataDir();
    for (const code of [0, 7]) {
      const serverEntrypoint = path.join(dataDir, `early-exit-${code}.ts`);
      await Bun.write(
        serverEntrypoint,
        `process.stdin.once("data", () => process.exit(${code}));\n` +
          `process.stdin.resume();\n`,
      );
      await expect(
        mcpExchange(dataDir, [], serverEntrypoint),
      ).rejects.toThrow(
        `MCP server exited before initialization (code=${code}, signal=null)`,
      );
    }
  }, outerTestBudget(0, 2));

  test("freezes the registered tool name, description, and input schema", async () => {
    const result = await mcpExchange(createDataDir(), [{ id: 3, tool: "help" }]);
    const response = result.messages.find((message) => message.id === 2) as {
      result: { tools: unknown[]; };
    };
    expect(response.result.tools).toHaveLength(1);
    expect(response.result.tools[0]).toEqual(JSON.parse(fixture("mcp-tool.json")));
  }, outerTestBudget(0, 1));

  test("drains stdout through close and accepts only valid JSON-RPC frames", async () => {
    const result = await mcpExchange(createDataDir(), [{ id: 3, tool: "help" }]);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const frames = result.stdout.split(/\r?\n/);
    expect(frames.pop()).toBe("");
    expect(frames).toHaveLength(result.messages.length);
    for (const frame of frames) expect(frame.length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(/\x1b\[/);
    expect(result.stdout).not.toContain("sana-mcp MCP server running on stdio");
    expect(result.stderr).toContain("sana-mcp MCP server running on stdio");
    expect(result.stderr).not.toMatch(/\x1b\[/);
  }, outerTestBudget(0, 1));

  test("returns the frozen logged-out help document", async () => {
    const dataDir = createDataDir();
    const result = await mcpExchange(dataDir, [{ id: 3, tool: "help" }]);
    expect(toolText(result.messages, 3)).toBe(fixture("help-logged-out.txt"));
  }, outerTestBudget(0, 1));

  test(
    "direct dispatcher and MCP preserve representative exact parity",
    async () => {
      const dataDir = createDataDir();
      await seedStore(dataDir);
      const calls: ToolCall[] = [
        { id: 10, tool: "help", args: { tool: "list" } },
        { id: 11, tool: "list", args: { page: 1, limit: 1 } },
        { id: 12, tool: "read", args: { meeting_id: "meeting-alpha", lines: [1, 1] } },
        { id: 13, tool: "search", args: { query: "coverage" } },
        { id: 14, tool: "status" },
      ];
      const mcp = await mcpExchange(dataDir, calls);
      // Keep the UNC/direct parity path sequential. On Windows, starting all
      // Bun children through a WSL share at once can exhaust the outer runner
      // budget even though every individual child remains bounded.
      const dispatcherOutputs = await runDispatcherBatch(dataDir, calls);
      for (const [index, call] of calls.entries()) {
        const expected = toolText(mcp.messages, call.id);
        expect(dispatcherOutputs[index]).toBe(expected);
      }
    },
    outerTestBudget(2, 1),
  );

  test(
    "behaviorally freezes representative outputs and legacy aliases",
    async () => {
      const dataDir = createDataDir();
      await seedStore(dataDir);
      const calls: ToolCall[] = [
        { id: 20, tool: "list", args: { page: 1, limit: 1 } },
        { id: 21, tool: "list_meetings", args: { page: 1, limit: 1 } },
        { id: 22, tool: "read", args: { meeting_id: "meeting-alpha", lines: [1, 1] } },
        {
          id: 23,
          tool: "read_transcript",
          args: { meeting_id: "meeting-alpha", lines: [1, 1] },
        },
        { id: 24, tool: "read", args: { id: "meeting-alpha", lines: [1, 1] } },
        { id: 25, tool: "search", args: { query: "coverage" } },
        { id: 26, tool: "summary", args: { meeting_id: "meeting-alpha" } },
        { id: 27, tool: "participants", args: { meeting_id: "meeting-alpha" } },
        { id: 28, tool: "recording", args: { meeting_id: "meeting-alpha" } },
        { id: 29, tool: "recording", args: {} },
        {
          id: 30,
          tool: "login",
          args: { email: "contract@example.invalid", confirmation_code: "123456" },
        },
        {
          id: 31,
          tool: "login",
          args: { email: "contract@example.invalid", code: "123456" },
        },
        { id: 32, tool: "read", args: { meeting_id: "meeting-alpha" } },
        { id: 33, tool: "search", args: { query: "contract", limit: 1, sort: "newest" } },
        { id: 34, tool: "status" },
        { id: 35, tool: "summary", args: { id: "meeting-alpha" } },
        { id: 36, tool: "participants", args: { id: "meeting-alpha" } },
        { id: 37, tool: "recording", args: { id: "meeting-alpha" } },
        { id: 38, tool: "read", args: {} },
        { id: 39, tool: "search", args: {} },
        { id: 61, tool: "login", args: {} },
        { id: 62, tool: "summary", args: {} },
        { id: 63, tool: "participants", args: {} },
      ];
      const result = await mcpExchange(dataDir, calls);
      const expected = JSON.parse(fixture("representative-outputs.json")) as Record<string, string>;

      expect(toolText(result.messages, 20)).toBe(expected.list);
      expect(toolText(result.messages, 21)).toBe(expected.list);
      expect(toolText(result.messages, 22)).toBe(expected.read);
      expect(toolText(result.messages, 23)).toBe(expected.read);
      expect(toolText(result.messages, 24)).toBe(expected.read);
      expect(toolText(result.messages, 25)).toBe(expected.search);
      expect(toolText(result.messages, 26)).toBe(expected.summary);
      expect(toolText(result.messages, 27)).toBe(expected.participants);
      expect(toolText(result.messages, 28)).toBe(expected.recordingError);
      expect(toolText(result.messages, 29)).toBe(expected.recordingMissingId);
      expect(toolText(result.messages, 30)).toBe(expected.loginCodeError);
      expect(toolText(result.messages, 31)).toBe(expected.loginCodeError);
      expect(toolText(result.messages, 32)).toBe(expected.readGuidance);
      expect(toolText(result.messages, 33)).toBe(expected.searchNextPage);
      expect(toolText(result.messages, 34)).toBe(expected.status);
      expect(toolText(result.messages, 35)).toBe(expected.summary);
      expect(toolText(result.messages, 36)).toBe(expected.participants);
      expect(toolText(result.messages, 37)).toBe(expected.recordingError);
      expect(toolText(result.messages, 38)).toBe(expected.readMissingId);
      expect(toolText(result.messages, 39)).toBe(expected.searchMissingQuery);
      expect(toolText(result.messages, 61)).toBe(expected.loginMissingEmail);
      expect(toolText(result.messages, 62)).toBe(expected.summaryMissingId);
      expect(toolText(result.messages, 63)).toBe(expected.participantsMissingId);
    },
    outerTestBudget(1, 1),
  );

  test(
    "freezes accepted, rejected, incomplete, and unavailable authentication transitions",
    async () => {
      const dataDir = createDataDir();
      const dispatcher = await buildAuthContractEntrypoint(
        dataDir,
        DISPATCH_CALL,
        "auth-dispatch.js",
      );
      const expected = JSON.parse(fixture("auth-transitions.json")) as Record<
        string,
        string
      >;
      const email = "auth@example.invalid";
      const cases = [
        {
          key: "requestAccepted",
          scenario: "request-accepted",
          args: { email },
        },
        {
          key: "requestPreflight",
          scenario: "request-preflight-rejected",
          args: { email },
        },
        {
          key: "requestRemoteRejected",
          scenario: "request-remote-rejected",
          args: { email },
        },
        {
          key: "requestRemoteUnknown",
          scenario: "request-remote-unknown",
          args: { email },
        },
        {
          key: "requestLocalIncomplete",
          scenario: "request-local-publication-incomplete",
          args: { email },
        },
        {
          key: "requestLocalIncomplete",
          scenario: "request-local-cleanup-incomplete",
          args: { email },
        },
        {
          key: "requestLocalIncomplete",
          scenario: "request-store-incomplete",
          args: { email },
        },
        {
          key: "originResetRequest",
          scenario: "origin-mismatch",
          args: { email },
        },
        {
          key: "legacyPartialResetRequest",
          scenario: "legacy-partial-session",
          args: { email },
        },
        {
          key: "originBaselineRecoveryFailed",
          scenario: "origin-baseline-recovery-failed",
          args: { email },
        },
        {
          key: "localAuthStateUnavailable",
          scenario: "local-auth-state-unavailable",
          args: { email },
        },
        {
          key: "verifyPreflight",
          scenario: "verify-preflight-rejected",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyStoreUnavailable",
          scenario: "verify-store-unavailable",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyCleanupIncomplete",
          scenario: "verify-local-cleanup-incomplete",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyRemoteRejected",
          scenario: "verify-remote-rejected",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyRemoteUnknown",
          scenario: "verify-remote-unknown",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyLocalIncomplete",
          scenario: "verify-local-incomplete",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "verifyLocalIncomplete",
          scenario: "missing-authoritative-identity",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "authTransitionIncomplete",
          scenario: "auth-transition-incomplete",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "syncUnavailable",
          scenario: "sync-unavailable",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "syncUnavailablePersistenceFailed",
          scenario: "sync-status-persistence-failed",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "publicationBusy",
          scenario: "publication-busy",
          args: { email, confirmation_code: "123456" },
        },
        {
          key: "staleWriter",
          scenario: "stale-writer",
          args: { email, confirmation_code: "123456" },
        },
      ] as const;

      for (const contractCase of cases) {
        let output: string;
        try {
          output = await runAuthDispatch(
            dispatcher,
            dataDir,
            contractCase.scenario,
            "login",
            contractCase.args,
          );
        } catch (error) {
          throw new Error(
            `authentication contract scenario ${contractCase.scenario} failed`,
            { cause: error },
          );
        }
        expect(
          output,
          contractCase.scenario,
        ).toBe(expected[contractCase.key]);
      }
    },
    outerTestBudget(23, 0, 1),
  );

  test(
    "models pending ownership, durable publication, and daemon cache release",
    async () => {
      const dataDir = createDataDir();
      const probe = await buildAuthContractEntrypoint(
        dataDir,
        AUTH_PUBLICATION_PROBE,
        "auth-publication-probe.js",
      );
      const userId = ["user", "contract"].join("-");
      const workspaceId = ["workspace", "contract"].join("-");
      const initialToken = [
        "22222222",
        "2222",
        "4222",
        "8222",
        "222222222222",
      ].join("-");
      const confirmedToken = [
        "33333333",
        "3333",
        "4333",
        "8333",
        "333333333333",
      ].join("-");
      const clearedPublication = {
        auth_pending: 0,
        auth_transition_pid: null,
        auth_transition_token: null,
        auth_transition_generation: null,
        auth_transition_kind: null,
        auth_transition_user_id: null,
        auth_transition_workspace_id: null,
        auth_issue_code: null,
        auth_issue_message: null,
        auth_issue_operation_token: null,
        auth_issue_generation: null,
        auth_issue_kind: null,
        catchup_generation: 3,
      };
      const initial = {
        auth_generation: 2,
        auth_publication_token: initialToken,
        auth_user_id: userId,
        auth_workspace_id: workspaceId,
        auth_pending: 1,
        auth_transition_pid: null,
        auth_transition_token: null,
        auth_transition_generation: null,
        auth_transition_kind: null,
        auth_transition_user_id: null,
        auth_transition_workspace_id: null,
        auth_issue_code: "AUTH_PUBLICATION_INCOMPLETE",
        auth_issue_message:
          "Local session persistence could not be confirmed; sign in again.",
        auth_issue_operation_token: initialToken,
        auth_issue_generation: 2,
        auth_issue_kind: "login",
        catchup_generation: 2,
        blocking: 1,
        cache_user_id: userId,
        cache_workspace_id: workspaceId,
        sync_issue_code: "PREVIOUS_SYNC_UNAVAILABLE",
        sync_issue_cause: "PREVIOUS_DAEMON_FAILURE",
        sync_issue_message: "previous contract sync failure",
      };
      const cases = [
        {
          scenario: "verify-ready-state",
          result: "ready",
          errorName: null,
          targetUserId: userId,
          targetWorkspaceId: workspaceId,
          postVerify: {
            sync_issue_code: null,
            sync_issue_cause: null,
            sync_issue_message: null,
          },
          finalBlocking: 0,
          finalSync: {
            sync_issue_code: null,
            sync_issue_cause: null,
            sync_issue_message: null,
          },
          events: [
            "store-blocking:3",
            "session-save:3",
            "store-confirm:3",
            "reset-failures:3",
            "clear-sync:3",
            "finish-sync:3",
          ],
        },
        {
          scenario: "sync-unavailable",
          result: "sync-unavailable",
          errorName: null,
          targetUserId: userId,
          targetWorkspaceId: workspaceId,
          postVerify: {
            sync_issue_code: "LOGIN_SYNC_UNAVAILABLE",
            sync_issue_cause: "DAEMON_START_FAILED",
            sync_issue_message: "contract daemon launch failed",
          },
          finalBlocking: 1,
          finalSync: {
            sync_issue_code: "LOGIN_SYNC_UNAVAILABLE",
            sync_issue_cause: "DAEMON_START_FAILED",
            sync_issue_message: "contract daemon launch failed",
          },
          events: [
            "store-blocking:3",
            "session-save:3",
            "store-confirm:3",
            "reset-failures:3",
            "record-sync:3",
          ],
        },
        {
          scenario: "missing-authoritative-identity",
          result: null,
          errorName: "VerifyCodeLocalTransitionError",
          targetUserId: null,
          targetWorkspaceId: null,
          postVerify: {
            sync_issue_code: "PREVIOUS_SYNC_UNAVAILABLE",
            sync_issue_cause: "PREVIOUS_DAEMON_FAILURE",
            sync_issue_message: "previous contract sync failure",
          },
          finalBlocking: 1,
          finalSync: {
            sync_issue_code: "PREVIOUS_SYNC_UNAVAILABLE",
            sync_issue_cause: "PREVIOUS_DAEMON_FAILURE",
            sync_issue_message: "previous contract sync failure",
          },
          events: [
            "store-blocking:3",
            "session-save:3",
            "store-confirm:3",
          ],
        },
      ] as const;

      for (const contractCase of cases) {
        const result = await runProcess(
          [probe],
          dataDir,
          undefined,
          false,
          undefined,
          { SANA_TEST_AUTH_SCENARIO: contractCase.scenario },
        );
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe("");
        const observed = JSON.parse(result.stdout) as {
          processPid: number;
          [key: string]: unknown;
        };
        const durablePublication = {
          auth_generation: 3,
          auth_publication_token: confirmedToken,
          auth_user_id: contractCase.targetUserId,
          auth_workspace_id: contractCase.targetWorkspaceId,
          ...clearedPublication,
          blocking: 1,
          cache_user_id: userId,
          cache_workspace_id: workspaceId,
        };
        expect(observed).toEqual({
          processPid: observed.processPid,
          result: contractCase.result,
          errorName: contractCase.errorName,
          generation: contractCase.result === null ? null : 3,
          initial,
          pending: [{
            blocking: 1,
            auth_pending: 1,
            catchup_generation: 3,
            auth_transition_pid: observed.processPid,
            auth_transition_token: confirmedToken,
            auth_transition_generation: 3,
            auth_transition_kind: "login",
            auth_transition_user_id: contractCase.targetUserId,
            auth_transition_workspace_id: contractCase.targetWorkspaceId,
            auth_issue_code: null,
            auth_issue_message: null,
            auth_issue_operation_token: null,
            auth_issue_generation: null,
            auth_issue_kind: null,
            sync_issue_code: "PREVIOUS_SYNC_UNAVAILABLE",
            sync_issue_cause: "PREVIOUS_DAEMON_FAILURE",
            sync_issue_message: "previous contract sync failure",
          }],
          postVerify: {
            ...durablePublication,
            ...contractCase.postVerify,
          },
          final: {
            ...durablePublication,
            blocking: contractCase.finalBlocking,
            ...contractCase.finalSync,
          },
          events: contractCase.events,
        });
      }
    },
    outerTestBudget(3, 0, 1),
  );

  test(
    "freezes auth-incomplete blocking and durable daemon degradation",
    async () => {
      const dataDir = createDataDir();
      const dispatcher = await buildAuthContractEntrypoint(
        dataDir,
        DISPATCH_CALL,
        "auth-state-dispatch.js",
      );
      const expected = JSON.parse(fixture("auth-transitions.json")) as Record<
        string,
        string
      >;

      const authHelp = await runAuthDispatch(
        dispatcher,
        dataDir,
        "auth-incomplete",
        "help",
        {},
      );
      expect(authHelp).toBe(
        `${expected.authIncompleteNotice}\n\n${fixture("help.txt")}`,
      );
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "auth-incomplete",
          "status",
          {},
        ),
      ).toBe(expected.authIncompleteStatus);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "auth-incomplete",
          "list",
          {},
        ),
      ).toBe(expected.authIncompleteDataBlock);
      const durableStatus: Parameters<typeof renderStatusInfo>[0] = {
        session: { hasCookie: true, loggedIn: true, expired: false },
        blocking: true,
        phase: "synced",
        transcriptsDone: 2,
        transcriptsTotal: 2,
        remaining: 0,
        etaMinutes: 0,
        meetings: 2,
        transcripts: 2,
        lastFullSyncMs: Date.parse("2026-01-03T12:00:00Z"),
        lastIncrementalMs: null,
        daemonHeartbeatMs: null,
        error: null,
        syncUnavailable: {
          code: "LOGIN_SYNC_UNAVAILABLE",
          cause: "DAEMON_START_FAILED",
          message: "contract daemon launch failed",
        },
        semantic: { enabled: false, embedded: 0, total: 2 },
      };
      expect(renderStatusInfo(durableStatus)).toBe(
        expected.durableSyncUnavailableStatus,
      );
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "daemon-launch-failure",
          "status",
          {},
        ),
      ).toBe(expected.daemonLaunchFailureStatus);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "daemon-status-persistence-failed",
          "status",
          {},
        ),
      ).toBe(expected.daemonStatusPersistenceFailed);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "daemon-status-persistence-with-previous",
          "status",
          {},
        ),
      ).toBe(expected.daemonStatusPersistenceWithPrevious);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "status-snapshot-changed",
          "status",
          {},
        ),
      ).toBe(expected.authStatusSnapshotChanged);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "auth-refresh-identity-mismatch",
          "status",
          {},
        ),
      ).toBe(expected.authRefreshIdentityMismatch);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "cache-operation-changed-before",
          "list",
          {},
        ),
      ).toBe(expected.cacheOperationChangedBefore);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "cache-operation-changed-during",
          "list",
          {},
        ),
      ).toBe(expected.cacheOperationChangedDuring);
      expect(
        await runAuthDispatch(
          dispatcher,
          dataDir,
          "cache-operation-changed-after",
          "list",
          {},
        ),
      ).toBe(expected.cacheOperationChangedAfter);
    },
    outerTestBudget(11, 0, 1),
  );

  test(
    "rejects cache results from real tuple mutations before, during, and after work",
    async () => {
      const dataDir = createDataDir();
      const probe = await buildAuthContractEntrypoint(
        dataDir,
        AUTH_CACHE_PROBE,
        "auth-cache-probe.js",
      );
      const expected = JSON.parse(fixture("auth-transitions.json")) as Record<
        string,
        string
      >;
      const cases = [
        {
          scenario: "cache-operation-changed-before",
          output: expected.cacheOperationChangedBefore,
          events: [
            "cache-mutation:before-capture",
            "cache-guard-rejected",
          ],
        },
        {
          scenario: "cache-operation-changed-during",
          output: expected.cacheOperationChangedDuring,
          events: [
            "cache-mutation:before-synchronous-fence",
            "cache-guard-rejected",
          ],
        },
        {
          scenario: "cache-operation-changed-after",
          output: expected.cacheOperationChangedAfter,
          events: [
            "cache-mutation:synchronous-after-operation",
            "cache-guard-rejected",
          ],
        },
        {
          scenario: "cache-search-changed-after-await",
          output: expected.cacheSearchChangedAfterAwait,
          events: [
            "search-read-complete",
            "search-yield",
            "cache-mutation:search-after-await",
            "cache-guard-rejected",
          ],
        },
        {
          scenario: "cache-recording-changed-after-await",
          output: expected.cacheRecordingChangedAfterAwait,
          events: [
            "recording-fetch-complete",
            "cache-mutation:recording-after-await",
            "cache-guard-rejected",
          ],
        },
      ] as const;

      for (const contractCase of cases) {
        const result = await runProcess(
          [probe],
          dataDir,
          undefined,
          false,
          undefined,
          { SANA_TEST_AUTH_SCENARIO: contractCase.scenario },
        );
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          output: contractCase.output,
          events: contractCase.events,
        });
      }
    },
    outerTestBudget(5, 0, 1),
  );

  test(
    "preserves exact direct dispatcher and MCP auth parity",
    async () => {
      const dataDir = createDataDir();
      const dispatcher = await buildAuthContractEntrypoint(
        dataDir,
        DISPATCH_CALL,
        "auth-parity-dispatch.js",
      );
      const mcp = await buildAuthContractEntrypoint(
        dataDir,
        path.join(ROOT, "src/mcp.ts"),
        "auth-parity-mcp.js",
      );
      const scenario = "sync-unavailable";
      const args = {
        email: "auth@example.invalid",
        confirmation_code: "123456",
      };
      const expected = (
        JSON.parse(fixture("auth-transitions.json")) as Record<string, string>
      ).syncUnavailable;
      const direct = await runAuthDispatch(
        dispatcher,
        dataDir,
        scenario,
        "login",
        args,
      );
      const mcpResult = await mcpExchange(
        dataDir,
        [{ id: 70, tool: "login", args }],
        mcp,
        { SANA_TEST_AUTH_SCENARIO: scenario },
      );

      expect(direct).toBe(expected);
      expect(toolText(mcpResult.messages, 70)).toBe(expected);
    },
    outerTestBudget(1, 1, 2),
  );

  test("freezes deterministic sync-in-progress status", async () => {
    const dataDir = createDataDir();
    await seedStore(dataDir);
    const progress = await runProcess(
      [SET_SYNC_PROGRESS],
      dataDir
    );
    expect(progress).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });
    const result = await mcpExchange(dataDir, [{ id: 60, tool: "status" }]);
    const expected = JSON.parse(fixture("representative-outputs.json")) as Record<string, string>;
    expect(toolText(result.messages, 60)).toBe(expected.statusSyncing);
  }, outerTestBudget(2, 1));

  test("freezes truthful read guidance while the meeting list is incomplete", async () => {
    const dataDir = createDataDir();
    await seedStore(dataDir);
    const listing = await runProcess([SET_IDLE_LISTING], dataDir);
    expect(listing).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const result = await mcpExchange(
      dataDir,
      [{ id: 64, tool: "read", args: { meeting_id: "external-alpha" } }],
    );
    const expected = JSON.parse(
      fixture("representative-outputs.json"),
    ) as Record<string, string>;
    expect(toolText(result.messages, 64)).toBe(expected.readStillListing);
  }, outerTestBudget(2, 1));

  test(
    "freezes explicit semantic degradation in a keyword-only standalone build",
    async () => {
      const dataDir = createDataDir();
      const dispatcher = await buildStandaloneDispatcher(dataDir);
      const expected = JSON.parse(fixture("semantic-degradation.json")) as Record<
        string,
        string
      >;
      const calls = [
        { key: "status", tool: "status", args: {} },
        {
          key: "searchWithResults",
          tool: "search",
          args: { query: "coverage" },
        },
        {
          key: "searchWithoutMatches",
          tool: "search",
          args: { query: "unmatched" },
        },
        {
          key: "searchEmptyPage",
          tool: "search",
          args: { query: "contract", limit: 1, page: 3 },
        },
      ] as const;

      const outputs = await runDispatcherBatch(
        dataDir,
        calls,
        dispatcher,
        true,
      );
      expect(outputs).toEqual(calls.map((call) => expected[call.key]));
    },
    outerTestBudget(1, 0, 1),
  );

  test(
    "freezes source semantic runtime degradation through production rendering",
    async () => {
      const dataDir = createDataDir();
      const dispatcher = await buildSourceFailureDispatcher(dataDir);
      const expected = JSON.parse(fixture("semantic-degradation.json")) as Record<
        string,
        string
      >;
      const cases = [
        {
          failure: "unavailable",
          outputs: [
            {
              key: "sourceRuntimeUnavailable",
              args: { query: "coverage" },
            },
            {
              key: "sourceRuntimeUnavailableNoMatches",
              args: { query: "unmatched" },
            },
            {
              key: "sourceRuntimeUnavailableEmptyPage",
              args: { query: "contract", limit: 1, page: 3 },
            },
          ],
        },
        {
          failure: "error",
          outputs: [
            {
              key: "sourceRuntimeError",
              args: { query: "coverage" },
            },
            {
              key: "sourceRuntimeErrorNoMatches",
              args: { query: "unmatched" },
            },
            {
              key: "sourceRuntimeErrorEmptyPage",
              args: { query: "contract", limit: 1, page: 3 },
            },
          ],
        },
        {
          failure: "non-error",
          outputs: [
            {
              key: "sourceUnknownThrownValue",
              args: { query: "coverage" },
            },
            {
              key: "sourceUnknownThrownValueNoMatches",
              args: { query: "unmatched" },
            },
            {
              key: "sourceUnknownThrownValueEmptyPage",
              args: { query: "contract", limit: 1, page: 3 },
            },
          ],
        },
      ] as const;

      for (const scenario of cases) {
        const outputs = await runDispatcherBatch(
          dataDir,
          scenario.outputs.map((output) => ({
            tool: "search",
            args: output.args,
          })),
          dispatcher,
          true,
          scenario.failure,
        );
        expect(outputs).toEqual(
          scenario.outputs.map((output) => expected[output.key]),
        );
      }
    },
    outerTestBudget(3, 0, 1),
  );

  test(
    "behaviorally freezes every documented list, read, and search semantic",
    async () => {
      const dataDir = createDataDir();
      await seedStore(dataDir);
      const jan3Start = Date.parse("2026-01-03T00:00:00Z");
      const jan3End = Date.parse("2026-01-03T23:59:59.999Z");
      const calls: ToolCall[] = [
        { id: 40, tool: "list", args: { query: "Alpha" } },
        { id: 41, tool: "list", args: { sort: "oldest", limit: 1 } },
        { id: 42, tool: "list", args: { filter: { status: "ready" }, sort: "oldest" } },
        { id: 43, tool: "list", args: { filter: { status: "downloading" } } },
        { id: 44, tool: "list", args: { filter: { status: "failed" } } },
        {
          id: 45,
          tool: "list",
          args: { filter: { date: { from: "2026-01-03", to: "2026-01-03" } } },
        },
        {
          id: 46,
          tool: "list",
          args: { filter: { date: { from: jan3Start, to: jan3End } } },
        },
        { id: 55, tool: "list", args: { sort: "oldest", limit: 1, page: 2 } },
        { id: 47, tool: "read", args: { meeting_id: "meeting-alpha", full: true } },
        {
          id: 48,
          tool: "read",
          args: { meeting_id: "meeting-alpha", full: true, timestamps: false },
        },
        { id: 49, tool: "read", args: { meeting_id: "meeting-alpha", lines: [2, 2] } },
        { id: 50, tool: "search", args: { query: "contract", limit: 1, sort: "best" } },
        { id: 51, tool: "search", args: { query: "contract", limit: 1, sort: "oldest" } },
        {
          id: 52,
          tool: "search",
          args: { query: "contract", limit: 1, page: 2, sort: "newest" },
        },
        {
          id: 53,
          tool: "search",
          args: {
            query: "contract",
            filter: { date: { from: "2026-01-03", to: "2026-01-03" } },
          },
        },
        {
          id: 54,
          tool: "search",
          args: { query: "contract", filter: { date: { from: jan3Start, to: jan3End } } },
        },
      ];
      const result = await mcpExchange(dataDir, calls);
      const expected = JSON.parse(fixture("documented-semantics.json")) as Record<string, string>;

      expect(toolText(result.messages, 40)).toBe(expected.listQuery);
      expect(toolText(result.messages, 41)).toBe(expected.listOldest);
      expect(toolText(result.messages, 42)).toBe(expected.listReady);
      expect(toolText(result.messages, 43)).toBe(expected.listDownloading);
      expect(toolText(result.messages, 44)).toBe(expected.listFailed);
      expect(toolText(result.messages, 45)).toBe(expected.listDate);
      expect(toolText(result.messages, 46)).toBe(expected.listDate);
      expect(toolText(result.messages, 55)).toBe(expected.listPageTwo);
      expect(toolText(result.messages, 47)).toBe(expected.readFull);
      expect(toolText(result.messages, 48)).toBe(expected.readFullNoTimestamps);
      expect(toolText(result.messages, 49)).toBe(expected.readRange);
      expect(toolText(result.messages, 50)).toBe(expected.searchBest);
      expect(toolText(result.messages, 51)).toBe(expected.searchOldest);
      expect(toolText(result.messages, 52)).toBe(expected.searchPageTwo);
      expect(toolText(result.messages, 53)).toBe(expected.searchDate);
      expect(toolText(result.messages, 54)).toBe(expected.searchDate);
    },
    outerTestBudget(1, 1),
  );
});
