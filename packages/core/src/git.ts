import { ProcessManager } from "./process-manager.js";
import { CodexBegError } from "./errors.js";

export class GitService {
  constructor(private readonly processes: ProcessManager) {}

  async run(workspaceId: string, cwd: string, args: string[]): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
    const managed = this.processes.start(workspaceId, cwd, globalThis.process.platform === "win32" ? "git.exe" : "git", args, 60, false);
    const result = await this.processes.wait(managed.processId);
    if (result.state === "failed" && result.exitCode === -1) throw new CodexBegError("GIT_UNAVAILABLE", result.stderr || "Git could not be started.");
    return { output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.slice(0, 256 * 1024), exitCode: result.exitCode, truncated: (result.stdout.length + result.stderr.length) > 256 * 1024 };
  }

  status(workspaceId: string, cwd: string) { return this.run(workspaceId, cwd, ["status", "--short", "--branch"]); }
  diff(workspaceId: string, cwd: string) { return this.run(workspaceId, cwd, ["diff", "--no-ext-diff"]); }
  log(workspaceId: string, cwd: string) { return this.run(workspaceId, cwd, ["log", "--oneline", "-20"]); }
  show(workspaceId: string, cwd: string, ref = "HEAD") { if (!/^[A-Za-z0-9_./~-]+$/.test(ref)) throw new CodexBegError("INVALID_GIT_REF", "Invalid git ref."); return this.run(workspaceId, cwd, ["show", "--stat", ref]); }
}
