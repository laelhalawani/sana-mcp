import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  SanaStore,
  SyncGenerationChangedError,
  type SyncCycleIdentity,
} from "../store/db.js";
import { SanaClient } from "../sana/client.js";
import { SessionExpiredError } from "../sana/types.js";
import { renderTranscript, countWords, transcriptLines } from "../sana/transcript.js";
import {
  acquireDaemonLease,
  DaemonLeaseLostError,
  DaemonStaleOwnerError,
  heartbeatDaemonLease,
  pidAlive,
} from "./lock.js";
import {
  semanticEnabled,
  semanticCapabilityState,
  embedTexts,
  embedMeeting,
  ensureVec,
  EMBED_DIM,
  EMBED_MODEL,
  SEMANTIC_INDEX_VERSION,
  SemanticUnavailableError,
  type EmbedTexts,
  type VectorBackend,
  vectorBackendForPlatform,
} from "../semantic/semantic.js";
import { EmbeddingWorkerClient } from "../semantic/embedding-worker.js";
import { RUNTIME_ENV } from "../runtime/env.js";
import { dataDirectory, ensureDataDir } from "../config.js";
import {
  publishClientSession,
  requireCurrentSession,
} from "../sana/session-publication.js";
import {
  clearDaemonControl,
  daemonStopRequested,
  observeDaemonControl,
  publishDaemonControl,
  refreshDaemonControl,
  type DaemonControlIdentity,
  type DaemonControlObservation,
} from "./control.js";

const INCREMENTAL_INTERVAL_MS = RUNTIME_ENV.syncIntervalMs;
const HEARTBEAT_MS = 5_000;
const REQUEST_DELAY_MS = RUNTIME_ENV.requestDelayMs;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function awaitEmbeddingWithHeartbeat(
  embedBatch: EmbedTexts,
  texts: string[],
  heartbeatOrStop: () => void,
  intervalMs = HEARTBEAT_MS,
): Promise<Float32Array[]> {
  const controller = new AbortController();
  const outcome = embedBatch(texts, controller.signal).then(
    (vectors) => ({ kind: "done" as const, vectors }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  for (;;) {
    const result = await Promise.race([
      outcome,
      sleep(intervalMs).then(() => null),
    ]);
    if (result !== null) {
      if (result.kind === "error") throw result.error;
      return result.vectors;
    }
    try {
      heartbeatOrStop();
    } catch (error) {
      controller.abort(error);
      await outcome;
      throw error;
    }
  }
}

function log(...a: unknown[]): void {
  try {
    ensureDataDir();
    fs.appendFileSync(
      path.join(dataDirectory(), "daemon.log"),
      `${new Date().toISOString()} ${a
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join(" ")}\n`,
    );
  } catch {
    // best-effort logging
  }
}

class DaemonStopRequestedError extends Error {
  constructor() {
    super("Daemon stop requested");
    this.name = "DaemonStopRequestedError";
  }
}

export interface ForegroundControlDependencies {
  readonly observeControl: () => DaemonControlObservation;
  readonly pidAlive: (pid: number) => boolean;
  readonly clearControl: (identity: DaemonControlIdentity) => void;
}

export function retireDeadForegroundControl(
  dependencies: ForegroundControlDependencies,
): void {
  const observed = dependencies.observeControl();
  if (observed.kind === "missing") return;
  if (observed.kind === "legacy") {
    throw new Error(
      "Foreground daemon found legacy control authority; use the verified installer replacement path",
    );
  }
  if (dependencies.pidAlive(observed.identity.pid)) {
    throw new Error(
      `Foreground daemon control still names live process ${observed.identity.pid}; refusing restart`,
    );
  }
  dependencies.clearControl(observed.identity);
  const after = dependencies.observeControl();
  if (after.kind !== "missing") {
    throw new Error(
      "Foreground daemon control changed during proven-dead retirement; preserved the current authority",
    );
  }
}

/** @internal Reset persisted artifact backoff once after daemon lease acquisition. */
export function prepareDaemonRetryState(
  store: Pick<SanaStore, "resetFailures">,
): void {
  store.resetFailures();
}

function heartbeat(
  store: SanaStore,
  control: DaemonControlIdentity,
): boolean {
  heartbeatDaemonLease(store, control.instanceId);
  refreshDaemonControl(control);
  return daemonStopRequested(control.instanceId);
}

/** Sleep in small chunks so heartbeats keep flowing and shutdown is prompt. */
async function heartbeatSleep(
  store: SanaStore,
  ms: number,
  stop: () => boolean,
  control: DaemonControlIdentity,
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < ms && !stop()) {
    if (heartbeat(store, control)) return;
    await sleep(
      Math.max(
        0,
        Math.min(HEARTBEAT_MS, ms - (performance.now() - startedAt)),
      ),
    );
  }
}

function markNeedsLogin(
  store: Pick<SanaStore, "markNeedsLoginIfCurrent">,
  client: Pick<SanaClient, "sessionVersion">,
): "marked" | "stale" {
  return store.markNeedsLoginIfCurrent(
    client.sessionVersion(),
    "Not logged in. Run meeting_transcripts(\"login\", {email}).",
  );
}

/**
 * Resolve the local-only daemon gate before any authentication request.
 * A pending challenge is intentionally left resumable for the interactive
 * login flow; the daemon only keeps its lease alive until that state changes.
 *
 * @internal Exported for side-effect boundary tests.
 */
export async function daemonSessionPreflight(
  store: Pick<SanaStore, "markNeedsLoginIfCurrent">,
  client: Pick<
    SanaClient,
    "hasAuthCookie" | "pendingSignInChallenge" | "sessionVersion"
  >,
  wait: () => Promise<void>,
): Promise<"wait" | "authenticate"> {
  if (client.pendingSignInChallenge() !== null) {
    await wait();
    return "wait";
  }
  if (!client.hasAuthCookie()) {
    markNeedsLogin(store, client);
    await wait();
    return "wait";
  }
  return "authenticate";
}

/** One sync cycle: refresh the meeting list, then download missing transcripts. */
export async function syncOnce(
  store: SanaStore,
  client: SanaClient,
  cycle: SyncCycleIdentity,
  leaseInstanceId: string,
  stopRequested: () => boolean = () => false,
  controlHeartbeat: () => void = () => {},
  embedBatch: EmbedTexts = embedTexts,
): Promise<void> {
  const heartbeatOrStop = (): void => {
    heartbeatDaemonLease(store, leaseInstanceId);
    controlHeartbeat();
    if (stopRequested()) throw new DaemonStopRequestedError();
  };
  const embedWithHeartbeat: EmbedTexts = async (texts) => {
    try {
      return await awaitEmbeddingWithHeartbeat(
        embedBatch,
        texts,
        heartbeatOrStop,
      );
    } finally {
      // Revalidate after every attempt, including fast failures and batches
      // that finish before the periodic heartbeat, before any publication.
      heartbeatOrStop();
    }
  };
  const initialState = store.getSyncState();
  const identityChanged =
    initialState.cache_user_id !== cycle.userId ||
    initialState.cache_workspace_id !== cycle.workspaceId;
  const firstEver =
    identityChanged || initialState.last_full_sync_ms == null;
  const writeAuthState = <Value>(operation: () => Value): Value =>
    store.writeSyncGeneration(cycle, operation);
  const write = <Value>(operation: () => Value): Value =>
    store.writeCacheGeneration(cycle, operation);
  let preparedVectorBackend: VectorBackend | null = null;
  const selectedVectorBackend = vectorBackendForPlatform();
  const storedVectorBackends = store.vectorStorageBackends();
  if (
    identityChanged &&
    selectedVectorBackend === "portable" &&
    storedVectorBackends.has("sqlite-vec")
  ) {
    throw new Error(
      "Cannot replace the active cache from a portable runtime while sqlite-vec storage is present. Use a sqlite-vec-capable build to complete the account cache replacement.",
    );
  }
  if (storedVectorBackends.has(selectedVectorBackend)) {
    try {
      preparedVectorBackend = await ensureVec(store.db, writeAuthState);
    } catch (error) {
      if (identityChanged || !(error instanceof SemanticUnavailableError)) throw error;
      log(
        "semantic vector storage unavailable, continuing canonical sync with keyword search:",
        error.message,
      );
    }
  }
  // --- refresh the complete meeting list so source processing phases advance ---
  writeAuthState(() => {
    store.updateSyncState({
      phase: "listing",
      message: firstEver ? "Fetching your meetings..." : "Checking for new meetings...",
      error: null,
    });
  });
  let discovered = 0;
  const listedAssets: Array<Parameters<SanaStore["upsertMeeting"]>[0]> = [];
  await client.walkMeetings((assets) => {
    store.assertSyncGeneration(cycle);
    let newOnThisPage = 0;
    for (const a of assets) {
      const existed = store.getMeeting(a.id);
      listedAssets.push({
        id: a.id,
        external_id: a.externalId ?? null,
        name: a.name,
        source: a.source,
        created_at_ms: a.createdAtEpochMs,
        modified_at_ms: a.modifiedAtEpochMs ?? null,
        processing_phase: a.processingPhase ?? null,
      });
      if (!existed) newOnThisPage++;
    }
    discovered += newOnThisPage;
    heartbeatOrStop();
    store.assertSyncGeneration(cycle);
  });

  if (identityChanged) {
    // The complete listing succeeded for the authoritative identity, so the
    // previous rebuildable cache can now be replaced without exposing it.
    store.activateCacheIdentity(cycle, preparedVectorBackend ?? undefined);
  }
  write(() => {
    for (const meeting of listedAssets) store.upsertMeeting(meeting);
  });
  const total = store.countMeetings();
  write(() => {
    store.updateSyncState({ meetings_total: total });
  });

  // --- download transcript + metadata for incomplete meetings ---
  // A meeting is complete only when it has both a transcript and metadata; we
  // fetch just the missing part so existing transcripts are not re-downloaded.
  let incomplete = store.meetingsDue(Date.now());
  const pending = store.countIncomplete();
  const eligible = incomplete.length;
  const cap = RUNTIME_ENV.maxNewTranscripts;
  if (cap > 0) incomplete = incomplete.slice(0, cap);
  write(() => {
    store.updateSyncState({
      phase: pending > 0 ? "downloading" : "synced",
      transcripts_total: total,
      transcripts_done: store.countTranscripts(),
      message:
        incomplete.length > 0
          ? `Sync queue: ${pending} pending; ${incomplete.length} queued this cycle${eligible > incomplete.length ? ` (${eligible - incomplete.length} deferred by the configured cycle limit)` : ""}. Processing one meeting at a time.`
          : pending > 0
            ? `${pending} meeting(s) pending; waiting for Sana processing or the next retry time. One meeting is processed at a time.`
            : "Up to date.",
    });
  });
  store.releaseCurrentCache(cycle);

  let done = 0;
  let failed = 0;
  let processed = 0;
  for (const id of incomplete) {
    let lastError: unknown;
    write(() => {
      const currentPending = store.countIncomplete();
      store.updateSyncState({
        message: `Sync queue: processing ${processed + 1}/${incomplete.length} this cycle. ${currentPending} currently pending.`,
      });
    });

    // Transcript — fetched and saved independently.
    if (!store.getTranscript(id)) {
      try {
        const segs = await client.getTranscription(id).finally(
          async () => await sleep(REQUEST_DELAY_MS),
        );
        write(() =>
          store.saveTranscript({
            meeting_id: id,
            text: renderTranscript(segs),
            json: JSON.stringify(segs),
            word_count: countWords(segs),
            segment_count: segs.length,
          }, preparedVectorBackend ?? undefined),
        );
        done++;
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
        if (e instanceof SyncGenerationChangedError) throw e;
        lastError = e;
      }
    }

    // Metadata (summary, notes, participants) — fetched and saved independently
    // so a participant-validation error never discards the transcript.
    if (!store.getMetadata(id)) {
      try {
        const meta = await client.getMeetingById(id).finally(
          async () => await sleep(REQUEST_DELAY_MS),
        );
        const participants = await client.getMeetingParticipants(id).finally(
          async () => await sleep(REQUEST_DELAY_MS),
        );
        write(() =>
          store.saveMetadata({
            meeting_id: id,
            summary: (meta?.summary ?? null) as string | null,
            summary_short: (meta?.summaryShort ?? null) as string | null,
            notes_json: meta
              ? JSON.stringify({
                  notes: meta.notes ?? null,
                  actionItems: meta.actionItems ?? null,
                })
              : null,
            participants_json: JSON.stringify(participants),
            has_recording:
              meta?.recordingUrl || meta?.fallbackRecordingUrl ? 1 : 0,
          }),
        );
      } catch (e) {
        if (e instanceof SessionExpiredError) throw e;
        if (e instanceof SyncGenerationChangedError) throw e;
        if (lastError === undefined) lastError = e;
      }
    }

    const complete = store.getTranscript(id) !== null && store.getMetadata(id) !== null;
    if (complete) {
      write(() => store.clearFailure(id));
    } else if (lastError !== undefined) {
      const message =
        lastError instanceof Error ? lastError.message : String(lastError);
      write(() => store.recordFailure(id, message));
      failed++;
    }
    processed++;
    write(() => {
      const currentPending = store.countIncomplete();
      store.updateSyncState({
        transcripts_done: store.countTranscripts(),
        message: `Sync queue: processed ${processed}/${incomplete.length} this cycle; ${currentPending} currently pending${failed ? `; ${failed} failed this cycle` : ""}. One meeting is processed at a time.`,
      });
    });
    if (processed % 3 === 0 || processed === incomplete.length) {
      heartbeatOrStop();
    }
  }

  // --- semantic embeddings (required for hybrid search when enabled) ---
  // If the embedding runtime/deps are unavailable (e.g. the compiled binary was
  // built with them --external), we do NOT fail the whole sync: we skip
  // embeddings for this run so keyword search and canonical artifact state stay
  // available. Any ordinary embedding error is logged and retried next cycle.
  const semanticState = semanticCapabilityState();
  let semanticUsable = semanticEnabled();
  if (semanticState.kind === "unsupported") {
    log(
      "semantic search unavailable, continuing with keyword search:",
      semanticState.message,
    );
  }
  if (semanticUsable) {
    const vectorBackend = preparedVectorBackend ?? vectorBackendForPlatform();
    const needEmbed = store.meetingsMissingEmbedding(
      EMBED_DIM,
      EMBED_MODEL,
      SEMANTIC_INDEX_VERSION,
      vectorBackend,
    );
    let emb = 0;
    for (const id of needEmbed) {
      try {
        const t = store.getTranscript(id);
        if (!t) continue;
        const meeting = store.getMeeting(id);
        if (meeting?.created_at_ms == null) {
          throw new Error(
            "Cannot create a semantic embedding because the meeting has no authoritative creation timestamp; refresh the meeting list before retrying.",
          );
        }
        const lines = transcriptLines(JSON.parse(t.json)).map((l) => ({
          n: l.n,
          speaker: l.speaker,
          text: l.text,
        }));
        await embedMeeting(
          store.db,
          id,
          meeting.created_at_ms,
          t.fetched_ms,
          lines,
          (commit) => write(commit),
          embedWithHeartbeat,
        );
        emb++;
      } catch (e) {
        if (e instanceof DaemonLeaseLostError) throw e;
        if (e instanceof DaemonStopRequestedError) throw e;
        if (e instanceof SyncGenerationChangedError) throw e;
        if (e instanceof SemanticUnavailableError) {
          // Embeddings can't run in this environment; degrade to keyword-only
          // for the rest of this process and stop trying to embed.
          semanticUsable = false;
          log("semantic search unavailable, continuing with keyword search:", e.message);
          break;
        }
        log(
          "semantic embedding failed; will retry:",
          id,
          e instanceof Error ? e.message : String(e),
        );
      }
      if (emb % 3 === 0 || emb === needEmbed.length) {
        heartbeatOrStop();
      }
    }
  }

  const now = Date.now();
  // Finalize atomically from counts read under the current generation fence.
  // A safe partial cache is released while pending artifacts retain their phase.
  store.finishSyncCycle({
    last_full_sync_ms: firstEver ? now : store.getSyncState().last_full_sync_ms,
    last_incremental_ms: now,
    cycle,
  });
  if (discovered > 0 || done > 0) log(`sync: +${discovered} meetings, +${done} transcripts`);
}

export async function runDaemon(): Promise<void> {
  retireDeadForegroundControl({
    observeControl: () => observeDaemonControl(),
    pidAlive,
    clearControl: (identity) => clearDaemonControl(identity),
  });
  const store = new SanaStore();
  const embeddingWorker = new EmbeddingWorkerClient();
  let leaseAcquired = false;
  let leaseInstanceId: string | undefined;
  let control: DaemonControlIdentity | undefined;
  let primaryError: unknown;
  let stopping = false;
  const stop = () => stopping;
  const shutdown = (sig: string) => {
    log("received", sig, "- shutting down");
    stopping = true;
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");

  try {
    const claim = acquireDaemonLease(store);
    if (claim.kind === "busy") {
      if (claim.ownerHeartbeat === "stale") {
        throw new DaemonStaleOwnerError(claim.ownerPid);
      }
      log("daemon already running (pid", claim.ownerPid, ") - exiting");
      return;
    }
    leaseAcquired = true;
    leaseInstanceId = claim.instanceId;
    prepareDaemonRetryState(store);
    const activeControl = publishDaemonControl(process.pid, {
      instanceId: claim.instanceId,
    });
    control = activeControl;
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    log("daemon started, pid", process.pid);

    while (!stopping) {
      if (daemonStopRequested(activeControl.instanceId)) {
        stopping = true;
        break;
      }
      const client = SanaClient.load();
      const preflight = await daemonSessionPreflight(
        store,
        client,
        async () =>
          await heartbeatSleep(store, 15_000, stop, activeControl),
      );
      if (preflight === "wait") {
        if (daemonStopRequested(activeControl.instanceId)) stopping = true;
        continue;
      }
      let activeCycle: SyncCycleIdentity | undefined;
      try {
        const loadedVersion = client.sessionVersion();
        if (
          loadedVersion.generation > 0 &&
          loadedVersion.publicationToken !== null &&
          loadedVersion.userId != null &&
          loadedVersion.workspaceId != null
        ) {
          activeCycle = requireCurrentSession(store, client);
        }
        await client.me();
        publishClientSession(store, client, "refresh", loadedVersion);
        const currentClient = SanaClient.load();
        activeCycle = requireCurrentSession(store, currentClient);
        await syncOnce(
          store,
          currentClient,
          activeCycle,
          activeControl.instanceId,
          () => stopping || daemonStopRequested(activeControl.instanceId),
          () => refreshDaemonControl(activeControl),
          embeddingWorker.embed,
        );
      } catch (e) {
        if (e instanceof DaemonLeaseLostError) throw e;
        if (e instanceof DaemonStopRequestedError) {
          stopping = true;
          continue;
        }
        if (e instanceof SyncGenerationChangedError) {
          log("sync session changed; restarting with the confirmed generation");
          continue;
        }
        if (e instanceof SessionExpiredError) {
          if (markNeedsLogin(store, client) === "stale") continue;
          await heartbeatSleep(store, 15_000, stop, activeControl);
          if (daemonStopRequested(activeControl.instanceId)) stopping = true;
          continue;
        }
        log("sync error:", (e as Error).message);
        if (activeCycle !== undefined) {
          try {
            store.writeSyncGeneration(activeCycle, () => {
              store.updateSyncState({
                phase: "error",
                error: (e as Error).message,
              });
            });
          } catch (stateError) {
            if (stateError instanceof SyncGenerationChangedError) continue;
            throw stateError;
          }
        }
        await heartbeatSleep(store, 30_000, stop, activeControl);
        if (daemonStopRequested(activeControl.instanceId)) stopping = true;
        continue;
      }
      if (store.getSyncState().blocking === 1) {
        // Catch-up not complete (transient failures remain retriable) - retry soon.
        await heartbeatSleep(store, 10_000, stop, activeControl);
      } else {
        // Wake early if a login requests a fresh catch-up (blocking flips to 1).
        await heartbeatSleep(
          store,
          INCREMENTAL_INTERVAL_MS,
          () => stopping || store.getSyncState().blocking === 1,
          activeControl,
        );
      }
      if (daemonStopRequested(activeControl.instanceId)) stopping = true;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    const errors: unknown[] = [];
    let retainControl = false;
    try {
      await embeddingWorker.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      finalizeDaemonResources(
        store,
        leaseAcquired,
        leaseInstanceId,
        primaryError,
      );
    } catch (error) {
      if (
        error instanceof DaemonResourceFinalizationError &&
        error.retainControl
      ) {
        retainControl = true;
      }
      if (error instanceof AggregateError) errors.push(...error.errors);
      else errors.push(error);
    }
    if (control !== undefined && !retainControl) {
      try {
        clearDaemonControl(control);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Daemon execution, database cleanup, or control cleanup failed",
      );
    }
    if (leaseAcquired) log("daemon stopped");
  }
}

export class DaemonResourceFinalizationError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly retainControl: boolean,
  ) {
    super(errors, "Daemon execution or cleanup failed");
    this.name = "DaemonResourceFinalizationError";
  }
}

/**
 * Complete daemon cleanup in successor-safe order. Each action is attempted
 * even if an earlier action fails, and every failure remains observable.
 *
 * @internal Exported to exercise failure aggregation without starting a daemon.
 */
export function finalizeDaemonResources(
  store: Pick<SanaStore, "clearDaemonIdentityIfOwned" | "close">,
  leaseAcquired: boolean,
  leaseInstanceId?: string,
  primaryError?: unknown,
): void {
  const errors: unknown[] = [];
  let closeFailed = false;
  if (primaryError !== undefined) errors.push(primaryError);

  if (leaseAcquired) {
    try {
      if (leaseInstanceId === undefined) {
        throw new Error(
          "Acquired daemon lease is missing its instance identity",
        );
      }
      const result = store.clearDaemonIdentityIfOwned(
        process.pid,
        leaseInstanceId,
      );
      if (result === "not-owner") {
        log(
          "daemon identity was not cleared because it no longer belongs to pid",
          process.pid,
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    store.close();
  } catch (error) {
    closeFailed = true;
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new DaemonResourceFinalizationError(errors, closeFailed);
  }
}
