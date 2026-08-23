import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "@codex-beg/core";
import { createMcpServer } from "./server.js";

describe("Codex BEG MCP contract", () => {
  it("initializes and lists the public safety-core tools", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "codex-beg-host-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-beg-host-workspace-"));
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: {} }));
    const runtime = new AgentRuntime(dataDirectory);
    await runtime.init();
    const server = createMcpServer(runtime);
    const client = new Client({ name: "codex-beg-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((item) => item.name)).toContain("workspace_snapshot");
    expect(listed.tools.map((item) => item.name)).not.toContain("shell_run");
    const invalid = await client.callTool({ name: "workspace_info", arguments: { workspaceId: "not-a-uuid" } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("INVALID_INPUT");
    const added = await client.callTool({ name: "workspace_add", arguments: { rootPath: workspaceRoot } });
    expect(added.isError).not.toBe(true);
    await client.close();
    await server.close();
    await runtime.shutdown();
  });
});
