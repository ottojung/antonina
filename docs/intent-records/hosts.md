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

Configured managed collection roots are validated as a set: every entry is a spelled and resolved path, each is absolute and canonical, no root repeats in either coordinate system, and no root is nested inside another in either coordinate system. A validated root set can only be produced by that validation, so an unusable configuration cannot reach the decision. A candidate judged against those roots is only eligible to be touched. Eligibility is never a claim that the path is unused, and the board resource registry remains the only authority on what is protected. Path safety never answers whether a path is still needed, and liveness is never derived from a name.

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
