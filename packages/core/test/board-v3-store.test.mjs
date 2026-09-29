import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

/**
 * `capability-write` mints a fresh per-object capability at POST, returns it
 * once, and keeps only its hash; it does not adopt the caller's header. A PUT or
 * DELETE of that object must present the minted value.
 */
function capabilityHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeSkrynia() {
  const objects = new Map();
  const requests = [];
  const issued = new Map();
  const capability = 'a'.repeat(64);
  let mintCount = 0;

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
    capabilityOf(key) { return issued.get(key) ?? null; },
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
        const minted = capabilityHash(`skrynia-minted:${key}:${++mintCount}`);
        const entry = {
          value: body,
          mode,
          capabilityHash: mode === 'capability-write' ? capabilityHash(minted) : null,
          revision: 1,
        };
        objects.set(key, entry);
        if (mode === 'capability-write') issued.set(key, minted);
        return jsonResponse(
          mode === 'capability-write'
            ? { mode, capability: minted }
            : { mode },
          201,
        );
      }

      if (method === 'PUT') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        const headers = new Headers(init.headers);
        if (current.capabilityHash !== null
            && capabilityHash(headers.get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        const match = headers.get('If-Match');
        if (match !== null && match !== etag(current)) {
          return jsonResponse({ error: 'etag_mismatch' }, 412);
        }
        current.value = body;
        current.revision += 1;
        return jsonResponse({ ok: true }, 200);
      }

      if (method === 'DELETE') {
        if (current === undefined) return new Response(null, { status: 404 });
        if (current.mode === 'immutable') return jsonResponse({ error: 'immutable' }, 403);
        if (current.capabilityHash !== null
            && capabilityHash(new Headers(init.headers).get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
          return jsonResponse({ error: 'invalid capability' }, 403);
        }
        objects.delete(key);
        return jsonResponse({ ok: true }, 200);
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

function materializedObjects(server) {
  return [...server.objects.entries()]
    .filter(([key]) => key !== 'board-v2');
}

function findMeta(server, head) {
  return materializedObjects(server).find(([, entry]) =>
    entry.value?.schemaVersion === 2
      && entry.value?.head === head
      && Array.isArray(entry.value?.directoryRefs)
      && typeof entry.value?.queueRef === 'string') ?? null;
}

test('initialize immediately replaces board-v2 history with one materialized pointer', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  const pointer = server.objects.get('board-v2').value;
  assert.equal(pointer.schemaVersion, 3);
  assert.equal(pointer.format, 'compact-materialized-snapshots');
  assert.equal(pointer.head, initialized.state.head);
  assert.equal(initialized.log, null);

  const meta = findMeta(server, pointer.head);
  assert.ok(meta);
  assert.equal(meta[1].value.revision, 1);
  assert.equal(meta[1].value.nextIssueNumber, 1);

  for (const [, entry] of server.objects) {
    assert.equal(Array.isArray(entry.value?.operations), false);
    assert.equal(Array.isArray(entry.value?.tailOperations), false);
  }
  assert.equal(
    server.requests.some((request) => Array.isArray(request.body?.operations)),
    false,
    'new-board initialization must never create an operation log',
  );
});

test('issue reads use only the pointer and materialized snapshots', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  const created = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'One key', body: '' },
  });
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'hello' },
  }, created.state.head);

  server.clearRequests();
  const issue = await store.getIssue(initialized.credential, 1);

  assert.equal(issue?.title, 'One key');
  assert.equal(issue?.messages.length, 1);
  assert.equal(issue?.messages[0].body, 'hello');
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
  assert.equal(server.requests.filter((request) => request.key === 'board-v2').length, 2);
  assert.equal(server.requests.some((request) => Array.isArray(request.body?.operations)), false);
});

test('overview reads list pages without fetching issue bodies or comments', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const issues = Array.from({ length: 51 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    body: index === 0 ? 'large body stays in its issue shard' : '',
    state: 'open',
    createdAt: '2026-09-28T17:00:00.000Z',
    updatedAt: '2026-09-28T17:00:00.000Z',
    messages: index === 0 ? [{
      id: 'sha256:' + 'A'.repeat(43),
      author: 'tester',
      body: 'large comment stays in its comment shard',
      createdAt: '2026-09-28T17:00:00.000Z',
    }] : [],
  }));
  const initialized = await store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 52,
    issues,
    resources: [],
    targets: [],
    dispatches: [],
  });

  const detailKeys = new Set(
    [...server.objects.entries()]
      .filter(([, entry]) => entry.value?.issue !== undefined || Array.isArray(entry.value?.messages))
      .map(([key]) => key),
  );

  server.clearRequests();
  const overview = await store.readOverview(initialized.credential);

  assert.equal(overview.issues.length, 51);
  assert.equal(overview.issues[0].messageCount, 1);
  assert.equal(overview.issues[0].hasBody, true);
  assert.equal(
    server.requests.some((request) => detailKeys.has(request.key)),
    false,
    'overview must not fetch issue or comment snapshots',
  );
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
});

test('fast mutations read summaries plus only the touched issue thread', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const issues = Array.from({ length: 51 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    body: index === 50 ? 'unrelated body' : '',
    state: 'open',
    createdAt: '2026-09-28T17:00:00.000Z',
    updatedAt: '2026-09-28T17:00:00.000Z',
    messages: index === 50 ? [{
      id: 'sha256:' + 'B'.repeat(43),
      author: 'other',
      body: 'unrelated comment',
      createdAt: '2026-09-28T17:00:00.000Z',
    }] : [],
  }));
  const initialized = await store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 52,
    issues,
    resources: [],
    targets: [],
    dispatches: [],
  });

  const unrelatedKeys = new Set(
    [...server.objects.entries()]
      .filter(([, entry]) =>
        entry.value?.number === 51
        && (entry.value?.issue !== undefined || Array.isArray(entry.value?.messages)))
      .map(([key]) => key),
  );

  server.clearRequests();
  await store.appendFast(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'localized write' },
  });

  assert.equal(
    server.requests.some((request) => unrelatedKeys.has(request.key)),
    false,
    'a write to issue 1 must not fetch issue 51 or its comments',
  );

  const secondPage = await store.readIssuePage(initialized.credential, 'open', 2);
  assert.equal(secondPage?.entries[0].number, 51);
  assert.equal(secondPage?.entries[0].messageCount, 1);
  assert.equal(secondPage?.entries[0].hasBody, true);
});

test('feed entries are materialized directly and read without history', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  const created = await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Feed issue', body: '' },
  });
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'feed message' },
  }, created.state.head);

  const storedFeedEntry = [...server.objects.values()]
    .flatMap((entry) => Array.isArray(entry.value?.entries) ? entry.value.entries : [])
    .find((entry) => entry?.kind === 'comment-added');
  assert.ok(storedFeedEntry);
  // A comment entry is self-contained. It carries its own author and body rather
  // than a reference into the issue's comment pages, because a reference from a
  // sealed feed page into a rewritten comment page is a backwards edge that
  // cannot be pinned -- and an entry in a sealed page is never rewritten, so
  // such a reference would dangle permanently once reclamation is enabled.
  assert.equal(storedFeedEntry.author, 'tester');
  assert.equal(storedFeedEntry.body, 'feed message');
  // And it names no shard at all: the feed is readable with no further lookups.
  assert.equal(Object.hasOwn(storedFeedEntry, 'commentRef'), false);
  assert.equal(Object.hasOwn(storedFeedEntry, 'commentIndex'), false);

  server.clearRequests();
  const page = await store.readFeed(initialized.credential, { limit: 10 });

  assert.equal(page?.entries.length, 2);
  assert.equal(page?.entries[0].kind, 'comment-added');
  assert.equal(page?.entries[0].author, 'tester');
  assert.equal(page?.entries[0].body, 'feed message');
  assert.equal(page?.entries[1].kind, 'issue-created');
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
});

test('the existing board storage key is the only live access key', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();

  await store.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Private locator', body: '' },
  });

  const wrongKey = {
    ...initialized.credential,
    storageCapability: 'b'.repeat(64),
  };

  await assert.rejects(
    () => store.readWithCredential(wrongKey),
    /board key/i,
  );
  await assert.rejects(
    () => store.append(wrongKey, {
      kind: 'issue.comment',
      payload: { number: 1, author: 'x', body: 'must not land' },
    }),
    /board key/i,
  );

  const issue = await store.getIssue(initialized.credential, 1);
  assert.equal(issue?.messages.length, 0);
});

test('concurrent writers serialize through the one capability-protected pointer', async () => {
  const server = fakeSkrynia();
  const first = deterministicStore(server);
  const initialized = await first.initialize();

  await first.append(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Seed', body: '' },
  });

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

  const final = await first.readWithCredential(initialized.credential);
  assert.ok(final);
  assert.deepEqual(
    final.state.board.issues.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    new Set(final.state.board.issues.map((issue) => issue.title)),
    new Set(['Seed', 'Left', 'Right']),
  );

  const pointer = server.objects.get('board-v2').value;
  assert.equal(pointer.revision, 4);
  assert.ok(findMeta(server, pointer.head));
});

test('commenting rewrites only the affected issue-list page plus snapshot leaves', async () => {
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

  server.clearRequests();
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'one-page update' },
  });

  const listPages = server.requests.filter(
    (request) => request.method === 'POST'
      && request.body?.state === 'open'
      && Array.isArray(request.body?.entries),
  );
  assert.equal(listPages.length, 1);
  assert.equal(listPages[0].body.page, 1);

  const pointerWrites = server.requests.filter(
    (request) => request.method === 'PUT' && request.key === 'board-v2',
  );
  assert.equal(pointerWrites.length, 1);
});
