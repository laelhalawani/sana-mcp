// `sana-mcp` configurer: detect installed MCP clients, show a toggle wizard
// reflecting each client's current registration, apply the diff (enable /
// disable), then optionally sign in. `--yes` is an opt-in unattended mode.
import { execFileSync, execSync } from "node:child_process";
import { checkbox, confirm, input } from "@inquirer/prompts";
import { CLIENTS, type ClientDef } from "./clients.js";
import { serverTarget, type ServerTarget } from "./server-target.js";
import { isRegistered } from "./status.js";
import { which } from "./detect.js";
import { wizardPrompt, type WizardRow, type WizardResult } from "./wizard-prompt.js";
import { sana } from "../tools/dispatch.js";
import {
  upsertJsonServer,
  upsertJsoncServer,
  upsertTomlServer,
  upsertYamlServerList,
  removeJsonServer,
  removeJsoncServer,
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

/**
 * Run a command-based client's CLI (e.g. `claude mcp add ...`). On Windows the
 * target is usually a `.cmd`/`.ps1` shim, which CreateProcess cannot exec
 * directly, so we run it through cmd.exe and quote each argument. On POSIX we
 * exec directly with an args array (no shell, so no quoting concerns).
 */
function runCommandClient(bin: string, args: string[]): void {
  if (process.platform === "win32") {
    // Resolve the binary to a full path (which() -> where.exe) so we don't
    // depend on cmd's PATH/PATHEXT resolution, which is fragile. A `.cmd`/`.ps1`
    // shim still can't be exec'd directly by CreateProcess, so go through
    // cmd.exe; quote the resolved path and each arg (call/cmd handles the shim).
    const resolved = which(bin) ?? bin;
    const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const line = `${q(resolved)} ${args.map(q).join(" ")}`;
    execSync(line, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return;
  }
  execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  if (inst.kind === "file-jsonc") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(
      upsertJsoncServer(file, inst.topKey, name, entry, inst.build, dryRun),
      file,
      dryRun
    );
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
  if (which(inst.bin) === null)
    return { status: "skipped", detail: `${inst.bin} CLI not found on PATH` };
  const args = inst.buildArgs(name, entry);
  if (dryRun) return { status: "ok", detail: `would run: ${inst.bin} ${args.join(" ")}` };
  try {
    runCommandClient(inst.bin, args);
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

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
};

/**
 * The interactive configurer, launched by `sana-mcp` (no args) or
 * `sana-mcp install`. Shows detected clients as toggles seeded from their
 * current registration, applies the diff, then offers sign-in.
 * `--yes` runs unattended: register with every detected client.
 */
export async function runInstall(opts: InstallOpts = {}): Promise<void> {
  const serverName = opts.name ?? "sana-mcp";
  const entry = serverTarget();
  const dryRun = !!opts.dryRun;

  const detected = CLIENTS.filter(safeDetect);

  // --- unattended path ---
  if (opts.yes) {
    if (detected.length === 0) {
      console.log("No supported AI clients detected.");
      return;
    }
    console.log(C.bold(`Registering sana-mcp with ${detected.length} detected client(s):`));
    for (const c of detected) {
      const r = applyClient(c, serverName, entry, dryRun);
      console.log(`  ${statusIcon(r)} ${c.name}: ${describe(r)}`);
    }
    console.log(`\nRun ${C.cyan("sana-mcp")} anytime to change this or sign in.`);
    return;
  }

  // --- interactive wizard ---
  if (detected.length === 0) {
    console.log("No supported AI clients detected on this machine.");
    console.log(
      `Install one (Claude Desktop, Cursor, VS Code, ...) then run ${C.cyan("sana-mcp")} again.`
    );
    return;
  }

  const rows: WizardRow[] = CLIENTS.map((c) => {
    const det = detected.includes(c);
    return {
      id: c.id,
      name: c.name,
      detected: det,
      current: det ? isRegistered(c, serverName) : false,
      hint: c.reloadHint,
    };
  });

  if (!process.stdin.isTTY) {
    console.log(
      "sana-mcp needs an interactive terminal to configure clients. Run `sana-mcp` in a terminal, or use `sana-mcp install --yes` to register with all detected clients."
    );
    return;
  }

  let result: WizardResult;
  try {
    result = await wizardPrompt({
      message: "Configure sana-mcp for your AI clients",
      rows,
      serverName,
    });
  } catch {
    console.log(
      "sana-mcp needs an interactive terminal to configure clients. Run `sana-mcp` in a terminal, or use `sana-mcp install --yes` to register with all detected clients."
    );
    return;
  }

  if (!result.submitted) {
    console.log("\nCancelled - no changes made.");
    return;
  }

  // Act on every detected client whose desired state is ON (upsert is
  // idempotent and self-refreshing: it rewrites a stale command path and
  // returns "noop" when nothing changed), plus clients being turned off.
  // Clients that were off and stay off are skipped silently.
  const acted: ClientDef[] = [];
  const results: ApplyResult[] = [];
  for (const c of detected) {
    const want = result.desired[c.id];
    const cur = rows.find((r) => r.id === c.id)?.current ?? false;
    if (want) {
      acted.push(c);
      results.push(applyClient(c, serverName, entry, dryRun));
    } else if (cur) {
      acted.push(c);
      results.push(applyRemove(c, serverName, dryRun));
    }
    // else: was off, stays off -> skip silently
  }

  if (acted.length === 0) {
    console.log("\nNo changes to apply.");
  } else {
    console.log("");
    acted.forEach((c, i) => {
      const r = results[i]!;
      const want = result.desired[c.id];
      const verb = want ? describe(r) : describeRemove(r, dryRun);
      const tail = r.status === "ok" && c.reloadHint ? C.dim(` (${c.reloadHint})`) : "";
      console.log(`  ${statusIcon(r, want)} ${c.name}: ${verb}${tail}`);
    });
  }

  // --- optional sign-in ---
  await maybeLogin();

  console.log(`\nAll set. Run ${C.cyan("sana-mcp")} anytime to reconfigure clients or sign in.`);
}

function statusIcon(r: ApplyResult, enabling = true): string {
  if (r.status === "ok") return enabling ? C.green("+") : C.yellow("-");
  if (r.status === "noop") return C.dim("=");
  if (r.status === "failed") return C.red("x");
  return C.dim("~");
}

/** Offer an optional email-code sign-in as part of the configurer. */
async function maybeLogin(): Promise<void> {
  let loggedIn = false;
  try {
    // `status` returns the "not logged in" explainer when there's no session.
    const s = await sana("status");
    loggedIn = !/not logged in|to sign in|has expired|to login again/i.test(s);
  } catch {
    loggedIn = false;
  }
  if (loggedIn) {
    console.log(C.dim("\nAlready signed in to Sana."));
    return;
  }

  const wantLogin = await confirm({
    message: "Sign in to Sana now? (you can also let your agent do it later)",
    default: true,
  }).catch(() => false);
  if (!wantLogin) {
    console.log(
      C.dim("Skipped. Your agent will ask for your email + code the first time it needs them.")
    );
    return;
  }

  const email = (await input({ message: "Email for your Sana account:" }).catch(() => "")).trim();
  if (!email) {
    console.log(C.dim("No email entered - skipping sign-in."));
    return;
  }
  console.log(await sana("login", { email }));

  const code = (
    await input({ message: "Enter the 6-digit code from your email:" }).catch(() => "")
  ).trim();
  if (!code) {
    console.log(C.dim("No code entered - run `sana-mcp login --email you@example.com --code <code>` later."));
    return;
  }
  console.log(await sana("login", { email, confirmation_code: code }));
}

function applyRemove(c: ClientDef, name: string, dryRun: boolean): ApplyResult {
  const inst = c.install;
  if (inst.kind === "file-json") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(removeJsonServer(file, inst.topKey, name, dryRun), file, dryRun);
  }
  if (inst.kind === "file-jsonc") {
    const file = inst.path();
    if (!file) return { status: "skipped", detail: "not supported on this platform" };
    return mapWrite(removeJsoncServer(file, inst.topKey, name, dryRun), file, dryRun);
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
  if (which(inst.bin) === null)
    return { status: "skipped", detail: `${inst.bin} CLI not found on PATH` };
  const args = inst.removeArgs(name);
  if (dryRun) return { status: "ok", detail: `would run: ${inst.bin} ${args.join(" ")}` };
  try {
    runCommandClient(inst.bin, args);
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
