// Standalone entry for the background sync daemon.
import fs from "node:fs";
import path from "node:path";
import { dataDirectory, ensureDataDir } from "./config.js";
import { runDaemon } from "./sync/daemon.js";

runDaemon().catch((e) => {
  try {
    ensureDataDir();
    fs.appendFileSync(
      path.join(dataDirectory(), "daemon.log"),
      `${new Date().toISOString()} daemon fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
    );
  } catch {
    // best-effort logging; if the data dir is unavailable there is nowhere to log
  }
  process.exit(1);
});
