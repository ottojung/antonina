import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalHost,
  canonicalPath,
  emptyBoard,
  parseBoard,
  pathFormDefect,
  resourceViews,
} from '../dist/model.js';

const timestamp = '2026-09-24T00:00:00.000Z';
const issue = (number, state = 'open') => ({
  number,
  title: `Issue ${number}`,
  body: '',
  state,
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: [],
});

test('canonical board parser rejects incompatible schemas and unknown issue fields', () => {
  assert.throws(() => parseBoard({ schemaVersion: 1, nextIssueNumber: 1, issues: [], resources: [] }), /incompatible/);
  assert.throws(() => parseBoard({
    schemaVersion: 2,
    nextIssueNumber: 2,
    issues: [{ ...issue(1), assignee: 'agent' }],
    resources: [],
  }), /incompatible/);
});

test('canonical board parser rejects unsafe counters and out-of-order messages', () => {
  assert.throws(() => parseBoard({
    schemaVersion: 2,
    nextIssueNumber: Number.MAX_SAFE_INTEGER + 1,
    issues: [],
    resources: [],
  }), /incompatible/);
  assert.throws(() => parseBoard({
    schemaVersion: 2,
    nextIssueNumber: 2,
    issues: [{
      ...issue(1),
      messages: [
        { id: 'later', author: 'a', body: 'later', createdAt: '2026-09-24T00:01:00.000Z' },
        { id: 'earlier', author: 'a', body: 'earlier', createdAt: timestamp },
      ],
    }],
    resources: [],
  }), /chronological/);
});

test('resource schema is strict and resource views derive protection from open dependencies', () => {
  const board = parseBoard({
    schemaVersion: 2,
    nextIssueNumber: 3,
    issues: [issue(1), issue(2, 'closed')],
    resources: [{
      host: 'lubko://server',
      path: '/workspace/project',
      issueNumbers: [1, 2],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
  assert.deepEqual(resourceViews(board), [{
    host: 'lubko://server',
    path: '/workspace/project',
    issues: [{ number: 1, state: 'open' }, { number: 2, state: 'closed' }],
    protected: true,
    collectible: false,
  }]);
  assert.throws(() => parseBoard({ ...board, resources: [{ ...board.resources[0], issueNumbers: [1, 1] }] }), /resource/);
  assert.throws(() => parseBoard({ ...board, resources: [{ ...board.resources[0], issueNumbers: [3] }] }), /resource/);
});

test('host and path canonicalization match the persisted resource contract', () => {
  assert.equal(canonicalHost(' lubko://server-name '), 'lubko://server-name');
  assert.equal(canonicalPath(' /a/b '), '/a/b');
  assert.equal(canonicalPath('/'), '/');
  for (const value of ['', 'https://server', 'lubko://', 'lubko://server/', 'lubko://server?x', 'lubko://ser ver']) {
    assert.throws(() => canonicalHost(value));
  }
  for (const value of ['', 'a/b', '/a/../b', '/a//b', '/a/.', '/a/b/']) {
    assert.throws(() => canonicalPath(value));
  }
});

test('path form defects name the rule each spelling breaks', () => {
  assert.equal(pathFormDefect('/'), null);
  assert.equal(pathFormDefect('/workspace/project'), null);
  assert.equal(pathFormDefect('/workspace/..hidden'), null);
  assert.equal(pathFormDefect(''), 'empty');
  assert.equal(pathFormDefect('a/b'), 'relative');
  assert.equal(pathFormDefect('workspace'), 'relative');
  assert.equal(pathFormDefect('/a/../b'), 'parent-traversal');
  assert.equal(pathFormDefect('/..'), 'parent-traversal');
  assert.equal(pathFormDefect('/a//b'), 'non-canonical');
  assert.equal(pathFormDefect('/a/./b'), 'non-canonical');
  assert.equal(pathFormDefect('/.'), 'non-canonical');
  assert.equal(pathFormDefect('/a/b/'), 'non-canonical');
  // The valid form is exactly the one canonicalization accepts, and it has not
  // // moved: `pathFormDefect(p) === null` iff `canonicalPath(p)` does not throw.
  for (const value of ['', '/', '/a', 'a', '..', '/..', '/a//b', '/a/./b', '/a/../b', '/a/']) {
    const valid = pathFormDefect(value) === null;
    let accepted = true;
    try {
      canonicalPath(value);
    } catch {
      accepted = false;
    }
    assert.equal(valid, accepted, JSON.stringify(value));
  }
  assert.throws(() => canonicalPath('/a/../b'), /Path must be/);
  assert.throws(() => canonicalPath('a'), /Path must be/);
  assert.throws(() => canonicalPath(''), /Path must be/);
});

test('empty board is canonical', () => {
  assert.deepEqual(parseBoard(emptyBoard()), emptyBoard());
});
