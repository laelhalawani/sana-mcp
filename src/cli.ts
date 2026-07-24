#!/usr/bin/env node
// Thin CLI over the same sana(tool, args) dispatcher the MCP server uses.
//   sana-mcp <tool> [json]            e.g. sana-mcp list '{"limit":10}'
//   sana-mcp login --email you@x.com
//   sana-mcp login --email you@x.com --code 123456
//   sana-mcp read --id v72Hz...
//   sana-mcp daemon                   run the background syncer in the foreground
import { Command } from "commander";
import { sana } from "./tools/dispatch.js";
import pkg from "../package.json" with { type: "json" };

const program = new Command();
program
  .name("sana-mcp")
  .description("Sana.AI meeting transcripts - CLI for the Sana.AI transcript tools")
  .version(pkg.version);

program
  .command("daemon")
  .description("Run the background sync daemon in the foreground")
  .action(async () => {
    const { runDaemon } = await import("./sync/daemon.js");
    await runDaemon();
  });

program
  .command("install")
  .description("Detect installed MCP clients and register sana-mcp with the ones you choose")
  .option("--dry-run", "show what would change without writing anything")
  .option("--yes", "register with all detected clients, no prompts")
  .option("--name <name>", "server name written into client configs", "sana-mcp")
  .action(async (opts: { dryRun?: boolean; yes?: boolean; name?: string }) => {
    const { runInstall } = await import("./install/install.js");
    await runInstall(opts);
    process.exit(0);
  });

program
  .command("uninstall")
  .description("Remove sana-mcp from the MCP clients you choose")
  .option("--dry-run", "show what would change without writing anything")
  .option("--yes", "remove from all detected clients, no prompts")
  .option("--name <name>", "server name to remove", "sana-mcp")
  .action(async (opts: { dryRun?: boolean; yes?: boolean; name?: string }) => {
    const { runUninstall } = await import("./install/install.js");
    await runUninstall(opts);
    process.exit(0);
  });

program
  .command("mcp")
  .description("Run the MCP server on stdio")
  .action(async () => {
    const { runMcp } = await import("./mcp.js");
    await runMcp();
  });

program
  .argument("[tool]", "tool name (help, login, status, list, read)")
  .argument("[json]", "optional JSON args, e.g. '{\"limit\":10}'")
  .option("--email <email>")
  .option("--code <code>", "confirmation code for login step 2")
  .option("--id <id>", "meeting id for read")
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
      !opts.limit &&
      !opts.query &&
      opts.timestamps !== false;
    if (bareInvocation) {
      const { runInstall } = await import("./install/install.js");
      await runInstall();
      process.exit(0);
    }

    let args: Record<string, unknown> = {};
    if (json) {
      try {
        args = JSON.parse(json);
      } catch {
        console.error("Invalid JSON args.");
        process.exit(1);
      }
    }
    if (opts.email) args.email = opts.email;
    if (opts.code) args.confirmation_code = opts.code;
    if (opts.id) args.id = opts.id;
    if (opts.limit) args.limit = Number(opts.limit);
    if (opts.query) args.query = opts.query;
    if (opts.timestamps === false) args.timestamps = false;

    const out = await sana(tool ?? "help", args);
    console.log(out);
    process.exit(0);
  });

program.parseAsync(process.argv);
