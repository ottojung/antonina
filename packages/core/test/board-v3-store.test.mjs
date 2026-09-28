import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';

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
      const body = init.body === undefined ? null : JSON.parse(String(init.body));
      requests.push({ method, key, body });
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
        if (!['capability-write', 'public-write', 'immutable'].includes(mode)) {
          return jsonResponse({ error: 'mode required' }, 400);
        }
        const objectCapability = mode === 'capability-write' ? capability : null;
        const entry = {
          value: body,
          mode,
          capability: objectCapability,
          revision: 1,
        };
        objects.set(key, entry);
        return jsonResponse(
          mode === 'capability-write'
            ? { mode, capability: objectCapability }
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
        current.value = body;
        current.revision += 1;
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 405 });
    },
  };
}

function findObject(server, predicate) {
  return [...server.objects.entries()].find(([, entry]) => predicate(entry.value)) ?? null;
}

function findMeta(server) {
  return findObject(
    server,
    (value) => value && value.schemaVersion === 1
      && Array.isArray(value.tailOperations)
      && Number.isInteger(value.operationCount),
  );
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
  assert.ok(findObject(server, (value) => value?.issue?.number === 1));
  assert.ok(findObject(server, (value) => value?.state === 'open' && Array.isArray(value.entries)));
  assert.ok(server.objects.has('board-v3-present'));

  const metaEntry = findMeta(server);
  assert.ok(metaEntry);
  const meta = metaEntry[1].value;
  assert.equal(meta.operationCount, 2);
  assert.equal(meta.tailOperations.length, 2);
  assert.equal(meta.logChunkCount, 0);
  assert.equal(meta.materializedRevision, 2);
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
  const afterCreate = await store.readWithCredential(initialized.credential);
  assert.ok(afterCreate);

  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'hello' },
  }, afterCreate.state.head);

  server.clearRequests();
  const issue = await store.getIssue(initialized.credential, 1);

  assert.equal(issue?.title, 'One key');
  assert.equal(issue?.messages.length, 1);
  assert.equal(issue?.messages[0].body, 'hello');
  assert.equal(server.requests.some((request) => request.key === 'board-v2'), false);
  assert.equal(server.requests.length, 4);
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
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
  const page = await store.readFeed(initialized.credential, { limit: 10 });

  assert.equal(page?.entries.length, 2);
  assert.equal(page?.entries[0].kind, 'comment-added');
  assert.equal(server.requests.some((request) => request.key === 'board-v2'), false);
  assert.equal(server.requests.length, 3);
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
});

test('a credential without the shared board key cannot read or write migrated v3', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Migrated', body: '' },
  }, initialized.state.head);

  const wrongBoardKey = {
    ...initialized.credential,
    storageCapability: 'b'.repeat(64),
  };

  await assert.rejects(
    () => store.readWithCredential(wrongBoardKey),
    /does not carry the board key/,
  );
  await assert.rejects(
    () => store.append(wrongBoardKey, {
      kind: 'issue.comment',
      payload: { number: 1, author: 'root', body: 'must not land' },
    }),
    /does not carry the board key/,
  );
});


test('concurrent v3 writers serialize through metadata CAS without losing either operation', async () => {
  const server = fakeSkrynia();
  const first = deterministicStore(server);
  const initialized = await first.initialize();

  const seed = await first.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Seed', body: '' },
  }, initialized.state.head);

  const left = deterministicStore(server);
  const right = deterministicStore(server);
  await Promise.all([
    left.append(initialized.credential, {
      kind: 'issue.create',
      payload: (state) => ({
        number: state.board.nextIssueNumber,
        title: 'Left',
        body: '',
      }),
    }, seed.state.head),
    right.append(initialized.credential, {
      kind: 'issue.create',
      payload: (state) => ({
        number: state.board.nextIssueNumber,
        title: 'Right',
        body: '',
      }),
    }, seed.state.head),
  ]);

  const final = await first.readWithCredential(initialized.credential, seed.state.head);
  assert.ok(final);
  assert.equal(final.state.board.issues.length, 3);
  assert.deepEqual(
    final.state.board.issues.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    new Set(final.state.board.issues.map((issue) => issue.title)),
    new Set(['Seed', 'Left', 'Right']),
  );
  const metaEntry = findMeta(server);
  assert.ok(metaEntry);
  const meta = metaEntry[1].value;
  assert.equal(meta.operationCount, 4);
  assert.equal(meta.materializedRevision, 4);
  assert.equal(meta.tailOperations.length, 4);
});


test('commenting an issue rewrites only its one issue-list page', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const issues = Array.from({ length: 51 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    body: '',
    state: 'open',
    createdAt: '2026-09-28T17:00:00.000Z',
    updatedAt: '2026-09-28T17:00:00.000Z',
    messages: [],
  }));
  const initialized = await store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 52,
    issues,
    resources: [],
    targets: [],
    dispatches: [],
  });

  const migrated = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 52, title: 'Migration trigger', body: '' },
  }, initialized.state.head);

  server.clearRequests();
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'one-page update' },
  }, migrated.state.head);

  const pageWrites = server.requests.filter(
    (request) => request.method === 'PUT'
      && request.body?.state === 'open'
      && Array.isArray(request.body?.entries),
  );
  assert.equal(pageWrites.length, 1);
  assert.equal(pageWrites[0].body.page, 1);
});
