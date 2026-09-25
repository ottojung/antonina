$id-4729183650148372
title: Antonina owns its agent lifecycle
date: 2026/09/25
source: issue-3
kind: requirement

Antonina provides the agent runtime, command-line interface, durable state, lifecycle controls, and operational documentation as one product.

$id-5837462019564831
title: Antonina runtime uses only the Python standard library
date: 2026/09/25
source: issue-1
kind: constraint

The Antonina runtime has no third-party Python dependencies. Package imports are limited to the standard library and Antonina modules; external backends run as subprocesses.

$id-6194057283167408
title: Antonina packaging is self-contained
date: 2026/09/25
source: issue-3
kind: requirement

The `antonina` distribution installs and operates as a self-contained CLI. Its runtime, tests, and development commands require no surrounding application or connector.
