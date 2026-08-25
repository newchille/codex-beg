import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentHost: ChildProcess | null = null;
let restartAttempts = 0;
let stopping = false;
let restartTimer: NodeJS.Timeout | undefined;
let quitting = false;
const execFileAsync = promisify(execFile);
const adminToken = randomBytes(32).toString("hex");

function hostScript(): string {
  if (app.isPackaged) return join(process.resourcesPath, "agent-host", "main.js");
  return resolve(here, "../../agent-host/dist/main.js");
}

function startAgentHost(): void {
  if (quitting || stopping || agentHost) return;
  const script = hostScript();
  if (!existsSync(script)) return;
  agentHost = spawn(process.execPath, [script], {
    cwd: resolve(here, "../.."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_BEG_DATA_DIR: app.getPath("userData"), CODEX_BEG_MCP_PORT: "43123", CODEX_BEG_ADMIN_TOKEN_STDIN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  agentHost.stdin?.end(adminToken);
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

async function waitForAgentHostExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    const onExit = () => { if (!settled) { settled = true; clearTimeout(timer); resolveExit(true); } };
    const timer = setTimeout(() => { if (!settled) { settled = true; child.removeListener("exit", onExit); resolveExit(false); } }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function restartAgentHost(): Promise<{ running: boolean; error?: string }> {
  if (quitting) return { running: Boolean(agentHost), error: "Application is quitting." };
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
  const child = agentHost; stopping = true;
  if (child) { child.kill("SIGTERM"); const exited = await waitForAgentHostExit(child, 6_000); if (!exited) { stopping = false; return { running: Boolean(agentHost), error: "Agent Host did not stop within 6 seconds." }; } }
  if (quitting) { stopping = true; return { running: false, error: "Application is quitting." }; }
  agentHost = null; restartAttempts = 0; stopping = false; startAgentHost();
  return agentHost ? { running: true } : { running: false, error: "Agent Host could not be started." };
}

async function fetchJson(path: string): Promise<unknown> {
  try { const response = await fetch(`http://127.0.0.1:43123${path}`, { headers: { "x-codex-beg-admin-token": adminToken } }); return await response.json(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  try { const response = await fetch(`http://127.0.0.1:43123${path}`, { method: "POST", headers: { "content-type": "application/json", "x-codex-beg-admin-token": adminToken }, body: JSON.stringify(body) }); return response.status === 204 ? null : await response.json(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function chooseWorkspaceDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function addPickedWorkspace(kind: "machine_root" | "project" = "project"): Promise<unknown> {
  const rootPath = await chooseWorkspaceDirectory();
  if (!rootPath) return null;
  return postJson("/admin/workspace/add", { rootPath, kind });
}

async function registerPickedChildWorkspace(parentWorkspaceId: string): Promise<unknown> {
  const rootPath = await chooseWorkspaceDirectory();
  if (!rootPath) return null;
  return registerWorkspaceDirectory(parentWorkspaceId, rootPath);
}

async function registerWorkspaceDirectory(parentWorkspaceId: string, rootPath: string): Promise<unknown> {
  const state = await fetchJson("/admin/state") as { workspaces?: Array<{ id: string; canonicalRoot: string }> };
  const parent = state.workspaces?.find((workspace) => workspace.id === parentWorkspaceId);
  if (!parent) return { error: `Unknown parent workspace: ${parentWorkspaceId}` };
  const childPath = relative(parent.canonicalRoot, rootPath);
  if (!childPath || childPath === "." || isAbsolute(childPath) || childPath.split(/[\\/]/).includes("..")) return { error: "Selected directory must be a child of the machine root." };
  return postJson("/admin/workspace/register", { parentWorkspaceId, path: childPath });
}

async function checkExecutable(executable: string, args = ["--version"]): Promise<{ available: boolean; output?: string; error?: string }> {
  try { const result = await execFileAsync(executable, args, { timeout: 10_000 }); return { available: true, output: `${result.stdout}${result.stderr}`.trim() }; }
  catch (error) { const value = error as { stdout?: string; stderr?: string; message?: string }; const output = `${value.stdout ?? ""}${value.stderr ?? ""}`.trim(); const result: { available: boolean; output?: string; error?: string } = { available: false }; if (output) result.output = output; if (value.message) result.error = value.message; return result; }
}

interface ApprovalSummary { approvalId: string; action: string; exactOperation: string; risk: string; classification: string; status: string }
async function approveWithNativeConfirmation(approvalId: string): Promise<unknown> {
  const approvals = await fetchJson("/admin/approvals");
  if (!Array.isArray(approvals)) return { error: "Approval queue is unavailable." };
  const approval = (approvals as ApprovalSummary[]).find((item) => item.approvalId === approvalId && item.status === "pending");
  if (!approval) return { error: "Approval is no longer pending." };
  const decision = await dialog.showMessageBox({ type: "warning", buttons: ["Cancel", "Approve once"], defaultId: 0, cancelId: 0, noLink: true, message: approval.action, detail: `Classification: ${approval.classification}\n\nOperation:\n${approval.exactOperation}\n\nRisk:\n${approval.risk}` });
  if (decision.response !== 1) return { approvalId, status: "cancelled" };
  return postJson(`/admin/approval/approve/${encodeURIComponent(approvalId)}`, {});
}
function registerIpc(): void {
  ipcMain.handle("agent:status", async () => ({ running: Boolean(agentHost), health: await fetchJson("/healthz"), events: await fetchJson("/events") }));
  ipcMain.handle("agent:restart", async () => restartAgentHost());
  ipcMain.handle("agent:events", async () => fetchJson("/events"));
  ipcMain.handle("agent:approvals", async () => fetchJson("/admin/approvals"));
  ipcMain.handle("agent:operations", async () => fetchJson("/admin/operations"));
  ipcMain.handle("agent:recovery", async () => fetchJson("/admin/recovery"));
  ipcMain.handle("agent:restore", async (_event, operationId: string) => postJson(`/admin/recovery/restore/${encodeURIComponent(operationId)}`, {}));
  ipcMain.handle("agent:approve", async (_event, approvalId: string) => approveWithNativeConfirmation(approvalId));
  ipcMain.handle("agent:reject", async (_event, approvalId: string) => postJson(`/admin/approval/reject/${encodeURIComponent(approvalId)}`, {}));
  ipcMain.handle("workspace:list", async () => fetchJson("/admin/state"));
  ipcMain.handle("workspace:add", async (_event, kind: "machine_root" | "project" = "project") => addPickedWorkspace(kind));
  ipcMain.handle("workspace:register-directory", async (_event, parentWorkspaceId: string) => registerPickedChildWorkspace(parentWorkspaceId));
  ipcMain.handle("workspace:select", async (_event, workspaceId: string) => postJson("/admin/workspace/select", { workspaceId }));
  ipcMain.handle("workspace:remove", async (_event, workspaceId: string) => postJson(`/admin/workspace/remove/${encodeURIComponent(workspaceId)}`, {}));
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
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 640, webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Codex BEG preload failed (${preloadPath}): ${error.message}`);
  });
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
