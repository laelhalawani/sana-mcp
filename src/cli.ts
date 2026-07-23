#!/usr/bin/env node
// Thin CLI over the same sana(tool, args) dispatcher the MCP server uses.
//   sana <tool> [json]                e.g. sana list_meetings '{"limit":10}'
//   sana login --email you@x.com
//   sana login --email you@x.com --code 123456
//   sana read_transcript --id v72Hz...
//   sana daemon                       run the background syncer in the foreground
import { Command } from "commander";
import { sana } from "./tools/dispatch.js";

const program = new Command();
program
  .name("sana")
  .description("Sana.AI meeting transcripts — CLI over the sana(tool,args) interface")
  .version("0.1.0");

program
  .command("daemon")
  .description("Run the background sync daemon in the foreground")
  .action(async () => {
    const { runDaemon } = await import("./sync/daemon.js");
    await runDaemon();
  });

program
  .argument("[tool]", "tool name (help, login, status, list_meetings, read_transcript)", "help")
  .argument("[json]", "optional JSON args, e.g. '{\"limit\":10}'")
  .option("--email <email>")
  .option("--code <code>", "confirmation code for login step 2")
  .option("--id <id>", "meeting id for read_transcript")
  .option("--limit <n>", "list limit")
  .option("--offset <n>", "list offset")
  .option("--query <q>", "filter meetings by title")
  .option("--no-timestamps", "omit timestamps in transcript")
  .action(async (tool: string, json: string | undefined, opts: Record<string, unknown>) => {
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
    if (opts.offset) args.offset = Number(opts.offset);
    if (opts.query) args.query = opts.query;
    if (opts.timestamps === false) args.timestamps = false;

    const out = await sana(tool, args);
    console.log(out);
    process.exit(0);
  });

program.parseAsync(process.argv);
