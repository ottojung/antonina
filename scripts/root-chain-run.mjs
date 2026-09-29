#!/usr/bin/env node
// The root `npm test` chain, executed so that a short-circuit is visible.
//
// Board issue 123. The defect this file exists to prevent is not a failing
// test; it is a failing test that *hides the suites after it*.
//
// The chain is a sequence of `npm run <script>` steps, and the shell's `&&`
// stops at the first non-zero exit. When `test:web` failed, `test:workflow` and
// `test:build-identity` never ran, produced no output, and left no artifact. The
// run's exit code was 1, so the run was red — but a reader of the log saw five
// green suites and a red one, and the two absent suites were indistinguishable
// from two suites that do not exist. The tail was *silently skipped*, which is
// worse than a red test: a red test tells you where to look, and a skipped tail
// tells you nothing at all.
//
// So the chain is no longer evaluated by the shell. It is run here, step by
// step, and every step is accounted for:
//
//   - every step is *executed*, and its real exit code is recorded and printed,
//     so no step's silence can be mistaken for its success;
//   - a step that fails does not prevent the steps after it from running, so a
//     break anywhere in the chain cannot erase the tail;
//   - the run's exit code is non-zero if *any* step failed, and the summary
//     names every step that did, so a broken chain reports all of its breakage
//     at once instead of one failure per run.
//
// This does not tolerate failure and does not weaken the gate. It is strictly
// stricter than `&&`: `&&` exits non-zero if any step fails *and* stops at the
// first one; this exits non-zero if any step fails and reports all of them. The
// difference is only that the tail is now observed rather than skipped.
//
// Deliberately not done here, because each converts a loud failure into a quiet
// one and is the opposite of the point: removing a suite from the chain,
// marking one `skip`, relaxing `test.environment` from `jsdom` to `node`, or
// deleting `dom-environment.test.tsx`.
//
// The chain itself is read from `scripts/root-chain.mjs`, the same module
// `scripts/root-chain.test.mjs` asserts against, so the list that runs and the
// list that is guarded cannot be two different lists.
//
// This is the executable half of the issue 123 visibility mechanism. The
// asserted half is `scripts/root-chain.test.mjs`, which is itself a step of the
// chain: the gate cannot be trusted if the thing that can break the chain can
// also stop the gate from running, and the tail running under this runner is
// what guarantees the gate always gets its turn.
//
// ---------------------------------------------------------------------------
// Board issue 124: the prerequisite the chain had, and did not name.
//
// Everything above is board 123. This runner could report every step perfectly
// and still leave a caller staring at four `ERR_MODULE_NOT_FOUND` errors naming
// `packages/*/dist`, because the step those suites actually needed was never in
// the chain to be reported. See `scripts/root-chain-prereq.mjs` for the
// measurements; the shape of the fix is here.
//
// The rule that governs this section, and the one that is easiest to break by
// accident:
//
//   the prerequisite is run and reported, and it NEVER stops the chain.
//
// Not "unless it failed". Not "unless the tree is unbuilt". A `pretest` script
// would be the obvious way to declare this and it is exactly wrong: npm aborts
// before running `test` when `pretest` fails, so a compile error would produce
// a run that reports *zero* of its seven steps. That is board 123's defect —
// suites that never ran, indistinguishable from suites that do not exist —
// reintroduced through the front door by a well-meant fix. So the prerequisite
// gets its own section, its own exit code, and the chain runs regardless.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRootTestChain, rootChainSource } from './root-chain.mjs';
import { formatPrereqNotice, inspectBuildState, resolvePrerequisite } from './root-chain-prereq.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run one chain step and resolve to its exit code.
 *
 * A step that cannot be spawned at all is reported as a failure of that step,
 * not as an unhandled rejection that would take the whole runner down before
 * the remaining steps have run — which is the very skip this file prevents.
 */
function runStep(name) {
  const result = spawnSync('npm', ['run', name], {
    cwd: repoRoot,
    stdio: 'inherit',
    // The suites own their own temp state; the runner does not invent one, so
    // what the suites see is exactly what a developer running them by hand
    // would give them.
    shell: false,
  });
  if (result.error) {
    process.stderr.write(`\nroot-chain-run: \`npm run ${name}\` could not be started: ${result.error.message}\n`);
    return 1;
  }
  // A step killed by a signal reports `signal` and a null status. That is a
  // failure of the step, and it is counted as one rather than as a pass.
  if (result.signal) return 1;
  return result.status ?? 1;
}

/**
 * Execute every step of the root chain and report each one.
 *
 * Exported for `scripts/root-chain.test.mjs`, which runs this against a
 * synthetic chain to observe the failure behaviour without needing a broken
 * suite in the real tree. A mechanism nobody has seen fail is not a mechanism
 * that is known to work.
 */
export function runChain(steps, { exec = runStep, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const results = [];
  for (const step of steps) {
    // `label` is the display name; it differs from `name` only for the
    // prerequisite, whose log line must not read as another test suite.
    const label = step.label ?? step.name;
    log(`root-chain-run: running ${label}`);
    const raw = exec(step.name);
    // A step that reports no numeric status — killed by a signal, or an `exec`
    // that does not answer — is a step that did not pass. Normalising here, in
    // the one place a result becomes a record, means no caller can accidentally
    // record an absent exit code and have the run read as green.
    const code = Number.isInteger(raw) ? raw : 1;
    results.push({ name: label, code });
    log(`root-chain-run: ${label} exited ${code}`);
  }
  return results;
}

/**
 * The human-facing summary. This is the part that makes a skip impossible to
 * miss: every step is listed with its own exit code, so an absent suite shows
 * up as a missing line rather than as nothing.
 *
 * Takes groups rather than one list, so the declared prerequisite is printed
 * under its own heading as a prerequisite. Collapsing it into the step list
 * would put a failed `typecheck` in the middle of the test results, where it
 * reads as a failing suite — the same misattribution as the original defect,
 * one level up.
 *
 * Exported so `scripts/root-chain.test.mjs` can read the rendered text, which is
 * what a caller actually reads. Asserting on the runner's source instead would
 * pass against a summary that is never reached.
 */
export function summarize(groups) {
  const width = groups
    .flatMap((group) => group.results)
    .reduce((max, r) => Math.max(max, r.name.length), 0);
  const lines = ['', 'root-chain-run: summary of every step in the root `npm test` chain', ''];
  const failed = [];
  for (const group of groups) {
    if (group.results.length === 0) continue;
    lines.push(`  ${group.title}:`);
    for (const { name, code } of group.results) {
      lines.push(`    ${name.padEnd(width)}  ${code === 0 ? 'pass (0)' : `FAIL (${code})`}`);
      if (code !== 0) failed.push({ ...group, name, code });
    }
    lines.push('');
  }
  if (failed.length === 0) {
    const steps = groups.flatMap((group) => group.results).length;
    lines.push(`root-chain-run: all ${steps} steps ran and all passed.`);
    return lines.join('\n');
  }
  lines.push(
    `root-chain-run: ${failed.length} step(s) failed: ${failed.map((r) => `${r.name} (${r.code})`).join(', ')}.`,
  );
  lines.push(
    'root-chain-run: every other step still ran; this chain reports all of its failures at once rather than stopping at the first.',
  );
  for (const group of failed) {
    if (!group.blocks) continue;
    lines.push(
      `root-chain-run: NOTE \`${group.name}\` is the chain's declared prerequisite, not a test suite. `
      + 'Every step below it ran anyway and its own exit code is the only thing that says anything about the code under test.',
    );
  }
  return lines.join('\n');
}

/**
 * Run the declared prerequisite and then the chain, as reporting groups.
 *
 * The single most important property of this function is that the chain runs
 * unconditionally. It is here, as its own exported unit, rather than inlined in
 * `main`, so `scripts/root-chain.test.mjs` can watch it happen: a mechanism
 * whose central promise is "this cannot skip anything" should be the easiest
 * thing in the file to test, not the hardest.
 *
 * @param {{ name: string, command: string } | null} prereq
 * @param {Array<{ name: string }>} steps
 * @returns {Array<{ title: string, results: Array<{ name: string, code: number }>, blocks: boolean }>}
 */
export function runWithPrerequisite(prereq, steps, options = {}) {
  const groups = [];
  if (prereq !== null) {
    groups.push({
      title: `declared prerequisite (npm run ${prereq.name})`,
      results: runChain(
        [{ name: prereq.name, label: `${prereq.name} (declared prerequisite)` }],
        options,
      ),
      blocks: true,
    });
  }
  // Unconditional, and deliberately not inside the `if` above. A prerequisite
  // that fails does not skip, reorder, or excuse a step.
  groups.push({ title: 'root chain steps', results: runChain(steps, options) });
  return groups;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const chain = resolveRootTestChain(repoRoot);

  // A step the resolver could not expand is still executed — `npm test --prefix
  // web` is one, and it is runnable. The count is checked against the source so
  // that a step silently dropped from the parse cannot quietly drop from the
  // run: the chain's own `npm run` steps are the contract, and this is where a
  // chain that runs fewer steps than it names is caught.
  const named = (rootChainSource(pkg).match(/npm\s+run\s+[A-Za-z0-9:_-]+/g) ?? []).length;
  if (chain.steps.length !== named) {
    process.stderr.write(
      `root-chain-run: the chain names ${named} \`npm run\` steps but the resolver found ${chain.steps.length}. `
      + 'The chain and the resolver disagree, so the chain cannot be run faithfully.\n',
    );
    return 1;
  }

  // The prerequisite is read from `package.json`, not from a comment, and it is
  // run through the same `runChain` machinery as the chain so that it cannot
  // acquire a second, laxer execution path.
  //
  // Deliberately not wrapped in a try/catch. A `prereq:root-test` naming a
  // script that does not exist is a broken committed file, not a caller's
  // sequencing mistake, and `scripts/root-chain.test.mjs` pins the correct
  // configuration. Catching it here would mean choosing between a stack trace
  // and a chain that runs on a declaration nobody could honour; the stack trace
  // is the honest one.
  const prereq = resolvePrerequisite(repoRoot, pkg);

  // Diagnostics only. This writes text and changes nothing about what runs or
  // what exit code comes out: a notice that altered the run would be a guard,
  // and a guard that stopped the chain would be board 123's defect.
  const notice = formatPrereqNotice({ prereq, state: inspectBuildState(repoRoot) });
  if (notice !== null) process.stderr.write(`${notice}\n`);

  const groups = runWithPrerequisite(prereq, chain.steps);
  process.stdout.write(`${summarize(groups)}\n`);
  // Strictly stricter than `&&`: any failure at all is a non-zero exit, and a
  // failed prerequisite is a failure of the run even though it stopped no step.
  return groups.flatMap((group) => group.results).some((r) => r.code !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
