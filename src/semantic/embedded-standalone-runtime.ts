import wasmPath from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm" with {
  type: "file",
};

interface StandaloneTransformersEnvironment {
  cacheDir: string | null;
  localModelPath: string;
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
  useFSCache: boolean;
  useWasmCache: boolean;
  backends: {
    onnx: {
      wasm: {
        wasmBinary?: Uint8Array;
        wasmPaths?: string | Record<string, string>;
        numThreads?: number;
      };
    };
  };
}

export async function configureStandaloneTransformers(
  environment: StandaloneTransformersEnvironment,
  localModelRoot: string,
): Promise<void> {
  const wasm = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  environment.cacheDir = null;
  environment.localModelPath = `${localModelRoot.replace(/[\\/]$/u, "")}/`;
  environment.allowLocalModels = true;
  environment.allowRemoteModels = false;
  environment.useFSCache = false;
  environment.useWasmCache = false;
  environment.backends.onnx.wasm.wasmBinary = wasm;
  environment.backends.onnx.wasm.wasmPaths = undefined;
  environment.backends.onnx.wasm.numThreads = 1;
}
