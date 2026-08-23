# ADR-0002: Centralize operation policy

## Status

Accepted

## Context

Tool names alone cannot determine whether an operation is safe. A command, path, and nested project script may have side effects.

## Decision

Every operation is normalized to an `OperationRequest` and classified by one policy engine before reaching OS APIs. Destructive or sensitive operations produce an approval request and never execute silently.

## Consequences

- All tools share the same safety boundary.
- The policy layer must inspect executable, arguments, resolved targets, and project command configuration.
- The MVP intentionally omits raw shell and deletion tools.
