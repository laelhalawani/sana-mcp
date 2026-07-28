import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { SemanticAssetError } from "./model-cache.js";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SemanticAssetError(
      `Embedded sqlite-vec directory is not an ordinary directory: ${directory}`,
    );
  }
}

function verifiedFile(file: string, expectedSha256: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SemanticAssetError(
        `Embedded sqlite-vec cache entry is not an ordinary file: ${file}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    return digest(readFileSync(descriptor)) === expectedSha256;
  } finally {
    closeSync(descriptor);
  }
}

export function extractEmbeddedVectorExtension(options: Readonly<{
  dataDirectory: string;
  assetName: string;
  bytes: Uint8Array;
  sha256: string;
}>): string {
  if (!path.isAbsolute(options.dataDirectory)) {
    throw new SemanticAssetError("sqlite-vec extraction requires an absolute data directory");
  }
  if (!/^vec0\.(?:so|dylib|dll)$/u.test(options.assetName)) {
    throw new SemanticAssetError("Embedded sqlite-vec asset name is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(options.sha256)) {
    throw new SemanticAssetError("Embedded sqlite-vec digest is invalid");
  }
  if (digest(options.bytes) !== options.sha256) {
    throw new SemanticAssetError("Embedded sqlite-vec bytes do not match the build digest");
  }

  ensureDirectory(options.dataDirectory);
  const nativeRoot = path.join(options.dataDirectory, "native");
  const extensionRoot = path.join(nativeRoot, "sqlite-vec");
  const digestRoot = path.join(extensionRoot, options.sha256);
  for (const directory of [nativeRoot, extensionRoot, digestRoot]) {
    ensureDirectory(directory);
  }
  const destination = path.join(digestRoot, options.assetName);
  if (verifiedFile(destination, options.sha256)) return destination;
  if (lstatExists(destination)) {
    throw new SemanticAssetError("Extracted sqlite-vec extension failed integrity verification");
  }

  const temporary = path.join(digestRoot, `.${options.assetName}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < options.bytes.byteLength) {
      offset += writeSync(
        descriptor,
        options.bytes,
        offset,
        options.bytes.byteLength - offset,
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    if (!verifiedFile(temporary, options.sha256)) {
      throw new SemanticAssetError("Staged sqlite-vec extension failed integrity verification");
    }
    chmodSync(temporary, 0o500);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (!verifiedFile(destination, options.sha256)) {
    throw new SemanticAssetError("Published sqlite-vec extension failed integrity verification");
  }
  return destination;
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function loadEmbeddedVectorExtension(
  db: Database,
  options: Parameters<typeof extractEmbeddedVectorExtension>[0],
): void {
  const extension = extractEmbeddedVectorExtension(options);
  if (process.platform !== "win32") {
    const descriptor = openSync(
      extension,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new SemanticAssetError(
          "sqlite-vec extension descriptor is not an ordinary file",
        );
      }
      if (digest(readFileSync(descriptor)) !== options.sha256) {
        throw new SemanticAssetError("sqlite-vec extension changed before loading");
      }
      const descriptorPath = `/proc/self/fd/${descriptor}`;
      const loadPath = path.join(
        path.dirname(extension),
        `.load-${randomUUID()}-${path.basename(extension)}`,
      );
      symlinkSync(descriptorPath, loadPath);
      try {
        db.loadExtension(loadPath, "sqlite3_vec_init");
        return;
      } finally {
        rmSync(loadPath, { force: true });
      }
    } finally {
      closeSync(descriptor);
    }
  }
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    CloseHandle: {
      args: [FFIType.i64],
      returns: FFIType.bool,
    },
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  });
  const encodedPath = Buffer.from(`${extension}\0`, "utf16le");
  const handle = kernel.symbols.CreateFileW(
    ptr(encodedPath),
    0x80000000,
    0x00000001,
    null,
    3,
    0x00000080,
    null,
  );
  if (handle === -1n) {
    const error = kernel.symbols.GetLastError();
    kernel.close();
    throw new SemanticAssetError(
      `Could not lock sqlite-vec against modification before loading (Windows error ${error})`,
    );
  }
  try {
    if (!verifiedFile(extension, options.sha256)) {
      throw new SemanticAssetError("sqlite-vec extension changed before loading");
    }
    db.loadExtension(extension);
  } finally {
    kernel.symbols.CloseHandle(handle);
    kernel.close();
  }
}
