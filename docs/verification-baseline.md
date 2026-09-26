# Verification baseline

This note is the objective baseline that the scheduled-work completion predicate
("repository verification passes on the exact resulting head") refers to. Changing a count in
this note without a stated reason is a documentation bug, not a routine update.

All counts below were observed on `e2b4d96` in the `issue-20-verify-baseline-2` worktree, with
`XDG_STATE_HOME` pointed at a fresh `mktemp -d` that was deleted afterwards, **under both
`TMPDIR` accounts**: a pinned executable `TMPDIR=/workspace/tmp-verify`, and `TMPDIR` unset (this
host's `noexec` `/tmp`). On this head both accounts are green and the counts agree; the two
accounts are still kept apart, because the mechanism that made them differ is new and a later
pass must be able to tell "fixed" from "not reached". A *count* change is not in itself a failure
— tests get added and removed — but a *new failing test name* is, and so is a *known failing name
that starts passing*. Both directions are changes needing a stated reason, so that a later pass
never has to choose between "the note is stale" and "it was fixed".

**Lineage.** This note was first written against `0f60cf9` by `9781ecc` and amended by `47784c4`.
Both are **docs-only** commits — each touches `docs/verification-baseline.md` and nothing else
(`git show --stat 9781ecc 47784c4`) — so no test-affecting commit is covered by them. The counts
they recorded were 114/67/82/94, and the `packages/core` figure of 114 they recorded is the one
re-measured here. Two test-affecting commits have landed since and are the reason the counts moved:
`e1de211` (the fake-`opencode` fixture path guard) and `e2b4d96` (three review Errors on it).
Their effect on the numbers is stated per row below, with the reason, per the rule above.

## The commands

Every tool is invoked as `node <path-to-tool>`, never as `npm run <script>`. That is a property of
this host, not of the repository: this host has no `/usr/bin/env`, so every `npm` script shim and
the `npm` binary itself (whose shebang is `#!/usr/bin/env node`) cannot exec here. `npm ci` can be
run on this host only as `node "$(dirname "$(command -v npm)")/../lib/node_modules/npm/bin/npm-cli.js" ci --prefix web`.
The repository scripts are correct for a normal host; the direct `node` form below is the
equivalent that actually executes here.

```sh
export XDG_STATE_HOME="$(mktemp -d)"   # tests must never touch ambient ~/.local/state/antonina
export TMPDIR=/workspace/tmp-verify    # optional on this head; see below

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

`TMPDIR` is no longer what decides these numbers, and that is itself a measured result, not an
inference. As of `e1de211` the two fake-`opencode` fixtures no longer write into `tmpdir()`
unconditionally: `selectExecRoot` (`packages/agent-runtime/test/backend.test.mjs:63-89`,
`packages/cli/test/agent.e2e.test.mjs:64-90`) *probes* candidate parents in order — first
`os.tmpdir()`, then the repo-local `<repo>/.antonina-test-tmp` — by writing a `#!/bin/sh` probe and
exec'ing it, and takes the first that actually execs. If none execs it throws
`ANTONINA_FIXTURE_NOEXEC` rather than letting a bare `opencode` lookup fall through to a real host
backend. The probe result, not `TMPDIR`, decides. Pinning `TMPDIR` to a directory on the executable
`/workspace` btrfs mount still works and still uses that directory, because it is first in the
candidate list and it execs; leaving `TMPDIR` unset now also works, because the second candidate is
on the repo's own filesystem. Both are recorded below because "one of them silently regressed" is
still a question a later pass has to be able to answer.

Do not reorder the list: the four `tsc -p` steps
also emit the `packages/*/dist` trees that the tests import
(`packages/cli/test/agent.e2e.test.mjs:17`, `packages/agent-runtime/test/backend.test.mjs:20`), so
they must precede the suites — deleting all three `dist` directories and running only the four
`tsc -p` steps regenerates them.

`web/node_modules` must exist first (`npm ci --prefix web`); the toolchain is the repository's
locked one, installed from `web/package-lock.json`. Observed tool versions on this host:
`typescript` 5.9.3, `vitest` 3.2.7, `node` 24.21.0.

### This list is a subset of the canonical harness

The list above is *not* the whole of repository verification, and it is not intended to be. The
canonical entry point is `/workspace/antonina-coordination/verify-antonina.sh <checkout>`, the
harness the coordinator runs. It makes exactly four `tsc -p` invocations, of which three are
unconditional and the conformance one is conditional on the project file existing, plus a fifth
`tsc` invocation as `tsc -b web`; it runs the four test suites; and it runs the **web production
build** (`node web/node_modules/vite/bin/vite.js build web --config web/vite.config.ts`, harness
`:34`) as the last step before its final line. The build is listed above for that reason. The
harness runs the conformance `tsc` conditionally — only
`if [ -f packages/agent-runtime/tsconfig.conformance.json ]` — whereas the list above runs it
unconditionally, which is the stricter of the two. The harness uses `set -e`, so a non-zero exit
from it names no failing step on its own; read its log. The harness does not set `XDG_STATE_HOME`
itself, so the caller must.

## Expected results, for `TMPDIR=/workspace/tmp-verify`

Command run (2026-09-26, this worktree, `web/node_modules` copied in from
`/workspace/antonina/web/node_modules` and not committed):

```sh
TMPDIR=/workspace/tmp-verify XDG_STATE_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-issue20-baseline2
```

Result: **exit 0**, final line `verify: ok`, in about 20 s. Log:
`/workspace/antonina-coordination/logs/verify-e2b4d96-pinned.log`.

| Command | Observed on `e2b4d96` |
| --- | --- |
| `tsc -p packages/core/tsconfig.json` | exit 0, no diagnostics (`typecheck: ok`) |
| `tsc -p packages/agent-runtime/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.conformance.json` | exit 0, no diagnostics |
| `tsc -p packages/cli/tsconfig.json` | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 114 tests, 114 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 71 tests, 71 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 85 tests, 85 pass, 0 fail |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0, `built in 705ms` |

Under that setting there are **no** known failures. Three of the four counts differ from the
`0f60cf9` table, and the reason is test additions in the two fixture files, not a behaviour change:
agent-runtime 67 → 71 (`e1de211` and `e2b4d96` added fixture-guard and `resolveOpencode` cases,
including the non-absolute-override refusal and the guard's own named-failure case), cli 82 → 85,
and web and core unchanged. Each was measured on this head by the run above; none is carried
forward from the previous note.

The earlier green log `logs/verify-0f60cf9.log` (13:27 on 2026-09-26) was attributed to the pinned
`TMPDIR` by inference from the fact that `/tmp` is `noexec`. The attribution is not inferential, and
does not rest on reading an environment out of a log — the harness log does not record `TMPDIR` at
all. It rests on a pair of runs of the *same* harness on the *same* checkout, differing in exactly
one variable: the pinned run is green end to end, the unpinned run (table below) aborts at the
agent-runtime suite, and the set of tests failing in the unpinned run is precisely the set of tests
whose fake `opencode` is written under `tmpdir()`. A variable that is the only difference between
a run and its counterfactual, and whose mechanism is directly observable, is the cause. That
reasoning applied to `0f60cf9`; it no longer has anything to explain on `e2b4d96`, because both
accounts are green.

## The other account: `TMPDIR` unset (this host's `noexec` `/tmp`)

```sh
env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-issue20-baseline2
```

Result: **exit 0**, final line `verify: ok`. Nothing aborted; the question of which step a non-zero
exit would have named does not arise on this head. Log:
`/workspace/antonina-coordination/logs/verify-e2b4d96-unpinned.log`.

| Command | Observed on `e2b4d96` |
| --- | --- |
| the four `tsc -p` steps | exit 0, no diagnostics (`typecheck: ok`) |
| `node --test packages/core/test/*.test.mjs` | 114 tests, 114 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 71 tests, 71 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 85 tests, 85 pass, 0 fail |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0 |
| the harness end to end | **exit 0**, `verify: ok` — no step aborted |
| worktree afterwards | `git status --porcelain` empty; no `.antonina-test-tmp` left behind |

This table is the change of record. On `0f60cf9` the same unpinned account was
agent-runtime 66/67 and cli 76/82 with the harness exiting 1 at the agent-runtime suite; on
`e2b4d96` it is 71/71 and 85/85 with the harness exiting 0. Reason: `selectExecRoot` probes
`os.tmpdir()`, gets `EACCES` on this `noexec` tmpfs, and falls through to the repo-local
`.antonina-test-tmp` on the executable `/workspace` btrfs mount, which execs. The seven known
failures recorded at `0f60cf9` are therefore *known names that stopped failing* and are kept below
under that heading, per the symmetric rule at the top of this note — not deleted.

## Known names that stopped failing at `e1de211` / `e2b4d96`

At `0f60cf9`, under the unpinned noexec account, 7 tests failed: 1 in
`packages/agent-runtime/test/backend.test.mjs:92` and 6 in `packages/cli/test/agent.e2e.test.mjs`.
All 7 pass on `e2b4d96` under that same account, and the whole harness is green. The names, kept so
a later pass can recognise them:

- agent-runtime, 1 name: `configured model catalog distinguishes absence from transport failure`
  (`packages/agent-runtime/test/backend.test.mjs:92`).
- cli, 6 names, all in `packages/cli/test/agent.e2e.test.mjs`:
  `built CLI runs a fresh prompt then continues the discovered OpenCode session` (`:89`),
  `hard steer interrupts the running process group and drains redirect FIFO` (`:110`),
  `stale reserved work is recovered without overwriting the accepted prompt` (`:138`),
  `backend server failure is persisted and sanitized through status` (`:261`),
  `prompt recovers an existing OpenCode session when durable session id was lost` (`:278`),
  `attached prompt streams output and returns invocation status` (`:386`).

**Why they stopped failing.** Not because `TMPDIR` changed: the run above has it unset. The
fall-through defect was real and it was fixed. `e1de211` made the fixture choose an exec-able root
by probing, and made the *backend seam itself* refuse a value that could fall through —
`resolveOpencode` (`packages/agent-runtime/src/backend.ts:77-92`) now requires
`ANTONINA_OPENCODE_BIN` to be absolute, so `opencode`, `./bin/opencode` and any other relative
value throw instead of being resolved against `PATH` or the cwd, and there is no bare-name lookup
left in the fixture path. `e2b4d96` closed three review Errors on that guard: the absolute-path
refusal above; `.antonina-test-tmp` added to `.gitignore`, with the root's cleanup registered inside
`selectExecRoot` at the moment the directory is created so it also covers the no-exec throw path and
a mid-suite abort; and the prune changed from `rmSync(path, { recursive: false })` to `rmdirSync` —
the former fails `EISDIR` on a directory on Node 22+, so the previous bare `catch {}` was a silent
no-op — with the `t.diagnostic` that now reports a genuine leftover. The measured worktree-clean
row above is the check that the last two of those work.

## History: the `0f60cf9` noexec account, and a superseded claim (kept)

This section is retained deliberately. The defect it describes was real, was found by measurement,
and is the reason the guard exists; a reader must not conclude the fall-through was never there.

**Superseded.** Several earlier coordination records asserted that
`packages/cli/test/agent.e2e.test.mjs` (6 cases) and
`packages/agent-runtime/test/backend.test.mjs:92` fail "for environmental reasons, because they
exec a real `opencode` binary". That account is wrong and is withdrawn here. Both files build their
own fake `opencode` shell script in a temp directory and prepend that directory to `PATH`, so they
require no real `opencode` at all:

- `packages/cli/test/agent.e2e.test.mjs:17-66` at `0f60cf9` — `fixture()` did
  `mkdtempSync(join(tmpdir(), 'antonina-cli-e2e-'))`, wrote a `#!/bin/sh` script that answers
  `models` / `session` / `run` and exits 2 otherwise, `chmodSync(opencode, 0o755)`, and set
  `PATH: \`${bin}:${process.env.PATH ?? ''}\``.
- `packages/agent-runtime/test/backend.test.mjs:19-23, 92-107` at `0f60cf9` — the same pattern, with
  the fake rewritten three times to model a present / absent / transport-failing model catalog.

**What actually happened under the noexec account at `0f60cf9`.** This host's `/tmp` is mounted
`noexec`; the verbatim `/proc/mounts` line is
`tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,relatime,inode64 0 0`. With `TMPDIR` unset, `tmpdir()` was
that `/tmp`, so the fake `opencode` could not be executed: `spawnSync` of the fixture script failed
`EACCES`, and libuv's `PATH` search then continued past the temp directory and found the *real*
`opencode` installed on this host's `PATH`. The assertions that expected the fixture's output
therefore saw the real backend's output instead. Reproduced directly: a `#!/bin/sh` script printing
`FAKE` in a `mkdtempSync(join(tmpdir(), ...))` directory fails to exec with `EACCES`, while the
identical script in a directory under `/workspace` execs and prints `FAKE`; and
`spawnSync('opencode', ['models'])` with that directory prepended to `PATH` returns the real model
catalog. Setting `TMPDIR` to an executable directory removed the `EACCES` and the fixture was used,
so all 7 tests passed — the fall-through to the real `opencode` on `PATH` was a genuine test defect
(the fixture silently did not fail closed when it could not exec), and it is recorded here rather
than fixed *at that commit*. It is fixed as of `e1de211`/`e2b4d96`; see above.

So: the earlier records were wrong about the mechanism, and this note remains the account of both
outcomes it superseded — for the noexec `/tmp` default and for a pinned executable `TMPDIR` —
though it is not the whole of repository verification, which is `verify-antonina.sh` (see above).
The tests are not "environmental" in the sense of needing a real binary — they need a *writable,
executable* temp directory, which this host does not provide under `/tmp`. That remains a host fact.
It is now handled inside the fixtures rather than by the caller having to remember `TMPDIR`, and the
residual caveat is stated next.

## The caveat the fix introduces: a checkout that is itself not exec-able

The guard's candidate list is exactly two entries —
`packages/agent-runtime/test/backend.test.mjs:63` and `packages/cli/test/agent.e2e.test.mjs:42,64`:
`[tmpdir(), <repo>/.antonina-test-tmp]`. There is **no** `ANTONINA_FIXTURE_ROOT` escape variable, and
there never has been: `git log --all -SANTONINA_FIXTURE_ROOT` is empty on this repository, and the
brief that described one was wrong about it. The only inputs are therefore `TMPDIR` (through
`os.tmpdir()`) and the filesystem the checkout itself lives on. On this head the second candidate
saves the day, because `/workspace` is btrfs and exec-able. A repository checked out on a `noexec`
mount has neither candidate, and the suites now fail *loudly and immediately* instead of quietly
using the host's real `opencode`.

Verified here, not assumed. Copying this checkout's `packages/` tree to `/tmp` (which is that same
`noexec` tmpfs) and running one file with `TMPDIR` unset:

```sh
mkdir -p /tmp/noexec-repo && cp -r packages /tmp/noexec-repo/
cd /tmp/noexec-repo && env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" \
  node --test packages/agent-runtime/test/backend.test.mjs
```

gives 11 tests, 7 pass, **4 fail**, and all four failures carry the same error, with
`error.code === 'ANTONINA_FIXTURE_NOEXEC'`:

```
Error: no exec-capable fixture directory for the fake opencode; tried: /tmp: EACCES; /tmp/noexec-repo/.antonina-test-tmp: EACCES
  code: 'ANTONINA_FIXTURE_NOEXEC'
```

The four names are `recognized OpenCode server failure becomes bounded structured diagnostics`,
`ordinary task failure is not misclassified and continuation stays explicit`,
`configured model catalog distinguishes absence from transport failure`, and `backend executable
resolves to an exact configured path, not a PATH lookup` — that is, every test in that file that
asks for a fixture. A developer on a `noexec` checkout sees those tests fail with an
`ANTONINA_FIXTURE_NOEXEC` error naming both candidate directories and the reason each was rejected,
not with the confusing "the real `opencode` answered" symptom the old account produced. The fix for
such a developer is to point `TMPDIR` at an exec-able directory (the first candidate) — or to
re-checkout on an exec-able filesystem; there is no third option in the current guard, and adding
one would be a change to the fixture front, not to this note. The same caveat applies to the cli
suite, which carries the same guard; it was not separately measured on a `noexec` checkout, and the
note does not claim a number for it.

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

## On the `packages/core` count of 125

Some coordination briefs and records state `packages/core` 125/125 (for example
`/workspace/antonina-coordination/2026-09-26-reconciliation.md` at several lines, and the
`issue-20-verify-baseline` prompts). This note has never recorded 125 — it recorded 114 at
`0f60cf9` — and **114 is re-measured on `e2b4d96`**: 114 tests, 114 pass, 0 fail, under *both*
`TMPDIR` accounts, in the runs quoted above. The 125 is a pre-existing baseline discrepancy in those
external records, not a count this note should adopt and not a discrepancy in the repository. The
only doc in this repository that states a `packages/core` count is this file. Those external records
are not owned by this front and are not edited here.
