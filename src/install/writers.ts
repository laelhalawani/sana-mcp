import {
  inspectAndRenderConfig,
  isOwnedConfigEntry,
  type ConfigOperation,
  type EntryBuilder,
  type FileConfigKind,
  type FormatChangeOptions,
} from "./config-formats.js";
import {
  publishConfigAtomic,
  readConfigSnapshot,
  type ConfigSnapshot,
} from "./atomic-config.js";
import { inspectLegacyConfigArtifacts } from "./legacy-config-artifacts.js";
import type { ServerTarget } from "./server-target.js";
import { boundedErrorText } from "./error-text.js";

export type {
  ConfigOperation,
  EntryBuilder,
  FileConfigKind,
} from "./config-formats.js";
export { isOwnedConfigEntry } from "./config-formats.js";

export type ConfigOwnership =
  | { state: "absent" }
  | { state: "owned" }
  | { state: "foreign"; reason: string }
  | { state: "unavailable"; reason: string };

export interface PlanFileChangeOptions {
  file: string;
  format: FileConfigKind;
  topKey?: string;
  name: string;
  target: ServerTarget;
  operation: ConfigOperation;
  build?: EntryBuilder;
}

export type FileChangePlan =
  | {
      state: "ready";
      file: string;
      operation: ConfigOperation;
      ownership: Extract<ConfigOwnership, { state: "absent" | "owned" }>;
      before: ConfigSnapshot;
      after: string;
      verification: PlanFileChangeOptions;
    }
  | {
      state: "noop";
      file: string;
      operation: ConfigOperation;
      ownership: Extract<ConfigOwnership, { state: "absent" | "owned" }>;
    }
  | {
      state: "collision";
      file: string;
      operation: ConfigOperation;
      ownership: Extract<ConfigOwnership, { state: "foreign" }>;
    }
  | {
      state: "unavailable";
      file: string;
      operation: ConfigOperation;
      ownership: Extract<ConfigOwnership, { state: "unavailable" }>;
    };

export type FileApplyResult =
  | {
      state: "applied";
      file: string;
      operation: ConfigOperation;
      durability: "verified" | "uncertain";
      warning?: string;
    }
  | { state: "noop"; file: string; operation: ConfigOperation }
  | { state: "collision"; file: string; reason: string }
  | { state: "unavailable"; file: string; reason: string }
  | { state: "conflict"; file: string; reason: string }
  | { state: "ambiguous"; file: string; reason: string }
  | { state: "failed"; file: string; reason: string };

const errorText = boundedErrorText;

function unavailable(
  options: Pick<PlanFileChangeOptions, "file" | "operation">,
  reason: string,
): Extract<FileChangePlan, { state: "unavailable" }> {
  return {
    state: "unavailable",
    file: options.file,
    operation: options.operation,
    ownership: { state: "unavailable", reason },
  };
}

function formatOptions(options: PlanFileChangeOptions): FormatChangeOptions {
  return {
    format: options.format,
    ...(options.topKey ? { topKey: options.topKey } : {}),
    name: options.name,
    target: options.target,
    operation: options.operation,
    ...(options.build ? { build: options.build } : {}),
  };
}

function legacyBlockReason(file: string): string | undefined {
  const legacy = inspectLegacyConfigArtifacts(file);
  if (legacy.state === "clear") return undefined;
  return legacy.reason;
}

export function inspectConfigOwnership(
  options: Omit<PlanFileChangeOptions, "operation">,
): ConfigOwnership {
  try {
    const blocked = legacyBlockReason(options.file);
    if (blocked) return { state: "unavailable", reason: blocked };
    const snapshot = readConfigSnapshot(options.file);
    return inspectAndRenderConfig(
      formatOptions({ ...options, operation: "register" }),
      snapshot.raw,
    ).ownership;
  } catch (error) {
    return { state: "unavailable", reason: errorText(error) };
  }
}

export function planFileChange(options: PlanFileChangeOptions): FileChangePlan {
  try {
    const blocked = legacyBlockReason(options.file);
    if (blocked) return unavailable(options, blocked);
    const before = readConfigSnapshot(options.file);
    const planned = inspectAndRenderConfig(formatOptions(options), before.raw);
    if (planned.ownership.state === "foreign")
      return {
        state: "collision",
        file: options.file,
        operation: options.operation,
        ownership: planned.ownership,
      };
    if (planned.after === undefined || planned.after === before.raw)
      return {
        state: "noop",
        file: options.file,
        operation: options.operation,
        ownership: planned.ownership,
      };
    return {
      state: "ready",
      file: options.file,
      operation: options.operation,
      ownership: planned.ownership,
      before,
      after: planned.after,
      verification: { ...options },
    };
  } catch (error) {
    return unavailable(options, errorText(error));
  }
}

export function applyFileChange(plan: FileChangePlan): FileApplyResult {
  if (plan.state === "noop")
    return { state: "noop", file: plan.file, operation: plan.operation };
  if (plan.state === "collision")
    return {
      state: "collision",
      file: plan.file,
      reason: plan.ownership.reason,
    };
  if (plan.state === "unavailable")
    return {
      state: "unavailable",
      file: plan.file,
      reason: plan.ownership.reason,
    };

  const blocked = legacyBlockReason(plan.file);
  if (blocked)
    return { state: "unavailable", file: plan.file, reason: blocked };

  const result = publishConfigAtomic(
    plan.file,
    plan.before,
    plan.after,
    (raw) => {
      try {
        const ownership = inspectAndRenderConfig(
          formatOptions(plan.verification),
          raw,
        ).ownership;
        const expected = plan.operation === "register" ? "owned" : "absent";
        return ownership.state === expected
          ? { ok: true }
          : {
              ok: false,
              reason:
                ownership.state === "foreign"
                  ? `${ownership.state}: ${ownership.reason}`
                  : `observed ownership state is ${ownership.state}`,
            };
      } catch (error) {
        return {
          ok: false,
          reason: `published config is invalid: ${errorText(error)}`,
        };
      }
    },
  );
  if (result.state === "published")
    return {
      state: "applied",
      file: plan.file,
      operation: plan.operation,
      durability: result.durability,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  return { state: result.state, file: plan.file, reason: result.reason };
}
