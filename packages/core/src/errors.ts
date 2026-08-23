export class CodexBegError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details: unknown = undefined) {
    super(message);
    this.name = "CodexBegError";
    this.code = code;
    this.details = details;
  }
}

export class PathViolationError extends CodexBegError {
  constructor(message: string, details?: unknown) {
    super("PATH_OUTSIDE_WORKSPACE", message, details);
  }
}

export class ApprovalRequiredError extends CodexBegError {
  constructor(public readonly approval: unknown) {
    super("APPROVAL_REQUIRED", "This operation requires explicit approval.", approval);
  }
}

export class StaleFileError extends CodexBegError {
  constructor(path: string) {
    super("STALE_FILE", `The file changed since the requested hash was read: ${path}`);
  }
}
