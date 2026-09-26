$id-5837462019564831
title: Antonina runtime uses only the Python standard library
date: 2026/09/25
source: issue-3
kind: constraint

Antonina has no third-party Python runtime dependencies. External agent backends are invoked as processes rather than imported as Python libraries.

$id-6194057283167408
title: Antonina has one canonical command
date: 2026/09/25
source: issue-3
kind: requirement

The public command is `antonina`. Alternate historical command names or compatibility launchers are not part of the product contract.
