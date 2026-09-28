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

$id-1773008474150622
title: Persisted board format transitions are migrations, not parser shims
date: 2026/09/28
source: issue-73
kind: requirement

Every path that opens Antonina board state passes through one migration gate
(`packages/core/src/migrations.ts`, called from `verifyAndReplayOperationLog`). A
stored version mismatch selects and applies the registered migration chain
automatically, so no caller has to remember to invoke a migration. A stored
version this build has no registered path from is refused by name before
anything is written, and a board already at the current version is not migrated
or changed by being opened. Declaring a version in
`SUPPORTED_PERSISTED_BOARD_VERSIONS` without registering its migration is a
typecheck failure, and the previous supported version is covered by a signed
fixture under `packages/core/test/fixtures/`.

A migration must not rewrite bytes or semantic objects that were already signed.
It either verifies the legacy signed representation exactly as persisted and
lifts it into the current in-memory representation — which is what v2 -> v3 does,
and what keeps the stored log and its signatures byte-identical forever — or it
appends an explicitly signed migration/checkpoint operation, which is required
only when the persisted bytes themselves must change. Tampering with
pre-migration signed history stays detectable after migration support exists.

A version bump owes the superseded version a parser *and* a persisted type. The
parser table `PERSISTED_BOARD_PARSERS` is keyed by `PERSISTED_BOARD_VERSIONS`,
and each entry must return a member of the closed `PersistedBoard` union
carrying that version's own `schemaVersion`. Moving `BOARD_SCHEMA_VERSION` to 4
without first adding a `BoardV3` interface to the union makes
`PersistedBoardOfVersion<3>` resolve to `never`, and the mapped type then demands
a v3 parser returning `never` — which typechecks, and which the suite would
accept as "a reader for v3". The cheap-looking `[3]: (value: unknown) => value as
never` is therefore a hole in the table, not a reader, and is not a way to close
this obligation. The obligation is what makes a bump unable to merge with a board
the previous release wrote that this build then refuses to read on the
operation-log parse path, which is the failure board issue 104 was opened for.

$id-1773008474150623
title: A declared readable board version must be readable on every path
date: 2026/09/28
source: issue-104
kind: requirement

The versions a build declares it can read are one declaration, read by both the
parser and the migration gate, and no path may recognise a version the others do
not. `parsePersistedBoard` dispatches on `PERSISTED_BOARD_VERSIONS` over the
parser table keyed by it, so a version the gate will accept and migrate is a
version the parser has already agreed to read. A parser that branches on a single
version constant instead — rather than on the declared list — is what let a v3
board be accepted by the gate and refused by the parser at the next bump, before
`migratePersistedBoard` was ever reached.

Declaring a version without a parser is a typecheck failure, and
`everySupportedVersionHasAParser` is the runtime half of the same obligation, so
an incomplete bump is red by name rather than at some later symptom.
