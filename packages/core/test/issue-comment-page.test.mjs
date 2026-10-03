import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

/**
 * Board issue 174: an issue's conversation is stored in 50-message comment
 * shards, and reading one page of it has to read one shard.
 *
 * Every assertion in this file that claims boundedness counts the storage GETs
 * the read actually made against the comment shards that exist. Asserting that a
 * returned array holds 50 messages proves nothing: the previous whole-thread
 * reassembly returned every message of every shard and satisfied that assertion
 * too. What distinguishes the two is how many shards crossed the wire.
 */

const STAMP = '2026-09-28T17:00:00.000Z';

function deterministicStore(server) {
  let id = 0;
  return new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: () => `v3-comments-${++id}`,
    now: () => new Date('2026-09-28T18:00:00.000Z'),
  });
}

/** The issue's own shard: the one object that carries both a `number` and an `issue`. */
function issueShardKeys(server, number) {
  return new Set([...server.objects.entries()]
    .filter(([, entry]) => entry.value?.number === number && entry.value?.issue !== undefined)
    .map(([key]) => key));
}

/** Every comment shard for an issue: the objects that carry `messages`. */
function commentShardKeys(server, number) {
  return new Set([...server.objects.entries()]
    .filter(([, entry]) => entry.value?.number === number && Array.isArray(entry.value?.messages))
    .map(([key]) => key));
}

function commentShardReads(server, keys) {
  return server.requests.filter((request) => request.method === 'GET' && keys.has(request.key)).map((request) => request.key);
}

function messages(count, author = 'tester') {
  return Array.from({ length: count }, (_, index) => ({
    id: `sha256:` + (index + 1).toString(16).padStart(43, '0'),
    author,
    body: `message ${index + 1}`,
    createdAt: STAMP,
  }));
}

/** A board holding one issue with `count` comments, i.e. `ceil(count / 50)` shards. */
async function boardWithComments(count) {
  const server = fakeSkrynia();
  const store = deterministicStore(server);
  const initialized = await store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Long conversation',
      body: 'the description',
      state: 'open',
      createdAt: STAMP,
      updatedAt: STAMP,
      messages: messages(count),
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  return { server, store, initialized };
}

test('a bounded comment page reads one comment shard, not the whole thread', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);
  assert.equal(shards.size, 3, '120 comments are stored as three 50-message shards');

  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 2);
  const read = commentShardReads(server, shards);

  assert.equal(page.total, 120);
  assert.equal(page.pageCount, 3);
  assert.equal(page.page, 2);
  assert.equal(page.messages.length, 50);
  assert.equal(page.messages[0].body, 'message 51');
  assert.equal(read.length, 1, 'one comment shard was fetched for one page');
  // Which shard matters as much as how many: the page asked for must be the
  // shard that crossed the wire.
  assert.equal(read[0], [...shards].find((key) => server.objects.get(key).value.page === 2));

  // The issue's own shard is read for the core fields, and no comment shard
  // other than the requested page is touched at all.
  const issueKeys = issueShardKeys(server, 1);
  assert.equal(issueKeys.size, 1);
  assert.equal(server.requests.filter((request) => request.method === 'GET' && issueKeys.has(request.key)).length, 1);
  assert.equal(page.issue.messages.length, 0, 'the issue core carries no messages with it');
  assert.equal(page.issue.title, 'Long conversation');
  assert.equal(page.issue.body, 'the description');
});

test('the whole-thread read is what the fan-out costs, for contrast', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);

  server.clearRequests();
  const issue = await store.getIssue(initialized.credential, 1);

  assert.equal(issue.messages.length, 120);
  assert.equal(commentShardReads(server, shards).length, 3, 'getIssue still reassembles every shard');
});

test('a page past the end of the thread fetches no comment shard at all', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);

  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 4);

  assert.equal(page.messages.length, 0);
  assert.equal(page.total, 120);
  assert.equal(page.pageCount, 3);
  assert.equal(
    commentShardReads(server, shards).length,
    0,
    'the snapshot already says the page is empty, so nothing is confirmed against the shards',
  );
});

test('an issue with no comments needs no shard read for its only page', async () => {
  const { server, store, initialized } = await boardWithComments(0);
  const shards = commentShardKeys(server, 1);
  assert.equal(shards.size, 0);

  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 1);

  assert.equal(page.messages.length, 0);
  assert.equal(page.total, 0);
  assert.equal(page.pageCount, 1, 'an empty thread is one page, not zero');
  assert.equal(commentShardReads(server, shards).length, 0);
});

test('paging the whole thread reproduces the stored message order exactly', async () => {
  const { store, initialized } = await boardWithComments(120);

  const paged = [];
  for (let page = 1; page <= 3; page += 1) {
    const read = await store.readIssueCommentPage(initialized.credential, 1, page);
    assert.equal(read.messages.length, page === 3 ? 20 : 50);
    paged.push(...read.messages.map((message) => message.body));
  }

  assert.deepEqual(paged, messages(120).map((message) => message.body));
});

test('the last page holds the partial shard, so a new comment lands there', async () => {
  const { store, initialized } = await boardWithComments(120);

  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'poster', body: 'the newest comment' },
  });

  const last = await store.readIssueCommentPage(initialized.credential, 1, 3);
  assert.equal(last.total, 121);
  assert.equal(last.pageCount, 3);
  assert.equal(last.messages.length, 21);
  assert.equal(last.messages.at(-1).body, 'the newest comment');

  // The page before the last one is unchanged by that post, which is what makes
  // the ordering across pages stable rather than shifted.
  const second = await store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.equal(second.total, 121);
  assert.equal(second.messages.length, 50);
  assert.equal(second.messages.at(-1).body, 'message 100');
});

test('a bounded read of an issue the board does not hold is null, as getIssue is', async () => {
  const { store, initialized } = await boardWithComments(3);

  assert.equal(await store.readIssueCommentPage(initialized.credential, 99, 1), null);
  assert.equal(await store.getIssue(initialized.credential, 99), null);
});

test('a comment page must be a positive integer', async () => {
  const { store, initialized } = await boardWithComments(3);

  await assert.rejects(() => store.readIssueCommentPage(initialized.credential, 1, 0), /positive integer/);
  await assert.rejects(() => store.readIssueCommentPage(initialized.credential, 1, 1.5), /positive integer/);
});