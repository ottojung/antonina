# Verification baseline

This note is the objective baseline that the scheduled-work completion predicate
("repository verification passes on the exact resulting head") refers to. Changing a count in
this note without a stated reason is a documentation bug, not a routine update.

All counts below were observed on **`65caa73`** at `/workspace/antonina-repin5` (the worktree of
the `issue-20-repin5` branch), with `XDG_STATE_HOME` **and** `XDG_CONFIG_HOME` each pointed at a
fresh `mktemp -d` that was deleted afterwards — so no run can read or write the operator's
`trust.json` or `credential.json` — and **under both `TMPDIR` accounts**: a pinned executable
`TMPDIR=/workspace/tmp-verify`, and `TMPDIR` unset. Both accounts were re-run in full on `65caa73`;
neither is carried forward, and every number in the tables below is read out of one of those two
runs. What makes the second account worth running separately is not that it fails — it does not —
but that this host's `/tmp` is a `noexec` tmpfs, and the fixture guard's candidate list reaches
`os.tmpdir()` first. Whether the guard absorbs that or not is a per-run fact, so it is measured
rather than inferred; the two accounts are never collapsed into one.

**Three counts changed at this re-pin, and the web one changed the most.** `65caa73` measures
**128 / 78 / 104 / 105**. The head this note replaces (`f5fe5cc`) measured 128 / 73 / 98 / 94; the
two before that were 128 / 73 / 96 / 94 (`79b7880`) and 125 / 72 / 88 / 94 (`888001e`). The
`888001e → f5fe5cc` attribution was established by the two earlier re-pins and is carried forward
unchanged — the same arithmetic, recomputed from the trees at this head and reconciling exactly:

- **core 125 → 128** — `packages/core/test/collection.test.mjs` 38 → 40 (`ceab3bb`, the front
  merged as `fc08a7a`) and `packages/core/test/managed-roots.test.mjs` 16 → 17 (`f1ddb62`, merged
  as `de53b07`).
- **agent-runtime 72 → 73** — `packages/agent-runtime/test/store.test.mjs` 12 → 13 (`40b2e5f`,
  merged as `79b7880`; the stale-lock reclaim that re-verifies the exact dead owner).
- **cli 88 → 96** — `packages/cli/test/collection.test.mjs` 29 → 32 (`6a5cf55`) then 32 → 33
  (`ceab3bb`), plus a new file, `packages/cli/test/clean-ownership-guard.test.mjs`, at 4
  (`52c244f`, merged as `a3c8caf`).
- **web 94 → 94** — no file under `web/src` is touched anywhere in `888001e..f5fe5cc`
  (`git diff --stat 888001e f5fe5cc` names no `web` file), so the count is unchanged *because it
  was re-measured*, not because it was skipped.

**And one count changed in the segment before this one**, `79b7880 → f5fe5cc`, a single merge
(`f5fe5cc`, the `delete --force` runner-reaping front, `724de31`):

- **cli 96 → 98, and nothing else moves.** `git diff --stat 79b7880 f5fe5cc` prints exactly one
  file, `packages/cli/test/agent.e2e.test.mjs`, +123 lines and 0 deletions, and counting `^test(`
  in it gives 21 → 23, i.e. **+2**, and 96 + 2 = **98**. Those two cases are
  `delete --force reaps the live runner process before removing the agent` (`:410`) and
  `delete --force cancels an in-flight runner reservation and reports it` (`:468`).

**And three counts change in the segment this front adds**, `f5fe5cc → 65caa73`, which is 16
commits: the `40e5099` fixture-guard front, the `69d0e9b` lock-ownership front, the `5eaa48d`
release marker, and the `65caa73` board/board-config and web UX work. The attribution is
established here, not carried, and it reconciles file by file with nothing left over.
`git diff --numstat f5fe5cc 65caa73 -- 'packages/*/test/*' web/src` names **seven** test files
changed and **one** added, and no core test file at all:

- **core 128 → 128, and no core test file is touched in the delta.** `git diff --numstat f5fe5cc
  65caa73 -- packages/core/test` prints nothing. The `^test(` census over the seven core files is
  24/6/40/17/6/14/21 = **128** on both sides.
- **agent-runtime 73 → 78, i.e. +5, in two files.** `packages/agent-runtime/test/store.test.mjs`
  13 → 17 (**+4**) and `packages/agent-runtime/test/backend.test.mjs` 11 → 12 (**+1**). The census
  is 11/8/8/17/7/9/13 = 73 → 12/8/8/17/7/9/17 = **78**. The four `store` cases are
  `releasing a lock never deletes a lock another owner installed at the same path`,
  `releasing a lock never deletes a replacement lock held by the same process`,
  `reclaiming a stale lock never unlinks a different tokenless record sharing pid and start ticks`
  and `lock initialization failure never unlinks another owner's create-before-write window`
  (verified additions), one from `0bf1736` (33 added lines), one from `cf1719e` (41 added lines)
  and two from `b16c8a1` (68 added lines), all merged as
  `69d0e9b`. The one `backend` case is
  `fixture guard: an uncreatable fixture parent is a named failure, never a substitution`
  (`:293`), from `49144e0` in `40e5099`.
- **cli 98 → 104, i.e. +6, in two files.** `packages/cli/test/board.test.mjs` 26 → 31 (**+5**) and
  `packages/cli/test/agent.e2e.test.mjs` 23 → 24 (**+1**). The census is
  26/4/33/3/9/23 = 98 → 31/4/33/3/9/24 = **104**. The `agent.e2e` case is the same
  `uncreatable fixture parent` guard case as in `backend.test.mjs`, at `:762`, from `49144e0`. The
  five `board` cases are `a board command takes its trust anchor and credential from the config
  files`, `the config directory follows XDG_CONFIG_HOME and the home fallback`,
  `a board command refuses a config file it cannot parse and names its path`,
  `a board command has no identity when the config files are absent` and
  `a trust anchor and credential from different boards are still refused` (+5, from `9299298`, the
  front that reads trust and credential from the config directory rather than the environment) and
  `the injected home resolves the config directory when XDG_CONFIG_HOME is unset` (+1, from
  `3dc3735`). **One name was also removed, and that is stated rather than absorbed into the
  count:** `9299298` deletes `board CLI refuses environment credentials it cannot parse or
  reconcile` and adds five cases in its place, so the net is +4 from that
  commit. `packages/cli/test/collection.test.mjs` is also touched by the delta (8 insertions, 2
  deletions, all of it the `TEST_HOME` injection and the reworded trust-anchor error) but its
  `^test(` count is **33 on both sides** — that commit changed how those 33 tests find their
  configuration, not how many there are.
- **web 94 → 105, i.e. +11, in two changed files and one new file.** `web/src/comment-composer.test.tsx`
  is **new** at **8**; `web/src/create-issue-form.test.tsx` 6 → 8 (**+2**); `web/src/ui-state.test.ts`
  37 → 38 (**+1**). The census is 22/6/25/4/37 = 94 → 22/8/25/4/38 = **105** across 5 files →
  **6 files**. The two `create-issue-form` cases are
  `treats Ctrl+Meta+Enter as one gesture rather than two, so it cannot submit twice` and
  `claims Meta+Enter as the same shortcut, so a Mac keyboard is not a second-class input`; the
  `ui-state` case is
  `advertises the composer shortcut next to the button it stands in for`. All eleven come from
  `1fe2da5` ("Post a comment with Ctrl+Enter or Cmd+Enter").

**This documentation commit adds no test**, so every unit of that movement is attributed to the
commits above and to nothing here; a count delta is never credited to the commit that only re-pins
the note. Nothing outside `docs/verification-baseline.md` changes in it.

No failing name and no known-passing name moved. Every one of the 22 new names above is a new
*name*, and all of them pass on this head under both `TMPDIR` accounts; none is a new failing name,
and no name that passed at `f5fe5cc` fails at `65caa73`. One name *disappeared*
(`board CLI refuses environment credentials it cannot parse or reconcile`, retired by `9299298`
along with the environment-credential path it tested); a removed name is not a failure in either
direction, but it is recorded here so that a later pass comparing name sets does not read it as a
silent edit. On this head both accounts are green and the counts agree; the two accounts are still
kept apart, because the mechanism that used to make them differ is not new, and a later pass must
be able to tell "fixed" from "not reached". A *count* change is not in itself a failure — tests get
added and removed — but a *new failing test name* is, and so is a *known failing name that starts
passing*. Both directions are changes needing a stated reason, so that a later pass never has to
choose between "the note is stale" and "it was fixed".

**Which head this table is pinned to.** The tables below are measured on `65caa73`, which **is** the
release head: `git rev-parse release/2026-09-26-2` = `65caa735bbf00fab3acf092784d93e86fcc45280`
= `git rev-parse main` = `65caa73`, which is the head this note was measured on and the parent of
this documentation-only commit. This is the **fourth** re-pin of
this note: it was first pinned to a *front branch* head (`888001e`, on
`issue-20-per-entry-coverage`, not a release head; that front was voided and its numbers are not
carried forward), then re-pinned to `79b7880`, then to `f5fe5cc`, and is now re-pinned again to
`65caa73`. The `79b7880` pin exists only on an unlanded front branch (`a0710e8`, on
`issue-20-repin2`) and the `f5fe5cc` pin only on another (`3e9c418`, on `issue-20-repin3`); neither
is merged, and nothing from either is inherited except arithmetic, which is re-derived from the
trees here. `a0710e8` is **not** merged and pins the wrong head, so none of its numbers are carried;
its *noexec* figures (`69+4=73`, `76+20=96`) describe `79b7880`, not this head, and the same-head
figures at `65caa73` are in the table near the end of this note, where they are larger.

**The release branch moved under the previous pin, and the lineage is continuous anyway.**
`git rev-parse release/2026-09-26` is now `69d0e9b`, not `f5fe5cc`; `69d0e9b` ("Merge issue 20 lock
ownership hardening") landed *after* `3e9c418` wrote that the branch equalled `f5fe5cc`. The retired
`release/2026-09-26` was promoted into `main` by a human and is no longer the active release line;
`release/2026-09-26-2` was cut from `main` and is active at `65caa73`. `f5fe5cc` is an ancestor of
`69d0e9b` and `69d0e9b` is an ancestor of `65caa73`, so the `^test(` arithmetic above accounts for
every test in `888001e..65caa73` continuously and leaves nothing unexplained. `888001e`, `79b7880`
and `f5fe5cc` are all ancestors of `65caa73` (`git merge-base --is-ancestor` succeeds for each). The
commit that carries this note touches `docs/verification-baseline.md` and nothing else, so the test
surface is byte-identical on the commit that results from landing it, and the counts here are the
counts for that head too. The harness run on the *exact* resulting head is reported in that
commit's message and in `/workspace/antonina-coordination/logs/verify-<sha>.log`, so it can be
checked against this table rather than taken on trust. That log is written by the coordinator, not
by the harness and not by the checkout: its absence for a given sha is not a missing measurement
and must not be read as one. The convention is real — `verify-538e009.log` exists for an earlier
pin — but it is coordinator-owned, so a later pass that finds no log for its head should re-run the
harness rather than treat the gap as a discrepancy.

**Lineage, and why the numbers are what they are.** This note was first written against `0f60cf9`
by `9781ecc` and amended by `47784c4`. Both are **docs-only** commits — each touches
`docs/verification-baseline.md` and nothing else (`git show --stat 9781ecc 47784c4`) — so no
test-affecting commit is covered by them. The counts they recorded were 114 / 67 / 82 / 94.

Two test-affecting lineages have landed since `0f60cf9`, and **`d896ed8` is their union**; the head
this note is pinned to is that union plus the fronts listed below. Every `^test(` total in the
table is one this note recomputed from the tree at that commit:

| Head | core | agent-runtime | cli | web | what it adds |
| --- | --- | --- | --- | --- | --- |
| `0f60cf9` | 114 | 67 | 82 | 94 | the base both lineages branch from |
| `e2b4d96` | 114 | 71 | 85 | 94 | the fixture-path-guard front: `e1de211` + `e2b4d96` |
| `868b5ec` | — | — | — | — | the loader / authrecord front, merged into the release head as `c2cd88a` |
| `d896ed8` | 125 | 71 | 88 | 94 | the merge of the two: `d896ed8` = merge(`868b5ec`, `e2b4d96`) |
| `45f2236` | 125 | 71 | 88 | 94 | `d896ed8` plus documentation and comments only |
| `888001e` | 125 | 72 | 88 | 94 | the branch head the second front pinned to: `45f2236` plus `cfce42a`'s comment-only front and the added per-entry ordering test |
| `79b7880` | 128 | 73 | 96 | 94 | the head the third front pinned to: `888001e` plus the F1/F3/F6 collect fronts and the clean-guard and stale-lock test fronts |
| `f5fe5cc` | 128 | 73 | 98 | 94 | the head the fourth front pinned to: `79b7880` plus the `delete --force` runner-reaping front (`724de31`), which adds 2 cli tests and touches no other suite |
| **`65caa73`** | **128** | **78** | **104** | **105** | **the head this note is pinned to, and the active release head**: `f5fe5cc` plus the host-independent fixture guards (`40e5099`, +2), the lock-ownership hardening (`69d0e9b`, +4 agent-runtime), the board config-directory front and web UX work (`65caa73`, +5 cli, +11 web) |

This is the point the `e2b4d96`-pinned draft of this note got wrong, and it is worth stating
precisely because the two lineages are both real measurements. `114 / 71 / 85 / 94` is what the
fixture front's own branch `e2b4d96` measures; `125 / 71 / 88 / 94` is what `d896ed8` measures.
Neither number is wrong. They are the counts of two different lineages, and this note is
pinned to a descendant of the second. **The extra core and cli tests belong to
the loader and authrecord fronts, not to the fixture front**, and that attribution is arithmetic,
not a story — the **code-and-test portion** of the delta from `e2b4d96` to `d896ed8` is five files.
`git diff --stat e2b4d96 d896ed8` prints **eight**: those five
(`packages/core/src/collection.ts`, `packages/core/test/collection.test.mjs`,
`packages/cli/src/collection.ts`, `packages/cli/test/collection.test.mjs`, and
`packages/cli/test/managed-roots-config.test.mjs`) plus three documentation files
(`docs/intent-records/hosts.md`, `docs/skills/resources.md`, and this note), none of which carries
a test. `managed-roots-config.test.mjs` is not new in this delta — it already exists at `e2b4d96`
(`git log e2b4d96 -1 -- packages/cli/test/managed-roots-config.test.mjs` = `0f60cf9`) — it grows
from 7 tests to 9. Counting `^test(` in the test files at each
side accounts for the difference exactly:

- core: `packages/core/test/collection.test.mjs` 27 → 38, i.e. **+11**, and 114 + 11 = **125**.
- cli: `packages/cli/test/collection.test.mjs` 28 → 29 (**+1**) and
  `packages/cli/test/managed-roots-config.test.mjs` 7 → 9 (**+2**), i.e. **+3**, and 85 + 3 = **88**.
- agent-runtime is 71 on both sides, and web is 94 on both sides: neither lineage touches them.

So the "core is 125" figure that appears throughout the coordination records is **not** a
discrepancy in those records, and not a discrepancy in this note. It is the loader/authrecord
lineage's count, which the merged head adopts. A front that measured on `e2b4d96` and wrote 114 into
this table would have been wrong on arrival, not merely early.

The same arithmetic, run again for the delta this re-pin introduces, is the per-file list at the
top of this note. All of it is recomputed from the trees, so a reader can re-derive it with
`git show <commit>:<file> | grep -c '^test('`.

## The commands

Every tool is invoked as `node <path-to-tool>`, never as `npm run <script>`. That is a property of
this host, not of the repository: this host has no `/usr/bin/env`, so every `npm` script shim and
the `npm` binary itself (whose shebang is `#!/usr/bin/env node`) cannot exec here. `npm ci` can be
run on this host only as `node "$(dirname "$(command -v npm)")/../lib/node_modules/npm/bin/npm-cli.js" ci --prefix web`.
The repository scripts are correct for a normal host; the direct `node` form below is the
equivalent that actually executes here.

```sh
export XDG_STATE_HOME="$(mktemp -d)"   # tests must never touch ambient ~/.local/state/antonina
export XDG_CONFIG_HOME="$(mktemp -d)"  # nor the operator's trust.json / credential.json
export TMPDIR=/workspace/tmp-verify    # one of the two accounts; the other leaves TMPDIR unset

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

`XDG_CONFIG_HOME` is exported alongside `XDG_STATE_HOME` because `9299298` moved the board's trust
anchor and credential from the environment into `$XDG_CONFIG_HOME/antonina/{trust,credential}.json`.
A test run that leaves it unset reads the operator's real files, which is exactly the ambient-state
hazard `XDG_STATE_HOME` already guarded against; on this head it is guarded too.

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

**The guard's own bytes DID change in the delta this front adds, so the reading of the mechanism is
re-derived here rather than carried.** The previous pin argued that the guard was byte-identical
across its range and therefore needed no re-reading. That argument is no longer available:
`git diff --numstat f5fe5cc 65caa73` reports 48 insertions / 4 deletions in
`packages/agent-runtime/test/backend.test.mjs` and 43 / 4 in `packages/cli/test/agent.e2e.test.mjs`,
because `49144e0` ("Pin the fixture guard to suite-owned parents instead of host paths", merged as
`40e5099`) rewrote both guards. Every anchor in the paragraph above was therefore re-read on
`65caa73`, and the reading survives the rewrite rather than being inherited: `selectExecRoot` is at
`backend.test.mjs:63` and `agent.e2e.test.mjs:64`, its `error.code = 'ANTONINA_FIXTURE_NOEXEC'` at
`backend.test.mjs:87` and `agent.e2e.test.mjs:88`, the candidate list is the literal
`[tmpdir(), REPO_FIXTURE_PARENT]` at `backend.test.mjs:63` built by `candidateParents()` at
`agent.e2e.test.mjs:41-43`, and `REPO_FIXTURE_PARENT` is `resolve('.antonina-test-tmp')` at
`backend.test.mjs:23` and `agent.e2e.test.mjs:19`. What `40e5099` added on top of the `e1de211`
shape is a third failure mode inside the same loop: a parent that cannot be *created* at all is now
recorded as `${parent}: cannot create fixture parent (${error.message})` and skipped, rather than
aborting the loop, and the new `uncreatable fixture parent` cases at `backend.test.mjs:293` and
`agent.e2e.test.mjs:762` pin that. The observable consequences for the tables in this note are
unmoved — still two candidates, still `EACCES` on a `noexec` mount, still a named failure rather
than a substitution — which is why the *numbers* could be carried forward in shape while the
*text* could not.

Do not reorder the list: the four `tsc -p` steps also emit the `packages/*/dist` trees that the tests
import (`packages/cli/test/agent.e2e.test.mjs:17`, `packages/agent-runtime/test/backend.test.mjs:20`),
so they must precede the suites — deleting all three `dist` directories and running only the four
`tsc -p` steps regenerates them.

`web/node_modules` must exist first (`npm ci --prefix web`); the toolchain is the repository's
locked one, installed from `web/package-lock.json`. For this re-pin it was materialised as a real
hardlinked copy (`cp -al`) of `/workspace/antonina/web/node_modules`, not a symlink, and is not
committed. Observed tool versions on this host:
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
or `XDG_CONFIG_HOME` itself, so the caller must set both. **Both tables below were produced by
running this harness, not by running the list above**, so the harness is not merely described here
— it is the instrument the numbers came from.

## Expected results, for `TMPDIR=/workspace/tmp-verify`

Commands run (2026-09-26, `/workspace/antonina-repin5`, the worktree this note is
pinned from; `web/node_modules` is a real hardlinked copy of
`/workspace/antonina/web/node_modules`, not a symlink, and is not committed):

```sh
TMPDIR=/workspace/tmp-verify XDG_STATE_HOME="$(mktemp -d)" XDG_CONFIG_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-repin5
```

Result: **exit 0**, final line `verify: ok`. No wall-clock figure is carried here, for the same
reason the `vite build` row carries none: the claim this section makes is that the run reproduces,
not how long it took.

| Command | Observed on `65caa73` |
| --- | --- |
| `tsc -p packages/core/tsconfig.json` | exit 0, no diagnostics (`typecheck: ok`) |
| `tsc -p packages/agent-runtime/tsconfig.json` | exit 0, no diagnostics |
| `tsc -p packages/agent-runtime/tsconfig.conformance.json` | exit 0, no diagnostics |
| `tsc -p packages/cli/tsconfig.json` | exit 0, no diagnostics |
| `node --test packages/core/test/*.test.mjs` | 128 tests, 128 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 78 tests, 78 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 104 tests, 104 pass, 0 fail |
| `vitest run --root web` | **6** test files, 105 tests, 105 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0 (the reported `built in …ms` is a single-run wall clock, not a reproducible measurement, and is deliberately not carried) |
| the harness end to end | **exit 0**, `verify: ok` |
| worktree afterwards | `git status --porcelain` empty; no `.antonina-test-tmp` left behind |
| processes afterwards | none left; every process the suites spawned converged or was reaped before the run ended |

Under that setting there are **no** known failures. Every count here was measured on this head by the
run above; none is carried forward from the previous note — including the ones that are unchanged
since `d896ed8`, which are unchanged because the run above re-measured them, not because it skipped
them — and none is carried over from `e2b4d96`.
For the per-row reasons that the counts differ from the `0f60cf9` table, see "Lineage" above: the
agent-runtime 67 → 71 and (on the fixture branch) cli 82 → 85 are test additions in the two fixture
files from `e1de211` and `e2b4d96`, and the further cli 85 → 88 and core 114 → 125 are the
loader/authrecord front's additions, accounted for file by file above. The movement *this* re-pin
introduces is agent-runtime 73 → 78, cli 98 → 104 and web 94 → 105, from the per-file list at the top
of this note; core 128 → 128 is unchanged because **no core test file is touched in
`f5fe5cc..65caa73`**, and it was re-measured rather than assumed either way. The web row is
**6** files rather than 5 because `1fe2da5` added `web/src/comment-composer.test.tsx`.

The earlier green log `logs/verify-0f60cf9.log` (13:27 on 2026-09-26) was attributed to the pinned
`TMPDIR` by inference from the fact that `/tmp` is `noexec`. The attribution is not inferential, and
does not rest on reading an environment out of a log — the harness log does not record `TMPDIR` at
all. It rests on a pair of runs of the *same* harness on the *same* checkout, differing in exactly
one variable: the pinned run is green end to end, the unpinned run (table below) aborts at the
agent-runtime suite, and the set of tests failing in the unpinned run is precisely the set of tests
whose fake `opencode` is written under `tmpdir()`. A variable that is the only difference between a
run and its counterfactual, and whose mechanism is directly observable, is the cause. That
reasoning applied to `0f60cf9`; it no longer has anything to explain on `65caa73`, because both
accounts are green — and the *copy-out* measurement further below is the one place where the
mechanism is still exercised, on purpose.

## The other account: `TMPDIR` unset (this host's `noexec` `/tmp`)

```sh
env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" XDG_CONFIG_HOME="$(mktemp -d)" \
  sh /workspace/antonina-coordination/verify-antonina.sh /workspace/antonina-repin5
```

Result: **exit 0**, final line `verify: ok`. Nothing aborted; the question of which step a non-zero
exit would have named does not arise on this head.

| Command | Observed on `65caa73` |
| --- | --- |
| the four `tsc -p` steps | exit 0, no diagnostics (`typecheck: ok`) |
| `node --test packages/core/test/*.test.mjs` | 128 tests, 128 pass, 0 fail |
| `node --test packages/agent-runtime/test/*.test.mjs` | 78 tests, 78 pass, 0 fail |
| `node --test packages/cli/test/*.test.mjs` | 104 tests, 104 pass, 0 fail |
| `vitest run --root web` | **6** test files, 105 tests, 105 pass |
| `tsc -b web` | exit 0, no diagnostics |
| `vite build web --config web/vite.config.ts` | exit 0 (as above: no millisecond figure is carried) |
| the harness end to end | **exit 0**, `verify: ok` — no step aborted |
| worktree afterwards | `git status --porcelain` empty; no `.antonina-test-tmp` left behind |

This account is 0 failures, and it was measured separately rather than inferred from the pinned
table: it is a second, independent run of the whole harness on the same checkout, and it agrees
row for row, suite for suite and count for count. On `0f60cf9` the same unpinned account was
agent-runtime 66/67 and cli 76/82 with the harness exiting 1 at the agent-runtime suite; on `65caa73`
it is 78/78 and 104/104 with the harness exiting 0. Reason: `selectExecRoot` probes
`os.tmpdir()`, gets `EACCES` on this `noexec` tmpfs, and falls through to the repo-local
`.antonina-test-tmp` on the executable `/workspace` btrfs mount, which execs. The seven known
failures recorded at `0f60cf9` are therefore *known names that stopped failing*, recorded as a
**fix, not a regression**, and kept below under that heading per the symmetric rule at the top of
this note — not deleted.

## Known names that stopped failing at `e1de211` / `e2b4d96`

At `0f60cf9`, under the unpinned noexec account, 7 tests failed: 1 in
`packages/agent-runtime/test/backend.test.mjs` and 6 in `packages/cli/test/agent.e2e.test.mjs`. All 7
pass on `65caa73` under that same account, and the whole harness is green. The names are kept so a
later pass can recognise them.

**The line anchors below are re-derived against `65caa73`, not carried forward.** Both fixture files
are touched by the `f5fe5cc → 65caa73` delta — `49144e0` added the `uncreatable fixture parent`
cases to each — so neither file's anchors can be carried. They happen to land at the same line
numbers as at `f5fe5cc`, and that is a result rather than a coincidence: the new cases sit at
`backend.test.mjs:293` and `agent.e2e.test.mjs:762`, i.e. **below every anchor in the table**, so
nothing above them shifted. Every anchor was nonetheless re-read on `65caa73` rather than inferred
from the position of the insertion. The `0f60cf9` anchors were `backend.test.mjs:92` and
`agent.e2e.test.mjs:89 / :110 / :138 / :261 / :278 / :386`; every anchor in the table was re-read
on `65caa73`.

| Test name | File | line at `0f60cf9` | line at `79b7880` | line at `f5fe5cc` | **line at `65caa73`** |
| --- | --- | --- | --- | --- | --- |
| `configured model catalog distinguishes absence from transport failure` | `packages/agent-runtime/test/backend.test.mjs` | `:92` | `:162` | `:162` | **`:162`** |
| `built CLI runs a fresh prompt then continues the discovered OpenCode session` | `packages/cli/test/agent.e2e.test.mjs` | `:89` | `:237` | `:237` | **`:237`** |
| `hard steer interrupts the running process group and drains redirect FIFO` | `packages/cli/test/agent.e2e.test.mjs` | `:110` | `:261` | `:261` | **`:261`** |
| `stale reserved work is recovered without overwriting the accepted prompt` | `packages/cli/test/agent.e2e.test.mjs` | `:138` | `:294` | `:294` | **`:294`** |
| `backend server failure is persisted and sanitized through status` | `packages/cli/test/agent.e2e.test.mjs` | `:261` | `:419` | `:542` | **`:542`** |
| `prompt recovers an existing OpenCode session when durable session id was lost` | `packages/cli/test/agent.e2e.test.mjs` | `:278` | `:438` | `:561` | **`:561`** |
| `attached prompt streams output and returns invocation status` | `packages/cli/test/agent.e2e.test.mjs` | `:386` | `:548` | `:671` | **`:671`** |

The three `f5fe5cc` anchors below `:294` were the ones that shifted by +123 across
`79b7880 → f5fe5cc`, because the two `delete --force` cases sit at `:410` and `:468`. The
`f5fe5cc → 65caa73` delta added nothing above `:671` in that file, so those three are unchanged —
which is exactly the kind of claim a later pass must be able to tell apart from a carried number,
so the coincidence is stated here rather than left implicit.

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
those work. `49144e0` (`40e5099`) then made the guard's parents *suite-owned* rather than derived
from host paths, which is the change that made the two new `uncreatable fixture parent` cases
writable at all.

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
in this repository contains the string (`git grep -l ANTONINA_FIXTURE_ROOT` names this note and
nothing else), and `git log --all -SANTONINA_FIXTURE_ROOT` returns **four** commits, not one and not
the three the previous pin recorded: `538e009` ("docs: re-pin the verification baseline to the
merged release head d896ed8"), `40015d8` ("docs: refresh the verification baseline for the
fixture-front head e2b4d96"), `a0710e8` (the unlanded `79b7880` re-pin front on `issue-20-repin2`),
and `3e9c418` (the unlanded `f5fe5cc` re-pin front on `issue-20-repin3`), and this commit, which
is the fifth. **All four are
documentation-only refreshes of this note that mention the string in order to deny it**, and the
count went from three to four only because a fourth re-pin front was cut. Their landing status
differs and is stated per commit rather than flattened: `538e009` has landed (it is an ancestor of
the pinned head), and `40015d8`, `a0710e8` and `3e9c418` have not. The distinction does not
matter to the argument, which is only that no *executable* file ever contained the variable — a
mention in four separate documentation commits, in four different states of landing, is still zero
executable mentions. The brief that described such a variable was wrong about it. The only inputs
are therefore `TMPDIR`
(through `os.tmpdir()`) and the filesystem the checkout itself lives on. On this head the second
candidate saves the day, because `/workspace` is btrfs and exec-able. **A repository checked out on
a `noexec` mount has neither candidate, and the suites now fail loudly and immediately** instead of
quietly using the host's real `opencode`.

**This copy-out was re-measured on `65caa73`, not carried forward.** An earlier revision of this
note measured the `noexec` columns at `d896ed8` and declined to re-run them at the re-pins that
followed, on the argument that the guard's bytes had not changed. That argument was sound for the
guard but it left the table's right-hand column describing a different head than the rest of the note,
and the previous front's attempt to re-pin it got the arithmetic wrong. This is the **fourth**
re-run of this copy-out (`d896ed8`, then `79b7880`, then `f5fe5cc`, now `65caa73`; the `888001e` pin
declined to re-run it, which is the gap being complained of), and the numbers below are all
from one copy-out of **this** worktree's `packages/` and `web/` trees to a directory under `/tmp`
(which is that same `noexec` tmpfs), with `TMPDIR` unset:

```sh
mkdir -p /tmp/noexec-65caa73 && cp -r packages /tmp/noexec-65caa73/ && cp -r web /tmp/noexec-65caa73/
cd /tmp/noexec-65caa73 && env -u TMPDIR XDG_STATE_HOME="$(mktemp -d)" XDG_CONFIG_HOME="$(mktemp -d)" \
  node --test packages/agent-runtime/test/*.test.mjs
```

`packages/agent-runtime/test/backend.test.mjs` alone gives 12 tests, 8 pass, **4 fail**, exit 1, and
all four failures carry the same error, with
`error.code === 'ANTONINA_FIXTURE_NOEXEC'`:

```
Error: no exec-capable fixture directory for the fake opencode; tried: /tmp: EACCES; /tmp/noexec-65caa73/.antonina-test-tmp: EACCES
  code: 'ANTONINA_FIXTURE_NOEXEC'
```

The four names, with lines re-read on `65caa73`, are every
test in that file that asks for a fixture:

- `recognized OpenCode server failure becomes bounded structured diagnostics` (`:95`)
- `ordinary task failure is not misclassified and continuation stays explicit` (`:114`)
- `configured model catalog distinguishes absence from transport failure` (`:162`)
- `backend executable resolves to an exact configured path, not a PATH lookup` (`:225`)

The 8 that pass in that file are the ones that do not need a fixture, plus the guard's own two
cases — `fixture guard: a non-exec-able fixture location is a named failure, never a substitution`
(`:263`), which stubs the probe and therefore passes on any filesystem, and `fixture guard: an
uncreatable fixture parent is a named failure, never a substitution` (`:293`), which stubs the
`mkdir` — that is the point of both. The second is new in this delta; the fixture-dependent set did
not grow, which is why this cell is unchanged at **4** from the previous pin even though the file
grew from 11 to 12 tests.

**The same caveat measured across all four suites**, on the same noexec copy, `TMPDIR` unset, from
the runs above. Every figure in the right-hand column was produced by those runs; none is
projected, and none is inferred from a different head.

| Suite | On an exec-able checkout (`65caa73`) | On the `noexec` copy (also `65caa73`) |
| --- | --- | --- |
| `node --test packages/core/test/*.test.mjs` | 128 / 128 / 0 | **128 / 128 / 0** — unaffected |
| `node --test packages/agent-runtime/test/*.test.mjs` | 78 / 78 / 0 | 78 / **74 / 4** — all 4 `ANTONINA_FIXTURE_NOEXEC` |
| `node --test packages/cli/test/*.test.mjs` | 104 / 104 / 0 | 104 / **82 / 22** — all 22 `ANTONINA_FIXTURE_NOEXEC` |
| `vitest run --root web` | **6** files, 105 / 105 | **6** files, 105 / 105 — unaffected, but see the caveat below |
| the harness end to end | exit 0, `verify: ok` | **exit 1**, `typecheck: ok`, core 128/128/0, agent-runtime 78 with 4 failing, then aborts at the agent-runtime suite (`set -e`) |

The columns are the same head on both sides, so every cell is a measurement rather than a
projection; the two columns differ only in the filesystem the checkout lives on. The counts are
internally consistent in the way a reader should require: 74 + 4 = 78 and 82 + 22 = 104, so the
fixture-dependent tests *failed* rather than being dropped, and the totals are conserved across the
two filesystems.

**The `noexec` failure count did not move, and that is the same arithmetic seen from the other
column.** At `f5fe5cc` the figures were agent-runtime 69 + 4 = 73 and cli 76 + 22 = 98; at `65caa73`
they are 74 + 4 = 78 and 82 + 22 = 104. Both *numerators* moved and neither *denominator of failures*
did, and for one reason in each suite: the four lock-ownership cases in
`packages/agent-runtime/test/store.test.mjs` and the five board-config cases in
`packages/cli/test/board.test.mjs` need no exec-able fixture directory, so they join the passing
column on both filesystems. The two new `uncreatable fixture parent` guard cases are the cases that
could have moved the failure count and deliberately do not: they stub `mkdirSync` and the probe
respectively, so they pass on a `noexec` mount by construction. This is also why the previous pin's
`76 + 20 = 96` (at `79b7880`) is not this column — that was a different head with two fewer cli
tests, and the two that `724de31` added at `f5fe5cc` both need a real fixture, taking the cli
failures from 20 to 22 then and now.

Per-file on the noexec copy, so the four and the twenty-two are attributable:

| File | tests / pass / fail on the noexec copy |
| --- | --- |
| `packages/agent-runtime/test/backend.test.mjs` | 12 / 8 / **4** |
| `packages/agent-runtime/test/{candidate-facts,lifecycle,managed-roots-config,metadata,process,store}.test.mjs` | 8/8/0, 8/8/0, 17/17/0, 7/7/0, 9/9/0, 17/17/0 |
| `packages/cli/test/agent.e2e.test.mjs` | 24 / 2 / **22** |
| `packages/cli/test/{board,collection,fail-closed,managed-roots-config,clean-ownership-guard}.test.mjs` | 31/31/0, 33/33/0, 3/3/0, 9/9/0, 4/4/0 |

So the 22 cli failures are all in `packages/cli/test/agent.e2e.test.mjs`, and there were **no**
failures of any other kind in the cli suite on the noexec copy — a count of `ANTONINA_FIXTURE_NOEXEC`
occurrences in that suite's output is exactly 22, and in the agent-runtime suite's exactly 4. The
two cases in that file that pass are the guard's own cases that stub the filesystem —
`fixture guard: a non-exec-able fixture location is a named failure, never a substitution` (`:735`)
and `fixture guard: an uncreatable fixture parent is a named failure, never a substitution` (`:762`,
new in this delta); the other two guard cases
(`:726`, `:787`) do reach the filesystem and so fail here, as they did at the previous pins.

**One caveat about the web cell, stated rather than smoothed over.** The web suite does not use the
fixture guard at all, and it does measure 105 / 105 on the noexec copy — but **not by the copy-out
command as written**, and this is a **host artefact rather than a same-method measurement**; a later
pass should not read the web cell as "the copy-out proves the web suite is unaffected" without
repeating the adjustment. Run verbatim out of a noexec copy, `vitest` cannot even start: rollup ships a
native addon and `dlopen` of it from a `noexec` mount fails with
`ERR_DLOPEN_FAILED: … rollup.linux-x64-gnu.node: failed to map segment from shared object`. That
failure was **re-reproduced at this head** rather than carried: copying
`rollup.linux-x64-gnu.node` alone into the noexec tree and requiring it gives
`Error: /tmp/noexec-65caa73/dlopen/rollup.linux-x64-gnu.node: failed to map segment from shared
object`, with no vitest involved at all, while `require`-ing the *same file* from the exec-able
`/workspace/antonina/web/node_modules/@rollup/rollup-linux-x64-gnu/` loads cleanly — so the
obstruction is the mount, not the web suite and not this toolchain. The number above was obtained by
pointing the copy's `web/node_modules` at the exec-able
`/workspace/antonina/web/node_modules` and running vitest with `--root` on the noexec copy, so the
*test sources and the Vite config* are the noexec ones and only the toolchain is not. The
agent-runtime and cli rows, by contrast, need no such adjustment — they are same-method measurements
of the same head as the left column, taken by invoking `node --test` directly on the noexec copy with
no toolchain resolution involved at all. The same adjustment is what makes the end-to-end harness
row measurable on the copy: without it the harness aborts at its very first step, `tsc`, before any
test runs, because `web/node_modules` does not exist in the copy.

What a developer on a `noexec` checkout sees is those tests fail with an
`ANTONINA_FIXTURE_NOEXEC` error naming both candidate directories and the reason each was rejected —
not the confusing "the real `opencode` answered" symptom the old account produced. The fix for such
a developer is to point `TMPDIR` at an exec-able directory (the first candidate) — or to re-checkout
on an exec-able filesystem; there is no third option in the current guard, and adding one would be a
change to the fixture front, not to this note.

## What pins the authorization shape, and what does not

The collect commit path refuses any record that is not the one the re-check issued, by identity.
What the suite actually pins about that, in `packages/core/test/collection.test.mjs` on `65caa73`:

- **The success-path commit is pinned.** `one re-check authorizes one deletion, and a copy of it is
  not that authorization` (`:643`) ends by committing the real record at `:669`
  (`commitCollectionDeletion(authorized).outcome === 'collect'`) and then showing the same record
  spent, and
  `a spent or unissued authorization removes nothing, and a copy is not the record` (`:967`) pins
  that a spent or copied record reaches nothing. Both would fail if `commitCollectionDeletion`
  stopped calling the commit at all.
- **A shallow copy is refused, and the limit of that case is the point.**
  `one re-check authorizes one deletion…` (`:643`) asserts at `:651-652` that
  `commitCollectionDeletion({ ...authorized })` throws `/not a live authorization/` (`:653`). What a
  shallow copy *cannot* exercise is an in-place edit of a frozen field: **`root` is frozen**, and
  frozen at both ends — `validateManagedRoots` (declared at `packages/core/src/managed-roots.ts:181`)
  freezes each entry at `:200` (`Object.freeze({ spelled: rootPath, resolved: rootResolved })`), and
  `isUnchanged` (`packages/core/src/collection.ts:931-936`) compares `root` by identity at `:936`
  rather than field by field precisely because the object's own contents cannot be
  edited in place. So the only tampering available on that field is *substitution* of a different,
  equal-looking root, which is a mismatch and is refused — and substitution is what
  `a write to either carried removal-shape field is refused at the commit` (`:841`, the `root` case
  at `:850`) actually exercises. A reader should not credit the shallow-copy assertion with covering
  a field tamper it structurally cannot perform.
- **The removal is issued-record-driven.** `a removal shape re-pointed after the re-check cannot
  reach the filesystem` (`:879`), `a re-pointed path is refused at the removal, with nothing
  removed` (`:915`), `the removal acts on the issued record, so an untouched authorization removes
  what the re-check read` (`:949`), and `a report reads the issued record, and a re-pointed
  authorization has no report` (`:1342`) are the direct pins for the `cli` rows
  `a removal that fails for any reason other than absence is not swallowed` (`:751`) and
  `a removal that fails part-way is still owed its one commit` (`:912`) in
  `packages/cli/test/collection.test.mjs` on the same head.

Nothing in this section is claimed to be exhaustive of the commit path, and nothing in it is claimed
to be covered that is not named above; the point is to record which of these cases the suite
genuinely reaches, so that a later pass can tell a removed assertion from a weakened one. Every
line number in this section was re-read on `65caa73`, and two of them **moved** in this delta and
are therefore re-derived rather than carried: `isUnchanged` is at `packages/core/src/collection.ts:931`
(the previous pin recorded `:926-929`), and `removeAndCommit` is at `packages/cli/src/collection.ts:535`
(the previous pin recorded `:538`). `packages/core/test/collection.test.mjs`,
`packages/core/src/collection.ts` and `packages/core/src/managed-roots.ts` are untouched by the whole
`f5fe5cc..65caa73` delta (`git diff --numstat f5fe5cc 65caa73 -- packages/core` names no test file),
so their anchors are unchanged as a *fact about those files* — which is not a licence to carry them.
`packages/cli/test/collection.test.mjs` **is** touched by the delta and all four of its anchors in
this paragraph were re-read.

### The route `ceab3bb` closes is unreachable today, and the guarantee is still real

Stated outright, because a reader should not come away believing a live hole was closed. `ceab3bb`
(the F3/F6 front, merged as `fc08a7a`) added the *report* built from the issued record
(`a report reads the issued record, and a re-pointed authorization has no report`,
`packages/core/test/collection.test.mjs:1342`). The route that closes is: re-check, then re-point the
authorization, then act. **On this tree that route is unreachable**, and the reason is reachability,
not enforcement: the only caller of the destructive door in the repository is
`packages/cli/src/collection.ts:500`, which calls `removeAndCommit(authorized, …)` with the very
object the re-check returned, inside one function, with no `await` between the re-check and the call
in which the authorization is held by anything that could write to it
(`git grep -n 'removeAuthorizedPath\|removeAndCommit' packages/*/src web/src` names only
`packages/cli/src/collection.ts` and core's own definition). There is no caller that holds the
authorization across an `await` and could mutate it in the interval.

So the guarantee the `ceab3bb` tests pin is real, but for a different reason than a reader would
otherwise assume: **before that front, core exported no non-destructive door at all.** The report
did not exist to be lied to, so there was nothing to close on that axis. What `ceab3bb` changed is
that a non-destructive consumer now exists and is built from the issued record — which makes the
single-use interval worth pinning before a future caller grows one, and which is why the tests are
worth having even though no current caller can reach the defect. This is a note about what the tests
are *for*, not a claim that the current tree is exploitable.

### Two things in the commit path that this suite does not pin, and one docstring that is now wrong

Recorded as owed by a code front, not fixed here — this commit is documentation-only and touches no
source or test file. **All three were re-checked on `65caa73` and all three are still open**, with
the anchors re-read at this head.

- **The success-path rule "a commit failure propagates" has no test.** On the success path
  (`packages/cli/src/collection.ts:565`, `if (reached) commit(authorized);`) a `commit` that throws
  propagates to the caller. Nothing in `packages/cli/test/collection.test.mjs` asserts it. The
  nearest cases are the *removal*-failure rules — `a bookkeeping failure cannot replace the removal
  failure it was owed for` (`:954`) and `a refusal and an un-confirmed pending report are owed no
  commit at all` (`:973`) — which cover the error path and the never-reached path, not this one.
  A mutant that wrapped that line in a bare `catch {}` would pass the shipped suite.
- **Nothing pins the default commit target to core's real spender.** `removeAndCommit`'s third
  parameter defaults to core's `commitCollectionDeletion`
  (`packages/cli/src/collection.ts:535`), and the only production call site at `:500` passes
  `options.commit ?? commitCollectionDeletion` explicitly, so the default is currently unreachable
  in production. No test asserts that the default *is* that function, so swapping it would not be
  caught. This is the mirror of the row above: both are about the un-injected path.
- **`collection.ts`'s commit docstring is still wrong about the mechanism.** The docstring on
  `removeAndCommit` (`packages/cli/src/collection.ts:508-533`) says twice that "the commit rides a
  `finally` over the removal" and reasons about what happens "inside a `finally`". The code below it
  is **try/catch**, not `finally` (`:552-566`): `try { removal = await coreRemoveAuthorizedPath(…) }
  catch (error) { if (reached) { try { commit(authorized); } catch {} } throw error; }` followed by
  `if (reached) commit(authorized);` at `:565`. Every behavioural claim the docstring makes is still
  true of the try/catch — the commit is armed by the filesystem being reached, the removal's error
  object propagates untouched, and a commit failure is swallowed only when the removal threw — so
  the defect is the word `finally`, twice, at `:515` and `:522`, describing a construct the function
  does not use. The note previously attributed this to `collection.ts:478`; at `65caa73`
  `collection.ts:478` is a `CollectionFailureKind` union member with no such text, and the
  docstring in question is the one in **`packages/cli`**. Correcting it there is a one-word source
  comment change and is left to a code front rather than smuggled into a docs-only re-pin. **It is
  reported here, not fixed here, and it is still present on this head.**

### `80decd7`'s quoted proof bytes are not reproducible by a reader

`80decd7` ("Scope the (b) test comment to the entry under test") is a comment-only commit whose
message states that "the comment-stripped token proof requires" the test title to stay
byte-identical, and quotes that it did so. **Those quoted bytes cannot be checked by reading this
note or the tree**: the proof is a computation over a test title that the reader has to perform
themselves, on their own checkout, with whatever tool the front used — and this note does not record
what that tool is. A reader must therefore **re-run the proof rather than trust the quoted bytes**,
and must not cite `80decd7`'s message as evidence that the title is unchanged. The check that is
cheap and this note *can* vouch for, re-read on `65caa73`: the title
`(b) a non-canonical spelling is refused before any I/O` is present, byte-identical, at
`packages/agent-runtime/test/managed-roots-config.test.mjs:179`, with the scoping comment
`80decd7` added immediately above it at `:172-178` still in place. That is the state the quoted
proof was about; the proof itself is not re-run here and is not claimed to be.

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

**Re-checked at `65caa73` and still true, so it stands unchanged.** `package.json:16` is still
`"test": "npm run test:core && npm run test:runtime && npm run test:cli && npm run test:web"` and
still contains no `tsc`; `package.json:10-11` are still the only routes to the conformance project;
and `tsconfig.conformance.json` still exists, which is why the harness runs that `tsc -p`
conditionally. The 16 commits in this delta touch neither the root scripts nor that project file
(`git diff --name-only f5fe5cc 65caa73` names no root `package.json` and no `tsconfig*.json`; it does
name `packages/cli/package.json`, which is the CLI's own `0.1.1` version bump from `dfa42b4` and
carries no test route), but the claim was re-read against the tree at this head rather than assumed,
and nothing here needed rewriting as a result.

## Test-safety of the runs recorded here

Both harness runs and every `node --test` invocation in the `noexec` section below were given
`XDG_STATE_HOME` **and** `XDG_CONFIG_HOME` as fresh `mktemp -d` directories, removed afterwards.
`XDG_CONFIG_HOME` is included because `9299298` moved the board's trust anchor and credential out of
the environment and into `$XDG_CONFIG_HOME/antonina/`; a run that omitted it would read the
operator's real `trust.json` and `credential.json`. Every process spawned by the suites converged or
was reaped before its run ended — confirmed by the clean `git status --porcelain` and absent
`.antonina-test-tmp` rows in both tables, and by observing that no `node` process from this
worktree survived either run.
