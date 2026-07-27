import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dataDir = process.env.SANA_DATA_DIR;
const authenticatedOrigin = process.env.SANA_BASE_URL;
const daemonPidText = process.env.SANA_TEST_DAEMON_PID;
if (!dataDir) throw new Error("SANA_DATA_DIR is required");
if (!authenticatedOrigin) throw new Error("SANA_BASE_URL is required");
if (!daemonPidText || !/^[1-9]\d*$/.test(daemonPidText)) {
  throw new Error("SANA_TEST_DAEMON_PID must be a positive integer");
}
const daemonPid = Number(daemonPidText);
if (!Number.isSafeInteger(daemonPid)) throw new Error("SANA_TEST_DAEMON_PID is out of range");

mkdirSync(dataDir, { recursive: true });
const publicationToken = [
  "11111111",
  "1111",
  "4111",
  "8111",
  "111111111111",
].join("-");
const daemonInstanceId = [
  "22222222",
  "2222",
  "4222",
  "8222",
  "222222222222",
].join("-");
const contractUserId = ["user", "contract"].join("-");
const contractWorkspaceId = ["workspace", "contract"].join("-");
writeFileSync(
  path.join(dataDir, "session.json"),
  JSON.stringify({
    cookies: { "sana-ai-session": "synthetic-contract-session" },
    userId: contractUserId,
    workspaceId: contractWorkspaceId,
    email: "contract@example.invalid",
    authenticatedOrigin,
    pendingLogin: null,
    generation: 1,
    publicationToken,
  })
);

const { SanaStore } = await import("../../../src/store/db.js");
const { publishDaemonControl } = await import(
  "../../../src/sync/control.js"
);
const store = new SanaStore();
try {
  store.upsertMeeting({
    id: "meeting-alpha",
    external_id: "external-alpha",
    name: "Alpha planning",
    source: "sana-ai:meeting",
    created_at_ms: Date.parse("2026-01-02T10:00:00Z"),
    modified_at_ms: Date.parse("2026-01-02T11:00:00Z"),
    processing_phase: "done",
  });
  store.upsertMeeting({
    id: "meeting-gamma",
    external_id: "external-gamma",
    name: "Gamma pending",
    source: "sana-ai:meeting",
    created_at_ms: Date.parse("2026-01-04T10:00:00Z"),
    modified_at_ms: Date.parse("2026-01-04T11:00:00Z"),
    processing_phase: "done",
  });
  store.upsertMeeting({
    id: "meeting-delta",
    external_id: "external-delta",
    name: "Delta retrying",
    source: "sana-ai:meeting",
    created_at_ms: Date.parse("2026-01-05T10:00:00Z"),
    modified_at_ms: Date.parse("2026-01-05T11:00:00Z"),
    processing_phase: "done",
  });
  store.upsertMeeting({
    id: "meeting-beta",
    external_id: "external-beta",
    name: "Beta review",
    source: "sana-ai:meeting",
    created_at_ms: Date.parse("2026-01-03T10:00:00Z"),
    modified_at_ms: Date.parse("2026-01-03T11:00:00Z"),
    processing_phase: "done",
  });

  store.saveTranscript({
    meeting_id: "meeting-alpha",
    text: "Contract coverage works.",
    json: JSON.stringify([
      {
        speaker: "Alex",
        words: [
          { text: "Contract", start_timestamp: 5, end_timestamp: 5.2 },
          { text: "coverage", start_timestamp: 5.3, end_timestamp: 5.5 },
          { text: "works.", start_timestamp: 5.6, end_timestamp: 5.8 },
        ],
      },
      {
        speaker: "Blair",
        words: [
          { text: "Second", start_timestamp: 65, end_timestamp: 65.2 },
          { text: "line.", start_timestamp: 65.3, end_timestamp: 65.5 },
        ],
      },
    ]),
    word_count: 5,
    segment_count: 2,
  });
  store.saveTranscript({
    meeting_id: "meeting-beta",
    text: "Review contract path.",
    json: JSON.stringify([
      {
        speaker: "Casey",
        words: [
          { text: "Review", start_timestamp: 7, end_timestamp: 7.2 },
          { text: "contract", start_timestamp: 7.3, end_timestamp: 7.6 },
          { text: "path.", start_timestamp: 7.7, end_timestamp: 8 },
        ],
      },
    ]),
    word_count: 3,
    segment_count: 1,
  });
  store.saveMetadata({
    meeting_id: "meeting-alpha",
    summary: "The team verified the contract.",
    summary_short: "Contract verification.",
    notes_json: JSON.stringify({
      actionItems: [
        {
          action: "Review fixtures",
          assignedTo: "Alex",
          dueDate: "2026-01-04",
        },
      ],
      notes: [{ topic: "Coverage", notes: ["Exercise every safe output path."] }],
    }),
    participants_json: JSON.stringify([
      {
        displayName: "Alex",
        email: "alex@example.invalid",
        isHost: true,
      },
      {
        displayName: "Blair",
        email: "blair@example.invalid",
        isHost: false,
      },
    ]),
    has_recording: 1,
  });
  store.saveMetadata({
    meeting_id: "meeting-beta",
    summary: null,
    summary_short: null,
    notes_json: null,
    participants_json: null,
    has_recording: 0,
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    store.recordFailure("meeting-delta", "synthetic contract failure");
  }
  store.updateSyncState({
    phase: "synced",
    message: "synthetic contract state",
    meetings_total: 4,
    transcripts_done: 2,
    transcripts_total: 2,
    last_full_sync_ms: Date.parse("2026-01-03T12:00:00Z"),
    last_incremental_ms: Date.parse("2026-01-03T12:00:00Z"),
    daemon_pid: daemonPid,
    daemon_heartbeat_ms: Date.now(),
    daemon_instance_id: daemonInstanceId,
    blocking: 0,
    catchup_epoch_ms: null,
    error: null,
    auth_generation: 1,
    auth_publication_token: publicationToken,
    auth_user_id: contractUserId,
    auth_workspace_id: contractWorkspaceId,
    cache_user_id: contractUserId,
    cache_workspace_id: contractWorkspaceId,
  });
  publishDaemonControl(daemonPid, { instanceId: daemonInstanceId });
} finally {
  store.close();
}
