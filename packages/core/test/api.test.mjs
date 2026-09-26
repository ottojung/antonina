import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi, BOARD_CAPABILITIES, BoardTrustRequiredError } from '../dist/api.js';
import { emptyBoard } from '../dist/model.js';

const STAMP = '2026-09-25T12:00:00.000Z';

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
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    set legacy(value) { legacy = value; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const text = String(url);
      const isSigned = text.endsWith('/store/antonina/board-v2');
      const isLegacy = text.endsWith('/store/antonina/board-v1');
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
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function api(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `api-${++sequence}`,
    ...options,
  });
}

test('explicit initialization establishes trust, credential, and verified editing access', async () => {
  const server = fakeSkrynia();
  const client = api(server);

  assert.equal(await client.signedBoardExists(), false);
  assert.equal(client.hasWriteAccess(), false);

  const initialized = await client.initialize();
  assert.equal(initialized.board.nextIssueNumber, 1);
  assert.equal(initialized.credential.keyId, initialized.trustAnchor.rootKeyId);
  assert.equal(client.hasWriteAccess(), true);
  assert.equal(await client.signedBoardExists(), true);

  const created = await client.createIssue('First', 'signed board');
  assert.equal(created.number, 1);
  const commented = await client.comment(1, 'root', 'hello');
  assert.equal(commented.messages[0].body, 'hello');
  assert.ok(client.getRememberedHead());
});

test('a trust anchor permits verified read-only replay without a credential', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  await writer.createIssue('Visible');

  const reader = api(server, {
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  const board = await reader.loadBoard();
  assert.equal(board.issues[0].title, 'Visible');
  assert.equal(reader.hasWriteAccess(), false);
  await assert.rejects(() => reader.createIssue('Blocked'), /credential is required/);
});

test('delegated credentials are attenuated and enforced by the shared API', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const child = await root.delegateCredential(['issue.create']);

  const delegated = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  const created = await delegated.createIssue('Delegated create');
  assert.equal(created.number, 1);
  assert.equal(delegated.hasWriteAccess(), true);
  assert.deepEqual(delegated.getEffectiveCapabilities(), ['issue.create']);
  await assert.rejects(() => delegated.close(1), /lacks required capability issue\.state/);
});

test('full-capability admin children can be minted without storing the root credential', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const adminCredential = await root.delegateCredential(BOARD_CAPABILITIES);

  const admin = api(server, {
    credential: adminCredential,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  const access = await admin.verifyCredential();
  assert.equal(access.canEdit, true);
  assert.deepEqual(access.capabilities, [...BOARD_CAPABILITIES].sort());
  assert.notEqual(adminCredential.keyId, initialized.trustAnchor.rootKeyId);
});

test('stale storage capability never becomes verified edit access', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  const client = api(server, {
    credential: stale,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  await assert.rejects(() => client.verifyCredential(), /failed \(403\)/);
  assert.equal(client.hasWriteAccess(), false);
});

test('revocation invalidates a delegated credential on its next verification', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const child = await root.delegateCredential(['issue.create']);
  await root.revokeCredential(child.keyId);

  const delegated = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  await assert.rejects(() => delegated.verifyCredential(), /unknown or revoked/);
  assert.equal(delegated.hasWriteAccess(), false);
});

test('reading reports a missing board as null and never creates one', async () => {
  const server = fakeSkrynia();
  const methods = [];
  const client = api(server, {
    fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); },
  });

  assert.equal(await client.readBoard(), null);
  assert.equal(methods.includes('POST'), false);
  assert.equal(server.signed, null);
});

test('an existing board is unreadable until a trust anchor is configured', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  const stranger = api(server);

  await assert.rejects(() => stranger.readBoard(), (error) => {
    assert.ok(error instanceof BoardTrustRequiredError);
    return /no trust anchor/.test(error.message);
  });

  const reader = api(server, { trustAnchor: initialized.trustAnchor });
  assert.deepEqual(await reader.readBoard(), initialized.board);
});

test('a second initializer is refused before it can replace the trust root', async () => {
  const server = fakeSkrynia();
  const first = api(server);
  const initialized = await first.initialize();
  const log = server.signed;

  const second = api(server);
  await assert.rejects(() => second.initialize(), /The Antonina signed board already exists/);

  assert.equal(server.signed, log);
  assert.equal(second.getCredential(), null);
  assert.equal(second.getTrustAnchor(), null);
  assert.equal(second.hasWriteAccess(), false);
});

test('mutations fail closed on a missing board instead of creating one', async () => {
  const initialized = await api(fakeSkrynia()).initialize();
  const server = fakeSkrynia();
  const methods = [];
  const writer = api(server, {
    credential: initialized.credential,
    fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); },
  });

  await assert.rejects(() => writer.createIssue('Blocked'), /does not exist/);

  assert.equal(methods.includes('POST'), false);
});

test('legacy migration is explicit and root-signs the imported board', async () => {
  const server = fakeSkrynia();
  server.legacy = {
    ...emptyBoard(),
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Legacy',
      body: 'unsigned source',
      state: 'open',
      createdAt: STAMP,
      updatedAt: STAMP,
      messages: [],
    }],
  };
  const client = api(server);

  assert.equal(await client.legacyBoardExists(), true);
  assert.equal(await client.signedBoardExists(), false);
  assert.equal(server.signed, null);

  const migrated = await client.migrateLegacy();
  assert.equal(migrated.board.issues[0].title, 'Legacy');
  assert.equal(migrated.credential.keyId, migrated.trustAnchor.rootKeyId);
  assert.equal(client.hasWriteAccess(), true);
  assert.equal(server.signed.operations[0].kind, 'board.initialize');
  assert.equal(server.signed.operations[0].payload.board.issues[0].title, 'Legacy');
});
