$id-7347263108849102
title: Antonina owns the Borys board client and durable resource registry
date: 2026/09/25
source: issue-11
kind: requirement

Antonina owns the Borys shared-board client and exposes it only through `antonina board ...`. Board configuration uses `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_CAPABILITY`, and `ANTONINA_BOARD_AUTHOR`; no alternate product owns the client and no legacy environment fallback exists.

The board resource registry records dependencies for durable host paths. A resource is protected while any dependent Borys issue is open. Resource identity is canonical `lubko://<server>` plus a normalized absolute POSIX path, and adding a dependency requires an open issue.
