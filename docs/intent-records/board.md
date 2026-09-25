$id-7347263108849102
title: Antonina owns the shared board client and durable resource registry
date: 2026/09/25
source: issue-11
kind: requirement

Antonina owns the shared board client and exposes it only through `antonina board ...`. Board configuration uses `ANTONINA_BOARD_URL`, `ANTONINA_BOARD_CAPABILITY`, and `ANTONINA_BOARD_AUTHOR`; no alternate product owns the client and no legacy environment fallback exists.

The board resource registry records dependencies for durable host paths. A resource is protected while any dependent board issue is open. Resource identity is canonical `lubko://<server>` plus a normalized absolute POSIX path, and adding a dependency requires an open issue.

$id-7342189056173421
title: The Antonina queue always contains all open GitHub issues
date: 2026/09/25
source: issue-19
kind: requirement

The Antonina board queue contains every currently open GitHub issue in the Antonina repository. Open issues are not manually omitted from the queue.

$id-8519064273185604
title: Queue priority is easy to reorder from the web interface
date: 2026/09/25
source: issue-19
kind: requirement

The Antonina web interface makes it easy to reorder the priority of issues in the queue. Reordering changes the shared queue priority rather than only a browser-local presentation order.
