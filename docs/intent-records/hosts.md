$id-3917852640139472
title: Host provisioning is part of Antonina
date: 2026/09/25
source: @ottojung
kind: requirement

Antonina includes the conventions and tooling needed to provision compatible hosts. A compatible host is an execution environment prepared to participate in Antonina-coordinated work rather than an unrelated machine configured ad hoc.

$id-7426031958142670
title: Antonina hosts inspect and respect the board
date: 2026/09/25
source: @ottojung
kind: requirement

An Antonina host must be able to inspect current Antonina board state and be configured so work running on the host can use that state for coordination. Host-local tools and automation should respect issue ownership, durable resources, and other board conventions relevant to the work they perform.

$id-5182694371058264
title: Hosts do not require a particular agent runtime
date: 2026/09/25
source: @ottojung
kind: constraint

Compatibility with Antonina is defined by participation in the board and host conventions, not by running a specific agent runtime. A host may use OpenClaw, OpenCode, other automation, ordinary scripts, or human-operated tools as appropriate.

$id-2640118735194607
title: A host deletes a registered path only from a verified board revision
date: 2026/09/26
source: @ottojung
kind: constraint

Deleting a registered path is permitted only from a protection answer derived from a verified signed board revision, and only for a path on the host running the collector. A path another host registered is not this host's to delete. A protection answer is a property of a board revision, not of a path: it must name the board and revision it came from so a caller can state exactly which board it acted on.

The verification of the revision is the responsibility of the read the caller supplies, not of the collection code. Only a `CollectionReader` that verifies the signed log -- in practice `boardApiCollectionReader` -- can make a revision a verified signed revision; a caller that supplies a reader which does not verify gets no such guarantee. The collection code itself only re-parses the board canonically, so it can refuse state that is not a well-formed board but cannot establish that a revision was signed.

$id-8103472669244713
title: Protection of a registered path is owed only to open board issues
date: 2026/09/26
source: @ottojung
kind: requirement

A registered path is protected while any issue that depends on it is open, and collectible only when no open issue depends on it. Reopening a dependent issue, adding a dependent issue, or otherwise registering a new dependency protects the path again. This is the one rule that decides protection, and it lives in the shared board model so no collector, CLI command, or board view can compute a different answer.

$id-6620371892455731
title: An unreadable board protects everything
date: 2026/09/26
source: @ottojung
kind: constraint

A protection answer may only be derived from a board this client has verified. If the board cannot be read, cannot be verified, or no longer validates, then there is no protection answer at all and every path is protected. An unreadable board is never an empty registry, and a resource whose dependent issues cannot be resolved is never a collectible path.

$id-4492810560173644
title: A destructive action re-checks protection against a fresh read
date: 2026/09/26
source: @ottojung
kind: constraint

A destructive action must re-verify the path against a fresh authoritative read immediately before it is taken, and may proceed only if that read still owes nothing to the path. A re-check that cannot be completed, a path that is protected at re-check, a path that is no longer registered, and a read from a different board all stop the action. A re-check authorizes at most one destructive action and is never reusable.

What the re-check guarantees is exactly this: the path owed nothing to any open issue at the last authoritative read. It does not guarantee that a path which became protected after that read will survive, because the interval between the completed read and the destructive action is not covered by any board primitive. The signed board log is append-only and offers no compare-and-delete and no lease, so a collector cannot close that interval; it can only narrow it. An integrating collector must therefore treat a path protected after the re-check read as a real possibility, keep the interval as short as it can make it, and must not claim otherwise. A path that was already protected at the re-check read, by contrast, is never deleted.

$id-7319058461288540
title: Collection decides only what a path is owed, never whether it is safe
date: 2026/09/26
source: @ottojung
kind: constraint

Deciding whether a registered path is safe to touch and deciding whether it is still owed protection are separate responsibilities with separate owners. Collection answers only the second. Neither answer may be inferred from a process, directory, or file name, and no collector may widen the set of paths it may act on beyond what a verified board revision authorized.

