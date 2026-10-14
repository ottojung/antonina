$id-2579436810427359
title: Antonina is the board and its compatible hosts
date: 2026/09/25
source: @ottojung
kind: requirement

Antonina's product boundary is the shared Antonina board together with hosts provisioned to participate in it. The board coordinates issues and durable resources; hosts provide execution environments where work can inspect that shared state and act in coordination with it. Antonina is not defined by any particular agent runtime, model provider, or coding harness.

$id-6841203759628147
title: The board is Antonina's coordination plane
date: 2026/09/25
source: @ottojung
kind: requirement

The Antonina board is the common coordination surface between people, hosts, tools, and automation. Other Antonina components should integrate with the board rather than introduce a separate competing source of issue or resource state.


$id-20261014-antonina-host-agnostic
title: Antonina contains no host-specific ownership or issue-routing policy
date: 2026/10/14
source: @ottojung
kind: constraint

Antonina itself is host-agnostic. Its CLI, board, reusable scheduler helpers, model, and shared repository must not encode specific hosts, host names, exclusive host assignments, issue-number blocklists, or project-to-host ownership. A host can inspect the same shared board without Antonina deciding which physical host should act. The shared board is a coordination plane, not a host-routing authority.

All Antonina orchestrators use the **same source-controlled prompt, scripts, and main-branch deployment** on every host. There are no private per-host Antonina scripts, alternate prompts, issue/project blocklists, or host-specific configuration overlays. Host-aware dispatch is a generic behavior: the same code reads the running hostname and the ordinary issue description, and honors an explicit execution-host restriction whenever one is present. The program stores no catalogue of which projects or issue numbers belong on which host. A deployment remains generic even when two hosts select different eligible issues.
