import assert from 'node:assert/strict';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

/**
 * Board issue 206: a page of an issue's conversation is a window onto the thread
 * that starts at its NEWEST end.
 *
 * At 21:00Z an orchestrator pass read six board issues, took page 1 as the
 * current state of each, and concluded the issues were unrepresented and needed
 * recovering. Several of them carried 40 to 50 comments. The read was not lying
 * about how many comments existed; it was answering a different question than
 * the reader was asking. `readIssueCommentPage` numbered its pages from the
 * OLDEST end, so page 1 was the beginning of a long thread rather than the end
 * of it, and a reader who opens an issue and reads the first thing the page
 * offered read the start of the history and concluded there was no current
 * state. The fix has to remove that trap at the layer that decides the order,
 * not in the component that draws it.
 *
 * The property this file protects is therefore not "the array is reversed". It
 * is: **a fresh reader who has read page 1 has seen the most recent comments.**
 * Page 1 holds the newest comments, page N walks BACKWARD into older history,
 * and the pages together partition the thread with nothing lost and nothing
 * served twice.
 *
 * The tie-break is load-bearing, not decoration. Every comment in this file's
 * fixture carries the SAME `createdAt`, so any ordering derived from timestamps
 * alone is a tie across the whole thread. Storage position is the total order
 * here -- `canonicalTimestampAtOrAfter` floors each appended timestamp at the
 * board's own, so append order is nondecreasing and each position is unique --
 * and it is the order these assertions require. If a future change ordered a
 * page by `createdAt` and fell back on array order for equal timestamps, these
 * assertions would fail rather than pass by luck.
 */

const STAMP = '2026-09-28T17:00:00.000Z';

function deterministicStore(server) {
  let id = 0;
  return new SignedBoardStore({
    fetch: server.fetch.bind(server),
    newId: () => `v3-newest-${++id}`,
    now: () => new Date('2026-09-28T18:00:00.000Z'),
  });
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

/**
 * `count` comments that ALL share one timestamp.
 *
 * The shared stamp is deliberate and is what makes this fixture able to catch a
 * timestamp-derived order: with every `createdAt` equal, an ordering that keys
 * on time has nothing to go on and exposes whatever tie-break it really uses.
 */
function messages(count, author = 'tester') {
  return Array.from({ length: count }, (_, index) => ({
    id: `sha256:` + (index + 1).toString(16).padStart(43, '0'),
    author,
    body: `message ${index + 1}`,
    createdAt: STAMP,
  }));
}

function bodies(read) {
  return read.messages.map((message) => message.body);
}

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

test('page 1 of a conversation holds the MOST RECENT comments, not the oldest', async () => {
  const { store, initialized } = await boardWithComments(120);

  const first = await store.readIssueCommentPage(initialized.credential, 1, 1);

  assert.equal(first.page, 1);
  assert.equal(first.total, 120);
  assert.equal(first.pageCount, 3);

  // This is the assertion the 21:00Z pass failed. Page 1 must END at the newest
  // comment on the board. Under the old oldest-first numbering this page began at
  // 'message 1' and ended at 'message 50', which is exactly what made a reader
  // believe a 120-comment issue had no current state.
  assert.equal(first.messages.at(-1).body, 'message 120', 'page 1 ends at the newest comment on the board');
  assert.equal(first.messages[0].body, 'message 71', 'page 1 begins 50 comments back from the newest');
  assert.equal(first.messages.length, 50);
  assert.ok(!bodies(first).includes('message 1'), 'the oldest comment is not on page 1');
});

test('higher page numbers walk BACKWARD into older history', async () => {
  const { store, initialized } = await boardWithComments(120);

  const first = await store.readIssueCommentPage(initialized.credential, 1, 1);
  const second = await store.readIssueCommentPage(initialized.credential, 1, 2);
  const third = await store.readIssueCommentPage(initialized.credential, 1, 3);

  // Each page reaches further back than the one before it. Read as three
  // consecutive assertions this says "newest, then older, then older still",
  // which is the direction the whole change is about.
  assert.equal(first.messages[0].body, 'message 71');
  assert.equal(second.messages[0].body, 'message 21');
  assert.equal(third.messages[0].body, 'message 1');

  assert.deepEqual(bodies(third), messages(20).map((message) => message.body));
});

test('paging the whole thread newest-first loses nothing and repeats nothing', async () => {
  const { store, initialized } = await boardWithComments(120);

  const pages = [];
  const lengths = [];
  for (let page = 1; page <= 3; page += 1) {
    const read = await store.readIssueCommentPage(initialized.credential, 1, page);
    lengths.push(read.messages.length);
    pages.push(bodies(read));
  }

  // Walking the pages BACKWARD reproduces the whole thread in its stored order.
  // The reversal is of the page sequence, not of each page's contents: order
  // inside a page stays chronological, so page 3 reads 'message 1'..'message 20'
  // rather than the other way round. This is the completeness half of the
  // property -- newest-first reorders pages, it never loses a comment and never
  // serves one on two pages.
  assert.deepEqual(lengths, [50, 50, 20]);
  assert.deepEqual(pages.slice().reverse().flat(), messages(120).map((message) => message.body));
  assert.equal(new Set(pages.flat()).size, 120, 'no comment appears on two pages');
});

test('a comment page keeps its order when every comment shares one timestamp', async () => {
  const { store, initialized } = await boardWithComments(120);

  // The whole fixture is tied: 120 comments, one distinct `createdAt`. So this
  // page's order cannot have come from the clock. It is storage position, which
  // is unique per comment and nondecreasing in time, and it is the same order on
  // every read rather than whatever a sort happened to produce.
  const reads = await Promise.all([1, 2, 3].map((page) =>
    store.readIssueCommentPage(initialized.credential, 1, page)));

  const first = bodies(reads[0]);
  assert.deepEqual(first, messages(120).slice(70, 120).map((message) => message.body));

  // Reading the same page again, and reading it concurrently with the others,
  // gives byte-identical order. An unstable tie-break would not.
  const again = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.deepEqual(bodies(again), first);
  assert.deepEqual(bodies(again), bodies(reads[0]));
});

test('the web conversation read and the CLI board show agree on every page', async () => {
  const { store, initialized } = await boardWithComments(120);

  // The bug was never one layer's fault: `getIssuePage` already walked backward
  // from the newest comment while `readIssueCommentPage` walked forward from the
  // oldest, so the CLI and the web rendered the same thread in opposite page
  // order and a reader who moved between them saw two different conversations.
  // They have to return the same comments for the same page number, or the trap
  // is only half removed.
  for (const page of [1, 2, 3]) {
    const viaConversation = await store.readIssueCommentPage(initialized.credential, 1, page);
    const viaShow = await store.getIssuePage(initialized.credential, 1, page);
    assert.deepEqual(
      bodies(viaConversation),
      viaShow.messages.map((message) => message.body),
      `page ${page} differs between the conversation read and board show`,
    );
  }
});

test('a newest-first page still reads a bounded number of shards, not the whole thread', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);
  assert.equal(shards.size, 3);

  // Newest-first pages are cut against the newest end of a shard sequence that
  // fills from the oldest, so a logical page can straddle two physical shards.
  // That straddle is the price of the direction and it is bounded: at most the
  // two shards one page can touch. What must never happen is the whole thread
  // being reassembled to draw one page of it -- the cost this read exists to
  // avoid, and the regression a naive "sort the array" fix would walk into.
  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 1);
  const reads = commentShardReads(server, shards);

  assert.equal(page.messages.length, 50);
  assert.equal(page.messages.at(-1).body, 'message 120', 'page 1 is the newest window');
  assert.ok(reads.length <= 2, `one page touched ${reads.length} shards; at most two may straddle`);
  assert.ok(reads.length < shards.size, 'a single page must not reassemble the whole thread');

  // And the same bound holds for the whole thread read, which is the contrast:
  // it does reassemble everything, and that is what the paged read is avoiding.
  server.clearRequests();
  const whole = await store.getIssue(initialized.credential, 1);
  assert.equal(whole.messages.length, 120);
  assert.equal(commentShardReads(server, shards).length, 3);
});

test('a thread that fits on one page is entirely on page 1, and stays newest-first as it grows past one', async () => {
  const { store, initialized } = await boardWithComments(7);

  const page = await store.readIssueCommentPage(initialized.credential, 1, 1);

  assert.equal(page.total, 7);
  assert.equal(page.pageCount, 1);
  // A whole thread that fits is page 1 whichever end the numbering runs from, so
  // on its own this half would pass against the old behaviour too. The
  // direction is pinned by the second half, which grows the thread past the page
  // boundary: the moment there IS more than one page, the newest comment has to
  // be the one on page 1. Under oldest-first numbering it lands on page 2 and
  // these assertions go red.
  assert.deepEqual(bodies(page), messages(7).map((message) => message.body));

  for (let index = 0; index < 44; index += 1) {
    await store.append(initialized.credential, {
      kind: 'issue.comment',
      payload: { number: 1, author: 'poster', body: `appended ${index + 1}` },
    });
  }

  const grown = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(grown.total, 51);
  assert.equal(grown.pageCount, 2);
  assert.equal(grown.messages.length, 50);
  assert.equal(grown.messages.at(-1).body, 'appended 44', 'the newest comment is on page 1 once there are two pages');
  assert.ok(!bodies(grown).includes('message 1'), 'the oldest comment has fallen to page 2');

  const second = await store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.deepEqual(bodies(second), ['message 1'], 'page 2 holds only the comment page 1 could not');
});

test('a new comment is visible on page 1 without the reader paging forward', async () => {
  const { store, initialized } = await boardWithComments(120);

  // The acceptance bar, stated as a test: a reader on page 1 posts, and the
  // comment they just wrote is on the page they are looking at. Under
  // oldest-first numbering it landed on the last page and the reader had to
  // page forward three times to see their own post.
  await store.append(initialized.credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'poster', body: 'the newest comment' },
  });

  const first = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(first.total, 121);
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages.at(-1).body, 'the newest comment', 'the newest comment is on page 1');
  assert.equal(first.messages[0].body, 'message 72', 'page 1 is still a 50-message window');
});

test('a page past the end of the thread is empty and reads no shard', async () => {
  const { server, store, initialized } = await boardWithComments(120);
  const shards = commentShardKeys(server, 1);

  server.clearRequests();
  const page = await store.readIssueCommentPage(initialized.credential, 1, 4);

  assert.deepEqual(page.messages, []);
  assert.equal(page.total, 120);
  assert.equal(page.pageCount, 3);
  assert.equal(commentShardReads(server, shards).length, 0, 'the snapshot already says there is nothing there');

  // "Past the end" is only past the end relative to a direction. Page 4 is the
  // fourth page walking BACKWARD from the newest comment; the newest window is
  // page 1, which is what makes page 4 the empty one rather than page 1.
  const first = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(first.messages.at(-1).body, 'message 120', 'page 1 is the newest window, so page 4 is past the end');
});