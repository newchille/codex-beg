import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonStore } from "./persistence.js";
import { ApprovalManager, PolicyEngine } from "./policy.js";
import { AgentRuntime } from "./runtime.js";
import { WorkspaceManager } from "./workspace.js";
import { ApprovalRequiredError, PathViolationError, StaleFileError } from "./errors.js";
import type { RegistryState } from "./types.js";

async function fixture(): Promise<{ root: string; runtime: AgentRuntime }> {
  const root = await mkdtemp(join(tmpdir(), "codex-beg-"));
  const data = await mkdtemp(join(tmpdir(), "codex-beg-data-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \\\"process.exit(0)\\\"" } }));
  const runtime = new AgentRuntime(data);
  await runtime.init();
  await runtime.addWorkspace(root, "Fixture");
  return { root, runtime };
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
});

describe("policy", () => {
  it("classifies dangerous command arguments as destructive", () => {
    const policy = new PolicyEngine();
    expect(policy.classify({ operationId: "x", source: "mcp", workspaceId: "x", kind: "project_test", executable: "powershell.exe", arguments: ["-Command", "Remove-Item file.txt"], targets: [], createdAt: new Date().toISOString() })).toBe("DESTRUCTIVE");
  });

  it("creates a single-use approval with a nonce for destructive operations", () => {
    const request = { operationId: "x", source: "mcp" as const, workspaceId: "x", kind: "delete", targets: [], createdAt: new Date().toISOString() };
    const manager = new ApprovalManager();
    const approval = manager.create(request, "delete", "delete file.txt", "destructive");
    expect(approval.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new PolicyEngine().enforce(request)).toThrow(ApprovalRequiredError);
    expect(manager.approve(approval.approvalId).status).toBe("approved");
    expect(() => manager.approve(approval.approvalId)).toThrow();
  });
});
