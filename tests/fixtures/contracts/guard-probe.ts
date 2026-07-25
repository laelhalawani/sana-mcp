import fs from "node:fs";
import { Database } from "bun:sqlite";

const liveDataDir = process.env.SANA_TEST_FORBIDDEN_DATA_DIR;
const isolatedDataDir = process.env.SANA_DATA_DIR;
if (!liveDataDir || !isolatedDataDir) {
  throw new Error("contract guard probe requires both data directories");
}

const liveDataAlias = process.env.SANA_TEST_LIVE_DATA_ALIAS;
const blocked: string[] = [];

function isContractBlock(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith("contract tests block")) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(isContractBlock);
  }
  return isContractBlock(error.cause);
}

async function expectBlocked(
  name: string,
  action: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (isContractBlock(error)) {
      blocked.push(name);
      return;
    }
    throw error;
  }
  throw new Error(`${name} was not blocked`);
}

await expectBlocked("live data metadata", () => fs.lstatSync(liveDataDir));
if (liveDataAlias) {
  await expectBlocked("live data alias metadata", () =>
    fs.lstatSync(liveDataAlias),
  );
  await expectBlocked("live data alias SQLite read-only", () =>
    new Database(liveDataAlias, { readonly: true, create: false }),
  );
}

const { SanaClient } = await import("../../../src/sana/client.js");
await expectBlocked("Sana client fetch", () =>
  new SanaClient().requestSignInCode("contract@example.invalid"),
);

const { ensureDaemonRunning } = await import("../../../src/sync/spawn.js");
await expectBlocked("production daemon spawn", async () => {
  await ensureDaemonRunning();
});

process.stdout.write(JSON.stringify(blocked));
