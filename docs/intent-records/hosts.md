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

Configured managed collection roots are validated as a set: every entry is a spelled and resolved path, each is absolute and canonical, no root repeats in either coordinate system, and no root is nested inside another in either coordinate system. A configuration that is absent, or that names nothing but separators, is refused by name before this validation is reached and is never passed on as an empty set, so "no roots were configured" is never a state the collector proceeds on. A root is also refused when it is, or resolves to, the filesystem root, and that refusal is made where the roots are loaded rather than in the root-set validation this paragraph describes: it is two ordered checks carrying distinct defect kinds, one on the spelling refused before this entry is resolved and one on the resolved path refused after the resolution that produces it, so a symlink to `/` is refused the same way the spelling `/` is while the two operator mistakes still read differently. The reason for both is the same: containment judged from `/` is vacuous and would place every absolute path on the host inside a root. In type-checked code a validated root set is only constructible through that validation, because the type carries a private brand; the decision performs no runtime brand check and therefore trusts the caller that hands it a root set, exactly as it trusts the filesystem facts the caller supplies. A candidate judged against those roots is only eligible to be touched. Eligibility is never a claim that the path is unused, and the board resource registry remains the only authority on what is protected. Path safety never answers whether a path is still needed, and liveness is never derived from a name.

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

A destructive action must re-verify the path against a fresh authoritative read immediately before it is taken, and may proceed only if that read still owes nothing to the path. A re-check that cannot be completed, a path that is protected at re-check, a path that is no longer registered, a read from a different board, and a path that no configured managed root authorises all stop the action. Single-use is enforced where the record of the issue is consumed, which is the commit, and the commit follows the action, so what one re-check bounds is the number of completion records it can produce and not the number of removals performed from it: a removal reads that same record and does not spend it, and one re-check is therefore no guarantee that a path is removed at most once. A removal that was performed is owed exactly one commit, and nothing in the re-check performs it for the collector.

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

$id-6971682678022844
title: The two declarations of a candidate's filesystem facts are one shape
date: 2026/09/26
source: @ottojung
kind: constraint

A candidate's filesystem facts are declared twice, once as the recipe the shared board model consumes and once as the declaration a host-side gatherer returns, and the two are two declarations of one thing rather than two things permitted to drift. They are held together by mutual assignability: each must be assignable to the other, in both directions, so a fact added, removed, or retyped on one side is a change to the other as well. One direction is not the constraint and does not satisfy it, because a one-directional reading tolerates precisely the failure the constraint exists to exclude: the recipe naming a fact that the gatherer never supplies, so a re-check proceeds on facts that answer less than it asked. An extra fact the gatherer supplies and the recipe does not name is the same failure from the other side, since the recipe would be answering a question the facts do not answer. The two directions are written as two assertions rather than as one assertion covering both directions, and that duplication is deliberate: a simplification which collapsed them into a single one-way assertion would look like tidying and would restore exactly the one-directional reading this record refuses.

The re-check is entitled to the completeness of this shape and to nothing looser. What a required gatherer owes is the recipe, so a re-check that receives a gatherer declaration differing from the recipe in any field, in either direction, has been handed a gatherer that opted out of the guarantees the re-check issues; a re-check is never entitled to treat whatever a gatherer happened to return as the facts it was promised, and the fact that a gatherer is a required input is a requirement on the shape of what it returns and not merely on its presence. That completeness is a property of the two declarations as they stand when they are brought together, and nothing at runtime looks for a gatherer that has drifted away from it: a re-check compares the facts it was handed for completeness against nothing beyond the path they name, and then judges those very facts on their own merits, so a gatherer that omitted a fact the recipe requires, or supplied one the recipe does not, would be taken at its word without ever answering for itself, a fact it supplied that the recipe does not name being carried along unread and a fact it failed to supply reaching the re-check as absent, the two absences ending the re-check differently because the judgment reads those facts differently: an absent `path` fact is caught by the check that the facts name the claimed path and ends the re-check as the named withheld outcome `candidate-facts-unavailable`, while an absent `resolvedPath` or `parentResolvedPath` is read as a path by the managed-root judgment and ends the re-check by throwing rather than by answering, no reason being named for it because that judgment returns none, a candidate in no configured root having been refused before it is read, so a divergence of the declaration itself is not something the re-check can observe.

The coupling fixes the shape and nothing else. It does not establish how the facts are gathered: nothing holds a gatherer to having really resolved the resolved path, or to having examined the final component rather than assumed it, so the recipe remains the only account of the gathering, and a change to the gathering is a change to the recipe rather than a private detail of an implementation. Nor does it freeze the shape, and it is not a gate against change: a fact may be added to both declarations at once, which is a decision about what a re-check may rely on and not a refactor of how it relies on it. A declaration that is widened past the recipe has not thereby been excused: made to admit any set of fields through an index signature, it is caught rather than let through, because such a declaration cannot stand in for one naming fixed facts, in the direction that requires the recipe to fit it, unless those values are admitted at `any`, and a widened declaration carrying such an index signature over `any` values, intersected onto the recipe, fits the recipe in either direction, so such a declaration satisfies the comparison in both directions by admitting anything at all. That strictness is itself contingent on how the recipe is spelled, and the contingency runs the other way: a bare index signature is assignable to the recipe under neither spelling, whatever its values, while a recipe spelled as a type alias carries an implicit index signature and is therefore itself assignable to a bare index signature whose values admit both the string and the boolean facts, which a recipe declared as an interface is only where those values are admitted at `any`, so rewriting the recipe as an alias admits a widened declaration the interface form rejected. A declaration can be loosened past the recipe and still satisfy the comparison in both directions, because assignability in either direction sees neither a field the recipe does not name that is optional nor a field whose type has been widened to `any`, so what such a declaration has given up is description rather than compatibility, and a declaration admitting values of any kind has given up both, matching everything by construction and having therefore broken the constraint while appearing to satisfy it; mutual assignability is a statement about two declarations being the same, and it is silent about whether either one is still a description of the facts a re-check needs. What the constraint withholds is only the ability to make the two disagree.

$id-3917852640139473
title: Reclaiming a stale metadata lock narrows the window it cannot close
date: 2026/09/26
source: issue-20
kind: constraint

A host that finds a metadata lock whose recorded owner is judged dead may reclaim it, and what makes that safe is that the reclaim re-reads the lock and unlinks it only when the record it re-read is byte-for-byte the same acquisition it judged dead — same acquisition identity and same content, with a tokenless record falling back to exact-content identity because pid and start ticks alone would let a different acquisition sharing them be unlinked. What the reclaim does not have, and must not be described as having, is an exclusive claim on the lock path across that re-read and the unlink that follows it. Between the two there is an interval in which another owner can have reclaimed the same stale lock and installed its own live lock, and this reclaim's unlink can then remove a lock it never judged. That window is a property of the primitives, not of this implementation: POSIX offers no compare-and-unlink, so nothing in ordinary Node or POSIX can make the judgment and the removal one act. A narrowing that shortens the interval, and a refusal when the re-read no longer shows the same acquisition, are the whole of what is available, and a reclaim that keeps the interval is not thereby claiming it closed.

The alternative considered for this window and deliberately rejected is quarantining the lock by renaming it aside and unlinking the renamed file. It is worse, not better, and the reason is worth recording so it is not relitigated blind. Renaming replaces one unexamined window with a longer chain of the same unexamined windows: the re-read, then the rename, then the unlink, each of which another owner can interleave with, so the operation that was meant to take the path out of contention adds two further steps in which a live owner's lock can be moved or removed. A rename also destroys the evidence the re-read depends on — once the record has been moved, nothing at the lock path states which acquisition the judgment was about, so a failure after the rename leaves a quarantined file that no later reader can attribute, and a reclaim that crashes there leaves the lock path free with a stale record beside it that nothing reclaims. Since the residual interval is already irreducible, the honest form of this code is the narrow one: judge, re-read, unlink only what the re-read still shows, and state the remaining window rather than trading it for a longer unstated one.

$id-3917852640139474
title: An execution target is not a resource
date: 2026/09/26
source: issue-21
kind: constraint

An execution target and a resource are different kinds of thing and neither is
stored as the other. A resource is a durable filesystem path an open issue
depends on; an execution target is an environment a job may be dispatched to. A
target declares which backend runs it, whether it is a persistent host or an
ephemeral environment, and what it can do; its capabilities, backend, and kind
come from closed vocabularies rather than from free-form strings, because
matching a requirement is a question about typed membership. A target that is an
ephemeral environment has no durable host filesystem and therefore no resource
anywhere in the board, and a target that is a persistent host answers to one
canonical `lubko://` address, which is what relates it to the resources
registered on that host. The relation is derived, so a resource never carries a
second spelling of the host it belongs to, and a resource on a host no target
claims is reported as belonging to no target rather than being attached to the
nearest one. No target is privileged by name: the catalog, not `phoebe-dev`,
decides what work can run where.

Where a target is dispatched, the backend behind it remains responsible for
running the work. Antonina decides and records which target a job runs on; it
does not reimplement the transport to a Lubko host, and it does not claim to
know whether a host is reachable at the moment it is selected. What a target
declares is a registration, and a target whose recorded status says it is
unavailable is refused by name rather than skipped in favour of another target.

$id-3917852640139475
title: A target selection is a decision, not a fallback
date: 2026/09/26
source: issue-21
kind: constraint

Selecting the target a job runs on is a decision made once, from the verified
board and the request, and it is reported rather than merely performed. The same
board and the same request always select the same target: candidates are ordered
by target identity, a target the request names is taken as given or refused by
name, and otherwise the eligible target declaring the fewest capabilities the
request did not ask for wins, ties broken by the lower target identity.
Nothing in the decision consults the clock, the registry's order, or a host's
liveness. A request no target satisfies fails with an outcome naming which
targets were considered and which requirement refused each, so an unknown
target, an unavailable target, an ineligible target, and an unsatisfiable
request are four distinguishable results. The rationale travels with the
decision: the dispatch record on the board carries the reason the target was
chosen, so the board itself explains a routing choice rather than leaving it
to be reconstructed.
