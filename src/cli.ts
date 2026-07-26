#!/usr/bin/env node
// Human CLI over structured core APIs; the MCP server keeps its agent-facing
// renderer and output contract separate.
//   sana-mcp <tool> [json]            e.g. sana-mcp list '{"limit":10}'
//   sana-mcp login --email you@x.com
//   sana-mcp login --email you@x.com --code 123456
//   sana-mcp read --id v72Hz...
//   sana-mcp daemon                   run the background syncer in the foreground
import { Command } from "commander";
import { inspect } from "node:util";
import { sanitizeTerminalText } from "./app/render.js";
import type {
  InstallerFlowResult,
  UninstallerFlowResult,
} from "./install/install.js";
import {
  BUILD_INFO,
  serializeStandaloneBuildInfoProperties,
} from "./runtime/build-info.js";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("sana-mcp")
  .description("Sana.AI meeting transcripts - CLI for the Sana.AI transcript tools")
  .version(pkg.version);

function writeHumanLine(
  stream: Pick<NodeJS.WriteStream, "write">,
  value: unknown,
): void {
  stream.write(`${sanitizeTerminalText(value, { multiline: true })}\n`);
}

function humanErrorText(error: unknown): string {
  if (error instanceof Error) {
    if (
      "code" in error &&
      error.code === "INVALID_ARGUMENT" &&
      "field" in error &&
      typeof error.field === "string"
    ) {
      return `Invalid argument "${error.field}": ${error.message || error.name}`;
    }
    return error.message || error.name;
  }
  return inspect(error, { colors: false });
}

function bareHint(): string {
  return [
    "Run sana-mcp in a terminal to configure Sana and your AI clients.",
    "For one-shot commands, run: sana-mcp help",
  ].join("\n");
}

function installerExitCode(
  disposition: InstallerFlowResult["disposition"],
): 0 | 1 {
  switch (disposition) {
    case "configured":
    case "planned":
    case "no-clients":
    case "no-changes":
    case "cancelled":
      return 0;
    case "interaction-unavailable":
      return 1;
  }
}

function uninstallerExitCode(
  disposition: UninstallerFlowResult["disposition"],
): 0 | 1 {
  switch (disposition) {
    case "completed":
    case "planned":
    case "no-registrations":
    case "no-selection":
    case "cancelled":
      return 0;
    case "interaction-unavailable":
      return 1;
  }
}

program
  .command("__inspect", { hidden: true })
  .description("Print the embedded standalone release identity")
  .option("--format <format>", "machine format: json or properties", "json")
  .action((opts: { format: string }) => {
    if (!BUILD_INFO.standalone) {
      throw new Error("__inspect is available only in a standalone build");
    }
    if (opts.format === "properties") {
      process.stdout.write(serializeStandaloneBuildInfoProperties(BUILD_INFO));
      return;
    }
    if (opts.format !== "json") {
      throw new Error("__inspect --format must be json or properties");
    }
    process.stdout.write(`${JSON.stringify(BUILD_INFO)}\n`);
  });

async function daemonLifecycle(
  operation: string,
): Promise<{ state: "running" | "stopped"; changed: boolean }> {
  const { SanaStore } = await import("./store/db.js");
  const { daemonStateStatus, pidAlive } = await import("./sync/lock.js");
  const inspect = (): { state: "running" | "stopped"; pid?: number } => {
    const store = new SanaStore();
    try {
      const status = daemonStateStatus(store.getSyncState());
      if (status.kind === "stale-live") {
        throw new Error(
          `daemon heartbeat is stale while process ${status.pid} is still running; stop it manually`,
        );
      }
      return status.kind === "alive"
        ? { state: "running", pid: status.pid }
        : { state: "stopped" };
    } finally {
      store.close();
    }
  };

  if (operation === "health") {
    return { state: inspect().state, changed: false };
  }
  if (operation === "start") {
    const before = inspect();
    if (before.state === "running") return { state: "running", changed: false };
    const { ensureDaemonRunning } = await import("./sync/spawn.js");
    await ensureDaemonRunning();
    return { state: inspect().state, changed: true };
  }
  if (operation === "stop") {
    const { requestDaemonStop } = await import("./sync/control.js");
    const deadline = Date.now() + 10_000;
    let changed = false;
    let stoppedObservations = 0;
    while (Date.now() < deadline) {
      const before = inspect();
      if (before.state === "stopped") {
        stoppedObservations++;
        if (stoppedObservations >= 3) {
          return { state: "stopped", changed };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }
      stoppedObservations = 0;
      const stoppedPid = before.pid!;
      requestDaemonStop(stoppedPid);
      changed = true;
      while (pidAlive(stoppedPid)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `daemon process ${stoppedPid} did not exit within 10000ms; stop it manually`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(
      "daemon state did not remain stopped within 10000ms; stop it manually",
    );
  }
  throw new Error("__lifecycle operation must be health, stop, or start");
}

program
  .command("__lifecycle <operation>", { hidden: true })
  .description("Run the versioned installer lifecycle protocol")
  .option("--format <format>", "machine format: properties", "properties")
  .action(async (operation: string, opts: { format: string }) => {
    if (!BUILD_INFO.standalone) {
      throw new Error("__lifecycle is available only in a standalone build");
    }
    if (opts.format !== "properties") {
      throw new Error("__lifecycle --format must be properties");
    }
    const result = await daemonLifecycle(operation);
    process.stdout.write(
      [
        `lifecycleProtocol=${BUILD_INFO.lifecycleProtocol}`,
        `state=${result.state}`,
        `changed=${String(result.changed)}`,
        "",
      ].join("\n"),
    );
  });

function requireStandaloneInstallerCommand(command: string): void {
  if (!BUILD_INFO.standalone) {
    throw new Error(`${command} is available only in a standalone build`);
  }
}

program
  .command("__reset-incompatible-state <operation>", { hidden: true })
  .description("Run the installer incompatible-state reset protocol")
  .requiredOption("--journal <directory>", "private reset journal directory")
  .option("--install-dir <directory>", "binary installation directory")
  .option("--format <format>", "machine format: properties", "properties")
  .action(
    async (
      operation: string,
      opts: { journal: string; installDir?: string; format: string },
    ) => {
      requireStandaloneInstallerCommand("__reset-incompatible-state");
      if (opts.format !== "properties") {
        throw new Error(
          "__reset-incompatible-state --format must be properties",
        );
      }
      const reset = await import("./install/incompatible-reset.js");
      if (operation === "status") {
        process.stdout.write(
          reset.serializeIncompatibleResetStatus(
            reset.inspectIncompatibleReset(opts.journal),
          ),
        );
        return;
      }
      const result =
        operation === "prepare"
          ? reset.prepareIncompatibleReset({
              journalDirectory: opts.journal,
              installDirectory:
                opts.installDir ??
                (() => {
                  throw new Error(
                    "prepare requires --install-dir",
                  );
                })(),
            })
          : operation === "rollback"
            ? reset.rollbackIncompatibleReset(opts.journal)
            : operation === "commit"
              ? reset.commitIncompatibleReset(opts.journal)
              : (() => {
                  throw new Error(
                    "reset operation must be prepare, rollback, commit, or status",
                  );
                })();
      process.stdout.write(reset.serializeIncompatibleResetResult(result));
    },
  );

const configTransaction = program
  .command("__configure-transaction", { hidden: true })
  .description("Run the installer client-configuration transaction protocol");

configTransaction
  .command("apply")
  .requiredOption("--journal <directory>", "private absolute journal directory")
  .requiredOption(
    "--server-command <path>",
    "final absolute standalone binary path",
  )
  .option("--yes", "confirm configuration of every detected client")
  .action(
    async (opts: {
      journal: string;
      serverCommand: string;
      yes?: boolean;
    }) => {
      requireStandaloneInstallerCommand("__configure-transaction");
      const { serializeConfigTransactionResult } = await import(
        "./install/config-transaction.js"
      );
      const { runInstallerConfigTransaction } = await import(
        "./install/install.js"
      );
      const result = await runInstallerConfigTransaction(
        {
          journalDirectory: opts.journal,
          serverCommand: opts.serverCommand,
          yes: opts.yes,
        },
        {
          terminal: {
            input: process.stdin,
            output: process.stderr,
            env: process.env,
            platform: process.platform,
          },
          writeLine: (line) => process.stderr.write(`${line}\n`),
        },
      );
      process.stdout.write(serializeConfigTransactionResult(result));
      process.exitCode = result.exitCode;
    },
  );

configTransaction
  .command("rollback")
  .requiredOption("--journal <directory>", "private absolute journal directory")
  .action(async (opts: { journal: string }) => {
    requireStandaloneInstallerCommand("__configure-transaction");
    const {
      rollbackConfigTransaction,
      serializeConfigTransactionResult,
    } = await import("./install/config-transaction.js");
    const result = rollbackConfigTransaction({
      journalDirectory: opts.journal,
    });
    process.stdout.write(serializeConfigTransactionResult(result));
    process.exitCode = result.exitCode;
  });

program
  .command("daemon")
  .description("Run the background sync daemon in the foreground")
  .action(async () => {
    const { runDaemon } = await import("./sync/daemon.js");
    await runDaemon();
  });

program
  .command("update")
  .description("Update an installed standalone sana-mcp to the latest release")
  .action(async () => {
    const { runUpdate } = await import("./install/update.js");
    const result = await runUpdate({
      confirmIncompatible: async () => {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
          throw new Error(
            "This update needs confirmation in an interactive terminal because local Sana state is incompatible",
          );
        }
        const { confirm } = await import("@inquirer/prompts");
        writeHumanLine(
          process.stdout,
          "This release cannot preserve the current local Sana state. Meetings will be re-synced and you will have to sign in again.",
        );
        return await confirm({
          message: "Do you want to continue?",
          default: false,
        });
      },
    });
    switch (result.state) {
      case "current":
        writeHumanLine(
          process.stdout,
          `sana-mcp ${result.version} is already current.`,
        );
        break;
      case "newer":
        writeHumanLine(
          process.stdout,
          `Installed sana-mcp ${result.version} is newer than latest ${result.latestVersion}; no downgrade was performed.`,
        );
        break;
      case "cancelled":
        writeHumanLine(process.stdout, "Update cancelled. Nothing was changed.");
        break;
      case "updated":
        writeHumanLine(
          process.stdout,
          `Updated sana-mcp to ${result.version}.`,
        );
        break;
      case "handed-off":
        writeHumanLine(
          process.stdout,
          `Update to sana-mcp ${result.version} was handed off and will continue after this command exits.`,
        );
        break;
    }
  });

program
  .command("install")
  .aliases(["config", "configure"])
  .description("Detect installed MCP clients and register sana-mcp with the ones you choose")
  .option("--dry-run", "show what would change without writing anything")
  .option("--yes", "register with all detected clients, no prompts")
  .option("--name <name>", "server name written into client configs", "sana-mcp")
  .action(async (opts: { dryRun?: boolean; yes?: boolean; name?: string }) => {
    const { runInstall } = await import("./install/install.js");
    const result = await runInstall(opts);
    process.exitCode = installerExitCode(result.disposition);
  });

program
  .command("uninstall")
  .description("Remove sana-mcp from the MCP clients you choose")
  .option("--dry-run", "show what would change without writing anything")
  .option("--yes", "remove from all detected clients, no prompts")
  .option("--name <name>", "server name to remove", "sana-mcp")
  .action(async (opts: { dryRun?: boolean; yes?: boolean; name?: string }) => {
    const { runUninstall } = await import("./install/install.js");
    const result = await runUninstall(opts);
    process.exitCode = uninstallerExitCode(result.disposition);
  });

program
  .command("mcp")
  .description("Run the MCP server on stdio")
  .action(async () => {
    const { runMcp } = await import("./mcp.js");
    await runMcp();
  });

program
  .argument(
    "[tool]",
    "tool name (help, login, status, list, read, search, summary, participants, recording)",
  )
  .argument("[json]", "optional JSON args, e.g. '{\"limit\":10}'")
  .option("--email <email>")
  .option("--code <code>", "confirmation code for login step 2")
  .option("--id <id>", "meeting id for read")
  .option("--page <n>", "page number")
  .option("--limit <n>", "list limit")
  .option("--query <q>", "filter meetings by title")
  .option("--no-timestamps", "omit timestamps in transcript")
  .action(async (tool: string | undefined, json: string | undefined, opts: Record<string, unknown>) => {
    // Bare `sana-mcp` (no tool, no flags) opens the interactive configurer.
    const bareInvocation =
      !tool &&
      !json &&
      !opts.email &&
      !opts.code &&
      !opts.id &&
      !opts.page &&
      !opts.limit &&
      !opts.query &&
      opts.timestamps !== false;
    if (bareInvocation) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        writeHumanLine(process.stdout, bareHint());
        process.exitCode = 0;
        return;
      }
      const { runApp } = await import("./app/app.js");
      await runApp();
      process.exitCode = 0;
      return;
    }

    let args: Record<string, unknown> = {};
    if (json) {
      if (tool === "help" && !json.trimStart().startsWith("{")) {
        args.command = json.trim();
      } else {
        try {
          const parsed: unknown = JSON.parse(json);
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) {
            throw new TypeError("JSON args must be an object.");
          }
          args = parsed as Record<string, unknown>;
        } catch {
          writeHumanLine(
            process.stderr,
            "Invalid JSON args: expected one JSON object.",
          );
          process.exitCode = 1;
          return;
        }
      }
    }
    if (opts.email) args.email = opts.email;
    if (opts.code) args.confirmation_code = opts.code;
    if (opts.id) args.id = opts.id;
    if (opts.page) args.page = Number(opts.page);
    if (opts.limit) args.limit = Number(opts.limit);
    if (opts.query) args.query = opts.query;
    if (opts.timestamps === false) args.timestamps = false;

    const { runHumanCommand } = await import("./app/commands.js");
    const out = await runHumanCommand(tool ?? "help", args);
    writeHumanLine(process.stdout, out);
    process.exitCode = 0;
  });

async function handleProgramFailure(error: unknown): Promise<void> {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "CLIENT_CONFIGURATION_INCOMPLETE"
  ) {
    const { handleClientConfigurationCliError } = await import(
      "./install/install.js"
    );
    if (handleClientConfigurationCliError(error)) return;
  }
  writeHumanLine(process.stderr, humanErrorText(error));
  process.exitCode = 1;
}

void program.parseAsync(process.argv).catch(handleProgramFailure);
