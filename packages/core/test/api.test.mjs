import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSigningKey } from '../dist/canonical.js';
import { createBoardCredential } from '../dist/credential.js';
import {
  BoardApi,
  BoardDeletedError,
  BoardMissingError,
  BOARD_CAPABILITIES,
  BoardStorageRejectedError,
  BoardTrustRequiredError,
  SignedBoardStoreError,
} from '../dist/api.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

const STAMP = '2026-09-25T12:00:00.000Z';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
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

async function anotherCredentialWithSameBoardKey(initialized) {
  const child = await generateSigningKey();
  return createBoardCredential(
    initialized.trustAnchor,
    child,
    initialized.credential.storageCapability,
  );
}

test('explicit initialization establishes trust, credential, and verified editing access', async () => {
  const server = fakeSkrynia();
  const client = api(server);

  assert.equal(await client.signedBoardExists(), false);
  assert.equal(client.hasWriteAccess(), false);

  const initialized = await client.initialize();
  assert.equal(initialized.state.board.nextIssueNumber, 1);
  assert.equal(initialized.credential.keyId, initialized.trustAnchor.rootKeyId);
  assert.equal(client.hasWriteAccess(), true);
  assert.equal(await client.signedBoardExists(), true);

  const created = await client.createIssue('First', 'signed board');
  assert.equal(created.number, 1);
  const commented = await client.comment(1, 'root', 'hello');
  assert.equal(commented.messages[0].body, 'hello');
  assert.ok(client.getRememberedHead());
});

test('a trust anchor alone cannot read the board', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  await writer.createIssue('Hidden without key');

  const reader = api(server, {
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.state.head,
  });
  await assert.rejects(() => reader.loadBoard(), BoardTrustRequiredError);
  await assert.rejects(() => reader.createIssue('Blocked'), /credential is required|no board credential/);
  assert.equal(reader.hasWriteAccess(), false);
});

test('historically issued credentials have full board access regardless old scope', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const child = await anotherCredentialWithSameBoardKey(initialized);

  const delegated = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.state.head,
  });
  const created = await delegated.createIssue('Existing key');
  await delegated.close(created.number);
  assert.equal(delegated.hasWriteAccess(), true);
  assert.deepEqual(new Set(delegated.getEffectiveCapabilities()), new Set(BOARD_CAPABILITIES));
});

test('new delegation and revocation APIs are disabled', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  await root.initialize();

  await assert.rejects(() => root.delegateCredential(['issue.create']), /delegation is disabled/);
  await assert.rejects(() => root.revokeCredential('ed25519:' + 'A'.repeat(43)), /revocation is disabled/);
  await assert.rejects(() => root.listAuthorities(), /authority lists are not part of the live access model/);
});

test('a wrong shared board key is refused during credential verification', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };

  const methods = [];
  const watched = api(server, {
    credential: stale,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: initialized.state.head,
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return server.fetch(url, init); },
  });

  await assert.rejects(
    () => watched.verifyCredential(),
    /board key/i,
  );
  assert.equal(methods.includes('PUT'), false, 'a wrong key never reaches the commit pointer');
  assert.equal(watched.hasWriteAccess(), false);
});

test('storage read failures and wrong board keys are reported as authentication failures', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();

  let forbidden = false;
  const reader = api(server, {
    credential: initialized.credential,
    fetch: async (url, init = {}) => {
      if (forbidden && (init.method ?? 'GET') === 'GET') {
        return jsonResponse({ error: 'forbidden' }, 403);
      }
      return server.fetch(url, init);
    },
  });
  assert.equal((await reader.verifyCredential()).canEdit, true);

  forbidden = true;
  await assert.rejects(
    () => reader.createIssue('Unreadable'),
    /failed \(403\)/,
  );
  assert.equal(reader.hasWriteAccess(), true, 'a transport read failure does not revoke the board key');

  const stale = { ...initialized.credential, storageCapability: 'b'.repeat(64) };
  const writer = api(server, { credential: stale });
  await assert.rejects(
    () => writer.createIssue('Wrong key'),
    /board key/i,
  );
  assert.equal(writer.hasWriteAccess(), false);
});

test('a malformed credential cannot read the board', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Visible');

  const other = await generateSigningKey();
  const impostor = {
    ...initialized.credential,
    keyId: initialized.credential.keyId,
    publicKey: other.publicKey,
    privateKey: other.privateKey,
  };
  const client = api(server, { credential: impostor });
  await assert.rejects(() => client.readBoard(), /key ID does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /key ID does not match its public key/);
});

test('a credential with a foreign private key cannot read the board', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const other = await generateSigningKey();
  const impostor = { ...initialized.credential, privateKey: other.privateKey };
  const client = api(server, { credential: impostor });
  await assert.rejects(() => client.readBoard(), /private key does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /private key does not match its public key/);
});

test('a credential with a forged key ID cannot read the board', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const impostor = { ...initialized.credential, keyId: `ed25519:${'A'.repeat(43)}` };
  const client = api(server, { credential: impostor });
  await assert.rejects(() => client.readBoard(), /key ID does not match its public key/);
  await assert.rejects(() => client.createIssue('Impostor'), /key ID does not match its public key/);
});

test('any well-formed credential carrying the shared board key has full access', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const foreign = await generateSigningKey();
  const client = api(server, {
    credential: {
      ...initialized.credential,
      keyId: foreign.keyId,
      publicKey: foreign.publicKey,
      privateKey: foreign.privateKey,
    },
  });
  assert.deepEqual(await client.readBoard(), initialized.state.board);
  const created = await client.createIssue('Same board key');
  assert.equal(created.title, 'Same board key');
});

test('a deleted board is reported as its own state to a key holder', async () => {
  const server = fakeSkrynia();
  const owner = api(server);
  const initialized = await owner.initialize();
  await owner.deleteBoard();

  const reader = api(server, { credential: initialized.credential });
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
    rememberedHead: initialized.state.head,
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return server.fetch(url, init); },
  });
  const access = await writer.verifyCredential();
  assert.equal(access.canEdit, true);

  const revisionBeforeDelete = server.signed.revision;
  await owner.deleteBoard();
  methods.length = 0;

  await assert.rejects(() => writer.createIssue('Too late'), BoardDeletedError);
  assert.equal(methods.includes('PUT'), false, 'a deleted board is noticed before another commit is sent');
  assert.equal(methods.includes('POST'), false, 'a deleted board creates no shard');
  assert.equal(server.signed.revision, revisionBeforeDelete + 1);
});

test('old signing identity metadata does not restrict the shared board key', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  const child = await anotherCredentialWithSameBoardKey(initialized);

  const client = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
  });
  const created = await client.createIssue('Still valid');
  await client.close(created.number);
  assert.equal(client.hasWriteAccess(), true);
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

test('an existing board is unreadable until its board credential is configured', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  const stranger = api(server);

  await assert.rejects(() => stranger.readBoard(), (error) => {
    assert.ok(error instanceof BoardTrustRequiredError);
    return /no board credential/.test(error.message);
  });

  const anchorOnly = api(server, { trustAnchor: initialized.trustAnchor });
  await assert.rejects(() => anchorOnly.readBoard(), BoardTrustRequiredError);

  const reader = api(server, { credential: initialized.credential });
  assert.deepEqual(await reader.readBoard(), initialized.state.board);
});

test('a second initializer is refused before it can replace the trust root', async () => {
  const server = fakeSkrynia();
  const first = api(server);
  const initialized = await first.initialize();
  const pointer = structuredClone(server.signed);

  const second = api(server);
  await assert.rejects(() => second.initialize(), /The Antonina board already exists/);

  assert.deepEqual(server.signed, pointer);
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

test('read commands require the board key while readBoard still reports a missing board as null', async () => {
  const server = fakeSkrynia();
  await api(server).initialize();
  const stranger = api(server);
  const absent = api(fakeSkrynia());

  for (const read of [() => stranger.listIssues(), () => stranger.getQueue(), () => stranger.listResources()]) {
    await assert.rejects(read, /credential|required|board credential/);
  }
  for (const read of [() => absent.listIssues(), () => absent.getQueue(), () => absent.listResources()]) {
    await assert.rejects(read, /does not exist/);
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
  const before = server.signed.revision;

  const committed = await client.reorderQueue([3, 1, 2]);

  assert.deepEqual(committed, [3, 1, 2]);
  assert.deepEqual(await client.getQueue(), [3, 1, 2]);
  assert.equal(server.signed.revision, before + 1);
});

test('a reordered queue is durable for a fresh client holding the board key', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  await writer.createIssue('One');
  await writer.createIssue('Two');
  await writer.reorderQueue([2, 1]);

  const fresh = api(server, { credential: initialized.credential });
  assert.deepEqual(await fresh.getQueue(), [2, 1]);
  assert.equal(fresh.hasWriteAccess(), true);
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
  const stored = structuredClone(server.signed);

  // A partial list and an unknown number fail the open-issue invariant; a
  // duplicated one is refused earlier, by the payload parser.
  for (const [invalid, refusal] of [
    [[1], /every open issue exactly once/],
    [[2, 1, 1], /Queue-reorder payload is malformed/],
    [[1, 99], /every open issue exactly once/],
  ]) {
    await assert.rejects(() => client.reorderQueue(invalid), refusal);
    assert.deepEqual(server.signed, stored, 'a rejected permutation must not change board content');
    assert.deepEqual(await client.getQueue(), [2, 1]);
  }
  assert.equal(methods.includes('PUT'), true, 'the accepted reorder did commit the pointer');
  assert.deepEqual(server.signed, stored);
});

test('an existing issued key can reorder regardless of its old capability list', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('One');
  await root.createIssue('Two');
  const child = await anotherCredentialWithSameBoardKey(initialized);

  const delegated = api(server, {
    credential: child,
    trustAnchor: initialized.trustAnchor,
    rememberedHead: root.getRememberedHead(),
  });
  assert.deepEqual(await delegated.reorderQueue([2, 1]), [2, 1]);
  assert.deepEqual(await delegated.getQueue(), [2, 1]);
});

test('a queue reorder survives the ETag conflict of a concurrent valid writer', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('One');
  await root.createIssue('Two');
  await root.createIssue('Three');
  const revisionBefore = server.signed.revision;

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
  assert.equal(server.signed.revision, revisionBefore + 2, 'the rival and the retry both committed');
  const issue = await root.getIssue(1);
  assert.equal(issue.messages.at(-1)?.body, 'racing');
});


test('new issue bodies and comments are limited to 10000 Unicode characters', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();

  const bodyAtLimit = '🙂'.repeat(10000);
  const created = await client.createIssue('At the limit', bodyAtLimit);
  assert.equal(Array.from(created.body).length, 10000);

  const beforeRejectedIssue = server.signed.revision;
  await assert.rejects(
    () => client.createIssue('Too long', 'x'.repeat(10001)),
    /Issue body must be at most 10000 characters/,
  );
  assert.equal(server.signed.revision, beforeRejectedIssue, 'a rejected issue body must not mutate storage');

  const commentAtLimit = 'λ'.repeat(10000);
  const commented = await client.comment(created.number, 'root', commentAtLimit);
  assert.equal(Array.from(commented.messages.at(-1).body).length, 10000);

  const beforeRejectedComment = server.signed.revision;
  await assert.rejects(
    () => client.comment(created.number, 'root', 'y'.repeat(10001)),
    /Comment body must be at most 10000 characters/,
  );
  assert.equal(server.signed.revision, beforeRejectedComment, 'a rejected comment must not mutate storage');
});
