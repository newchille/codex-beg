import { createHash, randomUUID } from "node:crypto";
import { EventBus } from "./events.js";
import { ApprovalRequiredError, CodexBegError } from "./errors.js";
import type { ApprovalRequest, OperationClass, OperationRequest } from "./types.js";
import { OPERATION_CLASSES } from "./types.js";

const DANGEROUS_PATTERNS = [
  /(^|[\\/\s])rm(\.exe)?([\\/\s]|$)/i,
  /(^|[\\/\s])(rmdir|del|erase)([\\/\s]|$)/i,
  /remove-item/i,
  /git\s+(clean|reset\s+--hard|push\s+--force|branch\s+-D)/i,
  /checkout\s+--/i,
  /restore\s+--/i,
];

export function operationHash(request: OperationRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export class PolicyEngine {
  constructor(private readonly events = new EventBus()) {}

  classify(request: OperationRequest): OperationClass {
    const commandText = [request.executable ?? "", ...(request.arguments ?? [])].join(" ");
    if (["delete", "file_delete", "git_clean", "git_reset_hard", "force_push", "operation_restore_delete"].includes(request.kind)) return OPERATION_CLASSES.destructive;
    if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(commandText))) return OPERATION_CLASSES.destructive;
    if (["workspace_add", "workspace_register"].includes(request.kind)) return OPERATION_CLASSES.capabilityGrant;
    if (request.kind.startsWith("system_") || request.kind === "shell_run") return OPERATION_CLASSES.systemSensitive;
    if (request.kind.startsWith("project_") || request.kind.startsWith("process_")) return OPERATION_CLASSES.process;
    if (["write_file", "apply_patch", "operation_restore", "git_stage", "git_commit"].includes(request.kind)) return OPERATION_CLASSES.writeReversible;
    return OPERATION_CLASSES.readOnly;
  }

  enforce(request: OperationRequest, approval?: ApprovalRequest): OperationClass {
    const classification = this.classify(request);
    if (classification === OPERATION_CLASSES.destructive || classification === OPERATION_CLASSES.systemSensitive || classification === OPERATION_CLASSES.capabilityGrant) {
      if (!approval || approval.status !== "approved" || approval.operationHash !== operationHash(request)) {
        this.events.emit("policy.approval_required", { operationId: request.operationId, classification });
        throw new ApprovalRequiredError({ classification, operationHash: operationHash(request), operationId: request.operationId });
      }
    } else {
      this.events.emit("policy.allowed", { operationId: request.operationId, classification });
    }
    return classification;
  }
}

export class ApprovalManager {
  private readonly maxHistory = 200;
  private readonly approvals = new Map<string, ApprovalRequest>();

  create(request: OperationRequest, action: string, exactOperation: string, risk: string, classification: OperationClass): ApprovalRequest {
    const approval: ApprovalRequest = {
      approvalId: randomUUID(), nonce: randomUUID(), operationId: request.operationId, operationHash: operationHash(request), action, classification,
      workspaceId: request.workspaceId, exactOperation, risk,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), status: "pending",
    };
    this.approvals.set(approval.approvalId, approval); this.pruneHistory();
    return approval;
  }

  get(id: string): ApprovalRequest {
    const value = this.approvals.get(id);
    if (!value) throw new CodexBegError("APPROVAL_NOT_FOUND", `Unknown approval: ${id}`);
    if (value.status === "pending" && Date.parse(value.expiresAt) <= Date.now()) value.status = "expired";
    return value;
  }

  approve(id: string): ApprovalRequest {
    const value = this.get(id);
    if (value.status !== "pending") throw new CodexBegError("APPROVAL_NOT_PENDING", "Approval is no longer pending.");
    value.status = "approved"; this.pruneHistory();
    return value;
  }

  reject(id: string): ApprovalRequest {
    const value = this.get(id);
    if (value.status !== "pending") throw new CodexBegError("APPROVAL_NOT_PENDING", "Approval is no longer pending.");
    value.status = "rejected"; this.pruneHistory();
    return value;
  }

  list(): ApprovalRequest[] { this.pruneHistory(); return [...this.approvals.values()].map((value) => ({ ...value })); }
  private pruneHistory(): void { const now = Date.now(); for (const approval of this.approvals.values()) if (approval.status === "pending" && Date.parse(approval.expiresAt) <= now) approval.status = "expired"; if (this.approvals.size <= this.maxHistory) return; for (const [id, approval] of this.approvals) { if (this.approvals.size <= this.maxHistory) break; if (approval.status !== "pending") this.approvals.delete(id); } }
}
