import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentHost: ChildProcess | null = null;
let restartAttempts = 0;
let stopping = false;
let restartTimer: NodeJS.Timeout | undefined;
let quitting = false;
const execFileAsync = promisify(execFile);

function hostScript(): string {
  if (app.isPackaged) return join(process.resourcesPath, "agent-host", "main.js");
  return resolve(here, "../../agent-host/dist/main.js");
}

function startAgentHost(): void {
  if (stopping || agentHost) return;
  const script = hostScript();
  if (!existsSync(script)) return;
  agentHost = spawn(process.execPath, [script], {
    cwd: resolve(here, "../.."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_BEG_DATA_DIR: app.getPath("userData"), CODEX_BEG_MCP_PORT: "43123" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  agentHost.stderr?.on("data", (chunk: Buffer) => mainWindow?.webContents.send("agent:log", chunk.toString("utf8")));
  agentHost.on("exit", () => {
    agentHost = null;
    mainWindow?.webContents.send("agent:status", { running: false });
    if (!stopping && restartAttempts < 3) {
      const delay = 500 * (2 ** restartAttempts);
      restartAttempts += 1;
      restartTimer = setTimeout(() => { restartTimer = undefined; startAgentHost(); }, delay);
    }
  });
}

async function fetchJson(path: string): Promise<unknown> {
  try { const response = await fetch(`http://127.0.0.1:43123${path}`); return await response.json(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  try { const response = await fetch(`http://127.0.0.1:43123${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return response.status === 204 ? null : await response.json(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function checkExecutable(executable: string, args = ["--version"]): Promise<{ available: boolean; output?: string; error?: string }> {
  try { const result = await execFileAsync(executable, args, { timeout: 10_000 }); return { available: true, output: `${result.stdout}${result.stderr}`.trim() }; }
  catch (error) { const value = error as { stdout?: string; stderr?: string; message?: string }; const output = `${value.stdout ?? ""}${value.stderr ?? ""}`.trim(); const result: { available: boolean; output?: string; error?: string } = { available: false }; if (output) result.output = output; if (value.message) result.error = value.message; return result; }
}

function registerIpc(): void {
  ipcMain.handle("agent:status", async () => ({ running: Boolean(agentHost), health: await fetchJson("/healthz"), events: await fetchJson("/events") }));
  ipcMain.handle("agent:events", async () => fetchJson("/events"));
  ipcMain.handle("agent:approvals", async () => fetchJson("/admin/approvals"));
  ipcMain.handle("agent:approve", async (_event, approvalId: string) => postJson(`/admin/approval/approve/${encodeURIComponent(approvalId)}`, {}));
  ipcMain.handle("agent:reject", async (_event, approvalId: string) => postJson(`/admin/approval/reject/${encodeURIComponent(approvalId)}`, {}));
  ipcMain.handle("workspace:list", async () => fetchJson("/admin/state"));
  ipcMain.handle("workspace:add", async (_event, rootPath: string) => postJson("/admin/workspace/add", { rootPath }));
  ipcMain.handle("workspace:select", async (_event, workspaceId: string) => postJson("/admin/workspace/select", { workspaceId }));
  ipcMain.handle("workspace:remove", async (_event, workspaceId: string) => postJson(`/admin/workspace/remove/${encodeURIComponent(workspaceId)}`, {}));
  ipcMain.handle("dialog:choose-directory", async () => { const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return result.canceled ? null : result.filePaths[0] ?? null; });
  ipcMain.handle("doctor:run", async () => {
    let tunnel: unknown = { status: "not_found", message: "tunnel-client is not on PATH" };
    try { const result = await execFileAsync("tunnel-client", ["doctor", "--profile", "codex-beg", "--explain"], { timeout: 15_000 }); tunnel = { status: "ok", output: `${result.stdout}${result.stderr}`.slice(-16_000) }; }
    catch (error) { const value = error as { code?: string | number; stdout?: string; stderr?: string; message?: string }; tunnel = { status: "unavailable", code: value.code, output: `${value.stdout ?? ""}${value.stderr ?? ""}${value.message ?? ""}`.slice(-16_000) }; }
    return {
      node: { available: true, output: process.versions.node },
      git: await checkExecutable(process.platform === "win32" ? "git.exe" : "git"),
      npm: await checkExecutable(process.platform === "win32" ? "npm.cmd" : "npm"),
      pnpm: await checkExecutable(process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      electron: process.versions.electron,
      platform: process.platform,
      agentHost: Boolean(agentHost),
      mcp: await fetchJson("/healthz"),
      workspace: await fetchJson("/admin/state"),
      policy: "central policy engine active",
      processManager: "managed child processes only",
      tunnel,
    };
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 640, webPreferences: { preload: join(here, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(join(here, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => { registerIpc(); startAgentHost(); await createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (!agentHost || quitting) return;
  event.preventDefault();
  quitting = true;
  const child = agentHost;
  const finish = () => { agentHost = null; app.quit(); };
  child.once("exit", finish);
  child.kill("SIGTERM");
  setTimeout(finish, 6_000).unref();
});
