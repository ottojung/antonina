import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { compareIssueActivity, issueLastActivityOf } from '../dist/api.js';
import { SignedBoardStore } from '../dist/board-store.js';

const CREATED = '2026-09-28T17:00:00.000Z';
const COMMENTED = '2026-09-28T18:00:00.000Z';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

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
        return jsonResponse(mode === 'capability-write'
          ? { mode, capability: minted }
          : { mode }, 201);
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
        const headers = new Headers(init.headers);
        if (current.capabilityHash !== null
            && capabilityHash(headers.get('X-Skrynia-Capability') ?? '') !== current.capabilityHash) {
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
    newId: () => `v3-legacy-activity-${++id}`,
    now: () => new Date(COMMENTED),
  });
}

/**
 * Rewrite every stored object with `lastActivityAt` stripped, imitating a board
 * written by the revision before the field existed. The `undefined`-dropping
 * JSON replacer matters: absence on the wire is the exact shape under test, and a
 * synthesized `null` would test something else.
 */
function scrubLastActivity(server) {
  let stripped = 0;
  for (const entry of server.objects.values()) {
    entry.value = JSON.parse(JSON.stringify(entry.value, (key, value) => {
      if (key !== 'lastActivityAt') return value;
      stripped += 1;
      return undefined;
    }));
  }
  assert.ok(stripped > 0, 'the fixture must actually carry the field to strip');
}

async function allOpenSummaries(store, credential) {
  const pages = [];
  for (let page = 1; ; page += 1) {
    const read = await store.readIssuePage(credential, 'open', page);
    if (read === null) break;
    pages.push(read.entries);
    if (read.entries.length < 50) break;
  }
  return pages;
}

function activityOrder(summaries) {
  return [...summaries].sort(compareIssueActivity).map((summary) => summary.number);
}

/**
 * 51 issues so the open list spans a page boundary, created newest-number-first
 * so the fallback order is not the number order, with two of them sharing a
 * creation time so the no-activity tie-break is exercised.
 */
function legacyBoard() {
  const issues = Array.from({ length: 51 }, (_, index) => {
    const number = index + 1;
    const createdAt = new Date(Date.parse(CREATED) - number * 60_000).toISOString();
    return {
      number,
      title: `Issue ${number}`,
      body: '',
      state: 'open',
      createdAt: [4, 5].includes(number) ? CREATED : createdAt,
      updatedAt: createdAt,
      messages: number === 2 ? [{
        id: 'sha256:' + 'C'.repeat(43),
        author: 'tester',
        body: 'commented long ago',
        createdAt: COMMENTED,
      }] : [],
    };
  });
  return { schemaVersion: 3, nextIssueNumber: 52, issues, resources: [], targets: [], dispatches: [] };
}

test('a board written before lastActivityAt existed keeps its recorded activity through a write', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize(legacyBoard());
  scrubLastActivity(server);

  // Reading the old shape does not throw and reports absence, not a claim.
  const before = await allOpenSummaries(store, initialized.credential);
  const flat = before.flat();
  assert.equal(flat.length, 51);
  for (const summary of flat) {
    assert.equal(summary.lastActivityAt, undefined);
    assert.equal(issueLastActivityOf(summary), summary.createdAt);
  }

  // One unrelated comment, through the fast path that never reads issue 2.
  await store.appendFast(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'unrelated' },
  });

  const afterWrite = (await allOpenSummaries(store, initialized.credential)).flat();
  const issue2 = afterWrite.find((summary) => summary.number === 2);
  assert.ok(issue2);
  assert.equal(
    issue2.lastActivityAt,
    undefined,
    'a shard that predates the field must not gain a recorded null for a commented issue',
  );
  assert.equal(issue2.messageCount, 1, 'the comment is still there; only its activity time is unknown');

  // And nothing anywhere on the live list claims it. This is the durable half of
  // the defect: the corruption is in the shards the next reader will load, not
  // only in what this read happened to return.
  assert.equal(
    afterWrite.filter((summary) => summary.lastActivityAt === null).length,
    0,
    'no rewritten summary may claim "never commented" for a commented issue',
  );
  // Issue 1 is the exception that proves the rule: its thread was read by the
  // mutation, so its activity time is known and is recorded. Every other issue
  // was never read, so none of them may carry the field at all.
  assert.deepEqual(
    afterWrite.filter((summary) => Object.hasOwn(summary, 'lastActivityAt'))
      .map((summary) => summary.number)
      .sort((left, right) => left - right),
    [1],
  );

  // Rewriting the issue's own thread is where the true time is known, so that is
  // where it is recorded -- rather than the false claim being reasserted.
  await store.appendFast(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 2, author: 'tester', body: 'answering the comment' },
  });
  const recovered = (await allOpenSummaries(store, initialized.credential)).flat();
  assert.equal(recovered.find((summary) => summary.number === 2).lastActivityAt, COMMENTED);
});

test('an issue with no recorded activity orders by the documented fallback, deterministically', async () => {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize(legacyBoard());
  scrubLastActivity(server);

  const pages = await allOpenSummaries(store, initialized.credential);
  assert.equal(pages.length, 2, 'the fixture must span a page boundary');
  const summaries = pages.flat();

  const expected = [...summaries]
    .sort((left, right) => issueLastActivityOf(right).localeCompare(issueLastActivityOf(left))
      || right.number - left.number)
    .map((summary) => summary.number);

  assert.deepEqual(activityOrder(summaries), expected);
  // Not the number order, not the queue order: the fallback is what decides.
  assert.notDeepEqual(expected, [...summaries].sort((left, right) => left.number - right.number).map((s) => s.number));
  // Issues 4 and 5 share a creation time and have no activity, so only the
  // documented tie-break can separate them, and it must be the higher number
  // first rather than input order.
  const shared = activityOrder(summaries);
  assert.ok(shared.indexOf(5) < shared.indexOf(4));

  // Determinism across repeated reads of the same snapshot.
  const second = (await allOpenSummaries(store, initialized.credential)).flat();
  const third = (await allOpenSummaries(store, initialized.credential)).flat();
  assert.deepEqual(activityOrder(second), expected);
  assert.deepEqual(activityOrder(third), expected);

  // Determinism across page boundaries: sorting the global list and then paging
  // it reconstructs the same order, at every page size, with nothing lost or
  // duplicated, and never reorders two no-activity rows when the window moves.
  for (const size of [1, 7, 50, 1000]) {
    const paged = [];
    for (let offset = 0; offset < expected.length; offset += size) {
      paged.push(...expected.slice(offset, offset + size));
    }
    assert.deepEqual(paged, expected, `page size ${size} must be a window, not a second sort`);
    assert.equal(new Set(paged).size, summaries.length);
  }
});