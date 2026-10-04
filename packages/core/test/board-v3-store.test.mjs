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

/**
 * Every materialized shard that carries the review record, in either place it
 * is written: the issue snapshot (`entry.value.issue.review`) and the list
 * projection (`entry.value.entries[].review`). Both are overwritten together by
 * the malformed-read tests below, because a reader is entitled to serve either
 * and a reader that served only the intact one would be reading a clear issue
 * off a shard that does not say so.
 */
function shardsCarryingReview(server) {
  return [...server.objects.entries()].filter(([, entry]) =>
    entry.value?.issue?.review !== undefined
    || (entry.value?.entries ?? []).some((summary) => summary?.review !== undefined));
}

/**
 * Rewrites the stored `review` of every shard `shardsCarryingReview` names, in
 * place, the way another writer of the same object would. The ref still names
 * this content's digest, which is what makes the read path's refusal the only
 * thing standing between a value this build does not accept and a clear issue.
 */
async function overwriteStoredReview(server, shards, nextReview) {
  for (const [key] of shards) {
    const entry = server.objects.get(key);
    const stored = entry.value.issue !== undefined
      ? { ...entry.value, issue: { ...entry.value.issue, review: nextReview(entry.value.issue.review) } }
      : {
        ...entry.value,
        entries: entry.value.entries.map((summary) => (
          summary.review === undefined ? summary : { ...summary, review: nextReview(summary.review) }
        )),
      };
    const response = await server.fetch(`https://example.invalid/_skrynia/store/antonina/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Skrynia-Capability': server.capabilityOf(key) },
      body: JSON.stringify(stored),
    });
    assert.equal(response.status, 200, 'the contract double must model anonymous overwrite');
  }
}

/** The rewritten value, read back the way any other reader would see it. */
function storedReviewOf(server, key) {
  const value = server.objects.get(key).value;
  return (value.issue ?? value.entries[0]).review;
}

/** The `outstandingBlocks` of one shard, in either place it is materialized. */
function storedBlocksOf(server, key) {
  const value = server.objects.get(key).value;
  return (value.issue ?? value.entries[0]).outstandingBlocks;
}

/** Every shard whose stored `outstandingBlocks` this build materialized. */
function shardsCarryingBlocks(server) {
  return [...server.objects.entries()].filter(([, entry]) =>
    entry.value?.issue?.outstandingBlocks !== undefined
    || (entry.value?.entries ?? []).some((summary) => summary?.outstandingBlocks !== undefined));
}

async function overwriteStoredBlocks(server, shards, blocks) {
  for (const [key] of shards) {
    const entry = server.objects.get(key);
    const stored = entry.value.issue !== undefined
      ? { ...entry.value, issue: { ...entry.value.issue, outstandingBlocks: blocks } }
      : {
        ...entry.value,
        entries: entry.value.entries.map((summary) => ({ ...summary, outstandingBlocks: blocks })),
      };
    const response = await server.fetch(`https://example.invalid/_skrynia/store/antonina/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Skrynia-Capability': server.capabilityOf(key) },
      body: JSON.stringify(stored),
    });
    assert.equal(response.status, 200, 'the contract double must model anonymous overwrite');
    assert.deepEqual(storedBlocksOf(server, key), blocks);
  }
}

/**
 * The two positions an issue is materialized in, as predicates over a shard, so
 * a test can put a shape in the snapshot alone or in the projection alone and
 * read the consequence in only one of the two readers.
 */
function isSnapshotShard([, entry]) {
  return entry.value?.issue !== undefined;
}

function isProjectionShard([, entry]) {
  return Array.isArray(entry.value?.entries);
}

async function putShard(server, key, stored) {
  const response = await server.fetch(`https://example.invalid/_skrynia/store/antonina/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Skrynia-Capability': server.capabilityOf(key) },
    body: JSON.stringify(stored),
  });
  assert.equal(response.status, 200, 'the contract double must model anonymous overwrite');
}

/**
 * Writes `value` into `field` in exactly one materialized position, leaving
 * every other shard and every other field of the same entry as this build wrote
 * it, so a test can put one shape in the snapshot alone or in the projection
 * alone and read the consequence in only one reader.
 */
async function writeStoredField(server, shards, field, value) {
  for (const [key] of shards) {
    const entry = server.objects.get(key);
    const stored = entry.value.issue !== undefined
      ? { ...entry.value, issue: { ...entry.value.issue, [field]: value } }
      : {
        ...entry.value,
        entries: entry.value.entries.map((summary) => (
          summary[field] === undefined ? summary : { ...summary, [field]: value }
        )),
      };
    await putShard(server, key, stored);
    const reread = server.objects.get(key).value;
    assert.deepEqual(
      (reread.issue ?? reread.entries[0])[field], value,
      'the overwrite must land, or the refusal below would prove nothing',
    );
  }
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

// Required fix 4 of /workspace/BOARD44-REVIEW-2600.md: the store's own fail-closed
// read of a stored verdict had no test at all -- mutation M5 turned that reader
// into a fail-open one and the whole suite stayed green. The shard below is
// written by this build, then its stored verdict is replaced with a value this
// build does not name, exactly as a shard written by something else would look.
// The second round covers the other half of that reader: a verdict that is
// well formed in every field except its commit id (review 44e05's required fix 2,
// mutation M4a), which is the shape a writer that abbreviates a digest would
// leave behind.
test('a shard carrying a verdict this build does not name is refused, not read as no review', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();
  const created = await store.appendFast(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Reviewed', body: '' },
  });
  await store.appendFast(initialized.credential, {
    kind: 'review.record',
    payload: {
      number: 1,
      commit: 'a'.repeat(40),
      verdict: 'request-changes',
      reviewer: 'independent',
      rationale: 'recommend no merge',
    },
  }, created.state.head);

  const before = await store.getIssue(initialized.credential, 1);
  assert.equal(before.review.verdict, 'request-changes');
  assert.equal(before.review.commit, 'a'.repeat(40));

  // Both places the verdict is materialized -- the issue snapshot and the list
  // projection -- are overwritten, for the reason the helpers record.
  const carrying = shardsCarryingReview(server);
  assert.ok(carrying.length >= 2, 'the verdict must be materialized in both the snapshot and the projection');

  await overwriteStoredReview(server, carrying, (review) => ({ ...review, verdict: 'recommend-no-merge' }));
  for (const [key] of carrying) {
    assert.equal(storedReviewOf(server, key).verdict, 'recommend-no-merge');
  }

  // A reader that has never seen the write -- a restart, or a second client --
  // refuses. It does not fall back to "this issue carries no review", which is
  // the read that would let a blocked handoff be declared complete.
  const reader = deterministicStore(server);
  await assert.rejects(
    () => reader.getIssue(initialized.credential, 1),
    /stored review verdict is malformed/,
  );
  await assert.rejects(
    () => reader.readIssuePage(initialized.credential, 'open', 1),
    /stored review verdict is malformed/,
  );

  // The commit-id gate is the same refusal for a verdict this build otherwise
  // reads field for field. An abbreviated or upper-case digest is not an object
  // id, so the block it names could never be compared against an approval's
  // canonical commit, and reading it would launder the block into a value that
  // matches nothing. Repairing the verdict and keeping every other field
  // canonical isolates the commit id as the only reason the shard is refused.
  const nonCanonicalCommits = [
    ['an abbreviated digest', 'a'.repeat(7)],
    ['an upper-case digest', 'A'.repeat(40)],
  ];
  for (const [what, commit] of nonCanonicalCommits) {
    await overwriteStoredReview(server, carrying, (review) => ({
      ...review,
      verdict: 'request-changes',
      commit,
    }));
    for (const [key] of carrying) {
      const stored = storedReviewOf(server, key);
      assert.equal(stored.commit, commit, `the overwrite must land ${what}`);
      assert.deepEqual(
        { verdict: stored.verdict, reviewer: stored.reviewer, rationale: stored.rationale },
        { verdict: 'request-changes', reviewer: 'independent', rationale: 'recommend no merge' },
        'the rest of the review must stay well formed, so only the commit id can be the reason for refusal',
      );
    }
    const rereader = deterministicStore(server);
    await assert.rejects(
      () => rereader.getIssue(initialized.credential, 1),
      /stored review verdict is malformed/,
      `getIssue must refuse a review whose commit is ${what}`,
    );
    await assert.rejects(
      () => rereader.readIssuePage(initialized.credential, 'open', 1),
      /stored review verdict is malformed/,
      `readIssuePage must refuse a review whose commit is ${what}`,
    );
  }
});

// Repairs D1 and D3 of /workspace/BOARD44-F1REVIEW-1128Z.md. Both were the same
// one-line `=== null` arm written twice, and they failed in opposite ways: in the
// issue-snapshot reader it mapped a stored explicit null to "absent", so a
// blocked issue was served as never reviewed and `issue.close` completed it
// (the false clear, and mutant M8 showed no test covered the arm); in the
// projection reader it was meant to tolerate the null but could not take the key
// back out of the spread of `clone(entry)` that preceded it, so a stored null
// reached `issueFromSummary` and the mutation path died of
// `TypeError: summary.outstandingBlocks is not iterable` instead of naming a
// refusal.
//
// The shape is one no writer in this repository produces -- `coreOf` omits the
// key -- and the model already refuses it (`isIssue` accepts `review` only when
// it is undefined or `isReview`, and `isReview(null)` is false), so a stored null
// is a shard written by something this build does not understand and the only
// honest reading of it is the named refusal. Each shape is put in one
// materialized position alone, so the assertion names the reader that refuses it.
test('a stored null is refused by name in each materialized position, and never reads as no review', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();
  const created = await store.appendFast(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Blocked', body: '' },
  });
  await store.appendFast(initialized.credential, {
    kind: 'review.record',
    payload: {
      number: 1,
      commit: 'a'.repeat(40),
      verdict: 'request-changes',
      reviewer: 'independent',
      rationale: 'recommend no merge',
    },
  }, created.state.head);

  // The shard is written by this build first, so the field under test exists in
  // both positions before anything is corrupted; otherwise a null would be
  // indistinguishable from the absent key that legitimately means "no review".
  assert.deepEqual((await store.getIssue(initialized.credential, 1)).outstandingBlocks, ['a'.repeat(40)]);
  const reviewShards = shardsCarryingReview(server);
  const blockShards = shardsCarryingBlocks(server);
  assert.ok(reviewShards.length >= 2, 'the verdict must be materialized in both the snapshot and the projection');
  assert.ok(blockShards.length >= 2, 'the block list must be materialized in both the snapshot and the projection');

  // Each entry is [which position, which shard list, which field, which refusal].
  // Each shape is written and then restored to the value this build wrote before
  // the next one, so no refusal below can be the previous shape's refusal still
  // sitting on the shard.
  const isSnapshot = (where) => where === 'the issue snapshot';
  const shapes = [
    ['the issue snapshot', isSnapshotShard, 'review', /stored review verdict is malformed/],
    ['the list projection', isProjectionShard, 'review', /stored review verdict is malformed/],
    ['the issue snapshot', isSnapshotShard, 'outstandingBlocks', /stored outstanding review blocks are malformed/],
    ['the list projection', isProjectionShard, 'outstandingBlocks', /stored outstanding review blocks are malformed/],
  ];
  for (const [where, inPosition, field, refusal] of shapes) {
    const carried = field === 'review' ? reviewShards : blockShards;
    const targets = carried.filter(inPosition);
    const others = carried.filter((shard) => !inPosition(shard));
    assert.ok(targets.length >= 1, `${where} must materialize ${field}, or the shape below proves nothing`);
    assert.ok(others.length >= 1, `${where}'s twin position must exist, or the shape below proves nothing`);
    const storedField = (key) => (
      server.objects.get(key).value.issue ?? server.objects.get(key).value.entries[0]
    )[field];
    const pristine = targets.map(([key]) => storedField(key));
    const otherPristine = others.map(([key]) => storedField(key));

    await writeStoredField(server, targets, field, null);
    const reader = deterministicStore(server);
    const read = isSnapshot(where)
      ? () => reader.getIssue(initialized.credential, 1)
      : () => reader.readIssuePage(initialized.credential, 'open', 1);
    // The refusal must be this build's own, at the reader under test, and not a
    // throw from somewhere downstream of it: a `TypeError` on the way out of
    // `issueFromSummary` would be the D3 crash wearing a different message.
    await assert.rejects(read, refusal, `${where} must refuse a stored ${field} of null by name`);
    await read().then(
      (served) => assert.fail(`a stored ${field} of null in ${where} was read as a clear record`),
      (error) => {
        assert.equal(
          error.constructor.name, 'SignedBoardStoreError',
          `${where} must refuse with the store's own refusal type, not ${error.constructor.name}`,
        );
        assert.match(error.message, refusal);
      },
    );

    // The twin position, untouched, still serves the intact record: what is
    // refused is the shape, not the board.
    const other = deterministicStore(server);
    const served = isSnapshot(where)
      ? (await other.readIssuePage(initialized.credential, 'open', 1)).entries[0]
      : await other.getIssue(initialized.credential, 1);
    const otherValue = served[field];
    assert.ok(
      otherPristine.some((value) => JSON.stringify(value) === JSON.stringify(otherValue)),
      `${where}'s twin position must be unaffected by the shape written here`,
    );

    targets.forEach(([key], index) => writeStoredField(server, [[key]], field, pristine[index]));
    const restored = targets.map(([key]) => storedField(key));
    assert.deepEqual(restored, pristine, 'each shape must be restored before the next');
  }
});

// Required fix 1 of review 44e05 (/workspace/BOARD44-FIXES-REVIEW-0450.md):
// `parseStoredOutstandingBlocks` shipped with no test of its failure mode --
// mutation M6 dropped both its shape checks and the full core suite stayed
// green. The shard below is written by this build, so its stored block list is
// exactly the list this build wrote, and is then replaced with a list this
// build cannot compare.
test('a shard carrying outstanding blocks this build cannot compare is refused, not read as unblocked', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();
  const created = await store.appendFast(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Blocked', body: '' },
  });
  await store.appendFast(initialized.credential, {
    kind: 'review.record',
    payload: {
      number: 1,
      commit: 'a'.repeat(40),
      verdict: 'request-changes',
      reviewer: 'independent',
      rationale: 'recommend no merge',
    },
  }, created.state.head);

  const before = await store.getIssue(initialized.credential, 1);
  assert.deepEqual(before.outstandingBlocks, ['a'.repeat(40)]);

  const carrying = shardsCarryingBlocks(server);
  assert.ok(carrying.length >= 2, 'the block list must be materialized in both the snapshot and the projection');

  // Two shapes, because the two checks are two claims. A non-canonical entry is
  // a commit id this build cannot resolve, and a duplicate is a list that no
  // append-only growth-only writer can have produced -- so either one means the
  // shard was not written by the record this build reads.
  const malformedLists = [
    ['a non-canonical block id', ['a'.repeat(7)]],
    ['a duplicated block id', ['b'.repeat(40), 'b'.repeat(40)]],
  ];
  for (const [what, blocks] of malformedLists) {
    await overwriteStoredBlocks(server, carrying, blocks);
    const reader = deterministicStore(server);
    await assert.rejects(
      () => reader.getIssue(initialized.credential, 1),
      /stored outstanding review blocks are malformed/,
      `getIssue must refuse ${what}`,
    );
    await assert.rejects(
      () => reader.readIssuePage(initialized.credential, 'open', 1),
      /stored outstanding review blocks are malformed/,
      `readIssuePage must refuse ${what}`,
    );
  }
});

// Review 44a02 mutation M7: `issueFromSummary` is claimed to be off the write
// path. It is not. `readMutationBundle` builds the working board from the list
// projection, and an unrelated compact mutation (a comment on another issue)
// rewrites the projection for every issue from that working board. So the two
// lines below are the only thing standing between an untouched issue's stored
// review verdict and a projection that has silently dropped it -- which is a
// clear issue at the completion gate, on an issue nobody touched. Dropping them
// left all 275 core tests green.
test('a compact mutation of one issue keeps every other issue review verdict in the projection', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize();
  const created = await store.appendFast(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 1, title: 'Blocked', body: '' },
  });
  await store.appendFast(initialized.credential, {
    kind: 'issue.create',
    payload: { number: 2, title: 'Unrelated', body: '' },
  }, created.state.head);
  await store.appendFast(initialized.credential, {
    kind: 'review.record',
    payload: {
      number: 1,
      commit: 'a'.repeat(40),
      verdict: 'request-changes',
      reviewer: 'independent',
      rationale: 'recommend no merge',
    },
  });

  // A reader that has never seen the write must see the block in both places the
  // completion gate can read it, before any mutation at all.
  const reader = deterministicStore(server);
  assert.deepEqual((await reader.getIssue(initialized.credential, 1)).outstandingBlocks, ['a'.repeat(40)]);
  const pageBefore = await reader.readIssuePage(initialized.credential, 'open', 1);
  assert.deepEqual(
    pageBefore.entries.find((entry) => entry.number === 1).outstandingBlocks,
    ['a'.repeat(40)],
    'precondition: the projection carries the block',
  );

  // A mutation that touches only issue 2. Issue 1 is not named by the operation.
  await store.appendFast(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 2, author: 'front', body: 'unrelated' },
  });

  const after = deterministicStore(server);
  assert.deepEqual(
    (await after.getIssue(initialized.credential, 1)).outstandingBlocks,
    ['a'.repeat(40)],
    "an untouched issue's outstanding blocks survive a mutation of another issue",
  );
  assert.equal((await after.getIssue(initialized.credential, 1)).review.verdict, 'request-changes');
  const pageAfter = await after.readIssuePage(initialized.credential, 'open', 1);
  const entry = pageAfter.entries.find((candidate) => candidate.number === 1);
  assert.deepEqual(
    entry.outstandingBlocks,
    ['a'.repeat(40)],
    "an untouched issue's block survives in the projection the next mutation rebuilds from",
  );
  assert.equal(entry.review.verdict, 'request-changes');
});
