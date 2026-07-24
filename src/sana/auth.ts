// Structured login core shared by the MCP handler and the interactive CLI.
// Performs the side-effects (request code, verify code, stamp the catch-up
// sync, spawn the daemon) and returns typed results. No display strings: each
// caller renders its own audience-appropriate text.
import { SanaClient } from "./client.js";
import type { SanaUser } from "./types.js";
import { SanaStore } from "../store/db.js";
import { ensureDaemonRunning } from "../sync/spawn.js";

export interface LoginResult {
  user: SanaUser;
  workspaceId?: string;
}

/**
 * Step 1: request a 6-digit sign-in code by email. Wraps
 * client.requestSignInCode + client.save(). Throws on failure; the caller
 * renders the error in its own words.
 */
export async function requestCode(
  client: SanaClient,
  email: string,
  workspaceId?: string
): Promise<void> {
  await client.requestSignInCode(email, workspaceId);
  client.save();
}

/**
 * Step 2: verify the code and establish the session, then trigger a fresh
 * catch-up sync. This is the single home for the post-login side-effects that
 * both the MCP handler and the CLI depend on:
 *   - submit code + save session
 *   - resetFailures (retry previously-failed downloads)
 *   - blocking:1 + catchup_epoch_ms (hold data tools until caught up)
 *   - ensureDaemonRunning
 * Throws on a bad/expired code; the caller renders the error.
 */
export async function verifyCode(
  client: SanaClient,
  store: SanaStore,
  email: string,
  code: string
): Promise<LoginResult> {
  const user = await client.submitSignInCode(email, code);
  client.save();
  store.resetFailures();
  store.updateSyncState({ blocking: 1, catchup_epoch_ms: Date.now() });
  ensureDaemonRunning();
  return { user, workspaceId: client.workspaceId };
}
