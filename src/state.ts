import fs from "node:fs";
import { STATE_FILE, ensureDataDir } from "./config.js";

export interface DownloadedMeeting {
  id: string;
  title?: string;
  date?: string; // ISO string of the meeting date if known
  downloadedAt: string; // ISO timestamp of when we saved it
  files: string[]; // relative paths we wrote
}

export interface State {
  downloaded: Record<string, DownloadedMeeting>;
}

export function loadState(): State {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as State;
    if (!parsed.downloaded) parsed.downloaded = {};
    return parsed;
  } catch {
    return { downloaded: {} };
  }
}

export function saveState(state: State): void {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isDownloaded(state: State, id: string): boolean {
  return Boolean(state.downloaded[id]);
}

export function markDownloaded(state: State, meeting: DownloadedMeeting): void {
  state.downloaded[meeting.id] = meeting;
}
