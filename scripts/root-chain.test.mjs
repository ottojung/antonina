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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  HOST_PRECONDITION_NEEDS,
  TEST_NEEDS_MARKER,
  declaredHostPreconditions,
  declaredTestNeeds,
  resolveRootTestChain,
} from './root-chain.mjs';

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
