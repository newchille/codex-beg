# ADR-0003: Atomic JSON state with NDJSON audit and recovery journals

## Status

Accepted

## Context

The single-user desktop MVP needs durable project metadata and rollback without adding native SQLite dependencies to Electron.

## Decision

Persist registry/settings as schema-versioned JSON using temp-file + rename, append audit events to rotated NDJSON, and store before-images in per-operation recovery directories.

## Consequences

- The MVP stays portable across macOS and Windows.
- Recovery data is inspectable and easy to export.
- Rotation and retention must be implemented explicitly.
