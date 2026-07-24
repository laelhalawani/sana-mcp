// Idempotent, non-destructive config writers. Each upsert only touches the
// named server entry, preserves every other key/server, and never clobbers a
// file it cannot parse.
import fs from "node:fs";
import path from "node:path";
import * as TOML from "@iarna/toml";
import { Document, parseDocument, isSeq } from "yaml";
import { parse as parseJsonc, modify, applyEdits, type ParseError } from "jsonc-parser";
import type { ServerTarget } from "./server-target.js";

export type WriteResult = "ok" | "noop" | "skipped-unparseable";

/** Builds the per-server config value written under topKey[name]. */
export type EntryBuilder = (entry: ServerTarget) => Record<string, unknown>;

function entryObject(entry: ServerTarget): Record<string, unknown> {
  const o: Record<string, unknown> = { command: entry.command, args: entry.args };
  if (entry.env && Object.keys(entry.env).length) o.env = entry.env;
  return o;
}

/**
 * Write `content` to `file` atomically: write a sibling temp file, then rename
 * over the target. A crash mid-write leaves the original intact instead of a
 * truncated config. `mkdirSync` first so a fresh file's parent dir exists.
 */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sana-mcp.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can't always rename over an existing file. Fall back to replace,
    // but first stash the original so a failed second rename can't lose it.
    if ((e as NodeJS.ErrnoException).code === "EEXIST" || (e as NodeJS.ErrnoException).code === "EPERM") {
      const bak = `${file}.sana-mcp.${process.pid}.bak`;
      let stashed = false;
      try {
        fs.renameSync(file, bak); // move original aside (no data lost yet)
        stashed = true;
      } catch {
        /* original may not exist / not movable; proceed */
      }
      try {
        fs.renameSync(tmp, file);
        if (stashed) fs.rmSync(bak, { force: true }); // success: drop the backup
      } catch (e2) {
        // Restore the original so the config is never left missing.
        if (stashed) {
          try {
            fs.rmSync(file, { force: true });
            fs.renameSync(bak, file);
          } catch {
            /* best effort restore */
          }
        }
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
        throw e2;
      }
    } else {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore cleanup failure */
      }
      throw e;
    }
  }
}

// ---- JSON (mcpServers / context_servers / ...) --------------------------

interface JsonRead {
  fresh: boolean; // file did not exist (safe to create)
  data: Record<string, unknown> | null; // null = present but unparseable
}

function readJsonTolerant(file: string): JsonRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { fresh: true, data: {} };
    throw e;
  }
  try {
    return { fresh: false, data: raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {} };
  } catch {
    return { fresh: false, data: null };
  }
}

export function upsertJsonServer(
  file: string,
  topKey: string,
  name: string,
  entry: ServerTarget,
  dryRun = false
): WriteResult {
  const { fresh, data } = readJsonTolerant(file);
  if (data === null) return "skipped-unparseable";
  if (data[topKey] != null && (typeof data[topKey] !== "object" || Array.isArray(data[topKey])))
    return "skipped-unparseable";
  const servers = (data[topKey] as Record<string, unknown> | undefined) ?? {};
  const obj = entryObject(entry);
  const cur: Record<string, unknown> | null = (servers[name] as Record<string, unknown> | undefined) ?? null;
  const managed = (o: Record<string, unknown>): string =>
    JSON.stringify({ command: o.command, args: o.args, env: o.env });
  if (!fresh && cur != null && managed(cur) === managed(obj)) return "noop";
  if (dryRun) return "ok";
  servers[name] = { ...cur, ...obj };
  data[topKey] = servers;
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
  return "ok";
}

// ---- TOML (Codex ~/.codex/config.toml -> [mcp_servers.<id>]) -------------

// TOML basic strings share JSON's escaping for the cases we care about
// (notably Windows backslash paths), so JSON.stringify is a safe serialiser.
const tomlStr = (s: string): string => JSON.stringify(s);

function renderTomlBlock(name: string, entry: ServerTarget): string {
  const lines: string[] = ["", `[mcp_servers.${name}]`, `command = ${tomlStr(entry.command)}`];
  if (entry.args.length) lines.push(`args = [${entry.args.map(tomlStr).join(", ")}]`);
  if (entry.env && Object.keys(entry.env).length) {
    const items = Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlStr(v)}`);
    lines.push(`env = { ${items.join(", ")} }`);
  }
  lines.push("");
  return lines.join("\n");
}

export function upsertTomlServer(
  file: string,
  name: string,
  entry: ServerTarget,
  dryRun = false
): WriteResult {
  const obj = entryObject(entry);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return "skipped-unparseable";
  }

  // No existing file: write a fresh, minimal one.
  if (raw === null) {
    if (dryRun) return "ok";
    const doc = { mcp_servers: { [name]: obj } } as unknown as TOML.JsonMap;
    atomicWrite(file, TOML.stringify(doc));
    return "ok";
  }

  // Existing file: parse to see whether our entry is already there.
  let doc: Record<string, unknown>;
  try {
    doc = raw.trim() ? (TOML.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return "skipped-unparseable";
  }
  const servers = (doc.mcp_servers as Record<string, unknown> | undefined) ?? {};
  if (JSON.stringify(servers[name] ?? null) === JSON.stringify(obj)) return "noop";

  if (dryRun) return "ok";

  if (servers[name] === undefined) {
    // Absent: APPEND a table at EOF so we keep the user's comments/formatting.
    fs.appendFileSync(file, renderTomlBlock(name, entry));
  } else {
    // Present but different: full rewrite (loses comments; rare).
    doc.mcp_servers = { ...servers, [name]: obj };
    atomicWrite(file, TOML.stringify(doc as unknown as TOML.JsonMap));
  }
  return "ok";
}

// ---- YAML list (Continue ~/.continue/config.yaml -> mcpServers: [...]) ----

interface YamlSeq {
  items: unknown[];
}
interface YamlMap {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
  delete: (k: string) => void;
}
/** A YAML node is our mcpServers list only if it's a real sequence (not a map,
 * whose `.items` are Pairs). */
function asSeq(node: unknown): YamlSeq | null {
  return isSeq(node) ? (node as unknown as YamlSeq) : null;
}
interface YamlDoc {
  contents: YamlMap | null;
  createNode: (v: unknown) => unknown;
  toString: () => string;
}

function readYamlDoc(file: string): { fresh: boolean; doc: YamlDoc | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { fresh: true, doc: new Document({}) as unknown as YamlDoc };
    return { fresh: false, doc: null };
  }
  const doc = parseDocument(raw);
  return { fresh: false, doc: doc.errors.length ? null : (doc as unknown as YamlDoc) };
}

function continueEntry(name: string, entry: ServerTarget): Record<string, unknown> {
  return {
    name,
    type: "stdio",
    command: entry.command,
    args: entry.args,
    env: entry.env ?? {},
  };
}

// Normalize a parsed Continue list item to a plain object for comparison.
function yEntry(node: unknown): Record<string, unknown> | null {
  const n = node as { get?: (k: string) => unknown } | null;
  if (!n?.get) return null;
  const g = (k: string) => {
    const v = n.get!(k);
    return v && typeof (v as { toJSON?: () => unknown }).toJSON === "function"
      ? (v as { toJSON: () => unknown }).toJSON()
      : v;
  };
  return { name: g("name"), type: g("type"), command: g("command"), args: g("args"), env: g("env") };
}

export function upsertYamlServerList(
  file: string,
  name: string,
  entry: ServerTarget,
  dryRun = false
): WriteResult {
  const { fresh, doc } = readYamlDoc(file);
  if (!doc || !doc.contents) return "skipped-unparseable";
  const existing = doc.contents.get("mcpServers");
  // If mcpServers exists but is not a sequence (e.g. a map), don't corrupt it.
  if (existing != null && !isSeq(existing)) return "skipped-unparseable";
  let list = asSeq(existing);
  if (!list) {
    doc.contents.set("mcpServers", doc.createNode([]));
    list = asSeq(doc.contents.get("mcpServers"));
  }
  if (!list) return "skipped-unparseable";
  const obj = continueEntry(name, entry);
  const idx = list.items.findIndex((it) => yEntry(it)?.name === name);
  if (idx >= 0 && JSON.stringify(yEntry(list.items[idx])) === JSON.stringify(obj)) return "noop";
  if (dryRun) return "ok";
  const node = doc.createNode(obj);
  if (idx >= 0) list.items[idx] = node;
  else list.items.push(node);
  atomicWrite(file, doc.toString());
  return "ok";
}

export function removeYamlServerList(file: string, name: string, dryRun = false): WriteResult {
  const { fresh, doc } = readYamlDoc(file);
  if (!doc || !doc.contents || fresh) return "noop";
  const list = asSeq(doc.contents.get("mcpServers"));
  if (!list) return "noop";
  const before = list.items.length;
  list.items = list.items.filter((it) => yEntry(it)?.name !== name);
  if (list.items.length === before) return "noop";
  if (dryRun) return "ok";
  if (list.items.length === 0) doc.contents.delete("mcpServers");
  atomicWrite(file, doc.toString());
  return "ok";
}

// ---- removal for JSON / TOML --------------------------------------------

export function removeJsonServer(
  file: string,
  topKey: string,
  name: string,
  dryRun = false
): WriteResult {
  const { fresh, data } = readJsonTolerant(file);
  if (data === null) return "skipped-unparseable";
  if (fresh) return "noop";
  const servers = (data[topKey] as Record<string, unknown> | undefined) ?? {};
  if (!(name in servers)) return "noop";
  if (dryRun) return "ok";
  delete servers[name];
  if (Object.keys(servers).length) data[topKey] = servers;
  else delete data[topKey];
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
  return "ok";
}

export function removeTomlServer(file: string, name: string, dryRun = false): WriteResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "noop";
    return "skipped-unparseable";
  }
  let doc: Record<string, unknown>;
  try {
    doc = raw.trim() ? (TOML.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return "skipped-unparseable";
  }
  const servers = (doc.mcp_servers as Record<string, unknown> | undefined) ?? {};
  if (!(name in servers)) return "noop";
  if (dryRun) return "ok";
  delete servers[name];
  if (Object.keys(servers).length) doc.mcp_servers = servers;
  else delete doc.mcp_servers;
  atomicWrite(file, TOML.stringify(doc as unknown as TOML.JsonMap));
  return "ok";
}

// ---- JSONC (comment-tolerant: opencode `mcp`, VS Code `servers`) ---------
// Uses jsonc-parser's edit API so existing comments and formatting survive.
// `topKey` is the servers container (e.g. "mcp" | "servers"); `build` shapes
// the per-server value (opencode uses type:"local" + array command; VS Code
// uses type:"stdio" + command/args).

const managedKeys = (o: Record<string, unknown>): string =>
  JSON.stringify({
    type: o.type ?? null,
    command: o.command ?? null,
    args: o.args ?? null,
    env: o.env ?? o.environment ?? null,
  });

function readJsoncTolerant(file: string): { fresh: boolean; text: string | null } {
  try {
    return { fresh: false, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { fresh: true, text: "{}" };
    return { fresh: false, text: null };
  }
}

/** Parse JSONC leniently; returns null if it has hard syntax errors. */
function parseJsoncSafe(text: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length) return null;
  if (data == null) return {};
  if (typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

export function upsertJsoncServer(
  file: string,
  topKey: string,
  name: string,
  entry: ServerTarget,
  build: EntryBuilder,
  dryRun = false
): WriteResult {
  const { fresh, text } = readJsoncTolerant(file);
  if (text === null) return "skipped-unparseable";
  const data = parseJsoncSafe(text);
  if (data === null) return "skipped-unparseable";
  const container = data[topKey];
  if (container != null && (typeof container !== "object" || Array.isArray(container)))
    return "skipped-unparseable";
  const servers = (container as Record<string, unknown> | undefined) ?? {};
  const obj = build(entry);
  const cur = (servers[name] as Record<string, unknown> | undefined) ?? null;
  if (!fresh && cur != null && managedKeys({ ...cur }) === managedKeys(obj)) return "noop";
  if (dryRun) return "ok";
  // Merge managed fields onto any existing entry (preserve user-added keys).
  const merged = { ...(cur ?? {}), ...obj };
  const edits = modify(text, [topKey, name], merged, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const out = applyEdits(text, edits);
  atomicWrite(file, out.endsWith("\n") ? out : out + "\n");
  return "ok";
}

export function removeJsoncServer(
  file: string,
  topKey: string,
  name: string,
  dryRun = false
): WriteResult {
  const { fresh, text } = readJsoncTolerant(file);
  if (fresh) return "noop";
  if (text === null) return "skipped-unparseable";
  const data = parseJsoncSafe(text);
  if (data === null) return "skipped-unparseable";
  const servers = (data[topKey] as Record<string, unknown> | undefined) ?? {};
  if (!(name in servers)) return "noop";
  if (dryRun) return "ok";
  const edits = modify(text, [topKey, name], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  atomicWrite(file, applyEdits(text, edits));
  return "ok";
}

// ---- read-only status checks (is our server registered?) -----------------

/** Whether `topKey[name]` exists in a plain-JSON config. */
export function hasJsonServer(file: string, topKey: string, name: string): boolean {
  try {
    const { data } = readJsonTolerant(file);
    if (!data) return false;
    const servers = data[topKey];
    return !!servers && typeof servers === "object" && !Array.isArray(servers) && name in servers;
  } catch {
    return false;
  }
}

/** Whether `topKey[name]` exists in a JSONC config (opencode / VS Code). */
export function hasJsoncServer(file: string, topKey: string, name: string): boolean {
  const { text } = readJsoncTolerant(file);
  if (text == null) return false;
  const data = parseJsoncSafe(text);
  if (!data) return false;
  const servers = data[topKey];
  return !!servers && typeof servers === "object" && !Array.isArray(servers) && name in servers;
}

/** Whether `[mcp_servers.name]` exists in a Codex TOML config. */
export function hasTomlServer(file: string, name: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let doc: Record<string, unknown>;
  try {
    doc = raw.trim() ? (TOML.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return false;
  }
  const servers = doc.mcp_servers as Record<string, unknown> | undefined;
  return !!servers && name in servers;
}

/** Whether a Continue YAML mcpServers list contains an item named `name`. */
export function hasYamlServer(file: string, name: string): boolean {
  const { doc } = readYamlDoc(file);
  if (!doc || !doc.contents) return false;
  const list = asSeq(doc.contents.get("mcpServers"));
  if (!list) return false;
  return list.items.some((it) => yEntry(it)?.name === name);
}
