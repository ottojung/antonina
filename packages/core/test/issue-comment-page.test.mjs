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

test('a bounded comment page reads a bounded number of comment shards, not the whole thread', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);
  assert.equal(shards.size, 3, '120 comments are stored as three 50-message shards');

  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 1);
  const read = commentShardReads(server, shards);

  assert.equal(page.total, 120);
  assert.equal(page.pageCount, 3);
  assert.equal(page.page, 1);
  assert.equal(page.messages.length, 50);
  // Board issue 206: page 1 is the newest window, so it ends at the newest
  // comment on the board. A reader who opens an issue sees its current state
  // rather than the opening of its history.
  assert.equal(page.messages.at(-1).body, 'message 120');
  assert.equal(page.messages[0].body, 'message 71');

  // Pages are cut from the newest end while shards are filled from the oldest,
  // so one page can straddle two shards. That straddle is the bound: at most two,
  // and never all three, because reassembling the whole thread to draw one page
  // of it is exactly the cost this read exists to avoid.
  assert.ok(read.length <= 2, `one page fetched ${read.length} shards; at most two may straddle`);
  assert.ok(read.length < shards.size, 'one page must not fetch every comment shard');
  // Which shards matter as much as how many: only the ones the window covers.
  const pageNumbers = read.map((key) => server.objects.get(key).value.page).sort((left, right) => left - right);
  assert.deepEqual(pageNumbers, [2, 3], 'page 1 covers the newest window, spanning the last two shards');

  // The issue's own shard is read for the core fields, and no comment shard
  // other than the requested window is touched at all.
  const issueKeys = issueShardKeys(server, 1);
  assert.equal(issueKeys.size, 1);
  assert.equal(server.requests.filter((request) => request.method === 'GET' && issueKeys.has(request.key)).length, 1);
  assert.equal(page.issue.messages.length, 0, 'the issue core carries no messages with it');
  assert.equal(page.issue.title, 'Long conversation');
  assert.equal(page.issue.body, 'the description');
});

test('a comment page aligned with a shard boundary still fetches exactly one', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);

  // Not every page straddles. Page 3 of a 120-comment thread is the oldest
  // window and falls entirely inside the first shard, so the boundedness claim
  // is not "always one" and not "always two" but a ceiling -- and the ceiling
  // has to be observed, not assumed.
  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 3);
  const read = commentShardReads(server, shards);

  assert.equal(page.messages.length, 20);
  assert.equal(page.messages[0].body, 'message 1');
  assert.equal(read.length, 1, 'an aligned page fetches exactly one comment shard');
  assert.equal(read[0], [...shards].find((key) => server.objects.get(key).value.page === 1));
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

test('paging the whole thread backward reproduces the stored message order exactly', async () => {
  const { store, initialized } = await boardWithComments(120);

  // Board issue 206: page 1 is the newest window and higher numbers walk
  // backward, so the walk that reproduces storage order is the REVERSED page
  // sequence. Within a page the order is still chronological -- only the page
  // sequence is reversed, which is what keeps order inside a page stable rather
  // than flipping it.
  const pages = [];
  for (let page = 1; page <= 3; page += 1) {
    const read = await store.readIssueCommentPage(initialized.credential, 1, page);
    assert.equal(read.messages.length, page === 3 ? 20 : 50);
    pages.push(read.messages.map((message) => message.body));
  }

  assert.deepEqual(pages.slice().reverse().flat(), messages(120).map((message) => message.body));
});

test('a new comment lands on page 1, and the page before it is unchanged by that post', async () => {
  const { store, initialized } = await boardWithComments(120);

  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'poster', body: 'the newest comment' },
  });

  // Board issue 206: a comment is appended to the newest end, and page 1 is the
  // newest window, so a reader on page 1 sees their own post without paging.
  // Under oldest-first numbering this post landed on the last page and the
  // reader had to page forward twice to find it.
  const first = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(first.total, 121);
  assert.equal(first.pageCount, 3);
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages.at(-1).body, 'the newest comment');
  assert.equal(first.messages[0].body, 'message 72');

  // The newest page before it is unchanged by that post, which is what makes the
  // ordering across pages stable rather than shifted.
  const second = await store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.equal(second.total, 121);
  assert.equal(second.messages.length, 50);
  assert.equal(second.messages[0].body, 'message 22');
  assert.equal(second.messages.at(-1).body, 'message 71');
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