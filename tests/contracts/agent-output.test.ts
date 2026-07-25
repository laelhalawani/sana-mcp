import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_TARGETS } from "../../src/release/contract.js";
import { renderHelp, TOOLS } from "../../src/tools/help.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/contracts/", import.meta.url));
const CONTRACT_TESTS = fileURLToPath(new URL("./", import.meta.url));
const CONTRACT_LEDGER = fileURLToPath(
  new URL("../../docs/dev/contract-change-ledger.md", import.meta.url)
);
const AUTHORIZED_HELP_SOURCE = fileURLToPath(new URL("../../src/tools/help.ts", import.meta.url));

function readFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), "utf8").replace(
    /\r?\n$/,
    ""
  );
}

function allFixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? allFixtureFiles(absolute) : [absolute];
  });
}

describe("agent-facing output contract", () => {
  test("freezes the public help registry, descriptions, arguments, and examples", () => {
    const expected = JSON.parse(readFixture("tool-docs.json"));
    expect(TOOLS).toEqual(expected);
    expect(renderHelp()).toBe(readFixture("help.txt"));
  });

  test("freezes each detailed help document", () => {
    const docs = JSON.parse(readFixture("tool-docs.json")) as typeof TOOLS;
    for (const doc of docs) {
      const expected = [
        `meeting_transcripts("${doc.name}", ...)`,
        "",
        doc.summary,
        "",
        `Arguments: ${doc.args}`,
        `Example:   ${doc.example}`,
      ].join("\n");
      expect(renderHelp(doc.name)).toBe(expected);
    }
  });

  test("freezes detailed list help against an exact standalone fixture", () => {
    expect(renderHelp("list")).toBe(readFixture("help-list.txt"));
  });

  test("freezes unknown-tool coaching", () => {
    expect(renderHelp("not-a-tool")).toBe(
      'Unknown tool "not-a-tool". Run meeting_transcripts("help") to list tools.'
    );
  });

  test("freezes the accepted document envelope and alias names", () => {
    const contract = JSON.parse(readFixture("agent-output-shapes.json")) as {
      documentEnvelope: {
        accepted: string[];
        currentBaselineUsesFrontmatter: boolean;
      };
      aliases: {
        tools: Record<string, string>;
        arguments: Record<string, string>;
      };
    };

    expect(contract.documentEnvelope.accepted).toEqual([
      "Markdown or free text without frontmatter",
      "YAML frontmatter delimited by --- followed by Markdown or free text",
    ]);
    expect(contract.documentEnvelope.currentBaselineUsesFrontmatter).toBe(false);
    expect(contract.aliases.tools).toEqual({
      list_meetings: "list",
      read_transcript: "read",
    });
    expect(contract.aliases.arguments).toEqual({
      "login.code": "login.confirmation_code",
      id: "meeting_id",
    });
  });

  test("recursively sanitizes every owned contract source and fixture", () => {
    const liveDataSentinel = path.normalize(path.join(ROOT, "data")).replaceAll("\\", "/");
    const forbidden = [
      liveDataSentinel,
      ["//", "wsl.localhost", "/"].join(""),
      ["/", "home", "/"].join(""),
      ["C:", "/", "Users", "/"].join(""),
      ["g", "hp_"].join(""),
      ["github", "_pat_"].join(""),
    ];

    const files = [
      ...allFixtureFiles(FIXTURES),
      ...allFixtureFiles(CONTRACT_TESTS),
      CONTRACT_LEDGER,
      AUTHORIZED_HELP_SOURCE,
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const fixture = readFileSync(file, "utf8").replaceAll("\\", "/");
      for (const value of forbidden) {
        expect(fixture, `${path.relative(FIXTURES, file)} must not contain ${value}`).not.toContain(
          value
        );
      }
    }
  });

  test("rejects generic opaque identifiers while allowing explicit synthetic forms", () => {
    const files = [
      ...allFixtureFiles(FIXTURES),
      ...allFixtureFiles(CONTRACT_TESTS),
      CONTRACT_LEDGER,
      AUTHORIZED_HELP_SOURCE,
    ];
    const keyedIdentifier =
      /(?:\\?["'])?(?:meeting_id|external_id|id)(?:\\?["'])?\s*:\s*\\?["']([^"'\\]+)\\?["']/g;
    const allowed = /^(?:(?:meeting|external)-(?:alpha|beta|gamma|delta)|<meeting-id>|<id>|\.\.\.|meeting_id)$/;
    const uuid =
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
    const longEncodedToken =
      /\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;
    const reviewedCodeIdentifiers = new Set(RELEASE_TARGETS);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(keyedIdentifier)) {
        expect(
          match[1],
          `${path.relative(ROOT, file)} contains a non-synthetic id value`
        ).toMatch(allowed);
      }
      expect(
        content.match(uuid) ?? [],
        `${path.relative(ROOT, file)} contains a UUID-shaped token`
      ).toEqual([]);
      expect(
        (content.match(longEncodedToken) ?? []).filter(
          (candidate) => !reviewedCodeIdentifiers.has(candidate)
        ),
        `${path.relative(ROOT, file)} contains a long opaque or URL-safe encoded token`
      ).toEqual([]);
    }
  });
});
