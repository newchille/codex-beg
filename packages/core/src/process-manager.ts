import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { win32 as pathWin32 } from "node:path";
import { EventBus } from "./events.js";
import { CodexBegError } from "./errors.js";
import type { ProcessSnapshot } from "./types.js";

const BUFFER_LIMIT = 512 * 1024;
const PROCESS_LIST_LIMIT = 50;
const PROCESS_LIST_OUTPUT_TAIL = 2 * 1024;
const PROCESS_HISTORY_LIMIT = 200;

interface ManagedProcess { snapshot: ProcessSnapshot; child: ChildProcessWithoutNullStreams; timeout?: NodeJS.Timeout; stdoutTotalChars: number; stderrTotalChars: number; stdoutStartOffset: number; stderrStartOffset: number }

export interface SpawnInvocation {
  executable: string;
  args: string[];
}

/**
 * Windows package-manager shims are .cmd/.bat files rather than native executables.
 * Invoke only the known shims through cmd.exe, preserving an argument array and
 * keeping spawn's shell option disabled for all processes.
 */
export function buildSpawnInvocation(executable: string, args: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SpawnInvocation {
  const baseName = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (platform !== "win32" || !/^(pnpm|npm|yarn|corepack)\.(cmd|bat)$/.test(baseName)) return { executable, args: [...args] };
  const unsafe = /[&|<>^%!()"\r\n]/;
  if (unsafe.test(executable) || args.some((arg) => unsafe.test(arg))) {
    throw new CodexBegError("UNSAFE_WINDOWS_SHIM_ARGUMENT", "Windows package-manager shim arguments contain CMD metacharacters.");
  }
  const configuredShell = env.ComSpec ?? env.COMSPEC;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  const commandShell = configuredShell && pathWin32.isAbsolute(configuredShell)
    ? configuredShell
    : pathWin32.join(systemRoot && pathWin32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows", "System32", "cmd.exe");
  return { executable: commandShell, args: ["/d", "/s", "/c", executable, ...args] };
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  constructor(private readonly events = new EventBus()) {}
  private pruneCompletedHistory(): void { if (this.processes.size <= PROCESS_HISTORY_LIMIT) return; const completed = [...this.processes.entries()].filter(([, item]) => ["exited", "failed", "stopped"].includes(item.snapshot.state)).sort(([, left], [, right]) => Date.parse(left.snapshot.startedAt) - Date.parse(right.snapshot.startedAt)); for (const [id] of completed) { if (this.processes.size <= PROCESS_HISTORY_LIMIT) break; this.processes.delete(id); } }

  list(): ProcessSnapshot[] { return [...this.processes.values()].sort((left, right) => Date.parse(right.snapshot.startedAt) - Date.parse(left.snapshot.startedAt)).slice(0, PROCESS_LIST_LIMIT).map((item) => { const snapshot = structuredClone(item.snapshot); if (snapshot.stdout.length > PROCESS_LIST_OUTPUT_TAIL) { snapshot.stdout = snapshot.stdout.slice(-PROCESS_LIST_OUTPUT_TAIL); snapshot.stdoutTruncated = true; } if (snapshot.stderr.length > PROCESS_LIST_OUTPUT_TAIL) { snapshot.stderr = snapshot.stderr.slice(-PROCESS_LIST_OUTPUT_TAIL); snapshot.stderrTruncated = true; } return snapshot; }); }
  get(id: string): ProcessSnapshot { const value = this.processes.get(id); if (!value) throw new CodexBegError("PROCESS_NOT_FOUND", `Unknown process: ${id}`); return structuredClone(value.snapshot); }

  start(workspaceId: string, cwd: string, executable: string, args: string[], timeoutSeconds: number, background: boolean): ProcessSnapshot {
    const processId = randomUUID();
    const snapshot: ProcessSnapshot = { processId, workspaceId, executable, arguments: args, startedAt: new Date().toISOString(), state: "starting", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    const invocation = buildSpawnInvocation(executable, args);
    const child = spawn(invocation.executable, invocation.args, { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32" });
    const managed: ManagedProcess = { snapshot, child, stdoutTotalChars: 0, stderrTotalChars: 0, stdoutStartOffset: 0, stderrStartOffset: 0 };
    this.processes.set(processId, managed);
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const totalKey = key === "stdout" ? "stdoutTotalChars" : "stderrTotalChars";
      const startKey = key === "stdout" ? "stdoutStartOffset" : "stderrStartOffset";
      managed[totalKey] += text.length;
      const current = snapshot[key] + text;
      if (current.length > BUFFER_LIMIT) { snapshot[key] = current.slice(-BUFFER_LIMIT); managed[startKey] = managed[totalKey] - snapshot[key].length; snapshot[key === "stdout" ? "stdoutTruncated" : "stderrTruncated"] = true; }
      else snapshot[key] = current;
      this.events.emit(key === "stdout" ? "process.stdout" : "process.stderr", { processId, text });
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("spawn", () => { snapshot.state = "running"; this.events.emit("process.started", { processId, workspaceId, executable, arguments: args }); });
    child.once("error", (error) => { snapshot.state = "failed"; snapshot.exitCode = -1; append("stderr", Buffer.from(error.message)); this.events.emit("process.exited", { processId, state: snapshot.state, exitCode: -1 }); });
    child.once("close", (code) => { snapshot.exitCode = code; if (snapshot.state !== "stopped" && snapshot.state !== "failed") snapshot.state = code === 0 ? "exited" : "failed"; this.events.emit("process.exited", { processId, state: snapshot.state, exitCode: code }); if (managed.timeout) clearTimeout(managed.timeout); this.pruneCompletedHistory(); });
    if (timeoutSeconds > 0) managed.timeout = setTimeout(() => { void this.stop(processId); }, timeoutSeconds * 1000);
    if (!background) return snapshot;
    return snapshot;
  }

  readOutput(id: string, stream: "stdout" | "stderr", offset?: number, maxChars = 16 * 1024) { const value = this.processes.get(id); if (!value) throw new CodexBegError("PROCESS_NOT_FOUND", `Unknown process: ${id}`); const max = Math.min(Math.max(maxChars, 1), 64 * 1024); const totalChars = stream === "stdout" ? value.stdoutTotalChars : value.stderrTotalChars; const retainedStartOffset = stream === "stdout" ? value.stdoutStartOffset : value.stderrStartOffset; const requestedOffset = offset ?? Math.max(retainedStartOffset, totalChars - max); if (requestedOffset < retainedStartOffset) throw new CodexBegError("PROCESS_OUTPUT_EXPIRED", `Requested ${stream} output is no longer retained.`); if (requestedOffset > totalChars) throw new CodexBegError("PROCESS_OUTPUT_OFFSET", `Requested ${stream} offset is beyond current output.`); const content = value.snapshot[stream].slice(requestedOffset - retainedStartOffset, requestedOffset - retainedStartOffset + max); const nextOffset = requestedOffset + content.length; return { processId: id, stream, content, offset: requestedOffset, charsReturned: content.length, totalChars, retainedStartOffset, truncatedBefore: retainedStartOffset > 0, hasMore: nextOffset < totalChars, nextOffset, state: value.snapshot.state }; }
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
