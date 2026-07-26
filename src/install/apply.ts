import path from "node:path";
import type { ClientDef } from "./clients.js";
import type { ServerTarget } from "./server-target.js";
import { validateServerName } from "./config-formats.js";
import {
  applyFileChange,
  planFileChange,
  type ConfigOperation,
  type FileChangePlan,
} from "./writers.js";

export type DesiredRegistration = "present" | "absent";

interface ClientChangeFields {
  clientId: string;
  clientName: string;
  serverName: string;
  desired: DesiredRegistration;
  operation: ConfigOperation;
}

export type ConfigPathProvenance =
  | { pathState: "known"; file: string }
  | { pathState: "unavailable"; pathUnavailableReason: string };

type ClientChangeBase = ClientChangeFields & ConfigPathProvenance;

export type ClientChange =
  | (ClientChangeBase & {
      state: "ready";
      transport: "file";
      plan: Extract<FileChangePlan, { state: "ready" }>;
    })
  | (ClientChangeBase & { state: "noop" })
  | (ClientChangeBase & { state: "collision"; reason: string })
  | (ClientChangeBase & { state: "unavailable"; reason: string });

export type ApplyResult =
  | (ClientChangeBase & {
      state: "applied";
      durability: "verified" | "uncertain";
      warning?: string;
    })
  | (ClientChangeBase & { state: "planned" | "noop" })
  | (ClientChangeBase & {
      state: "collision" | "unavailable" | "conflict" | "ambiguous" | "failed";
      reason: string;
    });

export interface ApplyOptions {
  dryRun?: boolean;
}

export interface ClientChangeRequest {
  client: ClientDef;
  serverName: string;
  target: ServerTarget;
  desired: DesiredRegistration;
}

export interface ConfigPathIdentityOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
}

export { validateServerName } from "./config-formats.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base(
  client: ClientDef,
  serverName: string,
  desired: DesiredRegistration
): ClientChangeFields {
  return {
    clientId: client.id,
    clientName: client.name,
    serverName,
    desired,
    operation: desired === "present" ? "register" : "remove",
  };
}

export async function planClientChange(
  client: ClientDef,
  serverName: string,
  target: ServerTarget,
  desired: DesiredRegistration
): Promise<ClientChange> {
  const common = base(client, serverName, desired);
  const install = client.install;
  let resolved: ReturnType<typeof install.path>;
  try {
    resolved = install.path();
  } catch (error) {
    const reason = `client config path resolution failed: ${errorText(error)}`;
    return {
      ...common,
      pathState: "unavailable",
      pathUnavailableReason: reason,
      state: "unavailable",
      reason,
    };
  }
  const provenance: ConfigPathProvenance =
    resolved.state === "available"
      ? { pathState: "known", file: resolved.path }
      : {
          pathState: "unavailable",
          pathUnavailableReason: resolved.reason,
        };
  try {
    validateServerName(serverName);
  } catch (error) {
    return {
      ...common,
      ...provenance,
      state: "unavailable",
      reason: errorText(error),
    };
  }
  if (resolved.state === "unavailable")
    return {
      ...common,
      ...provenance,
      state: "unavailable",
      reason: resolved.reason,
    };
  const planned = planFileChange({
    file: resolved.path,
    format: install.format,
    topKey: install.topKey,
    name: serverName,
    target,
    operation: common.operation,
    build: install.build,
    predecessors: install.predecessors,
  });
  const fileCommon = {
    ...common,
    pathState: "known" as const,
    file: planned.file,
  };
  if (planned.state === "ready")
    return {
      ...fileCommon,
      state: "ready",
      transport: "file",
      plan: planned,
    };
  if (planned.state === "noop") return { ...fileCommon, state: "noop" };
  if (planned.state === "collision")
    return {
      ...fileCommon,
      state: "collision",
      reason: planned.ownership.reason,
    };
  return {
    ...fileCommon,
    state: "unavailable",
    reason: planned.ownership.reason,
  };
}

function passiveResult(change: Exclude<ClientChange, { state: "ready" }>): ApplyResult {
  if (change.state === "noop") return { ...change };
  return { ...change };
}

export async function applyClientChange(
  change: ClientChange,
  options: ApplyOptions = {}
): Promise<ApplyResult> {
  if (change.state !== "ready") return passiveResult(change);
  const common = {
    clientId: change.clientId,
    clientName: change.clientName,
    serverName: change.serverName,
    desired: change.desired,
    operation: change.operation,
    pathState: "known" as const,
    file: change.plan.file,
  };
  if (options.dryRun) return { ...common, state: "planned" };

  const result = applyFileChange(change.plan);
  if (result.state === "applied")
    return {
      ...common,
      state: "applied",
      durability: result.durability,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  if (result.state === "noop") return { ...common, state: "noop" };
  return { ...common, state: result.state, reason: result.reason };
}

/**
 * Produce the deterministic identity used to reject aliases within one direct
 * config batch. This is lexical by design: config publication performs the
 * authoritative filesystem boundary checks.
 */
export function configPathIdentity(
  file: string,
  options: ConfigPathIdentityOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const cwd = options.cwd ?? process.cwd();
  const identity = pathApi.normalize(pathApi.resolve(cwd, file));
  return platform === "win32" ? identity.toLowerCase() : identity;
}

function duplicatePathFailure(
  change: ClientChange,
  reason: string,
): ClientChange {
  const common = {
    clientId: change.clientId,
    clientName: change.clientName,
    serverName: change.serverName,
    desired: change.desired,
    operation: change.operation,
  };
  return change.pathState === "known"
    ? {
        ...common,
        pathState: "known",
        file: change.file,
        state: "unavailable",
        reason,
      }
    : {
        ...common,
        pathState: "unavailable",
        pathUnavailableReason: change.pathUnavailableReason,
        state: "unavailable",
        reason,
      };
}

/**
 * Plan every requested direct client change before any caller can apply one.
 * The installer-only journaled transaction keeps its separate protocol.
 */
export async function planClientChanges(
  requests: readonly ClientChangeRequest[],
  identityOptions: ConfigPathIdentityOptions = {},
): Promise<readonly ClientChange[]> {
  const changes = await Promise.all(
    requests.map(({ client, serverName, target, desired }) =>
      planClientChange(client, serverName, target, desired)
    ),
  );
  const indicesByIdentity = new Map<string, number[]>();
  for (const [index, change] of changes.entries()) {
    if (change.pathState !== "known") continue;
    let identity: string;
    try {
      identity = configPathIdentity(change.file, identityOptions);
    } catch (error) {
      changes[index] = duplicatePathFailure(
        change,
        `client config path identity could not be determined: ${errorText(error)}`,
      );
      continue;
    }
    const indices = indicesByIdentity.get(identity);
    if (indices) indices.push(index);
    else indicesByIdentity.set(identity, [index]);
  }
  for (const indices of indicesByIdentity.values()) {
    if (indices.length < 2) continue;
    const clients = indices.map((index) => changes[index]!.clientName);
    const reason = `multiple selected clients resolve to the same config path: ${clients.join(", ")}`;
    for (const index of indices)
      changes[index] = duplicatePathFailure(changes[index]!, reason);
  }
  return changes;
}

/**
 * Apply a fully planned direct batch in request order. A known planning
 * failure keeps the whole batch read-only. Apply-time races remain observable
 * per client and may leave an earlier change applied; this is not a transaction.
 */
export async function applyPlannedClientChanges(
  changes: readonly ClientChange[],
  options: ApplyOptions = {},
): Promise<readonly ApplyResult[]> {
  const planningBlocked = changes.some(
    (change) =>
      change.state === "collision" || change.state === "unavailable",
  );
  const dryRun = options.dryRun === true || planningBlocked;
  const results: ApplyResult[] = [];
  for (const change of changes)
    results.push(await applyClientChange(change, { dryRun }));
  return results;
}
