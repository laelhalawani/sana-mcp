export interface StandaloneTransformersEnvironment {
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
  _environment: StandaloneTransformersEnvironment,
  _localModelRoot: string,
): Promise<void> {
  throw new Error(
    "The embedded semantic WASM runtime is available only in an official standalone build.",
  );
}
