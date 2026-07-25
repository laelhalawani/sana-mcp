import { verifyCode } from "../../../src/sana/auth.js";
import { SanaClient } from "./auth-client.js";
import {
  contractEvents,
  contractPendingPublications,
} from "./auth-model.js";
import { SanaStore } from "./auth-store.js";

const store = new SanaStore();
const selectState = (
  state: ReturnType<SanaStore["peekContractSyncState"]>,
) => ({
  auth_generation: state.auth_generation,
  auth_publication_token: state.auth_publication_token,
  auth_user_id: state.auth_user_id,
  auth_workspace_id: state.auth_workspace_id,
  auth_pending: state.auth_pending,
  auth_transition_pid: state.auth_transition_pid,
  auth_transition_token: state.auth_transition_token,
  auth_transition_generation: state.auth_transition_generation,
  auth_transition_kind: state.auth_transition_kind,
  auth_transition_user_id: state.auth_transition_user_id,
  auth_transition_workspace_id: state.auth_transition_workspace_id,
  auth_issue_code: state.auth_issue_code,
  auth_issue_message: state.auth_issue_message,
  auth_issue_operation_token: state.auth_issue_operation_token,
  auth_issue_generation: state.auth_issue_generation,
  auth_issue_kind: state.auth_issue_kind,
  catchup_generation: state.catchup_generation,
  blocking: state.blocking,
  cache_user_id: state.cache_user_id,
  cache_workspace_id: state.cache_workspace_id,
  sync_issue_code: state.sync_issue_code,
  sync_issue_cause: state.sync_issue_cause,
  sync_issue_message: state.sync_issue_message,
});

const initial = selectState(store.peekContractSyncState());
let result:
  | Awaited<ReturnType<typeof verifyCode>>
  | undefined;
let errorName: string | null = null;
try {
  result = await verifyCode(
    SanaClient.load(),
    store,
    "auth@example.invalid",
    "123456",
  );
} catch (error) {
  errorName = error instanceof Error ? error.name : "non-error";
}
const postVerify = selectState(store.peekContractSyncState());
if (result?.kind === "ready") {
  store.finishContractSyncCycle(result.confirmation);
}
const final = selectState(store.peekContractSyncState());

console.log(JSON.stringify({
  processPid: process.pid,
  result: result?.kind ?? null,
  errorName,
  generation: result?.confirmation.generation ?? null,
  initial,
  pending: contractPendingPublications(),
  postVerify,
  final,
  events: contractEvents(),
}));
