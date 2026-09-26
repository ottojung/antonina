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
