import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_FEED_ENTRY_KINDS, boardFeed, feedEntries, parseFeedCursor } from '../dist/feed.js';
import { emptyBoard, parseBoard } from '../dist/model.js';

const T0 = '2026-09-24T00:00:00.000Z';
const T1 = '2026-09-24T00:01:00.000Z';
const T2 = '2026-09-24T00:02:00.000Z';

function board(issues, nextIssueNumber) {
  return parseBoard({
    schemaVersion: 3,
    nextIssueNumber,
    issues,
    resources: [],
    targets: [],
    dispatches: [],
  });
}

function issue(number, changes = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    createdAt: T0,
    updatedAt: T0,
    messages: [],
    ...changes,
  };
}

function message(id, createdAt) {
  return { id, author: 'ada', body: `body ${id}`, createdAt };
}

/** A board whose whole activity shares one instant, so every tiebreak is load-bearing. */
function collidingBoard() {
  return board([
    issue(1, { messages: [message('m2', T0), message('m1', T0)] }),
    issue(2, { state: 'closed', createdAt: T0, updatedAt: T0, messages: [message('m3', T0)] }),
    issue(3, { createdAt: T0, updatedAt: T0 }),
  ], 4);
}

test('the empty board has an empty feed and no continuation', () => {
  const page = boardFeed(emptyBoard());
  assert.deepEqual(page.entries, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.total, 0);
  assert.equal(page.limit, 50);
});

test('creation, last change, and comments are separate entries over the same board', () => {
  const board1 = board([
    issue(1, { createdAt: T0, updatedAt: T2, messages: [message('m1', T1)] }),
  ], 2);
  const entries = feedEntries(board1);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.at]), [
    ['issue-updated', T2],
    ['comment-added', T1],
    ['issue-created', T0],
  ]);
  assert.equal(entries[0].state, 'open');
  assert.equal(entries[1].author, 'ada');
  assert.equal(entries[1].body, 'body m1');
  assert.equal(entries[1].messageId, 'm1');
  assert.equal(entries[2].messageId, null);
  assert.equal(entries[2].title, 'Issue 1');
});

test('entry identity is unique across the feed even when every instant collides', () => {
  const entries = feedEntries(collidingBoard());
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  // Newest first, and within one instant a fixed kind order then issue number.
  // Newest first, and within one instant the vocabulary order
  // (created, updated, commented) then issue number then message identity.
  assert.deepEqual(ids, [
    'issue-created:1:-',
    'issue-created:2:-',
    'issue-created:3:-',
    'issue-updated:1:-',
    'issue-updated:2:-',
    'issue-updated:3:-',
    'comment-added:1:m1',
    'comment-added:1:m2',
    'comment-added:2:m3',
  ]);
});

test('paging over colliding timestamps concatenates to the single-page projection', () => {
  const board1 = collidingBoard();
  const all = boardFeed(board1, { limit: 500 }).entries.map((entry) => entry.id);

  const paged = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = boardFeed(board1, { limit: 2, cursor });
    paged.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(paged, all);
  assert.equal(new Set(paged).size, all.length);
});

test('a walk also loses and repeats nothing when the collision spans a page boundary', () => {
  // Two issues and one comment share the newest instant, so a limit of 1 splits
  // the tie group across three consecutive pages.
  const board1 = board([
    issue(1, { createdAt: T0, updatedAt: T1, messages: [message('m1', T1)] }),
    issue(2, { createdAt: T0, updatedAt: T1 }),
  ], 3);
  const all = boardFeed(board1, { limit: 500 }).entries.map((entry) => entry.id);
  const walked = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = boardFeed(board1, { limit: 1, cursor });
    walked.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  assert.deepEqual(walked, all);
  // One created and one updated entry per issue, plus the single comment.
  assert.equal(all.length, 5);
});

test('the last page reports no continuation and an earlier one does', () => {
  const board1 = board([
    issue(1, { messages: [message('m1', T1), message('m2', T2)] }),
  ], 2);
  const first = boardFeed(board1, { limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.at), [T2, T1]);
  assert.equal(typeof first.nextCursor, 'string');
  const second = boardFeed(board1, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.id), ['issue-created:1:-', 'issue-updated:1:-']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, first.total);
});

test('the projection is deterministic and independent of the order issues are stored in', () => {
  const forwards = board([issue(1), issue(2, { createdAt: T1 })], 3);
  const backwards = board([issue(2, { createdAt: T1 }), issue(1)], 3);
  assert.deepEqual(feedEntries(forwards), feedEntries(backwards));
  assert.deepEqual(boardFeed(forwards, { limit: 2 }), boardFeed(backwards, { limit: 2 }));
});

test('a limit is bounded, and a nonsense one is refused rather than clamped', () => {
  const board1 = board([issue(1)], 2);
  assert.equal(boardFeed(board1, { limit: 100000 }).limit, 500);
  assert.throws(() => boardFeed(board1, { limit: 0 }), /positive integer/);
});

test('the feed never invents a kind the board cannot answer', () => {
  // The board records one `updatedAt` per issue and one `createdAt` per message,
  // and there is no message-edit operation, so the feed has exactly these three
  // kinds. A closed issue whose last change was the closure is still only
  // "updated", because the board never recorded that it had been open before.
  assert.deepEqual([...BOARD_FEED_ENTRY_KINDS], ['issue-created', 'issue-updated', 'comment-added']);
  const closed = board([issue(1, { state: 'closed', createdAt: T0, updatedAt: T0 })], 2);
  assert.deepEqual(feedEntries(closed).map((entry) => entry.kind), ['issue-created', 'issue-updated']);
});

test('a malformed continuation token is refused instead of being ignored', () => {
  const board1 = board([issue(1)], 2);
  for (const cursor of ['', 'v2.aaaa', 'v1.@@@', 'v1.' + Buffer.from('[1]', 'utf8').toString('base64url')]) {
    assert.throws(() => boardFeed(board1, { cursor }), /malformed/, cursor);
  }
  assert.throws(() => parseFeedCursor('nonsense'), /malformed/);
});

test('an unknown but well-formed cursor returns the entries after that position', () => {
  // A cursor is a position in the order, not a lookup key, so an entry that no
  // longer exists still pages forward instead of failing.
  const board1 = board([issue(1, { createdAt: T0, updatedAt: T1, messages: [message('m1', T1)] })], 2);
  const cursor = 'v1.' + Buffer.from(JSON.stringify([T1, 'comment-added', 9, 'm9']), 'utf8').toString('base64url');
  const page = boardFeed(board1, { cursor });
  // The cursor sits past both T1 entries, so the creation entry is what remains.
  assert.deepEqual(page.entries.map((entry) => entry.id), ['issue-created:1:-']);
  assert.equal(page.total, 3);
});
