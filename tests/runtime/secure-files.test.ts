import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  CorruptJsonFileError,
  CorruptJsonPreservationError,
  InvalidJsonValueError,
  JsonFileTooLargeError,
  SecurePathError,
  SecurePathManualActionError,
  ensureSecureDirectories,
  ensureSecureDirectory,
  isFilesystemRootPath,
  isObservedMountBoundaryPath,
  openSensitiveFile,
  readJsonFile,
  repairSensitiveFilePermissions,
  writeJsonAtomic,
} from "../../src/runtime/secure-files.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sana-private-files-"));
  roots.push(root);
  return root;
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("private storage paths", () => {
  test("creates and repairs managed directories and files", () => {
    const root = temporaryRoot();
    const directory = path.join(root, "profile", "transcripts");
    ensureSecureDirectories([path.dirname(directory), directory]);
    const file = path.join(path.dirname(directory), "session.json");
    const descriptor = openSensitiveFile(file, "wx");
    fs.writeFileSync(descriptor, "{}");
    fs.closeSync(descriptor);

    if (process.platform !== "win32") {
      expect(mode(path.dirname(directory))).toBe(0o700);
      expect(mode(directory)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
      fs.chmodSync(file, 0o644);
      repairSensitiveFilePermissions(file);
      expect(mode(file)).toBe(0o600);
    }
  });

  test("rejects roots, mount roots, links, and unexpected target types", () => {
    const root = temporaryRoot();
    expect(isFilesystemRootPath(path.parse(root).root)).toBe(true);
    expect(() => ensureSecureDirectory(path.parse(root).root)).toThrow();
    expect(() =>
      ensureSecureDirectory(root, { mountPoints: [root] }),
    ).toThrow();

    if (process.platform !== "win32") {
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      const linked = path.join(root, "linked");
      fs.symlinkSync(outside, linked, "dir");
      expect(() => ensureSecureDirectory(path.join(linked, "child"))).toThrow(
        SecurePathError,
      );

      const file = path.join(root, "file");
      fs.writeFileSync(file, "value");
      const fileLink = path.join(root, "file-link");
      fs.symlinkSync(file, fileLink);
      expect(() => openSensitiveFile(fileLink, "r")).toThrow(SecurePathError);
    }
  });

  test("detects an actual mounted filesystem boundary without mutation", () => {
    if (process.platform === "linux" && fs.existsSync("/mnt/c")) {
      const target = fs.statSync("/mnt/c");
      const parent = fs.statSync("/mnt");
      if (target.dev !== parent.dev) {
        expect(isObservedMountBoundaryPath("/mnt/c")).toBe(true);
      }
    }
  });

  test("preflights a directory batch before creating any requested path", () => {
    const root = temporaryRoot();
    const first = path.join(root, "first", "managed");
    const invalidParent = path.join(root, "not-a-directory");
    fs.writeFileSync(invalidParent, "value");
    expect(() =>
      ensureSecureDirectories([first, path.join(invalidParent, "managed")]),
    ).toThrow(SecurePathError);
    expect(fs.existsSync(path.join(root, "first"))).toBe(false);
  });

  test("translates Windows ACL adapter failures without replacing typed errors", () => {
    const first = path.join(temporaryRoot(), "first");
    const adapterFailure = new Error("adapter failed");
    let translated: unknown;
    try {
      ensureSecureDirectory(first, {
        platform: "win32",
        windowsAcl: () => {
          throw adapterFailure;
        },
      });
    } catch (error) {
      translated = error;
    }
    expect(translated).toBeInstanceOf(SecurePathManualActionError);
    expect((translated as SecurePathManualActionError).target).toBe(first);
    expect((translated as Error).cause).toBe(adapterFailure);

    const second = path.join(temporaryRoot(), "second");
    const typed = new SecurePathManualActionError(second, "typed failure");
    expect(() =>
      ensureSecureDirectory(second, {
        platform: "win32",
        windowsAcl: () => {
          throw typed;
        },
      }),
    ).toThrow(typed);
  });

  test("supports only explicit sensitive-file modes and preserves exclusive create", () => {
    const file = path.join(temporaryRoot(), "profile", "daemon.lock");
    const descriptor = openSensitiveFile(file, "wx");
    fs.closeSync(descriptor);
    expect(() => openSensitiveFile(file, "wx")).toThrow();
    expect(() => openSensitiveFile(file, "unsupported")).toThrow(TypeError);
  });
});

describe("private JSON", () => {
  const schema = z.object({ value: z.string() }).strict();

  test("writes atomically, validates on read, and leaves no temporary artifacts", () => {
    const file = path.join(temporaryRoot(), "profile", "config.json");
    writeJsonAtomic(file, { value: "first" });
    writeJsonAtomic(file, { value: "second" });
    expect(readJsonFile(file, schema)).toEqual({
      kind: "value",
      value: { value: "second" },
    });
    expect(
      fs
        .readdirSync(path.dirname(file))
        .filter((entry) => !entry.startsWith(".sana-acl-setup-")),
    ).toEqual(["config.json"]);
    if (process.platform !== "win32") expect(mode(file)).toBe(0o600);
  });

  test("rejects unsupported JSON before filesystem mutation", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => "side effect",
    });
    const sparse = new Array(1);
    const values: unknown[] = [
      undefined,
      1n,
      Number.NaN,
      cyclic,
      accessor,
      sparse,
      new Date(),
      { omitted: undefined },
    ];
    const root = temporaryRoot();
    for (const [index, value] of values.entries()) {
      const parent = path.join(root, String(index));
      expect(() => writeJsonAtomic(path.join(parent, "value.json"), value)).toThrow(
        InvalidJsonValueError,
      );
      expect(fs.existsSync(parent)).toBe(false);
    }
  });

  test("returns a typed missing state and rejects oversized input", () => {
    const file = path.join(temporaryRoot(), "profile", "config.json");
    expect(readJsonFile(file, schema)).toEqual({ kind: "missing" });
    fs.writeFileSync(file, JSON.stringify({ value: "too large" }), {
      mode: 0o600,
    });
    expect(() =>
      readJsonFile(file, schema, { maximumBytes: 4 }),
    ).toThrow(JsonFileTooLargeError);
  });

  test("reads at most maximumBytes plus one when a file grows after fstat", () => {
    const root = temporaryRoot();
    ensureSecureDirectory(root);
    const file = path.join(root, "growing.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    const originalFstat = fs.fstatSync;
    let calls = 0;
    fs.fstatSync = ((descriptor: number, options?: unknown) => {
      const stats = (
        originalFstat as (
          descriptor: number,
          options?: unknown,
        ) => fs.Stats | fs.BigIntStats
      )(descriptor, options);
      calls++;
      if (calls === 2) {
        fs.appendFileSync(file, Buffer.alloc(128, 65));
      }
      return stats;
    }) as typeof fs.fstatSync;
    const originalReadFile = fs.readFileSync;
    fs.readFileSync = (() => {
      throw new Error("unbounded readFileSync was used");
    }) as typeof fs.readFileSync;
    try {
      expect(() =>
        readJsonFile(file, z.object({}), {
          maximumBytes: 16,
          platform: "win32",
          windowsAcl: () => {},
        }),
      ).toThrow(JsonFileTooLargeError);
    } finally {
      fs.fstatSync = originalFstat;
      fs.readFileSync = originalReadFile;
    }
  });

  test("uses one bounded recovery path for repeated corrupt reads", () => {
    const file = path.join(temporaryRoot(), "profile", "session.json");
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, "{", { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        readJsonFile(file, schema);
        throw new Error("corrupt JSON unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(CorruptJsonFileError);
        expect((error as CorruptJsonFileError).quarantinePath).toBe(
          `${file}.corrupt`,
        );
      }
    }
    expect(
      fs
        .readdirSync(path.dirname(file))
        .filter((entry) => entry.includes(".corrupt")),
    ).toEqual(["session.json.corrupt"]);
  });

  test("preserves both files when the bounded recovery path differs", () => {
    const file = path.join(temporaryRoot(), "profile", "session.json");
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, "{", { mode: 0o600 });
    fs.writeFileSync(`${file}.corrupt`, "different", { mode: 0o600 });
    expect(() => readJsonFile(file, schema)).toThrow(
      CorruptJsonPreservationError,
    );
    expect(fs.readFileSync(file, "utf8")).toBe("{");
    expect(fs.readFileSync(`${file}.corrupt`, "utf8")).toBe("different");
  });

  test("aggregates bounded-read and recovery-write failures with close failures", () => {
    const root = temporaryRoot();
    ensureSecureDirectory(root);
    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, '{"value":"large"}', { mode: 0o600 });
    const originalClose = fs.closeSync;
    fs.closeSync = ((descriptor: number) => {
      originalClose(descriptor);
      throw new Error("read close failed");
    }) as typeof fs.closeSync;
    try {
      let caught: unknown;
      try {
        readJsonFile(oversized, schema, { maximumBytes: 4 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors[0]).toBeInstanceOf(
        JsonFileTooLargeError,
      );
      expect(
        ((caught as AggregateError).errors[1] as Error).message,
      ).toBe("read close failed");
    } finally {
      fs.closeSync = originalClose;
    }

    const corrupt = path.join(root, "corrupt.json");
    fs.writeFileSync(corrupt, "{", { mode: 0o600 });
    const originalWrite = fs.writeFileSync;
    let recoveryWrite = false;
    fs.writeFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof target === "number") {
        recoveryWrite = true;
        throw new Error("recovery write failed");
      }
      return (originalWrite as (...values: unknown[]) => void)(target, ...args);
    }) as typeof fs.writeFileSync;
    fs.closeSync = ((descriptor: number) => {
      originalClose(descriptor);
      if (recoveryWrite) throw new Error("recovery close failed");
    }) as typeof fs.closeSync;
    try {
      let caught: unknown;
      try {
        readJsonFile(corrupt, schema);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CorruptJsonPreservationError);
      const cause = (caught as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors.map((error) => (error as Error).message))
        .toEqual(["recovery write failed", "recovery close failed"]);
    } finally {
      fs.writeFileSync = originalWrite;
      fs.closeSync = originalClose;
    }
  });

  test(
    "aggregates directory flush and descriptor cleanup failures",
    { skip: process.platform === "win32" },
    () => {
      const file = path.join(temporaryRoot(), "profile", "config.json");
      const originalFsync = fs.fsyncSync;
      const originalClose = fs.closeSync;
      let fsyncCalls = 0;
      let directoryFlushFailed = false;
      fs.fsyncSync = ((descriptor: number) => {
        fsyncCalls++;
        if (fsyncCalls === 2) {
          directoryFlushFailed = true;
          throw new Error("directory flush failed");
        }
        return originalFsync(descriptor);
      }) as typeof fs.fsyncSync;
      fs.closeSync = ((descriptor: number) => {
        originalClose(descriptor);
        if (directoryFlushFailed) throw new Error("directory close failed");
      }) as typeof fs.closeSync;
      try {
        let caught: unknown;
        try {
          writeJsonAtomic(file, { value: "test" });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        expect(
          (caught as AggregateError).errors.map(
            (error) => (error as Error).message,
          ),
        ).toEqual(["directory flush failed", "directory close failed"]);
      } finally {
        fs.fsyncSync = originalFsync;
        fs.closeSync = originalClose;
      }
    },
  );
});
