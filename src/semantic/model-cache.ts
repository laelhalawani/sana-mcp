import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const PINNED_MODEL_ID = "Xenova/all-MiniLM-L6-v2" as const;
export const PINNED_MODEL_REVISION =
  "751bff37182d3f1213fa05d7196b954e230abad9" as const;

export interface PinnedModelFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export const PINNED_MODEL_FILES = Object.freeze([
  Object.freeze({
    path: "config.json",
    size: 650,
    sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  }),
  Object.freeze({
    path: "tokenizer.json",
    size: 711_661,
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  }),
  Object.freeze({
    path: "tokenizer_config.json",
    size: 366,
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  }),
  Object.freeze({
    path: "onnx/model_quantized.onnx",
    size: 22_972_370,
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  }),
] as const satisfies readonly PinnedModelFile[]);

const MODEL_ORIGIN = "https://huggingface.co";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STALE_SNAPSHOT_MS = 24 * 60 * 60_000;

export class SemanticAssetError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SemanticAssetError";
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactBytes(bytes: Uint8Array, file: PinnedModelFile): void {
  if (bytes.byteLength !== file.size) {
    throw new SemanticAssetError(
      `Pinned semantic model file ${file.path} has size ${bytes.byteLength}; expected ${file.size}`,
    );
  }
  const digest = sha256(bytes);
  if (digest !== file.sha256) {
    throw new SemanticAssetError(
      `Pinned semantic model file ${file.path} has SHA-256 ${digest}; expected ${file.sha256}`,
    );
  }
}

function assertSafeRelativeFile(file: PinnedModelFile): readonly string[] {
  const segments = file.path.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    throw new SemanticAssetError(`Semantic model file path is unsafe: ${file.path}`);
  }
  return segments;
}

function assertSafeDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SemanticAssetError(
      `Semantic asset directory is not an application-owned ordinary directory: ${directory}`,
    );
  }
}

function ensureSafeDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(directory);
}

function readOrdinaryFile(file: string): Uint8Array | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SemanticAssetError(
      `Semantic asset cache entry is not an ordinary file: ${file}`,
    );
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(file, constants.O_RDONLY | noFollow);
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishVerifiedFile(
  destination: string,
  bytes: Uint8Array,
  file: PinnedModelFile,
): void {
  assertExactBytes(bytes, file);
  const directory = path.dirname(destination);
  ensureSafeDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    const staged = readOrdinaryFile(temporary);
    if (staged === null) {
      throw new SemanticAssetError(`Staged semantic model file disappeared: ${file.path}`);
    }
    assertExactBytes(staged, file);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  const installed = readOrdinaryFile(destination);
  if (installed === null) {
    throw new SemanticAssetError(`Published semantic model file disappeared: ${file.path}`);
  }
  assertExactBytes(installed, file);
}

export function pinnedModelUrl(file: PinnedModelFile): URL {
  const url = new URL(
    `/${PINNED_MODEL_ID}/resolve/${PINNED_MODEL_REVISION}/${file.path}`,
    MODEL_ORIGIN,
  );
  if (
    url.origin !== MODEL_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new SemanticAssetError(`Pinned semantic model path is invalid: ${file.path}`);
  }
  return url;
}

export interface ModelDownloadOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
}

export async function downloadPinnedModelFile(
  file: PinnedModelFile,
  options: ModelDownloadOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SemanticAssetError("Semantic model download timeout is invalid");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new SemanticAssetError("Semantic model redirect limit is invalid");
  }

  const controller = new AbortController();
  const abortDownload = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortDownload();
  else options.signal?.addEventListener("abort", abortDownload, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let current = pinnedModelUrl(file);
  try {
    for (let redirects = 0; ; redirects++) {
      if (
        current.protocol !== "https:" ||
        current.username !== "" ||
        current.password !== ""
      ) {
        throw new SemanticAssetError("Semantic model download refused a non-HTTPS URL");
      }
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/octet-stream" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          throw new SemanticAssetError("Semantic model download exceeded its redirect limit");
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new SemanticAssetError("Semantic model redirect omitted its destination");
        }
        current = new URL(location, current);
        continue;
      }
      if (response.status !== 200) {
        throw new SemanticAssetError(
          `Semantic model download failed with HTTP status ${response.status}`,
        );
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) !== file.size) {
        throw new SemanticAssetError(
          `Semantic model response declared size ${declaredLength}; expected ${file.size}`,
        );
      }
      if (response.body === null) {
        throw new SemanticAssetError("Semantic model response has no body");
      }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(file.size);
      let offset = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (offset + chunk.value.byteLength > file.size) {
          await reader.cancel();
          throw new SemanticAssetError(
            `Semantic model response exceeded the exact size for ${file.path}`,
          );
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
      if (offset !== file.size) {
        throw new SemanticAssetError(
          `Semantic model response ended at ${offset} bytes; expected ${file.size}`,
        );
      }
      assertExactBytes(bytes, file);
      return bytes;
    }
  } catch (cause) {
    if (cause instanceof SemanticAssetError) throw cause;
    throw new SemanticAssetError(
      `Could not download pinned semantic model file ${file.path}`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortDownload);
  }
}

export type ModelFileDownloader = (file: PinnedModelFile) => Promise<Uint8Array>;

export async function prepareVerifiedModelCache(
  cacheDirectory: string,
  modelId: string,
  revision: string,
  files: readonly PinnedModelFile[],
  download: ModelFileDownloader,
): Promise<string> {
  if (!path.isAbsolute(cacheDirectory)) {
    throw new SemanticAssetError("Semantic model cache directory must be absolute");
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(modelId)) {
    throw new SemanticAssetError("Semantic model identifier is invalid");
  }
  const modelSegments = modelId.split("/");
  if (modelSegments.some((segment) => segment === "." || segment === "..")) {
    throw new SemanticAssetError("Semantic model identifier is invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new SemanticAssetError("Semantic model revision is invalid");
  }
  const revisionRoot = path.join(cacheDirectory, revision);
  const [owner, model] = modelSegments;
  const ownerRoot = path.join(revisionRoot, owner);
  const modelRoot = path.join(ownerRoot, model);
  for (const directory of [cacheDirectory, revisionRoot, ownerRoot, modelRoot]) {
    ensureSafeDirectory(directory);
  }
  for (const file of files) {
    const destination = path.join(modelRoot, ...assertSafeRelativeFile(file));
    const existing = readOrdinaryFile(destination);
    if (existing !== null) {
      try {
        assertExactBytes(existing, file);
        continue;
      } catch (error) {
        if (error instanceof SemanticAssetError) {
          throw new SemanticAssetError(
            `Pinned semantic model cache entry failed verification: ${file.path}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    publishVerifiedFile(destination, await download(file), file);
  }
  verifyModelCache(revisionRoot, modelId, files);
  return revisionRoot;
}

export function verifyModelCache(
  revisionRoot: string,
  modelId: string,
  files: readonly PinnedModelFile[],
): void {
  const modelRoot = path.join(revisionRoot, ...modelId.split("/"));
  assertSafeDirectory(modelRoot);
  for (const file of files) {
    const cached = readOrdinaryFile(
      path.join(modelRoot, ...assertSafeRelativeFile(file)),
    );
    if (cached === null) {
      throw new SemanticAssetError(`Pinned semantic model cache is missing ${file.path}`);
    }
    assertExactBytes(cached, file);
  }
}

export interface VerifiedModelSnapshot {
  readonly root: string;
  dispose(): void;
}

function makeDirectoryTreeWritable(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SemanticAssetError(
      `Semantic model snapshot contains an unsafe directory: ${directory}`,
    );
  }
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SemanticAssetError(
        `Semantic model snapshot contains a symbolic link: ${candidate}`,
      );
    }
    if (entry.isDirectory()) makeDirectoryTreeWritable(candidate);
  }
}

function removeStaleSnapshots(snapshotsRoot: string): void {
  const now = Date.now();
  const entries = readdirSync(snapshotsRoot, { withFileTypes: true });
  if (entries.length > 128) {
    throw new SemanticAssetError("Semantic model snapshot inventory is unbounded");
  }
  for (const entry of entries) {
    const candidate = path.join(snapshotsRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new SemanticAssetError(
        `Semantic model snapshot inventory contains an unsafe entry: ${candidate}`,
      );
    }
    const stat = lstatSync(candidate);
    if (now - stat.mtimeMs < STALE_SNAPSHOT_MS) continue;
    makeDirectoryTreeWritable(candidate);
    rmSync(candidate, { recursive: true, force: true });
  }
}

/** Creates a process-private, verified read-only view for model initialization. */
export function createVerifiedModelSnapshot(
  revisionRoot: string,
  modelId: string,
  files: readonly PinnedModelFile[],
): VerifiedModelSnapshot {
  verifyModelCache(revisionRoot, modelId, files);
  const snapshotsRoot = path.join(path.dirname(revisionRoot), "runtime");
  ensureSafeDirectory(snapshotsRoot);
  removeStaleSnapshots(snapshotsRoot);
  const snapshotRoot = path.join(snapshotsRoot, randomUUID());
  const modelRoot = path.join(snapshotRoot, ...modelId.split("/"));
  ensureSafeDirectory(modelRoot);
  const directories = new Set<string>([snapshotRoot, path.dirname(modelRoot), modelRoot]);
  const published: string[] = [];
  try {
    for (const file of files) {
      const segments = assertSafeRelativeFile(file);
      const source = path.join(revisionRoot, ...modelId.split("/"), ...segments);
      const bytes = readOrdinaryFile(source);
      if (bytes === null) {
        throw new SemanticAssetError(`Pinned semantic model cache is missing ${file.path}`);
      }
      assertExactBytes(bytes, file);
      const destination = path.join(modelRoot, ...segments);
      publishVerifiedFile(destination, bytes, file);
      published.push(destination);
      for (
        let directory = path.dirname(destination);
        directory.startsWith(snapshotRoot) && directory.length >= snapshotRoot.length;
        directory = path.dirname(directory)
      ) {
        directories.add(directory);
        if (directory === snapshotRoot) break;
      }
    }
    verifyModelCache(snapshotRoot, modelId, files);
    for (const file of published) chmodSync(file, 0o400);
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      chmodSync(directory, 0o500);
    }
  } catch (error) {
    for (const directory of directories) {
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Cleanup below reports only the authoritative initialization failure.
      }
    }
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    root: snapshotRoot,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const directory of directories) chmodSync(directory, 0o700);
      rmSync(snapshotRoot, { recursive: true, force: true });
    },
  });
}

/**
 * Materializes the exact revision in a revision-scoped local-model root. The
 * returned directory is suitable for Transformers.js `env.localModelPath`.
 */
export async function preparePinnedModelCache(
  cacheDirectory: string,
  download: ModelFileDownloader = downloadPinnedModelFile,
): Promise<string> {
  return prepareVerifiedModelCache(
    cacheDirectory,
    PINNED_MODEL_ID,
    PINNED_MODEL_REVISION,
    PINNED_MODEL_FILES,
    download,
  );
}

export function verifyPinnedModelCache(revisionRoot: string): void {
  verifyModelCache(revisionRoot, PINNED_MODEL_ID, PINNED_MODEL_FILES);
}

export function createPinnedModelSnapshot(revisionRoot: string): VerifiedModelSnapshot {
  return createVerifiedModelSnapshot(
    revisionRoot,
    PINNED_MODEL_ID,
    PINNED_MODEL_FILES,
  );
}
