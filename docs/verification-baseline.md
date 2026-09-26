# Verification baseline

This note is the objective baseline that the scheduled-work completion predicate
("repository verification passes on the exact resulting head") refers to. Changing a count in
this note without a stated reason is a documentation bug, not a routine update.

All counts below were observed on `0f60cf9` in the `issue-20-verify-baseline` worktree, with
`XDG_STATE_HOME` pointed at a fresh `mktemp -d` that was deleted afterwards **and `TMPDIR` pointed at
an executable directory** (as pinned in "The commands" below). `TMPDIR` decides these numbers, so
every count here is the count *for that setting*; the other account, with the default noexec `/tmp`,
is recorded in full rather than omitted. A *count* change is not in itself a failure — tests get
added and removed — but a *new failing test name* is, and so is a *known failing name that starts
passing*. Both directions are changes needing a stated reason, so that a later pass never has to
choose between "the note is stale" and "it was fixed".

## The commands

Every tool is invoked as `node <path-to-tool>`, never as `npm run <script>`. That is a property of
this host, not of the repository: this host has no `/usr/bin/env`, so every `npm` script shim and
the `npm` binary itself (whose shebang is `#!/usr/bin/env node`) cannot exec here. `npm ci` can be
run on this host only as `node "$(dirname "$(command -v npm)")/../lib/node_modules/npm/bin/npm-cli.js" ci --prefix web`.
The repository scripts are correct for a normal host; the direct `node` form below is the
equivalent that actually executes here.

```sh
export XDG_STATE_HOME="$(mktemp -d)"   # tests must never touch ambient ~/.local/state/antonina
export TMPDIR=/workspace/tmp-verify    # must be executable; /tmp is mounted noexec on this host

node web/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node web/node_modules/typescript/bin/tsc -p packages/agent-runtime/tsconfig.json
node web/node_modules/typescript/bin/tsc -p packages/agent-runtime/tsconfig.conformance.json
node web/node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json

node --test packages/core/test/*.test.mjs
node --test packages/agent-runtime/test/*.test.mjs
node --test packages/cli/test/*.test.mjs
node web/node_modules/vitest/vitest.mjs run --root web

node web/node_modules/typescript/bin/tsc -b web
node web/node_modules/vite/bin/vite.js build web --config web/vite.config.ts
```

`TMPDIR` is not optional decoration. `os.tmpdir()` honours it, the two fake-`opencode` fixtures
create their script there, and the script cannot be executed from this host's `/tmp`
(`tmpfs ... noexec` in `/proc/mounts`). Pinning it to a directory on the executable `/workspace` btrfs
mount is the difference between 7 failures and 0. Do not reorder the list: the four `tsc -p` steps
also emit the `packages/*/dist` trees that the tests import
(`packages/cli/test/agent.e2e.test.mjs:15`, `packages/agent-runtime/test/backend.test.mjs:16`), so
they must precede the suites — deleting all three `dist` directories and running only the four
`tsc -p` steps regenerates them.

`web/node_modules` must exist first (`npm ci --prefix web`); the toolchain is the repository's
locked one, installed from `web/package-lock.json`. Observed tool versions on this host:
`typescript` 5.9.3, `vitest` 3.2.7, `node` 24.21.0.

### This list is a subset of the canonical harness

The list above is *not* the whole of repository verification, and it is not intended to be. The
canonical entry point is `/workspace/antonina-coordination/verify-antonina.sh <checkout>`, the
harness the coordinator runs. It performs the four `tsc -p` steps, the four test suites, and
`tsc -b web`, plus the **web production build**
(`node web/node_modules/vite/bin/vite.js build web --config web/vite.config.ts`, harness `:34`),
which is included above for that reason. The harness runs the conformance `tsc` conditionally — only
`if [ -f packages/agent-runtime/tsconfig.conformance.json ]` — whereas the list above runs it
unconditionally, which is the stricter of the two. The harness uses `set -e`, so a non-zero exit
from it names no failing step on its own; read its log. The harness does not set `XDG_STATE_HOME`
itself, so the caller must.

## Expected results, for `TMPDIR=/workspace/tmp-verify`

| Command | Observed on `0f60cf9` |
| --- | --- |
| `tsc -p packages/core/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.conformance.json` | exit 0, no diagnostics |
| `tsc -p packages/cli/tsconfig.json` | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 114 tests, 114 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 67 tests, 67 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 82 tests, 82 pass, 0 fail |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0 |

Under that setting there are **no** known failures. Running the canonical harness the same way —
`TMPDIR=/workspace/tmp-verify XDG_STATE_HOME="$(mktemp -d)" sh
/workspace/antonina-coordination/verify-antonina.sh <checkout>` — ends `verify: ok`, exit 0, with
114/114, 67/67, 82/82 and 94/94. That is the shape of the green log
`logs/verify-0f60cf9.log` (13:27 on 2026-09-26): it is green because `TMPDIR` pointed at an
executable directory, not because `/tmp` was ever executable. `/tmp` is a `noexec` tmpfs in
`/proc/mounts` with no sign of having been otherwise.

## The other account: default `TMPDIR` (this host's noexec `/tmp`)

| Command | Observed on `0f60cf9` |
| --- | --- |
| the four `tsc -p` steps | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 114 tests, 114 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 67 tests, 66 pass, **1 fail** |
| `node --test packages/cli/test/*.test.mjs` | 82 tests, 76 pass, **6 fail** |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| the harness end to end | exit 1, aborting at the agent-runtime suite (`set -e`) |

Only the two fake-`opencode` fixture files are affected by `TMPDIR`; the other rows are identical
under both accounts. So 7 failures is a real, reproducible result *for the noexec default* and 0 is
a real, reproducible result *for a pinned executable `TMPDIR`*. Neither is the whole truth, and
this note now states both. A later pass that sees 7 known failures under an unpinned `TMPDIR` has
not found a regression; a later pass that sees 0 under a pinned `TMPDIR` has not found a fix either.

The 7 failures under the noexec account are all in the two fake-`opencode` fixture files and are
recorded, not hidden, in "Known failures under the noexec account" below.

## Known failures under the noexec account, and a superseded claim

**Superseded.** Several earlier coordination records asserted that
`packages/cli/test/agent.e2e.test.mjs` (6 cases) and
`packages/agent-runtime/test/backend.test.mjs:92` fail "for environmental reasons, because they
exec a real `opencode` binary". That account is wrong and is withdrawn here. Both files build their
own fake `opencode` shell script in a temp directory and prepend that directory to `PATH`, so they
require no real `opencode` at all:

- `packages/cli/test/agent.e2e.test.mjs:17-66` — `fixture()` does
  `mkdtempSync(join(tmpdir(), 'antonina-cli-e2e-'))`, writes a `#!/bin/sh` script that answers
  `models` / `session` / `run` and exits 2 otherwise (`:24-56`), `chmodSync(opencode, 0o755)` (`:57`),
  and sets `PATH: \`${bin}:${process.env.PATH ?? ''}\`` (`:60`).
- `packages/agent-runtime/test/backend.test.mjs:19-23, 92-107` — the same pattern, with the fake
  rewritten three times to model a present / absent / transport-failing model catalog.

**What actually happens under the noexec account.** This host's `/tmp` is mounted `noexec`
(`tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,relatime,size=65536k` in `/proc/mounts`). With `TMPDIR`
unset, `tmpdir()` is that `/tmp`, so the fake `opencode` cannot be executed: `spawnSync` of the
fixture script fails `EACCES`, and libuv's `PATH` search then continues past the temp directory and
finds the *real* `opencode` that is installed on this host's `PATH`. The assertions that expect the
fixture's output therefore see the real backend's output instead. Reproduced directly: a `#!/bin/sh`
script printing `FAKE` in a `mkdtempSync(join(tmpdir(), ...))` directory fails to exec with `EACCES`,
while the identical script in a directory under `/workspace` execs and prints `FAKE`; and
`spawnSync('opencode', ['models'])` with that directory prepended to `PATH` returns the real model
catalog. Setting `TMPDIR` to an executable directory removes the `EACCES` and the fixture is used, so
all 7 tests pass — the fall-through to the real `opencode` on `PATH` is a genuine test defect (the
fixture silently does not fail closed when it cannot exec), and it is recorded here rather than fixed.

The failure names to expect **under the noexec account**, so a later pass can tell a known failure
from a new one — and, by the symmetric rule above, so it can tell a known name that has *stopped*
failing from a silent fix:

- agent-runtime, 1 failure: `configured model catalog distinguishes absence from transport failure`
  (`packages/agent-runtime/test/backend.test.mjs:92`) — asserts `false` at `:102`, gets `true` from
  the real catalog.
- cli, 6 failures, all in `packages/cli/test/agent.e2e.test.mjs`:
  `built CLI runs a fresh prompt then continues the discovered OpenCode session` (`:89`),
  `hard steer interrupts the running process group and drains redirect FIFO` (`:110`),
  `stale reserved work is recovered without overwriting the accepted prompt` (`:138`),
  `backend server failure is persisted and sanitized through status` (`:261`),
  `prompt recovers an existing OpenCode session when durable session id was lost` (`:278`),
  `attached prompt streams output and returns invocation status` (`:386`).

So: the earlier records were wrong about the mechanism, and this note is the account of both
outcomes it supersedes — for the noexec `/tmp` default and for a pinned executable `TMPDIR` — though
it is not the whole of repository verification, which is `verify-antonina.sh` (see above). The tests
are not "environmental" in the sense of needing a real binary — they need a *writable, executable*
temp directory, which this host does not provide under `/tmp`, which is why the commands above set
`TMPDIR`. That is a host fact and a possible test-fixture concern for a future front; it is not
fixed here.

## `npm test` is not repository verification

`npm test` (`package.json:16`) runs `test:core`, `test:runtime`, `test:cli` and `test:web`. It does
**not** run any typechecking. `packages/agent-runtime/tsconfig.conformance.json` — the project that
typechecks the conformance program holding the two `CandidatePathFacts` declarations together
(`packages/agent-runtime/src/candidate-facts.ts:16-19`) — is reachable only through the `typecheck` /
`typecheck:conformance` scripts (`package.json:10-11`). A green `npm test` is therefore not by itself
repository verification; the five `tsc` invocations above are part of the predicate, and so is the web
production build — the predicate is the whole of `verify-antonina.sh`, not the command list above,
which is a deliberately explicit subset of it. This is finding F10 of
`/workspace/antonina-coordination/issue-20-claims-audit.md` and is recorded here only, not fixed.
