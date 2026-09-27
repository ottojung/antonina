import assert from 'node:assert/strict';
import test from 'node:test';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// The projection is a pure function of an operation log built in memory, and
// this file touches no filesystem, no `$XDG_STATE_HOME` and no
// `$XDG_CONFIG_HOME` at all.
const TEST_STATE_HOME = '/nonexistent-antonina-feed-core-state';
const TEST_CONFIG_HOME = '/nonexistent-antonina-feed-core-config';
process.env.XDG_STATE_HOME = TEST_STATE_HOME;
process.env.XDG_CONFIG_HOME = TEST_CONFIG_HOME;

import { generateSigningKey } from '../dist/canonical.js';
import { emptyBoard } from '../dist/model.js';
import {
  createTrustAnchor,
  emptyOperationLog,
  signBoardOperation,
  verifyAndReplayOperationLog,
} from '../dist/operations.js';
import { BOARD_FEED_ENTRY_KINDS, boardFeed, feedEntries, parseFeedCursor } from '../dist/feed.js';

const T0 = '2026-09-24T00:00:00.000Z';
const T1 = '2026-09-24T00:01:00.000Z';
const T2 = '2026-09-24T00:02:00.000Z';

const timestamp = (index) => new Date(Date.parse(T0) + index * 60_000).toISOString();

/** A real signed log, so the projection is exercised over verified history. */
async function logWith(operations, sameInstant = false) {
  const root = await generateSigningKey();
  const anchor = await createTrustAnchor('board-feed', root);
  const log = emptyOperationLog(anchor);
  const append = async (kind, payload, index) => {
    const operation = await signBoardOperation({
      boardId: log.boardId,
      previous: log.head,
      timestamp: timestamp(index),
      nonce: `${kind}-${index}`,
      kind,
      payload,
    }, root);
    log.operations.push(operation);
    log.head = operation.opId;
    return operation;
  };
  await append('board.initialize', { board: emptyBoard() }, 0);
  let index = 1;
  for (const [kind, payload, at] of operations) {
    await append(kind, payload, sameInstant ? 0 : (at ?? index));
    index += 1;
  }
  // The feed is a projection of verified history, so a fixture the log refuses
  // to replay is a broken fixture, not a test.
  await verifyAndReplayOperationLog(log, anchor);
  return log;
}

const created = (number, title = `Issue ${number}`) => ['issue.create', { number, title, body: '' }];

test('an empty board has an empty feed and no continuation', async () => {
  const log = await logWith([]);
  const page = boardFeed(log);
  assert.deepEqual(page.entries, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.total, 0);
  assert.equal(page.limit, 50);
});

test('each recorded operation is its own entry, at its own instant', async () => {
  const log = await logWith([
    ['issue.create', { number: 1, title: 'Feed me', body: '' }, 0],
    ['issue.comment', { number: 1, author: 'ada', body: 'first' }, 1],
    ['issue.edit', { number: 1, title: 'Feed me, edited', body: null }, 2],
    ['issue.close', { number: 1 }, 3],
    ['issue.reopen', { number: 1 }, 4],
  ]);
  const entries = feedEntries(log);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.at]), [
    ['issue-reopened', timestamp(4)],
    ['issue-closed', timestamp(3)],
    ['issue-edited', timestamp(2)],
    ['comment-added', timestamp(1)],
    ['issue-created', timestamp(0)],
  ]);
  const comment = entries[3];
  assert.equal(comment.author, 'ada');
  assert.equal(comment.body, 'first');
  assert.equal(comment.messageId, comment.id);
  // The title in force when the operation was committed, not a later one.
  assert.equal(entries[3].title, 'Feed me');
  assert.equal(entries[2].title, 'Feed me, edited');
  assert.equal(entries[0].state, 'open');
  assert.equal(entries[1].state, 'closed');
});

test('a closure and a reopen are reported, never collapsed into one change', async () => {
  // The collapsed `Board` view records neither: it shows a closed issue with one
  // `updatedAt` and cannot say when the closure happened or whether the issue was
  // ever open. The log records both, so the feed reports both.
  const log = await logWith([
    ['issue.create', { number: 1, title: 'Close me', body: '' }, 0],
    ['issue.close', { number: 1 }, 1],
    ['issue.reopen', { number: 1 }, 2],
  ]);
  assert.deepEqual(feedEntries(log).map((entry) => entry.kind), [
    'issue-reopened', 'issue-closed', 'issue-created',
  ]);
});

test('an untouched issue contributes exactly one entry, and deletion is reported', async () => {
  const log = await logWith([created(1), created(2)]);
  assert.deepEqual(feedEntries(log).map((entry) => entry.kind), ['issue-created', 'issue-created']);

  const deleted = await logWith([created(1), ['issue.delete', { number: 1 }, 1]]);
  assert.deepEqual(feedEntries(deleted).map((entry) => entry.kind), ['issue-deleted', 'issue-created']);
});

test('the vocabulary is exactly the issue-scoped operation kinds', async () => {
  assert.deepEqual([...BOARD_FEED_ENTRY_KINDS], [
    'issue-created', 'issue-edited', 'comment-added', 'issue-closed', 'issue-reopened', 'issue-deleted',
  ]);
  // Every kind is produced by the fixture above, so the enumeration is total over
  // what the projection can produce rather than a list with unreachable members.
  const log = await logWith([
    ['issue.create', { number: 1, title: 'All kinds', body: '' }, 0],
    ['issue.comment', { number: 1, author: 'ada', body: 'hi' }, 1],
    ['issue.edit', { number: 1, title: null, body: 'edited' }, 2],
    ['issue.close', { number: 1 }, 3],
    ['issue.reopen', { number: 1 }, 4],
    ['issue.delete', { number: 1 }, 5],
  ]);
  assert.deepEqual(
    [...new Set(feedEntries(log).map((entry) => entry.kind))].sort(),
    [...BOARD_FEED_ENTRY_KINDS].sort(),
  );
});

test('the tie-break is the log order, so one instant still has one order', async () => {
  // Every operation shares one instant, so nothing but the log order can order
  // these entries. The feed reports them in the order the log committed them,
  // newest first.
  const log = await logWith([
    created(1), created(2), ['issue.comment', { number: 1, author: 'ada', body: 'first' }],
  ], 0);
  const entries = feedEntries(log);
  assert.deepEqual(entries.map((entry) => entry.kind), ['comment-added', 'issue-created', 'issue-created']);
  // A log position is unique, so entry identity is unique with no synthetic
  // kind/number/message tiebreak needed.
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, log.operations.slice(1).reverse().map((operation) => operation.opId));
});

test('paging over one fully tied log concatenates to the single-page projection', async () => {
  const log = await logWith([
    created(1), created(2),     ['issue.comment', { number: 1, author: 'ada', body: 'first' }],
    ['issue.close', { number: 2 }],
  ], 0);
  const all = boardFeed(log, { limit: 500 }).entries.map((entry) => entry.id);

  for (const limit of [1, 2, 3]) {
    const paged = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = boardFeed(log, { limit, cursor });
      paged.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual(paged, all);
    assert.equal(new Set(paged).size, all.length);
  }
});

test('the last page reports no continuation and an earlier one does', async () => {
  const log = await logWith([
    created(1),
    ['issue.comment', { number: 1, author: 'ada', body: 'first' }, 1],
    ['issue.comment', { number: 1, author: 'ada', body: 'second' }, 2],
  ]);
  const first = boardFeed(log, { limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.at), [T2, T1]);
  assert.equal(typeof first.nextCursor, 'string');
  const second = boardFeed(log, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.kind), ['issue-created']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, first.total);
});

test('the projection is a pure function of the log', async () => {
  const log = await logWith([created(1), created(2), ['issue.close', { number: 2 }]]);
  const copy = structuredClone(log);
  assert.deepEqual(feedEntries(log), feedEntries(copy));
  assert.deepEqual(boardFeed(log, { limit: 2 }), boardFeed(copy, { limit: 2 }));
});

test('a limit is bounded, and a nonsense one is refused rather than clamped', async () => {
  const log = await logWith([created(1)]);
  assert.equal(boardFeed(log, { limit: 100000 }).limit, 500);
  assert.throws(() => boardFeed(log, { limit: 0 }), /positive integer/);
});

test('a malformed continuation token is refused instead of being ignored', async () => {
  const log = await logWith([created(1)]);
  for (const cursor of ['', 'v2.aaaa', 'v1.@@@', 'v1.' + Buffer.from('[1]', 'utf8').toString('base64url')]) {
    assert.throws(() => boardFeed(log, { cursor }), /malformed/, cursor);
  }
  assert.throws(() => parseFeedCursor('nonsense'), /malformed/);
});

test('a cursor is a position in the log, not a lookup key', async () => {
  const log = await logWith([created(1), ['issue.comment', { number: 1, author: 'ada', body: 'x' }, 1]]);
  // A position the log never reached, from a walk of a board that has since been
  // replaced, is still a position: the entries after it are the whole feed, and
  // the feed is never a failure because a token named something absent.
  const ahead = 'v1.' + Buffer.from(JSON.stringify([timestamp(9), 99]), 'utf8').toString('base64url');
  assert.deepEqual(
    boardFeed(log, { cursor: ahead }).entries.map((entry) => entry.kind),
    ['comment-added', 'issue-created'],
  );
  // A position before every entry leaves nothing, rather than re-delivering the
  // entries the caller already has.
  const behind = 'v1.' + Buffer.from(JSON.stringify([T0, 0]), 'utf8').toString('base64url');
  const page = boardFeed(log, { cursor: behind });
  assert.deepEqual(page.entries, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.total, 2);
});
