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
const input = (spelled, resolved = spelled) => ({ spelled, resolved });

const rootsOf = (inputs) => {
  const result = validateManagedRoots(inputs);
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
  assert.deepEqual(validateManagedRoots([input('workspace')]).defect, {
    kind: 'path-form', path: 'workspace', defect: 'relative',
  });
  assert.deepEqual(validateManagedRoots([input('/workspace/../etc')]).defect, {
    kind: 'path-form', path: '/workspace/../etc', defect: 'parent-traversal',
  });
  assert.deepEqual(validateManagedRoots([input('/workspace/antonina/')]).defect, {
    kind: 'path-form', path: '/workspace/antonina/', defect: 'non-canonical',
  });
  assert.deepEqual(validateManagedRoots([input('')]).defect, {
    kind: 'path-form', path: '', defect: 'empty',
  });
});

test('a root set refuses a root whose resolved form is not canonical', () => {
  assert.deepEqual(validateManagedRoots([input('/workspace', 'data/work')]).defect, {
    kind: 'path-form', path: 'data/work', defect: 'relative',
  });
  assert.deepEqual(validateManagedRoots([input('/workspace', '/workspace/../data')]).defect, {
    kind: 'path-form', path: '/workspace/../data', defect: 'parent-traversal',
  });
  assert.deepEqual(validateManagedRoots([{ spelled: '/workspace' }]).defect, { kind: 'malformed-root' });
});

test('a root set refuses a root nested inside another configured root', () => {
  const result = validateManagedRoots([input('/workspace/antonina'), input('/workspace/antonina/inner')]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.defect, {
    kind: 'nested', path: '/workspace/antonina/inner', within: '/workspace/antonina',
  });
  // A parent of another root is the same ambiguity, not a separate case.
  const reversed = validateManagedRoots([input('/workspace/antonina/inner'), input('/workspace/antonina')]);
  assert.deepEqual(reversed.defect, {
    kind: 'nested', path: '/workspace/antonina/inner', within: '/workspace/antonina',
  });
  // Two roots that are siblings once resolved are still ambiguous for a collector
  // that acts in resolved coordinates, so nesting is refused there too.
  const crossed = validateManagedRoots([
    input('/workspace/antonina', '/data/work'),
    input('/workspace/other', '/data/work/inner'),
  ]);
  assert.deepEqual(crossed.defect, {
    kind: 'nested', path: '/workspace/other', within: '/workspace/antonina',
  });
});

test('a root set refuses the same root configured twice', () => {
  const result = validateManagedRoots([input('/workspace/antonina'), input('/workspace/antonina')]);
  assert.deepEqual(result.defect, { kind: 'duplicate', path: '/workspace/antonina' });
  // Two spelled roots that are different names for one directory are the same
  // ambiguity in resolved coordinates.
  const aliases = validateManagedRoots([
    input('/workspace/antonina', '/data/work'),
    input('/workspace/antonina-link', '/data/work'),
  ]);
  assert.deepEqual(aliases.defect, { kind: 'duplicate', path: '/data/work' });
});

test('an eligible candidate hands back one actionable path and no other', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
  const result = decide(roots, '/workspace/antonina/session-1');
  assert.deepEqual(result, {
    eligible: true,
    path: '/workspace/antonina/session-1',
    root: { spelled: '/workspace/antonina', resolved: '/workspace/antonina' },
    unlinkFinalComponent: false,
  });
  // The only path a collector may act on is the spelled board-recorded path.
  assert.deepEqual(Object.keys(result).sort(), ['eligible', 'path', 'root', 'unlinkFinalComponent']);
  // The root handed back is the very instance the validated set holds, frozen, so a
  // collector cannot learn a root by identity and then have it changed under it.
  assert.equal(result.root, roots.roots[0]);
  assert.equal(Object.isFrozen(result.root), true);
  assert.equal(Object.isFrozen(roots.roots), true);
});

test('an eligible symlink is unlinked at the spelled path, never followed', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
  const link = candidate('/workspace/antonina/link', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina/session-1',
  });
  assert.deepEqual(evaluateManagedCandidate(roots, link), {
    eligible: true,
    path: '/workspace/antonina/link',
    root: { spelled: '/workspace/antonina', resolved: '/workspace/antonina' },
    unlinkFinalComponent: true,
  });
  // Even a link pointing at its own root stays eligible: the link is the
  // target, and unlinking it leaves the root in place.
  const linkToRoot = candidate('/workspace/antonina/link', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina',
  });
  assert.equal(evaluateManagedCandidate(roots, linkToRoot).eligible, true);
});

test('a configured root is not collectible through the roots that define it', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
  assert.equal(refusalOf(roots, '/workspace/antonina'), 'candidate-is-managed-root');
  // Resolving a candidate onto its own root is not the same thing as naming it:
  // a symlink that points back at the root is unlinked, and the root survives.
  assert.equal(
    evaluateManagedCandidate(roots, candidate('/workspace/antonina/link', {
      finalComponentIsSymlink: true,
      resolvedPath: '/workspace/antonina',
    })).eligible,
    true,
  );

  const filesystemRoot = rootsOf(['/'].map((path) => input(path)));
  assert.equal(decide(filesystemRoot, '/workspace/antonina').eligible, true);
  assert.equal(refusalOf(filesystemRoot, '/'), 'candidate-is-managed-root');
  assert.equal(decide(filesystemRoot, '/workspace/foobar').eligible, true);
  // A path under `/` that is not absolute is still refused before containment.
  assert.deepEqual(refusalOf(filesystemRoot, 'workspace/antonina'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
});

test('a candidate in no managed root is refused as unmanaged', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
  assert.equal(refusalOf(roots, '/etc/antonina'), 'outside-managed-roots');
  assert.equal(refusalOf(roots, '/home/dev/antonina'), 'outside-managed-roots');
});

test('a candidate that only shares a string prefix with a root is refused as a near miss', () => {
  const roots = rootsOf(['/workspace/foo'].map((path) => input(path)));
  assert.equal(refusalOf(roots, '/workspace/foobar'), 'near-miss-root-prefix');
  assert.equal(refusalOf(roots, '/workspace/foobar/nested'), 'near-miss-root-prefix');
  // One more separator is a real containment, not a near miss.
  assert.equal(decide(roots, '/workspace/foo/bar').eligible, true);
});

test('an empty or relative candidate is refused before any containment is considered', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
  assert.deepEqual(refusalOf(roots, ''), { kind: 'candidate-path-form', defect: 'empty' });
  assert.deepEqual(refusalOf(roots, 'workspace/antonina/session-1'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
  assert.deepEqual(refusalOf(roots, './session-1'), {
    kind: 'candidate-path-form', defect: 'relative',
  });
});

test('a candidate that walks up with `..` is refused even when it spells back into a root', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
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
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
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
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
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
  const linkOut = candidate('/workspace/antonina/session-1', {
    finalComponentIsSymlink: true,
    resolvedPath: '/workspace/antonina-elsewhere/session-1',
  });
  assert.equal(
    evaluateManagedCandidate(roots, linkOut).refusal,
    'symlink-escapes-managed-root',
  );
});

test('a root under a symlinked ancestor is judged in resolved coordinates', () => {
  // `/workspace` is a symlink to `/data/work`, so the root is reached by a name
  // that shares no prefix with anything a candidate resolves to.
  const roots = rootsOf([input('/workspace/antonina', '/data/work/antonina')]);
  const inside = candidate('/workspace/antonina/session-1', {
    resolvedPath: '/data/work/antonina/session-1',
    parentResolvedPath: '/data/work/antonina',
  });
  assert.deepEqual(evaluateManagedCandidate(roots, inside), {
    eligible: true,
    path: '/workspace/antonina/session-1',
    root: { spelled: '/workspace/antonina', resolved: '/data/work/antonina' },
    unlinkFinalComponent: false,
  });
  // The root itself is still not collectible through the roots that define it.
  assert.equal(
    refusalOf(roots, '/workspace/antonina'),
    'candidate-is-managed-root',
  );
  // A sibling directory under the same symlinked ancestor is genuinely outside.
  assert.equal(
    refusalOf(roots, '/workspace/other/session-1'),
    'outside-managed-roots',
  );
  // A candidate that really does resolve out of the resolved root is still refused.
  const escaping = candidate('/workspace/antonina/session-1', {
    resolvedPath: '/data/work/elsewhere/session-1',
    parentResolvedPath: '/data/work/antonina',
  });
  assert.equal(evaluateManagedCandidate(roots, escaping).refusal, 'symlink-escapes-managed-root');
  // And a directory symlinked out from under the root is refused as an escape.
  const reparented = candidate('/workspace/antonina/session-1', {
    resolvedPath: '/data/work/antonina/session-1',
    parentResolvedPath: '/var/elsewhere',
  });
  assert.equal(
    evaluateManagedCandidate(roots, reparented).refusal,
    'containing-directory-escapes-managed-root',
  );
  // Per-component containment still holds against a resolved root.
  const nearMiss = rootsOf([input('/workspace/foo', '/data/work/foo')]);
  assert.equal(
    refusalOf(nearMiss, '/workspace/foobar', {
      resolvedPath: '/data/work/foobar',
      parentResolvedPath: '/data/work',
    }),
    'near-miss-root-prefix',
  );
});

test('a candidate whose containing directory resolves out of the managed root is refused', () => {
  const roots = rootsOf(['/workspace/antonina'].map((path) => input(path)));
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
  assert.equal(evaluateManagedCandidate(roots, reparentedIn).eligible, true);
});

test('each candidate is judged only against the root it belongs to', () => {
  const roots = rootsOf(['/workspace/a', '/srv/b'].map((path) => input(path)));
  // The validated set keeps the configured order, frozen, because the first matching
  // root is the one that authorises a candidate.
  assert.deepEqual(roots.roots.map((root) => root.spelled), ['/workspace/a', '/srv/b']);
  assert.equal(Object.isFrozen(roots.roots), true);
  assert.equal(Object.isFrozen(roots), true);
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
