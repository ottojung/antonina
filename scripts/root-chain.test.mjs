// The root `npm test` chain's bare-checkout contract, asserted by expansion.
//
// Board issue 74 follow-up. This is the gate that makes the release line's
// root chain runnable on a bare checkout with no browser, no chromedriver and
// no built `web/dist`, and the gate that makes re-breaking it impossible to do
// silently.
//
// It works by expansion, not by reading the chain's text. The previous guard
// — `the root npm test chain does not require a browser or a built bundle`, in
// `scripts/deploy-smoke.test.mjs` — string-matched `pkg.scripts.test` for
// `test:deploy-smoke`, so the step `node --test scripts/*.test.mjs` passed it:
// that command contains neither the name nor a `deploy-smoke` substring, and it
// does not need to, because it names a *glob*. Board 74 added
// `scripts/deploy-smoke.test.mjs` to the directory that glob covers and the
// root chain went from 10 tests to 37, 27 of which need a real browser and a
// built bundle. A guard that reads the text cannot see a glob.
//
// So `scripts/root-chain.mjs` resolves the chain to the set of files on disk,
// and the cases below assert against that set. A suite that declares a
// precondition it cannot meet without a host — `browser`, `chromedriver`,
// `built-web-bundle`, marked with an `antonina-test-needs:` comment in its own
// header — fails the gate if the chain reaches it, by any route: by a glob, by
// a rename into a covered directory, or by being appended to the chain by name.
//
// This file is deliberately pure Node with no host preconditions of its own, so
// it runs *inside* the root chain. The guard is useless in a suite the root
// chain does not run.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CHAIN_RUNNER,
  CHAIN_SCRIPT,
  HOST_PRECONDITION_NEEDS,
  TEST_NEEDS_MARKER,
  declaredHostPreconditions,
  declaredTestNeeds,
  resolveRootTestChain,
  rootChainSource,
} from './root-chain.mjs';
import {
  PREREQ_SCRIPT,
  TYPECHECK_SCRIPT,
  WEB_TYPECHECK_SCRIPT,
  formatPrereqNotice,
  inspectBuildState,
  resolvePrerequisite,
  typecheckCoversWeb,
  typecheckedSources,
} from './root-chain-prereq.mjs';
import { runChain, runWithPrerequisite, summarize } from './root-chain-run.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chain = resolveRootTestChain(repoRoot);

test('the root npm test chain resolves to a set of test files on disk', () => {
  assert.ok(chain.files.length > 0, 'the root chain resolved to no test files at all');
  for (const file of chain.files) {
    assert.ok(existsSync(file), `the root chain names a file that does not exist: ${file}`);
  }
  // The resolution must actually cover the suites, not silently return one
  // directory. If a future step stops being parseable the gate would pass on a
  // short list, so the suites the chain is supposed to run are named here.
  for (const suite of [
    'packages/core/test/',
    'packages/agent-runtime/test/',
    'packages/host-daemon/test/',
    'packages/cli/test/',
    '.github/',
    'scripts/build-identity.test.mjs',
    'scripts/root-chain.test.mjs',
  ]) {
    assert.ok(
      chain.relative.some((file) => file.startsWith(suite)),
      `the root chain resolves to nothing under ${suite}`,
    );
  }
});

test('the root npm test chain reaches no suite that needs a browser or a built bundle', () => {
  // The defect itself, asserted as a property of the expanded file set.
  const offenders = [];
  for (const file of chain.files) {
    const needs = declaredHostPreconditions(file);
    if (needs.length > 0) offenders.push(`${file.slice(repoRoot.length + 1)} needs ${needs.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `the root \`npm test\` chain runs suites that cannot run on a bare checkout:\n  ${offenders.join('\n  ')}\n`
      + 'A suite that needs a browser, a chromedriver or a built web bundle belongs behind '
      + '`npm run test:deploy-smoke` and the CI job that provisions both, not in the root chain.',
  );
});

test('the deploy smoke suite declares the preconditions that keep it out of the root chain', () => {
  const smoke = join(repoRoot, 'scripts', 'deploy-smoke.test.mjs');
  // Positive direction: the declaration the previous cases rely on is really
  // present, so "no offenders above" is not vacuous.
  for (const need of ['browser', 'chromedriver', 'built-web-bundle']) {
    assert.ok(
      declaredTestNeeds(smoke).includes(need),
      `scripts/deploy-smoke.test.mjs does not declare \`${need}\` with an \`${TEST_NEEDS_MARKER}:\` comment, `
      + 'so the root chain case above cannot see it',
    );
  }
  // And it is genuinely not in the root chain, by name or by glob.
  assert.ok(
    !chain.files.includes(resolve(smoke)),
    'the root chain reaches the deploy smoke suite by a glob rather than by the explicit exclusion it needs',
  );
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:deploy-smoke'], 'node --test scripts/deploy-smoke.test.mjs');
});

test('the needs a suite can declare are the ones the gate knows about', () => {
  // If a new need were added to the list without being expressible, or a suite
  // declared a misspelled need, the gate would pass on a typo.
  assert.deepEqual(HOST_PRECONDITION_NEEDS, ['browser', 'chromedriver', 'built-web-bundle']);
  const smoke = join(repoRoot, 'scripts', 'deploy-smoke.test.mjs');
  for (const need of declaredTestNeeds(smoke)) {
    assert.ok(
      [...HOST_PRECONDITION_NEEDS, 'no-host-precondition'].includes(need),
      `scripts/deploy-smoke.test.mjs declares an unknown need \`${need}\`; the gate will not act on it`,
    );
  }
});

test('no step of the root chain globs a directory that holds a suite with host preconditions', () => {
  // The residual trap in its bluntest form: re-widen `test:build-identity` to
  // `node --test scripts/*.test.mjs` and the root chain silently reaches the
  // deploy smoke suite again. That is the exact change that produced board
  // 74's Finding 1, so it is asserted against directly rather than left to
  // follow from the cases above — the cases above see the *file set*, and a
  // re-widened glob that happens to be the only thing in that directory
  // changes the file set only after a browser suite is added there.
  //
  // `web/src` and `web` are in the scanned directories for the reason given in
  // `the web suites the root chain runs through test:web are enumerated and
  // none of them needs a host`: those files are `.ts`/`.tsx` rather than
  // `.test.mjs`, but a script that grew a `web/src/*.test.*` glob would reach
  // them exactly as `scripts/*.test.mjs` reaches the deploy smoke suite.
  const preconditioned = new Map();
  for (const dir of ['scripts', 'packages/core/test', 'packages/agent-runtime/test', 'packages/host-daemon/test', 'packages/cli/test', '.github', 'web/src', 'web']) {
    const full = join(repoRoot, dir);
    for (const name of readdirSync(full)) {
      if (!isTestFileName(name)) continue;
      const file = join(full, name);
      const needs = declaredHostPreconditions(file);
      if (needs.length > 0) preconditioned.set(dir, needs);
    }
  }
  assert.ok(
    preconditioned.has('scripts'),
    'this case is only meaningful while a suite with host preconditions lives in a directory the root chain could glob; '
    + 'if that suite moved, re-check this case rather than trusting it',
  );
  for (const command of Object.values(pkgScripts())) {
    for (const token of command.split(/\s+/)) {
      const dir = token.replace(/\/?\*[^/]*$/, '').replace(/\/$/, '');
      if (dir === '' || !preconditioned.has(dir)) continue;
      assert.fail(
        `\`${command}\` globs ${dir}/, which holds a suite that needs ${preconditioned.get(dir).join(', ')}. `
        + 'Name the bare-checkout suites explicitly instead of globbing a directory that also holds a browser suite.',
      );
    }
  }
});

test('every test file in scripts/ is named by a script, so none is orphaned by the narrowed glob', () => {
  // The narrowed `test:build-identity` is correct only if the file it stopped
  // globbing is still reachable by name. A future suite added to scripts/ and
  // wired to nothing would be dead code that the root chain no longer sweeps
  // up, which is the same class of silent loss as the silent gain that caused
  // this issue.
  const scripts = pkgScripts();
  const named = new Set();
  for (const command of Object.values(scripts)) {
    for (const token of command.split(/\s+/)) {
      if (token.endsWith('.test.mjs')) named.add(token.replace(/^\.\//, ''));
    }
  }
  const orphans = readdirSync(join(repoRoot, 'scripts'))
    .filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => !named.has(`scripts/${name}`))
    .sort();
  assert.deepEqual(orphans, [], `test files in scripts/ that no npm script runs: ${orphans.join(', ')}`);
});

function pkgScripts() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
}

/**
 * A vitest- or node-test-shaped test file name. `web/` suites are `.ts`/`.tsx`
 * and run under `vitest`, not `node --test`, so the `.test.mjs` suffix alone
 * would leave the whole `web/` tree unscanned.
 */
function isTestFileName(name) {
  return /\.(test|spec)\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/.test(name);
}

/**
 * Every test file under `web/` that `npm run test:web` (`vitest run`) will pick
 * up, as repository-relative paths. `node_modules` and `dist` are excluded
 * because vitest excludes them.
 */
function webTestFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isTestFileName(entry.name)) files.push(full.slice(repoRoot.length + 1).split('\\').join('/'));
    }
  };
  walk(join(repoRoot, 'web'));
  return files.sort();
}

test('the web suites the root chain runs through test:web are enumerated and none of them needs a host', () => {
  // The gate cannot expand `npm test --prefix web` — `test:web` is reported as
  // an `unresolved` step, so no case above ever asks about a `web/` path. That
  // gap is honest, and it was also where a suite could hide: a browser-requiring
  // test added as `web/src/foo.test.ts` declaring all three needs is swept into
  // the root chain by `test:web` and every case above stays green, because the
  // file is in the one directory the chain's file set never contains. The marker
  // is read correctly; nobody asks.
  //
  // So the web set is enumerated here explicitly and held to the same rule as
  // the resolvable steps. If a `web/` suite genuinely needs a host, this case
  // fails and names it — which is the point: the decision becomes reviewable
  // instead of invisible. Board 74's own subject matter is web-UI testing, so
  // this is the most likely directory for the next browser suite.
  const offenders = [];
  for (const relative of webTestFiles()) {
    const needs = declaredHostPreconditions(join(repoRoot, relative));
    if (needs.length > 0) offenders.push(`${relative} needs ${needs.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `\`npm run test:web\` is a step of the root \`npm test\` chain and vitest runs every suite under \`web/\`, `
      + `including ones needing a host:\n  ${offenders.join('\n  ')}\n`
      + 'A suite that needs a browser, a chromedriver or a built bundle does not belong under `web/` while '
      + '`test:web` is in the root chain: the chain cannot exclude a vitest file, and this gate cannot expand one.',
  );
});

test('the vitest set this case enumerates is the set the root chain actually runs', () => {
  // A guard against the case above going vacuous the way a narrowed glob would.
  // If `web/` ever held no test files, "none of them needs a host" would be
  // trivially true, so the enumeration is pinned against the files the tree
  // actually has. `web/build-identity-plugin.test.ts` is named because it lives
  // at the `web/` root rather than under `web/src`, and a walker that only
  // descended into `web/src` would miss it — the same shape as the glob hole
  // the rest of this gate exists to close.
  const files = webTestFiles();
  assert.ok(files.length > 0, 'no test files found under web/; the enumeration above would be vacuous');
  for (const expected of ['web/build-identity-plugin.test.ts', 'web/src/api.test.ts']) {
    assert.ok(
      files.includes(expected),
      `the web test enumeration missed ${expected}; found ${JSON.stringify(files, null, 2)}`,
    );
  }
  assert.ok(
    !files.some((file) => file.startsWith('web/node_modules/') || file.startsWith('web/dist/')),
    'the web test enumeration reached into node_modules or dist, which vitest excludes',
  );
});

// ---------------------------------------------------------------------------
// Board issue 123: a short-circuiting chain, and the tail it hides.
//
// Everything above this line is board 74's browser/bundle contract. These cases
// are a different defect, and the difference matters: that one was a chain that
// ran suites it *should not* have run, and this one is a chain that did not run
// suites it *should* have. A chain built from the shell's `&&` stops at the
// first non-zero exit, so when `test:web` failed, `test:workflow` and
// `test:build-identity` produced no output, no artifact and no trace. The run
// was red, but a reader saw five green suites and one red one, and the two
// absent suites looked exactly like two suites that do not exist.
//
// The fix has two halves and they are not equally trusted. The executable half
// is `scripts/root-chain-run.mjs`: it runs every step, records every exit code,
// prints a per-step summary and still exits non-zero if anything failed. The
// asserted half is here, because a mechanism in a file that nothing runs is a
// comment. The cases below are the ones that keep the mechanism honest: they
// pin the chain's shape, and they observe the runner failing on a synthetic
// chain, because a visibility mechanism nobody has watched fail is not a
// mechanism known to work.
// ---------------------------------------------------------------------------

test('the root npm test chain is executed by the runner, not by the shell', () => {
  // The shape of the fix, pinned. `npm test` must not be an `&&` expression:
  // that is precisely the thing whose short-circuit hid the tail. The chain
  // lives in its own script so the runner and this gate read one list.
  const scripts = pkgScripts();
  assert.equal(
    scripts.test,
    `node ${CHAIN_RUNNER}`,
    '`npm test` is not the chain runner, so a short-circuiting `&&` chain can hide the suites after it again',
  );
  assert.equal(CHAIN_RUNNER, 'scripts/root-chain-run.mjs');
  assert.ok(
    existsSync(join(repoRoot, CHAIN_RUNNER)),
    `\`npm test\` invokes ${CHAIN_RUNNER}, which does not exist, so \`npm test\` cannot run at all`,
  );
  assert.equal(
    scripts[CHAIN_SCRIPT],
    rootChainSource(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))),
    `\`${CHAIN_SCRIPT}\` is missing, so the runner has no chain to execute and falls back to \`scripts.test\``,
  );
  assert.ok(
    !/\s&&\s/.test(scripts.test),
    `\`npm test\` still chains with \`&&\`: ${scripts.test}. The runner exists so no step can skip the ones after it.`,
  );
});

test('every suite the root chain is supposed to run is a step the runner will execute', () => {
  // The anti-skip property, asserted on the resolved step list. `resolveRootTestChain`
  // already walks the chain; these are the suites that must appear in the list of
  // steps the runner actually invokes. This is the case that fails if someone
  // drops a suite from `chain:root-test` — the tail would then be missing
  // deliberately rather than by accident, and would still be silent without this.
  const named = chain.steps.map((step) => step.name);
  for (const suite of [
    'test:core',
    'test:runtime',
    'test:daemon',
    'test:cli',
    'test:web',
    'test:workflow',
    'test:build-identity',
  ]) {
    assert.ok(named.includes(suite), `the root chain does not run \`${suite}\`; it runs ${JSON.stringify(named)}`);
  }
  // Order is part of the contract: the cheap pure-Node suites first, so a
  // failure is reported against the smallest possible cause.
  assert.deepEqual(
    named,
    ['test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'],
    'the root chain runs a different set or order of suites than the release line declares',
  );
  // No duplicates: a suite listed twice would run twice and report twice, which
  // is a chain whose accounting cannot be read.
  assert.equal(new Set(named).size, named.length, `the root chain names a suite more than once: ${JSON.stringify(named)}`);
});

test('the chain runner runs every step after a failure instead of stopping at the first', () => {
  // The defect, demonstrated red under mutation, with a synthetic chain so no
  // real suite has to be broken to observe it. The old chain was `a && b && c`:
  // `a` failing meant `b` and `c` never ran. Here `a` fails and `b` and `c` are
  // still recorded, each with its own exit code.
  const executed = [];
  const results = runChain(
    [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    { exec: (name) => { executed.push(name); return name === 'a' ? 1 : 0; }, log: () => {} },
  );
  assert.deepEqual(
    executed,
    ['a', 'b', 'c'],
    'the runner stopped after a failing step, so the suites after it were skipped — the exact defect of board 123',
  );
  assert.deepEqual(
    results.map((r) => [r.name, r.code]),
    [['a', 1], ['b', 0], ['c', 0]],
    'the runner did not report an exit code for every step it ran',
  );
});

test('the chain runner reports every failure, and its exit status is non-zero if any step failed', () => {
  // Two halves. First, that a failure anywhere is visible and not just the
  // first: the `&&` chain could only ever tell you about one. Second, and this
  // is the half that must not be relaxed, that the runner does not become a way
  // of *tolerating* a failure — it is strictly stricter than `&&`, which exited
  // non-zero too but had already stopped running.
  const executed = [];
  const results = runChain(
    [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    { exec: (name) => { executed.push(name); return name === 'c' ? 3 : 0; }, log: () => {} },
  );
  assert.deepEqual(executed, ['a', 'b', 'c']);
  const failed = results.filter((r) => r.code !== 0);
  assert.deepEqual(failed.map((r) => r.name), ['c'], 'a non-zero step was not reported as a failure');
  assert.notEqual(results.some((r) => r.code !== 0), false, 'a non-zero step did not make the run non-zero');
  // A step killed by a signal has no status; it must not read as a pass.
  const signalled = runChain([{ name: 'a' }], { exec: () => undefined, log: () => {} });
  assert.notEqual(signalled[0].code, undefined, 'a step with no exit status was recorded without one');
});

test('the chain runner does not run a suite the chain does not name', () => {
  // The other direction, so the fix cannot be used to quietly *add* work: the
  // runner executes exactly the steps `resolveRootTestChain` resolved from the
  // chain, and nothing else. The deploy smoke suite is the standing witness that
  // this matters — it needs a browser and a built bundle.
  const smoke = resolve(join(repoRoot, 'scripts', 'deploy-smoke.test.mjs'));
  assert.ok(
    !chain.files.includes(smoke),
    'the root chain reaches the deploy smoke suite, so the runner would execute a suite that cannot run on a bare checkout',
  );
  // And the runner's step list is derived from the chain, not hardcoded: it
  // contains no script name the chain does not contain.
  const chainText = rootChainSource(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')));
  for (const step of chain.steps) {
    assert.ok(
      chainText.includes(`npm run ${step.name}`),
      `the runner would execute \`${step.name}\`, which \`${CHAIN_SCRIPT}\` does not name`,
    );
  }
});

test('the root chain steps this gate cannot resolve are the ones it says they are', () => {
  // `npm test --prefix web` runs a package-local runner whose file set is not
  // visible from here. Reporting it as unresolved is what keeps the other
  // cases an honest account of what they cover instead of a blanket claim.
  const steps = chain.unresolved.map((entry) => entry.step);
  assert.deepEqual(
    steps,
    ['npm test --prefix web'],
    `the root chain has steps this gate cannot resolve, and they are not the expected one: ${JSON.stringify(chain.unresolved, null, 2)}`,
  );
});

// ---------------------------------------------------------------------------
// Board issue 124: the step the chain required and did not name.
//
// Everything above is boards 74 and 123. Those are about what the chain *runs*:
// board 74's was a chain that ran browser suites it could not run, and board
// 123's was a chain that did not report the suites it skipped. This section is
// about a step that was never in the chain at all, so neither mechanism could
// see it — a runner that faithfully executes and reports seven steps is still
// seven red steps and no explanation when the eighth, unlisted one was skipped.
//
// The failure that had to become impossible, measured twice on fresh worktrees:
//
//   board 123's front — `npm test` exited 1, red at 5 of 7 steps, four
//     `ERR_MODULE_NOT_FOUND` errors naming `packages/*/dist`, one vitest Startup
//     Error, and nothing anywhere saying a prerequisite had been skipped;
//   board 112's front — `npm run typecheck` exited 127 with
//     `./web/node_modules/.bin/tsc: not found`, immediately below a
//     `pretypecheck` step that had exited 0, because `pretypecheck` is plain node.
//
// A caller who skipped `typecheck` saw a green step, then a compiler error with
// no cause, or four module-resolution errors naming build output. Both read as
// code regressions and neither was one.
//
// The fix has two halves and, as with board 123, only one of them is the
// mechanism. The declared prerequisite and the build-state inspection live in
// `scripts/root-chain-prereq.mjs`; the runner runs them in
// `scripts/root-chain-run.mjs`. Every case below is here because a mechanism
// asserted only by a comment is not asserted at all.
// ---------------------------------------------------------------------------

test('the root npm test chain declares its prerequisite as data, not as a comment', () => {
  // The defect was an *undeclared* prerequisite. Declaring it in a comment would
  // leave the runner's behaviour unconnected to it: delete the comment, or
  // change the script, and the chain goes back to requiring something nothing
  // reads. So the declaration is a `package.json` key that a resolver reads,
  // and this case pins that it resolves to a script that exists.
  const prereq = resolvePrerequisite(repoRoot);
  assert.ok(prereq !== null, `\`package.json\` declares no \`${PREREQ_SCRIPT}\`, so \`npm test\` has no declared prerequisite and the defect is back`);
  assert.equal(
    prereq.name,
    'typecheck',
    `\`${PREREQ_SCRIPT}\` names ${prereq.name}; the chain's declared prerequisite is \`typecheck\`, which is what emits \`packages/*/dist\` and the generated build-identity modules`,
  );
  assert.equal(prereq.command, pkgScripts().typecheck);
});

test('the declared prerequisite typechecks the web app, not only packages/*', () => {
  // Board issue 193. The measured hole, re-derived on this line at base 7565ee11:
  // the root `typecheck` compiled `packages/*` only, so `web/src` was compiled by
  // nothing a landing gate runs — vitest does not typecheck, and the web build's
  // own `tsc -b` is not a gate step. A type error under `web/src` therefore left
  // `npm run typecheck` at 0 and `npm test` at 0 across all seven chain steps,
  // and read as passing. That is the fail-open shape boards 66, 69 and 108
  // exist to prevent.
  //
  // This asserts coverage of `web` by the root `typecheck`, derived by walking
  // the command rather than by matching one string, so it survives a legitimate
  // rewrite of the command and fails if the web app is dropped out of it again.
  const sources = typecheckedSources({ scripts: pkgScripts() });
  assert.ok(
    sources.has('web'),
    `the root \`${TYPECHECK_SCRIPT}\` compiles ${[...sources].sort().join(', ')} and not \`web\`, so a type error in web/src is invisible to the chain's prerequisite. Run \`npm run ${WEB_TYPECHECK_SCRIPT}\` from it.`,
  );
  assert.deepEqual(
    [...sources].sort(),
    ['packages/agent-runtime', 'packages/cli', 'packages/core', 'packages/host-daemon', 'web'],
    'the root `typecheck` no longer covers exactly the five TypeScript roots this repository declares',
  );
  // The web step must be the web app's own typecheck, not something named
  // `typecheck:web` that compiles nothing.
  assert.equal(pkgScripts()[WEB_TYPECHECK_SCRIPT], 'npm run typecheck --prefix web');
});

test('the web-coverage check is not vacuous: it fails when the web step is dropped', () => {
  // A guard that cannot fail is not a guard. Two regressions are covered, because
  // either one alone reopens board 193: deleting the web step from the root
  // typecheck, and leaving the step defined but unreferenced. Both must be
  // reported as "web is not covered" rather than passing quietly.
  const without = structuredClone(pkgScripts());
  delete without[WEB_TYPECHECK_SCRIPT];
  assert.equal(typecheckCoversWeb({ scripts: without }), false, 'removing the web typecheck step left the web app looking covered');

  const unreferenced = structuredClone(pkgScripts());
  unreferenced[TYPECHECK_SCRIPT] = unreferenced[TYPECHECK_SCRIPT].split('&&').filter((step) => !step.includes(WEB_TYPECHECK_SCRIPT)).join(' && ');
  assert.equal(typecheckCoversWeb({ scripts: unreferenced }), false, 'a web typecheck step that the root typecheck no longer names still looked like coverage');

  // And the positive control: the real tree is covered. Without this the two cases
  // above could pass on a resolver that always says "no".
  assert.equal(typecheckCoversWeb({ scripts: pkgScripts() }), true);
  assert.ok(typecheckedSources({ scripts: pkgScripts() }).has('web'));
});

test('the declared prerequisite is not a chain step, and the chain is still exactly the seven suites', () => {
  // The two contracts are kept apart deliberately. `chain:root-test` answers
  // "which suites guard this repository" and `prereq:root-test` answers "what
  // has to happen before the chain means anything". Folding the prerequisite
  // into the chain would make the pinned list above mean "seven test suites
  // plus a compile", and would make the prerequisite indistinguishable from a
  // failing suite in the summary — which is the misattribution again, one level
  // up.
  const prereq = resolvePrerequisite(repoRoot);
  assert.ok(prereq !== null, `no \`${PREREQ_SCRIPT}\` declared`);
  const named = chain.steps.map((step) => step.name);
  assert.ok(
    !named.includes(prereq.name),
    `\`${prereq.name}\` is a step of \`${CHAIN_SCRIPT}\` as well as the declared prerequisite, so it is reported as a suite and the two contracts can no longer be told apart`,
  );
  // Re-pin the list, so adding a prerequisite cannot quietly become adding a
  // suite and no test in this file is the one that notices.
  assert.deepEqual(
    named,
    ['test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'],
    'the root chain runs a different set or order of suites than the release line declares',
  );
});

test('a failed prerequisite does not stop, skip, or excuse any chain step', () => {
  // The load-bearing case, and the one a "fix" would most easily get wrong. The
  // obvious way to declare a prerequisite is a `pretest` script, and it is
  // exactly wrong: npm aborts before running `test` when `pretest` fails, so a
  // type error would produce a run reporting *zero* of its seven steps. That is
  // board 123's defect — suites that never ran, indistinguishable from suites
  // that do not exist — reintroduced through the front door. So the runner runs
  // the prerequisite, records it, and runs the chain regardless.
  //
  // Here the prerequisite fails at 127, the exit code board 112's front measured
  // for `./web/node_modules/.bin/tsc: not found`, and all seven steps are still
  // executed and still reported with their own exit codes.
  const executed = [];
  const groups = runWithPrerequisite(
    { name: 'typecheck', command: 'tsc' },
    ['test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'].map((name) => ({ name })),
    {
      exec: (name) => { executed.push(name); return name === 'typecheck' ? 127 : 0; },
      log: () => {},
    },
  );
  assert.deepEqual(
    executed,
    ['typecheck', 'test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'],
    'a failed prerequisite changed what the chain ran — the exact defect of board 123, reintroduced as a prerequisite',
  );
  assert.deepEqual(
    groups.map((group) => group.results.map((r) => [r.name, r.code])),
    [
      [['typecheck (declared prerequisite)', 127]],
      [
        ['test:core', 0], ['test:runtime', 0], ['test:daemon', 0],
        ['test:cli', 0], ['test:web', 0], ['test:workflow', 0], ['test:build-identity', 0],
      ],
    ],
    'the prerequisite and the chain are not reported as two separate groups of exit codes, so a failed prerequisite still reads as a failing suite',
  );
  // And the run is still red: a failed prerequisite must not be swallowed, or
  // `npm test` would go green on a tree that was never built.
  assert.ok(
    groups.flatMap((g) => g.results).some((r) => r.code !== 0),
    'a failed prerequisite did not make the run non-zero',
  );
});

test('no declared prerequisite still runs the whole chain, as its own group', () => {
  // The mirror of the case above with `prereq === null`, and the only case that
  // pins what runs when nothing is declared. `runWithPrerequisite` is the
  // function that decides what executes, and the `prereq !== null` branch is
  // where the chain call sits *outside*. Indent `root-chain-run.mjs:211` inward
  // by one level and the chain stops running exactly in this case — the
  // declaration is gone, the runner reports "all 0 steps ran and all passed",
  // and `npm test` exits 0 having run no suite at all. That is board 123's
  // defect, green instead of red, and the three cases that pass a prerequisite
  // cannot see it because they never take this path.
  //
  // (The undeclared-prerequisite case at
  // `the preflight notice is diagnostic and cannot stop or gate the chain` is a
  // different assertion: it pins `formatPrereqNotice`'s *text* for a null
  // prerequisite. It never calls `runWithPrerequisite`, so it cannot tell a
  // chain that runs from a chain that does not. Both stay.)
  const executed = [];
  const groups = runWithPrerequisite(
    null,
    ['test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'].map((name) => ({ name })),
    { exec: (name) => { executed.push(name); return 0; }, log: () => {} },
  );
  assert.deepEqual(
    executed,
    ['test:core', 'test:runtime', 'test:daemon', 'test:cli', 'test:web', 'test:workflow', 'test:build-identity'],
    'with no declared prerequisite the chain ran nothing — a `npm test` that runs no suite and exits 0',
  );
  assert.equal(groups.length, 1, 'with no declared prerequisite the chain is not reported as exactly one group');
  assert.equal(groups[0].title, 'root chain steps');
  assert.deepEqual(
    groups[0].results.map((r) => [r.name, r.code]),
    [
      ['test:core', 0], ['test:runtime', 0], ['test:daemon', 0],
      ['test:cli', 0], ['test:web', 0], ['test:workflow', 0], ['test:build-identity', 0],
    ],
    'with no declared prerequisite the chain steps are not reported with their own exit codes',
  );
});

test('a passing prerequisite is reported as a prerequisite and still runs the whole chain', () => {
  // The other direction, so the previous case cannot be satisfied by simply
  // never reporting the prerequisite. The green case is the one that matters
  // most in practice: it is what makes the four `ERR_MODULE_NOT_FOUND` errors
  // unreachable through `npm test`, because the thing that produces
  // `packages/*/dist` has already run by the time the suites do.
  const executed = [];
  const groups = runWithPrerequisite(
    { name: 'typecheck', command: 'tsc' },
    [{ name: 'test:core' }, { name: 'test:web' }],
    { exec: (name) => { executed.push(name); return 0; }, log: () => {} },
  );
  assert.deepEqual(executed, ['typecheck', 'test:core', 'test:web']);
  assert.equal(groups.length, 2, 'a passing prerequisite produced no separate group, so it is invisible in the summary');
  assert.equal(groups[0].title, 'declared prerequisite (npm run typecheck)');
  assert.equal(groups[0].results[0].name, 'typecheck (declared prerequisite)');
});

test('an unbuilt tree reports each missing condition separately, with its own remedy', () => {
  // Three conditions, three remedies, and a fresh worktree has all three at
  // once. Collapsing them into one "unbuilt" boolean is what would have left
  // board 112's front with a run that still told them to run a typecheck that
  // exits 127 — the misattribution, one level of indirection further away.
  //
  // The root is a throwaway directory, deliberately empty: this is the
  // fresh-worktree case the issue documents, produced without touching the real
  // tree or the real `web/node_modules`.
  const bare = mkdtempSync(join(tmpdir(), 'antonina-124-bare-'));
  try {
    const state = inspectBuildState(bare);
    assert.equal(state.ok, false, 'an empty tree was reported as ready to run the chain');
    const byKind = Object.fromEntries(state.missing.map((c) => [c.kind, c]));
    assert.deepEqual(
      Object.keys(byKind).sort(),
      ['build-output', 'generated-module', 'toolchain'],
      `an unbuilt tree did not report all three missing conditions; got ${JSON.stringify(state.missing, null, 2)}`,
    );
    // The condition that actually bit board 112's front is named as its own
    // thing, because no amount of typechecking can produce it.
    assert.deepEqual(byKind.toolchain.entries, ['web/node_modules/.bin/tsc']);
    assert.equal(byKind.toolchain.remedy, 'npm run bootstrap');
    // A missing package `dist` and a missing generated module are different
    // conditions and both are reported, with different remedies.
    assert.ok(
      byKind['build-output'].entries.includes('packages/core/dist'),
      `the unbuilt tree did not name a missing package dist directory: ${JSON.stringify(byKind['build-output'], null, 2)}`,
    );
    assert.equal(byKind['build-output'].remedy, 'npm run typecheck');
    assert.ok(
      byKind['generated-module'].entries.includes('packages/cli/src/build-identity.generated.ts')
      && byKind['generated-module'].entries.includes('web/build-identity.generated.ts'),
      `the unbuilt tree did not name both generated build-identity modules: ${JSON.stringify(byKind['generated-module'], null, 2)}`,
    );
    assert.equal(byKind['generated-module'].remedy, 'npm run generate:build-identity');

    // The notice has to say the thing that was true before the defect: that the
    // step results below are not evidence of a code regression. A notice that
    // only listed paths would still leave the reader to work that out.
    const notice = formatPrereqNotice({ prereq: { name: 'typecheck' }, state });
    for (const expected of [
      'MISSING PREREQUISITE',
      'npm run bootstrap',
      'npm run typecheck',
      'npm run generate:build-identity',
      'NOT evidence of a code regression',
      'will still run and report its own exit code',
    ]) {
      assert.ok(notice.includes(expected), `the preflight notice does not say \`${expected}\`:\n${notice}`);
    }
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('a tree that has been built reports no missing prerequisite', () => {
  // The other direction, so the notice above cannot be satisfied by always
  // printing a warning. This runs against a synthetic tree that contains
  // exactly what the prerequisite is supposed to produce, which also pins what
  // "built" means: the toolchain, both generated modules, and every package
  // dist. A tree missing any one of them is not built, and the three are not
  // interchangeable.
  const built = mkdtempSync(join(tmpdir(), 'antonina-124-built-'));
  const materialize = (root) => {
    for (const entry of ['web/node_modules/.bin/tsc', 'packages/cli/src/build-identity.generated.ts', 'web/build-identity.generated.ts']) {
      mkdirSync(dirname(join(root, entry)), { recursive: true });
      writeFileSync(join(root, entry), '');
    }
    for (const dir of ['packages/core/dist', 'packages/agent-runtime/dist', 'packages/host-daemon/dist', 'packages/cli/dist']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
  };
  try {
    materialize(built);
    const state = inspectBuildState(built);
    assert.deepEqual(state.missing, [], `a fully built tree was still reported as missing prerequisites: ${JSON.stringify(state.missing, null, 2)}`);
    assert.equal(formatPrereqNotice({ prereq: { name: 'typecheck' }, state }), null, 'a built tree still got a missing-prerequisite notice');

    // One condition at a time, each on its own freshly built tree, so the check
    // is not passing because the tree happened to be complete for a reason this
    // case does not control, and so a missing condition is not masked by an
    // earlier removal. Each of these is a real, distinct state a caller can be
    // in, and each must be named as itself.
    for (const [kind, entry] of [
      ['toolchain', 'web/node_modules/.bin/tsc'],
      ['generated-module', 'web/build-identity.generated.ts'],
      ['build-output', 'packages/agent-runtime/dist'],
    ]) {
      const partial_root = mkdtempSync(join(tmpdir(), 'antonina-124-partial-'));
      try {
        materialize(partial_root);
        rmSync(join(partial_root, entry), { recursive: true, force: true });
        const partial = inspectBuildState(partial_root);
        assert.deepEqual(
          partial.missing.map((c) => c.kind),
          [kind],
          `removing only ${entry} from an otherwise built tree did not produce exactly the \`${kind}\` condition; got ${JSON.stringify(partial.missing, null, 2)}`,
        );
      } finally {
        rmSync(partial_root, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
});

test('the preflight notice is diagnostic and cannot stop or gate the chain', () => {
  // A notice that altered the run would be a guard, and a guard that stopped the
  // chain is board 123's defect. So the notice is a pure function of the tree's
  // build state and the declared prerequisite: it takes no runner, returns no
  // exit code, and `runWithPrerequisite` — the thing that decides what runs —
  // does not consult it. Pinned here so a future "let's make it fatal" change
  // is a visible diff against this line rather than a silent one.
  const built = mkdtempSync(join(tmpdir(), 'antonina-124-pure-'));
  try {
    mkdirSync(join(built, 'packages'), { recursive: true });
    const args = { prereq: { name: 'typecheck' }, state: inspectBuildState(built) };
    assert.equal(formatPrereqNotice(args), formatPrereqNotice(args), 'the notice is not a pure function of its inputs');
    assert.equal(typeof formatPrereqNotice(args), 'string');
    // A tree with no declared prerequisite still gets an honest notice rather
    // than a crash, because "nobody declared the prerequisite" is the defect
    // being reported on, not an error to throw over.
    const undeclared = formatPrereqNotice({ prereq: null, state: inspectBuildState(built) });
    assert.ok(undeclared.startsWith('\nroot-chain-run: MISSING PREREQUISITE'), `the notice for an undeclared prerequisite is wrong:\n${undeclared}`);
  } finally {
    rmSync(built, { recursive: true, force: true });
  }
});

test('a declared prerequisite naming a script that does not exist is an error, not a silent pass', () => {
  // The failure mode a lenient resolver would allow: `prereq:root-test` names
  // `typechek`, nothing defines it, the runner "runs" nothing, and the chain
  // goes green having never built the tree. That is the defect with a
  // declaration attached, which is worse than no declaration.
  const bogus = mkdtempSync(join(tmpdir(), 'antonina-124-bogus-'));
  try {
    writeFileSync(
      join(bogus, 'package.json'),
      JSON.stringify({ name: 'x', private: true, scripts: { [PREREQ_SCRIPT]: 'typechek' } }),
    );
    assert.throws(
      () => resolvePrerequisite(bogus),
      /does not define/,
      'a prerequisite naming a script that does not exist was accepted',
    );
  } finally {
    rmSync(bogus, { recursive: true, force: true });
  }
});

test('the rendered summary names the failed prerequisite as a prerequisite, not as a failing suite', () => {
  // The summary is what a reader actually reads, so the grouping has to survive
  // all the way into the rendered text. A failed `typecheck` sitting in the
  // middle of the test results reads as a failing suite, which is the original
  // defect wearing a summary. This asserts on the rendered string rather than on
  // the runner's source, because source text would match a summary that is
  // never reached.
  const rendered = summarize(runWithPrerequisite(
    { name: 'typecheck', command: 'tsc' },
    [{ name: 'test:core' }, { name: 'test:web' }],
    { exec: (name) => (name === 'typecheck' ? 127 : 0), log: () => {} },
  ));
  assert.ok(rendered.includes('declared prerequisite (npm run typecheck)'), `the summary does not label the prerequisite:\n${rendered}`);
  assert.ok(rendered.includes('root chain steps:'), `the summary does not label the chain steps:\n${rendered}`);
  assert.ok(rendered.includes('typecheck (declared prerequisite)  FAIL (127)'), `the failed prerequisite is not reported with its real exit code:\n${rendered}`);
  // The sentence that stops a reader from calling this a code regression.
  assert.ok(
    rendered.includes('is the chain\'s declared prerequisite, not a test suite'),
    `the summary does not tell the reader that the red step is a prerequisite:\n${rendered}`,
  );
  // And it still names the chain's own results, so nothing was hidden by the
  // grouping.
  assert.ok(rendered.includes('test:core') && rendered.includes('test:web'), `the summary dropped a chain step:\n${rendered}`);
});

test('`npm test` is still the chain runner, so the prerequisite is what actually runs', () => {
  assert.ok(
    pkgScripts().test === `node ${CHAIN_RUNNER}`,
    '`npm test` is not the chain runner, so neither the chain nor its declared prerequisite would run',
  );
});
