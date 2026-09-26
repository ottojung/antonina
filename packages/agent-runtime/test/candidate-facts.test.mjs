import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { gatherCandidatePathFacts } from '../dist/packages/agent-runtime/src/candidate-facts.js';

/**
 * The gatherer is the only place in the collection stack that reads the
 * filesystem, so it is the only test that needs a real tree. Each test makes its
 * own temporary root and removes it in its own teardown, so no test depends on
 * another's leftovers and nothing is created at import time. Nothing here reads
 * or writes ambient Antonina state.
 */
const withTree = async (build) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'antonina-candidate-facts-')));
  try {
    return await build(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('a plain directory resolves to itself in both coordinate systems', async () => {
  await withTree(async (root) => {
    mkdirSync(join(root, 'project'));
    assert.deepEqual(await gatherCandidatePathFacts(`${root}/project`), {
      path: `${root}/project`,
      resolvedPath: `${root}/project`,
      finalComponentIsSymlink: false,
      parentResolvedPath: root,
    });
  });
});

test('a symlinked final component is reported as one, and resolves through', async () => {
  await withTree(async (root) => {
    mkdirSync(join(root, 'target'));
    symlinkSync(join(root, 'target'), join(root, 'link'));
    const facts = await gatherCandidatePathFacts(`${root}/link`);
    assert.deepEqual(facts, {
      path: `${root}/link`,
      resolvedPath: `${root}/target`,
      finalComponentIsSymlink: true,
      parentResolvedPath: root,
    });
  });
});

test('a symlinked containing directory moves the candidate off its spelled name', async () => {
  await withTree(async (root) => {
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'link'));
    // The candidate does not exist, which is a real deletion target: the facts
    // are the resolved parent plus the final component, so the parent resolving
    // elsewhere is exactly the fact that must come out.
    const facts = await gatherCandidatePathFacts(`${root}/link/candidate`);
    assert.deepEqual(facts, {
      path: `${root}/link/candidate`,
      resolvedPath: `${root}/elsewhere/candidate`,
      finalComponentIsSymlink: false,
      parentResolvedPath: `${root}/elsewhere`,
    });
  });
});

test('a path that does not exist yet is resolved through its parent', async () => {
  await withTree(async (root) => {
    assert.deepEqual(await gatherCandidatePathFacts(`${root}/never-created/candidate`), null);
    mkdirSync(join(root, 'parent'));
    const facts = await gatherCandidatePathFacts(`${root}/parent/candidate`);
    assert.deepEqual(facts, {
      path: `${root}/parent/candidate`,
      resolvedPath: `${root}/parent/candidate`,
      finalComponentIsSymlink: false,
      parentResolvedPath: `${root}/parent`,
    });
  });
});

test('a broken symlink is still a symlink, and its target cannot be resolved', async () => {
  await withTree(async (root) => {
    symlinkSync(join(root, 'absent'), join(root, 'broken'));
    assert.equal(await gatherCandidatePathFacts(`${root}/broken`), null);
  });
});

test('a top-level candidate resolves against the filesystem root', async () => {
  await withTree(async () => {
    // `/proc/self` exists and is a symlink, so this exercises the `join('/', …)`
    // arm of the parent join against a real path.
    const facts = await gatherCandidatePathFacts('/proc/self');
    assert.notEqual(facts, null);
    assert.equal(facts.parentResolvedPath, '/proc');
    assert.equal(facts.finalComponentIsSymlink, true);
  });
});

test('a malformed candidate is refused rather than described', async () => {
  await withTree(async (root) => {
    // Not a canonical absolute path at all: the gatherer does not canonicalise
    // spelling, but it also does not invent facts for one. A relative spelling
    // resolves its parent against the process, so here there is no parent
    // directory to resolve and no facts to report.
    assert.equal(await gatherCandidatePathFacts('relative/candidate'), null);
    assert.equal(await gatherCandidatePathFacts(`${root}/a/../../b`), null);
  });
});

test('an existing regular file reports a resolved path equal to its own', async () => {
  await withTree(async (root) => {
    writeFileSync(join(root, 'file'), 'x');
    const facts = await gatherCandidatePathFacts(`${root}/file`);
    assert.deepEqual(facts, {
      path: `${root}/file`,
      resolvedPath: `${root}/file`,
      finalComponentIsSymlink: false,
      parentResolvedPath: root,
    });
  });
});
