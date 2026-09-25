$id-4729183650148372
title: Antonina is an independent optional agent runtime
date: 2026/09/25
source: issue-1
kind: requirement

Antonina owns the standalone agent runtime. It is optional and must not be required to run Lubko.

$id-5837462019564831
title: Antonina runtime uses only the Python standard library
date: 2026/09/25
source: issue-1
kind: constraint

The Antonina runtime has no third-party runtime dependencies and no dependency on the Lubko Python package.

$id-6194057283167408
title: Antonina is independent of Lubko packaging
date: 2026/09/25
source: issue-1
kind: requirement

Antonina may be installed and operated independently of Lubko. Lubko must not import Antonina or expose Antonina as a Lubko command.
