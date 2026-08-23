import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { CodexBegError } from "./errors.js";
import type { ProcessSnapshot } from "./types.js";

const BUFFER_LIMIT = 512 * 1024;

interface ManagedProcess { snapshot: ProcessSnapshot; child: ChildProcessWithoutNullStreams; timeout?: NodeJS.Timeout }

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  constructor(private readonly events = new EventBus()) {}

  list(): ProcessSnapshot[] { return [...this.processes.values()].map((item) => structuredClone(item.snapshot)); }
  get(id: string): ProcessSnapshot { const value = this.processes.get(id); if (!value) throw new CodexBegError("PROCESS_NOT_FOUND", `Unknown process: ${id}`); return structuredClone(value.snapshot); }

  start(workspaceId: string, cwd: string, executable: string, args: string[], timeoutSeconds: number, background: boolean): ProcessSnapshot {
    const processId = randomUUID();
    const snapshot: ProcessSnapshot = { processId, workspaceId, executable, arguments: args, startedAt: new Date().toISOString(), state: "starting", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32" });
    const managed: ManagedProcess = { snapshot, child };
    this.processes.set(processId, managed);
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const current = snapshot[key] + text;
      if (current.length > BUFFER_LIMIT) { snapshot[key] = current.slice(-BUFFER_LIMIT); snapshot[key === "stdout" ? "stdoutTruncated" : "stderrTruncated"] = true; }
      else snapshot[key] = current;
      this.events.emit(key === "stdout" ? "process.stdout" : "process.stderr", { processId, text });
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("spawn", () => { snapshot.state = "running"; this.events.emit("process.started", { processId, workspaceId, executable, arguments: args }); });
    child.once("error", (error) => { snapshot.state = "failed"; snapshot.exitCode = -1; snapshot.stderr += error.message; this.events.emit("process.exited", { processId, state: snapshot.state, exitCode: -1 }); });
    child.once("close", (code) => { snapshot.exitCode = code; if (snapshot.state !== "stopped" && snapshot.state !== "failed") snapshot.state = code === 0 ? "exited" : "failed"; this.events.emit("process.exited", { processId, state: snapshot.state, exitCode: code }); if (managed.timeout) clearTimeout(managed.timeout); });
    if (timeoutSeconds > 0) managed.timeout = setTimeout(() => { void this.stop(processId); }, timeoutSeconds * 1000);
    if (!background) return snapshot;
    return snapshot;
  }

  async wait(id: string): Promise<ProcessSnapshot> {
    const value = this.processes.get(id); if (!value) throw new CodexBegError("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
    if (["exited", "failed", "stopped"].includes(value.snapshot.state)) return structuredClone(value.snapshot);
    await new Promise<void>((resolve) => value.child.once("close", () => resolve()));
    return structuredClone(value.snapshot);
  }

  async stop(id: string): Promise<ProcessSnapshot> {
    const value = this.processes.get(id); if (!value) throw new CodexBegError("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
    if (["exited", "failed", "stopped"].includes(value.snapshot.state)) return structuredClone(value.snapshot);
    value.snapshot.state = "stopped";
    if (process.platform === "win32") value.child.kill();
    else { try { process.kill(-value.child.pid!, "SIGTERM"); } catch { value.child.kill("SIGTERM"); } }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (value.snapshot.exitCode === null) {
      if (process.platform === "win32" && value.child.pid) {
        const treeKiller = spawn("taskkill.exe", ["/PID", String(value.child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
        treeKiller.unref();
      } else { try { value.child.kill("SIGKILL"); } catch { /* already exited */ } }
    }
    return structuredClone(value.snapshot);
  }

  async stopAll(): Promise<void> { await Promise.all([...this.processes.keys()].map((id) => this.stop(id).catch(() => undefined))); }
}
