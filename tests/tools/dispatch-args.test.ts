import { afterEach, expect, test } from "bun:test";
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

test("invalid public requests return before auth, store, daemon, process, or network work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-dispatch-args-"));
  roots.push(root);
  const blockedDataPath = path.join(root, "data-is-a-file");
  fs.writeFileSync(blockedDataPath, "must remain untouched");

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        let networkCalls = 0;
        let processCalls = 0;
        const childProcess = require("node:child_process");
        childProcess.spawn = () => {
          processCalls++;
          throw new Error("invalid arguments attempted to spawn a process");
        };
        childProcess.spawnSync = () => {
          processCalls++;
          throw new Error("invalid arguments attempted a synchronous process");
        };
        globalThis.fetch = async () => {
          networkCalls++;
          throw new Error("invalid arguments reached the network");
        };
        const { sana } = await import("./src/tools/dispatch.ts");
        const { renderHelp } = await import("./src/tools/help.ts");
        const cases = [
          ["list", { page: "2" }, "page"],
          ["list_meetings", { limit: 1001 }, "limit"],
          ["read", { meeting_id: "meeting-a", timestamps: "false" }, "timestamps"],
          ["read_transcript", { meeting_id: "meeting-a", lines: [1, "2"] }, "lines"],
          ["search", { query: "pricing", sort: "recent" }, "sort"],
          ["summary", { meeting_id: 7 }, "meeting_id"],
          ["participants", { id: null }, "id"],
          ["recording", { meeting_id: {} }, "meeting_id"],
          ["status", { unexpected: true }, "unexpected"],
          ["help", { tool: 7 }, "tool"],
          ["login", { email: 7 }, "email"],
          ["login", { email: "person@example.com", confirmation_code: "abc" }, "confirmation_code"],
          ["login", { email: "person@example.com", confirmation_code: "12345" }, "confirmation_code"],
          ["login", { email: "person@example.com", confirmation_code: -123456 }, "confirmation_code"],
          ["login", { email: "person@example.com", confirmation_code: 1234567 }, "confirmation_code"],
          ["login", { email: "person@example.com", code: "abc" }, "code"],
          ["login", { email: "person@example.com", code: "12345" }, "code"],
          ["login", { email: "person@example.com", code: -123456 }, "code"],
          ["login", { email: "person@example.com", code: 1234567 }, "code"],
        ];
        for (const [tool, args, field] of cases) {
          const output = await sana(tool, args);
          if (!output.startsWith('Invalid argument "' + field + '":')) {
            throw new Error(tool + " did not return its argument error: " + output);
          }
        }
        const exactCases = [
          [
            "unknown-operation",
            {},
            'Unknown tool "unknown-operation". ' + renderHelp(),
          ],
          [
            "toString",
            {},
            'Unknown tool "toString". ' + renderHelp(),
          ],
          [
            "help",
            { tool: "unknown-operation" },
            renderHelp("unknown-operation"),
          ],
          [
            "login",
            {},
            'To sign in, provide the email connected to your Sana.ai subscription: meeting_transcripts("login", {"email":"you@example.com"}). A 6-digit code will be emailed to that address.',
          ],
          [
            "login",
            { email: "not-an-email" },
            "No sign-in request was sent for not-an-email. The sign-in code request was invalid before contacting Sana.",
          ],
          [
            "search",
            {},
            'Provide a search query: meeting_transcripts("search", {"query":"..."}). Optional: page, limit, sort, filter.',
          ],
          [
            "read",
            {},
            'Provide a meeting id: meeting_transcripts("read", {"meeting_id":"..."}). Get ids from meeting_transcripts("list") or "search".',
          ],
          [
            "summary",
            {},
            'Provide a meeting id: meeting_transcripts("summary", {"meeting_id":"..."}).',
          ],
          [
            "participants",
            {},
            'Provide a meeting id: meeting_transcripts("participants", {"meeting_id":"..."}).',
          ],
          [
            "recording",
            {},
            'Provide a meeting id: meeting_transcripts("recording", {"meeting_id":"..."}).',
          ],
        ];
        for (const [tool, args, expected] of exactCases) {
          const output = await sana(tool, args);
          if (output !== expected) {
            throw new Error(tool + " changed pure coaching: " + output);
          }
        }
        if (networkCalls !== 0) {
          throw new Error("invalid data arguments performed network work");
        }
        if (processCalls !== 0) {
          throw new Error("invalid requests performed process work");
        }
      `,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        SANA_DATA_DIR: blockedDataPath,
        SANA_TRANSCRIPTS_DIR: path.join(root, "transcripts"),
        SANA_SEMANTIC: "0",
      },
    },
  );

  expect(child.status, child.stderr).toBe(0);
  expect(fs.readFileSync(blockedDataPath, "utf8")).toBe(
    "must remain untouched",
  );
  expect(fs.readdirSync(root)).toEqual(["data-is-a-file"]);
});

test("preflight snapshots nested arguments before any asynchronous runtime work", async () => {
  const { preflightToolRequest } = await import(
    "../../src/tools/dispatch.js"
  );
  const args = {
    page: 2,
    filter: { date: { from: "2026-01-03" } },
  };
  const result = preflightToolRequest("list", args);
  expect(result.kind).toBe("continue");
  args.page = 9;
  args.filter.date.from = "not-a-date";
  if (result.kind === "continue") {
    expect(result.args).toEqual({
      page: 2,
      filter: { date: { from: "2026-01-03" } },
    });
  }
});

test("login preflight accepts only canonical six-digit code boundaries", async () => {
  const { preflightToolRequest } = await import(
    "../../src/tools/dispatch.js"
  );

  for (const field of ["confirmation_code", "code"] as const) {
    for (const code of ["000000", "999999", 100000, 999999]) {
      const result = preflightToolRequest("login", {
        email: "person@example.com",
        [field]: code,
      });
      expect(result.kind).toBe("continue");
    }

    for (const code of ["abc", "12345", -123456, 1234567]) {
      const result = preflightToolRequest("login", {
        email: "person@example.com",
        [field]: code,
      });
      expect(result).toEqual({
        kind: "respond",
        text: `Invalid argument "${field}": must be exactly six ASCII digits.`,
      });
    }
  }
});
