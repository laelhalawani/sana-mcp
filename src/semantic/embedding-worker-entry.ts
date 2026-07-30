import { runEmbeddingWorker } from "./embedding-worker.js";

try {
  await runEmbeddingWorker();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
