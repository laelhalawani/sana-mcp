// Idempotent, non-destructive config writers. Each upsert only touches the
// named server entry, preserves every other key/server, and never clobbers a
// file it cannot parse.
import fs from "node:fs";
import path from "node:path";
import * as TOML from "@iarna/toml";
import { Document, parseDocument } from "yaml";
import type { ServerTarget } from "./server-target.js";

export type WriteResult = "ok" | "noop" | "skipped-unparseable";

function entryObject(entry: ServerTarget): Record<string, unknown> {
  const o: Record<string, unknown> = { command: entry.command, args: entry.args };
  if (entry.env && Object.keys(entry.env).length) o.env = entry.env;
  return o;
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
  const servers = (data[topKey] as Record<string, unknown> | undefined) ?? {};
  const obj = entryObject(entry);
  if (!fresh && JSON.stringify(servers[name] ?? null) === JSON.stringify(obj)) return "noop";
  if (dryRun) return "ok";
  data[topKey] = { ...servers, [name]: obj };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TOML.stringify(doc));
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
    fs.writeFileSync(file, TOML.stringify(doc as unknown as TOML.JsonMap));
  }
  return "ok";
}

// ---- YAML list (Continue ~/.continue/config.yaml -> mcpServers: [...]) ----

interface YamlMap {
  get: (k: string) => { items: unknown[] } | null;
  set: (k: string, v: unknown) => void;
  delete: (k: string) => void;
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
  let list = doc.contents.get("mcpServers");
  if (!list || !Array.isArray(list.items)) {
    doc.contents.set("mcpServers", doc.createNode([]));
    list = doc.contents.get("mcpServers");
  }
  if (!list) return "skipped-unparseable";
  const obj = continueEntry(name, entry);
  const idx = list.items.findIndex((it) => yEntry(it)?.name === name);
  if (idx >= 0 && JSON.stringify(yEntry(list.items[idx])) === JSON.stringify(obj)) return "noop";
  if (dryRun) return "ok";
  const node = doc.createNode(obj);
  if (idx >= 0) list.items[idx] = node;
  else list.items.push(node);
  if (fresh) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString());
  return "ok";
}

export function removeYamlServerList(file: string, name: string, dryRun = false): WriteResult {
  const { fresh, doc } = readYamlDoc(file);
  if (!doc || !doc.contents || fresh) return "noop";
  const list = doc.contents.get("mcpServers");
  if (!list || !Array.isArray(list.items)) return "noop";
  const before = list.items.length;
  list.items = list.items.filter((it) => yEntry(it)?.name !== name);
  if (list.items.length === before) return "noop";
  if (dryRun) return "ok";
  if (list.items.length === 0) doc.contents.delete("mcpServers");
  fs.writeFileSync(file, doc.toString());
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
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
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
  fs.writeFileSync(file, TOML.stringify(doc as unknown as TOML.JsonMap));
  return "ok";
}
