import { z } from "zod";

export const PROJECT_TYPES = {
  node: "node",
  flutter: "flutter",
  maven: "maven",
  gradle: "gradle",
  rust: "rust",
  go: "go",
  python: "python",
  dotnet: "dotnet",
  unknown: "unknown",
} as const;

export type ProjectType = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];

export const WORKSPACE_KINDS = { machineRoot: "machine_root", project: "project" } as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[keyof typeof WORKSPACE_KINDS];

export const OPERATION_CLASSES = {
  readOnly: "READ_ONLY",
  writeReversible: "WRITE_REVERSIBLE",
  process: "PROCESS",
  destructive: "DESTRUCTIVE",
  systemSensitive: "SYSTEM_SENSITIVE",
  capabilityGrant: "CAPABILITY_GRANT",
} as const;

export type OperationClass = (typeof OPERATION_CLASSES)[keyof typeof OPERATION_CLASSES];

export const COMMAND_NAMES = ["test", "lint", "typecheck", "build", "dev"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const CONTEXT_LIMITS = {
  readManyMaxFiles: 20,
  readManyDefaultFileBytes: 64 * 1024,
  readManyDefaultTotalBytes: 512 * 1024,
  readManyHardTotalBytes: 2 * 1024 * 1024,
  searchFilesDefaultMaxResults: 200,
  searchFilesMaxResults: 500,
  pageDefaultMaxResults: 100,
  pageMaxResults: 500,
} as const;

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
  kind: WorkspaceKind;
  parentWorkspaceId?: string;
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
  cwd?: string;
  environment?: Record<string, string>;
  timeoutSeconds?: number;
  initializeGit?: boolean;
  targets: OperationTarget[];
  createdAt: string;
}

export interface ApprovalRequest {
  classification: OperationClass;
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
  status: "pending" | "running" | "succeeded" | "failed" | "approval_required" | "rejected" | "interrupted";
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
  pid?: number;
  startedAt: string;
  state: "starting" | "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface CommandRunResult {
  commandId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
  offset: number;
  bytesReturned: number;
  totalBytes: number;
  truncated: boolean;
  nextOffset: number | null;
  sha256: string;
}

export interface ReadManyFileRequest {
  path: string;
  offset: number;
  limit: number;
  knownSha256?: string;
}

export interface ReadManyFileResult extends Partial<ReadFileResult> {
  path: string;
  unchanged?: boolean;
  error?: { code: string; message: string };
}

export interface ReadManyFilesResult {
  files: ReadManyFileResult[];
  totalBytesReturned: number;
  maxTotalBytes: number;
  truncated: boolean;
}

export interface SearchFileItem {
  path: string;
  kind: "file" | "directory";
  size?: number;
}

export interface SearchFilesResult {
  items: SearchFileItem[];
  truncated: boolean;
  nextOffset: number | null;
}

export const WorkspaceAddInput = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  rootPath: z.string().min(1),
  kind: z.enum([WORKSPACE_KINDS.machineRoot, WORKSPACE_KINDS.project]).default(WORKSPACE_KINDS.project),
});

export const WorkspaceIdInput = z.object({ workspaceId: z.string().uuid() });

export const WorkspaceRegisterInput = z.object({
  parentWorkspaceId: z.string().uuid(),
  path: z.string().min(1).max(4096),
  displayName: z.string().trim().min(1).max(120).optional(),
});

export const WorkspaceCreateInput = z.object({
  parentWorkspaceId: z.string().uuid(),
  path: z.string().min(1).max(4096),
  displayName: z.string().trim().min(1).max(120).optional(),
  initializeGit: z.boolean().default(false),
});

export const WorkspaceRefreshInput = z.object({ workspaceId: z.string().uuid() });

export const RelativePathInput = z.object({
  workspaceId: z.string().uuid(),
  path: z.string().min(1).max(4096),
});

export const ReadFileInput = RelativePathInput.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(512 * 1024).default(128 * 1024),
});

export const ReadManyFilesInput = z.object({
  workspaceId: z.string().uuid(),
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(CONTEXT_LIMITS.readManyHardTotalBytes).default(CONTEXT_LIMITS.readManyDefaultFileBytes),
    knownSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })).min(1).max(CONTEXT_LIMITS.readManyMaxFiles),
  maxTotalBytes: z.number().int().min(1).max(CONTEXT_LIMITS.readManyHardTotalBytes).default(CONTEXT_LIMITS.readManyDefaultTotalBytes),
});

export const ListDirectoryPageInput = z.object({
  workspaceId: z.string().uuid(),
  path: z.string().max(4096).default("."),
  offset: z.number().int().min(0).max(100_000).default(0),
  maxResults: z.number().int().min(1).max(CONTEXT_LIMITS.pageMaxResults).default(CONTEXT_LIMITS.pageDefaultMaxResults),
});

export const SearchTextPageInput = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1).max(500),
  path: z.string().max(4096).optional(),
  offset: z.number().int().min(0).max(100_000).default(0),
  maxResults: z.number().int().min(1).max(CONTEXT_LIMITS.pageMaxResults).default(CONTEXT_LIMITS.pageDefaultMaxResults),
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

export const SearchFilesInput = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1).max(500),
  path: z.string().max(4096).optional(),
  offset: z.number().int().min(0).default(0),
  maxResults: z.number().int().min(1).max(CONTEXT_LIMITS.searchFilesMaxResults).default(CONTEXT_LIMITS.searchFilesDefaultMaxResults),
});

export const ProjectCommandInput = z.object({
  workspaceId: z.string().uuid(),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
});

const environmentInput = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(8192)).superRefine((value, context) => {
  const blocked = new Set(["PATH", "HOME", "SHELL", "PWD", "OLDPWD", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "RUBYOPT", "PERL5OPT", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"]);
  if (Object.keys(value).length > 64) context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Environment overrides exceed the 64-key limit." });
  if (Object.entries(value).reduce((total, [key, item]) => total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(item, "utf8"), 0) > 256 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Environment overrides exceed the 256 KiB total limit." });
  for (const key of Object.keys(value)) if (blocked.has(key.toUpperCase())) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} cannot be overridden.` });
});

const validateProcessInvocation = (value: { executable: string; cwd: string; args: string[] }, context: z.RefinementCtx): void => {
  if (value.executable.includes("\0")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["executable"], message: "Executable cannot contain NUL bytes." });
  if (value.cwd.includes("\0")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cwd"], message: "cwd cannot contain NUL bytes." });
  for (const [index, arg] of value.args.entries()) if (arg.includes("\0")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["args", index], message: "Arguments cannot contain NUL bytes." });
  const totalBytes = value.args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0);
  if (totalBytes > 256 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, path: ["args"], message: "Arguments exceed the 256 KiB total limit." });
};

export const CommandRunInput = z.object({
  workspaceId: z.string().uuid(),
  executable: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(64 * 1024)).max(128).default([]),
  cwd: z.string().min(1).max(4096).default("."),
  env: environmentInput.optional(),
  timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).superRefine(validateProcessInvocation);

export const ProcessStartInput = z.object({
  workspaceId: z.string().uuid(),
  executable: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(64 * 1024)).max(128).default([]),
  cwd: z.string().min(1).max(4096).default("."),
  env: environmentInput.optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
}).superRefine(validateProcessInvocation);

export const ProcessWriteInput = z.object({ processId: z.string().uuid(), input: z.string().max(64 * 1024) });

export const GitStageInput = z.object({
  workspaceId: z.string().uuid(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
});

export const GitCommitInput = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().trim().min(1).max(5000),
});

export const GitCreateBranchInput = z.object({
  workspaceId: z.string().uuid(),
  branchName: z.string().trim().min(1).max(255).regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+(?<!\.)$/),
});

export const GitCheckoutInput = GitCreateBranchInput;

export const DirectoryCreateInput = z.object({ workspaceId: z.string().uuid(), path: z.string().min(1).max(4096) });

export const ProcessIdInput = z.object({ processId: z.string().uuid() });
export const ProcessReadOutputInput = z.object({
  processId: z.string().uuid(),
  stream: z.enum(["stdout", "stderr"]),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(64 * 1024).default(16 * 1024),
});

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
