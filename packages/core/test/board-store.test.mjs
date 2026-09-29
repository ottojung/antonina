import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyBoard } from '../dist/model.js';
import { SignedBoardStore } from '../dist/board-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

test('initialization immediately commits a materialized board pointer and returns the existing board key', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: (() => {
      let sequence = 0;
      return () => `id-${++sequence}`;
    })(),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  });

  const initialized = await store.initialize();
  assert.equal(initialized.state.board.nextIssueNumber, 1);
  assert.equal(initialized.log, null);
  // The board credential carries the capability Skrynia minted for the pointer
  // object itself, not an ambient namespace capability: `capability-write`
  // mints per object and keeps only a hash, so the value the creating response
  // returned is the only thing that authorizes a later PUT of that object. This
  // is the whole reason pointer CAS works, and asserting the wrong identity here
  // is what let a shard-side capability mismatch reach production.
  assert.equal(initialized.credential.storageCapability, server.capabilityOf('board-v2'));
  assert.notEqual(initialized.credential.storageCapability, server.capability);
  assert.equal(initialized.credential.keyId, initialized.credential.rootKeyId);
  assert.equal(server.signed.schemaVersion, 3);
  assert.equal(server.signed.format, 'compact-materialized-snapshots');
  assert.equal(server.signed.rootKeyId, initialized.credential.rootKeyId);
});

test('concurrent writers converge through the one pointer CAS without losing either mutation', async () => {
  const server = fakeSkrynia();
  const first = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: (() => { let n = 0; return () => `first-${++n}`; })(),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  });
  const initialized = await first.initialize();

  const left = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: (() => { let n = 0; return () => `left-${++n}`; })(),
    now: () => new Date('2026-09-25T12:01:00.000Z'),
  });
  const right = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: (() => { let n = 0; return () => `right-${++n}`; })(),
    now: () => new Date('2026-09-25T12:02:00.000Z'),
  });

  await Promise.all([
    left.append(initialized.credential, {
      kind: 'issue.create',
      payload: (state) => ({
        number: state.board.nextIssueNumber,
        title: 'Left',
        body: '',
      }),
    }),
    right.append(initialized.credential, {
      kind: 'issue.create',
      payload: (state) => ({
        number: state.board.nextIssueNumber,
        title: 'Right',
        body: '',
      }),
    }),
  ]);

  const committed = await first.readWithCredential(initialized.credential);
  assert.ok(committed);
  assert.deepEqual(
    committed.state.board.issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(
    new Set(committed.state.board.issues.map((issue) => issue.title)),
    new Set(['Left', 'Right']),
  );
  assert.equal(committed.log, null);
  assert.equal(server.signed.revision, 3);
});

test('a wrong board key cannot open the materialized snapshots', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const initialized = await store.initialize();
  const wrong = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  await assert.rejects(
    () => store.append(wrong, {
      kind: 'issue.create',
      payload: { number: 1, title: 'Refused', body: '' },
    }),
    /board key/i,
  );

  const current = await store.readWithCredential(initialized.credential);
  assert.equal(current?.state.board.issues.length, 0);
});

test('a tampered materialized pointer is rejected instead of becoming board state', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const initialized = await store.initialize();

  server.bump({
    ...server.signed,
    head: 'sha256:' + 'A'.repeat(43),
    metaRef: 'meta:forged',
  });

  await assert.rejects(
    () => store.readWithCredential(initialized.credential),
    /board key|snapshot|metadata/i,
  );
});

test('initialization and later snapshot mutations are floored by imported timestamps', async () => {
  const server = fakeSkrynia();
  const initial = {
    ...emptyBoard(),
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Future initial timestamp',
      body: '',
      state: 'open',
      createdAt: '2026-09-25T13:00:00.000Z',
      updatedAt: '2026-09-25T13:00:00.000Z',
      messages: [],
    }],
  };
  const store = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: () => new Date('2026-09-25T12:00:00.000Z'),
    newId: (() => { let sequence = 0; return () => `floor-${++sequence}`; })(),
  });

  const initialized = await store.initialize(initial);
  const committed = await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'root', body: 'after import' },
  });
  assert.equal(
    committed.state.board.issues[0].messages[0].createdAt,
    '2026-09-25T13:00:00.000Z',
  );
});

test('board existence probing remains a cheap pointer-key check', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  assert.equal(await store.signedBoardExists(), false);
  assert.equal(server.signed, null);
  await store.initialize();
  assert.equal(await store.signedBoardExists(), true);
});
