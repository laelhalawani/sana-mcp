import { requestContractCatchupCompletion } from "./auth-model.js";

export async function ensureDaemonRunning(): Promise<void> {
  if (
    process.env.SANA_TEST_AUTH_SCENARIO === "daemon-launch-failure" ||
    process.env.SANA_TEST_AUTH_SCENARIO === "sync-unavailable" ||
    process.env.SANA_TEST_AUTH_SCENARIO === "sync-status-persistence-failed" ||
    process.env.SANA_TEST_AUTH_SCENARIO === "daemon-status-persistence-failed" ||
    process.env.SANA_TEST_AUTH_SCENARIO ===
      "daemon-status-persistence-with-previous"
  ) {
    const error = new Error("contract daemon launch failed") as Error & {
      code: string;
    };
    error.code = "DAEMON_START_FAILED";
    throw error;
  }
  requestContractCatchupCompletion();
}
