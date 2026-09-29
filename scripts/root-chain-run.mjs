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

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRootTestChain, rootChainSource } from './root-chain.mjs';

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
    log(`root-chain-run: running ${step.name}`);
    const raw = exec(step.name);
    // A step that reports no numeric status — killed by a signal, or an `exec`
    // that does not answer — is a step that did not pass. Normalising here, in
    // the one place a result becomes a record, means no caller can accidentally
    // record an absent exit code and have the run read as green.
    const code = Number.isInteger(raw) ? raw : 1;
    results.push({ name: step.name, code });
    log(`root-chain-run: ${step.name} exited ${code}`);
  }
  return results;
}

/**
 * The human-facing summary. This is the part that makes a skip impossible to
 * miss: every step is listed with its own exit code, so an absent suite shows
 * up as a missing line rather than as nothing.
 */
function summarize(results) {
  const width = results.reduce((max, r) => Math.max(max, r.name.length), 0);
  const lines = ['', 'root-chain-run: summary of every step in the root `npm test` chain', ''];
  for (const { name, code } of results) {
    lines.push(`  ${name.padEnd(width)}  ${code === 0 ? 'pass (0)' : `FAIL (${code})`}`);
  }
  const failed = results.filter((r) => r.code !== 0);
  lines.push('');
  if (failed.length === 0) {
    lines.push(`root-chain-run: all ${results.length} steps ran and all passed.`);
  } else {
    lines.push(
      `root-chain-run: ${failed.length} of ${results.length} steps failed: ${failed.map((r) => `${r.name} (${r.code})`).join(', ')}.`,
    );
    lines.push(
      'root-chain-run: every other step still ran; this chain reports all of its failures at once rather than stopping at the first.',
    );
  }
  return lines.join('\n');
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

  const results = runChain(chain.steps);
  process.stdout.write(`${summarize(results)}\n`);
  // Strictly stricter than `&&`: any failure at all is a non-zero exit.
  return results.some((r) => r.code !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
