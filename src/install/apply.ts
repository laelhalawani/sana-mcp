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
