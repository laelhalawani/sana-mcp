import { expect, mock, test } from "bun:test";

const launchFailure = new Error("daemon did not become ready");
const operationToken = "11111111-1111-4111-8111-111111111111";
let daemonReady = false;
const launchCalls: string[] = [];

mock.module("../../src/sync/spawn.js", () => ({
  ensureDaemonRunning: async () => {
    launchCalls.push("ensure");
    if (!daemonReady) throw launchFailure;
    return { alreadyRunning: false, spawned: true };
  },
}));

const {
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  StaleSessionWriterError,
  VerifyCodeLocalTransitionError,
  VerifyCodePreflightError,
  VerifyCodeRemoteError,
  verifyCode,
} = await import("../../src/sana/auth.js");
const {
  NoPendingLoginError,
  SignInChallengeRejectedError,
} = await import("../../src/sana/client.js");

function loginClient(calls: string[], saveError?: Error) {
  let version = {
    generation: 0,
    publicationToken: null as string | null,
    userId: null as string | null,
    workspaceId: null as string | null,
  };
  return {
    workspaceId: "workspace-authoritative",
    submitSignInCode: async () => {
      calls.push("submit");
      version = {
        ...version,
        userId: "user-authoritative",
        workspaceId: "workspace-authoritative",
      };
      return { id: "user-authoritative" };
    },
    sessionVersion: () => version,
    savePublication: (generation: number, token: string) => {
      calls.push("save");
      version = {
        generation,
        publicationToken: token,
        userId: "user-authoritative",
        workspaceId: "workspace-authoritative",
      };
      if (saveError) throw saveError;
    },
  };
}

function publicationStore(
  calls: string[],
  options: {
    claim?: "acquired" | "busy";
    confirm?: "confirmed" | "not-current" | Error;
    record?: "recorded" | "stale" | Error;
  } = {},
) {
  return {
    claimAuthPublication: () => {
      calls.push("blocking");
      return options.claim === "busy"
        ? { kind: "busy", ownerPid: 4242 }
        : {
            kind: "acquired",
            intent: {
              operationToken,
              targetGeneration: 1,
            ownerPid: process.pid,
            kind: "login",
            userId: "user-authoritative",
            workspaceId: "workspace-authoritative",
            sourceGeneration: 0,
            sourcePublicationToken: null,
            sourceUserId: null,
            sourceWorkspaceId: null,
            },
          };
    },
    confirmAuthPublication: () => {
      calls.push("confirm");
      if (options.confirm instanceof Error) throw options.confirm;
      return options.confirm ?? "confirmed";
    },
    markAuthPublicationIncomplete: () => {
      calls.push("release");
      return "released";
    },
    resetFailuresIfCurrent: () => {
      calls.push("reset");
      return "reset";
    },
    recordSyncUnavailableIfCurrent: () => {
      calls.push("record-unavailable");
      if (options.record instanceof Error) throw options.record;
      return options.record ?? "recorded";
    },
    clearSyncUnavailableIfCurrent: () => {
      calls.push("clear-unavailable");
      return "cleared";
    },
  };
}

test("daemon readiness failure is partial only after confirmed publication", async () => {
  daemonReady = false;
  launchCalls.length = 0;
  const calls: string[] = [];
  const result = await verifyCode(
    loginClient(calls) as never,
    publicationStore(calls) as never,
    "person@example.com",
    "123456",
  );

  expect(result.kind).toBe("sync-unavailable");
  if (result.kind === "sync-unavailable") {
    expect(result.failure.cause).toBe(launchFailure);
  }
  expect(calls).toEqual([
    "submit",
    "blocking",
    "save",
    "confirm",
    "reset",
    "record-unavailable",
  ]);
  expect(launchCalls).toEqual(["ensure"]);
});

test("sync-status persistence failure does not revoke a confirmed login", async () => {
  daemonReady = false;
  launchCalls.length = 0;
  const calls: string[] = [];
  const persistenceFailure = new Error("sync status database write failed");
  const result = await verifyCode(
    loginClient(calls) as never,
    publicationStore(calls, { record: persistenceFailure }) as never,
    "person@example.com",
    "123456",
  );

  expect(result.kind).toBe("sync-unavailable");
  if (result.kind !== "sync-unavailable") return;
  expect(result.confirmation).toEqual({
    generation: 1,
    publicationToken: operationToken,
    userId: "user-authoritative",
    workspaceId: "workspace-authoritative",
  });
  expect(result.failure.cause).toBe(launchFailure);
  expect(result.failure.persistence?.cause).toBe(persistenceFailure);
  expect(calls).toEqual([
    "submit",
    "blocking",
    "save",
    "confirm",
    "reset",
    "record-unavailable",
  ]);
});

test("superseded login never returns partial success after stale issue persistence", async () => {
  daemonReady = false;
  launchCalls.length = 0;
  const calls: string[] = [];
  await expect(
    verifyCode(
      loginClient(calls) as never,
      publicationStore(calls, { record: "stale" }) as never,
      "person@example.com",
      "123456",
    ),
  ).rejects.toBeInstanceOf(StaleSessionWriterError);
  expect(calls).toContain("record-unavailable");
});

test("successful login blocks before save and confirms before sync", async () => {
  daemonReady = true;
  launchCalls.length = 0;
  const calls: string[] = [];
  const result = await verifyCode(
    loginClient(calls) as never,
    publicationStore(calls) as never,
    "person@example.com",
    "123456",
  );

  expect(result).toEqual({
    kind: "ready",
    user: { id: "user-authoritative" },
    workspaceId: "workspace-authoritative",
    confirmation: {
      generation: 1,
      publicationToken: operationToken,
      userId: "user-authoritative",
      workspaceId: "workspace-authoritative",
    },
  });
  expect(calls).toEqual([
    "submit",
    "blocking",
    "save",
    "confirm",
    "reset",
    "clear-unavailable",
  ]);
  expect(launchCalls).toEqual(["ensure"]);
});

test("verify failures distinguish preflight, rejection, and unknown remote outcome", async () => {
  const cases = [
    {
      error: new NoPendingLoginError("no pending challenge"),
      type: VerifyCodePreflightError,
      remoteAccepted: false,
    },
    {
      error: new SignInChallengeRejectedError("challenge rejected"),
      type: VerifyCodeRemoteError,
      remoteAccepted: false,
    },
    {
      error: new Error("connection reset after submit"),
      type: VerifyCodeRemoteError,
      remoteAccepted: "unknown",
    },
  ] as const;

  for (const scenario of cases) {
    let caught: unknown;
    try {
      await verifyCode(
        {
          sessionVersion: () => ({
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          }),
          submitSignInCode: async () => {
            throw scenario.error;
          },
        } as never,
        {} as never,
        "person@example.com",
        "123456",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(scenario.type);
    expect(
      (caught as VerifyCodePreflightError | VerifyCodeRemoteError)
        .remoteAccepted,
    ).toBe(scenario.remoteAccepted);
  }
});

test("a live publication owner prevents a stale login save", async () => {
  daemonReady = true;
  launchCalls.length = 0;
  const calls: string[] = [];
  let caught: unknown;
  try {
    await verifyCode(
      loginClient(calls) as never,
      publicationStore(calls, { claim: "busy" }) as never,
      "person@example.com",
      "123456",
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AuthPublicationBusyError);
  expect(calls).toEqual(["submit", "blocking"]);
  expect(launchCalls).toEqual([]);
});

test("uncertain session persistence releases exact owner and stays typed", async () => {
  daemonReady = true;
  launchCalls.length = 0;
  const calls: string[] = [];
  const saveError = new Error("atomic session publication uncertain");
  let caught: unknown;
  try {
    await verifyCode(
      loginClient(calls, saveError) as never,
      publicationStore(calls) as never,
      "person@example.com",
      "123456",
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AuthTransitionIncompleteError);
  expect((caught as Error).cause).toBe(saveError);
  expect(calls).toEqual(["submit", "blocking", "save", "release"]);
  expect(launchCalls).toEqual([]);
});

test("confirmation SQL failure is transition-incomplete, never partial success", async () => {
  daemonReady = true;
  launchCalls.length = 0;
  const calls: string[] = [];
  const confirmError = new Error("confirm SQL failed");
  let caught: unknown;
  try {
    await verifyCode(
      loginClient(calls) as never,
      publicationStore(calls, { confirm: confirmError }) as never,
      "person@example.com",
      "123456",
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AuthTransitionIncompleteError);
  expect((caught as Error).cause).toBe(confirmError);
  expect(calls).toEqual([
    "submit",
    "blocking",
    "save",
    "confirm",
    "release",
  ]);
  expect(launchCalls).toEqual([]);
});
