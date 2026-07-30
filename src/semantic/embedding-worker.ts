import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { isCompiledBinary, PROJECT_ROOT } from "../config.js";
import {
  EMBED_DIM,
  SemanticUnavailableError,
  embedTexts,
  unloadModel,
  type EmbedTexts,
  type SemanticUnavailableContext,
} from "./semantic.js";

const MAX_BATCH_SIZE = 128;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;

interface WorkerRequest {
  readonly id: number;
  readonly texts: string[];
}

type WorkerResponse =
  | Readonly<{ id: number; ok: true; vectors: string[] }>
  | Readonly<{
      id: number;
      ok: false;
      message: string;
      unavailable: boolean;
      context?: SemanticUnavailableContext;
    }>;

function workerCommand(): Readonly<{ executable: string; args: string[] }> {
  return isCompiledBinary()
    ? { executable: process.execPath, args: ["__semantic-worker"] }
    : {
        executable: process.execPath,
        args: [path.join(PROJECT_ROOT, "src", "semantic", "embedding-worker-entry.ts")],
      };
}

function parseRequest(line: string): WorkerRequest {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
    throw new Error("Semantic worker request exceeds the protocol size limit");
  }
  const value = JSON.parse(line) as Partial<WorkerRequest>;
  if (!Number.isSafeInteger(value.id) || (value.id ?? 0) <= 0) {
    throw new Error("Semantic worker request has an invalid id");
  }
  if (
    !Array.isArray(value.texts) ||
    value.texts.length === 0 ||
    value.texts.length > MAX_BATCH_SIZE ||
    value.texts.some((text) => typeof text !== "string")
  ) {
    throw new Error("Semantic worker request has an invalid text batch");
  }
  return { id: value.id!, texts: value.texts };
}

function serializeVectors(vectors: readonly Float32Array[]): string[] {
  return vectors.map((vector) =>
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64")
  );
}

function parseResponse(line: string, expectedId: number, batchSize: number): Float32Array[] {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
    throw new Error("Semantic worker response exceeds the protocol size limit");
  }
  const response = JSON.parse(line) as WorkerResponse;
  if (response.id !== expectedId) {
    throw new Error("Semantic worker response id does not match its request");
  }
  if (!response.ok) {
    if (response.unavailable) {
      throw new SemanticUnavailableError(response.message, { context: response.context });
    }
    throw new Error(response.message);
  }
  if (!Array.isArray(response.vectors) || response.vectors.length !== batchSize) {
    throw new Error("Semantic worker returned an invalid vector batch");
  }
  return response.vectors.map((encoded) => {
    if (typeof encoded !== "string") {
      throw new Error("Semantic worker returned a non-string vector");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== EMBED_DIM * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error("Semantic worker returned a vector with the wrong dimension");
    }
    return new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  });
}

export async function runEmbeddingWorker(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffered = "";
  try {
    for await (const chunk of process.stdin) {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_MESSAGE_BYTES) {
        throw new Error("Semantic worker input exceeds the protocol size limit");
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length === 0) continue;
        let id = 0;
        let response: WorkerResponse;
        try {
          const request = parseRequest(line);
          id = request.id;
          const vectors = await embedTexts(request.texts);
          response = { id, ok: true, vectors: serializeVectors(vectors) };
        } catch (error) {
          const unavailable = error instanceof SemanticUnavailableError;
          response = {
            id,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            unavailable,
            ...(unavailable && error.context !== undefined
              ? { context: error.context }
              : {}),
          };
        }
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
    if (buffered.length > 0) {
      throw new Error("Semantic worker received a truncated request");
    }
  } finally {
    await unloadModel();
  }
}

interface PendingRequest {
  readonly id: number;
  readonly batchSize: number;
  readonly resolve: (vectors: Float32Array[]) => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

export class EmbeddingWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending: PendingRequest | null = null;
  private stdout = "";
  private stderr = "";
  private closed = false;

  readonly embed: EmbedTexts = async (texts, signal) => {
    if (this.closed) throw new Error("Semantic worker client is closed");
    if (this.pending !== null) {
      throw new Error("Semantic worker received concurrent embedding requests");
    }
    signal?.throwIfAborted();
    const child = this.ensureChild();
    const id = this.nextId++;
    return await new Promise<Float32Array[]>((resolve, reject) => {
      const onAbort = (): void => {
        this.fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        this.terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        batchSize: texts.length,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      };
      child.stdin.write(`${JSON.stringify({ id, texts })}\n`, (error) => {
        if (
          error &&
          this.child === child &&
          this.pending?.id === id
        ) {
          this.fail(error);
        }
      });
    });
  };

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;
    const command = workerCommand();
    const child = spawn(command.executable, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child === child) this.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child === child) {
        this.stderr = `${this.stderr}${chunk}`.slice(-4096);
      }
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.stdout = "";
      this.stderr = "";
      this.fail(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.pending !== null) {
        const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
        const diagnostics = this.stderr.trim();
        this.fail(new Error(
          `Semantic worker exited before responding (${detail})${diagnostics ? `: ${diagnostics}` : ""}`,
        ));
      }
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > MAX_MESSAGE_BYTES) {
      this.fail(new Error("Semantic worker output exceeds the protocol size limit"));
      this.terminate();
      return;
    }
    const newline = this.stdout.indexOf("\n");
    if (newline < 0) return;
    const line = this.stdout.slice(0, newline);
    this.stdout = this.stdout.slice(newline + 1);
    const pending = this.pending;
    if (pending === null || this.stdout.includes("\n")) {
      this.fail(new Error("Semantic worker emitted an unsolicited response"));
      this.terminate();
      return;
    }
    try {
      const vectors = parseResponse(line, pending.id, pending.batchSize);
      this.pending = null;
      pending.removeAbortListener();
      pending.resolve(vectors);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    pending.removeAbortListener();
    pending.reject(error);
  }

  terminate(): void {
    const child = this.child;
    this.child = null;
    this.stdout = "";
    this.stderr = "";
    if (child === null) return;
    child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child === null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    if (await Promise.race([
      exited.then(() => true),
      Bun.sleep(CLOSE_TIMEOUT_MS).then(() => false),
    ])) return;
    child.kill("SIGTERM");
    if (await Promise.race([
      exited.then(() => true),
      Bun.sleep(CLOSE_TIMEOUT_MS).then(() => false),
    ])) return;
    child.kill("SIGKILL");
    await exited;
  }
}
