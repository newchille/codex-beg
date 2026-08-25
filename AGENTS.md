# AGENTS.md — Codex BEG

This repository may contain intentional uncommitted work. Preserve it.

## Before doing any work

1. Read `docs/PROJECT_PLAN.md` — it is the canonical current roadmap and status.
2. Read the ADRs relevant to the phase you are touching.
3. Run `git status` and review the existing diff before editing.
4. Finish the current `IN PROGRESS` item before starting a later roadmap phase unless a blocker requires otherwise.

## Safety rules

- Do not run `git reset`, `git clean`, `git restore`, checkout/discard, or equivalent destructive cleanup.
- Do not delete files/directories without explicit user confirmation.
- Do not commit or push unless the user explicitly asks.
- Do not introduce raw shell/arbitrary command execution as a shortcut.
- Preserve workspace-ID isolation, project/Git root boundaries, approval gating, and recovery behavior.
- Treat renderer code and unrelated local processes as untrusted/minimally trusted surfaces; sensitive authority belongs in Electron main / Agent Host.
- Do not weaken security controls merely to make a test or integration easier.

## Keeping agents in sync

When a phase materially changes state, architecture, security invariants, or next-step order, update `docs/PROJECT_PLAN.md` in the same working tree.

Historical handoff documents are context only. If they conflict with `docs/PROJECT_PLAN.md`, follow the canonical plan and current ADRs.
