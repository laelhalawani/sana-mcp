import { ExitPromptError } from "@inquirer/core";
import { z } from "zod";
import {
  rowStatus,
  type ArtifactProblem,
} from "../core/meetings.js";
import { sanitizeTerminalText } from "./render.js";
import {
  LocalAppRuntime,
  type AppRuntime,
} from "./runtime.js";
import {
  TerminalAppPrompts,
  type AppPrompts,
} from "./prompts.js";

type AppChoice =
  | "search"
  | "list"
  | "meeting"
  | "status"
  | "login"
  | "configure"
  | "quit";

function line(value = ""): void {
  process.stdout.write(`${sanitizeTerminalText(value, { multiline: true })}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function date(value: number): string {
  return new Date(value).toLocaleDateString();
}

function showArtifactIssue(problem: ArtifactProblem): void {
  const subject =
    problem.name === undefined
      ? `meeting "${problem.id}"`
      : `${problem.artifact} for "${problem.name}"`;
  const state =
    problem.kind === "corrupt" ? "is corrupt" : "is unavailable";
  line(`The cached ${subject} ${state} (${problem.code}).`);
  if (problem.detail) line(problem.detail);
  line("Re-sync the meeting cache before retrying.");
}

async function choose(
  prompts: AppPrompts,
  choices: ReadonlyArray<{ name: string; value: AppChoice }>,
): Promise<AppChoice> {
  return prompts.select({
    message: "What would you like to do?",
    choices,
    pageSize: choices.length,
  });
}

async function showStatus(runtime: AppRuntime): Promise<void> {
  const status = runtime.status();
  line();
  if (!status.session.loggedIn) {
    line(
      status.session.expired
        ? "Your Sana session has expired. Sign in again."
        : "You are not signed in to Sana.",
    );
    return;
  }
  if (status.authTransition) {
    line(`Authentication is not ready: ${status.authTransition.message}`);
    return;
  }
  line(`Sync status: ${status.phase.replaceAll("_", " ")}`);
  if (status.meetings !== null) line(`Meetings ready: ${status.meetings}`);
  if (status.remaining !== null && status.remaining > 0) {
    line(
      `Pending: ${status.remaining}${status.retrying ? ` (${status.retrying} retrying)` : ""}`,
    );
  }
  if (
    status.transcriptsDone !== null &&
    status.transcriptsTotal !== null
  ) {
    line(
      `Transcripts stored: ${status.transcriptsDone}/${status.transcriptsTotal}`,
    );
  }
  if (status.etaMinutes !== null && status.blocking) {
    line(`Estimated time remaining: ${status.etaMinutes} min`);
  }
  if (status.error) line(`Sync error: ${status.error}`);
  if (status.syncUnavailable) {
    line(`Background sync is unavailable: ${status.syncUnavailable.message}`);
  }
}

async function showMeetings(runtime: AppRuntime): Promise<void> {
  const result = runtime.meetings({ limit: 20, page: 1 });
  line();
  if (result.rows.length === 0) {
    line("No synced meetings found.");
    return;
  }
  for (const meeting of result.rows) {
    line(
      `${date(meeting.created_at_ms)}  ${meeting.name}  ` +
        `[${rowStatus(meeting)}]  ${meeting.id}`,
    );
  }
  if (result.hasMore) {
    line(`Showing 20 of ${result.total}. Use sana-mcp list --page 2 for more.`);
  }
}

async function showMeeting(
  runtime: AppRuntime,
  prompts: AppPrompts,
): Promise<void> {
  const input = await prompts.input("Meeting ID");
  if (input === null) return;
  const id = input.trim();
  if (!id) return;
  const action = await prompts.select({
    message: "Meeting view:",
    choices: [
      { name: "Transcript", value: "transcript" },
      { name: "Summary", value: "summary" },
      { name: "Participants", value: "participants" },
      { name: "Recording link", value: "recording" },
      { name: "Back", value: "back" },
    ],
  });
  if (action === "back") return;
  line();

  if (action === "transcript") {
    const result = runtime.transcript(id);
    if (result.kind === "no-meeting") {
      line(`No meeting found with ID ${id}.`);
      return;
    }
    if (result.kind === "still-listing") {
      line("The meeting list is still syncing. Check Sync status and try again.");
      return;
    }
    if (result.kind === "not-downloaded") {
      line(
        `The transcript for "${result.name}" is still downloading ` +
          `(${result.done}/${result.total}).`,
      );
      return;
    }
    if (result.kind === "corrupt" || result.kind === "unavailable") {
      showArtifactIssue(result);
      return;
    }
    line(result.name);
    for (const transcriptLine of result.lines) {
      line(
        `${transcriptLine.n}  [${transcriptLine.time}] ` +
          `${transcriptLine.speaker}: ${transcriptLine.text}`,
      );
    }
    return;
  }

  if (action === "summary") {
    const result = runtime.summary(id);
    if (result.kind === "no-meeting") {
      line(`No meeting found with ID ${id}.`);
      return;
    }
    if (result.kind === "none") {
      line(`No summary is available for ${result.name}.`);
      return;
    }
    if (result.kind === "corrupt" || result.kind === "unavailable") {
      showArtifactIssue(result);
      return;
    }
    line(result.view.name);
    if (result.view.summaryShort) line(result.view.summaryShort);
    if (result.view.summary) line(result.view.summary);
    for (const item of result.view.actionItems) {
      line(
        `- ${item.action}${item.assignedTo ? ` - ${item.assignedTo}` : ""}`,
      );
    }
    for (const topic of result.view.notes) {
      line(topic.topic);
      for (const note of topic.notes) line(`- ${note}`);
    }
    return;
  }

  if (action === "participants") {
    const result = runtime.participants(id);
    if (result.kind === "no-meeting") {
      line(`No meeting found with ID ${id}.`);
      return;
    }
    if (result.kind === "none") {
      line(`No participants are available for ${result.name}.`);
      return;
    }
    if (result.kind === "corrupt" || result.kind === "unavailable") {
      showArtifactIssue(result);
      return;
    }
    line(result.name);
    for (const participant of result.participants) {
      line(
        `${participant.displayName ?? participant.email ?? "Unnamed participant"}` +
          `${participant.displayName && participant.email ? `  ${participant.email}` : ""}` +
          `${participant.isHost ? "  (host)" : ""}`,
      );
    }
    return;
  }

  const result = await runtime.recording(id);
  if (result.kind === "ok") {
    line(result.name);
    line(result.url);
  } else if (result.kind === "none") {
    line(`No recording is available for ${result.name}.`);
  } else if (result.kind === "no-meeting") {
    line(`No meeting found with ID ${id}.`);
  } else if (result.kind === "expired") {
    line("Your Sana session has expired. Sign in again.");
  } else {
    line(`Could not load the recording link: ${result.message}`);
  }
}

async function signIn(
  runtime: AppRuntime,
  prompts: AppPrompts,
): Promise<void> {
  const emailInput = await prompts.input("Email for your Sana account");
  if (emailInput === null) return;
  const email = emailInput.trim();
  if (!email) return;
  if (!z.string().email().safeParse(email.toLowerCase()).success) {
    line("Enter a valid email address.");
    return;
  }
  await runtime.requestCode(email);
  line(`We emailed a 6-digit code to ${email}.`);
  const codeInput = await prompts.input("6-digit code");
  if (codeInput === null) return;
  const code = codeInput.trim();
  if (!code) {
    line("Sign-in paused. Run sana-mcp and choose Sign in when ready.");
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    line("The confirmation code must be exactly six digits.");
    return;
  }
  const result = await runtime.verifyCode(email, code);
  line(`Signed in as ${result.user.email}.`);
  if (result.kind === "sync-unavailable") {
    line(`Signed in, but background sync could not start: ${result.failure.message}`);
    if (result.failure.persistence) {
      line(
        `The sync failure status could not be persisted: ${result.failure.persistence.message}`,
      );
    }
  } else {
    line("Your meetings are syncing in the background.");
  }
}

async function showAccount(
  runtime: AppRuntime,
  prompts: AppPrompts,
): Promise<void> {
  runtime.refresh();
  const status = runtime.status();
  const state = status.session.loggedIn
    ? "signed in"
    : status.session.expired
      ? "session expired"
      : "not signed in";
  const action = await prompts.select({
    message: `Sana account - ${state}`,
    choices: [
      { name: "Back", value: "back" },
      {
        name: status.session.loggedIn ? "Sign in again" : "Sign in",
        value: "login",
      },
    ],
    pageSize: 2,
  });
  if (action === "login") await signIn(runtime, prompts);
}

function signedOutChoices(expired: boolean): Array<{
  name: string;
  value: AppChoice;
}> {
  return [
    {
      name: expired ? "Sign in again (session expired)" : "Sign in to Sana",
      value: "login",
    },
    { name: "Configure AI clients", value: "configure" },
    { name: "Quit", value: "quit" },
  ];
}

function signedInChoices(blocking: boolean): Array<{
  name: string;
  value: AppChoice;
}> {
  const pending = blocking ? " (syncing)" : "";
  return [
    { name: `Meetings${pending}`, value: "list" },
    ...(!blocking
      ? [{ name: "Search transcripts", value: "search" as const }]
      : []),
    { name: "Sync status", value: "status" },
    { name: "Sana account", value: "login" },
    { name: "Configuration", value: "configure" },
    { name: "Quit", value: "quit" },
  ];
}

export async function runApp(
  runtime?: AppRuntime,
  prompts: AppPrompts = new TerminalAppPrompts(),
): Promise<void> {
  if (!prompts.interactive) {
    line("Run sana-mcp in an interactive terminal.");
    return;
  }

  const activeRuntime = runtime ?? new LocalAppRuntime();
  try {
    for (;;) {
      activeRuntime.refresh();
      const status = activeRuntime.status();
      let choice: AppChoice;
      try {
        choice = await choose(
          prompts,
          status.session.loggedIn
            ? signedInChoices(status.blocking)
            : signedOutChoices(status.session.expired),
        );
      } catch (error) {
        if (error instanceof ExitPromptError) return;
        throw error;
      }
      if (choice === "quit") return;
      try {
        if (choice === "login") {
          if (status.session.loggedIn) {
            await showAccount(activeRuntime, prompts);
          } else {
            await signIn(activeRuntime, prompts);
          }
        }
        else if (choice === "configure") await activeRuntime.configure();
        else if (choice === "status") {
          const result = await prompts.syncStatus(activeRuntime);
          if (result.action === "quit") return;
        }
        else if (choice === "list") {
          const result = await prompts.meetingBrowser(activeRuntime);
          if (result.action === "quit") return;
        }
        else if (choice === "meeting") await showMeeting(activeRuntime, prompts);
        else if (choice === "search") {
          const result = await prompts.search(activeRuntime);
          if (result.action === "quit") return;
        }
      } catch (error) {
        if (error instanceof ExitPromptError) return;
        line(`Could not complete that action: ${errorMessage(error)}`);
      }
    }
  } finally {
    activeRuntime.close();
  }
}
