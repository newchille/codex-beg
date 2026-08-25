import { contextBridge, ipcRenderer } from "electron";

const api = {
  status: () => ipcRenderer.invoke("agent:status"),
  restartAgentHost: () => ipcRenderer.invoke("agent:restart"),
  events: () => ipcRenderer.invoke("agent:events"),
  approvals: () => ipcRenderer.invoke("agent:approvals"),
  operations: () => ipcRenderer.invoke("agent:operations"),
  recovery: () => ipcRenderer.invoke("agent:recovery"),
  restore: (operationId: string) => ipcRenderer.invoke("agent:restore", operationId),
  approve: (approvalId: string) => ipcRenderer.invoke("agent:approve", approvalId),
  reject: (approvalId: string) => ipcRenderer.invoke("agent:reject", approvalId),
  workspaceList: () => ipcRenderer.invoke("workspace:list"),
  workspaceAdd: (kind: "machine_root" | "project" = "project") => ipcRenderer.invoke("workspace:add", kind),
  workspaceRegisterDirectory: (parentWorkspaceId: string) => ipcRenderer.invoke("workspace:register-directory", parentWorkspaceId),
  workspaceSelect: (workspaceId: string) => ipcRenderer.invoke("workspace:select", workspaceId),
  workspaceRemove: (workspaceId: string) => ipcRenderer.invoke("workspace:remove", workspaceId),
  doctor: () => ipcRenderer.invoke("doctor:run"),
  onLog: (listener: (line: string) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value); ipcRenderer.on("agent:log", handler); return () => ipcRenderer.removeListener("agent:log", handler); },
};

contextBridge.exposeInMainWorld("codexBeg", api);
