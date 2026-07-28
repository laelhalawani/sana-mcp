import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PINNED_MODEL_FILES,
  PINNED_MODEL_ID,
  PINNED_MODEL_REVISION,
  SemanticAssetError,
  createVerifiedModelSnapshot,
  downloadPinnedModelFile,
  pinnedModelUrl,
  prepareVerifiedModelCache,
  verifyModelCache,
  type PinnedModelFile,
} from "../../src/semantic/model-cache.js";
import {
  extractEmbeddedVectorExtension,
  loadEmbeddedVectorExtension,
} from "../../src/semantic/native-extension.js";
import { vectorBuildAsset } from "../../src/semantic/build-plugin.js";
import { RELEASE_TARGETS } from "../../src/release/contract.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("pinned semantic model contract", () => {
  test("freezes the exact revision and researched four-file inventory", async () => {
    expect(PINNED_MODEL_ID).toBe("Xenova/all-MiniLM-L6-v2");
    expect(PINNED_MODEL_REVISION).toBe(
      "751bff37182d3f1213fa05d7196b954e230abad9",
    );
    expect(PINNED_MODEL_FILES).toEqual([
      {
        path: "config.json",
        size: 650,
        sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
      },
      {
        path: "tokenizer.json",
        size: 711661,
        sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
      },
      {
        path: "tokenizer_config.json",
        size: 366,
        sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
      },
      {
        path: "onnx/model_quantized.onnx",
        size: 22972370,
        sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
      },
    ]);
    expect(Object.isFrozen(PINNED_MODEL_FILES)).toBe(true);

    const config = await readFile(
      path.join(import.meta.dir, "fixtures/model-config.json"),
    );
    expect(config.byteLength).toBe(PINNED_MODEL_FILES[0].size);
    expect(sha256(config)).toBe(PINNED_MODEL_FILES[0].sha256);
  });

  test("uses only the exact HTTPS model/revision/file route", () => {
    expect(pinnedModelUrl(PINNED_MODEL_FILES[3]).href).toBe(
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/" +
        `${PINNED_MODEL_REVISION}/onnx/model_quantized.onnx`,
    );
  });

  test("bounds redirects and verifies response size and digest", async () => {
    const file = PINNED_MODEL_FILES[0];
    const bytes = await readFile(
      path.join(import.meta.dir, "fixtures/model-config.json"),
    );
    const requests: string[] = [];
    const downloaded = await downloadPinnedModelFile(file, {
      fetchImpl: (async (input, init) => {
        requests.push(String(input));
        expect(init?.redirect).toBe("manual");
        if (requests.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.hf.test/exact-config" },
          });
        }
        return new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        });
      }) as typeof fetch,
      timeoutMs: 1_000,
      maxRedirects: 1,
    });
    expect(downloaded).toEqual(new Uint8Array(bytes));
    expect(requests).toEqual([
      pinnedModelUrl(file).href,
      "https://cdn.hf.test/exact-config",
    ]);

    await expect(
      downloadPinnedModelFile(file, {
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://cdn.hf.test/config" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/non-HTTPS/);
    await expect(
      downloadPinnedModelFile(file, {
        maxRedirects: 0,
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://cdn.hf.test/config" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/redirect limit/);
    const changed = new Uint8Array(bytes);
    changed[0] ^= 1;
    await expect(
      downloadPinnedModelFile(file, {
        fetchImpl: (async () => new Response(changed, { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  test("aborts an in-flight model download", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const operation = downloadPinnedModelFile(PINNED_MODEL_FILES[0], {
      signal: controller.signal,
      fetchImpl: ((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    controller.abort(new Error("search cancelled"));
    await expect(operation).rejects.toThrow(/Could not download pinned/);
    expect(requestSignal?.aborted).toBe(true);
  });
});

describe("verified semantic model cache", () => {
  test("atomically publishes verified files and rejects later corruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-model-cache-test-"));
    const first = Buffer.from("first exact model file");
    const second = Buffer.from("second exact model file");
    const files: readonly PinnedModelFile[] = [
      { path: "config.json", size: first.length, sha256: sha256(first) },
      { path: "onnx/model.onnx", size: second.length, sha256: sha256(second) },
    ];
    let downloads = 0;
    try {
      const revisionRoot = await prepareVerifiedModelCache(
        path.join(root, "cache"),
        "Owner/model",
        "a".repeat(40),
        files,
        async (file) => {
          downloads++;
          return file.path === files[0].path ? first : second;
        },
      );
      expect(downloads).toBe(2);
      verifyModelCache(revisionRoot, "Owner/model", files);
      expect(
        await readFile(path.join(revisionRoot, "Owner/model/onnx/model.onnx")),
      ).toEqual(second);

      const snapshot = createVerifiedModelSnapshot(
        revisionRoot,
        "Owner/model",
        files,
      );
      expect(await readFile(path.join(snapshot.root, "Owner/model/config.json"))).toEqual(
        first,
      );
      snapshot.dispose();
      await expect(
        readFile(path.join(snapshot.root, "Owner/model/config.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await prepareVerifiedModelCache(
        path.join(root, "cache"),
        "Owner/model",
        "a".repeat(40),
        files,
        async () => {
          throw new Error("verified cache unexpectedly downloaded again");
        },
      );
      await writeFile(path.join(revisionRoot, "Owner/model/config.json"), "corrupt");
      await expect(
        prepareVerifiedModelCache(
          path.join(root, "cache"),
          "Owner/model",
          "a".repeat(40),
          files,
          async () => first,
        ),
      ).rejects.toThrow(/failed verification/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked application cache boundary", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-model-link-test-"));
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, "cache"));
    try {
      await expect(
        prepareVerifiedModelCache(
          path.join(root, "cache"),
          "Owner/model",
          "a".repeat(40),
          [],
          async () => new Uint8Array(),
        ),
      ).rejects.toBeInstanceOf(SemanticAssetError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects model identifiers and file paths that can escape the cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-model-path-test-"));
    const bytes = Buffer.from("exact");
    const file = { path: "../outside", size: bytes.length, sha256: sha256(bytes) };
    try {
      await expect(
        prepareVerifiedModelCache(
          path.join(root, "cache"),
          "../model",
          "a".repeat(40),
          [],
          async () => bytes,
        ),
      ).rejects.toThrow(/identifier is invalid/);
      await expect(
        prepareVerifiedModelCache(
          path.join(root, "cache"),
          "Owner/model",
          "a".repeat(40),
          [file],
          async () => bytes,
        ),
      ).rejects.toThrow(/path is unsafe/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("embedded sqlite-vec assets", () => {
  test("maps every release target to its exact native package", () => {
    expect(RELEASE_TARGETS.map((target) => [target, vectorBuildAsset(target)])).toEqual([
      ["bun-linux-x64", { packageName: "sqlite-vec-linux-x64", assetName: "vec0.so" }],
      ["bun-linux-x64-musl", { packageName: "sqlite-vec-linux-x64", assetName: "vec0.so" }],
      ["bun-linux-arm64", { packageName: "sqlite-vec-linux-arm64", assetName: "vec0.so" }],
      ["bun-linux-arm64-musl", { packageName: "sqlite-vec-linux-arm64", assetName: "vec0.so" }],
      ["bun-darwin-x64", { packageName: "sqlite-vec-darwin-x64", assetName: "vec0.dylib" }],
      ["bun-darwin-arm64", { packageName: "sqlite-vec-darwin-arm64", assetName: "vec0.dylib" }],
      ["bun-windows-x64", { packageName: "sqlite-vec-windows-x64", assetName: "vec0.dll" }],
    ]);
  });

  test("extracts under the digest, reuses verified bytes, and detects tampering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-vector-asset-test-"));
    const bytes = Buffer.from("synthetic native extension bytes");
    const expected = sha256(bytes);
    try {
      const extension = extractEmbeddedVectorExtension({
        dataDirectory: root,
        assetName: "vec0.so",
        bytes,
        sha256: expected,
      });
      expect(extension).toBe(path.join(root, "native/sqlite-vec", expected, "vec0.so"));
      expect(await readFile(extension)).toEqual(bytes);
      expect(
        extractEmbeddedVectorExtension({
          dataDirectory: root,
          assetName: "vec0.so",
          bytes,
          sha256: expected,
        }),
      ).toBe(extension);
      await chmod(extension, 0o600);
      await writeFile(extension, "tampered");
      expect(() =>
        extractEmbeddedVectorExtension({
          dataDirectory: root,
          assetName: "vec0.so",
          bytes,
          sha256: expected,
        }),
      ).toThrow(/integrity verification/);
      expect(() =>
        extractEmbeddedVectorExtension({
          dataDirectory: root,
          assetName: "vec0.so",
          bytes,
          sha256: "0".repeat(64),
        }),
      ).toThrow(/build digest/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads verified native bytes through the open descriptor on Linux", async () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-vector-load-test-"));
    const bytes = await readFile(
      path.join(process.cwd(), "node_modules/sqlite-vec-linux-x64/vec0.so"),
    );
    const db = new Database(":memory:");
    try {
      loadEmbeddedVectorExtension(db, {
        dataDirectory: root,
        assetName: "vec0.so",
        bytes,
        sha256: sha256(bytes),
      });
      expect(db.query("SELECT vec_version() AS version").get()).toEqual({
        version: "v0.1.9",
      });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("holds a no-write Windows handle throughout verification and loading", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "sana-vector-lock-test-"));
    const bytes = Buffer.from("synthetic native extension bytes");
    let blocked = false;
    try {
      loadEmbeddedVectorExtension(
        {
          loadExtension(file: string): void {
            try {
              writeFileSync(file, "tampered");
            } catch (error) {
              blocked = (error as NodeJS.ErrnoException).code === "EBUSY" ||
                (error as NodeJS.ErrnoException).code === "EPERM" ||
                (error as NodeJS.ErrnoException).code === "EACCES";
            }
          },
        } as unknown as Database,
        {
          dataDirectory: root,
          assetName: "vec0.dll",
          bytes,
          sha256: sha256(bytes),
        },
      );
      expect(blocked).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
