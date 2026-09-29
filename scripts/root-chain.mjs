// What the root `npm test` chain actually runs, resolved rather than guessed.
//
// Board issue 74 follow-up. The root chain is written as a sequence of
// `npm run <script>` steps, and those steps are `node --test <pattern>` with a
// *glob* for a pattern. The defect this module exists to prevent is that
// reading the chain's text says nothing about the files it expands to: a glob
// over `scripts/` looks browser-free in a string match and stops being
// browser-free the moment a browser-requiring suite is added to that directory
// (which is exactly what board 74's merge did, taking the root chain from 10
// tests to 37, 27 of which need a real browser, a matching chromedriver and a
// built `web/dist`).
//
// So nothing here parses commands as text to decide what they mean. It walks
// the chain, follows each `npm run` to its own command, takes the file
// patterns out of each `node --test` step, and expands them against the real
// working tree with `readdir`. The answer is a set of paths on disk.
//
// The companion half is `declaredTestNeeds`: a suite that needs a browser, a
// driver or a built bundle says so in a marker comment in its own header, and
// this module reads that marker off the file. A suite that is pulled into the
// root chain and declares a need it cannot meet there fails, whether it got
// there by a glob, by a rename, or by someone appending it by name.
//
// One honest limit, which the `unresolved` return is what makes visible: the
// `node --test` steps are the ones this module can resolve to files. A
// package-local runner step — `npm test --prefix web` — runs a file set that is
// not derivable from here, so this module reports the step as unresolved rather
// than claiming its files are browser-free. `scripts/root-chain.test.mjs`
// enumerates the `web/` set itself and holds it to the same rule, so the limit
// is covered rather than merely disclosed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * The marker a test file uses to declare a precondition it cannot meet on a
 * bare checkout. Kept as an exact, greppable token rather than prose so a file
 * cannot satisfy it by accident.
 */
export const TEST_NEEDS_MARKER = 'antonina-test-needs';

/**
 * Needs that make a suite unfit for the root chain: the root chain is
 * contractually runnable with no browser, no chromedriver and no built
 * `web/dist`.
 */
export const HOST_PRECONDITION_NEEDS = ['browser', 'chromedriver', 'built-web-bundle'];

/**
 * The npm script that holds the root chain, as a list of steps. It is a
 * separate script from `test` so that `scripts/root-chain-run.mjs` and
 * `resolveRootTestChain` read the *same* list: the runner executes it and the
 * gate asserts properties of it, so a second copy of the chain cannot drift
 * from the first and quietly become the one that runs.
 */
export const CHAIN_SCRIPT = 'chain:root-test';

/**
 * The `npm test` entry point. The chain is executed by a runner that reports
 * every step, not by the shell's `&&`. See `scripts/root-chain-run.mjs`.
 */
export const CHAIN_RUNNER = 'scripts/root-chain-run.mjs';

/**
 * The root chain, as a string of `&&`-joined steps.
 *
 * Falls back to `scripts.test` for a tree that has not adopted the runner yet,
 * so the gate can still resolve a chain rather than crashing on a missing
 * script. `scripts/root-chain.test.mjs` asserts that the fallback is not what
 * a checked-in tree actually uses.
 */
export function rootChainSource(pkg) {
  const chain = pkg.scripts?.[CHAIN_SCRIPT];
  if (typeof chain === 'string' && chain.trim() !== '') return chain;
  return pkg.scripts.test;
}

/**
 * A `npm run <name>` step of a chain command.
 */
const NPM_RUN = /^npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/;

/**
 * A `node --test [flags] <pattern>...` step, capturing only the non-flag
 * arguments, which are the file patterns. Long flags (`--test-name-pattern=x`)
 * and the `--` separator are handled so a future flag cannot silently be
 * mistaken for a path.
 */
const NODE_TEST = /^node\s+--test\b\s*(.*)$/;

/**
 * Expand one glob segment against the filesystem. Only the trailing `*` form
 * the repository actually uses is supported, and an unsupported pattern is an
 * error rather than a silent empty result: a guard that quietly resolves an
 * unrecognised glob to "no files" is the same class of bug as one that
 * string-matches a command.
 */
function expandPattern(repoRoot, pattern) {
  if (!pattern.includes('*')) return [resolve(repoRoot, pattern)];
  const segments = pattern.split('/');
  const last = segments[segments.length - 1];
  if (last !== '*.test.mjs') {
    throw new Error(`root-chain: unsupported glob pattern ${JSON.stringify(pattern)}`);
  }
  const dir = resolve(repoRoot, ...segments.slice(0, -1));
  const entries = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'));
  return entries.map((name) => join(dir, name)).sort();
}

/**
 * Every file the root `npm test` chain runs, as absolute paths, plus the steps
 * that could not be resolved to `node --test` file patterns.
 *
 * `unresolved` is reported rather than ignored. `npm test --prefix web` runs a
 * package-local runner whose file set this module cannot see, so a claim that
 * the chain is browser-free has to be a claim about the steps that are
 * resolvable plus an explicit note about the ones that are not.
 */
export function resolveRootTestChain(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const files = new Set();
  const unresolved = [];
  const seenScripts = new Set();
  const steps = [];

  const walk = (command, via) => {
    for (const rawStep of command.split('&&')) {
      const step = rawStep.trim();
      if (step === '') continue;
      const npmRun = NPM_RUN.exec(step);
      if (npmRun) {
        const name = npmRun[1];
        const target = pkg.scripts?.[name];
        if (target === undefined) {
          unresolved.push({ via, step, reason: `no such script: ${name}` });
          continue;
        }
        // A cycle would otherwise recurse forever; report it instead.
        if (seenScripts.has(name)) {
          unresolved.push({ via, step, reason: `script cycle at ${name}` });
          continue;
        }
        seenScripts.add(name);
        // Recorded as a top-level step of the chain even though it is walked
        // into, so the runner and this gate agree on which `npm run` invocations
        // the chain performs, in order, without either re-parsing the text.
        steps.push({ name, command: target });
        walk(target, name);
        continue;
      }
      const nodeTest = NODE_TEST.exec(step);
      if (nodeTest) {
        const patterns = nodeTest[1]
          .split(/\s+/)
          .filter((token) => token !== '' && token !== '--' && !token.startsWith('--'));
        if (patterns.length === 0) {
          unresolved.push({ via, step, reason: 'node --test step with no file pattern' });
          continue;
        }
        for (const pattern of patterns) {
          for (const file of expandPattern(repoRoot, pattern)) {
            if (!statSync(file).isFile()) {
              throw new Error(`root-chain: pattern ${JSON.stringify(pattern)} did not resolve to a file`);
            }
            files.add(file);
          }
        }
        continue;
      }
      unresolved.push({ via, step, reason: 'not an npm run or node --test step' });
    }
  };

  walk(rootChainSource(pkg), 'test');
  return {
    files: [...files].sort(),
    relative: [...files].map((file) => file.slice(repoRoot.length + 1).split(sep).join('/')).sort(),
    unresolved,
    steps,
  };
}

/**
 * The needs a test file declares in its own header, lowercased and split, or
 * `[]` if it declares none. Only marker lines are read, so the word "browser"
 * appearing in an assertion message cannot make a pure-Node suite look like it
 * needs a browser.
 */
export function declaredTestNeeds(file) {
  const source = readFileSync(file, 'utf8');
  const needs = [];
  for (const line of source.split('\n')) {
    const match = new RegExp(`^\\s*//\\s*${TEST_NEEDS_MARKER}\\s*:\\s*(.+)$`).exec(line);
    if (!match) continue;
    for (const need of match[1].split(',')) {
      const trimmed = need.trim().toLowerCase();
      if (trimmed !== '') needs.push(trimmed);
    }
  }
  return needs;
}

/**
 * The host preconditions a file declares, i.e. the needs that disqualify it
 * from the root chain.
 */
export function declaredHostPreconditions(file) {
  return declaredTestNeeds(file).filter((need) => HOST_PRECONDITION_NEEDS.includes(need));
}
