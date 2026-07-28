import * as ort from "onnxruntime-web/webgpu";
import { createHash } from "node:crypto";
import {
  PINNED_MODEL_FILES,
  SemanticAssetError,
} from "./model-cache.js";

export * from "onnxruntime-web/webgpu";
export const InferenceSession = {
  async create(model: unknown, ...options: unknown[]): Promise<unknown> {
    const input =
      typeof model === "string"
        ? new Uint8Array(await Bun.file(model).arrayBuffer())
        : model;
    if (typeof model === "string") {
      const expected = PINNED_MODEL_FILES.find(
        (file) => file.path === "onnx/model_quantized.onnx",
      );
      if (expected === undefined) {
        throw new SemanticAssetError("Pinned ONNX model authority is unavailable");
      }
      const digest = createHash("sha256").update(input as Uint8Array).digest("hex");
      if ((input as Uint8Array).byteLength !== expected.size || digest !== expected.sha256) {
        throw new SemanticAssetError("ONNX model changed before inference-session creation");
      }
    }
    return (ort.InferenceSession.create as (...args: unknown[]) => Promise<unknown>)(
      input,
      ...options,
    );
  },
};
