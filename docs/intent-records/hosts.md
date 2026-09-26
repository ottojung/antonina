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
