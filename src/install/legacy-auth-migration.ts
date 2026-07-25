import { SanaClient } from "../sana/client.js";
import { publishClientSession } from "../sana/session-publication.js";
import { SessionExpiredError } from "../sana/types.js";
import { SanaStore } from "../store/db.js";
import {
  CorruptJsonFileError,
  CorruptJsonPreservationError,
  JsonFileTooLargeError,
  SecurePathError,
} from "../runtime/secure-files.js";

export type LegacyAuthMigrationResult =
  | Readonly<{
      state: "not-needed";
      persistentStateTouched: false;
    }>
  | Readonly<{
      state: "preserved";
      persistentStateTouched: true;
    }>
  | Readonly<{
      state: "fresh-login-required";
      persistentStateTouched: true;
    }>
  | Readonly<{
      state: "validation-unavailable";
      persistentStateTouched: false;
    }>
  | Readonly<{
      state: "local-session-unavailable";
      persistentStateTouched: false;
    }>;

const LEGACY_SOURCE_VERSION = {
  generation: 0,
  publicationToken: null,
  userId: null,
  workspaceId: null,
} as const;

function publish(
  client: SanaClient,
  sourceVersion: Readonly<{
    generation: 0;
    publicationToken: null;
    userId: null;
    workspaceId: null;
  }>,
  kind: "login" | "reset" = "login",
): void {
  const store = new SanaStore();
  try {
    publishClientSession(store, client, kind, sourceVersion);
  } finally {
    store.close();
  }
}

function publishSignedOut(
  sourceVersion: Readonly<{
    generation: 0;
    publicationToken: null;
    userId: null;
    workspaceId: null;
  }>,
): LegacyAuthMigrationResult {
  publish(new SanaClient(), sourceVersion, "reset");
  return {
    state: "fresh-login-required",
    persistentStateTouched: true,
  };
}

/**
 * Revalidate an old origin-less Sana cookie and publish it through the current
 * generation/CAS protocol. No legacy workspace or user identifier is trusted.
 */
export async function migrateLegacyAuthentication(): Promise<LegacyAuthMigrationResult> {
  let input: ReturnType<typeof SanaClient.loadPre1SessionForMigration>;
  try {
    input = SanaClient.loadPre1SessionForMigration();
  } catch (error) {
    if (error instanceof CorruptJsonFileError) {
      return publishSignedOut(LEGACY_SOURCE_VERSION);
    }
    if (
      error instanceof CorruptJsonPreservationError ||
      error instanceof JsonFileTooLargeError ||
      error instanceof SecurePathError
    ) {
      return {
        state: "local-session-unavailable",
        persistentStateTouched: false,
      };
    }
    throw error;
  }
  if (input.kind === "not-needed") {
    return { state: "not-needed", persistentStateTouched: false };
  }
  if (input.kind === "fresh-login-required") {
    return publishSignedOut(input.sourceVersion);
  }

  try {
    await input.client.me();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return publishSignedOut(input.sourceVersion);
    }
    return {
      state: "validation-unavailable",
      persistentStateTouched: false,
    };
  }

  publish(input.client, input.sourceVersion);
  return { state: "preserved", persistentStateTouched: true };
}

export function serializeLegacyAuthMigrationResult(
  result: LegacyAuthMigrationResult,
): string {
  return [
    "migrationProtocol=1",
    `state=${result.state}`,
    `persistentStateTouched=${String(result.persistentStateTouched)}`,
    "",
  ].join("\n");
}
