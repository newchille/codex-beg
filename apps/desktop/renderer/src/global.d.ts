interface CodexBegApi {
  status: () => Promise<{ running: boolean; health: unknown; events: unknown }>;
  restartAgentHost: () => Promise<{ running: boolean; error?: string }>;
  events: () => Promise<unknown>;
  approvals: () => Promise<unknown>;
  operations: () => Promise<unknown>;
  recovery: () => Promise<unknown>;
  restore: (operationId: string) => Promise<unknown>;
  approve: (approvalId: string) => Promise<unknown>;
  reject: (approvalId: string) => Promise<unknown>;
  workspaceList: () => Promise<unknown>;
  workspaceAdd: (kind?: "machine_root" | "project") => Promise<unknown>;
  workspaceRegisterDirectory: (parentWorkspaceId: string) => Promise<unknown>;
  workspaceSelect: (workspaceId: string) => Promise<unknown>;
  workspaceRemove: (workspaceId: string) => Promise<unknown>;
  doctor: () => Promise<Record<string, unknown>>;
  onLog: (listener: (line: string) => void) => () => void;
}

declare global { interface Window { codexBeg: CodexBegApi } }
export {};
