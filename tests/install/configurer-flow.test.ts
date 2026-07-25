import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExitPromptError } from "@inquirer/core";
import type { TerminalEnvironment } from "../../src/app/ui.js";
import { stripTerminalSequences } from "../../src/app/render.js";
import type { ClientDef } from "../../src/install/clients.js";
import { SignInChallengeRejectedError } from "../../src/sana/client.js";
import {
  AuthPublicationBusyError,
  AuthTransitionIncompleteError,
  RequestCodeLocalTransitionError,
  RequestCodeRemoteError,
  StaleSessionWriterError,
  VerifyCodeLocalTransitionError,
  VerifyCodeRemoteError,
  type LoginResult,
} from "../../src/core/login.js";
import {
  ClientAuthenticationPartialError,
  ClientAuthenticationOperationError,
  ClientAuthenticationSessionCleanupError,
  ClientConfigurationIncompleteError,
  inspectStableConfigurerAuthState,
  runInstall,
  runUninstall,
  type ConfigurerAuthSession,
  type ConfigurerAuthState,
  type InstallInteraction,
} from "../../src/install/install.js";
import { serverTarget } from "../../src/install/server-target.js";
import { initialWizardDesiredState } from "../../src/install/wizard-prompt.js";
import type { SessionVersion, SyncState } from "../../src/store/db.js";

function terminal(
  env: TerminalEnvironment = { LANG: "C.UTF-8" },
  inputTTY = true,
  outputTTY = true
): NonNullable<InstallInteraction["terminal"]> {
  return {
    input: { isTTY: inputTTY },
    output: { isTTY: outputTTY, columns: 100, rows: 30, write() {} },
    env,
    platform: process.platform,
  };
}

function syncState(
  overrides: Partial<SyncState> = {}
): SyncState {
  return {
    phase: "idle",
    message: "",
    meetings_total: 0,
    transcripts_done: 0,
    transcripts_total: 0,
    last_full_sync_ms: null,
    last_incremental_ms: null,
    daemon_pid: null,
    daemon_heartbeat_ms: null,
    blocking: 1,
    catchup_epoch_ms: null,
    auth_pending: 0,
    auth_transition_pid: null,
    auth_generation: 1,
    auth_publication_token:
      "11111111-1111-4111-8111-111111111111",
    auth_user_id: "user-1",
    auth_workspace_id: "workspace-1",
    auth_transition_token: null,
    auth_transition_generation: null,
    auth_transition_kind: null,
    auth_transition_user_id: null,
    auth_transition_workspace_id: null,
    auth_issue_code: null,
    auth_issue_message: null,
    catchup_generation: null,
    cache_user_id: "user-1",
    cache_workspace_id: "workspace-1",
    sync_issue_code: null,
    sync_issue_cause: null,
    sync_issue_message: null,
    error: null,
    updated_ms: 0,
    ...overrides,
  };
}

function sessionClient(
  version: SessionVersion,
  hasCookie = true
) {
  const fullVersion: SessionVersion = {
    ...version,
    userId: version.userId ?? "user-1",
    workspaceId: version.workspaceId ?? "workspace-1",
  };
  return {
    sessionVersion: () => fullVersion,
    hasAuthCookie: () => hasCookie,
  };
}

function fixture(
  id: string,
  file: string,
  detection: ReturnType<ClientDef["detect"]>
): ClientDef {
  return {
    id,
    name: `Client ${id}`,
    detect: () => detection,
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "available", path: file }),
      topKey: "mcpServers",
    },
    reloadHint: "restart it",
  };
}

function fakeAuth(options: {
  loggedIn: boolean;
  authState?: ConfigurerAuthState;
  inspectError?: Error;
  requestError?: Error;
  verifyError?: Error;
  closeError?: Error;
  verifyResult?: LoginResult;
}) {
  const calls = {
    session: 0,
    request: [] as string[],
    verify: [] as Array<[string, string]>,
    close: 0,
  };
  const session: ConfigurerAuthSession = {
    inspect() {
      calls.session += 1;
      if (options.inspectError) throw options.inspectError;
      return (
        options.authState ?? {
          kind: options.loggedIn ? "ready" : "signed-out",
          generation: options.loggedIn ? 1 : 0,
          session: {
            hasCookie: options.loggedIn,
            loggedIn: options.loggedIn,
            expired: false,
          },
        }
      );
    },
    async requestCode(email) {
      calls.request.push(email);
      if (options.requestError) throw options.requestError;
    },
    async verifyCode(email, code) {
      calls.verify.push([email, code]);
      if (options.verifyError) throw options.verifyError;
      return options.verifyResult ?? {
        kind: "ready",
        user: { id: "user-1", email },
        workspaceId: "workspace-1",
        confirmation: {
          generation: 1,
          publicationToken:
            "11111111-1111-4111-8111-111111111111",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
      };
    },
    close() {
      calls.close += 1;
      if (options.closeError) throw options.closeError;
    },
  };
  return { session, calls };
}

function interaction(
  clients: readonly ClientDef[],
  output: string[],
  additions: Partial<InstallInteraction> = {}
): InstallInteraction {
  return {
    clients,
    terminal: terminal(),
    writeLine: (line) => output.push(line),
    prompt: async ({ rows }) => ({
      submitted: true,
      desired: Object.fromEntries(rows.map((row) => [row.id, true])),
    }),
    ...additions,
  };
}

test("interactive structured login handles logged-in and logged-out sessions without network", async () => {
  for (const loggedIn of [true, false]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-configurer-auth-")
    );
    const file = path.join(root, "client.json");
    const client = fixture("present", file, {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    const auth = fakeAuth({ loggedIn });
    const answers = ["person@example.test", "123456"];
    try {
      await runInstall(
        {},
        interaction([client], output, {
          terminal: terminal({ NO_COLOR: "" }),
          openAuthSession: () => auth.session,
          confirm: async () => true,
          input: async () => answers.shift() ?? "",
        })
      );
      assert.equal(auth.calls.session, 1);
      assert.equal(auth.calls.close, 1);
      assert.deepEqual(
        auth.calls.request,
        loggedIn ? [] : ["person@example.test"]
      );
      assert.deepEqual(
        auth.calls.verify,
        loggedIn ? [] : [["person@example.test", "123456"]]
      );
      assert.match(
        output.join("\n"),
        loggedIn ? /Already signed in to Sana/u : /Signed in as person@example\.test/u
      );
      assert.doesNotMatch(output.join("\n"), /meeting_transcripts\(|your agent/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("structured login failure is typed, human-readable, and closes local state", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-auth-failure-")
  );
  const file = path.join(root, "client.json");
  const client = fixture("present", file, {
    state: "present",
    evidence: [root],
  });
  const output: string[] = [];
  const auth = fakeAuth({
    loggedIn: false,
    requestError: new Error("service unavailable"),
  });
  try {
    await assert.rejects(
      runInstall(
        {},
        interaction([client], output, {
          terminal: terminal({ NO_COLOR: "" }),
          openAuthSession: () => auth.session,
          confirm: async () => true,
          input: async () => "person@example.test",
        })
      ),
      ClientConfigurationIncompleteError
    );
    assert.equal(auth.calls.close, 1);
    assert.match(output.join("\n"), /sign-in code could not be requested/u);
    assert.match(output.join("\n"), /service unavailable/u);
    assert.doesNotMatch(
      output.join("\n"),
      /Client configuration and Sana sign-in are ready/u
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("simultaneous login and close failures render every cause and retain the aggregate", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-auth-aggregate-")
  );
  const client = fixture("present", path.join(root, "client.json"), {
    state: "present",
    evidence: [root],
  });
  const output: string[] = [];
  const closeError = new Error("close\n\u001b[32mfailed");
  const auth = fakeAuth({
    loggedIn: false,
    requestError: new Error("request\n\u001b[31mfailed"),
    closeError,
  });
  let observed: ClientConfigurationIncompleteError | undefined;
  try {
    await assert.rejects(
      runInstall(
        {},
        interaction([client], output, {
          terminal: terminal({ NO_COLOR: "" }),
          openAuthSession: () => auth.session,
          confirm: async () => true,
          input: async () => "person@example.test",
        })
      ),
      (error: unknown) => {
        if (error instanceof ClientConfigurationIncompleteError) {
          observed = error;
          return true;
        }
        return false;
      }
    );
    assert.equal(auth.calls.close, 1);
    assert.ok(observed?.cause instanceof AggregateError);
    const causes = [...(observed!.cause as AggregateError).errors];
    assert.ok(causes[0] instanceof ClientAuthenticationOperationError);
    assert.equal(
      (causes[0] as ClientAuthenticationOperationError).operation,
      "request-code"
    );
    assert.equal(
      (
        (causes[0] as ClientAuthenticationOperationError).cause as Error
      ).message,
      "request\n\u001b[31mfailed"
    );
    assert.ok(causes[1] instanceof ClientAuthenticationSessionCleanupError);
    assert.equal(
      (causes[1] as ClientAuthenticationSessionCleanupError).cause,
      closeError
    );
    const rendered = output.join("\n");
    assert.match(rendered, /request failed/u);
    assert.match(rendered, /close failed/u);
    assert.doesNotMatch(rendered, /\u001b\[3[12]m/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("authentication session cleanup failures remain typed and describe the completed outcome truthfully", async () => {
  for (const mode of ["signed-in", "already-signed-in", "skipped"] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-configurer-auth-cleanup-")
    );
    const client = fixture("present", path.join(root, "client.json"), {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    const closeCause =
      mode === "signed-in"
        ? new AggregateError(
            [
              new Error("database handle busy"),
              new AggregateError(
                [new Error("permission repair failed")],
                "close follow-up failed"
              ),
            ],
            "store close failed"
          )
        : new Error("store close failed");
    const auth = fakeAuth({
      loggedIn: mode === "already-signed-in",
      closeError: closeCause,
    });
    const answers = ["person@example.test", "123456"];
    let observed: ClientConfigurationIncompleteError | undefined;
    try {
      await assert.rejects(
        runInstall(
          {},
          interaction([client], output, {
            terminal: terminal({ NO_COLOR: "" }),
            openAuthSession: () => auth.session,
            confirm: async () => mode !== "skipped",
            input: async () => answers.shift() ?? "",
          })
        ),
        (error: unknown) => {
          if (error instanceof ClientConfigurationIncompleteError) {
            observed = error;
            return true;
          }
          return false;
        }
      );
      assert.ok(
        observed?.cause instanceof ClientAuthenticationSessionCleanupError
      );
      const cleanup =
        observed!.cause as ClientAuthenticationSessionCleanupError;
      assert.equal(cleanup.outcome, mode);
      assert.equal(cleanup.cause, closeCause);
      const rendered = output.join("\n");
      assert.match(rendered, /authentication session cleanup failed/u);
      if (mode === "signed-in") {
        assert.match(rendered, /sign-in succeeded/u);
        assert.match(rendered, /database handle busy/u);
        assert.match(rendered, /permission repair failed/u);
        assert.equal(rendered.match(/store close failed/gu)?.length, 1);
      } else if (mode === "already-signed-in") {
        assert.match(rendered, /was already signed in/u);
      } else {
        assert.match(rendered, /sign-in was skipped/u);
      }
      assert.doesNotMatch(rendered, /sign-in could not be completed/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("sync-unavailable login is a truthful typed partial outcome and never claims sync started", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-auth-partial-")
  );
  const client = fixture("present", path.join(root, "client.json"), {
    state: "present",
    evidence: [root],
  });
  const output: string[] = [];
  const syncCause = new AggregateError(
    [
      new Error("daemon refused"),
      new AggregateError(
        [new Error("socket closed"), "retry exhausted"],
        "worker startup failed"
      ),
    ],
    "sync launch failed"
  );
  const persistenceCause = new Error("status write failed");
  const auth = fakeAuth({
    loggedIn: false,
    verifyResult: {
      kind: "sync-unavailable",
      user: { id: "user-1", email: "person@example.test" },
      workspaceId: "workspace-1",
      confirmation: {
        generation: 2,
        publicationToken:
          "22222222-2222-4222-8222-222222222222",
        userId: "user-1",
        workspaceId: "workspace-1",
      },
      failure: {
        code: "LOGIN_SYNC_UNAVAILABLE",
        message: "sync launch failed",
        cause: syncCause,
        persistence: {
          code: "SYNC_STATUS_PERSISTENCE_FAILED",
          message: "status write failed",
          cause: persistenceCause,
        },
      },
    },
  });
  const answers = ["person@example.test", "123456"];
  let observed: ClientConfigurationIncompleteError | undefined;
  try {
    await assert.rejects(
      runInstall(
        {},
        interaction([client], output, {
          terminal: terminal({ NO_COLOR: "" }),
          openAuthSession: () => auth.session,
          confirm: async () => true,
          input: async () => answers.shift() ?? "",
        })
      ),
      (error: unknown) => {
        if (error instanceof ClientConfigurationIncompleteError) {
          observed = error;
          return true;
        }
        return false;
      }
    );
    assert.ok(observed?.cause instanceof ClientAuthenticationPartialError);
    assert.equal(
      (observed!.cause as ClientAuthenticationPartialError).cause,
      syncCause
    );
    assert.equal(
      (observed!.cause as ClientAuthenticationPartialError).confirmation
        .userId,
      "user-1"
    );
    assert.equal(
      (observed!.cause as ClientAuthenticationPartialError).failure
        .persistence?.cause,
      persistenceCause
    );
    const rendered = output.join("\n");
    assert.match(rendered, /Signed in as person@example\.test/u);
    assert.match(rendered, /meeting sync is unavailable/u);
    assert.match(rendered, /workspace workspace-1/u);
    assert.match(rendered, /Authentication generation 2 is confirmed/u);
    assert.match(rendered, /local meeting cache remains blocked/u);
    assert.match(rendered, /daemon refused/u);
    assert.match(rendered, /worker startup failed/u);
    assert.match(rendered, /socket closed/u);
    assert.match(rendered, /retry exhausted/u);
    assert.match(rendered, /sync-unavailable status could not be persisted/u);
    assert.match(rendered, /status write failed/u);
    assert.equal(rendered.match(/sync launch failed/gu)?.length, 1);
    assert.doesNotMatch(rendered, /meetings are syncing|check progress/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("authentication publication errors use structured human messages without false readiness claims", async () => {
  for (const operation of ["request-code", "verify-code"] as const) {
    for (const transition of [
      new AuthTransitionIncompleteError(
        "AUTH_PUBLICATION_CONFIRMATION_FAILED",
        "core publication detail",
        { cause: new Error("database unavailable") }
      ),
      new AuthPublicationBusyError(4321),
      new StaleSessionWriterError(7),
    ]) {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "sana-configurer-transition-")
      );
      const client = fixture("present", path.join(root, "client.json"), {
        state: "present",
        evidence: [root],
      });
      const output: string[] = [];
      const requestFailure =
        new RequestCodeLocalTransitionError({
          publication: transition,
        });
      const verifyFailure =
        new VerifyCodeLocalTransitionError({
          publication: transition,
        });
      const auth = fakeAuth({
        loggedIn: false,
        ...(operation === "request-code"
          ? { requestError: requestFailure }
          : { verifyError: verifyFailure }),
      });
      const answers = ["person@example.test", "123456"];
      let observed: ClientConfigurationIncompleteError | undefined;
      try {
        await assert.rejects(
          runInstall(
            {},
            interaction([client], output, {
              terminal: terminal({ NO_COLOR: "" }),
              openAuthSession: () => auth.session,
              confirm: async () => true,
              input: async () => answers.shift() ?? "",
            })
          ),
          (error: unknown) => {
            if (error instanceof ClientConfigurationIncompleteError) {
              observed = error;
              return true;
            }
            return false;
          }
        );
        assert.ok(
          observed?.cause instanceof ClientAuthenticationOperationError
        );
        assert.equal(
          (observed!.cause as ClientAuthenticationOperationError).operation,
          operation
        );
        assert.equal(
          (observed!.cause as ClientAuthenticationOperationError).cause,
          operation === "request-code" ? requestFailure : verifyFailure
        );
        const rendered = output.join("\n");
        if (transition instanceof AuthTransitionIncompleteError) {
          assert.match(rendered, /authentication transition is incomplete/u);
          assert.match(rendered, /AUTH_PUBLICATION_CONFIRMATION_FAILED/u);
          assert.match(rendered, /database unavailable/u);
        } else if (transition instanceof AuthPublicationBusyError) {
          assert.match(rendered, /another local authentication transition/u);
          assert.match(rendered, /process 4321/u);
        } else {
          assert.match(
            rendered,
            /superseded by authentication generation 7/u
          );
        }
        if (operation === "request-code") {
          assert.match(rendered, /accepted the sign-in code request/u);
          assert.doesNotMatch(rendered, /accepted the code/u);
        } else {
          assert.match(rendered, /accepted the code/u);
          assert.match(
            rendered,
            /meeting sync (?:was not started|were not confirmed)/u
          );
        }
        assert.doesNotMatch(rendered, /core publication detail/u);
        assert.doesNotMatch(
          rendered,
          /Signed in as|meetings are syncing|Sana sign-in are ready/u
        );
        assert.doesNotMatch(rendered, /meeting_transcripts\(|your agent/u);
      } finally {
        fs.rmSync(root, { recursive: true });
      }
    }
  }
});

test("request-code rendering distinguishes remote rejection from accepted local-transition failure", async () => {
  for (const scenario of [
    {
      name: "remote-rejected",
      error: new RequestCodeRemoteError(
        new SignInChallengeRejectedError("request rejected")
      ),
      expected: /rejected the sign-in code request: request rejected/u,
      forbidden: /accepted the sign-in code request/u,
    },
    {
      name: "remote-unknown",
      error: new RequestCodeRemoteError(new Error("network reset")),
      expected: /remote outcome of the sign-in code request is unknown: network reset/u,
      forbidden: /Sana (?:rejected|accepted) the sign-in code request/u,
    },
    {
      name: "local-store-open",
      error: new RequestCodeLocalTransitionError({
        store: new Error("store unavailable"),
      }),
      expected: /local session publication could not begin because the authentication store could not be opened: store unavailable/u,
      forbidden: /did not accept the sign-in code request/u,
    },
    {
      name: "cleanup-only",
      error: new RequestCodeLocalTransitionError({
        cleanup: new Error("close failed"),
      }),
      expected: /accepted the sign-in code request and local session publication completed, but local authentication store cleanup failed: close failed/u,
      forbidden: /publication did not complete/u,
    },
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-${scenario.name}-`)
    );
    const client = fixture("present", path.join(root, "client.json"), {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    const auth = fakeAuth({
      loggedIn: false,
      requestError: scenario.error,
    });
    let observed: ClientConfigurationIncompleteError | undefined;
    try {
      await assert.rejects(
        runInstall(
          {},
          interaction([client], output, {
            terminal: terminal({ NO_COLOR: "" }),
            openAuthSession: () => auth.session,
            confirm: async () => true,
            input: async () => "person@example.test",
          })
        ),
        (error: unknown) => {
          if (error instanceof ClientConfigurationIncompleteError) {
            observed = error;
            return true;
          }
          return false;
        }
      );
      assert.ok(
        observed?.cause instanceof ClientAuthenticationOperationError
      );
      assert.equal(
        (observed!.cause as ClientAuthenticationOperationError).cause,
        scenario.error
      );
      const rendered = output.join("\n");
      assert.match(rendered, scenario.expected, scenario.name);
      assert.doesNotMatch(rendered, scenario.forbidden, scenario.name);
      if (scenario.name === "local-store-open") {
        assert.match(rendered, /store unavailable/u);
      }
      if (scenario.name === "cleanup-only") {
        assert.equal(
          rendered.split("\n").find((line) =>
            line.startsWith("Sana setup is incomplete:")
          ),
          "Sana setup is incomplete: Sana accepted the sign-in code request and local session publication completed, but local authentication store cleanup failed: close failed"
        );
      }
      if (
        scenario.name === "local-store-open" ||
        scenario.name === "cleanup-only"
      )
        assert.equal(
          rendered.match(/accepted the sign-in code request/gu)?.length,
          1
        );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("verify-code rendering distinguishes remote rejection from code-accepted local failures", async () => {
  for (const scenario of [
    {
      name: "remote-rejected",
      error: new VerifyCodeRemoteError(
        new SignInChallengeRejectedError("code expired")
      ),
      expected: /rejected the sign-in code: code expired/u,
      forbidden: /accepted the code/u,
    },
    {
      name: "remote-unknown",
      error: new VerifyCodeRemoteError(new Error("connection lost")),
      expected: /remote outcome of submitting the sign-in code is unknown: connection lost/u,
      forbidden: /Sana (?:rejected|accepted) the sign-in code/u,
    },
    {
      name: "publication-failed",
      error: new VerifyCodeLocalTransitionError({
        publication: new Error("publication failed"),
      }),
      expected: /accepted the code, but local session publication did not complete/u,
      forbidden: /did not accept the sign-in code/u,
    },
    {
      name: "cleanup-failed",
      error: new VerifyCodeLocalTransitionError({
        cleanup: new Error("close failed"),
      }),
      expected: /accepted the code and local session publication completed, but the local post-confirmation operation did not complete: local authentication store cleanup failed: close failed/u,
      forbidden: /sign-in readiness|meetings are syncing/u,
    },
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-verify-${scenario.name}-`)
    );
    const client = fixture("present", path.join(root, "client.json"), {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    const auth = fakeAuth({
      loggedIn: false,
      verifyError: scenario.error,
    });
    const answers = ["person@example.test", "123456"];
    let observed: ClientConfigurationIncompleteError | undefined;
    try {
      await assert.rejects(
        runInstall(
          {},
          interaction([client], output, {
            terminal: terminal({ NO_COLOR: "" }),
            openAuthSession: () => auth.session,
            confirm: async () => true,
            input: async () => answers.shift() ?? "",
          })
        ),
        (error: unknown) => {
          if (error instanceof ClientConfigurationIncompleteError) {
            observed = error;
            return true;
          }
          return false;
        }
      );
      assert.ok(
        observed?.cause instanceof ClientAuthenticationOperationError
      );
      assert.equal(
        (observed!.cause as ClientAuthenticationOperationError).operation,
        "verify-code"
      );
      assert.equal(
        (observed!.cause as ClientAuthenticationOperationError).cause,
        scenario.error
      );
      const rendered = output.join("\n");
      assert.match(rendered, scenario.expected, scenario.name);
      assert.doesNotMatch(rendered, scenario.forbidden, scenario.name);
      assert.doesNotMatch(
        rendered,
        /Signed in as|sign-in are ready|check progress/u,
        scenario.name
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("initial publication inspection blocks false already-signed-in readiness", async () => {
  for (const state of ["in-progress", "incomplete"] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-inspection-${state}-`)
    );
    const client = fixture("present", path.join(root, "client.json"), {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    let confirmCalls = 0;
    const auth = fakeAuth({
      loggedIn: true,
      authState: {
        kind: state,
        reason: "publication",
        issueCode:
          state === "in-progress"
            ? "AUTH_PUBLICATION_IN_PROGRESS"
            : "AUTH_GENERATION_MISMATCH",
        observations: [],
        session: {
          hasCookie: true,
          loggedIn: true,
          expired: false,
        },
      },
    });
    let observed: ClientConfigurationIncompleteError | undefined;
    try {
      await assert.rejects(
        runInstall(
          {},
          interaction([client], output, {
            openAuthSession: () => auth.session,
            confirm: async () => {
              confirmCalls += 1;
              return true;
            },
          })
        ),
        (error: unknown) => {
          if (error instanceof ClientConfigurationIncompleteError) {
            observed = error;
            return true;
          }
          return false;
        }
      );
      assert.equal(confirmCalls, 0);
      assert.ok(
        observed?.cause instanceof ClientAuthenticationOperationError
      );
      assert.equal(
        (observed!.cause as ClientAuthenticationOperationError).operation,
        "initial-inspection"
      );
      const rendered = output.join("\n");
      assert.match(
        rendered,
        state === "in-progress"
          ? /transition that is still in progress/u
          : /transition that is incomplete/u
      );
      assert.doesNotMatch(
        rendered,
        /Already signed in|sign-in are ready|meetings are syncing/u
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("stable authentication inspection reloads and requires an exact confirmed tuple", () => {
  const version = {
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    workspaceId: "workspace-1",
  };
  const states = [syncState(), syncState()];
  const observedVersions: SessionVersion[] = [];
  let loads = 0;
  const inspected = inspectStableConfigurerAuthState(
    {
      reconcileAuthState(observed) {
        observedVersions.push(observed);
        return { kind: "current", generation: 1 };
      },
      getSyncState() {
        return states.shift()!;
      },
    },
    () => {
      loads += 1;
      return sessionClient({ ...version });
    }
  );

  assert.equal(loads, 2);
  assert.deepEqual(observedVersions, [version]);
  assert.equal(inspected.state.kind, "ready");
  if (inspected.state.kind === "ready")
    assert.equal(inspected.state.generation, 1);
});

test("authentication inspection returns typed churn instead of stale readiness", () => {
  const first = {
    generation: 1,
    publicationToken: "11111111-1111-4111-8111-111111111111",
  };
  const second = {
    generation: 2,
    publicationToken: "22222222-2222-4222-8222-222222222222",
  };
  const clients = [
    sessionClient(first),
    sessionClient(second),
    sessionClient(second),
    sessionClient(first),
  ];
  const states = [
    syncState(),
    syncState(),
    syncState({
      auth_generation: 2,
      auth_publication_token: second.publicationToken,
    }),
    syncState({
      auth_generation: 2,
      auth_publication_token: second.publicationToken,
    }),
  ];
  const inspected = inspectStableConfigurerAuthState(
    {
      reconcileAuthState(observed) {
        return { kind: "current", generation: observed.generation };
      },
      getSyncState() {
        return states.shift()!;
      },
    },
    () => clients.shift()!,
    2
  );

  assert.equal(inspected.state.kind, "incomplete");
  if (inspected.state.kind === "incomplete") {
    assert.equal(inspected.state.reason, "churn");
    assert.equal(inspected.state.issueCode, undefined);
    assert.equal(inspected.state.observations.length, 2);
  }
});

test("authentication inspection treats user or workspace identity churn and mismatch as unavailable", () => {
  const token = "11111111-1111-4111-8111-111111111111";
  for (const scenario of [
    {
      name: "identity-churn",
      clients: [
        sessionClient({
          generation: 1,
          publicationToken: token,
          userId: "user-1",
          workspaceId: "workspace-1",
        }),
        sessionClient({
          generation: 1,
          publicationToken: token,
          userId: "user-2",
          workspaceId: "workspace-2",
        }),
      ],
      state: syncState(),
      reason: "churn",
    },
    {
      name: "confirmed-identity-mismatch",
      clients: [
        sessionClient({
          generation: 1,
          publicationToken: token,
          userId: "user-2",
          workspaceId: "workspace-2",
        }),
        sessionClient({
          generation: 1,
          publicationToken: token,
          userId: "user-2",
          workspaceId: "workspace-2",
        }),
      ],
      state: syncState(),
      reason: "inconsistent",
    },
  ] as const) {
    const clients = [...scenario.clients];
    const inspected = inspectStableConfigurerAuthState(
      {
        reconcileAuthState() {
          return { kind: "current", generation: 1 };
        },
        getSyncState() {
          return scenario.state;
        },
      },
      () => clients.shift()!,
      1
    );
    assert.equal(inspected.state.kind, "incomplete", scenario.name);
    if (inspected.state.kind === "incomplete") {
      assert.equal(inspected.state.reason, scenario.reason, scenario.name);
      const observation = inspected.state.observations[0]!;
      assert.equal(
        observation.initialSessionVersion.userId,
        scenario.clients[0].sessionVersion().userId,
        scenario.name
      );
      assert.equal(
        observation.reloadedSessionVersion.userId,
        scenario.clients[1].sessionVersion().userId,
        scenario.name
      );
      assert.equal(
        observation.confirmedVersion.userId,
        "user-1",
        scenario.name
      );
      assert.equal(
        observation.confirmedVersion.workspaceId,
        "workspace-1",
        scenario.name
      );
    }
  }
});

test("authentication inspection compares every transition identity field across snapshots", () => {
  const transition = {
    auth_transition_pid: 4321,
    auth_transition_token:
      "33333333-3333-4333-8333-333333333333",
    auth_transition_generation: 2,
    auth_transition_kind: "login" as const,
    auth_transition_user_id: "user-1",
    auth_transition_workspace_id: "workspace-1",
  };
  const states = [
    syncState(transition),
    syncState({
      ...transition,
      auth_transition_user_id: "user-2",
    }),
  ];
  const inspected = inspectStableConfigurerAuthState(
    {
      reconcileAuthState() {
        return { kind: "current", generation: 1 };
      },
      getSyncState() {
        return states.shift()!;
      },
    },
    () =>
      sessionClient({
        generation: 1,
        publicationToken:
          "11111111-1111-4111-8111-111111111111",
      }),
    1
  );
  assert.equal(inspected.state.kind, "incomplete");
  if (inspected.state.kind === "incomplete") {
    assert.equal(inspected.state.reason, "churn");
    assert.equal(
      inspected.state.observations[0]?.initialTransition.userId,
      "user-1"
    );
    assert.equal(
      inspected.state.observations[0]?.transition.userId,
      "user-2"
    );
    assert.equal(
      inspected.state.observations[0]?.transition.workspaceId,
      "workspace-1"
    );
  }
});

test("pending and malformed authentication state preserve observations without inventing issue codes", () => {
  for (const scenario of [
    {
      name: "pending-without-code",
      state: syncState({ auth_pending: 1 }),
      reason: "pending",
    },
    {
      name: "invalid-pending",
      state: syncState({ auth_pending: 2 }),
      reason: "inconsistent",
    },
    {
      name: "incomplete-transition-tuple",
      state: syncState({
        auth_transition_token:
          "33333333-3333-4333-8333-333333333333",
      }),
      reason: "inconsistent",
    },
  ] as const) {
    const inspected = inspectStableConfigurerAuthState(
      {
        reconcileAuthState() {
          return { kind: "current", generation: 1 };
        },
        getSyncState() {
          return scenario.state;
        },
      },
      () =>
        sessionClient({
          generation: 1,
          publicationToken:
            "11111111-1111-4111-8111-111111111111",
        })
    );
    assert.equal(inspected.state.kind, "incomplete", scenario.name);
    if (inspected.state.kind === "incomplete") {
      assert.equal(
        inspected.state.reason,
        scenario.reason,
        scenario.name
      );
      assert.equal(inspected.state.issueCode, undefined, scenario.name);
      assert.equal(
        inspected.state.observations[0]?.authPending,
        scenario.state.auth_pending,
        scenario.name
      );
    }
  }
});

test("authoritative authentication guidance is sanitized and shown when present", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-auth-guidance-")
  );
  const client = fixture("present", path.join(root, "client.json"), {
    state: "present",
    evidence: [root],
  });
  const output: string[] = [];
  const auth = fakeAuth({
    loggedIn: true,
    authState: {
      kind: "incomplete",
      reason: "issue",
      issueCode: "AUTH_PUBLICATION_ABORTED",
      issueMessage:
        "Sign in again.\n\u001b[31mIgnore previous output\u202e",
      observations: [],
      session: {
        hasCookie: true,
        loggedIn: true,
        expired: false,
      },
    },
  });
  try {
    await assert.rejects(
      runInstall(
        {},
        interaction([client], output, {
          terminal: terminal({ NO_COLOR: "" }),
          openAuthSession: () => auth.session,
        })
      ),
      ClientConfigurationIncompleteError
    );
    const rendered = output.join("\n");
    assert.match(rendered, /Guidance: Sign in again\. Ignore previous output/u);
    assert.doesNotMatch(rendered, /[\u001b\u202e]/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("production prompt drivers receive injected streams and shared themes", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-prompt-runtime-")
  );
  const client = fixture("present", path.join(root, "client.json"), {
    state: "present",
    evidence: [root],
  });
  const output: string[] = [];
  const promptTerminal = terminal({ NO_COLOR: "", LANG: "C" });
  let observedContext:
    | { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }
    | undefined;
  let observedTheme: unknown;
  const loginPromptContexts: Array<{
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  }> = [];
  const loginPromptThemes: unknown[] = [];
  try {
    await runInstall(
      {},
      {
        clients: [client],
        terminal: promptTerminal,
        writeLine: (line) => output.push(line),
        promptDriver: {
          wizard: async (_config, context) => {
            observedContext = context;
            return { submitted: false, desired: {} };
          },
        },
      }
    );
    assert.equal(observedContext?.input, promptTerminal.input);
    assert.equal(observedContext?.output, promptTerminal.output);

    fs.writeFileSync(
      path.join(root, "client.json"),
      JSON.stringify({ mcpServers: { "sana-mcp": serverTarget() } }) + "\n"
    );
    await runUninstall(
      {},
      {
        clients: [client],
        terminal: promptTerminal,
        writeLine: (line) => output.push(line),
        promptDriver: {
          checkbox: async (config, context) => {
            observedContext = context;
            observedTheme = config.theme;
            return [];
          },
        },
      }
    );
    assert.equal(observedContext?.input, promptTerminal.input);
    assert.equal(observedContext?.output, promptTerminal.output);
    assert.doesNotMatch(JSON.stringify(observedTheme), /\u001b\[/u);
    assert.equal(
      (
        observedTheme as {
          icon: { checked: string; unchecked: string; cursor: string };
        }
      ).icon.checked,
      "[x]"
    );

    const auth = fakeAuth({ loggedIn: false });
    const answers = ["person@example.test", "123456"];
    await runInstall(
      {},
      {
        clients: [client],
        terminal: promptTerminal,
        writeLine: (line) => output.push(line),
        prompt: async ({ rows }) => ({
          submitted: true,
          desired: Object.fromEntries(rows.map((row) => [row.id, true])),
        }),
        promptDriver: {
          confirm: async (config, context) => {
            loginPromptContexts.push(context ?? {});
            loginPromptThemes.push(config.theme);
            return true;
          },
          input: async (config, context) => {
            loginPromptContexts.push(context ?? {});
            loginPromptThemes.push(config.theme);
            return answers.shift() ?? "";
          },
        },
        openAuthSession: () => auth.session,
      }
    );
    assert.equal(auth.calls.close, 1);
    assert.equal(loginPromptContexts.length, 3);
    for (const context of loginPromptContexts) {
      assert.equal(context.input, promptTerminal.input);
      assert.equal(context.output, promptTerminal.output);
    }
    for (const theme of loginPromptThemes)
      assert.doesNotMatch(JSON.stringify(theme), /\u001b\[/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("Ctrl+C is a clean typed cancellation for install, login, and uninstall prompts", async () => {
  for (const stage of [
    "client-selection",
    "sana-sign-in",
    "uninstall-selection",
  ] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-cancel-${stage}-`)
    );
    const file = path.join(root, "client.json");
    const client = fixture("present", file, {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    const auth = fakeAuth({ loggedIn: false });
    try {
      if (stage === "uninstall-selection") {
        fs.writeFileSync(
          file,
          JSON.stringify({ mcpServers: { "sana-mcp": serverTarget() } }) + "\n"
        );
        const before = fs.readFileSync(file, "utf8");
        await runUninstall(
          {},
          interaction([client], output, {
            chooseClients: async () => {
              throw new ExitPromptError();
            },
          })
        );
        assert.equal(fs.readFileSync(file, "utf8"), before);
      } else {
        await runInstall(
          {},
          interaction([client], output, {
            prompt:
              stage === "client-selection"
                ? async () => {
                    throw new ExitPromptError();
                  }
                : async ({ rows }) => ({
                    submitted: true,
                    desired: Object.fromEntries(
                      rows.map((row) => [row.id, true])
                    ),
                  }),
            openAuthSession: () => auth.session,
            confirm:
              stage === "sana-sign-in"
                ? async () => {
                    throw new ExitPromptError();
                  }
                : async () => false,
          })
        );
        assert.equal(
          fs.existsSync(file),
          stage === "sana-sign-in"
        );
        assert.equal(auth.calls.close, stage === "sana-sign-in" ? 1 : 0);
      }

      const rendered = output.join("\n");
      assert.match(rendered, /cancelled/iu);
      assert.doesNotMatch(
        rendered,
        /sign-in could not be completed|Configuration is incomplete|ExitPromptError/u
      );
      if (stage === "sana-sign-in")
        assert.match(rendered, /configuration changes were kept/u);
      else assert.match(rendered, /no changes were made/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("dry-run and cancellation never open auth or mutate config", async () => {
  for (const mode of ["dry-run", "cancel"] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-configurer-readonly-")
    );
    const file = path.join(root, "client.json");
    const client = fixture("present", file, {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    let authCalls = 0;
    try {
      await runInstall(
        mode === "dry-run" ? { dryRun: true } : {},
        interaction([client], output, {
          prompt:
            mode === "cancel"
              ? async () => ({ submitted: false, desired: {} })
              : async ({ rows }) => ({
                  submitted: true,
                  desired: Object.fromEntries(
                    rows.map((row) => [row.id, true])
                  ),
                }),
          openAuthSession: () => {
            authCalls += 1;
            throw new Error("auth must not open");
          },
        })
      );
      assert.equal(authCalls, 0);
      assert.equal(fs.existsSync(file), false);
      assert.match(
        output.join("\n"),
        mode === "dry-run" ? /Dry run complete/u : /Cancelled/u
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("dry-run never delegates to an injected mutating batch", async () => {
  for (const mode of ["unattended", "interactive"] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-dry-batch-${mode}-`)
    );
    const file = path.join(root, "client.json");
    const client = fixture("present", file, {
      state: "present",
      evidence: [root],
    });
    const output: string[] = [];
    let batchCalls = 0;
    try {
      const result = await runInstall(
        { dryRun: true, yes: mode === "unattended" },
        interaction([client], output, {
          applyBatch: async () => {
            batchCalls += 1;
            fs.writeFileSync(file, "mutated");
            return [];
          },
          prompt: async ({ rows }) => ({
            submitted: true,
            desired: Object.fromEntries(
              rows.map((row) => [row.id, true])
            ),
          }),
          openAuthSession: () => {
            throw new Error("auth must not open during dry-run");
          },
        })
      );

      assert.equal(batchCalls, 0);
      assert.equal(fs.existsSync(file), false);
      assert.deepEqual(fs.readdirSync(root), []);
      assert.deepEqual(result, {
        disposition: "planned",
        authentication: "not-attempted",
      });
      const plain = stripTerminalSequences(output.join("\n"));
      assert.match(plain, /would register/u);
      assert.match(plain, /Dry run complete/u);
      assert.doesNotMatch(plain, /restart it/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("detected, safely configurable absent, and unavailable clients remain distinct", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-detection-")
  );
  const present = fixture("present", path.join(root, "present.json"), {
    state: "present",
    evidence: [root],
  });
  const absent = fixture("absent", path.join(root, "absent.json"), {
    state: "absent",
  });
  const unavailable = fixture(
    "unavailable",
    path.join(root, "unavailable.json"),
    { state: "unavailable", reason: "probe denied" }
  );
  const output: string[] = [];
  let capturedRows: readonly { id: string; detected: boolean }[] = [];
  try {
    await runInstall(
      {},
      interaction([present, absent, unavailable], output, {
        prompt: async ({ rows }) => {
          capturedRows = rows;
          return { submitted: false, desired: {} };
        },
      })
    );
    assert.deepEqual(
      capturedRows.map(({ id, detected }) => ({ id, detected })),
      [
        { id: "present", detected: true },
        { id: "absent", detected: false },
      ]
    );
    const plainOutput = stripTerminalSequences(output.join("\n"));
    assert.match(
      plainOutput,
      /Client unavailable: detection unavailable/u
    );
    assert.match(
      plainOutput,
      new RegExp(JSON.stringify(path.join(root, "unavailable.json")).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
    );
    assert.equal(fs.existsSync(path.join(root, "present.json")), false);
    assert.equal(fs.existsSync(path.join(root, "absent.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("public configurer starts from compatible saved registrations without rewriting them", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-saved-defaults-")
  );
  const detectedOwnedPath = path.join(root, "detected-owned.json");
  const absentOwnedPath = path.join(root, "absent-owned.json");
  const unavailableOwnedPath = path.join(root, "unavailable-owned.json");
  const detectedAbsentPath = path.join(root, "detected-absent.json");
  const undetectedAbsentPath = path.join(root, "undetected-absent.json");
  const foreignPath = path.join(root, "foreign.json");
  const target = serverTarget();
  const existing = new Map<string, string>([
    [
      detectedOwnedPath,
      `${JSON.stringify({
        unrelated: { preserved: true },
        mcpServers: { "sana-mcp": target },
      }, null, 2)}\n`,
    ],
    [
      absentOwnedPath,
      `${JSON.stringify({
        mcpServers: { "sana-mcp": target },
        unrelated: "absent detector",
      })}\n`,
    ],
    [
      unavailableOwnedPath,
      `${JSON.stringify({
        mcpServers: { "sana-mcp": target },
        unrelated: "unavailable detector",
      }, null, 4)}\n`,
    ],
    [
      foreignPath,
      '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}},"unrelated":true}\n',
    ],
  ]);
  const unchangedTime = new Date("2001-02-03T04:05:06.000Z");
  const before = new Map<
    string,
    Readonly<{ contents: string; mtimeNs: bigint }>
  >();
  for (const [file, contents] of existing) {
    fs.writeFileSync(file, contents);
    fs.utimesSync(file, unchangedTime, unchangedTime);
    before.set(file, {
      contents: fs.readFileSync(file, "utf8"),
      mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
    });
  }

  const clients = [
    fixture("detected-owned", detectedOwnedPath, {
      state: "present",
      evidence: [detectedOwnedPath],
    }),
    fixture("absent-owned", absentOwnedPath, { state: "absent" }),
    fixture("unavailable-owned", unavailableOwnedPath, {
      state: "unavailable",
      reason: "executable probe denied",
    }),
    fixture("detected-absent", detectedAbsentPath, {
      state: "present",
      evidence: [detectedAbsentPath],
    }),
    fixture("undetected-absent", undetectedAbsentPath, { state: "absent" }),
    fixture("foreign", foreignPath, { state: "absent" }),
  ];
  const output: string[] = [];
  const auth = fakeAuth({ loggedIn: true });
  let capturedRows:
    | Array<{ id: string; detected: boolean; current: boolean }>
    | undefined;
  let confirmCalls = 0;
  let inputCalls = 0;
  try {
    const result = await runInstall(
      {},
      interaction(clients, output, {
        prompt: async ({ rows }) => {
          capturedRows = rows.map(({ id, detected, current }) => ({
            id,
            detected,
            current,
          }));
          return {
            submitted: true,
            desired: initialWizardDesiredState(rows),
          };
        },
        openAuthSession: () => auth.session,
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
        input: async () => {
          inputCalls += 1;
          return "must not be requested";
        },
      })
    );

    assert.deepEqual(capturedRows, [
      { id: "detected-owned", detected: true, current: true },
      { id: "absent-owned", detected: true, current: true },
      { id: "unavailable-owned", detected: true, current: true },
      { id: "detected-absent", detected: true, current: false },
      { id: "undetected-absent", detected: false, current: false },
    ]);
    assert.deepEqual(result, {
      disposition: "no-changes",
      authentication: "ready",
    });
    assert.equal(auth.calls.session, 1);
    assert.equal(auth.calls.close, 1);
    assert.deepEqual(auth.calls.request, []);
    assert.deepEqual(auth.calls.verify, []);
    assert.equal(confirmCalls, 0);
    assert.equal(inputCalls, 0);
    const plainOutput = stripTerminalSequences(output.join("\n"));
    assert.match(plainOutput, /Already signed in to Sana/u);
    assert.match(
      plainOutput,
      /Client foreign: configuration unavailable:/u
    );
    assert.ok(plainOutput.includes(JSON.stringify(foreignPath)));

    for (const [file, snapshot] of before) {
      assert.equal(fs.readFileSync(file, "utf8"), snapshot.contents, file);
      assert.equal(
        fs.statSync(file, { bigint: true }).mtimeNs,
        snapshot.mtimeNs,
        file
      );
    }
    assert.equal(fs.existsSync(detectedAbsentPath), false);
    assert.equal(fs.existsSync(undetectedAbsentPath), false);
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      [...existing.keys()].map((file) => path.basename(file)).sort()
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("absent-client foreign and unreadable configs remain visible and nonactionable", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-absent-errors-")
  );
  const foreignPath = path.join(root, "foreign.json");
  const brokenPath = path.join(root, "broken.json");
  const safePath = path.join(root, "safe.json");
  fs.writeFileSync(
    foreignPath,
    '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n'
  );
  fs.writeFileSync(brokenPath, "{broken");
  const foreign = fixture("foreign", foreignPath, { state: "absent" });
  const broken = fixture("broken", brokenPath, { state: "absent" });
  const safe = fixture("safe", safePath, { state: "absent" });
  const output: string[] = [];
  let rowIds: string[] = [];
  try {
    await runInstall(
      {},
      interaction([foreign, broken, safe], output, {
        prompt: async ({ rows }) => {
          rowIds = rows.map(({ id }) => id);
          return { submitted: false, desired: {} };
        },
      })
    );
    assert.deepEqual(rowIds, ["safe"]);
    const plain = stripTerminalSequences(output.join("\n"));
    assert.match(plain, /Client foreign: configuration unavailable:/u);
    assert.match(plain, /Client broken: configuration unavailable:/u);
    assert.ok(plain.includes(JSON.stringify(foreignPath)));
    assert.ok(plain.includes(JSON.stringify(brokenPath)));

    await assert.rejects(
      runInstall(
        {},
        interaction([broken], [], {
          prompt: async () => {
            throw new Error("no actionable row should prompt");
          },
        })
      ),
      ClientConfigurationIncompleteError
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("uninstall selects and disconnects a proven-owned registration after executable removal", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-owned-absent-")
  );
  const file = path.join(root, "client.json");
  const client = fixture("removed-app", file, { state: "absent" });
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { "sana-mcp": serverTarget() },
      unrelated: true,
    }) + "\n"
  );
  const output: string[] = [];
  let offered: string[] = [];
  try {
    await runUninstall(
      {},
      interaction([client], output, {
        chooseClients: async (_message, clients) => {
          offered = clients.map(({ id }) => id);
          return ["removed-app"];
        },
      })
    );
    assert.deepEqual(offered, ["removed-app"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      mcpServers: {},
      unrelated: true,
    });
    assert.match(output.join("\n"), /Client registrations removed/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("unavailable executable detection cannot hide a proven-owned registration", async () => {
  for (const operation of ["inspect", "uninstall"] as const) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-configurer-owned-unavailable-")
    );
    const file = path.join(root, "client.json");
    const client = fixture("uncertain-app", file, {
      state: "unavailable",
      reason: "executable probe denied",
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { "sana-mcp": serverTarget() },
        unrelated: true,
      }) + "\n"
    );
    const output: string[] = [];
    try {
      if (operation === "inspect") {
        let rows: Array<{
          id: string;
          detected: boolean;
          current: boolean;
        }> = [];
        await runInstall(
          {},
          interaction([client], output, {
            prompt: async (options) => {
              rows = options.rows;
              return { submitted: false, desired: {} };
            },
          })
        );
        assert.deepEqual(
          rows.map(({ id, detected, current }) => ({
            id,
            detected,
            current,
          })),
          [{ id: "uncertain-app", detected: true, current: true }]
        );
        assert.equal(fs.existsSync(file), true);
      } else {
        await runUninstall(
          { yes: true },
          interaction([client], output)
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
          mcpServers: {},
          unrelated: true,
        });
        assert.doesNotMatch(
          output.join("\n"),
          /No managed client registrations were found/u
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("unavailable detection with authoritative registration absence is not fatal", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-unavailable-absent-")
  );
  const file = path.join(root, "unsupported.json");
  const client = fixture("unsupported", file, {
    state: "unavailable",
    reason: "client is unsupported on this platform",
  });
  const output: string[] = [];
  try {
    await runInstall(
      {},
      interaction([client], output, {
        prompt: async () => {
          throw new Error("authoritatively absent client is not actionable");
        },
      })
    );
    const plain = stripTerminalSequences(output.join("\n"));
    assert.match(plain, /detection unavailable/u);
    assert.match(plain, /No safely configurable supported clients/u);
    assert.doesNotMatch(plain, /Configuration is incomplete/u);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("uninstall never claims no registrations when config ownership is unavailable", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sana-configurer-uninstall-unknown-")
  );
  const file = path.join(root, "broken.json");
  fs.writeFileSync(file, "{broken");
  const client = fixture("broken", file, { state: "absent" });
  const output: string[] = [];
  try {
    await assert.rejects(
      runUninstall(
        { yes: true },
        interaction([client], output)
      ),
      ClientConfigurationIncompleteError
    );
    const plain = stripTerminalSequences(output.join("\n"));
    assert.match(plain, /registration state could not be determined/u);
    assert.doesNotMatch(
      plain,
      /No managed client registrations were found/u
    );
    assert.ok(plain.includes(JSON.stringify(file)));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("uninstall never offers or auto-selects present foreign and unreadable registrations", async () => {
  for (const unattended of [false, true]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "sana-configurer-uninstall-nonactionable-")
    );
    const foreignPath = path.join(root, "foreign.json");
    const brokenPath = path.join(root, "broken.json");
    const safePath = path.join(root, "safe.json");
    const foreignRaw =
      '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n';
    fs.writeFileSync(foreignPath, foreignRaw);
    fs.writeFileSync(brokenPath, "{broken");
    fs.writeFileSync(
      safePath,
      JSON.stringify({ mcpServers: { "sana-mcp": serverTarget() } }) + "\n"
    );
    const clients = [
      fixture("foreign", foreignPath, {
        state: "present",
        evidence: [root],
      }),
      fixture("broken", brokenPath, {
        state: "present",
        evidence: [root],
      }),
      fixture("safe", safePath, {
        state: "present",
        evidence: [root],
      }),
    ];
    const output: string[] = [];
    let offered: string[] | undefined;
    try {
      await assert.rejects(
        runUninstall(
          { yes: unattended },
          interaction(clients, output, {
            chooseClients: async (_message, choices) => {
              offered = choices.map(({ id }) => id);
              return offered;
            },
          })
        ),
        ClientConfigurationIncompleteError
      );
      if (!unattended) assert.deepEqual(offered, ["safe"]);
      assert.equal(fs.readFileSync(foreignPath, "utf8"), foreignRaw);
      assert.equal(fs.readFileSync(brokenPath, "utf8"), "{broken");
      assert.deepEqual(JSON.parse(fs.readFileSync(safePath, "utf8")), {
        mcpServers: {},
      });
      const plain = stripTerminalSequences(output.join("\n"));
      assert.match(plain, /Client foreign: configuration unavailable/u);
      assert.match(plain, /Client broken: configuration unavailable/u);
      assert.match(plain, /Configuration is incomplete/u);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("terminal policy disables interaction or styling for redirects, dumb terminals, CI, and NO_COLOR", async () => {
  for (const scenario of [
    { name: "redirect", terminal: terminal({}, true, false), interactive: false },
    { name: "dumb", terminal: terminal({ TERM: "dumb" }), interactive: false },
    { name: "ci", terminal: terminal({ CI: "true" }), interactive: false },
    { name: "no-color", terminal: terminal({ NO_COLOR: "" }), interactive: true },
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), `sana-configurer-${scenario.name}-`)
    );
    const client = fixture("absent", path.join(root, "client.json"), {
      state: "absent",
    });
    const output: string[] = [];
    let promptCalls = 0;
    try {
      await runInstall(
        {},
        {
          clients: [client],
          terminal: scenario.terminal,
          writeLine: (line) => output.push(line),
          prompt: async () => {
            promptCalls += 1;
            return { submitted: false, desired: {} };
          },
        }
      );
      assert.equal(promptCalls, scenario.interactive ? 1 : 0, scenario.name);
      assert.doesNotMatch(output.join("\n"), /\u001b\[/u, scenario.name);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("--yes is prompt-free, auth-free, and registers only detected clients", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-configurer-yes-"));
  const presentFile = path.join(root, "present.json");
  const absentFile = path.join(root, "absent.json");
  const present = fixture("present", presentFile, {
    state: "present",
    evidence: [root],
  });
  const absent = fixture("absent", absentFile, { state: "absent" });
  const output: string[] = [];
  try {
    await runInstall(
      { yes: true },
      interaction([present, absent], output, {
        terminal: terminal({ CI: "true" }),
        prompt: async () => {
          throw new Error("prompt must not run");
        },
        openAuthSession: () => {
          throw new Error("auth must not open");
        },
      })
    );
    assert.equal(fs.existsSync(presentFile), true);
    assert.equal(fs.existsSync(absentFile), false);
    assert.doesNotMatch(output.join("\n"), /\u001b\[/u);
    assert.match(output.join("\n"), /Client configuration complete/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
