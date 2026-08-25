# Codex BEG

Codex BEG is a local-first Electron + MCP development agent. A ChatGPT planner (Sol High or another configured model) calls the local MCP server; the app owns workspace isolation, policy checks, filesystem changes, project commands, process lifecycle, audit events, and recovery. The implementation worker is local Luna-style execution: this app does not call a model API and does not invoke Codex CLI.

Current roadmap and agent handoff state: [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md). Agents should read that file before starting a new phase.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

For an unsigned desktop build:

```bash
pnpm package
```

For the shareable Apple Silicon macOS installer and team handoff:

```bash
pnpm package:dmg
```

The DMG is written to `apps/desktop/release/Codex-BEG-0.1.0-mac-arm64.dmg`. See [`dist-share/SETUP_TEAM.md`](dist-share/SETUP_TEAM.md) for zero-to-working setup, tunnel-client, ChatGPT Connector, daily use, and troubleshooting.

The agent host listens on `127.0.0.1:43123/mcp` when started by the desktop app. It never makes model API requests and does not invoke Codex CLI.

To connect ChatGPT Developer Mode, install the official `tunnel-client` separately, then configure Tunnel ID + Runtime API key in Codex BEG → Connection. The app stores the key with OS-backed Electron `safeStorage`, verifies the tunnel, and controls the managed `codex-beg` runtime pointed at `http://127.0.0.1:43123/mcp`; `tunnel-client` itself is not bundled.

## Team setup from a GitHub checkout

On an Apple Silicon Mac, a teammate can build and install the app from a fresh checkout:

```bash
git clone https://github.com/newchille/codex-beg.git gpt-mcp
cd gpt-mcp
./scripts/bootstrap-macos.sh
```

On a clean Apple Silicon Mac, `bootstrap-macos.sh` installs Homebrew (when missing), Node.js, pnpm, Codex BEG, and the official tunnel-client. It then saves that user's own `tunnel_id` and Runtime API key securely on first setup. Use `--skip-connect` if you want to install first and configure later.

To configure credentials manually once:

```bash
./scripts/configure-codex-beg.sh
```

For later runs, use the install-free launcher:

```bash
./scripts/run-codex-beg.sh
```

Use [`docs/TEAM_SETUP_FROM_SOURCE.md`](docs/TEAM_SETUP_FROM_SOURCE.md) for the complete flow, including the optional official Codex Tunnel MCP plugin. Each user/device should have its own tunnel ID and restricted Runtime API key. Run `bootstrap-macos.sh` again after source changes to build a fresh app and replace the installed one; use `run-codex-beg.sh` for daily starts.

## Workspace hierarchy

Codex BEG supports both project workspaces and larger machine-root style folders. Register the large folder once with `workspace_add` using `kind: "machine_root"`, then register individual projects beneath it with `workspace_register` and a relative path. Each child project gets its own project detection, Git root, and project commands.

Example flow:

```text
workspace_add({ rootPath: "/Users/me/DevProjects", kind: "machine_root" })
workspace_register({ parentWorkspaceId: "<root-id>", path: "service-a" })
workspace_register({ parentWorkspaceId: "<root-id>", path: "mobile-app" })
```

Only one workspace is stored as the current UI/default selection, but MCP tools are workspace-ID addressed. Registered child projects can therefore be inspected or operated on independently without moving the machine root or changing process working directories manually.

## Context-efficient inspection

Repository inspection is bounded by default. `read_file` returns continuation metadata using byte offsets and never ends a returned chunk in the middle of a UTF-8 code point; an offset inside a code point is rejected instead of returning corrupted replacement characters. `read_many_files` applies per-file and total byte ceilings, and `search_files` pages filename discovery while skipping common dependency/build trees during automatic discovery. `read_many_files` also accepts a previously returned `knownSha256`; unchanged files return metadata with `unchanged: true` and no repeated content bytes.

For large directories and text searches, use `list_directory_page` and `search_text_page`. Both return `truncated` and `nextOffset`, use deterministic ordering, and preserve the same workspace path boundary as the non-paged tools. Explicit reads remain available for paths that automatic discovery skips; discovery exclusions are context-efficiency rules, not security denies.

The paged tools are additive. Existing `list_directory` and `search_text` callers keep their current response shapes.

Long-running project logs should use `process_read_output` instead of repeatedly returning the full process snapshot. It reads one stdout/stderr stream with a bounded logical cursor (16 Ki characters by default, 64 Ki maximum), preserves offsets across the retained ring buffer, and reports `PROCESS_OUTPUT_EXPIRED` if the requested cursor has already rolled out of retention. `process_list` is also bounded to 50 recent entries with 2 Ki-character stdout/stderr tails, while only completed in-memory history is pruned above 200 records. Interactive stdin and generic process start remain intentionally unavailable.

## Reloading the Agent Host

After rebuilding a changed MCP schema, use **Doctor → Restart Agent Host** in the Desktop app to gracefully reload the compiled Agent Host without starting a second desktop instance. The restart sends only `SIGTERM`; if the host does not stop within the bounded timeout, Codex BEG reports the error instead of force-killing it or launching another host on the same port.

`/healthz` includes the Agent Host version, MCP tool count, and a short hash of the tool-name catalog. These fields make stale running builds visible in Doctor diagnostics. An external MCP client may still require its own connector refresh after the Agent Host schema changes.

## Safety boundary

All tool calls pass through the central policy engine. The initial surface has no delete tool, no raw shell, no force Git operations, and no `codex_run`. Reversible writes create a recovery journal before changing user files.
