$id-4729183650148372
title: Antonina owns the managed-agent runtime
date: 2026/09/25
source: issue-3
kind: requirement

Antonina provides the standalone managed-agent runtime, including durable local session state, process lifecycle control, logs, and the `antonina` command-line interface.

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
