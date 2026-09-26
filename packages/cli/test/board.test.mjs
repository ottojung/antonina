import assert from 'node:assert/strict';
import test from 'node:test';

import { runBoardCommand } from '../dist/packages/cli/src/board.js';

const stamp = '2026-09-24T10:00:00.000Z';

function issue(number = 1, state = 'open') {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: stamp, updatedAt: stamp, messages: [] };
}

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function command(argv, client, env = {}) {
  const capture = memoryIo();
  return runBoardCommand(argv, { env, io: capture.io, createClient: () => client })
    .then((code) => ({ ...capture, code }));
}

test('board CLI emits deterministic JSON list output', async () => {
  const result = await command(['list', '--json'], {
    listIssues: async () => [issue()],
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out[0]), [issue()]);
  assert.deepEqual(result.err, []);
});

test('board CLI requires author from flag or environment before calling the client', async () => {
  let called = false;
  const result = await command(['comment', '1', 'hello'], {
    comment: async () => { called = true; return issue(); },
  });
  assert.equal(result.code, 1);
  assert.match(result.err[0], /ANTONINA_BOARD_AUTHOR/);
  assert.equal(called, false);
});

test('board CLI passes explicit author and renders the updated issue', async () => {
  let observed;
  const result = await command(['comment', '1', 'hello', '--author', 'Vitalik', '--json'], {
    comment: async (...args) => {
      observed = args;
      return { ...issue(), messages: [{ id: 'm1', author: 'Vitalik', body: 'hello', createdAt: stamp }] };
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(observed, [1, 'Vitalik', 'hello']);
  assert.equal(JSON.parse(result.out[0]).messages[0].author, 'Vitalik');
});

test('credential delegation validates, sorts, and deduplicates capability names', async () => {
  let observed;
  const credential = {
    schemaVersion: 1,
    boardId: 'board',
    rootKeyId: 'ed25519:' + 'a'.repeat(43),
    rootPublicKey: 'A',
    keyId: 'ed25519:' + 'b'.repeat(43),
    publicKey: 'B',
    privateKey: 'C',
    storageCapability: 'd'.repeat(64),
  };
  const result = await command([
    'credential',
    'delegate',
    'issue.create',
    'issue.comment',
    'issue.create',
    '--json',
  ], {
    delegateCredential: async (capabilities) => {
      observed = capabilities;
      return credential;
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(observed, ['issue.comment', 'issue.create']);
  assert.equal(JSON.parse(result.out[0]).keyId, credential.keyId);
});

test('credential delegation rejects unknown capabilities before calling the client', async () => {
  let called = false;
  const result = await command(['credential', 'delegate', 'everything'], {
    delegateCredential: async () => { called = true; throw new Error('unexpected'); },
  });
  assert.equal(result.code, 1);
  assert.match(result.err[0], /unknown board capability/);
  assert.equal(called, false);
});

test('queue reorder parses positive issue numbers in order', async () => {
  let observed;
  const result = await command(['queue', 'reorder', '3', '1', '2', '--json'], {
    reorderQueue: async (numbers) => {
      observed = numbers;
      return numbers;
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(observed, [3, 1, 2]);
  assert.deepEqual(JSON.parse(result.out[0]), [3, 1, 2]);
});

test('explicit initialize returns credential and trust material in JSON mode', async () => {
  const initialized = {
    board: { schemaVersion: 2, nextIssueNumber: 1, issues: [], resources: [] },
    credential: {
      schemaVersion: 1,
      boardId: 'board',
      rootKeyId: 'ed25519:' + 'a'.repeat(43),
      rootPublicKey: 'A',
      keyId: 'ed25519:' + 'a'.repeat(43),
      publicKey: 'A',
      privateKey: 'B',
      storageCapability: 'c'.repeat(64),
    },
    trustAnchor: {
      boardId: 'board',
      rootKeyId: 'ed25519:' + 'a'.repeat(43),
      rootPublicKey: 'A',
    },
    head: 'sha256:' + 'd'.repeat(43),
  };
  const result = await command(['initialize', '--json'], {
    initialize: async () => initialized,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.out[0]);
  assert.equal(parsed.credential.storageCapability, initialized.credential.storageCapability);
  assert.equal(parsed.trustAnchor.rootKeyId, initialized.trustAnchor.rootKeyId);
});

test('invalid credential environment JSON fails closed before network access', async () => {
  const capture = memoryIo();
  const code = await runBoardCommand(['list'], {
    env: { ANTONINA_BOARD_CREDENTIAL: '{not-json' },
    io: capture.io,
  });
  assert.equal(code, 1);
  assert.match(capture.err[0], /ANTONINA_BOARD_CREDENTIAL must contain valid JSON/);
});

test('access without a configured credential fails closed before network access', async () => {
  const capture = memoryIo();
  const code = await runBoardCommand(['access'], { env: {}, io: capture.io });
  assert.equal(code, 1);
  assert.match(capture.err[0], /credential is required/);
});
