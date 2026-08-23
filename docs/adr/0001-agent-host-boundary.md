# ADR-0001: Separate agent host from Electron renderer

## Status

Accepted

## Context

MCP calls need access to the local filesystem and process subsystem, while the renderer must not receive Node.js privileges.

## Decision

Run the domain runtime and MCP Streamable HTTP server in a supervised `agent-host` process. Electron main owns lifecycle and exposes only typed preload APIs to React.

## Consequences

- The renderer remains protected by context isolation and disabled Node integration.
- MCP can be inspected independently from the UI.
- A second process must be supervised and shut down cleanly.
