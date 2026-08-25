# ADR-0005: Separate machine roots from project workspaces

## Status

Accepted

## Context

Codex BEG needs to work across many local repositories without treating a large parent directory as one runnable project. Using only a single current directory makes Git and project-command boundaries ambiguous and increases the risk of operating on a sibling repository.

## Decision

Represent registered directories as either `machine_root` or `project` workspaces. A machine root is a discovery/container boundary only. Child projects are registered explicitly with a relative path and receive their own workspace ID, project detection, Git boundary, and command profile.

MCP operations remain addressed by explicit `workspaceId`; `currentWorkspaceId` is only a default/UI selection. Project and Git operations require a project workspace. Git operations additionally require the Git top-level directory to equal the project's canonical workspace root so Git cannot walk upward into an ancestor repository outside the workspace boundary.

## Consequences

- Multiple repositories under one parent can be managed independently without changing a global working directory.
- A child project cannot expose sibling projects through workspace-relative file tools.
- Machine roots cannot accidentally run project or Git commands.
- Child registration must remain canonical-path checked and idempotent.
- Removing a registration does not delete project files.
