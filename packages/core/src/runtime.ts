import { applyPatch } from "diff";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EventBus } from "./events.js";
import { ApprovalManager, PolicyEngine } from "./policy.js";
import { AuditLog, JsonStore, ensureDir } from "./persistence.js";
import { RecoveryManager } from "./recovery.js";
import { WorkspaceManager } from "./workspace.js";
import { GitService } from "./git.js";
import { ProcessManager } from "./process-manager.js";
import { getProjectCommand } from "./project-adapters.js";
import { ApprovalRequiredError, CodexBegError, StaleFileError } from "./errors.js";
import type { ApprovalRequest, CommandName, OperationRecord, OperationRequest, ProcessSnapshot, RecoveryManifest, RegistryState, Workspace } from "./types.js";
import { ApplyPatchInput, ProjectCommandInput, SearchInput, WriteFileInput } from "./types.js";

interface OperationStore { schemaVersion: 1; operations: OperationRecord[] }
const EMPTY_OPERATIONS: OperationStore = { schemaVersion: 1, operations: [] };

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
    this.events.on((event) => { void audit.append(event); });
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
  }

  private async saveOperations(): Promise<void> { await new JsonStore<OperationStore>(join(this.dataDirectory, "operations.json"), EMPTY_OPERATIONS).save(this.operations); }
  private createOperation(kind: string, workspaceId: string): OperationRecord {
    const record: OperationRecord = { operationId: randomUUID(), kind, status: "pending", workspaceId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.operations.operations.push(record);
    return record;
  }
  operationGet(operationId: string): OperationRecord { const value = this.operations.operations.find((item) => item.operationId === operationId); if (!value) throw new CodexBegError("OPERATION_NOT_FOUND", `Unknown operation: ${operationId}`); return structuredClone(value); }
  approvalsList(): ApprovalRequest[] { return this.approvals.list(); }
  approvalApprove(id: string): ApprovalRequest {
    const value = this.approvals.approve(id);
    const record = this.operations.operations.find((item) => item.approvalId === id);
    if (record) { record.updatedAt = new Date().toISOString(); void this.saveOperations(); }
    const pending = this.pending.get(value.operationId);
    if (pending) {
      this.pending.delete(value.operationId);
      try { this.policy.enforce(pending.request, value); void this.execute(pending.request, pending.action, pending.options); }
      catch (error) { const item = this.operations.operations.find((entry) => entry.operationId === value.operationId); if (item) { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.updatedAt = new Date().toISOString(); void this.saveOperations(); } }
    }
    return value;
  }
  approvalReject(id: string): ApprovalRequest { const value = this.approvals.reject(id); const record = this.operations.operations.find((item) => item.approvalId === id); if (record) { record.status = "rejected"; record.updatedAt = new Date().toISOString(); void this.saveOperations(); } this.pending.delete(value.operationId); return value; }

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
      const details = error.details as { operationHash: string };
      const approval = this.approvals.create(request, options.approvalAction ?? request.kind, `${request.executable ?? request.kind} ${(request.arguments ?? []).join(" ")}`.trim(), "The operation can alter or destroy local data.");
      const record = this.operations.operations.find((item) => item.operationId === request.operationId)!;
      record.status = "approval_required"; record.approvalId = approval.approvalId; record.updatedAt = new Date().toISOString();
      this.pending.set(request.operationId, { request, action: action as () => Promise<unknown>, options });
      await this.saveOperations();
      throw new ApprovalRequiredError({ ...details, approval });
    }
    return this.execute(request, action, options);
  }

  async addWorkspace(rootPath: string, displayName?: string): Promise<Workspace> { return this.workspaces.add(rootPath, displayName); }
  async selectWorkspace(workspaceId: string): Promise<Workspace> { return this.workspaces.select(workspaceId); }
  async removeWorkspace(workspaceId: string): Promise<void> { await this.workspaces.remove(workspaceId); }
  workspaceList(): RegistryState { return this.workspaces.getState(); }
  workspaceCurrent(): Workspace | null { return this.workspaces.current(); }
  workspaceInfo(workspaceId: string): Workspace { return this.workspaces.require(workspaceId); }
  workspaceTree(workspaceId: string) { return this.workspaces.tree(workspaceId); }
  workspaceSnapshot(workspaceId: string) { return this.workspaces.snapshot(workspaceId); }
  readFile(workspaceId: string, path: string, offset = 0, limit = 128 * 1024) { return this.readFileInternal(workspaceId, path, offset, Math.min(limit, 512 * 1024)); }
  private async readFileInternal(workspaceId: string, path: string, offset: number, limit: number): Promise<{ path: string; content: string; truncated: boolean; sha256: string }> {
    const resolved = await this.workspaces.resolvePath(workspaceId, path);
    const bytes = await readFile(resolved.absolute);
    if (bytes.includes(0)) throw new CodexBegError("BINARY_FILE", "Binary files are not returned as text.");
    const slice = bytes.subarray(offset, offset + limit);
    return { path: resolved.relativePath, content: slice.toString("utf8"), truncated: offset + limit < bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async listDirectory(workspaceId: string, path = ".") { const resolved = await this.workspaces.resolvePath(workspaceId, path); return (await (await import("node:fs/promises")).readdir(resolved.absolute, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" })); }
  search(workspaceId: string, query: string, path?: string, maxResults = 200) { return this.workspaces.search(workspaceId, query, path, maxResults); }
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
      return await this.run(request, async () => { await this.recovery.capture(request.operationId, args.workspaceId, [args.path]); await ensureDir(dirname(resolved.absolute)); const temp = `${resolved.absolute}.${process.pid}.${Date.now()}.tmp`; try { await writeFile(temp, args.content, "utf8"); await rename(temp, resolved.absolute); } catch (error) { await unlink(temp).catch(() => undefined); await this.recovery.rollback(request.operationId).catch(() => undefined); throw error; } const after = new Map([[args.path, await this.workspaces.sha256(resolved.absolute)]]); return { operationId: request.operationId, change: await this.recovery.markApplied(request.operationId, after) }; });
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
    return this.run(request, async () => { await this.recovery.capture(request.operationId, args.workspaceId, edits.map((edit) => edit.path)); const hashes = new Map<string, string>(); const temps: string[] = []; try { for (const edit of edits) { const resolved = await this.workspaces.resolvePath(args.workspaceId, edit.path); const temp = `${resolved.absolute}.${process.pid}.${Date.now()}-${temps.length}.tmp`; temps.push(temp); await writeFile(temp, edit.content, "utf8"); } for (const [index, edit] of edits.entries()) { const resolved = await this.workspaces.resolvePath(args.workspaceId, edit.path); const temp = temps[index]; if (!temp) throw new CodexBegError("INVALID_PATCH", "Patch staging failed."); await rename(temp, resolved.absolute); hashes.set(edit.path, await this.workspaces.sha256(resolved.absolute)); } } catch (error) { await Promise.all(temps.map((temp) => unlink(temp).catch(() => undefined))); await this.recovery.rollback(request.operationId).catch(() => undefined); throw error; } return { operationId: request.operationId, change: await this.recovery.markApplied(request.operationId, hashes) }; });
  }

  async projectCommand(name: CommandName, input: unknown): Promise<ProcessSnapshot> {
    const args = ProjectCommandInput.parse(input); const workspace = this.workspaces.require(args.workspaceId); const command = getProjectCommand(workspace, name); const policyArgs = command.script ? [...command.args, "--script", command.script] : command.args; const request = this.request(args.workspaceId, `project_${name}`, [], command.executable, policyArgs); const timeout = args.timeoutSeconds ?? command.timeoutSeconds ?? (name === "dev" ? 0 : 600); return this.run(request, async () => { const process = this.processes.start(args.workspaceId, workspace.canonicalRoot, command.executable, command.args, timeout, name === "dev"); return name === "dev" ? process : this.processes.wait(process.processId); }, { approvalAction: `${name} project command` });
  }
  processList() { return this.processes.list(); }
  processRead(processId: string) { return this.processes.get(processId); }
  async processStop(processId: string) { const snapshot = this.processes.get(processId); const request = this.request(snapshot.workspaceId, "process_stop", [], snapshot.executable, snapshot.arguments); return this.run(request, () => this.processes.stop(processId)); }
  gitStatus(workspaceId: string) { const workspace = this.workspaces.require(workspaceId); const request = this.request(workspaceId, "git_status", []); return this.run(request, () => this.git.status(workspaceId, workspace.canonicalRoot)); }
  gitDiff(workspaceId: string) { const workspace = this.workspaces.require(workspaceId); const request = this.request(workspaceId, "git_diff", []); return this.run(request, () => this.git.diff(workspaceId, workspace.canonicalRoot)); }
  gitLog(workspaceId: string) { const workspace = this.workspaces.require(workspaceId); const request = this.request(workspaceId, "git_log", []); return this.run(request, () => this.git.log(workspaceId, workspace.canonicalRoot)); }
  gitShow(workspaceId: string, ref?: string) { const workspace = this.workspaces.require(workspaceId); const request = this.request(workspaceId, "git_show", [], "git", ref ? ["show", "--stat", ref] : ["show", "--stat", "HEAD"]); return this.run(request, () => this.git.show(workspaceId, workspace.canonicalRoot, ref)); }
  recoveryRestore(operationId: string) {
    const manifest = this.recovery.get(operationId);
    if (!manifest) throw new CodexBegError("RECOVERY_NOT_FOUND", `Unknown recovery operation: ${operationId}`);
    const deletesCreatedFile = manifest.changes.some((change) => !change.existed);
    const targets = manifest.changes.map((change) => change.afterSha256 ? { path: change.path, expectedSha256: change.afterSha256 } : { path: change.path });
    const request = this.request(manifest.workspaceId, deletesCreatedFile ? "operation_restore_delete" : "operation_restore", targets);
    return this.run(request, () => this.recovery.restore(operationId), { approvalAction: "restore workspace changes" });
  }
  async shutdown(): Promise<void> { await this.processes.stopAll(); }
}
