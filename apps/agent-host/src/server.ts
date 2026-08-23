import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { AgentRuntime, CodexBegError, ProjectCommandInput, ReadFileInput, RelativePathInput, SearchInput, WorkspaceAddInput, WorkspaceIdInput, WriteFileInput } from "@codex-beg/core";

export const TOOL_NAMES = [
  "workspace_list", "workspace_add", "workspace_select", "workspace_current", "workspace_info", "workspace_tree", "workspace_snapshot",
  "read_file", "list_directory", "search_text", "file_info", "write_file", "apply_patch",
  "git_status", "git_diff", "git_log", "git_show",
  "project_test", "project_lint", "project_typecheck", "project_build", "project_dev",
  "process_list", "process_read", "process_stop", "operation_get",
] as const;

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export function createMcpServer(runtime: AgentRuntime): Server {
  const server = new Server({ name: "codex-beg", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    tool("workspace_list", "List registered local workspaces.", {}),
    tool("workspace_add", "Register a local project directory. This is the only tool that accepts an absolute root path.", { rootPath: { type: "string" }, displayName: { type: "string" } }, ["rootPath"]),
    tool("workspace_select", "Select the active registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_current", "Return the current active workspace.", {}),
    tool("workspace_info", "Return metadata for a registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_tree", "Return a bounded tree for a registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_snapshot", "Return workspace metadata and a bounded tree snapshot.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("read_file", "Read bounded UTF-8 text using a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["workspaceId", "path"]),
    tool("list_directory", "List entries using a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" } }, ["workspaceId"]),
    tool("search_text", "Search text in bounded workspace files.", { workspaceId: { type: "string" }, query: { type: "string" }, path: { type: "string" }, maxResults: { type: "number" } }, ["workspaceId", "query"]),
    tool("file_info", "Return metadata and hash for a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" } }, ["workspaceId", "path"]),
    tool("write_file", "Create or overwrite a UTF-8 file with hash-checked reversible recovery.", { workspaceId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, expectedSha256: { type: "string" } }, ["workspaceId", "path", "content"]),
    tool("apply_patch", "Apply an atomic bounded unified patch to workspace files.", { workspaceId: { type: "string" }, patch: { type: "string" } }, ["workspaceId", "patch"]),
    tool("git_status", "Read Git status for the selected workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_diff", "Read the current Git diff.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_log", "Read recent Git history.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_show", "Read a bounded Git ref summary.", { workspaceId: { type: "string" }, ref: { type: "string" } }, ["workspaceId"]),
    ...(["test", "lint", "typecheck", "build", "dev"] as const).map((name) => tool(`project_${name}`, `Run the configured ${name} project command.`, { workspaceId: { type: "string" }, timeoutSeconds: { type: "number" } }, ["workspaceId"])),
    tool("process_list", "List managed processes and bounded logs.", {}),
    tool("process_read", "Read one managed process.", { processId: { type: "string" } }, ["processId"]),
    tool("process_stop", "Stop one managed process.", { processId: { type: "string" } }, ["processId"]),
    tool("operation_get", "Read an operation result or approval-required status.", { operationId: { type: "string" } }, ["operationId"]),
  ] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      switch (name) {
        case "workspace_list": result = runtime.workspaceList(); break;
        case "workspace_add": { const input = WorkspaceAddInput.parse(args); result = await runtime.addWorkspace(input.rootPath, input.displayName); break; }
        case "workspace_select": { const input = WorkspaceIdInput.parse(args); result = await runtime.selectWorkspace(input.workspaceId); break; }
        case "workspace_current": result = runtime.workspaceCurrent(); break;
        case "workspace_info": { const input = WorkspaceIdInput.parse(args); result = runtime.workspaceInfo(input.workspaceId); break; }
        case "workspace_tree": { const input = WorkspaceIdInput.parse(args); result = await runtime.workspaceTree(input.workspaceId); break; }
        case "workspace_snapshot": { const input = WorkspaceIdInput.parse(args); result = await runtime.workspaceSnapshot(input.workspaceId); break; }
        case "read_file": { const input = ReadFileInput.parse(args); result = await runtime.readFile(input.workspaceId, input.path, input.offset, input.limit); break; }
        case "list_directory": { const input = WorkspaceIdInput.parse(args); result = await runtime.listDirectory(input.workspaceId, typeof args.path === "string" ? args.path : "."); break; }
        case "search_text": { const input = SearchInput.parse(args); result = await runtime.search(input.workspaceId, input.query, input.path, input.maxResults); break; }
        case "file_info": { const input = RelativePathInput.parse(args); result = await runtime.fileInfo(input.workspaceId, input.path); break; }
        case "write_file": result = await runtime.writeFile(WriteFileInput.parse(args)); break;
        case "apply_patch": result = await runtime.applyPatch(args); break;
        case "git_status": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitStatus(input.workspaceId); break; }
        case "git_diff": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitDiff(input.workspaceId); break; }
        case "git_log": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitLog(input.workspaceId); break; }
        case "git_show": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitShow(input.workspaceId, typeof args.ref === "string" ? args.ref : undefined); break; }
        case "project_test": result = await runtime.projectCommand("test", ProjectCommandInput.parse(args)); break;
        case "project_lint": result = await runtime.projectCommand("lint", ProjectCommandInput.parse(args)); break;
        case "project_typecheck": result = await runtime.projectCommand("typecheck", ProjectCommandInput.parse(args)); break;
        case "project_build": result = await runtime.projectCommand("build", ProjectCommandInput.parse(args)); break;
        case "project_dev": result = await runtime.projectCommand("dev", ProjectCommandInput.parse(args)); break;
        case "process_list": result = runtime.processList(); break;
        case "process_read": result = runtime.processRead(String(args.processId)); break;
        case "process_stop": result = await runtime.processStop(String(args.processId)); break;
        case "operation_get": result = runtime.operationGet(String(args.operationId)); break;
        default: throw new CodexBegError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const details = error instanceof CodexBegError ? { code: error.code, message: error.message, details: error.details } : error instanceof ZodError ? { code: "INVALID_INPUT", message: "Tool arguments failed schema validation.", details: error.issues } : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(details) }] };
    }
  });
  return server;
}

async function handleMcpRequest(runtime: AgentRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StreamableHTTPServerTransport({});
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(request, response);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function startHttpServer(runtime: AgentRuntime, port = 43123) {
  const http = createServer((request, response) => {
    if (request.url === "/healthz") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, service: "codex-beg-agent-host" })); return; }
    if (request.url?.startsWith("/events")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.events.recent())); return; }
    if (request.url === "/admin/state" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.workspaceList())); return; }
    if (request.url === "/admin/approvals" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.approvalsList())); return; }
    if (request.url?.startsWith("/admin/approval/") && request.method === "POST") {
      const parts = request.url.split("/"); const action = parts.at(-2); const id = parts.at(-1) ?? "";
      void Promise.resolve(action === "approve" ? runtime.approvalApprove(id) : action === "reject" ? runtime.approvalReject(id) : (() => { throw new CodexBegError("INVALID_APPROVAL_ACTION", "Unsupported approval action."); })()).then((value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
      return;
    }
    if (request.url?.startsWith("/admin/recovery/restore/") && request.method === "POST") { const id = request.url.split("/").pop() ?? ""; void Promise.resolve(runtime.recoveryRestore(id)).then((value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url === "/admin/workspace/add" && request.method === "POST") { void readJson(request).then(async (body) => { const workspace = await runtime.addWorkspace(String(body.rootPath), typeof body.displayName === "string" ? body.displayName : undefined); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(workspace)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url === "/admin/workspace/select" && request.method === "POST") { void readJson(request).then(async (body) => { const workspace = await runtime.selectWorkspace(String(body.workspaceId)); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(workspace)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url?.startsWith("/admin/workspace/remove/") && request.method === "POST") { const id = request.url.split("/").pop() ?? ""; void runtime.removeWorkspace(id).then(() => { response.writeHead(204); response.end(); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url !== "/mcp") { response.writeHead(404); response.end("Not found"); return; }
    void handleMcpRequest(runtime, request, response).catch((error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => resolve()); });
  return http;
}
