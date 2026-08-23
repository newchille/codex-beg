# ADR-0004: External Secure MCP Tunnel, no model backend

## Status

Accepted

## Context

The intended workflow is ChatGPT calling the local computer through MCP. The app should not duplicate model inference or consume a separate API budget.

## Decision

Expose the local MCP server on loopback and let the user-managed OpenAI `tunnel-client` forward to it. Codex BEG does not create Responses API requests, store the runtime key, download the tunnel binary, or invoke Codex CLI.

## Consequences

- ChatGPT Developer Mode and tunnel credentials remain external prerequisites.
- Tunnel availability is reported by Doctor when configured.
- Local MCP and tests remain usable without network access.
