import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyConfigTransaction,
  rollbackConfigTransaction,
  serializeConfigTransactionResult,
} from "../../src/install/config-transaction.js";
import type { ClientDef } from "../../src/install/clients.js";
import { standardConfigEntry } from "../../src/install/config-formats.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-config-tx-"));
}

function journalDirectory(root: string, name = "journal"): string {
  return path.join(root, name);
}

function fixture(
  id: string,
  file: string,
  detection: ReturnType<ClientDef["detect"]> = {
    state: "present",
    evidence: [file],
  },
): ClientDef {
  return {
    id,
    name: `Fixture ${id}`,
    detect: () => detection,
    install: {
      kind: "file",
      format: "json",
      path: () => ({ state: "available", path: file }),
      topKey: "mcpServers",
    },
    reloadHint: "reload",
  };
}

function applyOptions(
  root: string,
  clients: readonly ClientDef[],
  name = "journal",
) {
  return {
    journalDirectory: journalDirectory(root, name),
    serverCommand: process.execPath,
    yes: true,
    clients,
  } as const;
}

test("apply journals exact absent and empty preimages, then rollback is idempotent", async () => {
  const root = temporaryDirectory();
  const absent = path.join(root, "absent.json");
  const empty = path.join(root, "empty.json");
  fs.writeFileSync(empty, "", { mode: 0o640 });
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("absent", absent), fixture("empty", empty)]),
    );
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.appliedCount, 2);
    assert.equal(applied.noopCount, 0);
    assert.ok(applied.journal);

    const journal = JSON.parse(fs.readFileSync(applied.journal, "utf8"));
    assert.equal(journal.targets[0].before.exists, false);
    assert.equal("bytesBase64" in journal.targets[0].before, false);
    assert.equal(journal.targets[1].before.exists, true);
    assert.equal(journal.targets[1].before.bytesBase64, "");
    assert.equal(journal.targets[1].before.token.size, 0);
    if (process.platform === "win32") {
      assert.equal("mode" in journal.targets[1].before, false);
      assert.equal("mode" in journal.targets[1].before.token, false);
    } else {
      assert.equal(journal.targets[1].before.mode, 0o640);
      assert.equal(journal.targets[1].before.token.mode, 0o640);
    }
    const published = JSON.parse(
      Buffer.from(journal.targets[0].after.bytesBase64, "base64").toString(
        "utf8",
      ),
    );
    assert.equal(published.mcpServers["sana-mcp"].command, process.execPath);
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.dirname(applied.journal)).mode & 0o777,
        0o700,
      );
      assert.equal(fs.statSync(applied.journal).mode & 0o777, 0o600);
    }

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal),
    });
    assert.equal(rolledBack.outcome, "failed-rolled-back");
    assert.equal(rolledBack.exitCode, 0);
    assert.equal(fs.existsSync(absent), false);
    assert.equal(fs.readFileSync(empty, "utf8"), "");
    if (process.platform !== "win32")
      assert.equal(fs.statSync(empty).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(applied.journal), true);

    const repeated = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal),
    });
    assert.equal(repeated.outcome, "failed-rolled-back");
    assert.equal(repeated.exitCode, 0);
    assert.equal(fs.existsSync(absent), false);
    assert.equal(fs.readFileSync(empty, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("a mixed receipt round-trips an absent removal no-op", async () => {
  const root = temporaryDirectory();
  const absent = path.join(root, "absent.json");
  const added = path.join(root, "added.json");
  try {
    const applied = await applyConfigTransaction({
      journalDirectory: journalDirectory(root),
      serverCommand: process.execPath,
      mutations: [
        { client: fixture("absent", absent), desired: "absent" },
        { client: fixture("added", added), desired: "present" },
      ],
    });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.noopCount, 1);
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    assert.equal(journal.targets[0].desired, "absent");
    assert.equal(journal.targets[0].state, "noop");
    assert.equal(journal.targets[0].before.exists, false);
    assert.equal(journal.targets[0].after.exists, false);

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(rolledBack.outcome, "failed-rolled-back");
    assert.equal(fs.existsSync(absent), false);
    assert.equal(fs.existsSync(added), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("an already exact registration returns no mutation without creating a receipt", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  const expected = `${JSON.stringify(
    {
      mcpServers: {
        "sana-mcp": { command: process.execPath, args: ["mcp"] },
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(file, expected);
  const before = fs.statSync(file);
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("exact", file)]),
    );
    assert.equal(applied.outcome, "no-mutation");
    assert.equal(applied.appliedCount, 0);
    assert.equal(applied.noopCount, 1);
    assert.equal(fs.readFileSync(file, "utf8"), expected);
    assert.equal(fs.statSync(file).ino, before.ino);

    assert.equal(applied.journal, undefined);
    assert.equal(fs.existsSync(journalDirectory(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("a no-op changed during planning returns a typed conflict", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  const expected = `${JSON.stringify(
    {
      mcpServers: {
        "sana-mcp": { command: process.execPath, args: ["mcp"] },
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(file, expected);
  let builds = 0;
  const base = fixture("racing-noop", file);
  const client: ClientDef = {
    ...base,
    install: {
      ...base.install,
      build: (entry) => {
        builds += 1;
        if (builds === 2) fs.unlinkSync(file);
        return standardConfigEntry(entry);
      },
    },
  };
  try {
    const applied = await applyConfigTransaction(applyOptions(root, [client]));
    assert.equal(applied.outcome, "conflict");
    assert.equal(applied.errorCode, "CONFIG_TRANSACTION_CONFLICT");
    assert.equal(applied.journal, undefined);
    assert.equal(fs.existsSync(journalDirectory(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("rollback preserves divergence observed before mutation and compensates independent targets", async () => {
  const root = temporaryDirectory();
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("first", first), fixture("second", second)]),
    );
    assert.equal(applied.outcome, "applied");
    const concurrent = '{"concurrent":true}\n';
    fs.writeFileSync(second, concurrent);

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(rolledBack.outcome, "conflict");
    assert.equal(rolledBack.exitCode, 2);
    assert.equal(
      rolledBack.errorCode,
      "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
    );
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.readFileSync(second, "utf8"), concurrent);
    assert.equal(fs.existsSync(applied.journal!), true);
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    assert.equal(journal.targets[0].state, "rolled-back");
    assert.equal(journal.targets[1].state, "conflict");
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("rollback retry clears stale issues and repeated conflict text does not grow", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("retry", file)]),
    );
    const journalFile = applied.journal!;
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    const postimage = Buffer.from(
      journal.targets[0].after.bytesBase64,
      "base64",
    );
    fs.writeFileSync(file, "external edit\n");

    const first = rollbackConfigTransaction({
      journalDirectory: path.dirname(journalFile),
    });
    assert.equal(first.outcome, "conflict");
    const firstReceipt = fs.readFileSync(journalFile, "utf8");
    const second = rollbackConfigTransaction({
      journalDirectory: path.dirname(journalFile),
    });
    assert.equal(second.outcome, "conflict");
    assert.equal(fs.readFileSync(journalFile, "utf8"), firstReceipt);

    fs.writeFileSync(file, postimage);
    if (process.platform !== "win32")
      fs.chmodSync(file, journal.targets[0].after.mode);
    const corrected = rollbackConfigTransaction({
      journalDirectory: path.dirname(journalFile),
    });
    assert.equal(corrected.outcome, "failed-rolled-back");
    assert.equal(corrected.exitCode, 0);
    assert.equal(corrected.message, undefined);
    const correctedReceipt = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    assert.equal("issue" in correctedReceipt, false);
    assert.equal("issue" in correctedReceipt.targets[0], false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("an unreadable target state is rollback-incomplete, not proven compensation", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("unreadable", file)]),
    );
    assert.equal(applied.outcome, "applied");
    fs.unlinkSync(file);
    fs.mkdirSync(file);

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(rolledBack.outcome, "rollback-incomplete");
    assert.equal(rolledBack.exitCode, 2);
    assert.equal(
      rolledBack.errorCode,
      "CONFIG_TRANSACTION_ROLLBACK_INCOMPLETE",
    );
    assert.equal(fs.statSync(file).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("a later apply failure compensates every already-published target", async () => {
  const root = temporaryDirectory();
  const first = path.join(root, "first.json");
  const second = path.join(root, "second.json");
  const firstClient = fixture("first", first);
  let builds = 0;
  firstClient.install.build = (entry) => {
    builds += 1;
    if (builds === 2) {
      fs.writeFileSync(
        path.join(root, ".second.json.sana-mcp.journal.json"),
        "legacy blocker",
      );
    }
    return standardConfigEntry(entry);
  };
  try {
    const failed = await applyConfigTransaction(
      applyOptions(root, [firstClient, fixture("second", second)]),
    );
    assert.equal(failed.outcome, "failed-rolled-back");
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.errorCode, "CONFIG_TRANSACTION_APPLY_FAILED");
    assert.match(failed.message!, /legacy sana-mcp transaction artifacts/u);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), false);
    const journal = JSON.parse(fs.readFileSync(failed.journal!, "utf8"));
    assert.equal(journal.state, "failed-rolled-back");
    assert.equal(journal.targets[0].state, "rolled-back");
    assert.equal(journal.targets[1].state, "rolled-back");
    assert.equal("issue" in journal, false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test(
  "completed compensation with an unpersistable final receipt is persistence-unknown",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryDirectory();
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");
    const journal = journalDirectory(root);
    const secondClient = fixture("persistence", second);
    let builds = 0;
    secondClient.install.build = (entry) => {
      builds += 1;
      if (builds === 2) fs.chmodSync(journal, 0);
      return standardConfigEntry(entry);
    };
    try {
      const failed = await applyConfigTransaction(
        applyOptions(root, [fixture("first", first), secondClient]),
      );
      assert.equal(failed.outcome, "journal-persistence-unknown");
      assert.equal(
        failed.errorCode,
        "CONFIG_TRANSACTION_JOURNAL_PERSISTENCE_UNKNOWN",
      );
      assert.equal(failed.exitCode, 2);
      assert.equal(fs.existsSync(first), false);
      assert.equal(fs.existsSync(second), false);
      assert.match(failed.message!, /journal update failed/u);
    } finally {
      if (fs.existsSync(journal)) fs.chmodSync(journal, 0o700);
      fs.rmSync(root, { recursive: true });
    }
  },
);

test("an applying crash marker reconciles from the recorded postimage", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("crash", file)]),
    );
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    journal.state = "applying";
    journal.targets[0].state = "applying";
    fs.writeFileSync(
      applied.journal!,
      `${JSON.stringify(journal, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(rolledBack.outcome, "failed-rolled-back");
    assert.equal(rolledBack.exitCode, 0);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test(
  "POSIX mode-only postimage divergence is a rollback conflict",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryDirectory();
    const file = path.join(root, "client.json");
    try {
      const applied = await applyConfigTransaction(
        applyOptions(root, [fixture("mode-conflict", file)]),
      );
      assert.equal(applied.outcome, "applied");
      fs.chmodSync(file, 0o640);

      const rolledBack = rollbackConfigTransaction({
        journalDirectory: path.dirname(applied.journal!),
      });
      assert.equal(rolledBack.outcome, "conflict");
      assert.equal(rolledBack.exitCode, 2);
      assert.equal(fs.existsSync(file), true);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  },
);

test(
  "an exact POSIX preimage including mode is idempotently recognized",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryDirectory();
    const file = path.join(root, "client.json");
    const before = '{"unrelated":true}\n';
    fs.writeFileSync(file, before, { mode: 0o640 });
    try {
      const applied = await applyConfigTransaction(
        applyOptions(root, [fixture("preimage", file)]),
      );
      assert.equal(applied.outcome, "applied");
      fs.writeFileSync(file, before);
      fs.chmodSync(file, 0o640);

      const rolledBack = rollbackConfigTransaction({
        journalDirectory: path.dirname(applied.journal!),
      });
      assert.equal(rolledBack.outcome, "failed-rolled-back");
      assert.equal(rolledBack.exitCode, 0);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  },
);

test("full selection failures occur before config or journal writes", async () => {
  const root = temporaryDirectory();
  const ready = path.join(root, "ready.json");
  const collision = path.join(root, "collision.json");
  fs.writeFileSync(
    collision,
    '{"mcpServers":{"sana-mcp":{"command":"foreign","args":[]}}}\n',
  );
  try {
    const failed = await applyConfigTransaction(
      applyOptions(root, [
        fixture("ready", ready),
        fixture("collision", collision),
      ]),
    );
    assert.equal(failed.outcome, "failed-rolled-back");
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.errorCode, "CONFIG_TRANSACTION_PREPARATION_FAILED");
    assert.match(failed.message!, /Fixture collision/u);
    assert.equal(fs.existsSync(ready), false);
    assert.equal(fs.existsSync(journalDirectory(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("unavailable or empty selection never becomes a successful empty result", async () => {
  const root = temporaryDirectory();
  try {
    const unavailable = await applyConfigTransaction(
      applyOptions(
        root,
        [
          fixture("unknown", path.join(root, "unknown.json"), {
            state: "unavailable",
            reason: "probe failed",
          }),
        ],
        "unknown-journal",
      ),
    );
    assert.equal(unavailable.exitCode, 1);
    assert.match(unavailable.message!, /detection is unavailable/u);

    const absent = await applyConfigTransaction(
      applyOptions(
        root,
        [
          fixture("absent", path.join(root, "absent.json"), {
            state: "absent",
          }),
        ],
        "absent-journal",
      ),
    );
    assert.equal(absent.exitCode, 1);
    assert.match(absent.message!, /no supported AI clients/u);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("an unrelated unavailable detector does not invalidate proven present selection", async () => {
  const root = temporaryDirectory();
  const selected = path.join(root, "selected.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [
        fixture("selected", selected),
        fixture("unsupported", path.join(root, "unsupported.json"), {
          state: "unavailable",
          reason: "this client has no supported path on this platform",
        }),
      ]),
    );
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.appliedCount, 1);
    assert.equal(fs.existsSync(selected), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("consent, absolute private journal, and running command are validated", async () => {
  const root = temporaryDirectory();
  const client = fixture("fixture", path.join(root, "client.json"));
  try {
    const noConsent = await applyConfigTransaction({
      ...applyOptions(root, [client], "no-consent"),
      yes: false,
    });
    assert.equal(noConsent.exitCode, 1);
    assert.match(noConsent.message!, /--yes/u);
    assert.equal(fs.existsSync(journalDirectory(root, "no-consent")), false);

    const relative = await applyConfigTransaction({
      ...applyOptions(root, [client], "unused"),
      journalDirectory: "relative-journal",
    });
    assert.equal(relative.exitCode, 1);
    assert.match(relative.message!, /absolute path/u);

    const other = path.join(root, "other-command");
    fs.writeFileSync(other, "not this process", { mode: 0o700 });
    const wrongCommand = await applyConfigTransaction({
      ...applyOptions(root, [client], "wrong-command"),
      serverCommand: other,
    });
    assert.equal(wrongCommand.exitCode, 1);
    assert.match(wrongCommand.message!, /running standalone executable/u);

    if (process.platform !== "win32") {
      const broad = journalDirectory(root, "broad");
      fs.mkdirSync(broad, { mode: 0o755 });
      const nonPrivate = await applyConfigTransaction({
        ...applyOptions(root, [client], "broad"),
        journalDirectory: broad,
      });
      assert.equal(nonPrivate.exitCode, 1);
      assert.match(nonPrivate.message!, /permissions are not private/u);
      assert.equal(fs.statSync(broad).mode & 0o777, 0o755);
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test(
  "normal symlinked journal ancestors are canonicalized but a linked leaf is rejected",
  { skip: process.platform === "win32" },
  async () => {
    const root = temporaryDirectory();
    const realParent = path.join(root, "real");
    const aliasParent = path.join(root, "alias");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, aliasParent, "dir");
    const aliasedJournal = path.join(aliasParent, "journal");
    try {
      const applied = await applyConfigTransaction({
        ...applyOptions(root, [
          fixture("canonical", path.join(root, "client.json")),
        ]),
        journalDirectory: aliasedJournal,
      });
      assert.equal(applied.outcome, "applied");
      assert.equal(
        applied.journal,
        path.join(
          fs.realpathSync.native(path.join(realParent, "journal")),
          "client-config-transaction.json",
        ),
      );

      const rolledBack = rollbackConfigTransaction({
        journalDirectory: aliasedJournal,
      });
      assert.equal(rolledBack.outcome, "failed-rolled-back");
      assert.equal(rolledBack.journal, applied.journal);

      const linkedLeaf = path.join(aliasParent, "linked-journal");
      fs.symlinkSync(path.join(realParent, "journal"), linkedLeaf, "dir");
      const rejected = rollbackConfigTransaction({
        journalDirectory: linkedLeaf,
      });
      assert.equal(rejected.outcome, "journal-unavailable");
      assert.equal(rejected.exitCode, 1);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  },
);

test("malformed journal cannot route rollback and remains untouched", () => {
  const root = temporaryDirectory();
  const directory = journalDirectory(root);
  fs.mkdirSync(directory, { mode: 0o700 });
  const journal = path.join(directory, "client-config-transaction.json");
  const malformed =
    '{"transactionProtocol":1,"targets":[{"configPath":"/tmp/x"}]}\n';
  fs.writeFileSync(journal, malformed, { mode: 0o600 });
  try {
    const result = rollbackConfigTransaction({ journalDirectory: directory });
    assert.equal(result.exitCode, 1);
    assert.equal(result.outcome, "journal-unavailable");
    assert.equal(result.errorCode, "CONFIG_TRANSACTION_JOURNAL_UNAVAILABLE");
    assert.equal(fs.readFileSync(journal, "utf8"), malformed);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("a NUL-bearing target path is rejected before journal or config mutation", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("nul-path", file)]),
    );
    assert.equal(applied.outcome, "applied");
    const published = fs.readFileSync(file);
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    journal.targets[0].configPath = `${file}\0redirect`;
    const malformed = `${JSON.stringify(journal, null, 2)}\n`;
    fs.writeFileSync(applied.journal!, malformed, { mode: 0o600 });

    const result = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(result.outcome, "journal-unavailable");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, "CONFIG_TRANSACTION_JOURNAL_UNAVAILABLE");
    assert.equal(fs.readFileSync(applied.journal!, "utf8"), malformed);
    assert.deepEqual(fs.readFileSync(file), published);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

for (const malformed of [
  {
    name: "top-level applied state with a pending target",
    mutate(journal: any) {
      journal.targets[0].state = "pending";
    },
  },
  {
    name: "target digest inconsistent with the server target",
    mutate(journal: any) {
      journal.targets[0].serverTargetDigest = "0".repeat(64);
    },
  },
] as const) {
  test(`semantic journal invariant rejects ${malformed.name} before mutation`, async () => {
    const root = temporaryDirectory();
    const file = path.join(root, "client.json");
    try {
      const applied = await applyConfigTransaction(
        applyOptions(root, [fixture("invariant", file)]),
      );
      const published = fs.readFileSync(file);
      const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
      malformed.mutate(journal);
      const raw = `${JSON.stringify(journal, null, 2)}\n`;
      fs.writeFileSync(applied.journal!, raw, { mode: 0o600 });
      const result = rollbackConfigTransaction({
        journalDirectory: path.dirname(applied.journal!),
      });
      assert.equal(result.outcome, "journal-unavailable");
      assert.equal(result.exitCode, 1);
      assert.equal(fs.readFileSync(applied.journal!, "utf8"), raw);
      assert.deepEqual(fs.readFileSync(file), published);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });
}

test("noop image cross-invariant is validated before rollback mutation", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  const changed = path.join(root, "changed.json");
  const expected = `${JSON.stringify(
    {
      mcpServers: {
        "sana-mcp": { command: process.execPath, args: ["mcp"] },
      },
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(file, expected);
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [
        fixture("noop-invariant", file),
        fixture("changed", changed),
      ]),
    );
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    const bytes = Buffer.from("different\n");
    journal.targets[0].after = {
      exists: true,
      bytesBase64: bytes.toString("base64"),
      ...(process.platform === "win32"
        ? {}
        : { mode: journal.targets[0].before.mode }),
      token: {
        exists: true,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        ...(process.platform === "win32"
          ? {}
          : { mode: journal.targets[0].before.mode }),
      },
    };
    const raw = `${JSON.stringify(journal, null, 2)}\n`;
    fs.writeFileSync(applied.journal!, raw, { mode: 0o600 });
    const result = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(result.outcome, "journal-unavailable");
    assert.equal(fs.readFileSync(applied.journal!, "utf8"), raw);
    assert.equal(fs.readFileSync(file, "utf8"), expected);
    assert.equal(fs.existsSync(changed), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("rollback-incomplete requires an unresolved terminal target", async () => {
  const root = temporaryDirectory();
  const file = path.join(root, "client.json");
  try {
    const applied = await applyConfigTransaction(
      applyOptions(root, [fixture("terminal-invariant", file)]),
    );
    const journal = JSON.parse(fs.readFileSync(applied.journal!, "utf8"));
    journal.state = "rollback-incomplete";
    journal.issue = "invented unresolved rollback";
    journal.targets[0].state = "rolled-back";
    const raw = `${JSON.stringify(journal, null, 2)}\n`;
    fs.writeFileSync(applied.journal!, raw, { mode: 0o600 });

    const rolledBack = rollbackConfigTransaction({
      journalDirectory: path.dirname(applied.journal!),
    });
    assert.equal(rolledBack.outcome, "journal-unavailable");
    assert.equal(fs.readFileSync(applied.journal!, "utf8"), raw);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("missing rollback journal is journal-unavailable, never failed-rolled-back", () => {
  const root = temporaryDirectory();
  const directory = journalDirectory(root);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    const result = rollbackConfigTransaction({ journalDirectory: directory });
    assert.equal(result.outcome, "journal-unavailable");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, "CONFIG_TRANSACTION_JOURNAL_UNAVAILABLE");
    const wire = JSON.parse(serializeConfigTransactionResult(result));
    assert.equal(wire.outcome, "journal-unavailable");
    assert.equal(wire.operation, "rollback");
    assert.equal("exitCode" in wire, false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("wire result is one JSON line and excludes the local exit-code adapter", async () => {
  const root = temporaryDirectory();
  try {
    const value = await applyConfigTransaction({
      ...applyOptions(root, [
        fixture("fixture", path.join(root, "client.json")),
      ]),
      yes: false,
    });
    const wire = serializeConfigTransactionResult(value);
    assert.equal(wire.endsWith("\n"), true);
    assert.equal(wire.slice(0, -1).includes("\n"), false);
    const parsed = JSON.parse(wire);
    assert.equal(parsed.transactionProtocol, 1);
    assert.equal(parsed.operation, "apply");
    assert.equal(parsed.outcome, "failed-rolled-back");
    assert.equal("exitCode" in parsed, false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
