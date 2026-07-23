export interface MeetingSummary {
  id: string; // assetId - used everywhere else
  externalId?: string | null;
  name: string;
  createdAtEpochMs: number;
  modifiedAtEpochMs?: number | null;
  source: string; // "sana-ai:meeting"
  processingPhase?: string | null; // "done" when Sana has finished processing
}

export interface TranscriptWord {
  text: string;
  start_timestamp: number;
  end_timestamp: number;
}

export interface TranscriptSegment {
  language?: string;
  speaker: string;
  words: TranscriptWord[];
}

export interface SanaUser {
  id: string;
  email: string;
  displayName?: string;
  lastUsedWorkspaceId?: string;
}

export interface MeWorkspace {
  authenticated: boolean;
  id: string;
  name?: string;
}

/** Thrown when the session is missing/expired so callers can prompt re-login. */
export class SessionExpiredError extends Error {
  constructor(message = "Sana session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}
