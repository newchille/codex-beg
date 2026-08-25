# ADR-0006: Make automatic repository inspection bounded and pageable

## Status

Accepted

## Context

AI clients can waste context and local I/O when broad tree, file, and search results are returned in one response. Dependency stores, generated output, caches, and repeated unchanged content are especially expensive but are not security boundaries by themselves.

## Decision

Keep explicit workspace reads available while making automatic discovery context-aware. File reads expose continuation metadata; multi-file reads enforce per-call budgets and per-file errors; filename, directory, and text discovery use deterministic ordering and offset pagination. Multi-file reads may use a client-supplied previously observed SHA-256 to return unchanged metadata without redelivering source content. Automatic discovery skips common dependency, cache, generated, and build directories, while explicit reads/searches into those paths remain allowed if the workspace path guard permits them.

Paging implementations should stream or discard skipped results rather than accumulating every result before the requested offset whenever practical.

## Consequences

- AI clients can request small deterministic pages and continue only when needed.
- Repositories containing large dependency/cache trees do not dominate automatic context.
- The ignore set is an efficiency policy, not an authorization policy.
- Explicit workspace boundary and secret policy checks remain the actual security controls.
- Future context-ledger or indexing features can build on these contracts without changing the basic file safety model.
