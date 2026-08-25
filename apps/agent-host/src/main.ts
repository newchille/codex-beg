import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentRuntime } from "@codex-beg/core";
import { createMcpServer, startHttpServer } from "./server.js";

const isStdio = process.argv.includes("--stdio");
const dataDirectory = process.env.CODEX_BEG_DATA_DIR ?? join(homedir(), ".codex-beg");
const port = Number(process.env.CODEX_BEG_MCP_PORT ?? 43123);

async function readAdminToken(): Promise<string | undefined> {
  if (process.env.CODEX_BEG_ADMIN_TOKEN_STDIN !== "1") return undefined;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 4096) throw new Error("Admin token input exceeded the maximum length.");
    chunks.push(buffer);
  }
  const token = Buffer.concat(chunks, totalBytes).toString("utf8").trim();
  return token || undefined;
}

const runtime = new AgentRuntime(dataDirectory);
await runtime.init();

if (isStdio) {
  const server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
} else {
  const adminToken = await readAdminToken();
  const http = await startHttpServer(runtime, port, adminToken);
  console.error(`codex-beg agent host listening on http://127.0.0.1:${port}/mcp`);
  const shutdown = async () => { http.close(); await runtime.shutdown(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
