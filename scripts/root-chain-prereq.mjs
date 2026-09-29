// The root `npm test` chain's declared prerequisite, and the build state that
// says whether it has been met.
//
// Board issue 124. This is a different defect from board 123, and the
// difference is the whole point of this file. Board 123 was a chain that did not
// run steps it should have run, and the fix was to run every step and report
// every exit code. Board 124 is about a step that was never in the chain at
// all, so no amount of running-and-reporting could see it.
//
// The measured shape, twice, by two independent fronts on fresh worktrees:
//
//   - board 123's front: `npm test` exited 1, red at 5 of 7 steps, with four
//     `ERR_MODULE_NOT_FOUND` errors naming `packages/*/dist` paths and a vitest
//     Startup Error for the web suite. Nothing in the output said a prerequisite
//     had been skipped.
//   - board 112's front: `npm run typecheck` exited 127 with
//     `./web/node_modules/.bin/tsc: not found`, and `pretypecheck` — the step
//     immediately above it — had exited 0, because `pretypecheck` is plain node.
//
// So the reader saw a green step immediately followed by a compiler error, and
// four module-resolution errors naming build output, and the causal thing — an
// unbuilt tree — was nowhere in the output. That is the defect: a red run whose
// real cause is a sequencing error, presented so that it reads as a code
// regression.
//
// There are three things here, and each closes a different way back in:
//
//   1. `resolvePrerequisite` reads the prerequisite out of `package.json` rather
//      than out of a comment, so it is declared data that the runner and the
//      gate read from one place and cannot disagree about.
//
//   2. `inspectBuildState` distinguishes the conditions that are genuinely
//      different. A missing package `dist` directory and a missing generated
//      build-identity module are not the same failure and do not have the same
//      remedy, and a single "the tree is unbuilt" boolean would have hidden the
//      one that actually bit (the toolchain itself, `web/node_modules`, which no
//      amount of typechecking can produce).
//
//   3. The runner runs the prerequisite and reports it *as a prerequisite*, in
//      its own labelled section with its own exit code, and then runs the chain
//      anyway. It does not stop the chain, and it does not make the chain's
//      result depend on the prerequisite passing: see the comment above
//      `runPrerequisite` in `scripts/root-chain-run.mjs`, which is where board
//      123's hard-won property is protected.
//
// Deliberately not done, because each of them converts a loud failure into a
// quiet one: a `pretest` script (npm aborts before `test` when `pretest` fails,
// so the chain would report zero of its steps — board 123's defect wearing a
// different hat), and making a missing `dist` a hard error in the runner (a
// caller who has just had `npm run typecheck` fail for a *type* reason must
// still get all seven step results, or one compile error erases the tail again).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This repository's root, used only to read this repository's own tooling. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The package.json script that declares what the root `npm test` chain requires
 * before it can be run. A separate key from `chain:root-test` on purpose: that
 * key is the contract for *which suites are guarded*, and a prerequisite is not
 * a suite. Collapsing the two would make `npm test` typecheck, and would make
 * `scripts/root-chain.test.mjs`'s pinned seven-step list mean "seven test
 * suites plus a compile".
 */
export const PREREQ_SCRIPT = 'prereq:root-test';

/**
 * The `tsc` the toolchain steps shell out to. It is reached by a relative path
 * in `package.json`, not through Node resolution, so a worktree that resolves
 * `node_modules` some other way still needs this exact file to exist — which is
 * why its absence is its own condition and not a synonym for "unbuilt".
 */
export const TOOLCHAIN_ENTRIES = ['web/node_modules/.bin/tsc'];

/**
 * One compiled `dist` per TypeScript package, as `tsc -p <pkg>/tsconfig.json`
 * leaves it. `tsconfig.json` sets `rootDir: ../..` for three of the four
 * packages, so the emitted entry point is under `dist/packages/<pkg>/src/`; the
 * directory's existence is what is checked here, not its layout, because a
 * package that compiled to nothing would be a `tsc` failure and is reported as
 * one.
 */
export const BUILD_OUTPUT_DIRS = [
  'packages/core/dist',
  'packages/agent-runtime/dist',
  'packages/host-daemon/dist',
  'packages/cli/dist',
];

/**
 * The modules `scripts/build-identity.mjs` generates, named by that script
 * rather than duplicated here, so this list cannot drift from the one the
 * generator writes. They are the artifacts `pretypecheck` produces, which is
 * exactly why they are checked separately: their absence means the *generator*
 * has not run, which a caller can fix without a compiler.
 *
 * Read from this repository's own generator, never from the tree being
 * inspected. The set of generated modules is a property of the *tooling*; a
 * tree that has not been built at all has no `scripts/build-identity.mjs` to ask,
 * and asking it anyway would make the check for a fresh worktree crash on the
 * very case it exists to describe.
 */
export function generatedModules() {
  const identity = readFileSync(join(REPO_ROOT, 'scripts', 'build-identity.mjs'), 'utf8');
  const modules = [...identity.matchAll(/^export const \w+_GENERATED_MODULE = '([^']+)';$/gm)]
    .map((match) => match[1]);
  if (modules.length === 0) {
    throw new Error(
      'root-chain-prereq: scripts/build-identity.mjs no longer declares any *_GENERATED_MODULE '
      + 'as a single-quoted string, so the generated build-identity modules this file checks for '
      + 'cannot be named. Update this module rather than dropping the check.',
    );
  }
  return modules;
}

/**
 * The script `npm test` declares it must run first, with the command it will
 * run, or `null` when the tree declares none.
 *
 * A tree with no declared prerequisite is a broken tree, not a tree with no
 * prerequisite, so `scripts/root-chain.test.mjs` asserts that the real
 * `package.json` declares one rather than letting `null` mean "nothing needed".
 */
export function resolvePrerequisite(repoRoot, pkg = readPackage(repoRoot)) {
  const name = pkg.scripts?.[PREREQ_SCRIPT];
  if (typeof name !== 'string' || name.trim() === '') return null;
  const command = pkg.scripts?.[name];
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error(
      `root-chain-prereq: \`${PREREQ_SCRIPT}\` names \`${name}\`, which \`package.json\` does not define. `
      + 'The chain would run a prerequisite that does not exist, which is a worse version of the '
      + 'defect this module exists to remove.',
    );
  }
  return { name, command };
}

function readPackage(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
}

/**
 * What is missing from the working tree, split by the condition that causes it.
 *
 * The three kinds are kept apart because they have three different remedies and
 * a reader who is told "the tree is unbuilt" is told nothing they can act on:
 *
 *   - `toolchain`: `web/node_modules` has not been provisioned. `npm run
 *     typecheck` cannot help, because the command it would run does not exist.
 *     The remedy is `npm run bootstrap`.
 *   - `generated-module`: the build-identity modules are absent, so
 *     `pretypecheck` has not run. The remedy is `npm run generate:build-identity`,
 *     which needs no compiler and no `dist`.
 *   - `build-output`: a package `dist` is absent, so `tsc` has not emitted.
 *     The remedy is `npm run typecheck`.
 *
 * A missing package directory and a missing generated module are different
 * conditions and both are reported: a fresh worktree has all three, and
 * reporting only the first would send the reader to run a typecheck that then
 * fails at exit 127 with no explanation.
 *
 * @returns {{
 *   ok: boolean,
 *   missing: Array<{ kind: 'toolchain' | 'generated-module' | 'build-output', remedy: string, entries: string[] }>,
 * }}
 */
export function inspectBuildState(repoRoot, { modules = generatedModules() } = {}) {
  const conditions = [
    { kind: 'toolchain', remedy: 'npm run bootstrap', entries: TOOLCHAIN_ENTRIES },
    { kind: 'generated-module', remedy: 'npm run generate:build-identity', entries: modules },
    { kind: 'build-output', remedy: 'npm run typecheck', entries: BUILD_OUTPUT_DIRS },
  ];
  const missing = [];
  for (const condition of conditions) {
    const absent = condition.entries.filter((entry) => !existsSync(join(repoRoot, entry)));
    if (absent.length > 0) missing.push({ ...condition, entries: absent });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The preflight notice: what is missing, and the one command that produces it.
 *
 * This is diagnostic text and nothing more. It is written before the chain runs
 * and it changes nothing about what runs or what exit code comes out, because a
 * notice that altered the run would be a guard, and a guard that stopped the
 * chain is board 123's defect again.
 */
export function formatPrereqNotice({ prereq, state }) {
  if (state.ok) return null;
  const lines = [
    '',
    'root-chain-run: MISSING PREREQUISITE — this working tree has not been built,',
    'so failures from here on are about the tree, not about the code under test.',
  ];
  if (prereq) {
    lines.push(`root-chain-run: the root \`npm test\` chain declares \`${PREREQ_SCRIPT}: ${prereq.name}\`.`);
  }
  for (const condition of state.missing) {
    lines.push(`root-chain-run:   ${condition.kind}: missing ${condition.entries.join(', ')} — run \`${condition.remedy}\``);
  }
  lines.push(
    'root-chain-run: every chain step will still run and report its own exit code; the steps below',
  );
  lines.push(
    'root-chain-run: are NOT evidence of a code regression until the prerequisite above is met.',
  );
  lines.push('');
  return lines.join('\n');
}
