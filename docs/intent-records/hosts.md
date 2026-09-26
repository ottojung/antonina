$id-3917852640139472
title: Host provisioning is part of Antonina
date: 2026/09/25
source: @ottojung
kind: requirement

Antonina includes the conventions and tooling needed to provision compatible hosts. A compatible host is an execution environment prepared to participate in Antonina-coordinated work rather than an unrelated machine configured ad hoc.

$id-6841027395618472
title: A collector may only touch canonical paths inside a configured managed root
date: 2026/09/26
source: @ottojung
kind: constraint

A collector may remove a path only when that path is absolute and canonical, contains no `..` traversal, and lies strictly inside one explicitly configured managed collection root. Containment is per path component, so a name that merely extends a root as a string is outside it, and a configured root is never collectible through the roots that define it. A path that reaches outside its managed root through a symlink, whether in its final component or in a directory above it, is refused. The decision is made from filesystem facts supplied by the caller, is a pure function of the configured roots and those facts, and reports the specific reason for a refusal rather than a bare verdict.

A configured root is held in both coordinate systems: the path as spelled, which is how the board records paths, and the same directory after every symlink on the way to it is followed. A candidate is located in a root by its spelled path, and every question about where it really is is answered against the root's resolved path, so a root reached through a symlinked ancestor is not mistaken for an escape. An eligible candidate yields exactly one actionable path, the one the board recorded, spelled identically; when that candidate is a symlink it is unlinked at that path, never followed and never recursed into. A collector is never handed a path spelled differently from the board-recorded one.

Configured managed collection roots are validated as a set: every entry is a spelled and resolved path, each is absolute and canonical, no root repeats in either coordinate system, and no root is nested inside another in either coordinate system. A configuration that is absent, or that names nothing but separators, is refused by name before this validation is reached and is never passed on as an empty set, so "no roots were configured" is never a state the collector proceeds on. A root is also refused when it is, or resolves to, the filesystem root: the check is in the resolved coordinate, so a symlink to `/` is refused the same way the spelling `/` is, because containment judged from `/` is vacuous and would place every absolute path on the host inside a root. In type-checked code a validated root set is only constructible through that validation, because the type carries a private brand; the decision performs no runtime brand check and therefore trusts the caller that hands it a root set, exactly as it trusts the filesystem facts the caller supplies. A candidate judged against those roots is only eligible to be touched. Eligibility is never a claim that the path is unused, and the board resource registry remains the only authority on what is protected. Path safety never answers whether a path is still needed, and liveness is never derived from a name.

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

Deleting a registered path is permitted only from a protection answer derived from a verified signed board revision, and only for a path on the host running the collector. A path another host registered is not this host's to delete. A protection answer is a property of a board revision, not of a path: the snapshot it is derived from names the board and the revision, and a per-path verdict inherits that attribution from its snapshot rather than naming the board and revision itself, so a caller can always state exactly which board it acted on.

The verification of the revision is the responsibility of the read, not of the collection code. Only a `CollectionReader` that verifies the signed log -- in practice `boardApiCollectionReader` -- can make a revision a verified signed revision; a caller that supplies a reader which does not verify gets no such guarantee. The collection code itself only re-parses the board canonically, so it can refuse state that is not a well-formed board but cannot establish that a revision was signed. A deleted board is unverified state, and the collection code establishes that itself rather than relying on `BoardApi` refusing to serve a deleted board. A host or a path that is not already canonical decides nothing: it is refused as protected, and a single malformed argument never aborts a sweep.

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

A destructive action must re-verify the path against a fresh authoritative read immediately before it is taken, and may proceed only if that read still owes nothing to the path. A re-check that cannot be completed, a path that is protected at re-check, a path that is no longer registered, a read from a different board, and a path that no configured managed root authorises all stop the action. A re-check authorizes at most one destructive action and is never reusable.

The re-check is not given a read by its caller: it builds its own verifying read from the board client it is given, so no hand-built board state can reach a destructive authorization through it. The managed-root judgment is likewise a required input rather than advice, because protection alone answers for any board-registered absolute path: without it a board could authorise collecting a configured managed root itself, or an absolute path in no managed root at all. The re-check obtains the candidate's own filesystem facts as well as making that judgment, from the collector's own path-safety side through a required gatherer it calls with the very path it named and nothing else, refusing any facts that name another path, so the facts cannot be about one path while the deletion is of another; a candidate whose facts cannot be obtained is withheld. A `collect` outcome therefore implies both that the board still owes nothing to the path and that a configured managed root authorises removing the very path the re-check named, on the strength of facts about that very path which the required gatherer supplied and which the re-check refused to accept unless they named it, and on nothing stronger.

What a re-check issues is the authority to act on the one path it read, not a token its holder may re-point: the fields an authorization carries are not frozen, and a caller still holding a writable reference to it may assign to them, but every destructive consumer of the authorization re-derives what it needs from the module-private record the re-check left behind rather than from the caller's object, so a destructive action that finds any of them changed after the re-check is refused before anything is removed, not performed against the re-pointed values and refused afterwards.

What the re-check guarantees is exactly this: the path owed nothing to any open issue at the last authoritative read. It does not guarantee that a path which became protected after that read will survive, because the interval between the completed read and the destructive action is not covered by any board primitive. The signed board log is append-only and offers no compare-and-delete and no lease, so a collector cannot close that interval; it can only narrow it. An integrating collector must therefore treat a path protected after the re-check read as a real possibility, keep the interval as short as it can make it, and must not claim otherwise. A path that was already protected at the re-check read, by contrast, is never deleted.

The collector is forbidden from lengthening that interval by observing the path again. The managed-root judgment is made from the candidate's own filesystem facts, and those facts already answer the one question a removal has left — whether the final component is itself a symlink and so must be unlinked as a link rather than descended into — so a re-check that authorizes a removal carries that instruction, and the configured root it was taken under, on the authorization itself. A collector takes the shape it was given and makes no filesystem observation of its own before removing anything: a second read would add an I/O to the end of an interval the collector is required to keep short, and would re-derive a safety decision the re-check had already made and issued. A refused re-check carries no such instruction at all, so there is no shape for a collector to act on when the re-check withheld.

$id-7319058461288540
title: Collection decides only what a path is owed, never whether it is safe
date: 2026/09/26
source: @ottojung
kind: constraint

Deciding whether a registered path is safe to touch and deciding whether it is still owed protection are separate responsibilities with separate owners. Collection answers only the second. Neither answer may be inferred from a process, directory, or file name, and no collector may widen the set of paths it may act on beyond what a verified board revision authorized.

