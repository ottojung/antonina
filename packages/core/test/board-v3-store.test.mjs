import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { credentialTrustAnchor } from '../dist/credential.js';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeSkrynia() {
  const objects = new Map();
  const requests = [];
  const capability = 'a'.repeat(64);

  function keyOf(url) {
    const parts = String(url).split('/');
    return decodeURIComponent(parts.at(-1));
  }

  function etag(entry) {
    return `"v${entry.revision}"`;
  }

  return {
    capability,
    requests,
    objects,
    clearRequests() { requests.length = 0; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const key = keyOf(url);
      requests.push({ method, key });
      const current = objects.get(key);

      if (method === 'GET') {
        return current === undefined
          ? new Response(null, { status: 404 })
          : jsonResponse(current.value, 200, etag(current));
      }

      if (method === 'POST') {
        if (current !== undefined) return new Response(null, { status: 409 });
        const headers = new Headers(init.headers);
        const mode = headers.get('X-Skrynia-Mode');
        if (mode !== 'capability-write' && mode !== 'public-write') {
          return jsonResponse({ error: 'mode required' }, 400);
        }
        const entry = {
          value: JSON.parse(String(init.body)),
          mode,
          capability: mode === 'capability-write' ? capability : null,
          revision: 1,
        };
        objects.set(key, entry);
        return jsonResponse(
          mode === 'capability-write'
            ? { mode, capability }
            : { mode },
          201,
        );
      }

      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        const headers = new Headers(init.headers);
        if (current.mode === 'capability-write'
            && headers.get('X-Skrynia-Capability') !== current.capability) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        const match = headers.get('If-Match');
        if (match !== null && match !== etag(current)) return new Response(null, { status: 412 });
        current.value = JSON.parse(String(init.body));
        current.revision += 1;
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 405 });
    },
  };
}

function deterministicStore(server) {
  let id = 0;
  return new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: () => `v3-test-${++id}`,
    now: () => new Date('2026-09-28T18:00:00.000Z'),
  });
}

test('first mutation migrates board-v2 into chunked v3 and leaves board-v2 frozen', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();
  const legacy = structuredClone(server.objects.get('board-v2').value);

  const committed = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: (state) => ({
      number: state.board.nextIssueNumber,
      title: 'Sharded issue',
      body: 'small canonical issue object',
    }),
  }, initialized.state.head);

  assert.equal(committed.state.board.issues.length, 1);
  assert.deepEqual(server.objects.get('board-v2').value, legacy);
  assert.ok(server.objects.has('board-v3-meta'));
  assert.ok(server.objects.has('board-v3-log-000000001'));
  assert.ok(server.objects.has('board-v3-issue-000000001'));
  assert.ok(server.objects.has('board-v3-issues-open-000000001'));

  const meta = server.objects.get('board-v3-meta').value;
  assert.equal(meta.operationCount, 2);
  assert.equal(meta.nextIssueNumber, 2);
  assert.equal(meta.openIssueCount, 1);
  assert.equal(meta.closedIssueCount, 0);
});

test('materialized issue reads do not fetch board-v2 or replay every log chunk', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'One key', body: '' },
  }, initialized.state.head);
  const afterCreate = await store.read(credentialTrustAnchor(initialized.credential));
  assert.ok(afterCreate);

  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'hello' },
  }, afterCreate.state.head);

  server.clearRequests();
  const issue = await store.getIssue(credentialTrustAnchor(initialized.credential), 1);

  assert.equal(issue?.title, 'One key');
  assert.equal(issue?.messages.length, 1);
  assert.equal(issue?.messages[0].body, 'hello');
  assert.equal(server.requests.some((request) => request.key === 'board-v2'), false);
  assert.equal(server.requests.some((request) => request.key.startsWith('board-v3-log-')), false);
  assert.deepEqual(
    server.requests.map((request) => request.key),
    ['board-v3-meta', 'board-v3-issue-000000001', 'board-v3-comments-000000001-000000001'],
  );
});

test('feed reads use only the v3 feed pages after migration', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  const created = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Feed issue', body: '' },
  }, initialized.state.head);
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'feed message' },
  }, created.state.head);

  server.clearRequests();
  const page = await store.readFeed(credentialTrustAnchor(initialized.credential), { limit: 10 });

  assert.equal(page?.entries.length, 2);
  assert.equal(page?.entries[0].kind, 'comment-added');
  assert.equal(server.requests.some((request) => request.key === 'board-v2'), false);
  assert.equal(server.requests.some((request) => request.key.startsWith('board-v3-log-')), false);
  assert.deepEqual(
    server.requests.map((request) => request.key),
    ['board-v3-meta', 'board-v3-feed-000000001'],
  );
});

test('v3 writes keep using the existing signing key even if the old storage capability is stale', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  const created = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Migrated', body: '' },
  }, initialized.state.head);

  const oldKeyWithStaleV2StorageCapability = {
    ...initialized.credential,
    storageCapability: 'b'.repeat(64),
  };
  const commented = await store.append(oldKeyWithStaleV2StorageCapability, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'root', body: 'still the same signing identity' },
  }, created.state.head);

  assert.equal(commented.state.board.issues[0].messages.length, 1);
  assert.equal(commented.state.board.issues[0].messages[0].body, 'still the same signing identity');
});
