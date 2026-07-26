import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import * as bunSqlite from "bun:sqlite";
import { mock } from "bun:test";

const forbiddenDataDirText = process.env.SANA_TEST_FORBIDDEN_DATA_DIR;
if (!forbiddenDataDirText) {
  throw new Error("SANA_TEST_FORBIDDEN_DATA_DIR is required");
}
const forbiddenDataAliasTargetText =
  process.env.SANA_TEST_FORBIDDEN_DATA_ALIAS_TARGET;
if (!forbiddenDataAliasTargetText) {
  throw new Error("SANA_TEST_FORBIDDEN_DATA_ALIAS_TARGET is required");
}

const originalRealpathSync = fs.realpathSync.bind(fs);

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Resolve a path through existing symlink/junction ancestors. */
function canonicalPotentialPath(value: string): string {
  let candidate = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(originalRealpathSync(candidate), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error("contract tests cannot resolve a filesystem ancestor");
      }
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

// The repository data path is lexical on purpose: establishing this guard must
// never resolve or inspect the live directory it protects.
const forbiddenDataDir = comparablePath(path.resolve(forbiddenDataDirText));
const forbiddenDataAliasTarget = comparablePath(
  canonicalPotentialPath(forbiddenDataAliasTargetText),
);

function guardPath(value: unknown): void {
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else if (value instanceof URL && value.protocol === "file:") {
    text = fileURLToPath(value);
  } else if (value instanceof Uint8Array) {
    text = Buffer.from(value).toString();
  }
  if (text === undefined) return;

  const lexicalCandidate = comparablePath(path.resolve(text));
  if (isSameOrDescendant(lexicalCandidate, forbiddenDataDir)) {
    throw new Error("contract tests block repository live-data access");
  }

  const candidate = comparablePath(canonicalPotentialPath(text));
  if (isSameOrDescendant(candidate, forbiddenDataAliasTarget)) {
    throw new Error("contract tests block repository live-data access");
  }
}

function guardFsMethod(name: string, pathIndexes: readonly number[]): void {
  const module = fs as unknown as Record<
    string,
    ((...args: unknown[]) => unknown) | undefined
  >;
  const original = module[name];
  if (!original) return;
  module[name] = (...args) => {
    for (const index of pathIndexes) guardPath(args[index]);
    return original.apply(fs, args);
  };
}

// These are the path-bearing Node entry points used by the exercised runtime:
// secure JSON/storage, SQLite setup, daemon locks, and daemon logging.
for (const name of [
  "chmodSync",
  "lstatSync",
  "mkdirSync",
  "openSync",
  "readFileSync",
  "statSync",
  "unlinkSync",
]) {
  guardFsMethod(name, [0]);
}
guardFsMethod("renameSync", [0, 1]);

mock.module("node:fs", () => ({ ...fs, default: fs }));

class GuardedDatabase extends bunSqlite.Database {
  constructor(...args: ConstructorParameters<typeof bunSqlite.Database>) {
    guardPath(args[0]);
    super(...args);
  }
}
mock.module("bun:sqlite", () => ({
  ...bunSqlite,
  Database: GuardedDatabase,
}));

globalThis.fetch = (() => {
  throw new Error("contract tests block external network access");
}) as typeof globalThis.fetch;

const childProcessModule = childProcess as unknown as Record<string, unknown>;
childProcessModule.spawn = (): never => {
  throw new Error("contract tests block daemon process launch");
};
mock.module("node:child_process", () => ({
  ...childProcess,
  default: childProcess,
}));

syncBuiltinESMExports();

const fixedNowText = process.env.SANA_TEST_FIXED_NOW_MS;
if (fixedNowText !== undefined) {
  if (!/^\d+$/.test(fixedNowText)) {
    throw new Error("SANA_TEST_FIXED_NOW_MS must be an integer");
  }
  const fixedNow = Number(fixedNowText);
  if (!Number.isSafeInteger(fixedNow)) {
    throw new Error("SANA_TEST_FIXED_NOW_MS is out of range");
  }
  Date.now = () => fixedNow;
}
