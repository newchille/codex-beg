import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentRuntime } from "@codex-beg/core";
import { createMcpServer, startHttpServer } from "./server.js";

const isStdio = process.argv.includes("--stdio");
const dataDirectory = process.env.CODEX_BEG_DATA_DIR ?? join(homedir(), ".codex-beg");
const port = Number(process.env.CODEX_BEG_MCP_PORT ?? 43123);

const runtime = new AgentRuntime(dataDirectory);
await runtime.init();

if (isStdio) {
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
} else {
  const http = await startHttpServer(runtime, port);
  console.error(`codex-beg agent host listening on http://127.0.0.1:${port}/mcp`);
  const shutdown = async () => { http.close(); await runtime.shutdown(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
