import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "FLI Flight Search MCP",
    version: "0.1.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Test the FLI Cloudflare Worker MCP server.",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `FLI MCP is working. Hello, ${name ?? "World"}!`,
        },
      ],
    }),
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
