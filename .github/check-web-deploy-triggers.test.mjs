import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rootChainSource } from '../scripts/root-chain.mjs';

// This repository's own deploy trigger, checked by .github/check-web-deploy-triggers.mjs.
//
// The checker is the enforcement point for this issue: a `paths` entry that
// misses a bundle input is what caused the incident. Its failure direction is
// therefore the thing worth pinning, not the reachability of the trace. Every
// case below runs the real checker over a real mutated copy of the real workflow
// and asserts on its exit code, because the only way a permanently green deploy
// trigger gets shipped is a change that turns the checker into a no-op, and the
// only defence against that is a test that fails when it stops failing.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(repoRoot, '.github', 'check-web-deploy-triggers.mjs');
const workflow = join(repoRoot, '.github', 'workflows', 'web-deploy.yml');
const original = readFileSync(workflow, 'utf8');

function runChecker(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'antonina-trigger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'web-deploy.yml');
  writeFileSync(candidate, contents);
  const result = spawnSync(process.execPath, [checker, '--workflow', candidate], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, `checker failed to run: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the checked-in workflow covers every traced bundle input', (t) => {
  const result = runChecker(t, original);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: PASS \(all \d+ traced build inputs are covered\)/);
  // packages/core is the input class this issue was filed for, so its presence in
  // the traced set is the assertion that matters, not just the summary line.
  assert.match(result.stdout, /covered {3}packages\/core\/src\/api\.ts/);
});

test('a dropped paths entry turns the check red', (t) => {
  // The regression this whole issue exists to prevent. If the checker cannot see
  // this, then nothing in CI can see it either.
  const mutated = original.replace('      - "packages/core/**"\n', '');
  assert.notEqual(mutated, original, 'the paths entry to remove was not found; the fixture would be vacuous');
  const result = runChecker(t, mutated);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /UNCOVERED packages\/core\//);
  assert.match(result.stderr, /RESULT: FAIL/);
});

test('a paths filter that covers nothing is reported rather than passed', (t) => {
  const mutated = original.replace(/^ {6}- "[^"]+"\n/gm, '');
  assert.notEqual(mutated, original, 'the paths entries to remove were not found; the fixture would be vacuous');
  const result = runChecker(t, mutated);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /RESULT: FAIL/);
});

test('the traced make target comes from a run step, not from a comment', (t) => {
  // A `make` named only in prose used to be traced, because the target was the
  // first `make ` anywhere in the file. A wrong target yields a smaller input
  // set, which yields a PASS, so the decoy has to be ignored silently.
  const mutated = original.replace('    paths:', '    # run: make dist   (prose, not a command)\n    paths:');
  assert.notEqual(mutated, original, 'the insertion point was not found; the fixture would be vacuous');
  const result = runChecker(t, mutated);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: PASS/);
  assert.doesNotMatch(result.stdout, /WARNING: no make target/);
  // `make dist` is not a target of this repository's Makefile, so tracing it
  // instead of `build` would have emptied the input set rather than kept it. The
  // count is the traced bundle inputs this revision actually has, so adding a
  // `web/**` or `packages/core/src/**` source file is expected to move it and
  // this number with it. 36 is this revision: 35 before, plus
  // `web/vite.config.ts`, which `web/tsconfig.node.json` includes as a bare
  // filename and which the bare-directory expansion could not see.
  assert.match(result.stdout, /traced bundle inputs: 36/);
});

test('a bare filename include is traced as the file it names', (t) => {
  // `web/tsconfig.node.json` declares `"include": ["vite.config.ts"]`. Expanded as
  // if it were a directory, that asks for files under `web/vite.config.ts/`, matches
  // nothing, and the run still says PASS over a traced set that has silently lost an
  // input which changes the deployed bundle. The `web/**` paths entry already covers
  // it, so the fix is visible only as the file appearing in the traced set at all.
  const result = runChecker(t, original);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /covered {3}web\/vite\.config\.ts\b/);
});

test('a bare directory include still matches that directory\'s contents', (t) => {
  // The other half of the same branch, and what `web/tsconfig.json` and the
  // `packages/*/tsconfig.json` projects rely on: a name that is a directory keeps
  // expanding to everything beneath it rather than matching only itself.
  const result = runChecker(t, original);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /covered {3}web\/src\/main\.tsx\b/);
});

test('an ambiguous make target fails instead of guessing', (t) => {
  const mutated = original.replace('npm test --prefix web', 'make dist\n          npm test --prefix web');
  assert.notEqual(mutated, original, 'the insertion point was not found; the fixture would be vacuous');
  const result = runChecker(t, mutated);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ERROR: the workflow runs more than one make target/);
});

test('a bundle import the checker cannot trace is reported next to the result', (t) => {
  // The silent-shrink case, and the one the workflow-level fixtures above cannot
  // reach: it needs a source change, not a workflow change. A tsconfig `paths`
  // alias or a vite alias would make a repository file look like a package, the
  // traced set would silently lose it, and the result line underneath would still
  // say PASS. So this runs the real checker over a synthetic tree, copied to a
  // temp root with the checker beside it, where `web/src` imports a sibling file
  // through a bare specifier that no manifest declares. That is exactly what an
  // alias looks like to the walker.
  const root = mkdtempSync(join(tmpdir(), 'antonina-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'web', 'src'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });

  // The checker derives the repository root from its own location, so copying it
  // into the synthetic tree is what points it there. No production seam needed.
  copyFileSync(checker, join(root, '.github', 'check-web-deploy-triggers.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic', scripts: {} }, null, 2));
  writeFileSync(join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { build: 'tsc -b' } }, null, 2));
  writeFileSync(join(root, 'Makefile'), 'build:\n\tnpm ci --prefix web\n\tnpm run build\n');
  writeFileSync(join(root, 'web', 'index.html'), '<script type="module" src="/src/main.ts"></script>\n');
  writeFileSync(join(root, 'shared', 'real.ts'), 'export const value = 1;\n');
  // The aliased import: `shared` is a directory, not a declared package.
  writeFileSync(join(root, 'web', 'src', 'main.ts'), "import { value } from 'shared/real';\nexport const used = value;\n");

  const via = (contents) => {
    const candidate = join(root, '.github', 'workflows', 'candidate.yml');
    writeFileSync(candidate, contents);
    return spawnSync(process.execPath, [join(root, '.github', 'check-web-deploy-triggers.mjs'), '--workflow', candidate], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
  };

  // Baseline: the aliased import is invisible to the walker, so the file it names
  // is absent from the traced set entirely. This is the shrink, and on its own it
  // is invisible.
  const before = via(original);
  assert.equal(before.status, 0, before.stdout + before.stderr);
  assert.match(before.stdout, /RESULT: PASS \(all 5 traced build inputs are covered\)/);
  assert.doesNotMatch(before.stdout, /shared\/real\.ts/);
  assert.doesNotMatch(before.stdout, /UNCOVERED shared/);

  // The same tree, with a filter entry that would have covered the aliased file
  // had the walker seen it. Because the file is missing from the traced set the
  // entry is reported stale, and the untraceable specifier is named. Together
  // those two say what a bare PASS would not: the filter covers an input this
  // run could not see.
  const widened = original.replace('      - "web/**"\n', '      - "web/**"\n      - "shared/**"\n');
  assert.notEqual(widened, original, 'the insertion point was not found; the fixture would be vacuous');
  const result = via(widened);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WARNING: `shared\/real` imported by web\/src\/main\.ts could not be traced/);
  assert.match(result.stdout, /No manifest in this repository declares it/);
  assert.match(result.stdout, /WARNING: paths entry `shared\/\*\*` matches no traced build input/);
  assert.doesNotMatch(result.stdout, /UNCOVERED shared\/real\.ts/);
  // The warning must sit with the result so a reader cannot take the PASS as
  // coverage while an input of unknown reachability is outstanding.
  const warningAt = result.stdout.indexOf('could not be traced');
  const resultAt = result.stdout.indexOf('RESULT:');
  assert.ok(warningAt !== -1 && resultAt !== -1 && warningAt < resultAt, 'the warning must be reported before the result line');
});

// --- is the bare-checkout gate still wired into the root chain? -------------
// This case is not about the deploy trigger at all. It is here because of where
// it lives, which is the only interesting property it has.
//
// `scripts/root-chain.test.mjs` is the gate that keeps the root `npm test`
// chain runnable on a bare checkout with no browser, no chromedriver and no
// built `web/dist` — the contract board 74 exists to restore. The defect the
// review of that work found is that the gate had no guard on *itself*: deleting
// `&& npm run test:build-identity` from `pkg.scripts.test` makes `npm test` exit
// 0 having silently dropped all 17 of its tests, and nothing in the repository
// noticed, because the only assertion that the gate is in the chain was
// `scripts/deploy-smoke.test.mjs` — a suite the root chain does not run, by
// design, because it needs a browser. The one check that the gate is reachable
// on a bare checkout lived in a suite unreachable on a bare checkout.
//
// So the assertion has to sit in a suite the root chain *does* run, in a
// subsystem the gate does not own. `test:workflow` is in the chain; `.github/`
// is not a directory `scripts/root-chain.mjs` scans. That is the whole reason
// this case is in this file and not in the gate.
//
// A test cannot assert its own reachability: the edit that breaks the gate is
// precisely the edit that stops this file running. So the chain text is also
// pinned here, explicitly, rather than left to be implied.
test('the root npm test chain still runs the bare-checkout gate', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  // The chain text, read from the chain rather than from `scripts.test`. Board
  // issue 123: `npm test` is now `scripts/root-chain-run.mjs`, which executes
  // the chain held in `chain:root-test` and prints a per-step exit-code
  // summary, so that a step failing can no longer stop the steps after it from
  // running. This case must therefore ask the same question of the chain the
  // runner runs — reading `scripts.test` and finding no `npm run` in it at all
  // would be true of a correctly configured tree, and would quietly stop
  // guarding anything the moment the runner was in place.
  const chain = rootChainSource(pkg);

  // This file is the witness, so its own reachability is asserted too. If
  // `test:workflow` is ever dropped from the chain, the case below is
  // unreachable and the guard it provides silently evaporates — the same
  // failure shape as the one this case exists to catch.
  assert.ok(
    chain.includes('npm run test:workflow'),
    `the root \`npm test\` chain does not run \`test:workflow\`, so this file never guards anything: ${chain}`,
  );
  // Which file `test:workflow` runs is not pinned as a string. It is
  // `node --test .github/*.test.mjs` — a glob — and asserting the literal
  // filename inside it would be the very mistake the bare-checkout gate exists
  // to stop: a text match that approves whatever the glob happens to expand to.
  // So the pattern is expanded against the real directory instead.
  const witnesses = pkg.scripts['test:workflow']
    .split(/\s+/)
    // The interpreter is a token too; only patterns can name a file.
    .filter((token) => token !== '' && !token.startsWith('-') && token !== 'node')
    .flatMap((pattern) => {
      const prefix = pattern.replace(/\/?\*[^/]*$/, '');
      if (prefix === '') return [];
      assert.ok(existsSync(join(repoRoot, prefix)), `\`test:workflow\` names ${pattern}, whose directory does not exist`);
      return readdirSync(join(repoRoot, prefix))
        .filter((name) => name.endsWith('.test.mjs'))
        .map((name) => join(prefix, name).split('\\').join('/'));
    });
  assert.ok(
    witnesses.includes('.github/check-web-deploy-triggers.test.mjs'),
    `\`test:workflow\` (${pkg.scripts['test:workflow']}) no longer runs this file, so the reachability `
      + `assertions below would be dead code; it runs ${JSON.stringify(witnesses)}`,
  );

  // The gate's own step, in the chain.
  assert.ok(
    chain.includes('npm run test:build-identity'),
    `the root \`npm test\` chain does not run \`test:build-identity\`, so scripts/root-chain.test.mjs `
      + `is never executed and \`npm test\` is green having stopped running it: ${chain}`,
  );
  assert.ok(
    pkg.scripts['test:build-identity'].includes('scripts/root-chain.test.mjs'),
    '`test:build-identity` does not name scripts/root-chain.test.mjs, so the bare-checkout gate does not run',
  );
  assert.ok(
    existsSync(join(repoRoot, 'scripts', 'root-chain.test.mjs')),
    'scripts/root-chain.test.mjs is missing; the root chain has no expanding bare-checkout gate',
  );
});
