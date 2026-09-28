$id-7316842059743168
title: Skrynia is Antonina's only backend
date: 2026/09/25
source: @ottojung
kind: constraint

Antonina has no application server or trusted Antonina backend between its clients and storage. The web UI and CLI are the two client front ends and talk directly to Skrynia. Skrynia remains a simple generic database/storage service: it issues and enforces an opaque storage capability, which is generic write authority over the storage it guards, carries no issue, queue, or workflow meaning, and is consistent with, not a violation of, the requirement that follows. Antonina must not depend on adding Antonina-specific authorization, permission, delegation, business-logic, or workflow enforcement to Skrynia.

$id-7342189056173421
title: The Antonina queue always contains all open board issues
date: 2026/09/25
source: issue-19
kind: requirement

The Antonina board queue contains every currently open issue on the board. Open issues are not manually omitted from the queue.

$id-8519064273185604
title: Queue priority is easy to reorder from the web interface
date: 2026/09/25
source: issue-19
kind: requirement

The Antonina web interface makes it easy to reorder the priority of issues in the queue. Reordering changes the shared queue priority rather than only a browser-local presentation order.


$id-9057812463175402
title: The live board is materialized snapshots, not a replay log
date: 2026/09/28
source: @ottojung
kind: constraint

Antonina's live board state is stored as materialized snapshots split across Skrynia keys. Normal reads and writes do not reconstruct state by replaying an operation history. Issue summaries are paged separately from issue bodies and comment pages; queue, resource/target catalog, feed, metadata, and issue directories are separate materialized objects. A client reads only the objects needed for the operation it is performing. The legacy board-v2 signed operation log may be verified and replayed only as a one-time migration source for an existing old board; it is not the live v3 storage model, and newly initialized boards do not create a replay log.

$id-1486327095748216
title: One shared board key grants all board access
date: 2026/09/28
source: @ottojung
kind: constraint

Antonina currently has one board-wide secret. Possession of the existing board credential carrying that storage key grants full read and write access to the board; without it, a client cannot derive the materialized shard locations or mutate the board pointer. Antonina does not implement roles, per-action capabilities, delegated authorities, revocation trees, or per-shard credentials in the live access model. Existing credential fields retained for compatibility must not be interpreted as a second authorization system.

$id-6410792354862107
title: Board list reads stay summary-only until an issue is opened
date: 2026/09/28
source: @ottojung
kind: requirement

Listing or refreshing the board must use the paged issue-summary snapshots and must not fetch every issue body or comment thread. Full issue bodies and comment pages are fetched on demand for the selected issue. Normal mutations likewise operate from materialized summaries and hydrate only the issue thread they actually need, while the low-level compatibility API may still request a fully hydrated post-write state explicitly.
