import { applyPatch } from "diff";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EventBus } from "./events.js";
import { ApprovalManager, PolicyEngine } from "./policy.js";
import { AuditLog, JsonStore, ensureDir } from "./persistence.js";
import { RecoveryManager } from "./recovery.js";
import { WorkspaceManager } from "./workspace.js";
import { GitService } from "./git.js";
import { ProcessManager } from "./process-manager.js";
import { getProjectCommand } from "./project-adapters.js";
import { resolveExecutable } from "./executable-resolution.js";
import { ApprovalRequiredError, CodexBegError, StaleFileError } from "./errors.js";
import type { ApprovalRequest, CommandName, OperationClass, OperationRecord, OperationRequest, ProcessSnapshot, ReadFileResult, ReadManyFilesResult, RecoveryManifest, RegistryState, SearchFilesResult, Workspace, WorkspaceKind } from "./types.js";
import { ApplyPatchInput, GitCommitInput, GitStageInput, ListDirectoryPageInput, ProcessReadOutputInput, ProjectCommandInput, ReadManyFilesInput, SearchFilesInput, SearchInput, SearchTextPageInput, WorkspaceAddInput, WorkspaceRegisterInput, WriteFileInput } from "./types.js";

interface OperationStore { schemaVersion: 1; operations: OperationRecord[] }
const EMPTY_OPERATIONS: OperationStore = { schemaVersion: 1, operations: [] };
const OPERATION_HISTORY_LIMIT = 1000;
function isUtf8Continuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }
function utf8SequenceLength(byte: number): number { if (byte <= 0x7f) return 1; if ((byte & 0xe0) === 0xc0) return 2; if ((byte & 0xf0) === 0xe0) return 3; if ((byte & 0xf8) === 0xf0) return 4; return 0; }
function incompleteUtf8SuffixLength(bytes: Buffer): number { if (!bytes.length) return 0; let index = bytes.length - 1; while (index >= 0 && isUtf8Continuation(bytes[index]!) && bytes.length - index <= 4) index -= 1; if (index < 0) return 0; const expected = utf8SequenceLength(bytes[index]!); const actual = bytes.length - index; return expected > 1 && actual < expected ? actual : 0; }

export class AgentRuntime {
  readonly events: EventBus;
  readonly workspaces: WorkspaceManager;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalManager;
  readonly processes: ProcessManager;
  readonly git: GitService;
  readonly recovery: RecoveryManager;
  private operations: OperationStore = EMPTY_OPERATIONS;
  private readonly pending = new Map<string, { request: OperationRequest; action: () => Promise<unknown>; options: { recoveryPaths?: string[]; approvalAction?: string } }>();

  constructor(private readonly dataDirectory: string) {
    this.events = new EventBus();
    const audit = new AuditLog(join(dataDirectory, "audit"));
    this.events.on((event) => { void audit.append(event).catch((error: unknown) => console.error("Codex BEG audit append failed:", error)); });
    this.workspaces = new WorkspaceManager(new JsonStore<RegistryState>(join(dataDirectory, "registry.json"), { schemaVersion: 1, workspaces: [], currentWorkspaceId: null }), this.events);
    this.policy = new PolicyEngine(this.events);
    this.approvals = new ApprovalManager();
    this.processes = new ProcessManager(this.events);
    this.git = new GitService(this.processes);
    this.recovery = new RecoveryManager(join(dataDirectory, "recovery"), new JsonStore(join(dataDirectory, "recovery", "index.json"), { schemaVersion: 1, operations: [] }), this.workspaces);
  }

  async init(): Promise<void> {
    await ensureDir(this.dataDirectory);
    await this.workspaces.init();
    await this.recovery.init();
    this.operations = await new JsonStore<OperationStore>(join(this.dataDirectory, "operations.json"), EMPTY_OPERATIONS).load();
    const interrupted = this.operations.operations.filter((record) => ["pending", "running", "approval_required"].includes(record.status));
    if (interrupted.length) {
      const now = new Date().toISOString();
      for (const record of interrupted) {
        record.status = "interrupted";
        record.error = "Agent Host restarted before the operation completed; rerun the operation if it is still needed.";
        record.updatedAt = now;
        this.events.emit("operation.interrupted", { operationId: record.operationId, kind: record.kind });
      }
      await this.saveOperations();
    }
  }

  private async saveOperations(): Promise<void> { this.pruneOperations(); await new JsonStore<OperationStore>(join(this.dataDirectory, "operations.json"), EMPTY_OPERATIONS).save(this.operations); }
  private pruneOperations(): void { const activeStatuses = new Set<OperationRecord["status"]>(["pending", "running", "approval_required"]); const terminal = this.operations.operations.filter((record) => !activeStatuses.has(record.status)).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)); if (terminal.length <= OPERATION_HISTORY_LIMIT) return; const retainedTerminal = new Set(terminal.slice(0, OPERATION_HISTORY_LIMIT).map((record) => record.operationId)); this.operations.operations = this.operations.operations.filter((record) => activeStatuses.has(record.status) || retainedTerminal.has(record.operationId)); }
  private createOperation(kind: string, workspaceId: string): OperationRecord {
    const record: OperationRecord = { operationId: randomUUID(), kind, status: "pending", workspaceId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.operations.operations.push(record);
    return record;
  }
  operationGet(operationId: string): OperationRecord { const value = this.operations.operations.find((item) => item.operationId === operationId); if (!value) throw new CodexBegError("OPERATION_NOT_FOUND", `Unknown operation: ${operationId}`); return structuredClone(value); }
  approvalsList(): ApprovalRequest[] { return this.approvals.list(); }
  async approvalApprove(id: string): Promise<ApprovalRequest> {
    const value = this.approvals.approve(id);
    const record = this.operations.operations.find((item) => item.approvalId === id);
    if (record) { record.updatedAt = new Date().toISOString(); await this.saveOperations(); }
    const pending = this.pending.get(value.operationId);
    if (pending) {
      this.pending.delete(value.operationId);
      try {
        this.policy.enforce(pending.request, value);
        await this.execute(pending.request, pending.action, pending.options);
      } catch (error) {
        const item = this.operations.operations.find((entry) => entry.operationId === value.operationId);
        if (item && item.status !== "failed") {
          item.status = "failed";
          item.error = error instanceof Error ? error.message : String(error);
          item.updatedAt = new Date().toISOString();
          await this.saveOperations();
        }
        throw error;
      }
    }
    return value;
  }
  async approvalReject(id: string): Promise<ApprovalRequest> { const value = this.approvals.reject(id); const record = this.operations.operations.find((item) => item.approvalId === id); if (record) { record.status = "rejected"; record.updatedAt = new Date().toISOString(); await this.saveOperations(); } this.pending.delete(value.operationId); return value; }

  private request(workspaceId: string, kind: string, targets: OperationRequest["targets"], executable?: string, args?: string[]): OperationRequest {
    const operation = this.createOperation(kind, workspaceId);
    const request: OperationRequest = { operationId: operation.operationId, source: "mcp", workspaceId, kind, targets, createdAt: operation.createdAt };
    if (executable !== undefined) request.executable = executable;
    if (args !== undefined) request.arguments = args;
    return request;
  }

  private async execute<T>(request: OperationRequest, action: () => Promise<T>, options: { recoveryPaths?: string[]; approvalAction?: string } = {}): Promise<T> {
    const record = this.operations.operations.find((item) => item.operationId === request.operationId)!;
    try {
      if (options.recoveryPaths?.length) await this.recovery.capture(request.operationId, request.workspaceId, options.recoveryPaths);
      record.status = "running"; record.updatedAt = new Date().toISOString(); await this.saveOperations();
      const result = await action();
      record.status = "succeeded"; record.result = result; record.updatedAt = new Date().toISOString(); await this.saveOperations();
      this.events.emit("tool.completed", { operationId: request.operationId, kind: request.kind });
      return result;
    } catch (error) {
      if (error instanceof ApprovalRequiredError) throw error;
      record.status = "failed"; record.error = error instanceof Error ? error.message : String(error); record.updatedAt = new Date().toISOString(); await this.saveOperations();
      this.events.emit("tool.failed", { operationId: request.operationId, kind: request.kind, error: record.error });
      throw error;
    }
  }

  private async run<T>(request: OperationRequest, action: () => Promise<T>, options: { recoveryPaths?: string[]; approvalAction?: string } = {}): Promise<T> {
    try {
      this.policy.enforce(request);
    } catch (error) {
      if (!(error instanceof ApprovalRequiredError)) throw error;
      const details = error.details as { operationHash: string; classification: OperationClass };
      const exactOperation = request.executable ? `${request.executable} ${(request.arguments ?? []).join(" ")}`.trim() : request.targets.length ? `${request.kind} ${request.targets.map((target) => target.path).join(" ")}` : request.kind;
      const risk = details.classification === "CAPABILITY_GRANT" ? "This operation expands the agent's local workspace or runnable-project access." : "The operation can alter or destroy local data.";
      const approval = this.approvals.create(request, options.approvalAction ?? request.kind, exactOperation, risk, details.classification);
      const record = this.operations.operations.find((item) => item.operationId === request.operationId)!;
      record.status = "approval_required"; record.approvalId = approval.approvalId; record.updatedAt = new Date().toISOString();
      this.pending.set(request.operationId, { request, action: action as () => Promise<unknown>, options });
      await this.saveOperations();
      throw new ApprovalRequiredError({ ...details, approval });
    }
    return this.execute(request, action, options);
  }

  async addWorkspace(rootPath: string, displayName?: string, kind?: WorkspaceKind): Promise<Workspace> { return this.workspaces.add(rootPath, displayName, kind); }
  async registerWorkspace(parentWorkspaceId: string, path: string, displayName?: string): Promise<Workspace> { return this.workspaces.register(parentWorkspaceId, path, displayName); }
  async addWorkspaceFromMcp(input: unknown): Promise<Workspace> {
    const args = WorkspaceAddInput.parse(input);
    const request = this.request("workspace-registry", "workspace_add", [{ path: args.rootPath }]);
    return this.run(request, () => this.workspaces.add(args.rootPath, args.displayName, args.kind), { approvalAction: "grant workspace access" });
  }
  async registerWorkspaceFromMcp(input: unknown): Promise<Workspace> {
    const args = WorkspaceRegisterInput.parse(input);
    const request = this.request(args.parentWorkspaceId, "workspace_register", [{ path: args.path }]);
    return this.run(request, () => this.workspaces.register(args.parentWorkspaceId, args.path, args.displayName), { approvalAction: "grant child project access" });
  }
  async selectWorkspace(workspaceId: string): Promise<Workspace> { return this.workspaces.select(workspaceId); }
  async removeWorkspace(workspaceId: string): Promise<void> { await this.workspaces.remove(workspaceId); }
  workspaceList(): RegistryState { return this.workspaces.getState(); }
  workspaceCurrent(): Workspace | null { return this.workspaces.current(); }
  workspaceInfo(workspaceId: string): Workspace { return this.workspaces.require(workspaceId); }
  workspaceTree(workspaceId: string) { return this.workspaces.tree(workspaceId); }
  workspaceSnapshot(workspaceId: string) { return this.workspaces.snapshot(workspaceId); }
  readFile(workspaceId: string, path: string, offset = 0, limit = 128 * 1024) { return this.readFileInternal(workspaceId, path, offset, Math.min(limit, 512 * 1024)); }
  private async readFileInternal(workspaceId: string, path: string, offset: number, limit: number): Promise<ReadFileResult> {
    const resolved = await this.workspaces.resolvePath(workspaceId, path);
    const hash = createHash("sha256");
    const captured: Buffer[] = [];
    const requestedEnd = offset + limit;
    let totalBytes = 0;
    let bytesReturned = 0;
    let binary = false;
    for await (const chunk of createReadStream(resolved.absolute)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      if (buffer.includes(0)) binary = true;
      const chunkStart = totalBytes;
      const chunkEnd = chunkStart + buffer.length;
      const readStart = Math.max(offset, chunkStart);
      const readEnd = Math.min(requestedEnd, chunkEnd);
      if (readEnd > readStart) {
        const slice = buffer.subarray(readStart - chunkStart, readEnd - chunkStart);
        captured.push(slice);
        bytesReturned += slice.length;
      }
      totalBytes = chunkEnd;
    }
    if (binary) throw new CodexBegError("BINARY_FILE", "Binary files are not returned as text.");
    const raw = Buffer.concat(captured, bytesReturned);
    if (offset > 0 && raw.length > 0 && isUtf8Continuation(raw[0]!)) throw new CodexBegError("UTF8_OFFSET_BOUNDARY", "Read offset falls inside a UTF-8 code point.");
    const incompleteSuffix = incompleteUtf8SuffixLength(raw);
    const complete = incompleteSuffix > 0 ? raw.subarray(0, raw.length - incompleteSuffix) : raw;
    if (raw.length > 0 && complete.length === 0) throw new CodexBegError("UTF8_READ_LIMIT_TOO_SMALL", "Read limit is too small to return a complete UTF-8 code point.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(complete); } catch { throw new CodexBegError("INVALID_UTF8", "File content is not valid UTF-8 text."); }
    bytesReturned = complete.length;
    const nextOffset = offset + bytesReturned < totalBytes ? offset + bytesReturned : null;
    return { path: resolved.relativePath, content, offset, bytesReturned, totalBytes, truncated: nextOffset !== null, nextOffset, sha256: hash.digest("hex") };
  }
  async readManyFiles(input: unknown): Promise<ReadManyFilesResult> {
    const args = ReadManyFilesInput.parse(input);
    const results: ReadManyFilesResult["files"] = [];
    let remaining = args.maxTotalBytes;
    let totalBytesReturned = 0;
    let truncated = false;
    for (const file of args.files) {
      try {
        if (file.knownSha256) {
          const info = await this.fileInfo(args.workspaceId, file.path);
          if (info.kind === "file" && info.sha256 === file.knownSha256) {
            results.push({ path: info.path, offset: file.offset, bytesReturned: 0, totalBytes: info.size, truncated: false, nextOffset: null, sha256: info.sha256, unchanged: true });
            continue;
          }
        }
        if (remaining <= 0) {
          results.push({ path: file.path, error: { code: "TOTAL_BUDGET_EXCEEDED", message: "The total read budget has been exhausted." } });
          truncated = true;
          continue;
        }
        const limit = Math.min(file.limit, remaining);
        const result = await this.readFileInternal(args.workspaceId, file.path, file.offset, limit);
        results.push({ ...result, unchanged: false });
        totalBytesReturned += result.bytesReturned;
        remaining -= result.bytesReturned;
        if (result.truncated || limit < file.limit) truncated = true;
      } catch (error) {
        const code = error instanceof CodexBegError ? error.code : (error as NodeJS.ErrnoException).code ?? "READ_FAILED";
        results.push({ path: file.path, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
    }
    return { files: results, totalBytesReturned, maxTotalBytes: args.maxTotalBytes, truncated };
  }
  async listDirectory(workspaceId: string, path = ".") { const resolved = await this.workspaces.resolvePath(workspaceId, path); return (await (await import("node:fs/promises")).readdir(resolved.absolute, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" })).sort((left, right) => left.name.localeCompare(right.name)); }
  async listDirectoryPage(input: unknown) {
    const args = ListDirectoryPageInput.parse(input);
    const all = await this.listDirectory(args.workspaceId, args.path);
    const items = all.slice(args.offset, args.offset + args.maxResults);
    const truncated = args.offset + items.length < all.length;
    return { items, truncated, nextOffset: truncated ? args.offset + items.length : null };
  }
  search(workspaceId: string, query: string, path?: string, maxResults = 200) { return this.workspaces.search(workspaceId, query, path, maxResults); }
  async searchTextPage(input: unknown) {
    const args = SearchTextPageInput.parse(input);
    return this.workspaces.searchTextPage(args.workspaceId, args.query, args.path, args.offset, args.maxResults);
  }
  async searchFiles(input: unknown): Promise<SearchFilesResult> {
    const args = SearchFilesInput.parse(input);
    return this.workspaces.searchFiles(args.workspaceId, args.query, args.path, args.offset, args.maxResults);
  }
  async fileInfo(workspaceId: string, path: string) {
    const resolved = await this.workspaces.resolvePath(workspaceId, path);
    const info = await stat(resolved.absolute);
    const result: { path: string; size: number; modifiedAt: string; kind: "directory" | "file"; sha256?: string } = { path: resolved.relativePath, size: info.size, modifiedAt: info.mtime.toISOString(), kind: info.isDirectory() ? "directory" : "file" };
    if (info.isFile()) result.sha256 = await this.workspaces.sha256(resolved.absolute);
    return result;
  }

  async writeFile(input: unknown): Promise<{ operationId: string; change: RecoveryManifest }> {
    const args = WriteFileInput.parse(input); const resolved = await this.workspaces.resolvePath(args.workspaceId, args.path, true);
    const existed = await access(resolved.absolute).then(() => true).catch(() => false);
    if (existed && !args.expectedSha256) throw new StaleFileError(args.path);
    if (existed && args.expectedSha256 && (await this.workspaces.sha256(resolved.absolute)) !== args.expectedSha256) throw new StaleFileError(args.path);
    const target = args.expectedSha256 ? { path: args.path, expectedSha256: args.expectedSha256 } : { path: args.path };
    const request = this.request(args.workspaceId, "write_file", [target]);
    try {
      return await this.run(request, async () => { await this.recovery.capture(request.operationId, args.workspaceId, [args.path]); await ensureDir(dirname(resolved.absolute)); const temp = `${resolved.absolute}.${request.operationId}.tmp`; try { await writeFile(temp, args.content, "utf8"); await rename(temp, resolved.absolute); } catch (error) { await unlink(temp).catch(() => undefined); await this.recovery.rollback(request.operationId).catch(() => undefined); throw error; } const after = new Map([[args.path, await this.workspaces.sha256(resolved.absolute)]]); return { operationId: request.operationId, change: await this.recovery.markApplied(request.operationId, after) }; });
    } catch (error) { throw error; }
  }

  async applyPatch(input: unknown): Promise<{ operationId: string; change: RecoveryManifest }> {
    const args = ApplyPatchInput.parse(input); const filePatches = args.patch.split(/(?=^--- )/m).filter((part) => part.trim());
    const edits: Array<{ path: string; content: string }> = [];
    if (filePatches.length > 50) throw new CodexBegError("INVALID_PATCH", "Patch may contain at most 50 files.");
    for (const patch of filePatches) {
      const oldLine = patch.match(/^--- (?:a\/)?(.+)$/m)?.[1]; const newLine = patch.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
      const path = newLine && newLine !== "/dev/null" ? newLine.trim() : oldLine?.trim(); if (!path || path === "/dev/null") throw new CodexBegError("INVALID_PATCH", "Patch must target a workspace file.");
      const resolved = await this.workspaces.resolvePath(args.workspaceId, path); const original = await readFile(resolved.absolute, "utf8"); const next = applyPatch(original, patch); if (next === false) throw new CodexBegError("INVALID_PATCH", `Patch did not apply cleanly: ${path}`); edits.push({ path, content: next });
    }
    const request = this.request(args.workspaceId, "apply_patch", edits.map((edit) => ({ path: edit.path })));
    return this.run(request, async () => { await this.recovery.capture(request.operationId, args.workspaceId, edits.map((edit) => edit.path)); const hashes = new Map<string, string>(); const temps: string[] = []; try { for (const edit of edits) { const resolved = await this.workspaces.resolvePath(args.workspaceId, edit.path); const temp = `${resolved.absolute}.${request.operationId}-${temps.length}.tmp`; temps.push(temp); await writeFile(temp, edit.content, "utf8"); } for (const [index, edit] of edits.entries()) { const resolved = await this.workspaces.resolvePath(args.workspaceId, edit.path); const temp = temps[index]; if (!temp) throw new CodexBegError("INVALID_PATCH", "Patch staging failed."); await rename(temp, resolved.absolute); hashes.set(edit.path, await this.workspaces.sha256(resolved.absolute)); } } catch (error) { await Promise.all(temps.map((temp) => unlink(temp).catch(() => undefined))); await this.recovery.rollback(request.operationId).catch(() => undefined); throw error; } return { operationId: request.operationId, change: await this.recovery.markApplied(request.operationId, hashes) }; });
  }

  async projectCommand(name: CommandName, input: unknown): Promise<ProcessSnapshot> {
    const args = ProjectCommandInput.parse(input);
    const workspace = this.workspaces.requireProject(args.workspaceId);
    const command = getProjectCommand(workspace, name);
    const resolved = await resolveExecutable(command.executable, { cwd: workspace.canonicalRoot, projectRoot: workspace.canonicalRoot });
    const commandArgs = [...resolved.argsPrefix, ...command.args];
    const policyArgs = command.script ? [...commandArgs, "--script", command.script] : commandArgs;
    const request = this.request(args.workspaceId, `project_${name}`, [], resolved.executable, policyArgs);
    const timeout = args.timeoutSeconds ?? command.timeoutSeconds ?? (name === "dev" ? 0 : 600);
    return this.run(request, async () => { const process = this.processes.start(args.workspaceId, workspace.canonicalRoot, resolved.executable, commandArgs, timeout, name === "dev"); return name === "dev" ? process : this.processes.wait(process.processId); }, { approvalAction: `${name} project command` });
  }
  processList() { return this.processes.list(); }
  processRead(processId: string) { return this.processes.get(processId); }
  processReadOutput(input: unknown) { const args = ProcessReadOutputInput.parse(input); return this.processes.readOutput(args.processId, args.stream, args.offset, args.maxChars); }
  async processStop(processId: string) { const snapshot = this.processes.get(processId); const request = this.request(snapshot.workspaceId, "process_stop", [], snapshot.executable, snapshot.arguments); return this.run(request, () => this.processes.stop(processId)); }
  private async requireBoundedGitProject(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.requireProject(workspaceId);
    const repository = await this.git.root(workspaceId, workspace.canonicalRoot);
    if (repository.exitCode !== 0) throw new CodexBegError("GIT_REPOSITORY_REQUIRED", "Git operations require the requested project workspace to be a Git repository.");
    const repositoryRoot = repository.output.trim().split(/\r?\n/).at(-1)?.trim();
    const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (!repositoryRoot || normalize(repositoryRoot) !== normalize(workspace.canonicalRoot)) throw new CodexBegError("GIT_WORKSPACE_BOUNDARY", "Git operations cannot use an ancestor repository outside the project workspace boundary.");
    return workspace;
  }
  async gitStatus(workspaceId: string) { const workspace = await this.requireBoundedGitProject(workspaceId); const request = this.request(workspaceId, "git_status", []); return this.run(request, () => this.git.status(workspaceId, workspace.canonicalRoot)); }
  async gitDiff(workspaceId: string) { const workspace = await this.requireBoundedGitProject(workspaceId); const request = this.request(workspaceId, "git_diff", []); return this.run(request, () => this.git.diff(workspaceId, workspace.canonicalRoot)); }
  async gitDiffCheck(workspaceId: string) { const workspace = await this.requireBoundedGitProject(workspaceId); const request = this.request(workspaceId, "git_diff_check", []); return this.run(request, () => this.git.diffCheck(workspaceId, workspace.canonicalRoot)); }
  async gitLog(workspaceId: string) { const workspace = await this.requireBoundedGitProject(workspaceId); const request = this.request(workspaceId, "git_log", []); return this.run(request, () => this.git.log(workspaceId, workspace.canonicalRoot)); }
  async gitShow(workspaceId: string, ref?: string) { const workspace = await this.requireBoundedGitProject(workspaceId); const request = this.request(workspaceId, "git_show", [], "git", ref ? ["show", "--stat", ref] : ["show", "--stat", "HEAD"]); return this.run(request, () => this.git.show(workspaceId, workspace.canonicalRoot, ref)); }
  async gitStage(input: unknown) {
    const args = GitStageInput.parse(input);
    const workspace = await this.requireBoundedGitProject(args.workspaceId);
    const paths: string[] = [];
    for (const requestedPath of args.paths) {
      const resolved = await this.workspaces.resolvePath(args.workspaceId, requestedPath);
      const info = await stat(resolved.absolute);
      if (!info.isFile()) throw new CodexBegError("GIT_STAGE_FILE_REQUIRED", `git_stage only stages existing files: ${requestedPath}`);
      paths.push(resolved.relativePath.replaceAll("\\", "/"));
    }
    const uniquePaths = [...new Set(paths)];
    const request = this.request(args.workspaceId, "git_stage", uniquePaths.map((path) => ({ path })), "git", ["add", "--", ...uniquePaths]);
    return this.run(request, () => this.git.stage(args.workspaceId, workspace.canonicalRoot, uniquePaths));
  }
  async gitCommit(input: unknown) {
    const args = GitCommitInput.parse(input);
    const workspace = await this.requireBoundedGitProject(args.workspaceId);
    const request = this.request(args.workspaceId, "git_commit", [], "git", ["commit", "-m", args.message]);
    return this.run(request, () => this.git.commit(args.workspaceId, workspace.canonicalRoot, args.message));
  }
  recoveryRestore(operationId: string) {
    const manifest = this.recovery.get(operationId);
    if (!manifest) throw new CodexBegError("RECOVERY_NOT_FOUND", `Unknown recovery operation: ${operationId}`);
    const deletesCreatedFile = manifest.changes.some((change) => !change.existed);
    const targets = manifest.changes.map((change) => change.afterSha256 ? { path: change.path, expectedSha256: change.afterSha256 } : { path: change.path });
    const request = this.request(manifest.workspaceId, deletesCreatedFile ? "operation_restore_delete" : "operation_restore", targets);
    return this.run(request, () => this.recovery.restore(operationId), { approvalAction: "restore workspace changes" });
  }
  operationList(limit = 100): OperationRecord[] { const max = Math.min(Math.max(limit, 1), 500); return structuredClone([...this.operations.operations].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, max)); }
  recoveryList(limit = 100): RecoveryManifest[] { return this.recovery.list(limit); }
  async shutdown(): Promise<void> { await this.processes.stopAll(); }
}
