# Codex BEG

Codex BEG is a local-first Electron + MCP development agent. A ChatGPT planner (Sol High or another configured model) calls the local MCP server; the app owns workspace isolation, policy checks, filesystem changes, project commands, process lifecycle, audit events, and recovery. The implementation worker is local Luna-style execution: this app does not call a model API and does not invoke Codex CLI.

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

The agent host listens on `127.0.0.1:43123/mcp` when started by the desktop app. It never makes model API requests and does not invoke Codex CLI.

To connect ChatGPT Developer Mode, install the official `tunnel-client` separately, create a profile named `codex-beg`, and point it at `http://127.0.0.1:43123/mcp`. Codex BEG does not bundle the tunnel client, store its runtime key, or provide an API fallback.

## Safety boundary

All tool calls pass through the central policy engine. The initial surface has no delete tool, no raw shell, no force Git operations, and no `codex_run`. Reversible writes create a recovery journal before changing user files.
