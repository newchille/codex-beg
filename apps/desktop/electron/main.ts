import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTrayMenuState,
  trayMenuStateEqual,
  TRAY_ACTION_MENU_ID,
  TRAY_STATUS_MENU_ID,
  updateTrayMenuItems,
  type TrayMenuState,
} from "./tray-menu.js";

const here = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayMenu: Menu | null = null;
let latestTrayStatus: TunnelRuntimeStatus | undefined;
let appliedTrayMenuState: TrayMenuState | undefined;
let trayMenuOpen = false;
let pendingTrayMenuState: TrayMenuState | undefined;
let trayTunnelActionRunning = false;
let tunnelAutoStartRunning = false;
let tunnelAutoStartTask: Promise<void> | undefined;
let agentHost: ChildProcess | null = null;
let restartAttempts = 0;
let stopping = false;
let restartTimer: NodeJS.Timeout | undefined;
let tunnelMonitorTimer: NodeJS.Timeout | undefined;
let quitting = false;
const execFileAsync = promisify(execFile);
const adminToken = randomBytes(32).toString("hex");
const TUNNEL_ALIAS = "codex-beg";
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const TRAY_ICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAJKADAAQAAAABAAAAJAAAAAAJxsHGAAAAoklEQVRYCe3SIQ7AIBQD0A8Z4VokCC7KIbgNigNgMIhtmWtSz0RxrfnNC+5+n/3oXWstq7Va791KKZZSOjrPjzEshGBzzm/U0TXvcbf3vltr5r23nLPFGI9ucn/7Q/4oBzmuQQQFKgkBBwkSIihQSQg4SJAQQYFKQsBBgoQIClQSAg4SJERQoJIQcJAgIYIClYSAgwQJERSoJAQcJEiIoED1AEo1IGrHC658AAAAAElFTkSuQmCC";
interface TunnelRuntimeStatus {
  alias: string;
  installed: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  runtimeState: string;
  tunnelId?: string;
  uiUrl?: string;
  executable?: string;
  error?: string;
  checkedAt: string;
}

type TunnelValidationState = "unconfigured" | "checking" | "valid" | "invalid";

interface TunnelValidation {
  state: TunnelValidationState;
  message: string;
  checkedAt?: string;
}

interface StoredTunnelConfig {
  tunnelId: string;
  apiKeyCiphertext: string;
  updatedAt: string;
}

interface TunnelConfigView {
  tunnelId: string;
  hasApiKey: boolean;
  secureStorageAvailable: boolean;
  validation: TunnelValidation;
}

interface TunnelConfigSecret extends TunnelConfigView {
  apiKey: string;
}

let tunnelValidation: TunnelValidation = { state: "unconfigured", message: "Add your Tunnel ID and Runtime API key." };

function emitLog(message: string): void {
  mainWindow?.webContents.send("agent:log", `[${new Date().toLocaleTimeString()}] ${message}`);
}

function emitTunnelStatus(status: TunnelRuntimeStatus): void {
  mainWindow?.webContents.send("tunnel:status-changed", status);
  updateTrayMenu(status);
}

function emitTunnelConfig(config: TunnelConfigView): void {
  mainWindow?.webContents.send("tunnel:config-changed", config);
}

function tunnelConfigPath(): string {
  return join(app.getPath("userData"), "tunnel-config.json");
}

function redactedError(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1_000);
}

function runtimeEnvironment(apiKey: string, tunnelId: string): NodeJS.ProcessEnv {
  const { OPENAI_ADMIN_KEY: _adminKey, OPENAI_API_KEY: _fallbackKey, ...baseEnv } = process.env;
  return { ...baseEnv, CONTROL_PLANE_API_KEY: apiKey, CONTROL_PLANE_TUNNEL_ID: tunnelId };
}

async function readStoredTunnelConfig(): Promise<StoredTunnelConfig | undefined> {
  try {
    const raw = await readFile(tunnelConfigPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Partial<StoredTunnelConfig>;
    if (typeof value.tunnelId !== "string" || typeof value.apiKeyCiphertext !== "string" || typeof value.updatedAt !== "string") return undefined;
    return { tunnelId: value.tunnelId, apiKeyCiphertext: value.apiKeyCiphertext, updatedAt: value.updatedAt };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return undefined;
  }
}

async function tunnelConfigView(): Promise<TunnelConfigView> {
  const stored = await readStoredTunnelConfig();
  return {
    tunnelId: stored?.tunnelId ?? "",
    hasApiKey: Boolean(stored?.apiKeyCiphertext),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    validation: tunnelValidation,
  };
}

async function loadTunnelConfigSecret(): Promise<TunnelConfigSecret | undefined> {
  const stored = await readStoredTunnelConfig();
  if (!stored) return undefined;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this Mac.");
  const apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyCiphertext, "base64"));
  return { tunnelId: stored.tunnelId, apiKey, hasApiKey: Boolean(apiKey), secureStorageAvailable: true, validation: tunnelValidation };
}

async function persistTunnelConfig(tunnelId: string, apiKey: string): Promise<TunnelConfigView> {
  const normalizedTunnelId = tunnelId.trim();
  if (!TUNNEL_ID_PATTERN.test(normalizedTunnelId)) throw new Error("Tunnel ID must match tunnel_<32 lowercase hex characters>.");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable; API key was not saved.");

  const existing = await readStoredTunnelConfig();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey && !existing?.apiKeyCiphertext) throw new Error("Runtime API key is required.");

  const apiKeyCiphertext = normalizedApiKey
    ? safeStorage.encryptString(normalizedApiKey).toString("base64")
    : existing!.apiKeyCiphertext;
  const value: StoredTunnelConfig = { tunnelId: normalizedTunnelId, apiKeyCiphertext, updatedAt: new Date().toISOString() };
  const path = tunnelConfigPath();
  const tempPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  tunnelValidation = { state: "unconfigured", message: "Saved. Verify the credentials before starting the tunnel." };
  const view = await tunnelConfigView();
  emitTunnelConfig(view);
  return view;
}

async function validateTunnelConfig(): Promise<TunnelConfigView> {
  tunnelValidation = { state: "checking", message: "Checking Tunnel ID and Runtime API key…" };
  emitTunnelConfig(await tunnelConfigView());
  try {
    const config = await loadTunnelConfigSecret();
    if (!config) throw new Error("Save a Tunnel ID and Runtime API key first.");
    if (!TUNNEL_ID_PATTERN.test(config.tunnelId)) throw new Error("Tunnel ID format is invalid.");
    if (!config.apiKey) throw new Error("Runtime API key is missing.");
    const executable = findTunnelClient();
    if (!executable) throw new Error("tunnel-client is not installed or could not be found.");

    const result = await execFileAsync(executable, ["admin", "--json", "tunnels", "get", config.tunnelId], {
      timeout: 15_000,
      env: runtimeEnvironment(config.apiKey, config.tunnelId),
    });
    const payload = parseJsonObject(result.stdout);
    const returnedTunnelId = typeof payload?.id === "string"
      ? payload.id
      : typeof payload?.tunnel_id === "string"
        ? payload.tunnel_id
        : config.tunnelId;
    if (returnedTunnelId !== config.tunnelId) throw new Error("The returned tunnel does not match the saved Tunnel ID.");

    tunnelValidation = { state: "valid", message: "Credentials verified. Ready to start.", checkedAt: new Date().toISOString() };
    emitLog("Tunnel credentials verified.");
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const raw = `${detail.stderr ?? ""}\n${detail.stdout ?? ""}\n${detail.message ?? ""}`.trim();
    const message = /\b(401|403)\b/.test(raw)
      ? "API key or tunnel access is invalid. Check Tunnels Read permission and the Tunnel ID."
      : redactedError(raw || "Tunnel configuration could not be verified.");
    tunnelValidation = { state: "invalid", message, checkedAt: new Date().toISOString() };
    emitLog(`Tunnel credential check failed: ${message}`);
  }
  const view = await tunnelConfigView();
  emitTunnelConfig(view);
  return view;
}

let tunnelStatusCache: { at: number; value: TunnelRuntimeStatus } | undefined;

function findTunnelClient(): string | undefined {
  const names = process.platform === "win32" ? ["tunnel-client.exe", "tunnel-client.cmd", "tunnel-client"] : ["tunnel-client"];
  const candidates: string[] = [];
  const configured = process.env.TUNNEL_CLIENT_BIN?.trim();
  if (configured) candidates.push(isAbsolute(configured) ? configured : resolve(configured));
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(join(directory, name));
  }
  if (process.platform !== "win32") {
    for (const directory of [join(homedir(), "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
      candidates.push(join(directory, "tunnel-client"));
    }
  }
  return [...new Set(candidates)].find((candidate) => existsSync(candidate));
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTunnelStatus(executable: string, payload: Record<string, unknown> | undefined, error?: string): TunnelRuntimeStatus {
  const processRunning = payload?.process_running === true;
  const healthy = payload?.healthy === true;
  const ready = payload?.ready === true;
  const reportedState = typeof payload?.runtime_state === "string" ? payload.runtime_state : undefined;
  let runtimeState = reportedState ?? "stopped";
  if (processRunning && ready) runtimeState = "ready";
  else if (processRunning && healthy) runtimeState = "healthy";
  else if (processRunning) runtimeState = "running";
  return {
    alias: "codex-beg",
    installed: true,
    processRunning,
    healthy,
    ready,
    runtimeState,
    ...(typeof payload?.tunnel_id === "string" ? { tunnelId: payload.tunnel_id } : {}),
    ...(typeof payload?.ui_url === "string" ? { uiUrl: payload.ui_url } : {}),
    executable,
    ...(error ? { error: error.slice(0, 800) } : {}),
    checkedAt: new Date().toISOString(),
  };
}

async function tunnelRuntimeStatus(force = false): Promise<TunnelRuntimeStatus> {
  const now = Date.now();
  if (!force && tunnelStatusCache && now - tunnelStatusCache.at < 1_500) return tunnelStatusCache.value;
  const executable = findTunnelClient();
  if (!executable) {
    const value: TunnelRuntimeStatus = { alias: "codex-beg", installed: false, processRunning: false, healthy: false, ready: false, runtimeState: "not_installed", error: "tunnel-client was not found. Set TUNNEL_CLIENT_BIN or install it on PATH.", checkedAt: new Date().toISOString() };
    tunnelStatusCache = { at: now, value };
    return value;
  }
  try {
    const result = await execFileAsync(executable, ["runtimes", "status", "codex-beg", "--json"], { timeout: 5_000 });
    const payload = parseJsonObject(result.stdout);
    const value = payload
      ? normalizeTunnelStatus(executable, payload)
      : normalizeTunnelStatus(executable, { runtime_state: "unknown" }, "tunnel-client returned invalid JSON status output.");
    tunnelStatusCache = { at: now, value };
    return value;
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const payload = parseJsonObject(detail.stdout);
    const message = `${detail.stderr ?? ""}${detail.message ?? ""}`.trim() || (typeof payload?.error === "string" ? payload.error : "Tunnel runtime status is unavailable.");
    const value = normalizeTunnelStatus(executable, payload, message);
    tunnelStatusCache = { at: now, value };
    return value;
  }
}

async function startTunnel(): Promise<{ status: TunnelRuntimeStatus; config: TunnelConfigView; error?: string }> {
  const configView = await validateTunnelConfig();
  if (configView.validation.state !== "valid") {
    return { status: await tunnelRuntimeStatus(true), config: configView, error: configView.validation.message };
  }

  try {
    const config = await loadTunnelConfigSecret();
    if (!config) throw new Error("Tunnel configuration is missing.");
    const executable = findTunnelClient();
    if (!executable) throw new Error("tunnel-client is not installed or could not be found.");

    emitLog("Starting secure tunnel…");
    await execFileAsync(executable, [
      "runtimes", "connect",
      "--alias", TUNNEL_ALIAS,
      "--tunnel-id", config.tunnelId,
      "--runtime-api-key", "env:CONTROL_PLANE_API_KEY",
      "--mcp-server-url", "http://127.0.0.1:43123/mcp",
      "--json",
    ], {
      timeout: 60_000,
      env: runtimeEnvironment(config.apiKey, config.tunnelId),
    });

    tunnelStatusCache = undefined;
    const status = await tunnelRuntimeStatus(true);
    emitTunnelStatus(status);
    emitLog(status.ready ? "Secure tunnel is ready." : `Tunnel started with state: ${status.runtimeState}.`);
    return { status, config: await tunnelConfigView() };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const raw = `${detail.stderr ?? ""}\n${detail.stdout ?? ""}\n${detail.message ?? ""}`.trim();
    const message = redactedError(raw || "Tunnel could not be started.");
    if (/\b(401|403)\b/.test(raw)) {
      tunnelValidation = { state: "invalid", message: "The saved key can see the tunnel but cannot start it. Check Tunnels Use permission.", checkedAt: new Date().toISOString() };
    }
    emitLog(`Tunnel start failed: ${message}`);
    const config = await tunnelConfigView();
    emitTunnelConfig(config);
    tunnelStatusCache = undefined;
    const status = await tunnelRuntimeStatus(true);
    emitTunnelStatus(status);
    return { status, config, error: message };
  }
}

async function waitForAgentHostReady(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchJson("/healthz") as { ok?: boolean };
    if (health?.ok === true) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function startTunnelOnLaunch(): Promise<void> {
  if (quitting || tunnelAutoStartRunning) return;
  const config = await tunnelConfigView();
  if (!config.hasApiKey || !config.tunnelId) return;

  const currentStatus = await tunnelRuntimeStatus(true);
  if (!currentStatus.installed || currentStatus.processRunning) return;

  tunnelAutoStartRunning = true;
  try {
    const validated = await validateTunnelConfig();
    if (validated.validation.state !== "valid") return;
    if (!await waitForAgentHostReady()) {
      emitLog("Secure tunnel auto-start skipped because Agent Host is not ready.");
      return;
    }
    if (quitting) return;
    const refreshedStatus = await tunnelRuntimeStatus(true);
    if (refreshedStatus.processRunning) return;
    const result = await startTunnel();
    if (result.error) emitLog(`Secure tunnel auto-start failed: ${result.error}`);
  } finally {
    tunnelAutoStartRunning = false;
  }
}

async function stopTunnel(): Promise<{ status: TunnelRuntimeStatus; error?: string }> {
  const executable = findTunnelClient();
  if (!executable) {
    const status = await tunnelRuntimeStatus(true);
    return { status, error: "tunnel-client is not installed or could not be found." };
  }
  try {
    emitLog("Stopping secure tunnel…");
    await execFileAsync(executable, ["runtimes", "stop", TUNNEL_ALIAS, "--json"], { timeout: 20_000 });
    emitLog("Secure tunnel stopped.");
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const message = redactedError(`${detail.stderr ?? ""}\n${detail.stdout ?? ""}\n${detail.message ?? ""}`.trim() || "Tunnel could not be stopped.");
    emitLog(`Tunnel stop failed: ${message}`);
    tunnelStatusCache = undefined;
    const status = await tunnelRuntimeStatus(true);
    emitTunnelStatus(status);
    return { status, error: message };
  }
  tunnelStatusCache = undefined;
  const status = await tunnelRuntimeStatus(true);
  emitTunnelStatus(status);
  return { status };
}

function showMainWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (process.platform === "darwin") void app.dock?.show();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow(): void {
  mainWindow?.hide();
  if (process.platform === "darwin") void app.dock?.hide();
}

function updateTrayMenu(status?: TunnelRuntimeStatus): void {
  latestTrayStatus = status;
  if (!tray) return;
  const state = getTrayMenuState(status, tunnelValidation.state);
  if (appliedTrayMenuState && trayMenuStateEqual(appliedTrayMenuState, state)) return;

  if (trayMenuOpen) {
    pendingTrayMenuState = state;
    return;
  }

  applyTrayMenuState(state);
}

function applyTrayMenuState(state: TrayMenuState): void {
  if (!tray) return;

  tray.setToolTip(state.tooltip);
  const menu = Menu.buildFromTemplate([
    { label: "Open Codex BEG", click: showMainWindow },
    { type: "separator" },
    { id: TRAY_STATUS_MENU_ID, label: "Tunnel: Checking…", enabled: false },
    {
      id: TRAY_ACTION_MENU_ID,
      label: "Start Tunnel",
      enabled: false,
      click: () => {
        if (trayTunnelActionRunning || tunnelAutoStartRunning) return;
        const currentStatus = latestTrayStatus;
        if (!currentStatus?.installed || tunnelValidation.state !== "valid") return;
        trayTunnelActionRunning = true;
        const action = currentStatus.processRunning ? stopTunnel() : startTunnel();
        void action.then((result) => {
          if (result.error) {
            emitLog(result.error);
            showMainWindow();
          }
        }).finally(() => {
          trayTunnelActionRunning = false;
          updateTrayMenu(latestTrayStatus);
        });
      },
    },
    { type: "separator" },
    { label: "Quit Codex BEG", click: () => app.quit() },
  ]);
  updateTrayMenuItems(menu, state);
  menu.on("menu-will-show", () => {
    trayMenuOpen = true;
  });
  menu.on("menu-will-close", () => {
    trayMenuOpen = false;
    const pendingState = pendingTrayMenuState;
    pendingTrayMenuState = undefined;
    if (pendingState) {
      setImmediate(() => {
        if (trayMenuOpen) {
          pendingTrayMenuState = pendingState;
          return;
        }
        applyTrayMenuState(pendingState);
      });
    }
  });
  trayMenu = menu;
  tray.setContextMenu(menu);
  appliedTrayMenuState = state;
}

function createTray(): void {
  if (tray) return;
  const templatePath = join(app.getAppPath(), "electron/trayIconTemplate.png");
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, "base64"), { scaleFactor: 2 });
  const imageSource = existsSync(templatePath) ? templatePath : image;
  if (typeof imageSource !== "string" && imageSource.isEmpty()) throw new Error("Codex BEG tray icon could not be decoded.");
  if (typeof imageSource !== "string") imageSource.setTemplateImage(true);
  tray = new Tray(imageSource, "31d13e44-7df7-4b77-83d1-3c24d9e4d3db");
  updateTrayMenu();
}

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
  agentHost.stdout?.on("data", (chunk: Buffer) => emitLog(chunk.toString("utf8").trimEnd()));
  agentHost.stderr?.on("data", (chunk: Buffer) => emitLog(chunk.toString("utf8").trimEnd()));
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
  ipcMain.handle("agent:status", async () => {
    const [health, tunnel] = await Promise.all([fetchJson("/healthz"), tunnelRuntimeStatus()]);
    updateTrayMenu(tunnel);
    return { running: Boolean(agentHost), health, tunnel, checkedAt: new Date().toISOString() };
  });
  ipcMain.handle("tunnel:status", async () => tunnelRuntimeStatus(true));
  ipcMain.handle("tunnel:config", async () => tunnelConfigView());
  ipcMain.handle("tunnel:config-save", async (_event, input: { tunnelId: string; apiKey: string }) => persistTunnelConfig(input.tunnelId, input.apiKey));
  ipcMain.handle("tunnel:config-validate", async () => validateTunnelConfig());
  ipcMain.handle("tunnel:start", async () => startTunnel());
  ipcMain.handle("tunnel:stop", async () => stopTunnel());
  ipcMain.handle("agent:events", async () => fetchJson("/events"));
  ipcMain.handle("agent:restart", async () => restartAgentHost());
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
    const tunnel = await tunnelRuntimeStatus(true);
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
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 1280, maxWidth: 1280, minHeight: 820, maxHeight: 820, resizable: false, maximizable: false, fullscreenable: false, webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Codex BEG preload failed (${preloadPath}): ${error.message}`);
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.meta && input.key.toLowerCase() === "q") {
      event.preventDefault();
      hideMainWindow();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await mainWindow.loadFile(join(here, "index.html"));
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideMainWindow();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") return;

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Codex BEG",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit Codex BEG", accelerator: "Command+Q", click: hideMainWindow },
      ],
    },
    { label: "File", submenu: [{ role: "close" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
    { label: "Help", submenu: [] },
  ]));
}

app.whenReady().then(async () => {
  installApplicationMenu();
  registerIpc();
  startAgentHost();
  await createWindow();
  createTray();
  const status = await tunnelRuntimeStatus(true);
  emitTunnelStatus(status);
  tunnelMonitorTimer = setInterval(() => { void tunnelRuntimeStatus(true).then(emitTunnelStatus); }, 2_000);
  tunnelMonitorTimer.unref();
  const config = await tunnelConfigView();
  emitTunnelConfig(config);
  if (config.hasApiKey && config.tunnelId) {
    tunnelAutoStartTask = startTunnelOnLaunch().finally(() => {
      tunnelAutoStartTask = undefined;
    });
  }
  app.on("activate", () => {
    if (!mainWindow) void createWindow();
  });
});
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (tunnelMonitorTimer) clearInterval(tunnelMonitorTimer);
  void (async () => {
    if (tunnelAutoStartTask) await tunnelAutoStartTask;
    const tunnel = await tunnelRuntimeStatus(true);
    if (tunnel.processRunning) {
      const stoppedTunnel = await stopTunnel();
      if (stoppedTunnel.error || stoppedTunnel.status.processRunning) {
        quitting = false;
        stopping = false;
        dialog.showErrorBox("Codex BEG is still running", "The secure tunnel did not stop cleanly. Try Quit again after checking Connection.");
        return;
      }
    }

    const child = agentHost;
    if (child) {
      child.kill("SIGTERM");
      const exited = await waitForAgentHostExit(child, 6_000);
      if (!exited) {
        quitting = false;
        stopping = false;
        dialog.showErrorBox("Codex BEG is still running", "The local agent did not stop cleanly. Try Quit again after checking Diagnostics.");
        return;
      }
    }
    agentHost = null;
    app.quit();
  })();
});
