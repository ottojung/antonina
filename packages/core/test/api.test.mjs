import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSigningKey } from '../dist/canonical.js';
import {
  BoardApi,
  BoardDeletedError,
  BoardMissingError,
  BOARD_CAPABILITIES,
  BoardStorageRejectedError,
  BoardTrustRequiredError,
  SignedBoardStoreError,
} from '../dist/api.js';

const STAMP = '2026-09-25T12:00:00.000Z';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  let beforePut = null;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    set beforePut(value) { beforePut = value; },
    bump(value) {
      signed = structuredClone(value);
      revision += 1;
    },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
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
  assert.equal(reader.accessState().credentialRejection, null);
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

test('a stale storage capability is refused by the first mutation, not before it', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  const methods = [];
  const watched = api(server, {
    credential: stale,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
    fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); },
  });

  const access = await watched.verifyCredential();
  assert.equal(access.canEdit, true);
  assert.equal(access.storageRejected, false);
  assert.equal(methods.includes('PUT'), false, 'verifying a credential must not write');

  await assert.rejects(
    () => watched.createIssue('Refused'),
    (error) => {
      assert.ok(error instanceof BoardStorageRejectedError);
      assert.equal(error.cause instanceof SignedBoardStoreError, true);
      assert.equal(error.cause.status, 403);
      return true;
    },
  );
  assert.equal(watched.hasWriteAccess(), false);
  assert.equal(watched.accessState().storageRejected, true);
  assert.equal(server.signed.operations.length, 1);
});

test('a 403 on the read a mutation is built on is a read failure, and a 403 on its write refuses storage', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  const methods = [];
  let forbidden = false;
  const reader = api(server, {
    credential: initialized.credential,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
    fetch: async (url, init = {}) => {
      methods.push(init.method ?? 'GET');
      if (forbidden && (init.method ?? 'GET') === 'GET') return jsonResponse({ error: 'forbidden' }, 403);
      return server.fetch(url, init);
    },
  });
  assert.equal((await reader.verifyCredential()).canEdit, true);

  forbidden = true;
  methods.length = 0;
  await assert.rejects(() => reader.createIssue('Unreadable'), (error) => {
    assert.equal(error instanceof BoardStorageRejectedError, false);
    assert.ok(error instanceof SignedBoardStoreError);
    assert.equal(error.status, 403);
    assert.match(error.message, /Skrynia GET antonina\/board-v2 failed \(403\)/);
    return true;
  });
  assert.deepEqual(methods, ['GET'], 'the refusal came from a read, before any write');
  assert.equal(reader.accessState().storageRejected, false);
  assert.equal(reader.hasWriteAccess(), true, 'a refused read must not cost this client its write access');

  const writer = api(server, {
    credential: stale,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });

  await assert.rejects(() => writer.createIssue('Refused'), BoardStorageRejectedError);
  assert.equal(writer.hasWriteAccess(), false);
  assert.equal(writer.accessState().storageRejected, true);
  assert.equal(server.signed.operations.length, 1);
});

test('a credential whose key ID claims a live authority but whose key is not that authority is read-only', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Visible');

  // A well-formed credential that names the root authority but carries a
  // different signing key pair, as browser storage can hold after a hand edit.
  const other = await generateSigningKey();
  const impostor = {
    ...initialized.credential,
    keyId: initialized.credential.keyId,
    publicKey: other.publicKey,
    privateKey: other.privateKey,
  };

  const client = api(server, {
    credential: impostor,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  assert.equal((await client.readBoard()).issues[0].title, 'Visible');
  assert.equal(client.hasWriteAccess(), false);
  assert.deepEqual(client.getEffectiveCapabilities(), []);
  assert.equal(client.accessState().keyId, null);
  assert.equal(client.accessState().canEdit, false);
  await assert.rejects(() => client.verifyCredential(), /key ID does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /key ID does not match its public key/);
  assert.equal(server.signed.operations.length, 2, 'a refused credential must not sign an operation');
});

test('a credential holding the live public key with a foreign private key is read-only', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Visible');

  const other = await generateSigningKey();
  const impostor = {
    ...initialized.credential,
    privateKey: other.privateKey,
  };

  const client = api(server, {
    credential: impostor,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  assert.equal((await client.readBoard()).issues[0].title, 'Visible');
  assert.equal(client.hasWriteAccess(), false);
  assert.deepEqual(client.getEffectiveCapabilities(), []);
  assert.equal(client.accessState().credentialRejection, 'unverified');
  await assert.rejects(() => client.verifyCredential(), /private key does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /private key does not match its public key/);
  assert.equal(server.signed.operations.length, 2, 'a refused credential must not sign an operation');
});

test('a credential whose key ID is not derived from the live public key is read-only', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Visible');

  const impostor = {
    ...initialized.credential,
    keyId: `ed25519:${'A'.repeat(43)}`,
  };

  const client = api(server, {
    credential: impostor,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  assert.equal((await client.readBoard()).issues[0].title, 'Visible');
  assert.equal(client.hasWriteAccess(), false);
  assert.deepEqual(client.getEffectiveCapabilities(), []);
  assert.equal(client.accessState().credentialRejection, 'unverified');
  await assert.rejects(() => client.verifyCredential(), /key ID does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /key ID does not match its public key/);
  assert.equal(server.signed.operations.length, 2, 'a refused credential must not sign an operation');
});

test('a well-formed credential for a key this board never registered is read-only', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Visible');

  const foreign = await generateSigningKey();
  const client = api(server, {
    credential: {
      ...initialized.credential,
      keyId: foreign.keyId,
      publicKey: foreign.publicKey,
      privateKey: foreign.privateKey,
    },
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
  });
  assert.equal((await client.readBoard()).issues[0].title, 'Visible');
  assert.equal(client.hasWriteAccess(), false);
  assert.deepEqual(client.getEffectiveCapabilities(), []);
  assert.equal(client.accessState().credentialRejection, 'unknown');
  await assert.rejects(() => client.verifyCredential(), /unknown or revoked/);
  await assert.rejects(() => client.createIssue('Impostor'), /unknown or revoked/);
  assert.equal(server.signed.operations.length, 2, 'a credential for an unregistered key must not sign an operation');
});

test('a deleted board is reported as its own state, not as a read failure', async () => {
  const server = fakeSkrynia();
  const owner = api(server);
  const initialized = await owner.initialize();
  await owner.deleteBoard();

  const reader = api(server, { trustAnchor: initialized.trustAnchor });
  await assert.rejects(() => reader.readBoard(), BoardDeletedError);
  await assert.rejects(() => reader.createIssue('Blocked'), BoardDeletedError);
});

test('an append to a board deleted after the credential was read reports as deleted', async () => {
  const server = fakeSkrynia();
  const owner = api(server);
  const initialized = await owner.initialize();

  const methods = [];
  const writer = api(server, {
    credential: initialized.credential,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.head,
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return server.fetch(url, init); },
  });
  const access = await writer.verifyCredential();
  assert.equal(access.canEdit, true);

  const log = server.signed;
  await owner.deleteBoard();
  methods.length = 0;

  await assert.rejects(() => writer.createIssue('Too late'), BoardDeletedError);
  assert.deepEqual(methods, ['GET'], 'a deleted board must be noticed before anything is signed or sent');
  assert.equal(server.signed.operations.length, log.operations.length + 1);
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
  assert.equal((await delegated.loadBoard()).issues.length, 0);
  assert.equal(delegated.accessState().credentialRejection, 'revoked');
  assert.equal(delegated.hasWriteAccess(), false);
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

test('a missing board stays a read-only miss even for a client holding an anchor', async () => {
  const server = fakeSkrynia();
  const elsewhere = await api(fakeSkrynia()).initialize();
  const methods = [];
  const client = api(server, {
    trustAnchor: elsewhere.trustAnchor,
    fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); },
  });

  assert.equal(await client.readBoard(), null);
  assert.equal(methods.includes('POST'), false);
  assert.equal(methods.includes('PUT'), false);
  assert.equal(server.signed, null);
});

test('read commands report an unverifiable board and a missing board as different failures', async () => {
  const server = fakeSkrynia();
  await api(server).initialize();
  const stranger = api(server);
  const absent = api(fakeSkrynia());

  for (const read of [() => stranger.listIssues(), () => stranger.getQueue(), () => stranger.listResources()]) {
    await assert.rejects(read, BoardTrustRequiredError);
  }
  for (const read of [() => absent.listIssues(), () => absent.getQueue(), () => absent.listResources()]) {
    await assert.rejects(read, BoardMissingError);
  }
  assert.equal(await absent.readBoard(), null);
});

test('reorderQueue commits the requested order and getQueue reads it back', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  await client.createIssue('One');
  await client.createIssue('Two');
  await client.createIssue('Three');

  const committed = await client.reorderQueue([3, 1, 2]);

  assert.deepEqual(committed, [3, 1, 2]);
  assert.deepEqual(await client.getQueue(), [3, 1, 2]);
  assert.equal(server.signed.operations.at(-1).kind, 'queue.reorder');
  assert.deepEqual(server.signed.operations.at(-1).payload, { numbers: [3, 1, 2] });
});

test('a reordered queue is durable for a fresh client that only loads the stored log', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  await writer.createIssue('One');
  await writer.createIssue('Two');
  await writer.reorderQueue([2, 1]);

  const fresh = api(server, { trustAnchor: initialized.trustAnchor });
  assert.deepEqual(await fresh.getQueue(), [2, 1]);
  assert.equal(fresh.hasWriteAccess(), false, 'a reader sees the order without being able to change it');
});

test('a rejected queue permutation leaves the stored log and the queue unchanged', async () => {
  const server = fakeSkrynia();
  const methods = [];
  const client = api(server, {
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return server.fetch(url, init); },
  });
  await client.initialize();
  await client.createIssue('One');
  await client.createIssue('Two');
  await client.reorderQueue([2, 1]);
  const stored = server.signed;

  // A partial list and an unknown number fail the open-issue invariant; a
  // duplicated one is refused earlier, by the payload parser.
  for (const [invalid, refusal] of [
    [[1], /every open issue exactly once/],
    [[2, 1, 1], /Queue-reorder payload is malformed/],
    [[1, 99], /every open issue exactly once/],
  ]) {
    await assert.rejects(() => client.reorderQueue(invalid), refusal);
    assert.equal(server.signed, stored, 'a rejected permutation must not write');
    assert.deepEqual(await client.getQueue(), [2, 1]);
  }
  assert.equal(methods.includes('PUT'), true, 'the accepted reorder did write once');
  assert.equal(server.signed.operations.length, 4);
});

test('reorderQueue without the queue.reorder capability writes nothing', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('One');
  await root.createIssue('Two');
  const child = await root.delegateCredential(['issue.create']);
  const stored = server.signed;

  const delegated = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  await assert.rejects(() => delegated.reorderQueue([2, 1]), /lacks required capability queue\.reorder/);

  assert.equal(server.signed, stored, 'a credential without the capability must not write');
  assert.deepEqual(await root.getQueue(), [1, 2]);
});

test('a queue reorder survives the ETag conflict of a concurrent valid writer', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('One');
  await root.createIssue('Two');
  await root.createIssue('Three');
  const operationsBefore = server.signed.operations.length;

  const rival = api(server, {
    credential: initialized.credential,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  // The rival commits a comment between this client's read and its write, so the
  // first PUT is refused with 412 and the reorder has to converge on retry.
  server.beforePut = async () => { await rival.comment(1, 'rival', 'racing'); };

  const committed = await root.reorderQueue([3, 1, 2]);

  assert.deepEqual(committed, [3, 1, 2]);
  assert.deepEqual(await root.getQueue(), [3, 1, 2]);
  assert.equal(server.signed.operations.length, operationsBefore + 2, 'the rival and the retry both committed');
  assert.deepEqual(
    server.signed.operations.slice(operationsBefore).map((operation) => operation.kind),
    ['issue.comment', 'queue.reorder'],
  );
});
