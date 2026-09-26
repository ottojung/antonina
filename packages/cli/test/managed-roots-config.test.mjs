import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COLLECT_ROOTS_ENV,
  describeRootsDefect,
  loadManagedRoots,
} from '../dist/packages/cli/src/collection.js';
import { evaluateManagedCandidate } from '../dist/packages/core/src/managed-roots.js';

// The loader is the CLI's only route to a branded `ManagedRoots`, so these cases
// drive it exactly as the command does: spellings in, either core's own result
// or a defect, out. Every case owns its tree and its own `XDG_STATE_HOME`, and
// reaps both before returning -- nothing here reads or mutates ambient Antonina
// state. Nothing spawns a process, so nothing needs reaping beyond the trees.
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

const load = (env) => loadManagedRoots(env, COLLECT_ROOTS_ENV);

test('no configured roots is reported as the empty defect, not as a usable set', async () => {
  await withTree(async () => {
    for (const env of [{}, { [COLLECT_ROOTS_ENV]: '' }, { [COLLECT_ROOTS_ENV]: '  :  : ' }]) {
      const result = await load(env);
      assert.equal(result.ok, false, JSON.stringify(env));
      assert.deepEqual(result.defect, { kind: 'empty' });
      assert.equal(result.spelling, null);
      assert.match(describeRootsDefect(result), /ANTONINA_COLLECT_ROOTS/);
    }
  });
});

test('a single spelled root resolves and validates without a brand cast', async () => {
  await withTree(async ({ root }) => {
    const spelling = join(root, 'work');
    await mkdir(spelling);

    const result = await load({ [COLLECT_ROOTS_ENV]: spelling });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.roots.roots, [{ spelled: spelling, resolved: spelling }]);
    // A genuine branded value, not a look-alike: it reaches the judgment.
    const judged = evaluateManagedCandidate(result.roots, {
      path: `${spelling}/project`,
      resolvedPath: `${spelling}/project`,
      finalComponentIsSymlink: false,
      parentResolvedPath: spelling,
    });
    assert.equal(judged.eligible, true, JSON.stringify(judged));
  });
});

test('a root that is a symlink resolves to its target and still validates', async () => {
  await withTree(async ({ root }) => {
    const target = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(target);
    await symlink(target, link);

    const result = await load({ [COLLECT_ROOTS_ENV]: link });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.roots.roots, [{ spelled: link, resolved: target }]);
  });
});

test('a duplicate spelled root is refused with the duplicate defect and the path', async () => {
  await withTree(async ({ root }) => {
    const one = join(root, 'one');
    const two = join(root, 'two');
    await mkdir(one);
    await mkdir(two);

    const result = await load({ [COLLECT_ROOTS_ENV]: `${one}:${two}:${one}` });

    assert.equal(result.ok, false);
    assert.deepEqual(result.defect, { kind: 'duplicate', path: one });
    assert.equal(result.spelling, one);
    assert.match(describeRootsDefect(result), new RegExp(`listed twice`));
  });
});

test('a root nested inside another is refused with path and within', async () => {
  await withTree(async ({ root }) => {
    const outer = join(root, 'outer');
    const inner = join(outer, 'inner');
    await mkdir(inner, { recursive: true });

    const result = await load({ [COLLECT_ROOTS_ENV]: `${outer}:${inner}` });

    assert.equal(result.ok, false);
    assert.deepEqual(result.defect, { kind: 'nested', path: inner, within: outer });
    assert.equal(result.spelling, inner);
  });
});

test('a pair that nests only in resolved coordinates is still refused', async () => {
  await withTree(async ({ root }) => {
    // Two spellings side by side, neither inside the other...
    const left = join(root, 'left');
    const right = join(root, 'right');
    await mkdir(left);
    await mkdir(right);
    // ...but the second is a symlink whose target is inside the first, so the
    // pair nests once resolved even though the spellings do not.
    const nested = join(left, 'nested');
    await mkdir(nested);
    const link = join(right, 'into-left');
    await symlink(nested, link);

    const result = await load({ [COLLECT_ROOTS_ENV]: `${left}:${link}` });

    assert.equal(result.ok, false);
    assert.deepEqual(result.defect, { kind: 'nested', path: link, within: left });
  });
});

test('a relative or parent-traversing root is refused with its path-form defect', async () => {
  await withTree(async ({ root }) => {
    const real = join(root, 'real');
    await mkdir(real);

    const relative = await load({ [COLLECT_ROOTS_ENV]: 'relative/root' });
    assert.equal(relative.ok, false);
    assert.deepEqual(relative.defect, { kind: 'path-form', path: 'relative/root', defect: 'relative' });
    assert.equal(relative.spelling, 'relative/root');
    assert.match(describeRootsDefect(relative), /canonical absolute POSIX path/);

    const traversal = await load({ [COLLECT_ROOTS_ENV]: `${root}/../elsewhere` });
    assert.equal(traversal.ok, false);
    assert.equal(traversal.defect.kind, 'path-form');
    assert.equal(traversal.defect.defect, 'parent-traversal');
  });
});

test('a configured root that cannot be resolved is reported against its own spelling', async () => {
  await withTree(async ({ root }) => {
    const good = join(root, 'good');
    await mkdir(good);
    const missing = join(root, 'missing');

    const result = await load({ [COLLECT_ROOTS_ENV]: `${good}:${missing}` });

    assert.equal(result.ok, false);
    assert.equal(result.spelling, missing);
    assert.equal(result.defect.kind, 'unresolvable-root');
    assert.equal(result.defect.path, missing);
    assert.match(describeRootsDefect(result), /cannot be resolved/);
  });
});

test('the filesystem root is refused as a managed root', async () => {
  await withTree(async () => {
    const result = await load({ [COLLECT_ROOTS_ENV]: '/' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.defect, { kind: 'root-is-filesystem-root', path: '/' });
    assert.equal(result.spelling, '/');
    assert.match(describeRootsDefect(result), /filesystem root/);
  });
});

test('a resolved coordinate is never taken from configuration', async () => {
  await withTree(async ({ root }) => {
    const real = join(root, 'real');
    const other = join(root, 'other');
    const link = join(root, 'link');
    await mkdir(real);
    await mkdir(other);
    await symlink(real, link);

    // The configured coordinate is the symlink and it resolves elsewhere, so a
    // `resolved` read from anywhere but this process's own `realpath` would be
    // visibly the wrong value here.
    const fromProcess = await load({ [COLLECT_ROOTS_ENV]: link });
    assert.deepEqual(fromProcess.roots.roots, [{ spelled: link, resolved: real }]);

    // And the loader asks the filesystem about every spelling itself: with an
    // injected `realpath` the only `resolved` value that can appear is the one
    // that call returns, whatever else the environment happens to contain.
    const asked = [];
    const injected = await loadManagedRoots(
      { [COLLECT_ROOTS_ENV]: `${link}:${other}`, ANTONINA_COLLECT_ROOTS_RESOLVED: '/etc' },
      COLLECT_ROOTS_ENV,
      {
        realpath: async (spelling) => {
          asked.push(spelling);
          return spelling === link ? real : spelling;
        },
      },
    );
    assert.deepEqual(asked, [link, other]);
    assert.equal(injected.ok, true, JSON.stringify(injected));
    assert.deepEqual(injected.roots.roots, [
      { spelled: link, resolved: real },
      { spelled: other, resolved: other },
    ]);
  });
});
