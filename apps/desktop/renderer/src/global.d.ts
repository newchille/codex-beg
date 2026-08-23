interface CodexBegApi {
  status: () => Promise<{ running: boolean; health: unknown; events: unknown }>;
  events: () => Promise<unknown>;
  approvals: () => Promise<unknown>;
  approve: (approvalId: string) => Promise<unknown>;
  reject: (approvalId: string) => Promise<unknown>;
  workspaceList: () => Promise<unknown>;
  workspaceAdd: (rootPath: string) => Promise<unknown>;
  workspaceSelect: (workspaceId: string) => Promise<unknown>;
  workspaceRemove: (workspaceId: string) => Promise<unknown>;
  chooseDirectory: () => Promise<string | null>;
  doctor: () => Promise<Record<string, unknown>>;
  onLog: (listener: (line: string) => void) => () => void;
}

declare global { interface Window { codexBeg: CodexBegApi } }
export {};
