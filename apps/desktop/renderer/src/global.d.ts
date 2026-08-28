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

interface TunnelConfigView {
  tunnelId: string;
  hasApiKey: boolean;
  secureStorageAvailable: boolean;
  validation: {
    state: "unconfigured" | "checking" | "valid" | "invalid";
    message: string;
    checkedAt?: string;
  };
}

interface CodexBegApi {
  status: () => Promise<{ running: boolean; health: unknown; tunnel: TunnelRuntimeStatus; checkedAt: string }>;
  tunnelStatus: () => Promise<TunnelRuntimeStatus>;
  tunnelConfig: () => Promise<TunnelConfigView>;
  tunnelSaveConfig: (input: { tunnelId: string; apiKey: string }) => Promise<TunnelConfigView>;
  tunnelValidateConfig: () => Promise<TunnelConfigView>;
  tunnelStart: () => Promise<{ status: TunnelRuntimeStatus; config: TunnelConfigView; error?: string }>;
  tunnelStop: () => Promise<{ status: TunnelRuntimeStatus; error?: string }>;
  restartAgentHost: () => Promise<{ running: boolean; error?: string }>;
  events: () => Promise<unknown>;
  activity: () => Promise<unknown>;
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
  onTunnelStatus: (listener: (value: TunnelRuntimeStatus) => void) => () => void;
  onTunnelConfig: (listener: (value: TunnelConfigView) => void) => () => void;
}

declare global { interface Window { codexBeg: CodexBegApi } }
export {};
