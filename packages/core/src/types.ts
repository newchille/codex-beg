import { z } from "zod";

export const PROJECT_TYPES = {
  node: "node",
  flutter: "flutter",
  maven: "maven",
  gradle: "gradle",
  rust: "rust",
  go: "go",
  dotnet: "dotnet",
  unknown: "unknown",
} as const;

export type ProjectType = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];

export const OPERATION_CLASSES = {
  readOnly: "READ_ONLY",
  writeReversible: "WRITE_REVERSIBLE",
  process: "PROCESS",
  destructive: "DESTRUCTIVE",
  systemSensitive: "SYSTEM_SENSITIVE",
} as const;

export type OperationClass = (typeof OPERATION_CLASSES)[keyof typeof OPERATION_CLASSES];

export const COMMAND_NAMES = ["test", "lint", "typecheck", "build", "dev"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandSpec {
  executable: string;
  args: string[];
  timeoutSeconds?: number;
  script?: string;
}

export type CommandConfig = Partial<Record<CommandName, CommandSpec>>;

export interface Workspace {
  id: string;
  displayName: string;
  canonicalRoot: string;
  projectType: ProjectType;
  commands: CommandConfig;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryState {
  schemaVersion: 1;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
}

export interface OperationTarget {
  path: string;
  expectedSha256?: string;
}

export interface OperationRequest {
  operationId: string;
  source: "mcp" | "desktop";
  workspaceId: string;
  kind: string;
  executable?: string;
  arguments?: string[];
  targets: OperationTarget[];
  createdAt: string;
}

export interface ApprovalRequest {
  approvalId: string;
  nonce: string;
  operationId: string;
  operationHash: string;
  action: string;
  workspaceId: string;
  exactOperation: string;
  risk: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface OperationRecord {
  operationId: string;
  kind: string;
  status: "pending" | "running" | "succeeded" | "failed" | "approval_required" | "rejected";
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  approvalId?: string;
  result?: unknown;
  error?: string;
}

export interface FileChange {
  path: string;
  existed: boolean;
  beforeSha256?: string;
  afterSha256?: string;
  bytes: number;
}

export interface RecoveryManifest {
  operationId: string;
  workspaceId: string;
  createdAt: string;
  status: "captured" | "applied" | "restored" | "restore_conflict";
  changes: FileChange[];
}

export interface ProcessSnapshot {
  processId: string;
  workspaceId: string;
  executable: string;
  arguments: string[];
  startedAt: string;
  state: "starting" | "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export const WorkspaceAddInput = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  rootPath: z.string().min(1),
});

export const WorkspaceIdInput = z.object({ workspaceId: z.string().uuid() });

export const RelativePathInput = z.object({
  workspaceId: z.string().uuid(),
  path: z.string().min(1).max(4096),
});

export const ReadFileInput = RelativePathInput.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(512 * 1024).default(128 * 1024),
});

export const WriteFileInput = RelativePathInput.extend({
  content: z.string().max(1024 * 1024),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const ApplyPatchInput = z.object({
  workspaceId: z.string().uuid(),
  patch: z.string().min(1).max(1024 * 1024),
});

export const SearchInput = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1).max(500),
  path: z.string().max(4096).optional(),
  maxResults: z.number().int().min(1).max(200).default(200),
});

export const ProjectCommandInput = z.object({
  workspaceId: z.string().uuid(),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
});

export const ProcessIdInput = z.object({ processId: z.string().uuid() });

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
