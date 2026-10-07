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

$id-7391028465183724
title: Runner owner token is read from the caller environment
date: 2026/10/07
source: issue-197
kind: limit

The runner owner token is verified against `options.env ?? process.env` at the claim site. A process that controls the environment it launches a runner in can therefore self-authorize an ownership claim by setting `RUNNER_OWNER_TOKEN_ENV` to a value it obtained or forged. No channel outside the durable state directory and the writer's control currently exists from which a reparented runner can re-derive its launcher's identity. This is a recorded LIMIT, not a code defect: no front may adopt such a channel because it changes shipped behaviour. A human ruling is required on whether an authorised channel exists and, if not, whether the self/declared claim shape is retired.
