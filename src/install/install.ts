// `sana-mcp install`: detect installed MCP clients, let the user pick, and
// register this server with each chosen client (idempotent, non-destructive).
import { execFileSync } from "node:child_process";
import { checkbox } from "@inquirer/prompts";
import { CLIENTS, type ClientDef } from "./clients.js";
import { serverTarget, type ServerTarget } from "./server-target.js";
import {
  upsertJsonServer,
  upsertTomlServer,
  upsertYamlServerList,
  removeJsonServer,
  removeTomlServer,
  removeYamlServerList,
  type WriteResult,
} from "./writers.js";

export interface InstallOpts {
  dryRun?: boolean;
  yes?: boolean;
  name?: string;
}

export interface ApplyResult {
  status: "ok" | "noop" | "skipped" | "failed";
  detail?: string;
}

function safeDetect(c: ClientDef): boolean {
  try {
    return c.detect();
  } catch {
    return false;
  }
}

function mapWrite(res: WriteResult, file: string, dryRun: boolean): ApplyResult {
  if (res === "skipped-unparseable")
    return { status: "skipped", detail: `${file} is not valid; left untouched` };
  if (res === "noop") return { status: "noop" };
  return { status: "ok", detail: dryRun ? `would write ${file}` : file };
}

function applyClient(
  c: ClientDef,
  name: string,
  entry: ServerTarget,
  dryRun: boolean
): ApplyResult {
  const inst = c.install;
  if (inst.kind === "file-json") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(upsertJsonServer(file, inst.topKey, name, entry, dryRun), file, dryRun);
  }
  if (inst.kind === "file-toml") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(upsertTomlServer(file, name, entry, dryRun), file, dryRun);
  }
  if (inst.kind === "file-yaml-list") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(upsertYamlServerList(file, name, entry, dryRun), file, dryRun);
  }
  // command-based (e.g. claude-code shells out to `claude mcp add`)
  const args = inst.buildArgs(name, entry);
  if (dryRun) return { status: "ok", detail: `would run: ${inst.bin} ${args.join(" ")}` };
  try {
    execFileSync(inst.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", detail: (e as Error).message.split("\n")[0] };
  }
}

function describe(r: ApplyResult): string {
  switch (r.status) {
    case "ok":
      return `registered${r.detail ? ` -> ${r.detail}` : ""}`;
    case "noop":
      return "already registered (no change)";
    case "skipped":
      return `skipped: ${r.detail ?? "not writable"}`;
    case "failed":
      return `failed: ${r.detail ?? "error"}`;
  }
}

export async function runInstall(opts: InstallOpts = {}): Promise<void> {
  const serverName = opts.name ?? "sana-mcp";
  const entry = serverTarget();
  const dryRun = !!opts.dryRun;

  const detected = CLIENTS.filter(safeDetect);
  const others = CLIENTS.filter((c) => !safeDetect(c));

  console.log(`sana-mcp installer - registering server "${serverName}"`);
  console.log(`  command: ${entry.command} ${entry.args.join(" ")}\n`);

  let chosen: ClientDef[];
  if (opts.yes) {
    chosen = detected;
    if (chosen.length === 0) {
      console.log("No supported clients detected. Re-run without --yes to pick manually.");
      return;
    }
  } else {
    if (detected.length === 0 && others.length === 0) {
      console.log("No supported clients known for this platform.");
      return;
    }
    const choices = [
      ...detected.map((c) => ({ name: `${c.name} (detected)`, value: c.id, checked: true })),
      ...others.map((c) => ({ name: c.name, value: c.id, checked: false })),
    ];
    const ids = await checkbox<string>({
      message: "Select clients to register sana-mcp with:",
      choices,
      pageSize: 15,
    });
    chosen = CLIENTS.filter((c) => ids.includes(c.id));
  }

  if (chosen.length === 0) {
    console.log("Nothing selected; no changes made.");
    return;
  }

  if (dryRun) console.log("Dry run - no files will be changed.\n");
  for (const c of chosen) {
    const r = applyClient(c, serverName, entry, dryRun);
    const tail = c.reloadHint ? ` -> ${c.reloadHint}` : "";
    console.log(`  ${c.name}: ${describe(r)}${tail}`);
  }
  console.log("\nDone.");
}

function applyRemove(c: ClientDef, name: string, dryRun: boolean): ApplyResult {
  const inst = c.install;
  if (inst.kind === "file-json") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(removeJsonServer(file, inst.topKey, name, dryRun), file, dryRun);
  }
  if (inst.kind === "file-toml") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(removeTomlServer(file, name, dryRun), file, dryRun);
  }
  if (inst.kind === "file-yaml-list") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(removeYamlServerList(file, name, dryRun), file, dryRun);
  }
  if (!inst.removeArgs)
    return { status: "skipped", detail: "no automated removal for this client" };
  const args = inst.removeArgs(name);
  if (dryRun) return { status: "ok", detail: `would run: ${inst.bin} ${args.join(" ")}` };
  try {
    execFileSync(inst.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", detail: (e as Error).message.split("\n")[0] };
  }
}

function describeRemove(r: ApplyResult, dryRun: boolean): string {
  if (r.status === "ok") return dryRun ? "would remove" : "removed";
  if (r.status === "noop") return "not registered (nothing to remove)";
  return describe(r);
}

export async function runUninstall(opts: InstallOpts = {}): Promise<void> {
  const serverName = opts.name ?? "sana-mcp";
  const dryRun = !!opts.dryRun;
  const detected = CLIENTS.filter(safeDetect);
  if (detected.length === 0) {
    console.log("No supported clients detected.");
    return;
  }

  let chosen: ClientDef[];
  if (opts.yes) {
    chosen = detected;
  } else {
    const ids = await checkbox<string>({
      message: `Remove "${serverName}" from which clients?`,
      choices: detected.map((c) => ({ name: c.name, value: c.id, checked: true })),
      pageSize: 15,
    });
    chosen = CLIENTS.filter((c) => ids.includes(c.id));
  }

  if (chosen.length === 0) {
    console.log("Nothing selected; no changes made.");
    return;
  }

  if (dryRun) console.log("Dry run - no files will be changed.\n");
  for (const c of chosen) {
    const r = applyRemove(c, serverName, dryRun);
    const detail =
      r.detail && r.status !== "ok" && r.status !== "noop" ? ` -> ${r.detail}` : "";
    console.log(`  ${c.name}: ${describeRemove(r, dryRun)}${detail}`);
  }
  console.log("\nDone.");
}
