import type { ClientDef } from "./clients.js";
import type { ConfigPathProvenance } from "./apply.js";
import type { ServerTarget } from "./server-target.js";
import {
  inspectConfigOwnership,
  type ConfigOwnership,
} from "./writers.js";

export type RegistrationStatus = ConfigOwnership & ConfigPathProvenance;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Inspect a client's file registration without launching a subprocess. */
export async function registrationStatus(
  client: ClientDef,
  name: string,
  target: ServerTarget
): Promise<RegistrationStatus> {
  let resolution: ReturnType<typeof client.install.path>;
  try {
    resolution = client.install.path();
  } catch (error) {
    const reason = `client config path resolution failed: ${errorText(error)}`;
    return {
      state: "unavailable",
      reason,
      pathState: "unavailable",
      pathUnavailableReason: reason,
    };
  }
  if (resolution.state === "unavailable")
    return {
      state: "unavailable",
      reason: resolution.reason,
      pathState: "unavailable",
      pathUnavailableReason: resolution.reason,
    };
  const ownership = inspectConfigOwnership({
    file: resolution.path,
    format: client.install.format,
    topKey: client.install.topKey,
    name,
    target,
    build: client.install.build,
  });
  return { ...ownership, pathState: "known", file: resolution.path };
}
