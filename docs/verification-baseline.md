# Verification baseline

This note is the objective baseline that the scheduled-work completion predicate
("repository verification passes on the exact resulting head") refers to. Changing a count in
this note without a stated reason is a documentation bug, not a routine update.

All counts below were observed on **`d896ed8`** in the `issue-20-verify-baseline-3` worktree, with
`XDG_STATE_HOME` pointed at a fresh `mktemp -d` that was deleted afterwards, **under both `TMPDIR`
accounts**: a pinned executable `TMPDIR=/workspace/tmp-verify`, and `TMPDIR` unset (this host's
`noexec` `/tmp`). On this head both accounts are green and the counts agree; the two accounts are
still kept apart, because the mechanism that used to make them differ is new, and a later pass must
be able to tell "fixed" from "not reached". A *count* change is not in itself a failure — tests get
added and removed — but a *new failing test name* is, and so is a *known failing name that starts
passing*. Both directions are changes needing a stated reason, so that a later pass never has to
choose between "the note is stale" and "it was fixed".

**Which head this table is pinned to.** The tables below are measured on `d896ed8`, the release head
(`release/2026-09-26`). The commit that carries this note touches `docs/verification-baseline.md`
and nothing else, so the test surface is byte-identical on the commit that results from landing it,
and the counts here are the counts for that head too. The harness run on the *exact* resulting head
is reported in that commit's message and in
`/workspace/antonina-coordination/logs/verify-<sha>.log`, so it can be checked against this table
rather than taken on trust.

**Lineage, and why the numbers are what they are.** This note was first written against `0f60cf9`
by `9781ecc` and amended by `47784c4`. Both are **docs-only** commits — each touches
`docs/verification-baseline.md` and nothing else (`git show --stat 9781ecc 47784c4`) — so no
test-affecting commit is covered by them. The counts they recorded were 114 / 67 / 82 / 94.

Two test-affecting lineages have landed since, and **`d896ed8` is their union**:

| Head | core | agent-runtime | cli | web | what it adds |
| --- | --- | --- | --- | --- | --- |
| `0f60cf9` | 114 | 67 | 82 | 94 | the base both lineages branch from |
| `e2b4d96` | 114 | 71 | 85 | 94 | the fixture-path-guard front: `e1de211` + `e2b4d96` |
| `868b5ec` | — | — | — | — | the loader / authrecord front, merged into the release head as `c2cd88a` |
| **`d896ed8`** | **125** | **71** | **88** | **94** | the merge of the two: `d896ed8` = merge(`868b5ec`, `e2b4d96`) |

This is the point the `e2b4d96`-pinned draft of this note got wrong, and it is worth stating
precisely because the two lineages are both real measurements. `114 / 71 / 85 / 94` is what the
fixture front's own branch `e2b4d96` measures; `125 / 71 / 88 / 94` is what the merged release head
measures. Neither number is wrong. They are the counts of two different lineages, and this note is
pinned to the second. **The extra core and cli tests belong to the loader and authrecord fronts, not
to the fixture front**, and that attribution is arithmetic, not a story — the whole delta from
`e2b4d96` to `d896ed8` is four files
(`git diff --stat e2b4d96 d896ed8`: `packages/core/src/collection.ts`,
`packages/core/test/collection.test.mjs`, `packages/cli/src/collection.ts`,
`packages/cli/test/collection.test.mjs`, plus a new
`packages/cli/test/managed-roots-config.test.mjs`), and counting `^test(` in the test files at each
side accounts for the difference exactly:

- core: `packages/core/test/collection.test.mjs` 27 → 38, i.e. **+11**, and 114 + 11 = **125**.
- cli: `packages/cli/test/collection.test.mjs` 28 → 29 (**+1**) and
  `packages/cli/test/managed-roots-config.test.mjs` 7 → 9 (**+2**), i.e. **+3**, and 85 + 3 = **88**.
- agent-runtime is 71 on both sides, and web is 94 on both sides: neither lineage touches them.

So the "core is 125" figure that appears throughout the coordination records is **not** a
discrepancy in those records, and not a discrepancy in this note. It is the loader/authrecord
lineage's count, which the merged head adopts. A front that measured on `e2b4d96` and wrote 114 into
this table would have been wrong on arrival, not merely early.

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
unconditionally: `selectExecRoot` (`packages/agent-runtime/test/backend.test.mjs:63`,
`packages/cli/test/agent.e2e.test.mjs:64`, with that file's candidate list built by
`candidateParents()` at `:41-43`) *probes* candidate parents in order — first `os.tmpdir()`, then the
repo-local `<repo>/.antonina-test-tmp` — by writing a `#!/bin/sh` probe and exec'ing it, and takes
the first that actually execs. If none execs it throws `ANTONINA_FIXTURE_NOEXEC`
(`backend.test.mjs:87`, `agent.e2e.test.mjs:88`) rather than letting a bare `opencode` lookup fall
through to a real host backend. The probe result, not `TMPDIR`, decides. Pinning `TMPDIR` to a
directory on the executable `/workspace` btrfs mount still works and still uses that directory,
because it is first in the candidate list and it execs; leaving `TMPDIR` unset now also works,
because the second candidate is on the repo's own filesystem. Both are recorded below because "one
of them silently regressed" is still a question a later pass has to be able to answer.

Do not reorder the list: the four `tsc -p` steps also emit the `packages/*/dist` trees that the tests
import (`packages/cli/test/agent.e2e.test.mjs:17`, `packages/agent-runtime/test/backend.test.mjs:20`),
so they must precede the suites — deleting all three `dist` directories and running only the four
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

Command run (2026-09-26, this worktree; `web/node_modules` symlinked in from
`/workspace/antonina/web/node_modules` and not committed):

```sh
TMPDIR=/workspace/tmp-verify XDG_STATE_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-issue20-baseline3
```

Result: **exit 0**, final line `verify: ok`, in about 20 s.

| Command | Observed on `d896ed8` |
| --- | --- |
| `tsc -p packages/core/tsconfig.json` | exit 0, no diagnostics (`typecheck: ok`) |
| `tsc -p packages/agent-runtime/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.conformance.json` | exit 0, no diagnostics |
| `tsc -p packages/cli/tsconfig.json` | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 125 tests, 125 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 71 tests, 71 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 88 tests, 88 pass, 0 fail |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0, `built in 543ms` |
| the harness end to end | **exit 0**, `verify: ok` |

Under that setting there are **no** known failures. Every count here was measured on this head by the
run above; none is carried forward from the previous note, and none is carried over from `e2b4d96`.
For the per-row reasons that the counts differ from the `0f60cf9` table, see "Lineage" above: the
agent-runtime 67 → 71 and (on the fixture branch) cli 82 → 85 are test additions in the two fixture
files from `e1de211` and `e2b4d96`, and the further cli 85 → 88 and core 114 → 125 are the
loader/authrecord front's additions, accounted for file by file above.

The earlier green log `logs/verify-0f60cf9.log` (13:27 on 2026-09-26) was attributed to the pinned
`TMPDIR` by inference from the fact that `/tmp` is `noexec`. The attribution is not inferential, and
does not rest on reading an environment out of a log — the harness log does not record `TMPDIR` at
all. It rests on a pair of runs of the *same* harness on the *same* checkout, differing in exactly
one variable: the pinned run is green end to end, the unpinned run (table below) aborts at the
agent-runtime suite, and the set of tests failing in the unpinned run is precisely the set of tests
whose fake `opencode` is written under `tmpdir()`. A variable that is the only difference between a
run and its counterfactual, and whose mechanism is directly observable, is the cause. That
reasoning applied to `0f60cf9`; it no longer has anything to explain on `d896ed8`, because both
accounts are green.

## The other account: `TMPDIR` unset (this host's `noexec` `/tmp`)

```sh
env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-issue20-baseline3
```

Result: **exit 0**, final line `verify: ok`. Nothing aborted; the question of which step a non-zero
exit would have named does not arise on this head.

| Command | Observed on `d896ed8` |
| --- | --- |
| the four `tsc -p` steps | exit 0, no diagnostics (`typecheck: ok`) |
| `node --test packages/core/test/*.test.mjs` | 125 tests, 125 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 71 tests, 71 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 88 tests, 88 pass, 0 fail |
| `vitest run --root web` | 5 test files, 94 tests, 94 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0, `built in 549ms` |
| the harness end to end | **exit 0**, `verify: ok` — no step aborted |
| worktree afterwards | `git status --porcelain` empty; no `.antonina-test-tmp` left behind |

This table is the change of record, and it is **the claim this front exists to make**: the account
that was 7 failures is 0 failures. On `0f60cf9` the same unpinned account was agent-runtime 66/67 and
cli 76/82 with the harness exiting 1 at the agent-runtime suite; on `d896ed8` it is 71/71 and 88/88
with the harness exiting 0. Reason: `selectExecRoot` probes `os.tmpdir()`, gets `EACCES` on this
`noexec` tmpfs, and falls through to the repo-local `.antonina-test-tmp` on the executable
`/workspace` btrfs mount, which execs. The seven known failures recorded at `0f60cf9` are therefore
*known names that stopped failing*, recorded as a **fix, not a regression**, and kept below under
that heading per the symmetric rule at the top of this note — not deleted.

## Known names that stopped failing at `e1de211` / `e2b4d96`

At `0f60cf9`, under the unpinned noexec account, 7 tests failed: 1 in
`packages/agent-runtime/test/backend.test.mjs` and 6 in `packages/cli/test/agent.e2e.test.mjs`. All 7
pass on `d896ed8` under that same account, and the whole harness is green. The names are kept so a
later pass can recognise them.

**The line anchors below are re-derived against `d896ed8`**, not carried forward. The
`0f60cf9` anchors were `backend.test.mjs:92` and `agent.e2e.test.mjs:89 / :110 / :138 / :261 / :278
/ :386`; both files have since shifted, and the current line for each name is given. (A prior
draft of this refresh moved the `backend.test.mjs` anchor only as far as `:96`, which is also stale.)

| Test name | File | line at `0f60cf9` | **line at `d896ed8`** |
| --- | --- | --- | --- |
| `configured model catalog distinguishes absence from transport failure` | `packages/agent-runtime/test/backend.test.mjs` | `:92` | **`:162`** |
| `built CLI runs a fresh prompt then continues the discovered OpenCode session` | `packages/cli/test/agent.e2e.test.mjs` | `:89` | **`:237`** |
| `hard steer interrupts the running process group and drains redirect FIFO` | `packages/cli/test/agent.e2e.test.mjs` | `:110` | **`:261`** |
| `stale reserved work is recovered without overwriting the accepted prompt` | `packages/cli/test/agent.e2e.test.mjs` | `:138` | **`:294`** |
| `backend server failure is persisted and sanitized through status` | `packages/cli/test/agent.e2e.test.mjs` | `:261` | **`:419`** |
| `prompt recovers an existing OpenCode session when durable session id was lost` | `packages/cli/test/agent.e2e.test.mjs` | `:278` | **`:438`** |
| `attached prompt streams output and returns invocation status` | `packages/cli/test/agent.e2e.test.mjs` | `:386` | **`:548`** |

**Why they stopped failing.** Not because `TMPDIR` changed: the run above has it unset. The
fall-through defect was real and it was fixed. `e1de211` made the fixture choose an exec-able root by
probing, and made the *backend seam itself* refuse a value that could fall through —
`resolveOpencode` (`packages/agent-runtime/src/backend.ts:77-92`) now requires
`ANTONINA_OPENCODE_BIN` to be absolute, so `opencode`, `./bin/opencode` and any other relative value
throw at `:86-90` instead of being resolved against `PATH` or the cwd, and there is no bare-name
lookup left in the fixture path. `e2b4d96` closed three review Errors on that guard: the
absolute-path refusal above; `.antonina-test-tmp` added to `.gitignore`, with the root's cleanup
registered inside `selectExecRoot` at the moment the directory is created so it also covers the
no-exec throw path and a mid-suite abort; and the prune changed from
`rmSync(path, { recursive: false })` to `rmdirSync` — the former fails `EISDIR` on a directory on
Node 22+, so the previous bare `catch {}` was a silent no-op — with the `t.diagnostic` that now
reports a genuine leftover. The measured worktree-clean row above is the check that the last two of
those work.

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
- `packages/agent-runtime/test/backend.test.mjs:19-23, 92-107` at `0f60cf9` — the same pattern,
  with the fake rewritten three times to model a present / absent / transport-failing model catalog.

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
than fixed *at that commit*. It is fixed as of `e1de211` / `e2b4d96`; see above.

So: the earlier records were wrong about the mechanism, and this note remains the account of both
outcomes it superseded — for the noexec `/tmp` default and for a pinned executable `TMPDIR` —
though it is not the whole of repository verification, which is `verify-antonina.sh` (see above).
The tests are not "environmental" in the sense of needing a real binary — they need a *writable,
executable* temp directory, which this host does not provide under `/tmp`. That remains a host fact.
It is now handled inside the fixtures rather than by the caller having to remember `TMPDIR`, and the
residual caveat is stated next and measured.

## The caveat the fix introduces: a checkout that is itself not exec-able

The guard's candidate list is exactly two entries — `packages/agent-runtime/test/backend.test.mjs:63`
and `packages/cli/test/agent.e2e.test.mjs:41-43, 64`: `[tmpdir(), <repo>/.antonina-test-tmp]`. There
is **no** `ANTONINA_FIXTURE_ROOT` escape variable, and there never has been: no source or test file
in this repository contains the string, and the only commit in the repository whose diff contains it
is an unlanded docs-only refresh, which mentions it in order to deny it. The brief that described
such a variable was wrong about it. The only inputs are therefore `TMPDIR` (through `os.tmpdir()`)
and the filesystem the checkout itself lives on. On this head the second candidate saves the day,
because `/workspace` is btrfs and exec-able. **A repository checked out on a `noexec` mount has
neither candidate, and the suites now fail loudly and immediately** instead of quietly using the
host's real `opencode`.

Verified here, not assumed, and re-established on this head rather than copied. Copying this
checkout's `packages/` and `web/` trees to a directory under `/tmp` (which is that same `noexec`
tmpfs) and running the suites there with `TMPDIR` unset:

```sh
mkdir -p /tmp/noexec-repo && cp -r packages /tmp/noexec-repo/ && cp -r web /tmp/noexec-repo/
cd /tmp/noexec-repo && env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" \
  node --test packages/agent-runtime/test/backend.test.mjs
```

gives 11 tests, 7 pass, **4 fail**, exit 1, and all four failures carry the same error, with
`error.code === 'ANTONINA_FIXTURE_NOEXEC'`:

```
Error: no exec-capable fixture directory for the fake opencode; tried: /tmp: EACCES; /tmp/noexec-repo/.antonina-test-tmp: EACCES
  code: 'ANTONINA_FIXTURE_NOEXEC'
```

That reproduces exactly. The four names, with lines re-derived on `d896ed8`, are every test in that
file that asks for a fixture:

- `recognized OpenCode server failure becomes bounded structured diagnostics` (`:95`)
- `ordinary task failure is not misclassified and continuation stays explicit` (`:114`)
- `configured model catalog distinguishes absence from transport failure` (`:162`)
- `backend executable resolves to an exact configured path, not a PATH lookup` (`:225`)

The 7 that pass in that file are the ones that do not need a fixture, plus the guard's own case
(`fixture guard: a non-exec-able fixture location is a named failure, never a substitution`,
`:263`), which stubs the probe and therefore passes on any filesystem — that is the point of it.

**The same caveat measured across all four suites**, on the same noexec copy, `TMPDIR` unset. This
closes the gap the `e2b4d96`-pinned draft of this note left open (it measured only the one
agent-runtime file and declined to give a number for cli):

| Suite | On an exec-able checkout | On the `noexec` copy |
| --- | --- | --- |
| `node --test packages/core/test/*.test.mjs` | 125 / 125 / 0 | **125 / 125 / 0** — unaffected |
| `node --test packages/agent-runtime/test/*.test.mjs` | 71 / 71 / 0 | 71 / **67 / 4** — all 4 `ANTONINA_FIXTURE_NOEXEC` |
| `node --test packages/cli/test/*.test.mjs` | 88 / 88 / 0 | 88 / **68 / 20** — all 20 `ANTONINA_FIXTURE_NOEXEC` |
| `vitest run --root web` | 5 files, 94 / 94 | **5 files, 94 / 94** — unaffected |
| the harness end to end | exit 0, `verify: ok` | **exit 1**, `typecheck: ok`, core 125, then aborts at the agent-runtime suite (`set -e`) |

The 20 cli failures are all in `packages/cli/test/agent.e2e.test.mjs` (that file alone: 21 tests,
1 pass, 20 fail), and there were **no** failures of any other kind in the cli suite on the noexec
copy — every one of the 20 carried `ANTONINA_FIXTURE_NOEXEC` and nothing else. Note that the test
*totals* are conserved across the two filesystems (71 and 88 either way): a noexec checkout does not
lose tests, it makes the fixture-dependent ones fail with a named, diagnosable error.

What a developer on a `noexec` checkout sees is those tests fail with an
`ANTONINA_FIXTURE_NOEXEC` error naming both candidate directories and the reason each was rejected —
not the confusing "the real `opencode` answered" symptom the old account produced. The fix for such
a developer is to point `TMPDIR` at an exec-able directory (the first candidate) — or to re-checkout
on an exec-able filesystem; there is no third option in the current guard, and adding one would be a
change to the fixture front, not to this note.

## `npm test` is not repository verification

`npm test` (`package.json:16`) runs `test:core`, `test:runtime`, `test:cli` and `test:web`. It does
**not** run any typechecking. `packages/agent-runtime/tsconfig.conformance.json` — the project that
typechecks the conformance program holding the two `CandidatePathFacts` declarations together
(`packages/agent-runtime/conformance/candidate-path-facts.conformance.ts:23-24`, asserted
bidirectionally at `:33-40`) — is reachable only through the `typecheck` / `typecheck:conformance`
scripts (`package.json:10-11`). A green `npm test` is therefore not by itself repository
verification; the five `tsc` invocations above are part of the predicate, and so is the web
production build — the predicate is the whole of `verify-antonina.sh`, not the command list above,
which is a deliberately explicit subset of it. This is finding F10 of
`/workspace/antonina-coordination/issue-20-claims-audit.md` and is recorded here only, not fixed.
