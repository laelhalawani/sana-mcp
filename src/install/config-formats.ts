import * as TOML from "@iarna/toml";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  visit,
  type ParseError,
} from "jsonc-parser";
import { isSeq, parseDocument } from "yaml";
import type { ServerTarget } from "./server-target.js";

export type FileConfigKind = "json" | "jsonc" | "toml" | "yaml-list";
export type EntryBuilder = (entry: ServerTarget) => Record<string, unknown>;
export type ConfigOperation = "register" | "remove";

export type FormatOwnership =
  | { state: "absent" }
  | { state: "owned" }
  | { state: "foreign"; reason: string };

export interface FormatChangeOptions {
  format: FileConfigKind;
  topKey?: string;
  name: string;
  target: ServerTarget;
  operation: ConfigOperation;
  build?: EntryBuilder;
  predecessors?: readonly EntryBuilder[];
}

export interface RenderedFormatChange {
  ownership: FormatOwnership;
  after?: string;
}

const UNSAFE_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
]);

function assertSafeObjectKey(value: string, label: string): void {
  if (
    !value ||
    value.includes("\0") ||
    UNSAFE_OBJECT_KEYS.has(value)
  )
    throw new Error(`${label} is invalid`);
}

/** The single server-name policy used by planning and every config format. */
export function validateServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name))
    throw new Error(
      "server name must be 1-64 ASCII letters, digits, dots, underscores, or hyphens"
    );
  if (UNSAFE_OBJECT_KEYS.has(name))
    throw new Error("server name conflicts with an object prototype property");
}

function assertValidTarget(target: ServerTarget): void {
  if (
    typeof target.command !== "string" ||
    target.command.length === 0 ||
    target.command.includes("\0")
  )
    throw new Error("server target command is invalid");
  if (
    !Array.isArray(target.args) ||
    target.args.some(
      (argument) => typeof argument !== "string" || argument.includes("\0")
    )
  )
    throw new Error("server target args are invalid");
  if (
    target.env !== undefined &&
    (target.env === null ||
      typeof target.env !== "object" ||
      Array.isArray(target.env) ||
      Object.entries(target.env).some(
        ([key, value]) =>
          !key ||
          key.includes("\0") ||
          typeof value !== "string" ||
          value.includes("\0")
      ))
  )
    throw new Error("server target environment is invalid");
}

export function standardConfigEntry(
  entry: ServerTarget
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    command: entry.command,
    args: [...entry.args],
  };
  if (entry.env && Object.keys(entry.env).length > 0)
    value.env = { ...entry.env };
  return value;
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date)
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    semanticEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => semanticEqual(leftObject[key], rightObject[key]))
  );
}

function ownedEntry(
  current: unknown,
  expected: Record<string, unknown>
): boolean {
  return (
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    semanticEqual(current, expected)
  );
}

/** Ownership requires equality of the complete entry, including unknown fields. */
export function isOwnedConfigEntry(
  current: unknown,
  target: ServerTarget,
  build: EntryBuilder = standardConfigEntry,
  predecessors: readonly EntryBuilder[] = [],
): boolean {
  assertValidTarget(target);
  return [build, ...predecessors].some((builder) =>
    ownedEntry(current, builder(target))
  );
}

function parseJsonObject(
  raw: string,
  comments: boolean
): Record<string, unknown> {
  if (!raw.trim()) return {};
  const objectKeys: Array<Set<string>> = [];
  let visitError: string | undefined;
  visit(
    raw,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        const keys = objectKeys[objectKeys.length - 1];
        if (!keys) {
          visitError = "JSON property appeared outside an object";
        } else if (keys.has(property)) {
          visitError = `duplicate JSON property ${JSON.stringify(property)}`;
        } else {
          keys.add(property);
        }
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
      onError: () => {
        visitError = "config contains JSON syntax errors";
      },
    },
    { allowTrailingComma: comments, disallowComments: !comments }
  );
  if (visitError) throw new Error(visitError);

  if (!comments) {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("config root must be an object");
    return value as Record<string, unknown>;
  }

  const errors: ParseError[] = [];
  const value = parseJsonc(raw, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0)
    throw new Error("config contains JSONC syntax errors");
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("config root must be an object");
  return value as Record<string, unknown>;
}

function newlineOf(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function preserveFinalNewline(original: string, output: string): string {
  const suffix = original.match(/(?:\r\n|\n)+$/u)?.[0] ?? "";
  return output.replace(/(?:\r?\n)+$/u, "") + suffix;
}

function jsonContainer(
  data: Record<string, unknown>,
  topKey: string
): Record<string, unknown> {
  const candidate = data[topKey];
  if (candidate === undefined) return {};
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  )
    throw new Error(`${topKey} must be an object`);
  return candidate as Record<string, unknown>;
}

function renderJsonChange(
  raw: string,
  topKey: string,
  name: string,
  value: Record<string, unknown> | undefined
): string {
  const source = raw.trim() ? raw : "{}";
  const eol = newlineOf(raw);
  const output = applyEdits(
    source,
    modify(source, [topKey, name], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    })
  );
  return raw ? preserveFinalNewline(raw, output) : `${output}${eol}`;
}

interface TomlHeaderSpan {
  start: number;
  lineEnd: number;
  array: boolean;
  path?: string[];
}

function markerPath(value: unknown, prefix: string[] = []): string[] | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = markerPath(child, prefix);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (object.__sana_header_marker === true) return prefix;
  for (const [key, child] of Object.entries(object)) {
    const found = markerPath(child, [...prefix, key]);
    if (found) return found;
  }
  return null;
}

function parseTomlHeaderPath(line: string): string[] | undefined {
  try {
    return (
      markerPath(
        TOML.parse(`${line}\n__sana_header_marker = true\n`) as Record<
          string,
          unknown
        >
      ) ?? undefined
    );
  } catch {
    return undefined;
  }
}

function scanTomlHeaders(raw: string): TomlHeaderSpan[] {
  const spans: TomlHeaderSpan[] = [];
  let lineStart = 0;
  while (lineStart < raw.length) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? raw.length : newline + 1;
    const line = raw.slice(lineStart, newline === -1 ? raw.length : newline);
    let cursor = 0;
    while (
      cursor < line.length &&
      (line[cursor] === " " || line[cursor] === "\t")
    )
      cursor++;
    if (line[cursor] === "[") {
      const array = line[cursor + 1] === "[";
      let quoted: "'" | '"' | undefined;
      let escaped = false;
      let closed = false;
      for (
        let index = cursor + (array ? 2 : 1);
        index < line.length;
        index++
      ) {
        const character = line[index]!;
        if (quoted === '"') {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = undefined;
          continue;
        }
        if (quoted === "'") {
          if (character === "'") quoted = undefined;
          continue;
        }
        if (character === '"' || character === "'") {
          quoted = character;
          continue;
        }
        if (character === "]" && (!array || line[index + 1] === "]")) {
          const remainder = line
            .slice(index + (array ? 2 : 1))
            .trimStart();
          if (remainder === "" || remainder.startsWith("#")) closed = true;
          break;
        }
      }
      if (closed)
        spans.push({
          start: lineStart,
          lineEnd,
          array,
          path: parseTomlHeaderPath(line),
        });
    }
    lineStart = lineEnd;
  }
  return spans;
}

function preservePrecedingComments(
  raw: string,
  blockStart: number,
  blockEnd: number
): number {
  const lines = [
    ...raw.slice(blockStart, blockEnd).matchAll(/.*(?:\r\n|\n|$)/gu),
  ].filter((match) => match[0] !== "");
  let preserveAt = blockEnd - blockStart;
  for (let index = lines.length - 1; index >= 0; index--) {
    const text = lines[index]![0].replace(/\r?\n$/u, "");
    if (text.trim() !== "" && !text.trimStart().startsWith("#")) break;
    preserveAt = lines[index]!.index!;
  }
  return blockStart + preserveAt;
}

function tomlTableRanges(
  raw: string,
  name: string
): Array<{ start: number; end: number }> | null {
  const headers = scanTomlHeaders(raw);
  const target = ["mcp_servers", name];
  const selected: Array<{ start: number; end: number }> = [];
  let baseFound = false;
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    if (!header.path) return null;
    const inTarget =
      header.path.length >= target.length &&
      target.every((part, partIndex) => header.path![partIndex] === part);
    if (!inTarget) continue;
    if (header.path.length === target.length && !header.array)
      baseFound = true;
    const nextStart = headers[index + 1]?.start ?? raw.length;
    selected.push({
      start: header.start,
      end: preservePrecedingComments(raw, header.lineEnd, nextStart),
    });
  }
  return baseFound && selected.length > 0 ? selected : null;
}

interface TomlInlineSpan {
  start: number;
  end: number;
}

/**
 * Locate a root inline-table assignment without treating a similarly named
 * key inside a later table as authoritative.
 */
function inlineMcpServersSpan(raw: string): TomlInlineSpan | undefined {
  let lineStart = 0;
  while (lineStart < raw.length) {
    const newline = raw.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? raw.length : newline + 1;
    const line = raw.slice(lineStart, newline === -1 ? raw.length : newline);
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[") && !trimmed.startsWith("[#")) return undefined;
    if (trimmed && !trimmed.startsWith("#")) {
      const key = /^(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=/u.exec(
        trimmed
      );
      if (key) {
        let cursor =
          lineStart + (line.length - trimmed.length) + key[0].length;
        while (cursor < raw.length && /[ \t]/u.test(raw[cursor]!)) cursor++;
        if (raw[cursor] !== "{") return undefined;
        const start = cursor;
        let curlyDepth = 0;
        let squareDepth = 0;
        let quote: TomlQuote | undefined;
        let escaped = false;
        for (; cursor < raw.length; cursor++) {
          const character = raw[cursor]!;
          if (quote) {
            if (quote === '"' || quote === '"""') {
              if (escaped) {
                escaped = false;
                continue;
              }
              if (character === "\\") {
                escaped = true;
                continue;
              }
            }
            if (raw.startsWith(quote, cursor)) {
              cursor += quote.length - 1;
              quote = undefined;
            }
            continue;
          }
          const opened = startingTomlQuote(raw, cursor);
          if (opened) {
            quote = opened;
            cursor += opened.length - 1;
            continue;
          }
          if (character === "#")
            throw new Error(
              "inline mcp_servers contains a comment before its closing brace"
            );
          if (character === "{") curlyDepth++;
          else if (character === "}") {
            curlyDepth--;
            if (curlyDepth === 0) return { start, end: cursor + 1 };
          } else if (character === "[") squareDepth++;
          else if (character === "]") squareDepth--;
          if (curlyDepth < 0 || squareDepth < 0)
            throw new Error("inline mcp_servers has unbalanced delimiters");
        }
        throw new Error("inline mcp_servers has no closing brace");
      }
    }
    lineStart = lineEnd;
  }
  return undefined;
}

function tomlInlineValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("inline mcp_servers contains a non-finite number");
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return `[${value.map((item) => tomlInlineValue(item)).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, child]) => `${JSON.stringify(key)} = ${tomlInlineValue(child)}`
    );
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error("inline mcp_servers contains an unsupported value");
}

interface TomlInlineMember {
  key: string;
  start: number;
  end: number;
  commaBefore?: number;
  commaAfter?: number;
}

type TomlQuote = "'" | '"' | "'''" | '"""';

function startingTomlQuote(raw: string, offset: number): TomlQuote | undefined {
  if (raw.startsWith('"""', offset)) return '"""';
  if (raw.startsWith("'''", offset)) return "'''";
  if (raw[offset] === '"') return '"';
  if (raw[offset] === "'") return "'";
  return undefined;
}

function directTomlKey(source: string): string | undefined {
  try {
    const parsed = TOML.parse(`${source} = 0`) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.length === 1 && parsed[keys[0]!] === 0
      ? keys[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function inlineMembers(raw: string, span: TomlInlineSpan): TomlInlineMember[] {
  const members: TomlInlineMember[] = [];
  let cursor = span.start + 1;
  let commaBefore: number | undefined;
  while (cursor < span.end - 1) {
    while (cursor < span.end - 1 && /\s/u.test(raw[cursor]!)) cursor++;
    if (cursor >= span.end - 1) break;
    const start = cursor;
    let quote: TomlQuote | undefined;
    let escaped = false;
    let equals = -1;
    for (; cursor < span.end - 1; cursor++) {
      const character = raw[cursor]!;
      if (quote) {
        if (quote === '"' || quote === '"""') {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (character === "\\") {
            escaped = true;
            continue;
          }
        }
        if (raw.startsWith(quote, cursor)) {
          cursor += quote.length - 1;
          quote = undefined;
        }
        continue;
      }
      const opened = startingTomlQuote(raw, cursor);
      if (opened) {
        quote = opened;
        cursor += opened.length - 1;
        continue;
      }
      if (character === "=") {
        equals = cursor;
        cursor++;
        break;
      }
      if (character === "," || character === "{" || character === "}")
        throw new Error("inline mcp_servers member key cannot be isolated");
      if (character === "#")
        throw new Error("inline mcp_servers member key ends in a comment");
    }
    if (equals < 0)
      throw new Error("inline mcp_servers member has no assignment");
    const key = directTomlKey(raw.slice(start, equals).trim());
    if (key === undefined)
      throw new Error("inline mcp_servers member key cannot be isolated");

    let curlyDepth = 0;
    let squareDepth = 0;
    quote = undefined;
    escaped = false;
    let end = -1;
    let commaAfter: number | undefined;
    for (; cursor < span.end; cursor++) {
      const character = raw[cursor]!;
      if (quote) {
        if (quote === '"' || quote === '"""') {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (character === "\\") {
            escaped = true;
            continue;
          }
        }
        if (raw.startsWith(quote, cursor)) {
          cursor += quote.length - 1;
          quote = undefined;
        }
        continue;
      }
      const opened = startingTomlQuote(raw, cursor);
      if (opened) {
        quote = opened;
        cursor += opened.length - 1;
        continue;
      }
      if (character === "#")
        throw new Error(
          "inline mcp_servers member value ends in a comment before isolation"
        );
      if (character === "{") curlyDepth++;
      else if (character === "}") {
        if (curlyDepth > 0) curlyDepth--;
        else if (squareDepth === 0) {
          end = cursor;
          while (end > equals + 1 && /\s/u.test(raw[end - 1]!)) end--;
          break;
        }
      } else if (character === "[") squareDepth++;
      else if (character === "]") squareDepth--;
      else if (
        character === "," &&
        curlyDepth === 0 &&
        squareDepth === 0
      ) {
        end = cursor;
        while (end > equals + 1 && /\s/u.test(raw[end - 1]!)) end--;
        commaAfter = cursor;
        cursor++;
        break;
      }
      if (curlyDepth < 0 || squareDepth < 0)
        throw new Error("inline mcp_servers member has unbalanced delimiters");
    }
    if (end < 0 || quote || curlyDepth !== 0 || squareDepth !== 0)
      throw new Error("inline mcp_servers member value cannot be isolated");
    members.push({ key, start, end, commaBefore, commaAfter });
    commaBefore = commaAfter;
  }
  return members;
}

function editInlineMcpServers(
  raw: string,
  span: TomlInlineSpan,
  name: string,
  expected: Record<string, unknown>,
  operation: ConfigOperation,
  servers: Record<string, unknown>
): string {
  const members = inlineMembers(raw, span);
  const target = members.find((member) => member.key === name);
  let after: string;
  if (operation === "remove") {
    if (!target)
      throw new Error(
        "owned inline mcp_servers member could not be isolated in source text"
      );
    if (target.commaBefore !== undefined) {
      after =
        raw.slice(0, target.commaBefore) +
        raw.slice(target.end);
    } else if (target.commaAfter !== undefined) {
      after =
        raw.slice(0, target.start) +
        raw.slice(target.commaAfter + 1);
    } else {
      after = raw.slice(0, target.start) + raw.slice(target.end);
    }
  } else {
    if (target)
      throw new Error(
        "absent inline mcp_servers member unexpectedly exists in source text"
      );
    const member = `${JSON.stringify(name)} = ${tomlInlineValue(expected)}`;
    const insertion = members.length === 0 ? member : `, ${member}`;
    const insertionAt =
      members.length === 0
        ? span.start + 1
        : members[members.length - 1]!.end;
    after =
      raw.slice(0, insertionAt) +
      insertion +
      raw.slice(insertionAt);
  }
  const verified = TOML.parse(after) as Record<string, unknown>;
  const updated = { ...servers };
  if (operation === "register") updated[name] = expected;
  else delete updated[name];
  if (!semanticEqual(verified.mcp_servers, updated))
    throw new Error(
      "edited inline mcp_servers failed semantic round-trip validation"
    );
  return after;
}

function tomlBlock(
  name: string,
  entry: Record<string, unknown>,
  eol: string
): string {
  const target = entry as {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  if (!Array.isArray(target.args))
    throw new Error("TOML server entry args must be an array");
  const lines = [
    `[mcp_servers.${JSON.stringify(name)}]`,
    `command = ${JSON.stringify(target.command)}`,
    `args = [${target.args
      .map((item) => JSON.stringify(item))
      .join(", ")}]`,
  ];
  if (target.env && Object.keys(target.env).length > 0) {
    const values = Object.entries(target.env).map(
      ([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`
    );
    lines.push(`env = { ${values.join(", ")} }`);
  }
  return lines.join(eol) + eol;
}

interface YamlMapLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

function yamlValue(node: unknown): unknown {
  return node &&
    typeof node === "object" &&
    typeof (node as { toJSON?: () => unknown }).toJSON === "function"
    ? (node as { toJSON: () => unknown }).toJSON()
    : node;
}

function yamlEntry(node: unknown): Record<string, unknown> | null {
  const value = yamlValue(node);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function continueEntry(
  name: string,
  entry: ServerTarget
): Record<string, unknown> {
  return {
    name,
    type: "stdio",
    command: entry.command,
    args: [...entry.args],
    env: entry.env ? { ...entry.env } : {},
  };
}

export function inspectAndRenderConfig(
  options: FormatChangeOptions,
  raw: string
): RenderedFormatChange {
  validateServerName(options.name);
  if (options.topKey)
    assertSafeObjectKey(options.topKey, "config container name");
  assertValidTarget(options.target);
  const expected = (options.build ?? standardConfigEntry)(options.target);
  const ownedExpected = [
    expected,
    ...(options.predecessors ?? []).map((builder) => builder(options.target)),
  ];
  const isOwned = (current: unknown): boolean =>
    ownedExpected.some((candidate) => ownedEntry(current, candidate));

  if (options.format === "json" || options.format === "jsonc") {
    if (!options.topKey)
      throw new Error(`${options.format} config requires topKey`);
    const data = parseJsonObject(raw, options.format === "jsonc");
    const container = jsonContainer(data, options.topKey);
    const current = Object.prototype.hasOwnProperty.call(
      container,
      options.name
    )
      ? container[options.name]
      : undefined;
    const ownership: FormatOwnership =
      current === undefined
        ? { state: "absent" }
        : isOwned(current)
          ? { state: "owned" }
          : {
              state: "foreign",
              reason:
                "same-name entry does not match the managed target",
            };
    if (
      (options.operation === "register" && ownership.state === "owned") ||
      (options.operation === "remove" && ownership.state === "absent") ||
      ownership.state === "foreign"
    )
      return { ownership };
    return {
      ownership,
      after: renderJsonChange(
        raw,
        options.topKey,
        options.name,
        options.operation === "register" ? expected : undefined
      ),
    };
  }

  if (options.format === "toml") {
    const data = raw.trim()
      ? (TOML.parse(raw) as Record<string, unknown>)
      : {};
    const serversValue = data.mcp_servers;
    if (
      serversValue !== undefined &&
      (serversValue === null ||
        typeof serversValue !== "object" ||
        Array.isArray(serversValue))
    )
      throw new Error("mcp_servers must be a table");
    const servers =
      (serversValue as Record<string, unknown> | undefined) ?? {};
    const current = Object.prototype.hasOwnProperty.call(
      servers,
      options.name
    )
      ? servers[options.name]
      : undefined;
    const ownership: FormatOwnership =
      current === undefined
        ? { state: "absent" }
        : isOwned(current)
          ? { state: "owned" }
          : {
              state: "foreign",
              reason:
                "same-name table does not match the managed target",
            };
    if (
      (options.operation === "register" && ownership.state === "owned") ||
      (options.operation === "remove" && ownership.state === "absent") ||
      ownership.state === "foreign"
    )
      return { ownership };

    const eol = newlineOf(raw);
    const inlineSpan = inlineMcpServersSpan(raw);
    if (inlineSpan) {
      return {
        ownership,
        after: editInlineMcpServers(
          raw,
          inlineSpan,
          options.name,
          expected,
          options.operation,
          servers
        ),
      };
    }
    if (options.operation === "register") {
      const separator =
        raw.length > 0 && !/(?:\r?\n)$/u.test(raw)
          ? eol + eol
          : raw
            ? eol
            : "";
      const after = raw + separator + tomlBlock(options.name, expected, eol);
      const verified = TOML.parse(after) as Record<string, unknown>;
      const verifiedServers = verified.mcp_servers as
        | Record<string, unknown>
        | undefined;
      if (
        !verifiedServers ||
        !Object.prototype.hasOwnProperty.call(
          verifiedServers,
          options.name
        ) ||
        !ownedEntry(verifiedServers[options.name], expected)
      )
        throw new Error(
          "rendered TOML target failed semantic round-trip validation"
        );
      return { ownership, after };
    }

    const ranges = tomlTableRanges(raw, options.name);
    if (!ranges)
      throw new Error(
        "parsed managed TOML table could not be located safely in source text"
      );
    let after = raw;
    for (const range of [...ranges].sort(
      (left, right) => right.start - left.start
    ))
      after = after.slice(0, range.start) + after.slice(range.end);
    after = preserveFinalNewline(raw, after);
    const verified = TOML.parse(after) as Record<string, unknown>;
    const verifiedServers = verified.mcp_servers as
      | Record<string, unknown>
      | undefined;
    if (
      verifiedServers &&
      Object.prototype.hasOwnProperty.call(verifiedServers, options.name)
    )
      throw new Error(
        "rendered TOML removal failed semantic postcondition"
      );
    return { ownership, after };
  }

  const document = parseDocument(raw || "{}");
  if (document.errors.length > 0)
    throw new Error(`YAML config is invalid: ${document.errors[0]!.message}`);
  if (!document.contents)
    document.contents = document.createNode(
      {}
    ) as unknown as typeof document.contents;
  if (typeof (document.contents as { get?: unknown }).get !== "function")
    throw new Error("YAML config root must be a map");
  const root = document.contents as unknown as YamlMapLike;
  const currentList = root.get("mcpServers");
  if (
    currentList !== undefined &&
    currentList !== null &&
    !isSeq(currentList)
  )
    throw new Error("mcpServers must be a sequence");
  const items = isSeq(currentList) ? currentList.items : [];
  const matching = items.filter(
    (item) => yamlEntry(item)?.name === options.name
  );
  const ownership: FormatOwnership =
    matching.length === 0
      ? { state: "absent" }
      : matching.length === 1 &&
          semanticEqual(
            yamlEntry(matching[0]),
            continueEntry(options.name, options.target)
          )
        ? { state: "owned" }
        : {
            state: "foreign",
            reason:
              matching.length > 1
                ? "multiple same-name entries prevent ownership proof"
                : "same-name entry does not match the managed target",
          };
  if (
    (options.operation === "register" && ownership.state === "owned") ||
    (options.operation === "remove" && ownership.state === "absent") ||
    ownership.state === "foreign"
  )
    return { ownership };

  if (!isSeq(currentList))
    root.set("mcpServers", document.createNode([]));
  const sequence = root.get("mcpServers");
  if (!isSeq(sequence))
    throw new Error("could not create mcpServers sequence");
  if (options.operation === "register") {
    sequence.items.push(
      document.createNode(continueEntry(options.name, options.target))
    );
  } else {
    sequence.items = sequence.items.filter(
      (item) => yamlEntry(item)?.name !== options.name
    );
    if (sequence.items.length === 0) root.delete("mcpServers");
  }
  const eol = newlineOf(raw);
  const rendered = document.toString().replace(/\n/gu, eol);
  return {
    ownership,
    after: raw ? preserveFinalNewline(raw, rendered) : rendered,
  };
}
