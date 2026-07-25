import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitIncompatibleReset,
  prepareIncompatibleReset,
  rollbackIncompatibleReset,
  serializeIncompatibleResetResult,
} from "../../src/install/incompatible-reset.js";

type EnvironmentSnapshot = Readonly<Record<string, string | undefined>>;

const MANAGED_ENVIRONMENT = [
  "HOME",
  "SANA_DATA_DIR",
  "SANA_TRANSCRIPTS_DIR",
  "SANA_MCP_INCOMPATIBLE_RESET",
] as const;

function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(
    MANAGED_ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const name of MANAGED_ENVIRONMENT) {
    const value = snapshot[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function withIsolatedHome<T>(
  callback: (paths: {
    root: string;
    home: string;
    data: string;
    install: string;
    journal: string;
  }) => T,
): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-incompatible-reset-"));
  const home = path.join(root, "home");
  const install = path.join(root, "install");
  const journal = path.join(root, "journal");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(install);
  fs.mkdirSync(journal);
  const environment = snapshotEnvironment();
  process.env.HOME = home;
  process.env.SANA_MCP_INCOMPATIBLE_RESET = "1";
  delete process.env.SANA_DATA_DIR;
  delete process.env.SANA_TRANSCRIPTS_DIR;
  try {
    return callback({
      root,
      home,
      data: path.join(home, ".sana-mcp"),
      install,
      journal,
    });
  } finally {
    restoreEnvironment(environment);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function resetJournal(journalDirectory: string): {
  state: string;
  dataRoot: string;
  quarantine: string | null;
  discard: string;
  token: string;
} {
  return JSON.parse(
    fs.readFileSync(
      path.join(journalDirectory, "incompatible-reset.json"),
      "utf8",
    ),
  ) as {
    state: string;
    dataRoot: string;
    quarantine: string | null;
    discard: string;
    token: string;
  };
}

describe("incompatible state reset transaction", () => {
  test("prepare quarantines existing data and rollback restores it", () => {
    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(path.join(data, "nested"), { recursive: true });
      fs.writeFileSync(path.join(data, "nested", "meeting.db"), "old-state");

      const prepared = prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      expect(prepared).toEqual({
        resetProtocol: 1,
        state: "fresh",
        quarantinePresent: true,
      });
      expect(fs.readdirSync(data)).toEqual([]);

      const transaction = resetJournal(journal);
      expect(transaction.dataRoot).toBe(data);
      expect(transaction.quarantine).not.toBeNull();
      expect(fs.readFileSync(
        path.join(transaction.quarantine!, "nested", "meeting.db"),
        "utf8",
      )).toBe("old-state");

      fs.writeFileSync(path.join(data, "new-state"), "discard-on-rollback");
      expect(rollbackIncompatibleReset(journal)).toEqual({
        resetProtocol: 1,
        state: "rolled-back",
        quarantinePresent: false,
      });
      expect(fs.readFileSync(path.join(data, "nested", "meeting.db"), "utf8"))
        .toBe("old-state");
      expect(fs.existsSync(path.join(data, "new-state"))).toBe(false);
      expect(fs.existsSync(transaction.quarantine!)).toBe(false);
      expect(resetJournal(journal).state).toBe("rolled-back");
      expect(rollbackIncompatibleReset(journal).state).toBe("rolled-back");
    });
  });

  test("commit keeps fresh state and permanently removes the quarantine", () => {
    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "old-state"), "old");
      prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      const transaction = resetJournal(journal);
      fs.writeFileSync(path.join(data, "new-state"), "new");

      expect(commitIncompatibleReset(journal)).toEqual({
        resetProtocol: 1,
        state: "committed",
        quarantinePresent: false,
      });
      expect(fs.readFileSync(path.join(data, "new-state"), "utf8")).toBe("new");
      expect(fs.existsSync(transaction.quarantine!)).toBe(false);
      expect(resetJournal(journal).state).toBe("committed");
      expect(commitIncompatibleReset(journal).state).toBe("committed");
    });
  });

  test("a missing original data root still creates a rollback-safe fresh root", () => {
    withIsolatedHome(({ data, install, journal }) => {
      expect(prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      })).toEqual({
        resetProtocol: 1,
        state: "fresh",
        quarantinePresent: false,
      });
      expect(fs.lstatSync(data).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(data, "temporary"), "new");

      expect(rollbackIncompatibleReset(journal).state).toBe("rolled-back");
      expect(fs.existsSync(data)).toBe(false);
      expect(resetJournal(journal).quarantine).toBeNull();
    });
  });

  test("requires explicit installer authority and rejects data overrides before mutation", () => {
    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "meeting.db"), "unchanged");

      delete process.env.SANA_MCP_INCOMPATIBLE_RESET;
      expect(() =>
        prepareIncompatibleReset({
          journalDirectory: journal,
          installDirectory: install,
        }),
      ).toThrow("available only to the installer");
      expect(fs.readFileSync(path.join(data, "meeting.db"), "utf8"))
        .toBe("unchanged");

      process.env.SANA_MCP_INCOMPATIBLE_RESET = "1";
      process.env.SANA_DATA_DIR = path.join(path.dirname(data), "custom-data");
      expect(() =>
        prepareIncompatibleReset({
          journalDirectory: journal,
          installDirectory: install,
        }),
      ).toThrow("automatic incompatible replacement is unavailable");
      expect(fs.readFileSync(path.join(data, "meeting.db"), "utf8"))
        .toBe("unchanged");
      expect(fs.readdirSync(journal)).toEqual([]);
    });
  });

  test("rejects overlapping install paths and non-directory data roots", () => {
    withIsolatedHome(({ data, home, journal }) => {
      fs.mkdirSync(data);
      expect(() =>
        prepareIncompatibleReset({
          journalDirectory: journal,
          installDirectory: path.join(data, "bin"),
        }),
      ).toThrow("overlaps");
      expect(fs.readdirSync(journal)).toEqual([]);

      fs.rmSync(data, { recursive: true });
      fs.writeFileSync(data, "not-a-directory");
      expect(() =>
        prepareIncompatibleReset({
          journalDirectory: journal,
          installDirectory: path.join(home, "bin"),
        }),
      ).toThrow("must be a regular directory");
      expect(fs.readFileSync(data, "utf8")).toBe("not-a-directory");
    });
  });

  test("rollback does not erase fresh state when its quarantine is missing", () => {
    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "old"), "old");
      prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      const transaction = resetJournal(journal);
      fs.writeFileSync(path.join(data, "fresh"), "must-survive");
      fs.rmSync(transaction.quarantine!, { recursive: true });

      expect(() => rollbackIncompatibleReset(journal)).toThrow(
        "quarantine is missing",
      );
      expect(fs.readFileSync(path.join(data, "fresh"), "utf8"))
        .toBe("must-survive");
      expect(resetJournal(journal).state).toBe("fresh");
    });
  });

  test("rollback and commit resume from their durable interruption phases", () => {
    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "old"), "old");
      prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      const file = path.join(journal, "incompatible-reset.json");
      const transaction = resetJournal(journal);
      fs.writeFileSync(path.join(data, "fresh"), "discard");

      fs.renameSync(data, transaction.discard);
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          ...transaction,
          state: "rollback-started",
        })}\n`,
      );
      expect(rollbackIncompatibleReset(journal).state).toBe("rolled-back");
      expect(fs.readFileSync(path.join(data, "old"), "utf8")).toBe("old");
      expect(fs.existsSync(transaction.discard)).toBe(false);
    });

    withIsolatedHome(({ data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "old"), "old");
      prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      const file = path.join(journal, "incompatible-reset.json");
      const transaction = resetJournal(journal);
      fs.writeFileSync(path.join(data, "fresh"), "keep");
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          ...transaction,
          state: "commit-started",
        })}\n`,
      );
      fs.rmSync(transaction.quarantine!, { recursive: true });

      expect(commitIncompatibleReset(journal).state).toBe("committed");
      expect(fs.readFileSync(path.join(data, "fresh"), "utf8")).toBe("keep");
    });
  });

  test("rejects a journal whose paths do not match the authoritative transaction", () => {
    withIsolatedHome(({ root, data, install, journal }) => {
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "old"), "old");
      prepareIncompatibleReset({
        journalDirectory: journal,
        installDirectory: install,
      });
      const file = path.join(journal, "incompatible-reset.json");
      const transaction = resetJournal(journal);
      const unrelated = path.join(root, "unrelated");
      fs.mkdirSync(unrelated);
      fs.writeFileSync(path.join(unrelated, "sentinel"), "untouched");
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ...transaction, dataRoot: unrelated })}\n`,
      );

      expect(() => rollbackIncompatibleReset(journal)).toThrow(
        "unexpected data root",
      );
      expect(fs.readFileSync(path.join(unrelated, "sentinel"), "utf8"))
        .toBe("untouched");
      expect(fs.existsSync(data)).toBe(true);
      expect(fs.existsSync(transaction.quarantine!)).toBe(true);
    });
  });

  test("serializes the bounded installer-facing result contract", () => {
    expect(
      serializeIncompatibleResetResult({
        resetProtocol: 1,
        state: "fresh",
        quarantinePresent: true,
      }),
    ).toBe(
      [
        "resetProtocol=1",
        "state=fresh",
        "quarantinePresent=true",
        "",
      ].join("\n"),
    );
  });
});
