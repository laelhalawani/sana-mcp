import { expect, mock, test } from "bun:test";

const operationToken = "11111111-1111-4111-8111-111111111111";
let storeConstructionFailure: unknown;
let publicationBusy = false;
let cleanupFailure: unknown;
let storeConstructions = 0;

class TestStore {
  constructor() {
    storeConstructions++;
    if (storeConstructionFailure !== undefined) {
      throw storeConstructionFailure;
    }
  }

  claimAuthPublication() {
    if (publicationBusy) return { kind: "busy", ownerPid: 4242 };
    return {
      kind: "acquired",
      intent: {
        operationToken,
        targetGeneration: 1,
        ownerPid: process.pid,
        kind: "request-code",
        userId: null,
        workspaceId: null,
        sourceGeneration: 0,
        sourcePublicationToken: null,
        sourceUserId: null,
        sourceWorkspaceId: null,
      },
    };
  }

  confirmAuthPublication() {
    return "confirmed";
  }

  markAuthPublicationIncomplete() {
    return "released";
  }

  close() {
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
}

mock.module("../../src/store/db.js", () => ({
  SanaStore: TestStore,
}));

mock.module("../../src/sync/spawn.js", () => ({
  ensureDaemonRunning: async () => ({
    alreadyRunning: true,
    spawned: false,
  }),
}));

const {
  RequestCodeLocalTransitionError,
  RequestCodePreflightError,
  RequestCodeRemoteError,
  requestCode,
} = await import("../../src/sana/auth.js");
const {
  SanaHttpError,
  SanaInputValidationError,
} = await import("../../src/sana/client.js");

function client(remoteFailure?: unknown) {
  let version = {
    generation: 0,
    publicationToken: null as string | null,
    userId: null as string | null,
    workspaceId: null as string | null,
  };
  return {
    requestSignInCode: async () => {
      if (remoteFailure !== undefined) throw remoteFailure;
    },
    sessionVersion: () => version,
    savePublication: (generation: number, token: string) => {
      version = {
        generation,
        publicationToken: token,
        userId: null,
        workspaceId: null,
      };
    },
  };
}

test("request-code remote rejection is distinct from any local transition", async () => {
  storeConstructions = 0;
  storeConstructionFailure = undefined;
  publicationBusy = false;
  cleanupFailure = undefined;
  const remoteFailure = new SanaHttpError(
    "user.sendSignInLink",
    400,
    "Sana rejected request",
  );
  let caught: unknown;
  try {
    await requestCode(
      client(remoteFailure) as never,
      "person@example.test",
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RequestCodeRemoteError);
  expect((caught as RequestCodeRemoteError).remoteAccepted).toBe(false);
  expect((caught as Error).cause).toBe(remoteFailure);
  expect(storeConstructions).toBe(0);
});

test("request-code preserves omitted versus explicitly undefined workspace", async () => {
  storeConstructions = 0;
  const observed: unknown[][] = [];
  const presenceClient = {
    ...client(),
    requestSignInCode: async (...args: unknown[]) => {
      observed.push(args);
      throw new SanaInputValidationError("stop before network");
    },
  };

  for (const invoke of [
    () => requestCode(presenceClient as never, "person@example.test"),
    () =>
      requestCode(
        presenceClient as never,
        "person@example.test",
        undefined as never,
      ),
  ]) {
    let caught: unknown;
    try {
      await invoke();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestCodePreflightError);
  }

  expect(observed).toEqual([
    ["person@example.test"],
    ["person@example.test", undefined],
  ]);
  expect(storeConstructions).toBe(0);
});

test("cleanup-only failure reports remote and publication success", async () => {
  storeConstructions = 0;
  storeConstructionFailure = undefined;
  publicationBusy = false;
  cleanupFailure = new Error("close failed");
  let caught: unknown;
  try {
    await requestCode(client() as never, "person@example.test");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RequestCodeLocalTransitionError);
  const typed = caught as RequestCodeLocalTransitionError;
  expect(typed.remoteAccepted).toBe(true);
  expect(typed.failures.publication).toBeUndefined();
  expect(typed.failures.cleanup).toBe(cleanupFailure);
});

test("accepted remote request preserves publication and cleanup failures", async () => {
  publicationBusy = true;
  cleanupFailure = new Error("close failed too");
  let caught: unknown;
  try {
    await requestCode(client() as never, "person@example.test");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RequestCodeLocalTransitionError);
  const typed = caught as RequestCodeLocalTransitionError;
  expect(typed.failures.publication).toBeDefined();
  expect(typed.failures.cleanup).toBe(cleanupFailure);
  expect((typed as Error).cause).toBeInstanceOf(AggregateError);
});
