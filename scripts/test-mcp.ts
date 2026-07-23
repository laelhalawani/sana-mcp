import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp.ts"],
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const call = async (tool: string, args?: Record<string, unknown>) => {
  const r = await client.callTool({ name: "meeting_transcripts", arguments: { tool, args } });
  const text = (r.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("\n");
  console.log(`\n=== sana("${tool}", ${JSON.stringify(args ?? {})}) ===\n` + text.slice(0, 500));
};

await call("help");
await call("status");
await call("list_meetings", { limit: 3 });

await client.close();
process.exit(0);
