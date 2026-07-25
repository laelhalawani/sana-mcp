import fs from "node:fs";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import type { z } from "zod";
import {
  SecurePathManualActionError,
  openSensitiveFile,
  repairSensitiveFilePermissions,
  writePrivateFileAtomic,
  type SecureFileOptions,
} from "./secure-files.js";

const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;

export class CorruptJsonFileError extends Error {
  readonly code = "CORRUPT_JSON_PRESERVED";

  constructor(
    readonly sourcePath: string,
    readonly quarantinePath: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid JSON at ${sourcePath} was retained and copied to ${quarantinePath} for manual recovery`,
      options,
    );
    this.name = "CorruptJsonFileError";
  }
}

export class CorruptJsonPreservationError extends Error {
  readonly code = "CORRUPT_JSON_PRESERVATION_FAILED";

  constructor(
    readonly sourcePath: string,
    readonly recoveryPath: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid JSON at ${sourcePath} was retained, but its bounded recovery copy could not be verified at ${recoveryPath}`,
      options,
    );
    this.name = "CorruptJsonPreservationError";
  }
}

export class JsonFileTooLargeError extends Error {
  readonly code = "JSON_FILE_TOO_LARGE";

  constructor(readonly target: string, readonly maximumBytes: number) {
    super(`JSON file exceeds the ${maximumBytes}-byte safety limit`);
    this.name = "JsonFileTooLargeError";
  }
}

export class InvalidJsonValueError extends TypeError {
  readonly code = "INVALID_JSON_VALUE";

  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonValueError";
  }
}

export interface ReadJsonOptions extends SecureFileOptions {
  readonly maximumBytes?: number;
}

export type ReadJsonResult<T> =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "value"; value: T }>;

function errno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function strictJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (current: unknown, location: string): void => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new InvalidJsonValueError(`${location} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new InvalidJsonValueError(
        `${location} contains unsupported ${typeof current} data`,
      );
    }
    if (ancestors.has(current)) {
      throw new InvalidJsonValueError(`${location} contains a cycle`);
    }
    ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key === "symbol")) {
        throw new InvalidJsonValueError(
          `${location} contains a symbol-keyed property`,
        );
      }
      if (Array.isArray(current)) {
        const allowed = new Set([
          "length",
          ...Array.from({ length: current.length }, (_, index) => String(index)),
        ]);
        if (keys.some((key) => !allowed.has(key as string))) {
          throw new InvalidJsonValueError(
            `${location} contains an unsupported array property`,
          );
        }
        for (let index = 0; index < current.length; index++) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new InvalidJsonValueError(
              `${location}[${index}] is sparse or accessor-backed`,
            );
          }
          visit(descriptor.value, `${location}[${index}]`);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidJsonValueError(
          `${location} contains an unsupported object type`,
        );
      }
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new InvalidJsonValueError(
            `${location}.${key} is non-enumerable or accessor-backed`,
          );
        }
        visit(descriptor.value, `${location}.${key}`);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, "$");
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new InvalidJsonValueError("The root value is not JSON data");
  }
  return `${serialized}\n`;
}

export function writeJsonAtomic(
  file: string,
  value: unknown,
  options: SecureFileOptions = {},
): void {
  // Validation precedes every filesystem mutation.
  const serialized = strictJson(value);
  writePrivateFileAtomic(file, serialized, options);
}

function readBounded(
  file: string,
  maximumBytes: number,
  options: SecureFileOptions,
): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSensitiveFile(file, "r", options);
  } catch (error) {
    if (errno(error, "ENOENT")) return undefined;
    throw error;
  }

  let bytes: Buffer | undefined;
  let operationError: unknown;
  try {
    const stats = fs.fstatSync(descriptor);
    if (stats.size > maximumBytes) {
      throw new JsonFileTooLargeError(file, maximumBytes);
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = fs.readSync(
        descriptor,
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (count === 0) break;
      total += count;
    }
    if (total > maximumBytes) {
      throw new JsonFileTooLargeError(file, maximumBytes);
    }
    bytes = buffer.subarray(0, total);
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      `Bounded JSON read and descriptor cleanup failed for ${file}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return bytes!;
}

function preserveCorrupt(
  source: string,
  bytes: Buffer,
  options: SecureFileOptions,
): string {
  const recovery = `${source}.corrupt`;
  try {
    let descriptor: number | undefined;
    try {
      descriptor = openSensitiveFile(recovery, "wx", options);
    } catch (error) {
      if (!errno(error, "EEXIST")) throw error;
      repairSensitiveFilePermissions(recovery, options);
      const existing = readBounded(recovery, bytes.byteLength + 1, options);
      if (!existing || !existing.equals(bytes)) {
        throw new SecurePathManualActionError(
          recovery,
          "The bounded corrupt-JSON recovery path already contains different data. Preserve both files manually.",
          { cause: error },
        );
      }
      return recovery;
    }
    let operationError: unknown;
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } catch (error) {
      operationError = error;
    }
    let closeError: unknown;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        `Corrupt-JSON recovery write and cleanup failed for ${source}`,
      );
    }
    if (operationError !== undefined) throw operationError;
    if (closeError !== undefined) throw closeError;
    repairSensitiveFilePermissions(recovery, options);
    return recovery;
  } catch (error) {
    throw new CorruptJsonPreservationError(source, recovery, { cause: error });
  }
}

export function readJsonFile<T>(
  file: string,
  schema: z.ZodType<T>,
  options: ReadJsonOptions = {},
): ReadJsonResult<T> {
  const absolute = path.resolve(file);
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes >= bufferConstants.MAX_LENGTH ||
    maximumBytes > DEFAULT_MAX_JSON_BYTES
  ) {
    throw new TypeError(
      `maximumBytes must be an integer from 1 through ${DEFAULT_MAX_JSON_BYTES}`,
    );
  }
  const bytes = readBounded(absolute, maximumBytes, options);
  if (bytes === undefined) return { kind: "missing" };

  let reason: string;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    const validated = schema.safeParse(parsed);
    if (validated.success) return { kind: "value", value: validated.data };
    reason = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }

  const recovery = preserveCorrupt(absolute, bytes, options);
  throw new CorruptJsonFileError(absolute, recovery, reason);
}
