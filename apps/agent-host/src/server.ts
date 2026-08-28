import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { AgentRuntime, CodexBegError, GitCheckoutInput, GitCommitInput, GitCreateBranchInput, GitStageInput, ListDirectoryPageInput, ProcessIdInput, ProcessReadOutputInput, ProjectCommandInput, ReadFileInput, ReadManyFilesInput, RelativePathInput, SearchFilesInput, SearchInput, SearchTextPageInput, WorkspaceAddInput, WorkspaceIdInput, WorkspaceRegisterInput, WriteFileInput } from "@codex-beg/core";

export const TOOL_NAMES = [
  "workspace_list", "workspace_add", "workspace_register", "workspace_create", "workspace_refresh", "workspace_select", "workspace_current", "workspace_info", "workspace_tree", "workspace_snapshot",
  "read_file", "read_many_files", "list_directory", "list_directory_page", "search_text", "search_text_page", "search_files", "file_info", "write_file", "apply_patch",
  "directory_create", "command_run", "git_status", "git_diff", "git_diff_check", "git_log", "git_show", "git_init", "git_add", "git_stage", "git_create_branch", "git_checkout", "git_commit",
  "project_test", "project_lint", "project_typecheck", "project_build", "project_dev",
  "process_list", "process_read", "process_read_output", "process_start", "process_write", "process_stop", "operation_get",
] as const;
export const TOOL_CATALOG_HASH = createHash("sha256").update(TOOL_NAMES.join("\n")).digest("hex").slice(0, 16);
export const AGENT_HOST_VERSION = "0.1.6";

const ADMIN_TOKEN_HEADER = "x-codex-beg-admin-token";
function adminAuthorized(request: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return false;
  const raw = request.headers[ADMIN_TOKEN_HEADER];
  const actual = Array.isArray(raw) ? raw[0] : raw;
  if (!actual) return false;
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(actual);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
function requiresAdminAuth(url?: string): boolean { return Boolean(url?.startsWith("/admin/") || url?.startsWith("/events")); }


const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export function createMcpServer(runtime: AgentRuntime): Server {
  const server = new Server({ name: "codex-beg", version: AGENT_HOST_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    tool("workspace_list", "List registered machine roots and project workspaces.", {}),
    tool("workspace_add", "Register an absolute local directory as a project or machine root.", { rootPath: { type: "string" }, displayName: { type: "string" }, kind: { type: "string", enum: ["machine_root", "project"] } }, ["rootPath"]),
    tool("workspace_register", "Register an existing child project below a registered workspace using a relative path.", { parentWorkspaceId: { type: "string" }, path: { type: "string" }, displayName: { type: "string" } }, ["parentWorkspaceId", "path"]),
    tool("workspace_create", "Create and register a child project directory below a machine-root workspace.", { parentWorkspaceId: { type: "string" }, path: { type: "string" }, displayName: { type: "string" }, initializeGit: { type: "boolean" } }, ["parentWorkspaceId", "path"]),
    tool("workspace_refresh", "Re-scan a workspace's current project type and configured commands.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_select", "Select the active registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_current", "Return the current active workspace.", {}),
    tool("workspace_info", "Return metadata for a registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_tree", "Return a bounded tree for a registered workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("workspace_snapshot", "Return workspace metadata and a bounded tree snapshot.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("read_file", "Read bounded UTF-8 text using a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["workspaceId", "path"]),
    tool("read_many_files", "Read multiple bounded UTF-8 files with per-file errors, conditional hashes, and a total byte ceiling.", { workspaceId: { type: "string" }, files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, knownSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["path"], additionalProperties: false } }, maxTotalBytes: { type: "number" } }, ["workspaceId", "files"]),
    tool("list_directory", "List entries using a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" } }, ["workspaceId"]),
    tool("list_directory_page", "List a stable bounded page of directory entries.", { workspaceId: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, maxResults: { type: "number" } }, ["workspaceId"]),
    tool("search_text", "Search text in bounded workspace files.", { workspaceId: { type: "string" }, query: { type: "string" }, path: { type: "string" }, maxResults: { type: "number" } }, ["workspaceId", "query"]),
    tool("search_text_page", "Search text with stable bounded paging and continuation metadata.", { workspaceId: { type: "string" }, query: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, maxResults: { type: "number" } }, ["workspaceId", "query"]),
    tool("search_files", "Discover bounded file and directory paths by name, skipping common dependency/build directories.", { workspaceId: { type: "string" }, query: { type: "string" }, path: { type: "string" }, offset: { type: "number" }, maxResults: { type: "number" } }, ["workspaceId", "query"]),
    tool("file_info", "Return metadata and hash for a workspace-relative path.", { workspaceId: { type: "string" }, path: { type: "string" } }, ["workspaceId", "path"]),
    tool("write_file", "Create or overwrite a UTF-8 file with hash-checked reversible recovery.", { workspaceId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, expectedSha256: { type: "string" } }, ["workspaceId", "path", "content"]),
    tool("apply_patch", "Apply an atomic bounded unified patch to workspace files.", { workspaceId: { type: "string" }, patch: { type: "string" } }, ["workspaceId", "patch"]),
    tool("directory_create", "Create a directory inside a registered workspace.", { workspaceId: { type: "string" }, path: { type: "string" } }, ["workspaceId", "path"]),
    tool("command_run", "Run a bounded structured executable and argument array inside a project workspace and return bounded output.", { workspaceId: { type: "string" }, executable: { type: "string" }, args: { type: "array", maxItems: 128, items: { type: "string" } }, cwd: { type: "string" }, env: { type: "object", additionalProperties: { type: "string" } }, timeoutSeconds: { type: "number" } }, ["workspaceId", "executable"]),
    tool("git_status", "Read Git status for the selected workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_diff", "Read the current Git diff.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_diff_check", "Check the working-tree diff for whitespace errors without modifying files.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_log", "Read recent Git history.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_show", "Read a bounded Git ref summary.", { workspaceId: { type: "string" }, ref: { type: "string" } }, ["workspaceId"]),
    tool("git_init", "Initialize Git metadata in a project workspace.", { workspaceId: { type: "string" } }, ["workspaceId"]),
    tool("git_add", "Stage existing workspace files using validated relative paths; deletions and directories are not staged.", { workspaceId: { type: "string" }, paths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } }, ["workspaceId", "paths"]),
    tool("git_stage", "Stage existing workspace files using validated relative paths; deletions and directories are not staged.", { workspaceId: { type: "string" }, paths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } }, ["workspaceId", "paths"]),
    tool("git_create_branch", "Create and switch to a new Git branch without shell parsing.", { workspaceId: { type: "string" }, branchName: { type: "string" } }, ["workspaceId", "branchName"]),
    tool("git_checkout", "Switch to an existing Git branch without force or discard flags.", { workspaceId: { type: "string" }, branchName: { type: "string" } }, ["workspaceId", "branchName"]),
    tool("git_commit", "Create a Git commit from the current index using a message argument (no shell parsing).", { workspaceId: { type: "string" }, message: { type: "string" } }, ["workspaceId", "message"]),
    ...(["test", "lint", "typecheck", "build", "dev"] as const).map((name) => tool(`project_${name}`, `Run the configured ${name} project command.`, { workspaceId: { type: "string" }, timeoutSeconds: { type: "number" } }, ["workspaceId"])),
    tool("process_list", "List managed processes and bounded logs.", {}),
    tool("process_read", "Read one managed process snapshot; use process_read_output for bounded logs.", { processId: { type: "string" } }, ["processId"]),
    tool("process_read_output", "Read a bounded page from retained stdout or stderr using a logical output offset.", { processId: { type: "string" }, stream: { type: "string", enum: ["stdout", "stderr"] }, offset: { type: "number" }, maxChars: { type: "number" } }, ["processId", "stream"]),
    tool("process_start", "Start a long-running managed executable with structured arguments inside a project workspace.", { workspaceId: { type: "string" }, executable: { type: "string" }, args: { type: "array", maxItems: 128, items: { type: "string" } }, cwd: { type: "string" }, env: { type: "object", additionalProperties: { type: "string" } }, timeoutSeconds: { type: "number" } }, ["workspaceId", "executable"]),
    tool("process_write", "Write bounded stdin to a process created by process_start or another managed project command.", { processId: { type: "string" }, input: { type: "string" } }, ["processId", "input"]),
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
        case "workspace_add": result = await runtime.addWorkspaceFromMcp(args); break;
        case "workspace_register": result = await runtime.registerWorkspaceFromMcp(args); break;
        case "workspace_create": result = await runtime.createWorkspaceFromMcp(args); break;
        case "workspace_refresh": result = await runtime.refreshWorkspaceFromMcp(args); break;
        case "workspace_select": { const input = WorkspaceIdInput.parse(args); result = await runtime.selectWorkspace(input.workspaceId); break; }
        case "workspace_current": result = runtime.workspaceCurrent(); break;
        case "workspace_info": { const input = WorkspaceIdInput.parse(args); result = runtime.workspaceInfo(input.workspaceId); break; }
        case "workspace_tree": { const input = WorkspaceIdInput.parse(args); result = await runtime.workspaceTree(input.workspaceId); break; }
        case "workspace_snapshot": { const input = WorkspaceIdInput.parse(args); result = await runtime.workspaceSnapshot(input.workspaceId); break; }
        case "read_file": { const input = ReadFileInput.parse(args); result = await runtime.readFile(input.workspaceId, input.path, input.offset, input.limit); break; }
        case "read_many_files": result = await runtime.readManyFiles(ReadManyFilesInput.parse(args)); break;
        case "list_directory": { const input = WorkspaceIdInput.parse(args); result = await runtime.listDirectory(input.workspaceId, typeof args.path === "string" ? args.path : "."); break; }
        case "list_directory_page": result = await runtime.listDirectoryPage(ListDirectoryPageInput.parse(args)); break;
        case "search_text": { const input = SearchInput.parse(args); result = await runtime.search(input.workspaceId, input.query, input.path, input.maxResults); break; }
        case "search_text_page": result = await runtime.searchTextPage(SearchTextPageInput.parse(args)); break;
        case "search_files": result = await runtime.searchFiles(SearchFilesInput.parse(args)); break;
        case "file_info": { const input = RelativePathInput.parse(args); result = await runtime.fileInfo(input.workspaceId, input.path); break; }
        case "write_file": result = await runtime.writeFile(WriteFileInput.parse(args)); break;
        case "apply_patch": result = await runtime.applyPatch(args); break;
        case "directory_create": result = await runtime.directoryCreate(args); break;
        case "command_run": result = await runtime.commandRun(args); break;
        case "git_status": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitStatus(input.workspaceId); break; }
        case "git_diff": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitDiff(input.workspaceId); break; }
        case "git_diff_check": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitDiffCheck(input.workspaceId); break; }
        case "git_log": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitLog(input.workspaceId); break; }
        case "git_show": { const input = WorkspaceIdInput.parse(args); result = await runtime.gitShow(input.workspaceId, typeof args.ref === "string" ? args.ref : undefined); break; }
        case "git_init": result = await runtime.gitInit(args); break;
        case "git_add": result = await runtime.gitAdd(args); break;
        case "git_stage": result = await runtime.gitStage(GitStageInput.parse(args)); break;
        case "git_create_branch": result = await runtime.gitCreateBranch(GitCreateBranchInput.parse(args)); break;
        case "git_checkout": result = await runtime.gitCheckout(GitCheckoutInput.parse(args)); break;
        case "git_commit": result = await runtime.gitCommit(GitCommitInput.parse(args)); break;
        case "project_test": result = await runtime.projectCommand("test", ProjectCommandInput.parse(args)); break;
        case "project_lint": result = await runtime.projectCommand("lint", ProjectCommandInput.parse(args)); break;
        case "project_typecheck": result = await runtime.projectCommand("typecheck", ProjectCommandInput.parse(args)); break;
        case "project_build": result = await runtime.projectCommand("build", ProjectCommandInput.parse(args)); break;
        case "project_dev": result = await runtime.projectCommand("dev", ProjectCommandInput.parse(args)); break;
        case "process_list": result = runtime.processList(); break;
        case "process_read": { const input = ProcessIdInput.parse(args); result = runtime.processRead(input.processId); break; }
        case "process_read_output": result = runtime.processReadOutput(ProcessReadOutputInput.parse(args)); break;
        case "process_start": result = await runtime.processStart(args); break;
        case "process_write": result = await runtime.processWrite(args); break;
        case "process_stop": { const input = ProcessIdInput.parse(args); result = await runtime.processStop(input.processId); break; }
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

export async function startHttpServer(runtime: AgentRuntime, port = 43123, adminToken?: string) {
  const http = createServer((request, response) => {
    if (request.url === "/healthz") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, service: "codex-beg-agent-host", version: AGENT_HOST_VERSION, toolCount: TOOL_NAMES.length, toolCatalogHash: TOOL_CATALOG_HASH })); return; }
    if (requiresAdminAuth(request.url) && !adminAuthorized(request, adminToken)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized admin request." }));
      return;
    }
    if (request.url?.startsWith("/events")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.events.recent())); return; }
    if (request.url === "/admin/activity" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.activityList())); return; }
    if (request.url === "/admin/state" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.workspaceList())); return; }
    if (request.url === "/admin/approvals" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.approvalsList())); return; }
    if (request.url === "/admin/operations" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.operationList())); return; }
    if (request.url === "/admin/recovery" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(runtime.recoveryList())); return; }
    if (request.url?.startsWith("/admin/approval/") && request.method === "POST") {
      const parts = request.url.split("/"); const action = parts.at(-2); const id = parts.at(-1) ?? "";
      void Promise.resolve(action === "approve" ? runtime.approvalApprove(id) : action === "reject" ? runtime.approvalReject(id) : (() => { throw new CodexBegError("INVALID_APPROVAL_ACTION", "Unsupported approval action."); })()).then((value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
      return;
    }
    if (request.url?.startsWith("/admin/recovery/restore/") && request.method === "POST") { const id = request.url.split("/").pop() ?? ""; void Promise.resolve(runtime.recoveryRestore(id)).then((value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url === "/admin/workspace/add" && request.method === "POST") { void readJson(request).then(async (body) => { const input = WorkspaceAddInput.parse(body); const workspace = await runtime.addWorkspace(input.rootPath, input.displayName, input.kind); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(workspace)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url === "/admin/workspace/register" && request.method === "POST") { void readJson(request).then(async (body) => { const input = WorkspaceRegisterInput.parse(body); const workspace = await runtime.registerWorkspace(input.parentWorkspaceId, input.path, input.displayName); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(workspace)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url === "/admin/workspace/select" && request.method === "POST") { void readJson(request).then(async (body) => { const workspace = await runtime.selectWorkspace(String(body.workspaceId)); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(workspace)); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url?.startsWith("/admin/workspace/remove/") && request.method === "POST") { const id = request.url.split("/").pop() ?? ""; void runtime.removeWorkspace(id).then(() => { response.writeHead(204); response.end(); }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }); return; }
    if (request.url !== "/mcp") { response.writeHead(404); response.end("Not found"); return; }
    void handleMcpRequest(runtime, request, response).catch((error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => resolve()); });
  return http;
}
