$id-9146205382714063
title: Antonina production runtime is TypeScript on Node.js
date: 2026/09/25
source: issue-28
kind: constraint

Antonina's supported production/runtime implementation is TypeScript compiled to JavaScript and executed with Node.js. Execution hosts need Node.js and intentionally external tools such as OpenCode, but not Python or a TypeScript compiler.

The runtime should use ordinary Node and POSIX process primitives. Do not add a native addon solely to reproduce pidfd/flock-level guarantees from the retired Python implementation; best-effort PID/start-time/marker validation before normal Node signalling is sufficient.

$id-6194057283167408
title: Antonina has one canonical command
date: 2026/09/25
source: issue-3
kind: requirement

The public command is `antonina`. Alternate historical command names or compatibility launchers are not part of the product contract.

$id-5081437296412058
title: Managed-agent metadata has one authoritative schema
date: 2026/09/25
source: issue-8
kind: constraint

Managed-agent durable metadata uses one exact current schema and version. Version 4 records explicitly contain every lifecycle authority field; missing fields, unknown fields, old versions, partial process identities, malformed reservations, and malformed control/steer authority are errors at the persistence boundary.

Antonina does not silently interpret old or incomplete metadata, does not synthesize legacy defaults, and does not maintain a dual-read compatibility path. A deliberate future schema change must introduce a new version and an explicit migration decision.
