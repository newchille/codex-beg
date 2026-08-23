import { contextBridge, ipcRenderer } from "electron";

const api = {
  status: () => ipcRenderer.invoke("agent:status"),
  events: () => ipcRenderer.invoke("agent:events"),
  approvals: () => ipcRenderer.invoke("agent:approvals"),
  approve: (approvalId: string) => ipcRenderer.invoke("agent:approve", approvalId),
  reject: (approvalId: string) => ipcRenderer.invoke("agent:reject", approvalId),
  workspaceList: () => ipcRenderer.invoke("workspace:list"),
  workspaceAdd: (rootPath: string) => ipcRenderer.invoke("workspace:add", rootPath),
  workspaceSelect: (workspaceId: string) => ipcRenderer.invoke("workspace:select", workspaceId),
  workspaceRemove: (workspaceId: string) => ipcRenderer.invoke("workspace:remove", workspaceId),
  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-directory"),
  doctor: () => ipcRenderer.invoke("doctor:run"),
  onLog: (listener: (line: string) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value); ipcRenderer.on("agent:log", handler); return () => ipcRenderer.removeListener("agent:log", handler); },
};

contextBridge.exposeInMainWorld("codexBeg", api);
