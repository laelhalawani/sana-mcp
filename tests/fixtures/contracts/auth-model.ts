export const contractUserId = ["user", "contract"].join("-");
export const contractWorkspaceId = ["workspace", "contract"].join("-");
export const initialPublicationToken = [
  "22222222",
  "2222",
  "4222",
  "8222",
  "222222222222",
].join("-");
export const confirmedPublicationToken = [
  "33333333",
  "3333",
  "4333",
  "8333",
  "333333333333",
].join("-");

const events: string[] = [];
let catchupCompletionRequested = false;
const cacheIdentity = {
  userId: contractUserId,
  workspaceId: contractWorkspaceId,
};
const pendingPublications: Array<Record<string, unknown>> = [];

export function recordContractEvent(event: string): void {
  events.push(event);
}

export function contractEvents(): readonly string[] {
  return [...events];
}

export function currentContractCacheIdentity(): Readonly<{
  userId: string;
  workspaceId: string;
}> {
  return { ...cacheIdentity };
}

export function publishContractCacheIdentity(
  userId: string,
  workspaceId: string,
): void {
  cacheIdentity.userId = userId;
  cacheIdentity.workspaceId = workspaceId;
}

export function mutateContractCacheIdentity(event: string): void {
  cacheIdentity.userId = ["user", "cache-race"].join("-");
  cacheIdentity.workspaceId = ["workspace", "cache-race"].join("-");
  recordContractEvent(`cache-mutation:${event}`);
}

export function recordContractPendingPublication(
  snapshot: Record<string, unknown>,
): void {
  pendingPublications.push({ ...snapshot });
}

export function contractPendingPublications(): readonly Record<
  string,
  unknown
>[] {
  return pendingPublications.map((snapshot) => ({ ...snapshot }));
}

export function requestContractCatchupCompletion(): void {
  catchupCompletionRequested = true;
}

export function consumeContractCatchupCompletion(): boolean {
  if (!catchupCompletionRequested) return false;
  catchupCompletionRequested = false;
  return true;
}
