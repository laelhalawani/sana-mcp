import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ordinaryConfigOperations,
  publishConfigAtomic,
  readConfigSnapshot,
  removeConfigAtomic,
} from "../../src/install/atomic-config.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sana-mcp-atomic-"));
}

test("publication flushes a sibling temporary and leaves no artifacts", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    fs.writeFileSync(file, "before\n", { mode: 0o640 });
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "after\n",
      (raw) => (raw === "after\n" ? { ok: true } : { ok: false, reason: raw }),
    );
    assert.equal(result.state, "published");
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("failed post-publication verification is ambiguous and never rolls back", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    fs.writeFileSync(file, "before\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "published\n",
      () => ({ ok: false, reason: "semantic owner is not proven" }),
    );
    assert.equal(result.state, "ambiguous");
    assert.match(
      result.state === "ambiguous" ? result.reason : "",
      /not rolled back or removed/u,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "published\n");
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("absent-target verification failure leaves the published file in place", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "published\n",
      () => ({ ok: false, reason: "ownership is unavailable" }),
    );
    assert.equal(result.state, "ambiguous");
    assert.equal(fs.readFileSync(file, "utf8"), "published\n");
    assert.match(
      result.state === "ambiguous" ? result.reason : "",
      /not rolled back or removed/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("existence changes observed before rename are conflicts", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    const before = readConfigSnapshot(file);
    fs.writeFileSync(file, "competitor\n");
    const result = publishConfigAtomic(file, before, "candidate\n", () => ({
      ok: true,
    }));
    assert.equal(result.state, "conflict");
    assert.equal(fs.readFileSync(file, "utf8"), "competitor\n");
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test(
  "POSIX mode-only divergence observed before replacement is a conflict",
  { skip: process.platform === "win32" },
  () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "client.json");
    try {
      fs.writeFileSync(file, "before\n", { mode: 0o640 });
      const before = readConfigSnapshot(file);
      fs.chmodSync(file, 0o600);
      const result = publishConfigAtomic(file, before, "candidate\n", () => ({
        ok: true,
      }));
      assert.equal(result.state, "conflict");
      assert.equal(fs.readFileSync(file, "utf8"), "before\n");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  },
);

test(
  "POSIX mode-only divergence observed during post-check is ambiguous",
  { skip: process.platform === "win32" },
  () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "client.json");
    try {
      fs.writeFileSync(file, "before\n", { mode: 0o640 });
      const result = publishConfigAtomic(
        file,
        readConfigSnapshot(file),
        "candidate\n",
        () => ({ ok: true }),
        {
          ...ordinaryConfigOperations,
          readPublished(target) {
            const raw = ordinaryConfigOperations.readPublished(target);
            fs.chmodSync(target, 0o600);
            return raw;
          },
        },
      );
      assert.equal(result.state, "ambiguous");
      assert.match(
        result.state === "ambiguous" ? result.reason : "",
        /mode differs/u,
      );
      assert.equal(fs.readFileSync(file, "utf8"), "candidate\n");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  },
);

test("injected Windows publication accepts snapshots without POSIX modes", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    fs.writeFileSync(file, "before\n");
    const result = publishConfigAtomic(
      file,
      { exists: true, raw: "before\n" },
      "candidate\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        platform: "win32",
        readSnapshot(target) {
          const snapshot = ordinaryConfigOperations.readSnapshot(target);
          return snapshot.exists
            ? { exists: true, raw: snapshot.raw }
            : snapshot;
        },
      },
    );
    assert.equal(result.state, "published");
    assert.equal(fs.readFileSync(file, "utf8"), "candidate\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("injected POSIX publication verifies the reported postimage mode", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  let snapshotReads = 0;
  try {
    fs.writeFileSync(file, "before\n");
    const result = publishConfigAtomic(
      file,
      { exists: true, raw: "before\n", mode: 0o600 },
      "candidate\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        platform: "linux",
        readSnapshot(target) {
          snapshotReads += 1;
          const snapshot = ordinaryConfigOperations.readSnapshot(target);
          return snapshot.exists
            ? {
                exists: true,
                raw: snapshot.raw,
                mode: snapshotReads === 1 ? 0o600 : 0o640,
              }
            : snapshot;
        },
      },
      0o600,
    );
    assert.equal(result.state, "ambiguous");
    assert.match(
      result.state === "ambiguous" ? result.reason : "",
      /mode differs/u,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "candidate\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

for (const [phase, override] of [
  [
    "write",
    {
      writeAndFlushTemporary() {
        return {
          state: "failed" as const,
          owned: false,
          error: new Error("injected write failure"),
        };
      },
    },
  ],
  [
    "flush",
    {
      writeAndFlushTemporary(temporary: string) {
        fs.writeFileSync(temporary, "partial");
        return {
          state: "failed" as const,
          owned: true,
          error: new Error("injected flush failure"),
        };
      },
    },
  ],
  [
    "rename",
    {
      rename() {
        throw new Error("injected rename failure");
      },
    },
  ],
] as const) {
  test(`${phase} failure preserves the original and cleans the temporary`, () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "client.json");
    try {
      fs.writeFileSync(file, "original\n");
      const result = publishConfigAtomic(
        file,
        readConfigSnapshot(file),
        "candidate\n",
        () => ({ ok: true }),
        { ...ordinaryConfigOperations, ...override },
      );
      assert.equal(result.state, "failed");
      assert.match(
        result.state === "failed" ? result.reason : "",
        new RegExp(`injected ${phase} failure`, "u"),
      );
      assert.equal(fs.readFileSync(file, "utf8"), "original\n");
      assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
}

test("cleanup failure remains visible alongside the primary failure", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const temporary = path.join(directory, ".client.injected.tmp");
  try {
    fs.writeFileSync(file, "original\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "candidate\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        temporaryPath: () => temporary,
        writeAndFlushTemporary(candidate) {
          fs.writeFileSync(candidate, "partial");
          return {
            state: "failed",
            owned: true,
            error: new Error("injected write failure"),
          };
        },
        removeTemporary: () => "injected cleanup failure",
      },
    );
    assert.equal(result.state, "failed");
    assert.match(
      result.state === "failed" ? result.reason : "",
      /injected write failure; injected cleanup failure/u,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "original\n");
    assert.equal(fs.readFileSync(temporary, "utf8"), "partial");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("nested atomic write and close causes remain observable", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  try {
    fs.writeFileSync(file, "original\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "candidate\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        writeAndFlushTemporary: () => ({
          state: "failed",
          owned: false,
          error: new AggregateError(
            [
              new Error("injected write cause"),
              new Error("injected close cause"),
            ],
            "temporary write and close both failed",
          ),
        }),
      },
    );
    assert.equal(result.state, "failed");
    const reason = result.state === "failed" ? result.reason : "";
    assert.match(reason, /injected write cause/u);
    assert.match(reason, /injected close cause/u);
    assert.equal(fs.readFileSync(file, "utf8"), "original\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("exclusive-create collision never removes a temporary owned by another process", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  const occupied = path.join(directory, ".client.occupied.tmp");
  try {
    fs.writeFileSync(file, "original\n");
    fs.writeFileSync(occupied, "foreign temporary\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "candidate\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        temporaryPath: () => occupied,
      },
    );
    assert.equal(result.state, "failed");
    assert.match(
      result.state === "failed" ? result.reason : "",
      /EEXIST|exist/u,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "original\n");
    assert.equal(fs.readFileSync(occupied, "utf8"), "foreign temporary\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("final-parent links and Windows junctions are rejected at apply", (context) => {
  const directory = temporaryDirectory();
  const realParent = path.join(directory, "real");
  const linkedParent = path.join(directory, "linked");
  fs.mkdirSync(realParent);
  try {
    try {
      fs.symlinkSync(
        realParent,
        linkedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.diagnostic(
          "Windows junction creation is unavailable in this environment; the limitation is explicit",
        );
        return;
      }
      throw error;
    }
    const file = path.join(linkedParent, "client.json");
    const result = publishConfigAtomic(
      file,
      { exists: false, raw: "" },
      "candidate\n",
      () => ({ ok: true }),
    );
    assert.equal(result.state, "failed");
    assert.match(
      result.state === "failed" ? result.reason : "",
      /symbolic link or reparse point/u,
    );
    assert.equal(fs.existsSync(path.join(realParent, "client.json")), false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("Windows publication retries a transient rename after rechecking the preimage", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  let attempts = 0;
  try {
    fs.writeFileSync(file, "before\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "after\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        platform: "win32",
        rename(source, destination) {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error(
              "temporarily busy",
            ) as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }
          ordinaryConfigOperations.rename(source, destination);
        },
      },
    );
    assert.equal(result.state, "published");
    assert.equal(attempts, 2);
    assert.equal(fs.readFileSync(file, "utf8"), "after\n");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("Windows publication retry never overwrites a changed optimistic preimage", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  let renameAttempts = 0;
  let reads = 0;
  try {
    fs.writeFileSync(file, "before\n");
    const result = publishConfigAtomic(
      file,
      readConfigSnapshot(file),
      "after\n",
      () => ({ ok: true }),
      {
        ...ordinaryConfigOperations,
        platform: "win32",
        readSnapshot(target) {
          reads += 1;
          if (reads === 2) fs.writeFileSync(target, "competitor\n");
          return ordinaryConfigOperations.readSnapshot(target);
        },
        rename() {
          renameAttempts += 1;
          const error = new Error("temporarily busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      },
    );
    assert.equal(result.state, "conflict");
    assert.equal(renameAttempts, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "competitor\n");
    assert.deepEqual(fs.readdirSync(directory), ["client.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("Windows removal retries a transient unlink after rechecking the preimage", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "client.json");
  let attempts = 0;
  try {
    fs.writeFileSync(file, "before\n");
    const result = removeConfigAtomic(file, readConfigSnapshot(file), {
      ...ordinaryConfigOperations,
      platform: "win32",
      unlink(target) {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("temporarily busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        ordinaryConfigOperations.unlink(target);
      },
    });
    assert.equal(result.state, "removed");
    assert.equal(attempts, 2);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("Windows never attempts a parent-directory flush after a mutation", () => {
  const directory = temporaryDirectory();
  const published = path.join(directory, "published.json");
  const ambiguous = path.join(directory, "ambiguous.json");
  const removed = path.join(directory, "removed.json");
  let flushCalls = 0;
  const operations = {
    ...ordinaryConfigOperations,
    platform: "win32" as const,
    flushParent() {
      flushCalls += 1;
      throw new Error("Windows directory flush must not be called");
    },
  };
  try {
    fs.writeFileSync(published, "before\n");
    assert.equal(
      publishConfigAtomic(
        published,
        readConfigSnapshot(published),
        "after\n",
        () => ({ ok: true }),
        operations,
      ).state,
      "published",
    );

    fs.writeFileSync(ambiguous, "before\n");
    assert.equal(
      publishConfigAtomic(
        ambiguous,
        readConfigSnapshot(ambiguous),
        "after\n",
        () => ({ ok: false, reason: "injected ambiguity" }),
        operations,
      ).state,
      "ambiguous",
    );

    fs.writeFileSync(removed, "before\n");
    assert.equal(
      removeConfigAtomic(
        removed,
        readConfigSnapshot(removed),
        operations,
      ).state,
      "removed",
    );
    assert.equal(flushCalls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("POSIX still flushes the parent after published, ambiguous, and removed mutations", () => {
  const directory = temporaryDirectory();
  const published = path.join(directory, "published.json");
  const ambiguous = path.join(directory, "ambiguous.json");
  const removed = path.join(directory, "removed.json");
  let flushCalls = 0;
  const operations = {
    ...ordinaryConfigOperations,
    platform: "linux" as const,
    flushParent() {
      flushCalls += 1;
      return undefined;
    },
  };
  try {
    fs.writeFileSync(published, "before\n");
    assert.equal(
      publishConfigAtomic(
        published,
        readConfigSnapshot(published),
        "after\n",
        () => ({ ok: true }),
        operations,
      ).state,
      "published",
    );

    fs.writeFileSync(ambiguous, "before\n");
    assert.equal(
      publishConfigAtomic(
        ambiguous,
        readConfigSnapshot(ambiguous),
        "after\n",
        () => ({ ok: false, reason: "injected ambiguity" }),
        operations,
      ).state,
      "ambiguous",
    );

    fs.writeFileSync(removed, "before\n");
    assert.equal(
      removeConfigAtomic(
        removed,
        readConfigSnapshot(removed),
        operations,
      ).state,
      "removed",
    );
    assert.equal(flushCalls, 3);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
