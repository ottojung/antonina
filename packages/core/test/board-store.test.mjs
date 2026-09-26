import assert from 'node:assert/strict';
import test from 'node:test';

import { credentialSigningKey } from '../dist/credential.js';
import { emptyBoard } from '../dist/model.js';
import { signBoardOperation } from '../dist/operations.js';
import { SignedBoardStore } from '../dist/board-store.js';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let legacy = null;
  let revision = 0;
  let beforePut = null;

  const etag = () => `"v${revision}"`;

  return {
    get signed() { return signed; },
    set signed(value) { signed = value; },
    get revision() { return revision; },
    set legacy(value) { legacy = value; },
    set beforePut(value) { beforePut = value; },
    capability,
    bump(value) {
      signed = structuredClone(value);
      revision += 1;
    },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const isSigned = String(url).endsWith('/store/antonina/board-v2');
      const isLegacy = String(url).endsWith('/store/antonina/board-v1');
      if (isLegacy) {
        if (method !== 'GET') return new Response(null, { status: 405 });
        return legacy === null ? new Response(null, { status: 404 }) : jsonResponse(legacy, 200, '"legacy"');
      }
      if (!isSigned) return new Response(null, { status: 404 });

      if (method === 'GET') {
        return signed === null ? new Response(null, { status: 404 }) : jsonResponse(signed, 200, etag());
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return jsonResponse({ mode: 'capability-write', capability }, 201);
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        if (beforePut) {
          const hook = beforePut;
          beforePut = null;
          await hook();
        }
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

test('initialization creates board-v2 deliberately and returns a root credential', async () => {
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
  assert.equal(initialized.log.operations.length, 1);
  assert.equal(initialized.log.operations[0].kind, 'board.initialize');
  assert.equal(initialized.credential.storageCapability, server.capability);
  assert.equal(initialized.credential.keyId, initialized.credential.rootKeyId);
  assert.equal(server.signed.rootKeyId, initialized.credential.rootKeyId);
});

test('concurrent valid writers converge through ETag retry without losing the winner', async () => {
  const server = fakeSkrynia();
  let id = 0;
  const store = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: () => `nonce-${++id}`,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  });
  const initialized = await store.initialize();
  const signer = credentialSigningKey(initialized.credential);

  server.beforePut = async () => {
    const current = structuredClone(server.signed);
    const winner = await signBoardOperation({
      boardId: current.boardId,
      previous: current.head,
      timestamp: '2026-09-25T12:01:00.000Z',
      nonce: 'winner',
      kind: 'issue.create',
      payload: { number: 1, title: 'Winner', body: '' },
    }, signer);
    current.operations.push(winner);
    current.head = winner.opId;
    server.bump(current);
  };

  const committed = await store.append(initialized.credential, {
    kind: 'issue.create',
    timestamp: '2026-09-25T12:02:00.000Z',
    nonce: 'mine',
    payload: (state) => ({
      number: state.board.nextIssueNumber,
      title: 'Mine',
      body: '',
    }),
  }, initialized.state.head);

  assert.deepEqual(
    committed.state.board.issues.map((issue) => [issue.number, issue.title]),
    [[1, 'Winner'], [2, 'Mine']],
  );
  assert.equal(committed.log.operations.length, 3);
  assert.equal(committed.log.operations[2].previous, committed.log.operations[1].opId);
});

test('storage capability validation is separate from cryptographic authority', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const initialized = await store.initialize();
  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  await assert.rejects(
    () => store.verifyStorageCapability(stale, initialized.state.head),
    /failed \(403\)/,
  );

  const valid = await store.verifyStorageCapability(initialized.credential, initialized.state.head);
  assert.equal(valid.state.head, initialized.state.head);
});

test('tampered persisted history is rejected instead of becoming derived state', async () => {
  const server = fakeSkrynia();
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const initialized = await store.initialize();

  const tampered = structuredClone(server.signed);
  tampered.operations[0].payload.board.nextIssueNumber = 2;
  server.bump(tampered);

  await assert.rejects(
    () => store.read({
      boardId: initialized.credential.boardId,
      rootKeyId: initialized.credential.rootKeyId,
      rootPublicKey: initialized.credential.rootPublicKey,
    }, initialized.state.head),
    /(identity hash|previously accepted head)/,
  );
});

test('legacy board-v1 is only exposed as an explicit migration source', async () => {
  const server = fakeSkrynia();
  const legacy = {
    ...emptyBoard(),
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Legacy',
      body: '',
      state: 'open',
      createdAt: '2026-09-25T12:00:00.000Z',
      updatedAt: '2026-09-25T12:00:00.000Z',
      messages: [],
    }],
  };
  server.legacy = legacy;
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });

  assert.deepEqual(await store.readLegacyBoard(), legacy);
  assert.equal(server.signed, null);
});
