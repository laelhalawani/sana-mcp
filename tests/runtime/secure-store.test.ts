import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function isolatedStore(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-private-store-"));
  roots.push(root);
  const file = path.join(root, "profile", "sana.db");
  return {
    file,
    child: spawnSync(
      process.execPath,
      [
        "-e",
        `
          import fs from "node:fs";
          const { SanaStore } = await import("./src/store/db.ts");
          const file = ${JSON.stringify(file)};
          ${source}
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, SANA_SEMANTIC: "0" },
      },
    ),
  };
}

describe("private SQLite storage", () => {
  test("uses the real database path and lets SQLite own its sidecars", () => {
    const { file, child } = isolatedStore(`
      const store = new SanaStore(file);
      store.db.exec("CREATE TABLE sidecar_probe(value BLOB); INSERT INTO sidecar_probe VALUES (randomblob(8192));");
      const databases = store.db.query("PRAGMA database_list").all();
      if (databases.length !== 1 || databases[0].file !== file) {
        throw new Error("SQLite did not open the requested ordinary path");
      }
      for (const artifact of [file, file + "-wal", file + "-shm"]) {
        if (!fs.existsSync(artifact)) continue;
        if (!fs.lstatSync(artifact).isFile()) throw new Error("unexpected artifact type");
        if (process.platform !== "win32" && (fs.statSync(artifact).mode & 0o777) !== 0o600) {
          throw new Error("insecure artifact mode: " + artifact);
        }
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    const names = fs.readdirSync(path.dirname(file));
    expect(names.some((name) => /lease|probe|replacement|coordination/i.test(name))).toBe(
      false,
    );
  });

  test("rejects linked SQLite artifacts before opening the database", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-store-link-"));
    roots.push(root);
    const directory = path.join(root, "profile");
    fs.mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, "sana.db");
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "sentinel", { mode: 0o600 });
    fs.symlinkSync(outside, `${file}-wal`);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { SanaStore } = await import("./src/store/db.ts");
          let failed = false;
          try { new SanaStore(${JSON.stringify(file)}); } catch { failed = true; }
          if (!failed) throw new Error("linked sidecar was accepted");
        `,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, SANA_SEMANTIC: "0" },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel");
  });

  test("clears daemon identity only for the expected owner", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const instanceId = "00000000-0000-4000-8000-000000000010";
      store.updateSyncState({
        daemon_pid: 1234,
        daemon_heartbeat_ms: 99,
        daemon_instance_id: instanceId,
      });
      if (store.clearDaemonIdentityIfOwned(5678, instanceId) !== "not-owner") {
        throw new Error("foreign owner was reported cleared");
      }
      if (store.getSyncState().daemon_pid !== 1234) {
        throw new Error("foreign daemon identity was changed");
      }
      if (store.clearDaemonIdentityIfOwned(1234, instanceId) !== "cleared") {
        throw new Error("owned daemon identity was not cleared");
      }
      const state = store.getSyncState();
      if (state.daemon_pid !== null || state.daemon_heartbeat_ms !== null ||
          state.daemon_instance_id !== null) {
        throw new Error("owned daemon identity remains");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("records a serialized login catch-up intent before session persistence", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const contender = new SanaStore(file);
      const tokenA = "11111111-1111-4111-8111-111111111111";
      const tokenB = "22222222-2222-4222-8222-222222222222";
      const tokenC = "33333333-3333-4333-8333-333333333333";
      store.updateSyncState({ blocking: 0 });
      const first = store.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenA,
        101,
        () => false
      );
      if (first.kind !== "acquired") {
        throw new Error("first login publication was not acquired");
      }
      let state = store.getSyncState();
      if (state.blocking !== 1 || state.catchup_generation !== 1 ||
          state.auth_pending !== 1 || state.auth_transition_pid !== 101 ||
          state.auth_transition_token !== tokenA) {
        throw new Error("first login catch-up intent was not committed");
      }
      const busy = contender.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenB,
        202,
        (pid) => pid === 101
      );
      if (busy.kind !== "busy" || busy.ownerPid !== 101) {
        throw new Error("live login publication was superseded");
      }
      const liveObserved = contender.reconcileAuthState(
        {
          generation: 1,
          publicationToken: tokenA,
          userId: "user-a",
          workspaceId: "workspace-a",
        },
        (pid) => pid === 101,
      );
      if (
        liveObserved.kind !== "incomplete" ||
        liveObserved.code !== "AUTH_PUBLICATION_IN_PROGRESS" ||
        store.getSyncState().auth_generation !== 0
      ) {
        throw new Error("observer confirmed a live owner's pending file");
      }
      if (store.confirmAuthPublication(first.intent, 1) !== "confirmed") {
        throw new Error("first persisted session was not confirmed");
      }
      const claimed = store.claimAuthPublication(
        { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenB,
        101,
        () => false
      );
      if (claimed.kind !== "acquired") {
        throw new Error("next login publication could not start");
      }
      state = store.getSyncState();
      if (state.blocking !== 1 || state.catchup_generation !== 2 ||
          state.auth_pending !== 1 || state.auth_transition_pid !== 101 ||
          state.auth_transition_token !== tokenB) {
        throw new Error("concurrent login intent was not serialized");
      }
      if (store.confirmAuthPublication(first.intent, 2) !== "not-current") {
        throw new Error("old token confirmed a new transition after PID reuse");
      }
      let staleRejected = false;
      try {
        store.finishSyncCycle({
          message: "old session cycle",
          meetings_total: 0,
          transcripts_total: 0,
          transcripts_done: 0,
          last_full_sync_ms: 1002,
          last_incremental_ms: 1002,
          workDone: true,
          cycle: { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
        });
      } catch (error) {
        staleRejected = error?.code === "SYNC_GENERATION_CHANGED";
      }
      if (!staleRejected) throw new Error("pending transition accepted a stale final write");
      if (store.getSyncState().blocking !== 1) {
        throw new Error("sync exposed cache during pending auth persistence");
      }
      if (store.confirmAuthPublication(claimed.intent, 2) !== "confirmed" ||
          store.getSyncState().auth_pending !== 0) {
        throw new Error("current persisted session was not confirmed");
      }
      staleRejected = false;
      try {
        store.finishSyncCycle({
          message: "new session cycle",
          meetings_total: 0,
          transcripts_total: 0,
          transcripts_done: 0,
          last_full_sync_ms: 1003,
          last_incremental_ms: 1003,
          workDone: true,
          cycle: { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
        });
      } catch (error) {
        staleRejected = error?.code === "SYNC_GENERATION_CHANGED";
      }
      if (!staleRejected) throw new Error("older generation final write was accepted");
      if (store.getSyncState().blocking !== 1) {
        throw new Error("older generation unblocked after clock-independent login");
      }
      store.activateCacheIdentity({
        generation: 2,
        publicationToken: tokenB,
        userId: "user-a",
        workspaceId: "workspace-a",
      });
      store.finishSyncCycle({
        message: "current session cycle",
        meetings_total: 0,
        transcripts_total: 0,
        transcripts_done: 0,
        last_full_sync_ms: 1004,
        last_incremental_ms: 1004,
        workDone: true,
        cycle: { generation: 2, publicationToken: tokenB, userId: "user-a", workspaceId: "workspace-a" },
      });
      if (store.getSyncState().blocking !== 0) {
        throw new Error("confirmed current session could not unblock");
      }

      const crashed = store.claimAuthPublication(
        { generation: 2, publicationToken: tokenB, userId: "user-a", workspaceId: "workspace-a" },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenC,
        303,
        () => false
      );
      if (crashed.kind !== "acquired") throw new Error("crash setup failed");
      const reconciled = contender.reconcileAuthState(
        { generation: 2, publicationToken: tokenB, userId: "user-a", workspaceId: "workspace-a" },
        () => false
      );
      state = store.getSyncState();
      if (reconciled.kind !== "incomplete" ||
          reconciled.code !== "AUTH_PUBLICATION_ABORTED" ||
          state.auth_issue_code !== "AUTH_PUBLICATION_ABORTED" ||
          state.blocking !== 1) {
        throw new Error("dead publication owner was not durably reconciled");
      }
      contender.close();
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("rejects stale identity writes and replaces cache only after activation", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const tokenA = "11111111-1111-4111-8111-111111111111";
      const tokenB = "22222222-2222-4222-8222-222222222222";
      const loginA = store.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenA,
        101,
        () => false,
      );
      if (loginA.kind !== "acquired") throw new Error("identity A claim failed");
      store.confirmAuthPublication(loginA.intent, 1);
      const cycleA = { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" };
      store.activateCacheIdentity(cycleA);
      store.writeSyncGeneration(cycleA, () => {
        store.upsertMeeting({
          id: "meeting-a",
          name: "Identity A",
          source: "sana-ai:meeting",
          created_at_ms: 1,
        });
        store.saveTranscript({
          meeting_id: "meeting-a",
          text: "identity A",
          json: "[]",
          word_count: 2,
          segment_count: 0,
        });
      });

      const loginB = store.claimAuthPublication(
        { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
        { userId: "user-b", workspaceId: "workspace-b" },
        "login",
        tokenB,
        202,
        () => false,
      );
      if (loginB.kind !== "acquired") throw new Error("identity B claim failed");
      store.confirmAuthPublication(loginB.intent, 2);
      if (store.getSyncState().blocking !== 1) {
        throw new Error("old identity cache was exposed after identity change");
      }
      let staleRejected = false;
      try {
        store.writeSyncGeneration(cycleA, () => {
          store.upsertMeeting({
            id: "stale-meeting",
            name: "stale",
            source: "sana-ai:meeting",
            created_at_ms: 2,
          });
        });
      } catch (error) {
        staleRejected = error?.code === "SYNC_GENERATION_CHANGED";
      }
      if (!staleRejected || store.getMeeting("stale-meeting") !== null) {
        throw new Error("stale generation wrote into the durable cache");
      }
      if (store.getMeeting("meeting-a") === null) {
        throw new Error("old cache was destroyed before replacement activation");
      }

      const cycleB = { generation: 2, publicationToken: tokenB, userId: "user-b", workspaceId: "workspace-b" };
      store.activateCacheIdentity(cycleB);
      if (store.getMeeting("meeting-a") !== null) {
        throw new Error("old identity cache survived activated replacement");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("malformed durable auth tuple becomes an observable blocking issue", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      store.db.prepare(
        "UPDATE sync_state SET auth_transition_token = ? WHERE id = 1"
      ).run("11111111-1111-4111-8111-111111111111");
      const reconciled = store.reconcileAuthState(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        () => false,
      );
      const state = store.getSyncState();
      if (
        reconciled.kind !== "incomplete" ||
        reconciled.code !== "AUTH_STATE_MALFORMED" ||
        state.auth_issue_code !== "AUTH_STATE_MALFORMED" ||
        state.blocking !== 1
      ) {
        throw new Error("malformed auth tuple was not durably blocked");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("stale daemon cannot mark a newer session as needing login", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const token = "11111111-1111-4111-8111-111111111111";
      const claim = store.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        token,
        101,
        () => false,
      );
      if (claim.kind !== "acquired") throw new Error("login claim failed");
      store.confirmAuthPublication(claim.intent, 1);
      store.updateSyncState({ phase: "synced" });
      const stale = store.markNeedsLoginIfCurrent(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        "stale session expired",
      );
      if (stale !== "stale" || store.getSyncState().phase !== "synced") {
        throw new Error("stale daemon overwrote the newer session phase");
      }
      const current = store.markNeedsLoginIfCurrent(
        { generation: 1, publicationToken: token, userId: "user-a", workspaceId: "workspace-a" },
        "current session expired",
      );
      if (current !== "marked" || store.getSyncState().phase !== "needs_login") {
        throw new Error("current expired session was not marked");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("confirmed login retires the previous needs-login phase atomically", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const tokenA = "11111111-1111-4111-8111-111111111111";
      const tokenB = "22222222-2222-4222-8222-222222222222";
      const first = store.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenA,
        101,
        () => false,
      );
      if (first.kind !== "acquired") throw new Error("first login failed");
      store.confirmAuthPublication(first.intent, 1);
      store.updateSyncState({
        phase: "needs_login",
        message: "old generation expired",
        error: "old expiry",
      });
      const second = store.claimAuthPublication(
        { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenB,
        202,
        () => false,
      );
      if (second.kind !== "acquired") throw new Error("second login failed");
      store.confirmAuthPublication(second.intent, 2);
      const state = store.getSyncState();
      if (
        state.phase !== "idle" ||
        state.error !== null ||
        state.auth_generation !== 2 ||
        state.auth_publication_token !== tokenB
      ) {
        throw new Error("new login retained the prior generation expiry");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("auth tuple CAS and cache operation guards reject stale identities", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const tokenA = "11111111-1111-4111-8111-111111111111";
      const tokenB = "22222222-2222-4222-8222-222222222222";
      const loginA = store.claimAuthPublication(
        { generation: 0, publicationToken: null, userId: null, workspaceId: null },
        { userId: "user-a", workspaceId: "workspace-a" },
        "login",
        tokenA,
        101,
        () => false,
      );
      if (loginA.kind !== "acquired") throw new Error("identity A claim failed");
      store.confirmAuthPublication(loginA.intent, 1);
      const tupleA = {
        generation: 1,
        publicationToken: tokenA,
        userId: "user-a",
        workspaceId: "workspace-a",
      };
      store.activateCacheIdentity(tupleA);
      store.updateSyncState({ blocking: 0, auth_pending: 0 });
      const guard = store.captureCacheOperation(tupleA);
      if (store.resetFailuresIfCurrent(tupleA) !== "reset") {
        throw new Error("current tuple did not reset failures");
      }
      if (
        store.recordSyncUnavailableIfCurrent(
          { ...tupleA, publicationToken: tokenB },
          "STALE",
          "stale",
          "must not persist",
        ) !== "stale"
      ) {
        throw new Error("stale sync issue write was accepted");
      }
      const invalidRefresh = store.claimAuthPublication(
        tupleA,
        { userId: "user-b", workspaceId: "workspace-b" },
        "refresh",
        "33333333-3333-4333-8333-333333333333",
        303,
        () => false,
      );
      if (
        invalidRefresh.kind !== "incomplete" ||
        invalidRefresh.code !== "AUTH_REFRESH_IDENTITY_MISMATCH"
      ) {
        throw new Error("refresh was allowed to change identity");
      }

      const loginB = store.claimAuthPublication(
        tupleA,
        { userId: "user-b", workspaceId: "workspace-b" },
        "login",
        tokenB,
        202,
        () => false,
      );
      if (loginB.kind !== "acquired") throw new Error("identity B claim failed");
      store.confirmAuthPublication(loginB.intent, 2);
      let changed = false;
      try {
        store.assertCacheOperation(guard);
      } catch (error) {
        changed = error?.code === "CACHE_OPERATION_CHANGED";
      }
      if (!changed) throw new Error("stale cache operation guard was accepted");
      if (store.clearSyncUnavailableIfCurrent(tupleA) !== "stale") {
        throw new Error("stale tuple cleared newer sync status");
      }
      store.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("identity tuple boundaries reject padded IDs and preserve paired absence", () => {
    const { child } = isolatedStore(`
      const store = new SanaStore(file);
      const token = "11111111-1111-4111-8111-111111111111";
      const secondToken = "22222222-2222-4222-8222-222222222222";
      const stateJson = () => JSON.stringify(store.getSyncState());
      const rejectWithoutPersistence = (label, operation) => {
        const before = stateJson();
        let caught;
        try {
          operation();
        } catch (error) {
          caught = error;
        }
        if (!(caught instanceof TypeError)) {
          throw caught ?? new Error(label + " accepted a padded identity");
        }
        if (stateJson() !== before) {
          throw new Error(label + " mutated persistence before rejection");
        }
      };

      for (const padded of [
        { userId: " padded-user ", workspaceId: "workspace-a" },
        { userId: "user-a", workspaceId: " padded-workspace " },
      ]) {
        rejectWithoutPersistence("session tuple", () =>
          store.markNeedsLoginIfCurrent(
            {
              generation: 1,
              publicationToken: token,
              ...padded,
            },
            "must not persist",
          ),
        );
        rejectWithoutPersistence("login publication target", () =>
          store.claimAuthPublication(
            {
              generation: 0,
              publicationToken: null,
              userId: null,
              workspaceId: null,
            },
            padded,
            "login",
            token,
            101,
            () => false,
          ),
        );
        rejectWithoutPersistence("request-code publication target", () =>
          store.claimAuthPublication(
            {
              generation: 0,
              publicationToken: null,
              userId: null,
              workspaceId: null,
            },
            padded,
            "request-code",
            token,
            101,
            () => false,
          ),
        );
        let cycleCallbackCalled = false;
        rejectWithoutPersistence("sync cycle tuple", () =>
          store.writeSyncGeneration(
            {
              generation: 1,
              publicationToken: token,
              ...padded,
            },
            () => {
              cycleCallbackCalled = true;
            },
          ),
        );
        if (cycleCallbackCalled) {
          throw new Error("padded sync cycle reached its write callback");
        }
        rejectWithoutPersistence("confirmed auth tuple", () =>
          store.resetFailuresIfCurrent({
            generation: 1,
            publicationToken: token,
            ...padded,
          }),
        );
      }
      store.close();

      const durableCases = [
        {
          name: "legacy-identity",
          patch: {
            auth_generation: 0,
            auth_publication_token: null,
            auth_user_id: "user-a",
            auth_workspace_id: "workspace-a",
          },
        },
        {
          name: "confirmed",
          patch: {
            auth_generation: 1,
            auth_publication_token: token,
            auth_user_id: " padded-user ",
            auth_workspace_id: "workspace-a",
          },
        },
        {
          name: "pending",
          patch: {
            blocking: 1,
            auth_pending: 1,
            auth_transition_pid: 101,
            auth_transition_token: token,
            auth_transition_generation: 1,
            auth_transition_kind: "request-code",
            auth_transition_user_id: "user-a",
            auth_transition_workspace_id: " padded-workspace ",
          },
        },
        {
          name: "cache",
          patch: {
            cache_user_id: " padded-user ",
            cache_workspace_id: "workspace-a",
          },
        },
      ];
      for (const durableCase of durableCases) {
        const malformed = new SanaStore(file + "." + durableCase.name);
        malformed.updateSyncState(durableCase.patch);
        let ownerProbeCalled = false;
        const result = malformed.reconcileAuthState(
          {
            generation: 0,
            publicationToken: null,
            userId: null,
            workspaceId: null,
          },
          () => {
            ownerProbeCalled = true;
            return true;
          },
        );
        const state = malformed.getSyncState();
        if (
          result.kind !== "incomplete" ||
          result.code !== "AUTH_STATE_MALFORMED" ||
          state.auth_issue_code !== "AUTH_STATE_MALFORMED" ||
          ownerProbeCalled
        ) {
          throw new Error(
            "padded " + durableCase.name +
              " tuple was authorized instead of blocked",
          );
        }
        malformed.close();
      }

      const absent = new SanaStore(file + ".absent");
      const claim = absent.claimAuthPublication(
        {
          generation: 0,
          publicationToken: null,
          userId: null,
          workspaceId: null,
        },
        { userId: null, workspaceId: null },
        "request-code",
        secondToken,
        202,
        () => false,
      );
      if (claim.kind !== "acquired") {
        throw new Error("paired absent request-code identity was rejected");
      }
      if (absent.confirmAuthPublication(claim.intent, 1) !== "confirmed") {
        throw new Error("paired absent publication was not confirmed");
      }
      const observed = {
        generation: 1,
        publicationToken: secondToken,
        userId: null,
        workspaceId: null,
      };
      const reconciled = absent.reconcileAuthState(
        observed,
        () => false,
      );
      if (
        reconciled.kind !== "current" ||
        absent.resetFailuresIfCurrent(observed) !== "reset"
      ) {
        throw new Error("documented paired identity absence was rejected");
      }
      const absentState = absent.getSyncState();
      if (
        absentState.auth_user_id !== null ||
        absentState.auth_workspace_id !== null ||
        absentState.cache_user_id !== null ||
        absentState.cache_workspace_id !== null
      ) {
        throw new Error("paired identity absence was not preserved exactly");
      }
      absent.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });

  test("recovered refresh clears only its own authentication issue", () => {
    const { child } = isolatedStore(`
      const tokenA = "11111111-1111-4111-8111-111111111111";
      const tokenB = "22222222-2222-4222-8222-222222222222";
      const seed = (store) => {
        const login = store.claimAuthPublication(
          { generation: 0, publicationToken: null, userId: null, workspaceId: null },
          { userId: "user-a", workspaceId: "workspace-a" },
          "login",
          tokenA,
          101,
          () => false,
        );
        if (login.kind !== "acquired") throw new Error("seed login failed");
        store.confirmAuthPublication(login.intent, 1);
        const refresh = store.claimAuthPublication(
          { generation: 1, publicationToken: tokenA, userId: "user-a", workspaceId: "workspace-a" },
          { userId: "user-a", workspaceId: "workspace-a" },
          "refresh",
          tokenB,
          202,
          () => false,
        );
        if (refresh.kind !== "acquired") throw new Error("refresh claim failed");
        store.markAuthPublicationIncomplete(
          refresh.intent,
          "AUTH_SESSION_PERSISTENCE_UNCERTAIN",
          "refresh persistence was uncertain",
          2,
        );
        return refresh;
      };

      const own = new SanaStore(file);
      seed(own);
      const recovered = own.reconcileAuthState(
        { generation: 2, publicationToken: tokenB, userId: "user-a", workspaceId: "workspace-a" },
        () => false,
      );
      const ownState = own.getSyncState();
      if (
        recovered.kind !== "current" ||
        ownState.auth_issue_code !== null ||
        ownState.auth_pending !== 0
      ) {
        throw new Error("recovered refresh did not clear its own issue");
      }
      own.close();

      const unrelatedFile = file + ".unrelated";
      const unrelated = new SanaStore(unrelatedFile);
      seed(unrelated);
      unrelated.updateSyncState({
        auth_issue_code: "AUTH_EXTERNAL_BLOCK",
        auth_issue_message: "an unrelated authentication problem remains",
        auth_issue_operation_token: null,
        auth_issue_generation: null,
        auth_issue_kind: null,
      });
      const blocked = unrelated.reconcileAuthState(
        { generation: 2, publicationToken: tokenB, userId: "user-a", workspaceId: "workspace-a" },
        () => false,
      );
      const unrelatedState = unrelated.getSyncState();
      if (
        blocked.kind !== "incomplete" ||
        unrelatedState.auth_issue_code !== "AUTH_EXTERNAL_BLOCK" ||
        unrelatedState.auth_pending !== 1
      ) {
        throw new Error("recovered refresh cleared an unrelated issue");
      }
      unrelated.close();
    `);
    expect(child.status, child.stderr).toBe(0);
  });
});
