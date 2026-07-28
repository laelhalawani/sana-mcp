import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ReleaseTarget } from "../release/contract.js";

export interface VectorBuildAsset {
  readonly packageName: string;
  readonly assetName: "vec0.so" | "vec0.dylib" | "vec0.dll";
}

export function vectorBuildAsset(target: ReleaseTarget): VectorBuildAsset {
  const platform = target.startsWith("bun-windows-")
    ? "windows"
    : target.startsWith("bun-darwin-")
      ? "darwin"
      : "linux";
  const architecture = target.includes("arm64") ? "arm64" : "x64";
  const suffix = platform === "windows" ? "dll" : platform === "darwin" ? "dylib" : "so";
  return Object.freeze({
    packageName: `sqlite-vec-${platform}-${architecture}`,
    assetName: `vec0.${suffix}` as VectorBuildAsset["assetName"],
  });
}

export function createSemanticBuildPlugin(target: ReleaseTarget): Bun.BunPlugin {
  const semanticRoot = import.meta.dir;
  const asset = vectorBuildAsset(target);
  return {
    name: `sana-bundled-semantic-${target}`,
    setup(build) {
      build.onResolve({ filter: /^onnxruntime-node$/u }, () => ({
        path: path.join(semanticRoot, "ort-wasm-shim.ts"),
      }));
      build.onResolve({ filter: /^sharp$/u }, () => ({
        path: path.join(semanticRoot, "sharp-stub.ts"),
      }));
      build.onResolve({ filter: /standalone-runtime\.js$/u }, (args) =>
        args.path === "./standalone-runtime.js" &&
        path.dirname(args.importer) === semanticRoot
          ? { path: path.join(semanticRoot, "embedded-standalone-runtime.ts") }
          : undefined,
      );
      build.onResolve({ filter: /^sqlite-vec$/u }, () => ({
        path: target,
        namespace: "sana-embedded-sqlite-vec",
      }));
      build.onLoad(
        { filter: /.*/u, namespace: "sana-embedded-sqlite-vec" },
        () => {
          const assetSpecifier = `${asset.packageName}/${asset.assetName}`;
          let assetPath: string;
          try {
            assetPath = fileURLToPath(import.meta.resolve(assetSpecifier));
          } catch (cause) {
            throw new Error(
              `The target-native semantic build asset ${assetSpecifier} is unavailable`,
              { cause },
            );
          }
          const bytes = readFileSync(assetPath);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const helper = path.join(semanticRoot, "native-extension.ts");
          return {
            loader: "ts",
            contents: `
import embeddedPath from ${JSON.stringify(assetPath)} with { type: "file" };
import { loadEmbeddedVectorExtension } from ${JSON.stringify(helper)};
const bytes = new Uint8Array(await Bun.file(embeddedPath).arrayBuffer());
const expectedSha256 = ${JSON.stringify(sha256)};
export function load(db, dataDirectory) {
  if (typeof dataDirectory !== "string" || dataDirectory.length === 0) {
    throw new Error("Embedded sqlite-vec requires the authoritative application data directory");
  }
  loadEmbeddedVectorExtension(db, {
    dataDirectory,
    assetName: ${JSON.stringify(asset.assetName)},
    bytes,
    sha256: expectedSha256,
  });
}
`,
          };
        },
      );
    },
  };
}
