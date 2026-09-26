# Verification baseline

This note is the objective baseline that the scheduled-work completion predicate
("repository verification passes on the exact resulting head") refers to. Changing a count in
this note without a stated reason is a documentation bug, not a routine update.

All counts below were observed on `0f60cf9` in the `issue-20-verify-baseline` worktree, with
`XDG_STATE_HOME` pointed at a fresh `mktemp -d` that was deleted afterwards. A *count* change is
not in itself a failure — tests get added and removed — but a *new failing test name* is.

## The commands

Every tool is invoked as `node <path-to-tool>`, never as `npm run <script>`. That is a property of
this host, not of the repository: this host has no `/usr/bin/env`, so every `npm` script shim and
the `npm` binary itself (whose shebang is `#!/usr/bin/env node`) cannot exec here. `npm ci` can be
run on this host only as `node "$(dirname "$(command -v npm)")/../lib/node_modules/npm/bin/npm-cli.js" ci --prefix web`.
The repository scripts are correct for a normal host; the direct `node` form below is the
equivalent that actually executes here.

```sh
export XDG_STATE_HOME="$(mktemp -d)"   # tests must never touch ambient ~/.local/state/antonina

node web/node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node web/node_modules/typescript/bin/tsc -p packages/agent-runtime/tsconfig.json
node web/node_modules/typescript/bin/tsc -p packages/agent-runtime/tsconfig.conformance.json
node web/node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json

node --test packages/core/test/*.test.mjs
node --test packages/agent-runtime/test/*.test.mjs
node --test packages/cli/test/*.test.mjs
node web/node_modules/vitest/vitest.mjs run --root web

node web/node_modules/typescript/bin/tsc -b web
```

`web/node_modules` must exist first (`npm ci --prefix web`); the toolchain is the repository's
locked one, installed from `web/package-lock.json`.

## Expected results

| Command | Observed on `0f60cf9` |
| --- | --- |
| `tsc -p packages/core/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.conformance.json` | exit 0, no diagnostics |
| `tsc -p packages/cli/tsconfig.json` | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 114 tests, 114 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 67 tests, 66 pass, **1 fail** |
| `node --test packages/cli/test/*.test.mjs` | 82 tests, 76 pass, **6 fail** |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |

The 7 failures are all in the two fake-`opencode` fixture files and are recorded, not hidden, in
"Known failures on this host" below.

## Known failures on this host, and a superseded claim

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

**What actually happens here.** This host's `/tmp` is mounted `noexec`. `tmpdir()` is `/tmp`, so the
fake `opencode` cannot be executed: `spawnSync` of the fixture script fails `EACCES`, and libuv's
`PATH` search then continues past the temp directory and finds the *real* `opencode` that is
installed on this host's `PATH`. The assertions that expect the fixture's output therefore see the
real backend's output instead. Reproduced directly: a `#!/bin/sh` script printing `FAKE` in a
`mkdtempSync(join(tmpdir(), ...))` directory fails to exec with `EACCES`, while the identical script
in a directory under `/workspace` execs and prints `FAKE`; and `spawnSync('opencode', ['models'])`
with that directory prepended to `PATH` returns the real model catalog.

The failure names to expect, so a later pass can tell a known failure from a new one:

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

So: the earlier records were wrong about the mechanism, and this note is the single account.
The tests are not "environmental" in the sense of needing a real binary — they need a *writable,
executable* temp directory, which this host does not provide under `/tmp`. That is a host fact and
a possible test-fixture concern for a future front; it is not fixed here.

## `npm test` is not repository verification

`npm test` (`package.json:16`) runs `test:core`, `test:runtime`, `test:cli` and `test:web`. It does
**not** run any typechecking. `packages/agent-runtime/tsconfig.conformance.json` — the project that
typechecks the conformance program holding the two `CandidatePathFacts` declarations together
(`packages/agent-runtime/src/candidate-facts.ts:16-19`) — is reachable only through the `typecheck` /
`typecheck:conformance` scripts (`package.json:10-11`). A green `npm test` is therefore not by itself
repository verification; the five `tsc` invocations above are part of the predicate. This is finding
F10 of `/workspace/antonina-coordination/issue-20-claims-audit.md` and is recorded here only, not
fixed.
