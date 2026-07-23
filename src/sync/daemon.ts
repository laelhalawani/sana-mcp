import { SanaStore } from "../store/db.js";
import { SanaClient } from "../sana/client.js";
import { SessionExpiredError } from "../sana/types.js";
import { renderTranscript, countWords } from "../sana/transcript.js";
import { isDaemonAlive } from "./lock.js";

const INCREMENTAL_INTERVAL_MS = Number(process.env.SANA_SYNC_INTERVAL_MS ?? 10 * 60_000);
const HEARTBEAT_MS = 5_000;
const REQUEST_DELAY_MS = Number(process.env.SANA_REQUEST_DELAY_MS ?? 150);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function heartbeat(store: SanaStore): void {
  store.updateSyncState({ daemon_pid: process.pid, daemon_heartbeat_ms: Date.now() });
}

/** Sleep in small chunks so heartbeats keep flowing and shutdown is prompt. */
async function heartbeatSleep(store: SanaStore, ms: number, stop: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) {
    heartbeat(store);
    await sleep(Math.min(HEARTBEAT_MS, end - Date.now()));
  }
}

function markNeedsLogin(store: SanaStore): void {
  store.updateSyncState({
    phase: "needs_login",
    message: "Not logged in. Run meeting_transcripts(\"login\", {email}).",
    error: null,
  });
}

/** One sync cycle: refresh the meeting list, then download missing transcripts. */
async function syncOnce(store: SanaStore, client: SanaClient): Promise<void> {
  const firstEver = store.getSyncState().last_full_sync_ms == null;

  // --- refresh meeting list (stop early once a page is fully known, unless
  //     this is the very first sync where we want everything). ---
  store.updateSyncState({
    phase: "listing",
    message: firstEver ? "Fetching your meetings..." : "Checking for new meetings...",
    error: null,
  });
  let discovered = 0;
  await client.walkMeetings((assets) => {
    let newOnThisPage = 0;
    for (const a of assets) {
      const existed = store.getMeeting(a.id);
      store.upsertMeeting({
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
    heartbeat(store);
    // Incremental runs can stop once a whole page is already known.
    if (!firstEver && newOnThisPage === 0) return false;
  });

  const total = store.countMeetings();
  store.updateSyncState({ meetings_total: total });

  // --- download transcript + metadata for incomplete meetings ---
  // A meeting is complete only when it has both a transcript and metadata; we
  // fetch just the missing part so existing transcripts are not re-downloaded.
  let incomplete = store.meetingsIncomplete();
  const cap = Number(process.env.SANA_MAX_NEW_TRANSCRIPTS ?? 0);
  if (cap > 0) incomplete = incomplete.slice(0, cap);
  store.updateSyncState({
    phase: incomplete.length ? "downloading" : "synced",
    transcripts_total: total,
    transcripts_done: store.countComplete(),
    message: incomplete.length ? `Downloading meetings: 0/${incomplete.length}...` : "Up to date.",
  });

  let done = 0;
  let failed = 0;
  for (const id of incomplete) {
    try {
      if (!store.getTranscript(id)) {
        const segs = await client.getTranscription(id);
        store.saveTranscript({
          meeting_id: id,
          text: renderTranscript(segs),
          json: JSON.stringify(segs),
          word_count: countWords(segs),
          segment_count: segs.length,
        });
      }
      if (!store.getMetadata(id)) {
        const meta = await client.getMeetingById(id);
        const participants = await client.getMeetingParticipants(id);
        store.saveMetadata({
          meeting_id: id,
          summary: (meta?.summary ?? null) as string | null,
          summary_short: (meta?.summaryShort ?? null) as string | null,
          notes_json: meta
            ? JSON.stringify({ notes: meta.notes ?? null, actionItems: meta.actionItems ?? null })
            : null,
          participants_json: JSON.stringify(participants),
          has_recording: meta?.recordingUrl || meta?.fallbackRecordingUrl ? 1 : 0,
        });
      }
      store.clearFailure(id);
      done++;
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e; // abort the whole cycle
      store.recordFailure(id, (e as Error).message);
      failed++;
    }
    if ((done + failed) % 3 === 0 || done + failed === incomplete.length) {
      store.updateSyncState({
        transcripts_done: store.countComplete(),
        message: `Downloading meetings: ${done}/${incomplete.length}${failed ? ` (${failed} failed)` : ""}...`,
      });
      heartbeat(store);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const now = Date.now();
  const caughtUp = store.meetingsIncomplete().length === 0;
  store.updateSyncState({
    phase: "synced",
    message: `Up to date - ${total} meetings, ${store.countComplete()} complete.`,
    meetings_total: total,
    transcripts_total: total,
    transcripts_done: store.countComplete(),
    last_full_sync_ms: firstEver ? now : store.getSyncState().last_full_sync_ms,
    last_incremental_ms: now,
    // Release the login-triggered block only once nothing is left to download.
    blocking: caughtUp ? 0 : store.getSyncState().blocking,
    error: null,
  });
  if (discovered > 0 || done > 0) log(`sync: +${discovered} meetings, +${done} transcripts`);
}

export async function runDaemon(): Promise<void> {
  const store = new SanaStore();

  if (isDaemonAlive(store)) {
    log("daemon already running (pid", store.getSyncState().daemon_pid, ") - exiting");
    return;
  }

  let stopping = false;
  const stop = () => stopping;
  const shutdown = (sig: string) => {
    log("received", sig, "- shutting down");
    stopping = true;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  heartbeat(store);
  log("daemon started, pid", process.pid);

  try {
    while (!stopping) {
      const client = SanaClient.load();
      if (!client.hasAuthCookie()) {
        markNeedsLogin(store);
        await heartbeatSleep(store, 15_000, stop);
        continue;
      }
      try {
        const me = await client.me();
        if (!me) {
          markNeedsLogin(store);
          await heartbeatSleep(store, 15_000, stop);
          continue;
        }
        client.save();
        await syncOnce(store, client);
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          markNeedsLogin(store);
          await heartbeatSleep(store, 15_000, stop);
          continue;
        }
        log("sync error:", (e as Error).message);
        store.updateSyncState({ phase: "error", error: (e as Error).message });
        await heartbeatSleep(store, 30_000, stop);
        continue;
      }
      if (store.getSyncState().blocking === 1) {
        // Catch-up not complete (transient failures remain retriable) - retry soon.
        await heartbeatSleep(store, 10_000, stop);
      } else {
        // Wake early if a login requests a fresh catch-up (blocking flips to 1).
        await heartbeatSleep(
          store,
          INCREMENTAL_INTERVAL_MS,
          () => stopping || store.getSyncState().blocking === 1
        );
      }
    }
  } finally {
    store.updateSyncState({ daemon_pid: null, daemon_heartbeat_ms: null });
    store.close();
    log("daemon stopped");
  }
}
