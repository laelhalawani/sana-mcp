#!/usr/bin/env node
// MCP server exposing a single entrypoint tool: sana(tool, args).
// The agent discovers everything else via sana({tool:"help"}).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sana } from "./tools/dispatch.js";

const server = new McpServer({
  name: "meeting-transcripts",
  version: "0.1.0",
});

server.registerTool(
  "meeting_transcripts",
  {
    title: "Meeting transcripts",
    description:
      'Access your meetings: list and search them, read transcripts, and get ' +
      'summaries, participants, and recording links. ' +
      'New meetings sync automatically shortly after they end. ' +
      'Call meeting_transcripts("help") for a summary of all tools and their usage. ' +
      'Powered by Sana.ai.',
    inputSchema: {
      tool: z
        .string()
        .describe(
          'The name of the meeting transcripts tool you want to use. One of: help, login, status, list, read, search, summary, participants, recording.'
        ),
      args: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'An optional JSON object of arguments for the chosen tool, e.g. {"email":"you@example.com"}. ' +
            'Check a tool\'s argument schema with meeting_transcripts("help", {"tool":"<name>"}).'
        ),
    },
  },
  async ({ tool, args }) => {
    const text = await sana(tool, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("sana MCP server running on stdio");
