// Login helpers layered over sana/auth.ts: the code request/verify side-effects
// plus waitForSync. Presentation-agnostic (no display strings).
import type { SanaStore } from "../store/db.js";
import { RUNTIME_ENV } from "../runtime/env.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The meeting count only appears after the daemon's brief "listing" phase.
// Wait up to half the 60s MCP default so login can report it, but never risk
// the client's request timeout.
export const COUNT_WAIT_MS = RUNTIME_ENV.countWaitMs;

export interface WaitResult {
  done: boolean;
  cacheReady: boolean;
  count: number | null;
  phase: ReturnType<SanaStore["getSyncState"]>["phase"];
}

/**
 * Wait (up to timeoutMs) for the login-triggered sync to finish, tracking how
 * many items remain. Cache readiness is separate from full artifact completion.
 */
export async function waitForSync(store: SanaStore, timeoutMs: number): Promise<WaitResult> {
  const end = Date.now() + timeoutMs;
  let count: number | null = null;
  for (;;) {
    const s = store.getSyncState();
    if (s.phase === "synced" && s.blocking !== 1) {
      return { done: true, cacheReady: true, count: 0, phase: s.phase };
    }
    if (s.phase === "downloading") {
      count = Math.max(
        0,
        store.countMeetings() - store.countMeetings({ status: "ready" }),
      );
    }
    if (s.blocking !== 1) {
      return { done: false, cacheReady: true, count, phase: s.phase };
    }
    if (s.phase === "needs_login" || s.phase === "error") {
      return { done: false, cacheReady: false, count, phase: s.phase };
    }
    if (Date.now() >= end) {
      return { done: false, cacheReady: false, count, phase: s.phase };
    }
    await sleep(300);
  }
}

export {
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  RequestCodeLocalTransitionError,
  RequestCodePreflightError,
  RequestCodeRemoteError,
  VerifyCodeLocalTransitionError,
  VerifyCodePreflightError,
  VerifyCodeRemoteError,
  StaleSessionWriterError,
  requestCode,
  verifyCode,
  type LoginResult,
} from "../sana/auth.js";
