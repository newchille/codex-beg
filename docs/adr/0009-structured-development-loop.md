# ADR-0009: Structured development-loop execution

## Status

Accepted

## Context

The local tunnel needs to support a normal edit, test, build, and long-running development loop. The existing configured `project_*` commands are not enough for bootstrapping a newly created project or invoking a project-owned script. A raw shell string would make argument validation, workspace confinement, approval classification, and process ownership ambiguous.

## Decision

Expose typed development-loop tools with structured executable and argument arrays:

- `workspace_create` creates a child directory below a registered machine root and registers it as a project after capability approval.
- `workspace_refresh` re-detects project type and configured commands from current files.
- `command_run` resolves one executable, runs it with bounded output and a finite timeout, and requires a project workspace and workspace-contained cwd.
- `process_start` creates a managed long-running process with an explicit process ID; `process_read`, `process_read_output`, `process_write`, and `process_stop` can address only IDs retained by the Agent Host.
- `directory_create`, `git_init`, `git_add`, `git_create_branch`, and non-force `git_checkout` remain narrow typed mutations.

The tools never accept a shell command string. Environment overrides are additive and reject path/interpreter injection variables such as `PATH`, `NODE_OPTIONS`, loader paths, and `PYTHONPATH`. Shell executables and system-sensitive command intent are approval-gated by the central policy; destructive patterns remain approval-gated. Output, arguments, stdin, timeouts, process history, and workspace paths are bounded.

## Consequences

- ChatGPT can bootstrap and iterate on a registered project without asking the user to switch to Terminal for routine structured commands.
- A command can still invoke a project-owned script through an explicit argv entry, but shell parsing is not performed by Codex BEG.
- Long-running processes can support stdin-driven workflows such as hot reload while remaining addressable and stoppable only through Agent Host-managed IDs.
- Commands are not a complete OS sandbox: project code can retain the capabilities of the executable it invokes. Sensitive executable classes and destructive intent therefore remain approval-gated, and the workspace/cwd boundary is enforced before spawning.
