// Standalone entry for the background sync daemon.
import { runDaemon } from "./sync/daemon.js";

runDaemon().catch((e) => {
  console.error("daemon fatal:", e);
  process.exit(1);
});
