import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requireAuthoritativeHome } from "../runtime/home.js";
import { writeJsonAtomic } from "../runtime/private-json.js";

const RESET_PROTOCOL = 1 as const;
const JOURNAL_NAME = "incompatible-reset.json";

const journalSchema = z
  .object({
    resetProtocol: z.literal(RESET_PROTOCOL),
    token: z.string().uuid(),
    state: z.enum([
      "prepared",
      "quarantined",
      "fresh",
      "commit-started",
      "committed",
      "rollback-started",
      "rolled-back",
    ]),
    dataRoot: z.string().min(1),
    quarantine: z.string().min(1).nullable(),
    discard: z.string().min(1),
  })
  .strict();

type ResetJournal = z.infer<typeof journalSchema>;
export type IncompatibleResetTransactionState = ResetJournal["state"];

function requireInstallerAuthority(): void {
  if (process.env.SANA_MCP_INCOMPATIBLE_RESET !== "1") {
    throw new Error(
      "incompatible local-state reset is available only to the installer",
    );
  }
  if (
    process.env.SANA_DATA_DIR !== undefined ||
    process.env.SANA_TRANSCRIPTS_DIR !== undefined
  ) {
    throw new Error(
      "automatic incompatible replacement is unavailable with SANA_DATA_DIR or SANA_TRANSCRIPTS_DIR; move or remove those Sana directories manually",
    );
  }
}

function canonicalAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDirectoryOrMissing(value: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

function assertDirectory(value: string, label: string): void {
  assertDirectoryOrMissing(value, label);
  if (!fs.existsSync(value)) {
    throw new Error(`${label} is missing`);
  }
}

function journalFile(directory: string): string {
  return path.join(canonicalAbsolute(directory, "reset journal directory"), JOURNAL_NAME);
}

function writeJournal(file: string, value: ResetJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, value);
}

function readJournal(directory: string): ResetJournal {
  const file = journalFile(directory);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16_384) {
    throw new Error("incompatible reset journal is not a bounded regular file");
  }
  const journal = journalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const expectedRoot = defaultDataRoot();
  if (journal.dataRoot !== expectedRoot) {
    throw new Error("incompatible reset journal names an unexpected data root");
  }
  const expectedQuarantine = path.join(
    path.dirname(expectedRoot),
    `.sana-mcp-incompatible-${journal.token}`,
  );
  const expectedDiscard = path.join(
    path.dirname(expectedRoot),
    `.sana-mcp-incompatible-discard-${journal.token}`,
  );
  if (
    journal.quarantine !== null &&
    journal.quarantine !== expectedQuarantine
  ) {
    throw new Error("incompatible reset journal names an unexpected quarantine");
  }
  if (journal.discard !== expectedDiscard) {
    throw new Error("incompatible reset journal names an unexpected discard path");
  }
  return journal;
}

function defaultDataRoot(): string {
  const home = requireAuthoritativeHome();
  const root = path.join(home, ".sana-mcp");
  if (root === home || path.dirname(root) !== home) {
    throw new Error("default Sana data root could not be resolved safely");
  }
  return root;
}

export type IncompatibleResetResult = Readonly<{
  resetProtocol: typeof RESET_PROTOCOL;
  state: "fresh" | "committed" | "rolled-back";
  quarantinePresent: boolean;
}>;

export function prepareIncompatibleReset(options: {
  journalDirectory: string;
  installDirectory: string;
}): IncompatibleResetResult {
  requireInstallerAuthority();
  const dataRoot = defaultDataRoot();
  const installDirectory = canonicalAbsolute(
    options.installDirectory,
    "install directory",
  );
  if (overlaps(dataRoot, installDirectory) || overlaps(installDirectory, dataRoot)) {
    throw new Error("Sana data root overlaps the binary installation directory");
  }
  assertDirectoryOrMissing(dataRoot, "Sana data root");
  const file = journalFile(options.journalDirectory);
  if (fs.existsSync(file)) {
    throw new Error("incompatible reset journal already exists");
  }
  const token = crypto.randomUUID();
  const quarantine = fs.existsSync(dataRoot)
    ? path.join(path.dirname(dataRoot), `.sana-mcp-incompatible-${token}`)
    : null;
  const discard = path.join(
    path.dirname(dataRoot),
    `.sana-mcp-incompatible-discard-${token}`,
  );
  if (quarantine !== null && fs.existsSync(quarantine)) {
    throw new Error("incompatible reset quarantine already exists");
  }
  if (fs.existsSync(discard)) {
    throw new Error("incompatible reset discard path already exists");
  }
  let journalPublished = false;
  try {
    writeJournal(file, {
      resetProtocol: RESET_PROTOCOL,
      token,
      state: "prepared",
      dataRoot,
      quarantine,
      discard,
    });
    journalPublished = true;
    if (quarantine !== null) {
      fs.renameSync(dataRoot, quarantine);
      writeJournal(file, {
        resetProtocol: RESET_PROTOCOL,
        token,
        state: "quarantined",
        dataRoot,
        quarantine,
        discard,
      });
    }
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    writeJournal(file, {
      resetProtocol: RESET_PROTOCOL,
      token,
      state: "fresh",
      dataRoot,
      quarantine,
      discard,
    });
  } catch (error) {
    if (!journalPublished) throw error;
    try {
      rollbackIncompatibleReset(options.journalDirectory);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "incompatible state reset preparation and rollback both failed",
      );
    }
    throw error;
  }
  return {
    resetProtocol: RESET_PROTOCOL,
    state: "fresh",
    quarantinePresent: quarantine !== null,
  };
}

export function rollbackIncompatibleReset(
  journalDirectory: string,
): IncompatibleResetResult {
  requireInstallerAuthority();
  const journal = readJournal(journalDirectory);
  if (journal.state === "rolled-back") {
    return {
      resetProtocol: RESET_PROTOCOL,
      state: "rolled-back",
      quarantinePresent: false,
    };
  }
  if (
    journal.state === "commit-started" ||
    journal.state === "committed"
  ) {
    throw new Error("incompatible reset is not rollback-ready");
  }
  for (const [value, label] of [
    [journal.dataRoot, "Sana data root"],
    [journal.quarantine, "Sana data quarantine"],
    [journal.discard, "Sana reset discard"],
  ] as const) {
    if (value !== null) assertDirectoryOrMissing(value, label);
  }
  if (
    journal.quarantine !== null &&
    (journal.state === "quarantined" || journal.state === "fresh") &&
    !fs.existsSync(journal.quarantine)
  ) {
    throw new Error("Sana data quarantine is missing");
  }
  writeJournal(journalFile(journalDirectory), {
    ...journal,
    state: "rollback-started",
  });

  if (journal.quarantine !== null) {
    const dataPresent = fs.existsSync(journal.dataRoot);
    const quarantinePresent = fs.existsSync(journal.quarantine);
    const discardPresent = fs.existsSync(journal.discard);
    if (dataPresent && quarantinePresent && !discardPresent) {
      fs.renameSync(journal.dataRoot, journal.discard);
    } else if (
      (dataPresent && quarantinePresent && discardPresent) ||
      (!dataPresent && !quarantinePresent) ||
      (!dataPresent && !quarantinePresent && discardPresent)
    ) {
      throw new Error("incompatible reset rollback paths are inconsistent");
    }
    if (
      !fs.existsSync(journal.dataRoot) &&
      fs.existsSync(journal.quarantine)
    ) {
      fs.renameSync(journal.quarantine, journal.dataRoot);
    }
    if (
      !fs.existsSync(journal.dataRoot) ||
      fs.existsSync(journal.quarantine)
    ) {
      throw new Error("incompatible reset could not restore the original state");
    }
    if (fs.existsSync(journal.discard)) {
      fs.rmSync(journal.discard, { recursive: true });
    }
  } else {
    if (fs.existsSync(journal.dataRoot) && fs.existsSync(journal.discard)) {
      throw new Error("incompatible reset rollback paths are inconsistent");
    }
    if (fs.existsSync(journal.dataRoot)) {
      fs.renameSync(journal.dataRoot, journal.discard);
    }
    if (fs.existsSync(journal.discard)) {
      fs.rmSync(journal.discard, { recursive: true });
    }
  }
  writeJournal(journalFile(journalDirectory), {
    ...journal,
    state: "rolled-back",
  });
  return {
    resetProtocol: RESET_PROTOCOL,
    state: "rolled-back",
    quarantinePresent: false,
  };
}

export function commitIncompatibleReset(
  journalDirectory: string,
): IncompatibleResetResult {
  requireInstallerAuthority();
  const journal = readJournal(journalDirectory);
  if (journal.state === "committed") {
    return {
      resetProtocol: RESET_PROTOCOL,
      state: "committed",
      quarantinePresent: false,
    };
  }
  if (journal.state !== "fresh" && journal.state !== "commit-started") {
    throw new Error("incompatible reset is not commit-ready");
  }
  assertDirectory(journal.dataRoot, "fresh Sana data root");
  assertDirectoryOrMissing(journal.discard, "Sana reset discard");
  if (fs.existsSync(journal.discard)) {
    throw new Error("incompatible reset discard path is unexpectedly present");
  }
  const resuming = journal.state === "commit-started";
  if (journal.quarantine !== null) {
    assertDirectoryOrMissing(journal.quarantine, "Sana data quarantine");
    if (!resuming && !fs.existsSync(journal.quarantine)) {
      throw new Error("Sana data quarantine is missing");
    }
  }
  writeJournal(journalFile(journalDirectory), {
    ...journal,
    state: "commit-started",
  });
  if (journal.quarantine !== null) {
    if (fs.existsSync(journal.quarantine)) {
      fs.rmSync(journal.quarantine, { recursive: true });
    }
  }
  writeJournal(journalFile(journalDirectory), {
    ...journal,
    state: "committed",
  });
  return {
    resetProtocol: RESET_PROTOCOL,
    state: "committed",
    quarantinePresent: false,
  };
}

export function serializeIncompatibleResetResult(
  result: IncompatibleResetResult,
): string {
  return [
    `resetProtocol=${result.resetProtocol}`,
    `state=${result.state}`,
    `quarantinePresent=${String(result.quarantinePresent)}`,
    "",
  ].join("\n");
}

export function inspectIncompatibleReset(
  journalDirectory: string,
): Readonly<{
  resetProtocol: typeof RESET_PROTOCOL;
  transactionState: IncompatibleResetTransactionState;
}> {
  requireInstallerAuthority();
  const journal = readJournal(journalDirectory);
  return {
    resetProtocol: RESET_PROTOCOL,
    transactionState: journal.state,
  };
}

export function serializeIncompatibleResetStatus(
  result: ReturnType<typeof inspectIncompatibleReset>,
): string {
  return [
    `resetProtocol=${result.resetProtocol}`,
    `transactionState=${result.transactionState}`,
    "",
  ].join("\n");
}
