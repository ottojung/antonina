import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateManagedCandidate,
  validateManagedRoots,
} from '../dist/managed-roots.js';

// Managed-root path safety is the deletion half of host garbage collection: it
// answers only "may this path be touched", and it answers purely. These tests
// name the filesystem facts directly instead of creating directories, so every
// refusal rule is exercised without touching a real tree.
const rootsOf = (paths) => {
  const result = validateManagedRoots(paths);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.roots;
};

const candidate = (path, overrides = {}) => {
  const separator = path.lastIndexOf('/');
  return {
    path,
    resolvedPath: path,
    finalComponentIsSymlink: false,
    parentResolvedPath: separator <= 0 ? '/' : path.slice(0, separator),
    ...overrides,
  };
};

const decide = (roots, path, overrides) => evaluateManagedCandidate(roots, candidate(path, overrides));

const refusalOf = (roots, path, overrides) => {
  const result = decide(roots, path, overrides);
  assert.equal(result.eligible, false, JSON.stringify(result));
  return result.refusal;
};

test('a root set refuses a non-canonical root and says which rule it broke', () => {
  assert.deepEqual(validateManagedRoots([]).defect, { kind: 'empty' });
  assert.deepEqual(validateManagedRoots(['workspace']).defect, {
    kind: 'path-form', path: 'workspace', defect: 'relative',
  });
  assert.deepEqual(validateManagedRoots(['/workspace/../etc']).defect, {
    kind: 'path-form', path: '/workspace/../etc', defect: 'parent-traversal',
  });
  assert.deepEqual(validateManagedRoots(['/workspace/antonina/']).defect, {
    kind: 'path-form', path: '/workspace/antonina/', defect: 'non-canonical',
  });
  assert.deepEqual(validateManagedRoots(['']).defect, {
    kind: 'path-form', path: '', defect: 'empty',
  });
});

test('a root set refuses a root nested inside another configured root', () => {
  const result = validateManagedRoots(['/workspace/antonina', '/workspace/antonina/inner']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.defect, {
    kind: 'nested', path: '/workspace/antonina/inner', within: '/workspace/antonina',
  });
  // A parent of another root is the same ambiguity, not a separate case.
  const reversed = validateManagedRoots(['/workspace/antonina/inner', '/workspace/antonina']);
  assert.deepEqual(reversed.defect, {
    kind: 'nested', path: '/workspace/antonina/inner', within: '/workspace/antonina',
  });
});

test('a root set refuses the same root configured twice', () => {
  const result = validateManagedRoots(['/workspace/antonina', '/workspace/antonina']);
  assert.deepEqual(result.defect, { kind: 'duplicate', path: '/workspace/antonina' });
});

test('a candidate inside a managed root is eligible and reports the resolved path', () => {
  const roots = rootsOf(['/workspace/antonina']);
  const result = decide(roots, '/workspace/antonina/session-1');
  assert.deepEqual(result, {
    eligible: true,
    path: '/workspace/antonina/session-1',
    root: { path: '/workspace/antonina' },
    resolvedPath: '/workspace/antonina/session-1',
    finalComponentIsSymlink: false,
  });
});

test('a configured root is not collectible through the roots that define it', () => {
  const roots = rootsOf(['/workspace/antonina']);
  assert.equal(refusalOf(roots, '/workspace/antonina'), 'candidate-is-managed-root');

  const filesystemRoot = rootsOf(['/']);
  assert.equal(decide(filesystemRoot, '/workspace/antonina').eligible, true);
  assert.equal(refusalOf(filesystemRoot, '/'), 'candidate-is-managed-root');
  assert.equal(decide(filesystemRoot, '/workspace/foobar').eligible, true);
  // A path under `/` that is not absolute is still refused before containment.
  assert.deepEqual(refusalOf(filesystemRoot, 'workspace/antonina'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
});

test('a candidate in no managed root is refused as unmanaged', () => {
  const roots = rootsOf(['/workspace/antonina']);
  assert.equal(refusalOf(roots, '/etc/antonina'), 'outside-managed-roots');
  assert.equal(refusalOf(roots, '/home/dev/antonina'), 'outside-managed-roots');
});

test('a candidate that only shares a string prefix with a root is refused as a near miss', () => {
  const roots = rootsOf(['/workspace/foo']);
  assert.equal(refusalOf(roots, '/workspace/foobar'), 'near-miss-root-prefix');
  assert.equal(refusalOf(roots, '/workspace/foobar/nested'), 'near-miss-root-prefix');
  // One more separator is a real containment, not a near miss.
  assert.equal(decide(roots, '/workspace/foo/bar').eligible, true);
});

test('an empty or relative candidate is refused before any containment is considered', () => {
  const roots = rootsOf(['/workspace/antonina']);
  assert.deepEqual(refusalOf(roots, ''), { kind: 'candidate-path-form', defect: 'empty' });
  assert.deepEqual(refusalOf(roots, 'workspace/antonina/session-1'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
  assert.deepEqual(refusalOf(roots, './session-1'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
});

test('a candidate that walks up with `..` is refused even when it spells back into a root', () => {
  const roots = rootsOf(['/workspace/antonina']);
  assert.deepEqual(refusalOf(roots, '/workspace/antonina/../etc'), {
    kind: 'candidate-path-form', defect: 'parent-traversal',
  });
  assert.deepEqual(refusalOf(roots, '/workspace/antonina/session/../../..'), {
    kind: 'candidate-path-form', defect: 'parent-traversal',
  });
  // A name that merely contains dots is an ordinary name.
  assert.equal(decide(roots, '/workspace/antonina/..hidden').eligible, true);
});

test('a non-canonical candidate spelling is refused', () => {
  const roots = rootsOf(['/workspace/antonina']);
  assert.deepEqual(refusalOf(roots, '/workspace/antonina/./session-1'), {
    kind: 'candidate-path-form', defect: 'non-canonical',
  });
  assert.deepEqual(refusalOf(roots, '/workspace/antonina//session-1'), {
    kind: 'candidate-path-form', defect: 'non-canonical',
  });
  assert.deepEqual(refusalOf(roots, '/workspace/antonina/session-1/'), {
    kind: 'candidate-path-form', defect: 'non-canonical',
  });
});

test('a candidate that resolves through a symlink out of its managed root is refused', () => {
  const roots = rootsOf(['/workspace/antonina']);
  const escaping = candidate('/workspace/antonina/session-1', {
    resolvedPath: '/etc/antonina',
  });
  assert.equal(
    evaluateManagedCandidate(roots, escaping).refusal,
    'symlink-escapes-managed-root',
  );
  // A final component that is a symlink is unlinked, not followed, but its
  // target must still be inside the root.
  const quietLink = candidate('/workspace/antonina/session-1', {
    finalComponentIsSymlink: true,
  });
  assert.equal(evaluateManagedCandidate(roots, quietLink).eligible, true);
  const linkToParent = candidate('/workspace/antonina/session-1', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina',
  });
  assert.equal(evaluateManagedCandidate(roots, linkToParent).eligible, true);
  const linkOut = candidate('/workspace/antonina/session-1', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina-elsewhere/session-1',
  });
  assert.equal(
    evaluateManagedCandidate(roots, linkOut).refusal,
    'symlink-escapes-managed-root',
  );
});

test('a symlink that stays inside its managed root is eligible and hands back the target', () => {
  const roots = rootsOf(['/workspace/antonina']);
  const link = candidate('/workspace/antonina/link', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina/session-1',
  });
  assert.deepEqual(evaluateManagedCandidate(roots, link), {
    eligible: true,
    path: '/workspace/antonina/link',
    root: { path: '/workspace/antonina' },
    resolvedPath: '/workspace/antonina/session-1',
    finalComponentIsSymlink: true,
  });
});

test('a candidate whose containing directory resolves out of the managed root is refused', () => {
  const roots = rootsOf(['/workspace/antonina']);
  // The candidate resolves inside the root, but the directory holding it is
  // elsewhere, so the spelled path is not the location it claims to be.
  const reparented = candidate('/workspace/antonina/session-1', {
    resolvedPath: '/workspace/antonina/session-1',
    parentResolvedPath: '/var/elsewhere',
  });
  assert.equal(
    evaluateManagedCandidate(roots, reparented).refusal,
    'containing-directory-escapes-managed-root',
  );
  // A directory symlinked back into the root is not an escape.
  const reparentedIn = candidate('/workspace/antonina/link/session-1', {
    resolvedPath: '/workspace/antonina/link/session-1',
    parentResolvedPath: '/workspace/antonina/session-1',
  });
  assert.equal(decide(roots, '/workspace/antonina/link/session-1', {
    parentResolvedPath: '/workspace/antonina/session-1',
  }).eligible, true);
  assert.equal(evaluateManagedCandidate(roots, reparentedIn).eligible, true);
});

test('with no managed root configured nothing is eligible, whatever the facts', () => {
  const empty = { roots: [] };
  assert.equal(
    evaluateManagedCandidate(empty, candidate('/workspace/antonina/session-1')).refusal,
    'no-managed-roots',
  );
});

test('each candidate is judged only against the root it belongs to', () => {
  const roots = rootsOf(['/workspace/a', '/srv/b']);
  assert.equal(decide(roots, '/workspace/a/one').eligible, true);
  assert.equal(decide(roots, '/srv/b/one').eligible, true);
  assert.equal(refusalOf(roots, '/srv/a/one'), 'outside-managed-roots');
  // Crossing from one root into a sibling root through a symlink is an escape.
  const crossed = candidate('/workspace/a/one', {
    finalComponentIsSymlink: true,
    resolvedPath: '/srv/b/one',
  });
  assert.equal(evaluateManagedCandidate(roots, crossed).refusal, 'symlink-escapes-managed-root');
});
