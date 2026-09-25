$id-7316842059743168
title: Skrynia is Antonina's only backend
date: 2026/09/25
source: @ottojung
kind: constraint

Antonina has no application server or trusted Antonina backend between its clients and storage. The web UI and CLI are the two client front ends and talk directly to Skrynia. Skrynia remains a simple generic database/storage service; Antonina must not depend on adding Antonina-specific authorization, permission, delegation, business-logic, or workflow enforcement to Skrynia.

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
