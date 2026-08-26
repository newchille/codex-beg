import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "@codex-beg/core";
import { AGENT_HOST_VERSION, TOOL_CATALOG_HASH, TOOL_NAMES, createMcpServer, startHttpServer } from "./server.js";

function firstText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) throw new Error("MCP result did not contain content.");
  const first = result.content[0];
  if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") throw new Error("MCP result did not contain text content.");
  return first.text;
}

describe("Codex BEG MCP contract", () => {
  it("initializes and lists the public safety-core tools", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "codex-beg-host-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-beg-host-workspace-"));
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: {} }));
    const runtime = new AgentRuntime(dataDirectory);
    await runtime.init();
    const server = createMcpServer(runtime);
    const client = new Client({ name: "codex-beg-test", version: "0.1.4" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(TOOL_NAMES.length);
    expect(AGENT_HOST_VERSION).toBe("0.1.4");
    expect(TOOL_CATALOG_HASH).toMatch(/^[a-f0-9]{16}$/);
    const toolNames = listed.tools.map((item) => item.name);
    for (const name of ["workspace_list", "workspace_add", "workspace_register", "workspace_select", "workspace_current", "workspace_info", "workspace_tree", "workspace_snapshot", "read_many_files", "list_directory_page", "search_text_page", "search_files", "git_diff_check", "git_stage", "git_commit", "process_read_output"]) expect(toolNames).toContain(name);
    expect(listed.tools.map((item) => item.name)).toContain("workspace_snapshot");
    expect(listed.tools.map((item) => item.name)).not.toContain("shell_run");
    const invalid = await client.callTool({ name: "workspace_info", arguments: { workspaceId: "not-a-uuid" } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("INVALID_INPUT");
    const workspaceGrant = await client.callTool({ name: "workspace_add", arguments: { rootPath: workspaceRoot } });
    expect(workspaceGrant.isError).toBe(true);
    expect(firstText(workspaceGrant)).toContain("APPROVAL_REQUIRED");
    expect(firstText(workspaceGrant)).toContain("CAPABILITY_GRANT");
    const workspaceApproval = runtime.approvalsList().at(-1)!;
    expect(workspaceApproval.exactOperation).toContain(workspaceRoot);
    expect(workspaceApproval.risk).toContain("expands");
    expect(workspaceApproval.classification).toBe("CAPABILITY_GRANT");
    await runtime.addWorkspace(workspaceRoot);
    const machineRootPath = await mkdtemp(join(tmpdir(), "codex-beg-host-machine-root-"));
    await mkdir(join(machineRootPath, "child-project"));
    await writeFile(join(machineRootPath, "child-project", "package.json"), JSON.stringify({ scripts: {} }));
    const machineRoot = await runtime.addWorkspace(machineRootPath, undefined, "machine_root");
    expect(machineRoot.kind).toBe("machine_root");
    const childGrant = await client.callTool({ name: "workspace_register", arguments: { parentWorkspaceId: machineRoot.id, path: "child-project" } });
    expect(childGrant.isError).toBe(true);
    expect(firstText(childGrant)).toContain("APPROVAL_REQUIRED");
    expect(firstText(childGrant)).toContain("CAPABILITY_GRANT");
    const child = await runtime.registerWorkspace(machineRoot.id, "child-project");
    expect(child.kind).toBe("project");
    const readMany = await client.callTool({ name: "read_many_files", arguments: { workspaceId: child.id, files: [{ path: "package.json" }] } });
    expect(readMany.isError).not.toBe(true);
    expect(firstText(readMany)).toContain("bytesReturned");
    const listPage = await client.callTool({ name: "list_directory_page", arguments: { workspaceId: child.id, maxResults: 1 } });
    expect(listPage.isError).not.toBe(true);
    expect(firstText(listPage)).toContain("package.json");
    const textPage = await client.callTool({ name: "search_text_page", arguments: { workspaceId: child.id, query: "scripts", maxResults: 1 } });
    expect(textPage.isError).not.toBe(true);
    expect(firstText(textPage)).toContain("package.json");
    const searchFiles = await client.callTool({ name: "search_files", arguments: { workspaceId: child.id, query: "package" } });
    expect(searchFiles.isError).not.toBe(true);
    expect(firstText(searchFiles)).toContain("package.json");
    const listedAfterRegistration = await client.callTool({ name: "workspace_list", arguments: {} });
    expect(firstText(listedAfterRegistration)).toContain(machineRoot.id);
    await client.close();
    await server.close();
    await runtime.shutdown();
  });

  it("protects local admin HTTP routes with a per-session token", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "codex-beg-host-admin-data-"));
    const runtime = new AgentRuntime(dataDirectory);
    await runtime.init();
    const token = "test-admin-token";
    const http = await startHttpServer(runtime, 0, token);
    try {
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address.");
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/admin/state`)).status).toBe(401);
      expect((await fetch(`${base}/admin/operations`)).status).toBe(401);
      expect((await fetch(`${base}/admin/recovery`)).status).toBe(401);
      expect((await fetch(`${base}/events`)).status).toBe(401);
      expect((await fetch(`${base}/admin/state`, { headers: { "x-codex-beg-admin-token": "wrong" } })).status).toBe(401);
      const authenticated = await fetch(`${base}/admin/state`, { headers: { "x-codex-beg-admin-token": token } });
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toMatchObject({ schemaVersion: 1, workspaces: [] });
      const adminHeaders = { "x-codex-beg-admin-token": token };
      expect(await (await fetch(`${base}/admin/operations`, { headers: adminHeaders })).json()).toEqual([]);
      expect(await (await fetch(`${base}/admin/recovery`, { headers: adminHeaders })).json()).toEqual([]);
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await runtime.shutdown();
    }
  });
});
