# ADR-0007: Expose bounded Git mutations instead of raw Git commands

## Status

Accepted

## Context

Codex BEG needs a usable write-to-commit development workflow, but exposing arbitrary Git subcommands would expand the mutation and repository-boundary attack surface. Git also searches parent directories for repositories, which can accidentally cross a registered workspace boundary.

## Decision

Expose narrow typed Git operations. All Git operations require a `project` workspace and require `git rev-parse --show-toplevel` to equal the workspace canonical root. `git_stage` accepts only validated workspace-relative paths to existing files, rejects directories and missing/deleted paths, deduplicates paths, and invokes `git add -- <paths>` with an argument array. `git_commit` commits the current index and passes the message as one argument without shell parsing. Neither tool stages broadly or constructs a shell command string.

## Consequences

- AI can complete a normal edit → stage → commit workflow when explicitly asked.
- Git cannot walk upward and operate on an ancestor repository outside the registered project boundary.
- The initial staging surface cannot stage deletions or entire directories; those capabilities require a future explicit safety design.
- Destructive Git operations such as reset/clean/force/discard remain unavailable or approval-gated rather than being smuggled through a generic Git command.
