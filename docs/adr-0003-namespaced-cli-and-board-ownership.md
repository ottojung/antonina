# ADR-0003: Namespace the public CLI and own the Borys board

Date: 2026-09-25

## Status

Accepted

## Context

Antonina's managed-agent operations and its Borys work board are separate product surfaces. Keeping agent commands at the executable root would make the growing public surface ambiguous, while a separate board executable would split ownership and configuration across products.

## Decision

The `antonina` executable is a small top-level dispatcher with exactly two public namespaces:

- `antonina agent ...` manages long-running agent sessions.
- `antonina board ...` manages Antonina's Borys board.

Direct root-level agent commands are not compatibility aliases. The background runner remains an internal agent entry point. The board client is implemented in Antonina with no Lubko import and reads only `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_CAPABILITY`, and `ANTONINA_BOARD_AUTHOR`.

The board object key remains `borys/board-v1`, but Antonina parses deployed schema v1 into schema v2 in memory and every mutation writes canonical v2 with issue bodies and resource dependencies. Resource identity is canonical host plus absolute POSIX path. Dependencies may reference existing issues; only open issues may gain dependencies; closing an issue preserves them; and a resource is protected while any dependent issue remains open.

## Consequences

The public namespace is explicit and stable, board ownership and configuration are singular, and existing deployed v1 boards remain readable without retaining a second public CLI. Runtime dependencies remain empty because the client uses only the Python standard library.
