# Codex BEG — Canonical Project Plan

> This file is the shared source of truth for ChatGPT, Codex/Luna-style agents, and humans working on this repository.
>
> Read this file before starting a new phase. Update it when a phase changes state, a security invariant changes, or a major architectural decision is accepted. Historical handoff documents are useful context, but this file wins when they conflict with the current implementation.

Last synced: 2026-08-26
Repository: `/Users/11397288/DevProjects/gpt-mcp`
Branch: `main`

## 1. Product goal

Build **Codex BEG**, a local-first desktop engineering control plane that lets ChatGPT reason about and safely operate on local codebases through MCP without using Codex CLI as a backend and without exposing a raw shell.

Primary architecture:

```text
ChatGPT / Sol
    |
Secure MCP Tunnel
    |
tunnel-client
    |
127.0.0.1:43123/mcp
    |
Agent Host
    |
Schema validation -> Central policy -> Typed services
    |                               |
Workspace / Files / Git / Project   Audit / Recovery / Events
    |
Managed local processes
    |
Local computer
```

The user is developing on a corporate-managed macOS machine today. Windows remains a target platform, but macOS is a first-class development and verification environment rather than a secondary compatibility target.

## 2. Non-negotiable safety invariants

These rules override convenience and feature speed.

- Do not expose `shell_run` or a generic arbitrary command executor.
- Do not expose filesystem delete tools.
- Do not expose destructive Git operations such as reset/clean/force/discard through a generic Git tool.
- Do not delete project files/directories without explicit user confirmation.
- Do not run `git reset`, `git clean`, `git restore`, checkout/discard, or equivalent destructive cleanup on the working tree.
- Do not commit unless the user explicitly asks for a commit.
- Every MCP filesystem operation is scoped by explicit `workspaceId`; mutable global cwd is never a security boundary.
- Absolute paths are accepted only by tightly controlled workspace-registration flows.
- `machine_root` is a container/discovery boundary only. Project/Git commands require `kind === "project"`.
- Git operations must require Git top-level to equal the project canonical root so Git cannot walk upward into an ancestor repository.
- Reversible writes must retain before-images/recovery metadata before mutation.
- Operations that destroy data, alter system-sensitive state, or grant new filesystem capability require explicit approval.
- Renderer code is not a trusted security boundary. Sensitive paths/tokens/approval decisions belong in Electron main or Agent Host.
- Loopback reduces network exposure but does not make every local process trusted.
- Generated/vendor/cache exclusions are context-efficiency rules, not authorization rules.

## 3. Current operation classes

The original MVP model has evolved. The canonical model is now:

```ts
type OperationClass =
  | "READ_ONLY"
  | "WRITE_REVERSIBLE"
  | "PROCESS"
  | "CAPABILITY_GRANT"
  | "DESTRUCTIVE"
  | "SYSTEM_SENSITIVE";
```

Behavior:

- `READ_ONLY`: allowed automatically inside the existing workspace boundary.
- `WRITE_REVERSIBLE`: allowed when the operation is narrow and recovery requirements are satisfied.
- `PROCESS`: allowed only for detected/configured project commands, never arbitrary command text.
- `CAPABILITY_GRANT`: requires Approve Once because it expands what local paths the agent may operate on. MCP `workspace_add` and `workspace_register` belong here.
- `DESTRUCTIVE`: requires Approve Once.
- `SYSTEM_SENSITIVE`: requires Approve Once.

Approval remains operation-hash bound, expiring, single-use, and tied to the exact pending operation.

## 4. Current workspace model

Canonical hierarchy:

```text
machine_root
├── project
├── project
└── nested/path/project
```

Example:

```text
/Users/11397288/DevProjects             [machine_root]
├── gpt-mcp                            [project]
├── apex-coach                         [project]
└── oneks/java-architecture-linter     [project]
```

Rules:

- `workspace_add(..., kind: "machine_root")` registers a container, not a runnable project.
- `workspace_register(parentWorkspaceId, relativePath)` explicitly links a child project.
- Child registration must reject absolute paths, `..`, NUL/device/UNC/ADS cases, and symlink/reparse escape.
- Canonical duplicate registration reuses the existing workspace ID.
- `currentWorkspaceId` is UI/default state only; explicit `workspaceId` calls work independently across projects.
- Removing a machine-root registration unlinks child relationships but does not delete child workspace registrations or project files.

Relevant ADR: `docs/adr/0005-workspace-hierarchy.md`.

## 5. Public tool direction

The original Safety Core MVP tool list has expanded with narrow typed tools. The intended source-level catalog includes:

```text
workspace_list
workspace_add
workspace_register
workspace_select
workspace_current
workspace_info
workspace_tree
workspace_snapshot

read_file
read_many_files
list_directory
list_directory_page
search_text
search_text_page
search_files
file_info
write_file
apply_patch

git_status
git_diff
git_log
git_show
git_stage
git_commit

project_test
project_lint
project_typecheck
project_build
project_dev

process_list
process_read
process_stop

operation_get
```

Do not add a large generic tool catalog merely for convenience. Prefer narrow typed capabilities with explicit schemas.

## 6. Completed / implemented work

### Phase A — Safety Core bootstrap

Status: **DONE**

Implemented foundations include:

- Electron + React + TypeScript desktop structure.
- Separate Agent Host process on loopback.
- Central policy engine.
- Workspace path validation and canonicalization.
- Project detection/adapters for multiple ecosystems.
- Managed process execution with no unrestricted shell.
- Audit/events/recovery foundations.
- Atomic JSON persistence.
- Reversible `write_file` / `apply_patch` behavior.
- External Secure MCP Tunnel architecture; no model API backend and no Codex CLI backend.

### Phase B — Workspace Hierarchy

Status: **DONE IN SOURCE / LIVE RELOAD STILL REQUIRED FOR NEW MCP CATALOG**

Implemented:

- `WorkspaceKind = machine_root | project`.
- `parentWorkspaceId`.
- `workspace_register`.
- Legacy workspace migration to `project`.
- Canonical duplicate reuse/linking.
- machine-root/project UI hierarchy.
- explicit workspace-ID routing across projects.
- project commands reject machine roots.
- Git boundary requires project root === Git top-level.

### Phase C — Robust executable resolution

Status: **DONE**

Implemented:

- Runtime executable resolution instead of trusting stale persisted command executable metadata.
- pnpm/npm/yarn discovery.
- PATH/NVM/NVM_BIN/.nvmrc/Volta/Homebrew/Corepack/common install locations.
- Windows package-manager shim adapter without enabling unrestricted `shell: true`.
- CMD metacharacter rejection and safer `ComSpec` handling.
- Existing registered workspaces recover without re-registration.

Live proof already observed: `project_typecheck` resolved a real pnpm executable and exited 0 instead of `spawn pnpm ENOENT`.

### Phase D — Context Economy

Status: **DONE**

Implemented:

- `read_file` continuation metadata.
- bounded-memory streaming read/hash behavior.
- `read_many_files` with max file count and byte budget.
- per-file errors.
- client-supplied `knownSha256` conditional read; unchanged files return metadata without content.
- byte continuation stops on complete UTF-8 code-point boundaries; offsets inside a multibyte code point and limits too small for one complete code point return typed errors instead of replacement-character corruption.
- `search_files` bounded filename/path discovery.
- `list_directory_page`.
- `search_text_page`.
- deterministic ordering/pagination.
- bounded paging memory behavior.
- automatic discovery skips common dependency/cache/build trees while explicit reads remain possible.

Relevant ADR: `docs/adr/0006-bounded-context-inspection.md`.

### Phase E — Bounded Git mutation

Status: **DONE**

Implemented:

- `git_stage` for validated existing workspace files only.
- `git add -- <paths>` argument-array execution.
- `git_commit` with message as one argument and no shell parsing.
- Git read/write operations require project workspace and exact Git root boundary.
- `git_diff_check` provides the acceptance-baseline `git diff --check` as a typed read-only tool without opening a generic shell.
- no broad staging, deletion staging, reset/clean/force operations.

Relevant ADR: `docs/adr/0007-bounded-git-mutations.md`.

### Phase F — Persistence / recovery hardening

Status: **DONE**

Implemented:

- unique operation-based temp write names.
- per-path serialized `JsonStore.save()` queue to prevent concurrent stale rename ordering.
- streaming SHA-256 where practical.
- recovery restore preflights every target before writing so a later conflict cannot partially restore earlier files.
- startup reconciliation marks previously nonterminal `pending`, `running`, or `approval_required` operation records as `interrupted` because pending closures/approvals are intentionally not resurrected after restart.
- persisted operation history keeps all nonterminal records plus the latest 1,000 terminal records, preventing `operations.json` from growing without bound.
- audit writes are serialized per audit directory, fsynced, rotated to unique UUID-suffixed segments, and async append failures are caught at the runtime listener so logging failure does not become an unhandled rejection.
- regression tests for concurrent persistence, restart interruption, and recovery conflict behavior.

### Phase G — Local control-plane hardening

Status: **DONE IN SOURCE / LIVE ACTIVATION PENDING**

Implemented:

- `/admin/*` and `/events` require a per-session random admin token.
- admin token is generated in Electron main and delivered to Agent Host over a one-shot anonymous stdin pipe, not argv/environment.
- token is not exposed to renderer/preload API.
- timing-safe token comparison on Agent Host.
- `/healthz` stays unauthenticated for diagnostics.
- MCP remains on loopback; custom `/mcp` token auth is intentionally not invented until tunnel compatibility is verified.
- `/healthz` reports Agent Host version, tool count, and tool-catalog hash.
- Doctor has graceful **Restart Agent Host** support; no force-kill fallback.
- Approve Once now requires a native Electron confirmation dialog before the admin approve call.
- MCP `workspace_add` / `workspace_register` are classified as `CAPABILITY_GRANT` and approval-gated.

Completed bridge hardening:

- renderer/preload workspace registration no longer accepts absolute paths from renderer code.
- Electron main owns the native folder picker and selected absolute path.
- renderer provides only intent (`kind` or `parentWorkspaceId`), and generic `chooseDirectory` exposure is removed.

## 7. Immediate next steps

These are the next tasks in order. Do not jump ahead unless a blocker requires it.

### NEXT-1 — Finish trusted workspace-picker bridge

Status: **DONE**

Requirements:

- `workspaceAdd(kind)` exposed to renderer; no renderer-supplied absolute root path.
- `workspaceRegisterDirectory(parentWorkspaceId)` exposed to renderer; no renderer-supplied child absolute path.
- native Electron main opens the folder picker and owns the selected absolute path.
- remove generic `chooseDirectory` exposure from preload/global renderer API.
- update renderer call sites.
- keep parent-child canonical validation in main + Agent Host/core.

### NEXT-2 — Re-run full verification

Status: **DONE**
After NEXT-1:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Also review:

```bash
git status
git diff --check
git diff
```

Verified after completing the bridge shrink:

- core tests: 22/22 passed
- agent-host tests: 2/2 passed
- typecheck passed
- lint passed; build passed

The complete suite was rerun after the bridge changes and passed. Direct `git diff --check` remains pending until the live host exposes a suitable typed execution path; review `git_diff` meanwhile and do not claim that command passed without running it.

### NEXT-3 — Document trusted local control plane
Status: **DONE**

Implemented in `docs/adr/0008-trusted-local-control-plane.md`, covering:

- local admin token boundary.
- renderer as untrusted/minimally trusted surface.
- native confirmation for approval.
- capability-grant classification.
- why `/healthz` remains public loopback.
- why `/mcp` app-level auth is deferred until Secure MCP Tunnel compatibility/mTLS design is validated.

Suggested filename:

```text
docs/adr/0008-trusted-local-control-plane.md
```

### NEXT-4 — Activate the new Agent Host build
Status: **BLOCKED ON LIVE DESKTOP RESTART / CONNECTOR REFRESH**

After source verification:

- use Desktop **Doctor → Restart Agent Host** rather than launching another Desktop/dev instance.
- verify `/healthz` version/toolCount/toolCatalogHash changes.
- refresh/reconnect the ChatGPT connector if its MCP schema cache remains stale.

The currently connected ChatGPT tool catalog has previously remained on an older 26-tool host even after source build succeeded; treat that as process/connector staleness, not automatically as a source-code failure.

### NEXT-5 — Real multi-project smoke test
Status: **PARTIAL ON OLD LIVE HOST; COMPLETE AFTER NEXT-4**

After live catalog reload, use existing registrations without deleting/re-registering unnecessarily.
Old-host evidence already passed: explicit-ID `git_status` works for `apex-coach` and `java-architecture-linter`; `apex-coach` typecheck ran from its own workspace and exited 0; the `gpt-mcp` tree did not expose sibling project roots. `java-architecture-linter` is not yet linked to the machine root and should be linked after the new catalog is active.

Verify:

1. `/Users/11397288/DevProjects` is a `machine_root`.
2. `gpt-mcp`, `apex-coach`, and `oneks/java-architecture-linter` are distinct project workspaces.
3. explicit child workspace IDs work independently of `currentWorkspaceId`.
4. `git_status` is isolated per child.
5. child tree/search cannot expose siblings.
6. project commands run from the child's canonical root.
7. duplicate child registration reuses the existing workspace.
8. MCP workspace expansion produces an approval request and cannot silently grant a new absolute path.

Do read-only smoke checks on unrelated projects unless the user explicitly asks to mutate them.

### NEXT-6 — macOS distribution checkpoint
Status: **PACKAGE AND NON-SECRET SMOKE READY / PUBLIC RELEASE PENDING**

Verified 2026-08-25:

- electron-vite dev builds use absolute main/preload/renderer inputs and non-cleaning shared outputs; `pnpm dev` launches the Desktop app and Agent Host health endpoint.
- The current arm64 package is at `apps/desktop/release/mac-arm64/Codex BEG.app`; packaged and extracted-ZIP smoke both returned Agent Host version `0.1.0`, 35 tools, and catalog hash `67325d2e949dde8a`.
- `pnpm package:dmg` now produces the installable `apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg`; the DMG was mounted read-only and verified to contain the arm64 app.
- 2026-08-26 package checkpoint: `apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg` SHA-256 is `617c38dc6344e7c63e1bc9ccd42392f503878c35370eece0cd183b3fccadde2d`; `dist-share/SHA256SUMS.txt` was regenerated from this file.
- 2026-08-26 packaged Agent Host SHA-256 is `4a20eb09ef3fadb5b6ffe6ee789574a8b6af12bd03694aaa2d63351e6c54465d`, matching `apps/agent-host/dist/main.js`.
- 2026-08-26 icon checkpoint: SVG was rasterized into the supported `apps/desktop/renderer/src/app-icon.icns`; the packaged bundle contains `Contents/Resources/icon.icns` and does not use the default Electron icon.
- 2026-08-26 packaged smoke: `/healthz` returned version `0.1.0`, 35 tools, catalog hash `67325d2e949dde8a`; close/reopen kept Agent Host alive; graceful Quit closed port `43123`; DMG read-only mount contained the app and icon.
- Desktop source now refreshes Projects immediately after a successful folder registration and also polls bounded workspace state so external registration changes appear without a manual reload.
- Desktop source now acts as the tunnel control surface: it shows live Agent/MCP/tunnel state, saves Tunnel ID plus an OS-encrypted Runtime API key through Electron `safeStorage`, verifies the exact tunnel with a read-only runtime-key lookup, and starts/stops the supported managed `tunnel-client runtimes` flow without putting the literal key on the command line.
- The previously built DMG with SHA-256 `c929e982edda6b826d7b16dc35e9b10cb8a2912be18cb2b0836563dc3bd331e6` is superseded by the 2026-08-26 package above.
- Window close now hides Codex BEG to a macOS menu-bar tray instead of exiting; the tray exposes Open, live tunnel state, Start/Stop Tunnel, and Quit. Full Quit gracefully stops the managed tunnel and Agent Host.
- GitHub checkout onboarding is now scripted for macOS arm64: `scripts/bootstrap-macos.sh` is the clean-machine install/update entry point that rebuilds from the current checkout and replaces the installed app without backups, `scripts/configure-codex-beg.sh` persists per-device credentials with mode-600 key storage, and `scripts/run-codex-beg.sh` is the install-free daily launcher; source setup is documented in `docs/TEAM_SETUP_FROM_SOURCE.md`.
- The tunnel wrapper accepts a tunnel ID plus a user-only Runtime API key file or exported environment variable, and now prompts for omitted values when run interactively; it checks the local Agent Host first and uses the managed `tunnel-client runtimes connect` flow without exposing the key as a command-line value.
- The current app is an adhoc/unsigned development distribution, not Developer ID signed or notarized; the friend guide documents the normal macOS Open Anyway flow.
- The tunnel-client/ChatGPT connector remains an external live prerequisite; the friend guide follows the current official `tunnel-client` runtime and connector flows.

## 8. Near-term roadmap after the current security checkpoint

Proceed in small phases.

### Phase H — Approval/recovery UX completion
Status: **DONE IN SOURCE / LIVE ACTIVATION PENDING**

Implemented / remaining UX work:

- show richer exact targets and classification in native approval UI.
- surface interrupted operations after restart.
- expose recovery manifest/status clearly in Live Logs.
- add recovery Restore UI if incomplete.
- make approval expiry/reject/single-use states obvious.
- Implemented: native approval dialog includes the explicit operation classification; Live Logs surfaces recent operations including `interrupted`, bounded recovery manifests, and Restore actions.
- Implemented: user-triggered restore of files created by the original operation remains `DESTRUCTIVE` and approval-gated; regression tested.
- Implemented: `/admin/operations` and `/admin/recovery` are token-protected and bounded to a default 100 / hard maximum 500 records before reaching renderer code.
- Implemented: Live Logs has a dedicated recent approval-decision history for `approved`, `rejected`, and `expired`; approved decisions are visibly marked single-use.
- Implemented: approval history is bounded to 200 records while preserving live pending approvals, and expired approvals transition during list/prune instead of disappearing silently.
- Implemented: audit appends are serialized per directory, fsynced, and rotated to UUID-suffixed files so concurrent rotation cannot overwrite an earlier audit segment.
- Implemented: Approve/Reject persistence is awaited, and approved async operations are awaited in the admin request path; action failures propagate to the caller after the operation record is persisted as `failed` instead of becoming an unhandled rejection.

### Phase I — Process/session usability
Status: **BOUNDED OUTPUT DONE IN SOURCE / INTERACTIVE INPUT DEFERRED**

Only after Safety Core is stable:

- bounded interactive process/session primitives if genuinely needed.
- explicit session IDs and bounded stdout/stderr pagination.
- no generic shell.
- preserve allowlisted/configured project-command semantics.
- Implemented: `process_read_output` reads at most 64 Ki characters per call from one retained stdout/stderr stream using logical offsets and defaults to a 16 Ki-character tail.
- Implemented: logical total/start offsets survive ring-buffer rollover; requesting an output cursor older than retained data returns `PROCESS_OUTPUT_EXPIRED` rather than shifting silently.
- Implemented: `process_list` returns at most 50 recent processes with only 2 Ki-character tails per stdout/stderr stream, and ProcessManager evicts only the oldest completed in-memory records above a 200-record retention ceiling while preserving all starting/running records.
- Deferred: interactive stdin/session input remains out of scope until a concrete project-command use case requires it; no generic `process_start` or shell was added.

### Phase J — Context indexing, only if bounded primitives prove insufficient

Do not start with SQLite/watchers automatically.

If repository-scale context still needs improvement, first define:

- what queries cannot be served by `search_files`, `search_text_page`, hashes, and bounded reads.
- privacy/retention requirements for any index.
- invalidation model.
- resource ceilings.
- opt-in workspace scope.

Persistent SQLite indexing and filesystem watchers are deferred until there is a demonstrated need.

### Phase K — Stronger MCP transport identity
Status: **DOCUMENTED PATH VALIDATED / CERTIFICATE PROVISIONING DEFERRED**

Investigate Secure MCP Tunnel-compatible endpoint authentication, preferably documented mTLS/client identity rather than a custom header that may break the tunnel.

Do not change `/mcp` authentication based on assumptions. Verify official tunnel behavior first.

Validated on 2026-08-25: official Secure MCP Tunnel docs and `openai/tunnel-client` support MCP-side mTLS for Streamable HTTP. Exact client configuration includes `MCP_CLIENT_CERT` / `MCP_CLIENT_KEY`, CLI `--mcp.client-cert` / `--mcp.client-key`, and optional custom CA trust. Do not invent a local bearer-header protocol when this documented identity path exists.
Implementation remains deferred until an operator intentionally provisions the Codex BEG HTTPS server certificate/key and client CA/trust material. Do not auto-generate, install, or trust a private CA on the managed workstation without explicit user authorization.

## 9. Explicitly deferred / out of scope for now

Do not start these merely because they are technically possible:

- raw shell / arbitrary command execution.
- generic `process_start`.
- filesystem delete tool.
- destructive/force Git commands.
- browser automation.
- Office automation.
- desktop/UI automation beyond Codex BEG's own trusted UI.
- audio/recording.
- scheduler/cron agent behavior.
- `codex_run` backend.
- automatic recursive project registration.
- persistent source-content cache in Agent Host.
- persistent SQLite repository index/watchers until justified.
- automatic download/bundling of `tunnel-client`.
- model API fallback.

## 10. Testing / acceptance baseline

For each phase, add the narrowest regression tests that prove the security/property change.

The complete project checkpoint should pass:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

Acceptance expectations include:

- path traversal and symlink escape remain blocked.
- machine roots cannot run project/Git commands.
- Git cannot walk to ancestor repository.
- GUI/NVM package-manager execution works without interactive shell startup.
- context operations are bounded/paged.
- writes retain recovery behavior.
- recovery conflict cannot cause partial restore.
- stale nonterminal operations do not masquerade as resumable after restart.
- local admin routes reject requests without the session token.
- renderer never receives the admin token.
- approval requires trusted native confirmation.
- MCP cannot silently expand workspace capability.
- renderer cannot provide arbitrary absolute workspace paths after NEXT-1.
- new live MCP catalog is verified after Agent Host restart.
- no destructive cleanup of the working tree occurred.

## 11. Rules for future agents

At the beginning of a new work session:

1. Read `docs/PROJECT_PLAN.md`.
2. Read relevant ADRs for the phase being touched.
3. Run `git status` and review the existing diff before editing.
4. Preserve uncommitted work.
5. Prefer finishing the current `IN PROGRESS` task before starting another phase.
6. Update this file if the phase status, architecture, or next-step order changes materially.
7. If a handoff is required, reference this plan and describe only the current blocker/delta rather than reproducing stale historical plans.

Never treat this plan as permission to delete files, discard work, commit, push, weaken security controls, or expose a raw shell.

## 12. Historical plan reconciliation

The original **Safety Core MVP** plan is still valid as product intent, but the following items are superseded by the current implementation:

- `Workspace` now has hierarchy metadata (`kind`, optional `parentWorkspaceId`).
- operation classes now include `CAPABILITY_GRANT`.
- the public source-level tool set is larger and includes bounded context + bounded Git mutation tools.
- `workspace_add` is no longer just an ordinary registration when requested through MCP; it is a capability expansion and must be approval-gated.
- context-efficient paging/hashing is part of the safety/usability baseline, not a future nice-to-have.
- local loopback admin HTTP is no longer implicitly trusted; it uses an app-session token.
- renderer/preload IPC is being narrowed so sensitive absolute paths originate from Electron main's native UI.
- recovery now preflights multi-file restore and startup marks orphaned nonterminal operations interrupted.
- macOS is a first-class development environment while Windows compatibility remains required.

The old Workspace Hierarchy and Context Economy handoffs should now be treated as historical implementation records. This file is the canonical current roadmap.
