import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, JsonStore } from "./persistence.js";
import { ApprovalManager, PolicyEngine } from "./policy.js";
import { AgentRuntime } from "./runtime.js";
import { WorkspaceManager } from "./workspace.js";
import { GitService } from "./git.js";
import { ProcessManager, buildSpawnInvocation } from "./process-manager.js";
import { ApprovalRequiredError, PathViolationError, StaleFileError } from "./errors.js";
import type { OperationRecord, ProcessSnapshot, RegistryState } from "./types.js";
import { executableNames, resolveExecutable } from "./executable-resolution.js";

async function fixture(): Promise<{ root: string; data: string; runtime: AgentRuntime }> {
  const root = await mkdtemp(join(tmpdir(), "codex-beg-"));
  const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \\\"process.exit(0)\\\"" } }));
  const runtime = new AgentRuntime(data);
  await runtime.init();
  await runtime.addWorkspace(root, "Fixture");
  return { root, data, runtime };
}

describe("workspace isolation", () => {
  it("rejects parent traversal and absolute paths", async () => {
    const { runtime } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await expect(runtime.readFile(workspace.id, "../outside.txt")).rejects.toBeInstanceOf(PathViolationError);
    await expect(runtime.readFile(workspace.id, "/tmp/outside.txt")).rejects.toBeInstanceOf(PathViolationError);
    await expect(runtime.readFile(workspace.id, "C:\\outside.txt")).rejects.toBeInstanceOf(PathViolationError);
    await expect(runtime.readFile(workspace.id, "\\\\server\\share\\outside.txt")).rejects.toBeInstanceOf(PathViolationError);
  });

  it("registers child projects below a machine root and reuses existing registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-root-"));
    const child = join(root, "service-a");
    const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
    await mkdir(child);
    await writeFile(join(child, "package.json"), JSON.stringify({ scripts: { test: "node -e \\\"process.exit(0)\\\"" } }));
    const runtime = new AgentRuntime(data);
    await runtime.init();
    const parent = await runtime.addWorkspace(root, "DevProjects", "machine_root");
    const first = await runtime.registerWorkspace(parent.id, "service-a");
    const second = await runtime.registerWorkspace(parent.id, "service-a");
    expect(first.id).toBe(second.id);
    expect(first.parentWorkspaceId).toBe(parent.id);
    expect(first.kind).toBe("project");
    expect(first.projectType).toBe("node");
    await expect(runtime.registerWorkspace(parent.id, "../outside")).rejects.toBeInstanceOf(PathViolationError);
    await expect(runtime.registerWorkspace(parent.id, "/tmp/outside")).rejects.toBeInstanceOf(PathViolationError);
    const outside = await mkdtemp(join(tmpdir(), "codex-beg-outside-"));
    await symlink(outside, join(root, "outside-link"), "dir");
    await expect(runtime.registerWorkspace(parent.id, "outside-link")).rejects.toBeInstanceOf(PathViolationError);

    const separatelyRegistered = await runtime.addWorkspace(child, "Service A");
    const childLink = join(root, "service-link");
    await symlink(child, childLink, "dir");
    const linked = await runtime.registerWorkspace(parent.id, "service-link");
    expect(linked.id).toBe(separatelyRegistered.id);
    expect(linked.parentWorkspaceId).toBe(parent.id);
    await expect(runtime.addWorkspace(child, "Nested root", "machine_root")).rejects.toMatchObject({ code: "WORKSPACE_KIND_CONFLICT" });
    await runtime.removeWorkspace(parent.id);
    expect(runtime.workspaceInfo(first.id).parentWorkspaceId).toBeUndefined();
    expect(runtime.workspaceInfo(first.id).kind).toBe("project");
    expect(await readFile(join(child, "package.json"), "utf8")).toContain("scripts");
  });

  it("persists registry and rejects stale overwrites", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    const created = await runtime.writeFile({ workspaceId: workspace.id, path: "notes.txt", content: "one" });
    expect(created.change.status).toBe("applied");
    const hash = (await runtime.fileInfo(workspace.id, "notes.txt")).sha256;
    await expect(runtime.writeFile({ workspaceId: workspace.id, path: "notes.txt", content: "two" })).rejects.toBeInstanceOf(StaleFileError);
    await runtime.writeFile({ workspaceId: workspace.id, path: "notes.txt", content: "two", expectedSha256: hash });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("two");
  });

  it("rejects project commands for machine roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-machine-root-command-"));
    const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
    const runtime = new AgentRuntime(data);
    await runtime.init();
    const machineRoot = await runtime.addWorkspace(root, "DevProjects", "machine_root");
    await expect(runtime.projectCommand("test", { workspaceId: machineRoot.id })).rejects.toMatchObject({ code: "PROJECT_WORKSPACE_REQUIRED" });
  });
  it("awaits approved async operations and records execution failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-approval-await-"));
    const data = await mkdtemp(join(tmpdir(), "codex-beg-approval-data-"));
    const runtime = new AgentRuntime(data);
    await runtime.init();
    const parent = await runtime.addWorkspace(root, "Root", "machine_root");
    await expect(runtime.registerWorkspaceFromMcp({ parentWorkspaceId: parent.id, path: "missing-child" })).rejects.toBeInstanceOf(ApprovalRequiredError);
    const approval = runtime.approvalsList().at(-1)!;
    await expect(runtime.approvalApprove(approval.approvalId)).rejects.toThrow();
    expect(runtime.operationGet(approval.operationId)).toMatchObject({ status: "failed" });
    expect(runtime.approvalsList().find((item) => item.approvalId === approval.approvalId)).toMatchObject({ status: "approved" });
    await runtime.shutdown();
  });

  it("returns bounded read metadata, continuation, and per-file errors", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await writeFile(join(root, "alpha.txt"), "abcdefghij");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const first = await runtime.readFile(workspace.id, "alpha.txt", 0, 4);
    expect(first).toMatchObject({ path: "alpha.txt", content: "abcd", offset: 0, bytesReturned: 4, totalBytes: 10, truncated: true, nextOffset: 4 });
    expect(first.sha256).toHaveLength(64);
    const unchanged = await runtime.readManyFiles({ workspaceId: workspace.id, files: [{ path: "alpha.txt", knownSha256: first.sha256 }], maxTotalBytes: 1 });
    expect(unchanged.totalBytesReturned).toBe(0);
    expect(unchanged.files[0]).toMatchObject({ path: "alpha.txt", unchanged: true, sha256: first.sha256, bytesReturned: 0, totalBytes: 10, truncated: false });
    expect("content" in unchanged.files[0]!).toBe(false);
    const second = await runtime.readFile(workspace.id, "alpha.txt", first.nextOffset!, 4);
    expect(second).toMatchObject({ content: "efgh", offset: 4, bytesReturned: 4, truncated: true, nextOffset: 8 });

    const many = await runtime.readManyFiles({ workspaceId: workspace.id, files: [{ path: "alpha.txt", limit: 4 }, { path: "missing.txt", limit: 4 }, { path: "binary.bin", limit: 4 }, { path: "alpha.txt", offset: 4, limit: 4 }, { path: "alpha.txt", offset: 8, limit: 4 }], maxTotalBytes: 6 });
    expect(many.totalBytesReturned).toBeLessThanOrEqual(6);
    expect(many.truncated).toBe(true);
    expect(many.files[1]).toMatchObject({ path: "missing.txt", error: { code: "ENOENT" } });
    expect(many.files[2]).toMatchObject({ path: "binary.bin", error: { code: "BINARY_FILE" } });
    expect(many.files[4]).toMatchObject({ path: "alpha.txt", error: { code: "TOTAL_BUDGET_EXCEEDED" } });
    const escaped = await runtime.readManyFiles({ workspaceId: workspace.id, files: [{ path: "../outside.txt" }], maxTotalBytes: 100 });
    expect(escaped.files[0]).toMatchObject({ error: { code: "PATH_OUTSIDE_WORKSPACE" } });
  });
  it("keeps byte continuation on UTF-8 code-point boundaries", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await writeFile(join(root, "unicode.txt"), "A😀ขB");
    const first = await runtime.readFile(workspace.id, "unicode.txt", 0, 3);
    expect(first).toMatchObject({ content: "A", offset: 0, bytesReturned: 1, totalBytes: 9, truncated: true, nextOffset: 1 });
    const emoji = await runtime.readFile(workspace.id, "unicode.txt", first.nextOffset!, 4);
    expect(emoji).toMatchObject({ content: "😀", offset: 1, bytesReturned: 4, nextOffset: 5 });
    const thai = await runtime.readFile(workspace.id, "unicode.txt", emoji.nextOffset!, 3);
    expect(thai).toMatchObject({ content: "ข", offset: 5, bytesReturned: 3, nextOffset: 8 });
    const last = await runtime.readFile(workspace.id, "unicode.txt", thai.nextOffset!, 3);
    expect(last).toMatchObject({ content: "B", offset: 8, bytesReturned: 1, truncated: false, nextOffset: null });
    await expect(runtime.readFile(workspace.id, "unicode.txt", 2, 4)).rejects.toMatchObject({ code: "UTF8_OFFSET_BOUNDARY" });
    await expect(runtime.readFile(workspace.id, "unicode.txt", 1, 1)).rejects.toMatchObject({ code: "UTF8_READ_LIMIT_TOO_SMALL" });
  });

  it("enforces read-many file and total limits", async () => {
    const { runtime } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await expect(runtime.readManyFiles({ workspaceId: workspace.id, files: Array.from({ length: 21 }, (_, index) => ({ path: `file-${index}.txt` })) })).rejects.toThrow();
    await expect(runtime.readManyFiles({ workspaceId: workspace.id, files: [{ path: "package.json" }], maxTotalBytes: 2 * 1024 * 1024 + 1 })).rejects.toThrow();
  });

  it("pages bounded file discovery and skips automatic discovery directories", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, ".pnpm-store"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(join(root, "src", "alpha.ts"), "alpha");
    await writeFile(join(root, "src", "beta.ts"), "beta");
    await writeFile(join(root, "node_modules", "hidden.ts"), "hidden");
    await writeFile(join(root, ".pnpm-store", "store-hidden.ts"), "hidden-store");
    await writeFile(join(root, "dist", "generated.ts"), "generated");
    await writeFile(join(root, "coverage", "report.ts"), "report");
    const first = await runtime.searchFiles({ workspaceId: workspace.id, query: ".ts", maxResults: 1 });
    expect(first.items).toEqual([{ path: "src/alpha.ts", kind: "file", size: 5 }]);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(1);
    const second = await runtime.searchFiles({ workspaceId: workspace.id, query: ".ts", offset: first.nextOffset!, maxResults: 1 });
    expect(second.items).toEqual([{ path: "src/beta.ts", kind: "file", size: 4 }]);
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeNull();
    const tree = await runtime.workspaceTree(workspace.id);
    expect(tree.some((item) => item.path.startsWith(".pnpm-store"))).toBe(false);
    const explicit = await runtime.searchFiles({ workspaceId: workspace.id, query: "hidden", path: "node_modules" });
    expect(explicit.items.map((item) => item.path)).toEqual(["node_modules/hidden.ts"]);
    expect(await runtime.readFile(workspace.id, "node_modules/hidden.ts")).toMatchObject({ content: "hidden" });
    await expect(runtime.searchFiles({ workspaceId: workspace.id, query: "ts", path: "../" })).rejects.toBeInstanceOf(PathViolationError);
  });
  it("pages directory and text search results deterministically", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await mkdir(join(root, "paged"), { recursive: true });
    await writeFile(join(root, "paged", "b.txt"), "needle b");
    await writeFile(join(root, "paged", "a.txt"), "needle a");
    await writeFile(join(root, "paged", "c.txt"), "other");
    const directoryFirst = await runtime.listDirectoryPage({ workspaceId: workspace.id, path: "paged", maxResults: 2 });
    expect(directoryFirst.items.map((item) => item.name)).toEqual(["a.txt", "b.txt"]);
    expect(directoryFirst).toMatchObject({ truncated: true, nextOffset: 2 });
    const directorySecond = await runtime.listDirectoryPage({ workspaceId: workspace.id, path: "paged", offset: directoryFirst.nextOffset!, maxResults: 2 });
    expect(directorySecond.items.map((item) => item.name)).toEqual(["c.txt"]);
    expect(directorySecond).toMatchObject({ truncated: false, nextOffset: null });
    const searchFirst = await runtime.searchTextPage({ workspaceId: workspace.id, query: "needle", path: "paged", maxResults: 1 });
    expect(searchFirst.items[0]).toMatchObject({ path: "paged/a.txt", line: 1, text: "needle a" });
    expect(searchFirst).toMatchObject({ truncated: true, nextOffset: 1 });
    const searchSecond = await runtime.searchTextPage({ workspaceId: workspace.id, query: "needle", path: "paged", offset: searchFirst.nextOffset!, maxResults: 1 });
    expect(searchSecond.items[0]).toMatchObject({ path: "paged/b.txt", line: 1, text: "needle b" });
    expect(searchSecond).toMatchObject({ truncated: false, nextOffset: null });
    await expect(runtime.searchTextPage({ workspaceId: workspace.id, query: "needle", path: "../" })).rejects.toBeInstanceOf(PathViolationError);
    await expect(runtime.listDirectoryPage({ workspaceId: workspace.id, offset: 100_001 })).rejects.toThrow();
  });
  it("preflights all recovery targets before restoring any file", async () => {
    const { runtime, root } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await writeFile(join(root, "a.txt"), "old-a");
    await writeFile(join(root, "b.txt"), "old-b");
    const manifest = await runtime.recovery.capture("recovery-preflight", workspace.id, ["a.txt", "b.txt"]);
    await writeFile(join(root, "a.txt"), "after-a");
    await writeFile(join(root, "b.txt"), "after-b");
    await runtime.recovery.markApplied(manifest.operationId, new Map([
      ["a.txt", await runtime.workspaces.sha256(join(root, "a.txt"))],
      ["b.txt", await runtime.workspaces.sha256(join(root, "b.txt"))],
    ]));
    await writeFile(join(root, "b.txt"), "external-b");
    await expect(runtime.recovery.restore(manifest.operationId)).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after-a");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("external-b");
  }); it("requires approval before recovery deletes a file created by the original operation", async () => { const { runtime, root } = await fixture(); const workspace = runtime.workspaceCurrent()!; const manifest = await runtime.recovery.capture("recovery-delete-approval", workspace.id, ["created.txt"]); await writeFile(join(root, "created.txt"), "created"); await runtime.recovery.markApplied(manifest.operationId, new Map([["created.txt", await runtime.workspaces.sha256(join(root, "created.txt"))]])); await expect(runtime.recoveryRestore(manifest.operationId)).rejects.toBeInstanceOf(ApprovalRequiredError); expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created"); expect(runtime.operationList().at(-1)).toMatchObject({ kind: "operation_restore_delete", status: "approval_required" });
  });

  it("rejects oversized recovery targets before creating partial state", async () => {
    const { runtime, root, data } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    const operationId = "recovery-oversized-preflight";
    await writeFile(join(root, "oversized.bin"), "");
    await truncate(join(root, "oversized.bin"), 64 * 1024 * 1024 + 1);
    await expect(runtime.recovery.capture(operationId, workspace.id, ["oversized.bin"])).rejects.toMatchObject({ code: "RECOVERY_FILE_TOO_LARGE" });
    await expect(readdir(join(data, "recovery", operationId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.recovery.get(operationId)).toBeUndefined();
  });

  it("rejects aggregate recovery snapshots over the operation ceiling before copying", async () => {
    const { runtime, root, data } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    const operationId = "recovery-aggregate-preflight";
    await writeFile(join(root, "first.bin"), "");
    await writeFile(join(root, "second.bin"), "");
    await writeFile(join(root, "third.bin"), "");
    await truncate(join(root, "first.bin"), 42 * 1024 * 1024);
    await truncate(join(root, "second.bin"), 42 * 1024 * 1024);
    await truncate(join(root, "third.bin"), 44 * 1024 * 1024 + 1);
    await expect(runtime.recovery.capture(operationId, workspace.id, ["first.bin", "second.bin", "third.bin"])).rejects.toMatchObject({ code: "RECOVERY_OPERATION_TOO_LARGE" });
    await expect(readdir(join(data, "recovery", operationId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.recovery.get(operationId)).toBeUndefined();
  });

  it("restores a normal recovery snapshot and preserves unresolved manifests during pruning", async () => {
    const { runtime, root, data } = await fixture();
    const workspace = runtime.workspaceCurrent()!;
    await writeFile(join(root, "normal.txt"), "before");
    const normal = await runtime.recovery.capture("recovery-normal", workspace.id, ["normal.txt"]);
    await writeFile(join(root, "normal.txt"), "after");
    await runtime.recovery.markApplied(normal.operationId, new Map([["normal.txt", await runtime.workspaces.sha256(join(root, "normal.txt"))]]));
    await runtime.recovery.restore(normal.operationId);
    expect(await readFile(join(root, "normal.txt"), "utf8")).toBe("before");

    await writeFile(join(root, "conflict.txt"), "before-conflict");
    const conflict = await runtime.recovery.capture("recovery-unresolved-conflict", workspace.id, ["conflict.txt"]);
    await writeFile(join(root, "conflict.txt"), "after-conflict");
    await runtime.recovery.markApplied(conflict.operationId, new Map([["conflict.txt", await runtime.workspaces.sha256(join(root, "conflict.txt"))]]));
    await writeFile(join(root, "conflict.txt"), "external-conflict");
    await expect(runtime.recovery.restore(conflict.operationId)).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });

    const captured = await runtime.recovery.capture("recovery-unresolved-captured", workspace.id, ["normal.txt"]);
    await (runtime.recovery as unknown as { prune: (maxAgeMs?: number, maxBytes?: number) => Promise<void> }).prune(0, 0);
    expect(runtime.recovery.get(captured.operationId)?.status).toBe("captured");
    expect(runtime.recovery.get(conflict.operationId)?.status).toBe("restore_conflict");
    await expect(readdir(join(data, "recovery", captured.operationId))).resolves.toContain("0.before");
    await expect(readdir(join(data, "recovery", conflict.operationId))).resolves.toContain("0.before");
  });
});

describe("executable resolution", () => {
  it("resolves a package manager from PATH to an executable path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-executable-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const pnpm = join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    await writeFile(pnpm, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await chmod(pnpm, 0o755);
    const resolved = await resolveExecutable("pnpm", { env: { PATH: bin }, homeDir: root });
    expect(await realpath(resolved.executable)).toBe(await realpath(pnpm));
    expect(resolved.argsPrefix).toEqual([]);
  });

  it("keeps Windows command-name candidates compatible with cmd shims", () => {
    expect(executableNames("pnpm", "win32")).toEqual(["pnpm.cmd", "pnpm.exe", "pnpm"]);
    expect(executableNames("pnpm", "darwin")).toEqual(["pnpm"]);
  });

  it("selects the project Node version before deterministic installed fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-node-project-"));
    const nvmDir = join(root, ".nvm");
    const preferred = join(nvmDir, "versions", "node", "v20.11.1", "bin");
    const fallback = join(nvmDir, "versions", "node", "v18.20.3", "bin");
    await mkdir(preferred, { recursive: true });
    await mkdir(fallback, { recursive: true });
    await writeFile(join(root, ".nvmrc"), "20.11.1\n");
    const preferredPnpm = join(preferred, "pnpm");
    const fallbackPnpm = join(fallback, "pnpm");
    await writeFile(preferredPnpm, "#!/bin/sh\nexit 0\n");
    await writeFile(fallbackPnpm, "#!/bin/sh\nexit 0\n");
    await chmod(preferredPnpm, 0o755);
    await chmod(fallbackPnpm, 0o755);
    const resolved = await resolveExecutable("pnpm", { cwd: root, projectRoot: root, env: { PATH: "", NVM_DIR: nvmDir }, homeDir: root });
    expect(await realpath(resolved.executable)).toBe(await realpath(preferredPnpm));
  });

  it("uses a narrow cmd adapter for known Windows package-manager shims without shell mode", () => {
    expect(buildSpawnInvocation("C:\\tools\\pnpm.cmd", ["run", "typecheck"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({ executable: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "C:\\tools\\pnpm.cmd", "run", "typecheck"] });
    expect(buildSpawnInvocation("C:\\tools\\pnpm.cmd", ["run", "test"], "win32", { ComSpec: "cmd.exe", SystemRoot: "D:\\Windows" }).executable).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(() => buildSpawnInvocation("C:\\tools\\pnpm.cmd", ["run", "test&whoami"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toThrowError(/metacharacters/);
    expect(buildSpawnInvocation("C:\\tools\\custom.cmd", ["arg"], "win32", { ComSpec: "cmd.exe" })).toEqual({ executable: "C:\\tools\\custom.cmd", args: ["arg"] });
    expect(buildSpawnInvocation("pnpm.cmd", ["run", "test"], "darwin")).toEqual({ executable: "pnpm.cmd", args: ["run", "test"] });
  });

  it("falls back to a Corepack shim without invoking a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-corepack-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const corepack = join(bin, "corepack.cmd");
    await writeFile(corepack, "@echo off\r\n");
    const resolved = await resolveExecutable("pnpm", { env: { PATH: bin }, homeDir: root, platform: "win32" });
    expect(await realpath(resolved.executable)).toBe(await realpath(corepack));
    expect(resolved.argsPrefix).toEqual(["pnpm"]);
  });

  it.skipIf(process.platform === "win32")("refreshes stale package-manager profiles at execution time", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-project-"));
    const bin = join(root, "bin");
    const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
    await mkdir(bin);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "ignored by fake pnpm" } }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const pnpm = join(bin, "pnpm");
    await writeFile(pnpm, "#!/bin/sh\nexit 0\n");
    await chmod(pnpm, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${previousPath ? `:${previousPath}` : ""}`;
    try {
      const firstRuntime = new AgentRuntime(data);
      await firstRuntime.init();
      const registered = await firstRuntime.addWorkspace(root, "Project");
      expect(registered.commands.test?.executable).toBe("pnpm");

      const secondRuntime = new AgentRuntime(data);
      await secondRuntime.init();
      const result = await secondRuntime.projectCommand("test", { workspaceId: registered.id });
      expect(result.executable).toBe(await realpath(pnpm));
      expect(result.exitCode).toBe(0);
      expect(result.state).toBe("exited");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("process output paging", () => { it("reads bounded logical output pages and rejects expired offsets", async () => { const root = await mkdtemp(join(tmpdir(), "codex-beg-process-output-")); const manager = new ProcessManager(); const small = manager.start("workspace-id", root, process.execPath, ["-e", "process.stdout.write('abcdef')"], 10, false); await manager.wait(small.processId); expect(manager.readOutput(small.processId, "stdout", 0, 2)).toMatchObject({ content: "ab", offset: 0, charsReturned: 2, totalChars: 6, retainedStartOffset: 0, hasMore: true, nextOffset: 2 }); expect(manager.readOutput(small.processId, "stdout", 2, 2)).toMatchObject({ content: "cd", offset: 2, hasMore: true, nextOffset: 4 }); const large = manager.start("workspace-id", root, process.execPath, ["-e", "process.stdout.write('a'.repeat(600000))"], 10, false); await manager.wait(large.processId); const tail = manager.readOutput(large.processId, "stdout", undefined, 10); expect(tail).toMatchObject({ content: "aaaaaaaaaa", totalChars: 600000, charsReturned: 10, hasMore: false, nextOffset: 600000, truncatedBefore: true }); expect(tail.retainedStartOffset).toBeGreaterThan(0); expect(() => manager.readOutput(large.processId, "stdout", 0, 10)).toThrowError(/no longer retained/); await manager.stopAll(); }); });
describe("process list bounding", () => { it("returns only bounded output tails", async () => { const root = await mkdtemp(join(tmpdir(), "codex-beg-process-list-")); const manager = new ProcessManager(); const processSnapshot = manager.start("workspace-id", root, process.execPath, ["-e", "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000))"], 10, false); await manager.wait(processSnapshot.processId); const listed = manager.list().find((item) => item.processId === processSnapshot.processId)!; expect(listed.stdout).toHaveLength(2048); expect(listed.stderr).toHaveLength(2048); expect(listed.stdoutTruncated).toBe(true); expect(listed.stderrTruncated).toBe(true); await manager.stopAll(); }); it("prunes only completed in-memory history and preserves running records", () => { const manager = new ProcessManager(); const internal = manager as unknown as { processes: Map<string, { snapshot: ProcessSnapshot }>; pruneCompletedHistory: () => void }; const makeSnapshot = (id: string, state: ProcessSnapshot["state"], index: number): ProcessSnapshot => ({ processId: id, workspaceId: "workspace-id", executable: "node", arguments: [], startedAt: new Date(index * 1000).toISOString(), state, exitCode: state === "running" ? null : 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }); for (let index = 0; index < 205; index += 1) internal.processes.set(`done-${index}`, { snapshot: makeSnapshot(`done-${index}`, "exited", index) }); internal.processes.set("running", { snapshot: makeSnapshot("running", "running", 999) }); internal.pruneCompletedHistory(); expect(internal.processes.size).toBe(200); expect(internal.processes.has("running")).toBe(true); expect(internal.processes.has("done-0")).toBe(false); }); });
describe("persistence", () => {
  it("serializes concurrent JSON saves to the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-store-"));
    const path = join(root, "state.json");
    await Promise.all(Array.from({ length: 20 }, (_, sequence) => new JsonStore(path, { sequence: -1 }).save({ sequence })));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ sequence: 19 });
  }); it("serializes concurrent audit appends across rotation without losing events", async () => { const root = await mkdtemp(join(tmpdir(), "codex-beg-audit-")); const audit = new AuditLog(root, 180); const events = Array.from({ length: 40 }, (_, sequence) => ({ id: `event-${sequence}`, name: "tool.completed" as const, timestamp: new Date(sequence * 1000).toISOString(), data: { sequence, payload: "x".repeat(64) } })); await Promise.all(events.map((event) => audit.append(event))); const files = (await readdir(root)).filter((name) => name.endsWith(".ndjson")); const restored = (await Promise.all(files.map(async (name) => (await readFile(join(root, name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string })))).flat(); expect(restored).toHaveLength(events.length); expect(new Set(restored.map((event) => event.id))).toEqual(new Set(events.map((event) => event.id))); }); it("returns an isolated initial value when the backing file does not exist", async () => { const root = await mkdtemp(join(tmpdir(), "codex-beg-store-initial-")); const path = join(root, "missing.json"); const initial = { items: [] as string[] }; const first = await new JsonStore(path, initial).load(); first.items.push("leak"); const second = await new JsonStore(path, initial).load(); expect(second).toEqual({ items: [] }); expect(initial).toEqual({ items: [] });
  });
  it("bounds persisted terminal operation history while preserving nonterminal records", async () => { const data = await mkdtemp(join(tmpdir(), "codex-beg-operation-retention-")); const runtime = new AgentRuntime(data); await runtime.init(); const internal = runtime as unknown as { operations: { schemaVersion: 1; operations: OperationRecord[] }; saveOperations: () => Promise<void> }; const makeRecord = (operationId: string, status: OperationRecord["status"], index: number): OperationRecord => ({ operationId, kind: "test", status, workspaceId: "workspace", createdAt: new Date(index * 1000).toISOString(), updatedAt: new Date(index * 1000).toISOString() }); for (let index = 0; index < 1005; index += 1) internal.operations.operations.push(makeRecord(`done-${index}`, "succeeded", index)); internal.operations.operations.push(makeRecord("pending-keep", "pending", 2000), makeRecord("running-keep", "running", 2001), makeRecord("approval-keep", "approval_required", 2002)); await internal.saveOperations(); const persisted = JSON.parse(await readFile(join(data, "operations.json"), "utf8")) as { operations: OperationRecord[] }; expect(persisted.operations).toHaveLength(1003); expect(persisted.operations.some((item) => item.operationId === "done-0")).toBe(false); expect(persisted.operations.some((item) => item.operationId === "done-1004")).toBe(true); for (const id of ["pending-keep", "running-keep", "approval-keep"]) expect(persisted.operations.some((item) => item.operationId === id)).toBe(true); await runtime.shutdown(); });
  it("marks persisted nonterminal operations interrupted after restart", async () => {
    const data = await mkdtemp(join(tmpdir(), "codex-beg-interrupted-"));
    const createdAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(join(data, "operations.json"), JSON.stringify({ schemaVersion: 1, operations: [
      { operationId: "pending-op", kind: "write_file", status: "pending", workspaceId: "workspace", createdAt, updatedAt: createdAt },
      { operationId: "approval-op", kind: "delete", status: "approval_required", workspaceId: "workspace", createdAt, updatedAt: createdAt, approvalId: "approval" },
      { operationId: "done-op", kind: "read_file", status: "succeeded", workspaceId: "workspace", createdAt, updatedAt: createdAt },
    ] }));
    const runtime = new AgentRuntime(data);
    await runtime.init();
    expect(runtime.operationGet("pending-op")).toMatchObject({ status: "interrupted", error: expect.stringContaining("restarted") });
    expect(runtime.operationGet("approval-op")).toMatchObject({ status: "interrupted", error: expect.stringContaining("restarted") });
    expect(runtime.operationGet("done-op").status).toBe("succeeded");
    await runtime.shutdown();
  });
});

describe("policy", () => {
  it("classifies dangerous command arguments as destructive", () => {
    const policy = new PolicyEngine();
    expect(policy.classify({ operationId: "x", source: "mcp", workspaceId: "x", kind: "project_test", executable: "powershell.exe", arguments: ["-Command", "Remove-Item file.txt"], targets: [], createdAt: new Date().toISOString() })).toBe("DESTRUCTIVE");
  });

  it("creates a single-use approval with a nonce for destructive operations", () => {
    const request = { operationId: "x", source: "mcp" as const, workspaceId: "x", kind: "delete", targets: [], createdAt: new Date().toISOString() };
    const manager = new ApprovalManager();
    const approval = manager.create(request, "delete", "delete file.txt", "destructive", "DESTRUCTIVE");
    expect(approval.classification).toBe("DESTRUCTIVE");
    expect(approval.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new PolicyEngine().enforce(request)).toThrow(ApprovalRequiredError);
    expect(manager.approve(approval.approvalId).status).toBe("approved");
    expect(() => manager.approve(approval.approvalId)).toThrow();
  });
  it("bounds terminal approval history while preserving live pending approvals", () => { const manager = new ApprovalManager(); const request = { operationId: "history-op", source: "mcp" as const, workspaceId: "x", kind: "delete", targets: [], createdAt: new Date().toISOString() }; for (let index = 0; index < 205; index += 1) { const approval = manager.create(request, `delete-${index}`, `delete file-${index}`, "destructive", "DESTRUCTIVE"); manager.approve(approval.approvalId); } const pending = manager.create(request, "pending", "delete pending", "destructive", "DESTRUCTIVE"); const listed = manager.list(); expect(listed).toHaveLength(200); expect(listed.some((item) => item.approvalId === pending.approvalId && item.status === "pending")).toBe(true); expect(listed.some((item) => item.action === "delete-0")).toBe(false); });
});

describe("git argument execution", () => {
  it("passes staged paths after a git option terminator", async () => {
    let capturedArguments: string[] | undefined;
    const fakeProcesses = {
      start: (_workspaceId: string, _cwd: string, executable: string, args: string[]) => {
        expect(executable).toBe("git");
        capturedArguments = args;
        return { processId: "process-id" };
      },
      wait: async () => ({ state: "exited", exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
    } as unknown as ProcessManager;
    const git = new GitService(fakeProcesses);
    await git.stage("workspace-id", "/tmp", ["src/a.ts", "--strange-name.ts"]);
    expect(capturedArguments).toEqual(["add", "--", "src/a.ts", "--strange-name.ts"]);
  });
  it("runs git diff --check without shell parsing", async () => { let capturedArguments: string[] | undefined; const fakeProcesses = { start: (_workspaceId: string, _cwd: string, executable: string, args: string[]) => { expect(executable).toBe("git"); capturedArguments = args; return { processId: "process-id" }; }, wait: async () => ({ state: "exited", exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }) } as unknown as ProcessManager; const git = new GitService(fakeProcesses); await git.diffCheck("workspace-id", "/tmp"); expect(capturedArguments).toEqual(["diff", "--check"]); });

  it("passes a commit message as one argument without shell parsing", async () => {
    let capturedArguments: string[] | undefined;
    const fakeProcesses = {
      start: (_workspaceId: string, _cwd: string, executable: string, args: string[]) => {
        expect(executable).toBe("git");
        capturedArguments = args;
        return { processId: "process-id" };
      },
      wait: async () => ({ state: "exited", exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
    } as unknown as ProcessManager;
    const git = new GitService(fakeProcesses);
    const message = "subject; $(touch should-not-run) --flag\nbody";
    await git.commit("workspace-id", "/tmp", message);
    expect(capturedArguments).toEqual(["commit", "-m", message]);
  });

  it("rejects git reads and mutations for machine roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-beg-machine-root-"));
    const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
    const runtime = new AgentRuntime(data);
    await runtime.init();
    const machineRoot = await runtime.addWorkspace(root, "DevProjects", "machine_root");
    await expect(runtime.gitStatus(machineRoot.id)).rejects.toMatchObject({ code: "PROJECT_WORKSPACE_REQUIRED" });
    await expect(runtime.gitStage({ workspaceId: machineRoot.id, paths: ["file.txt"] })).rejects.toMatchObject({ code: "PROJECT_WORKSPACE_REQUIRED" });
    await expect(runtime.gitCommit({ workspaceId: machineRoot.id, message: "should not commit" })).rejects.toMatchObject({ code: "PROJECT_WORKSPACE_REQUIRED" });
  });
});
