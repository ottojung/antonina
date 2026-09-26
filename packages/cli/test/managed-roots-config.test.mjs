import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { describeRootsDefect } from '../dist/packages/cli/src/collection.js';
import {
  MANAGED_ROOTS_ENV,
  loadManagedRoots,
} from '../dist/packages/agent-runtime/src/managed-roots-config.js';

// What this suite owns: `describeRootsDefect`, the operator-facing rendering of a
// refused root set, and nothing else. Every case is driven from a defect the
// canonical loader actually produced -- the loader is
// `packages/agent-runtime/src/managed-roots-config.js` and is imported from
// there, so the defects here are the loader's real verdicts rather than
// hand-built ones. What the loader *decides* -- which spellings it accepts, what
// it refuses, and in what order -- is asserted by the suite that owns it,
// `packages/agent-runtime/test/managed-roots-config.test.mjs`; nothing here pins
// that, so a loader change cannot be caught here and a loader test does not have
// to be coupled to the CLI build.
//
// Every case owns its tree and its own `XDG_STATE_HOME`, and reaps both before
// returning -- nothing here reads or mutates ambient Antonina state. Nothing
// spawns a process, so nothing needs reaping beyond the trees.
async function withTree(body) {
  const root = await mkdtemp(join(tmpdir(), 'antonina-collect-roots-'));
  const stateHome = join(root, 'state');
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    await body({ root, stateHome });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const load = (env) => loadManagedRoots(env, MANAGED_ROOTS_ENV);

test('an unset or separator-only variable is rendered as its own refusal, naming the variable', async () => {
  await withTree(async () => {
    for (const env of [{}, { [MANAGED_ROOTS_ENV]: '' }, { [MANAGED_ROOTS_ENV]: '  :  : ' }]) {
      const line = describeRootsDefect(await load(env));

      // The leading word is the kind the loader refused on, so an operator who
      // never configured anything is not told the same thing as an operator whose
      // roots were refused for a reason they can act on. The sentence also has to
      // stay actionable: it names the variable to set, the separator to use, and
      // what the entries have to be.
      assert.equal(line, 'roots-not-configured: no managed collection roots are configured in '
        + 'ANTONINA_COLLECT_ROOTS; set it to a ":"-separated list of absolute directories '
        + 'the collector may remove from');
    }
  });
});

test('the refusal line names the variable it was given, not a hard-coded one', async () => {
  await withTree(async () => {
    // `loadManagedRoots` takes the name as an argument, and the rendering reads
    // the defect's own `variable` field, so a caller supplying a different name
    // gets a line about its own name rather than a stale one.
    const line = describeRootsDefect(await loadManagedRoots({}, 'ANTONINA_OTHER_ROOTS'));

    assert.match(line, /^roots-not-configured: /);
    assert.match(line, /ANTONINA_OTHER_ROOTS/);
    assert.equal(line.includes('ANTONINA_COLLECT_ROOTS'), false, JSON.stringify(line));
  });
});

test('a non-canonical root is rendered with core\'s own path-form wording', async () => {
  await withTree(async () => {
    for (const [spelling, defect] of [
      ['relative/root', 'relative'],
      ['/workspace/../etc', 'parent-traversal'],
    ]) {
      const line = describeRootsDefect(await load({ [MANAGED_ROOTS_ENV]: spelling }));

      // The kind first, then the offending entry, then the judgment's own field:
      // the operator is told which spelling and which rule, not just that
      // something was malformed.
      assert.equal(line, `path-form: configured managed root ${spelling} is not a canonical absolute POSIX path (${defect})`);
    }
  });
});

test('a duplicated root is rendered against the spelling that appears twice', async () => {
  await withTree(async ({ root }) => {
    const one = join(root, 'one');
    const two = join(root, 'two');
    await mkdir(one);
    await mkdir(two);

    const line = describeRootsDefect(await load({ [MANAGED_ROOTS_ENV]: `${one}:${two}:${one}` }));

    assert.equal(line, `duplicate: configured managed root ${one} is listed twice`);
  });
});

test('a nested root is rendered with both of the roots that nest', async () => {
  await withTree(async ({ root }) => {
    const outer = join(root, 'outer');
    const inner = join(outer, 'inner');
    await mkdir(inner, { recursive: true });

    const line = describeRootsDefect(await load({ [MANAGED_ROOTS_ENV]: `${outer}:${inner}` }));

    // Both coordinates are named, because "one of your roots is inside another
    // one" is not actionable until the operator can see which two.
    assert.equal(line, `nested: configured managed root ${inner} is inside configured managed root ${outer}`);
  });
});

test('the two filesystem-root refusals render as two different sentences', async () => {
  await withTree(async ({ root }) => {
    const spelling = await load({ [MANAGED_ROOTS_ENV]: '/' });
    assert.equal(
      describeRootsDefect(spelling),
      'root-is-filesystem-root: configured managed root / is the filesystem root; '
        + 'it would make every absolute path collectible',
    );

    // One hop from the refused spelling: an ordinary-looking directory whose
    // resolved coordinate is `/`, which is what `isWithin` special-cases into
    // vacuous containment. The two are separate operator mistakes, so the lines
    // say different things -- the resolved one names the resolved coordinate.
    const worklink = join(root, 'worklink');
    await symlink('/', worklink);
    const resolved = await load({ [MANAGED_ROOTS_ENV]: worklink });
    assert.equal(
      describeRootsDefect(resolved),
      `root-resolves-to-filesystem-root: configured managed root ${worklink} resolves to the `
        + 'filesystem root /; it would make every absolute path collectible',
    );
    assert.equal(
      describeRootsDefect(resolved).includes('root-is-filesystem-root:'),
      false,
      'the two mistakes read differently',
    );
  });
});

test('a root reached through a chain of symlinks that ends at the filesystem root is refused', async () => {
  await withTree(async ({ root }) => {
    // Two hops, because a refusal proved for one hop is not a refusal proved for
    // a chain: every hop is followed before the resolved coordinate exists, so
    // the resolved `/` here is the product of two resolutions and not one.
    const first = join(root, 'first');
    const second = join(root, 'second');
    await symlink('/', first);
    await symlink(first, second);

    const result = await load({ [MANAGED_ROOTS_ENV]: second });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(result.defect, {
      kind: 'root-resolves-to-filesystem-root',
      path: second,
      resolved: '/',
    });
    assert.equal(result.spelling, second);
    assert.match(describeRootsDefect(result), /resolves to the filesystem root \//);
  });
});

test('the filesystem root spelled with a trailing slash is refused as a path form', async () => {
  await withTree(async () => {
    // `//` is the same directory as `/`, so if a trailing slash were accepted
    // this spelling would be a second way to say the refused root. It is refused
    // earlier, as a non-canonical spelling, and that is the more honest answer:
    // the spelling is not one this loader accepts at all.
    const result = await load({ [MANAGED_ROOTS_ENV]: '//' });

    assert.equal(result.ok, false);
    assert.equal(result.spelling, '//');
    assert.equal(result.defect.kind, 'path-form');
    assert.match(describeRootsDefect(result), /canonical absolute POSIX path/);
  });
});

test('an unresolvable root is rendered with the loader\'s own message', async () => {
  await withTree(async ({ root }) => {
    const good = join(root, 'good');
    await mkdir(good);
    const missing = join(root, 'missing');

    const line = describeRootsDefect(await load({ [MANAGED_ROOTS_ENV]: `${good}:${missing}` }));

    // The loader's message is passed through verbatim rather than summarised,
    // because it is the one that carries the spelling the refusal is against and
    // the filesystem's own reason.
    assert.match(line, /^unresolvable-root: /);
    assert.match(line, new RegExp(`configured managed root ${missing.replace(/\//g, '\\/')} cannot be resolved: `));
  });
});
