import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi } from '../dist/api.js';
import { SignedBoardStore } from '../dist/board-store.js';
import { compareClosedIssues, closingTimeOf } from '../dist/board-v3-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

const EPOCH = Date.parse('2026-09-25T12:00:00.000Z');

/**
 * A board whose clock is under the test's control, so two issues closed in
 * different operations carry different closing timestamps. Without this every
 * close in a test lands on the same instant and the ordering contract under
 * test is never exercised.
 */
function store(server) {
  let sequence = 0;
  let tick = 0;
  return new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: () => new Date(EPOCH + (tick += 1) * 60_000),
    newId: () => `closed-order-reader-${++sequence}`,
  });
}

function api(server) {
  let sequence = 0;
  let tick = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(EPOCH + (tick += 1) * 60_000),
    newId: () => `closed-order-${++sequence}`,
  });
}

/**
 * Creates `count` issues and closes them in the order given, so the closing
 * timestamps run in the opposite direction to the issue numbers for some of
 * them. That inversion is the whole point: an issue-number-ordered comparator
 * produces a different list, so a regression to it cannot stay green here.
 */
async function closeInGivenOrder(client, count, closeOrder) {
  for (let number = 1; number <= count; number += 1) {
    await client.createIssue(`Issue ${number}`, 'body');
  }
  for (const number of closeOrder) {
    await client.close(number);
  }
}

function numbers(summaries) {
  return summaries.map((summary) => summary.number);
}

test('the comparator orders by closing time, most recent first, not by issue number', () => {
  const closed = [
    { number: 1, closedAt: '2026-09-25T12:00:00.000Z', updatedAt: '2026-09-25T11:00:00.000Z' },
    { number: 2, closedAt: '2026-09-25T14:00:00.000Z', updatedAt: '2026-09-25T13:00:00.000Z' },
    { number: 3, closedAt: '2026-09-25T13:00:00.000Z', updatedAt: '2026-09-25T12:30:00.000Z' },
    { number: 4, closedAt: '2026-09-25T15:00:00.000Z', updatedAt: '2026-09-25T14:30:00.000Z' },
  ];
  assert.deepEqual(closed.slice().sort(compareClosedIssues).map((key) => key.number), [4, 2, 3, 1]);
});

test('the comparator is a total order: antisymmetric, and zero only on a true tie', () => {
  const earlier = { number: 9, closedAt: '2026-09-25T11:00:00.000Z', updatedAt: '2026-09-25T11:00:00.000Z' };
  const later = { number: 2, closedAt: '2026-09-25T12:00:00.000Z', updatedAt: '2026-09-25T12:00:00.000Z' };
  assert.ok(compareClosedIssues(later, earlier) < 0);
  assert.ok(compareClosedIssues(earlier, later) > 0);
  // Tied on time, the higher number sorts first, so this pair is not symmetric
  // about the sign: the comparison is antisymmetric, not merely non-zero.
  const left = { number: 7, closedAt: '2026-09-25T12:00:00.000Z', updatedAt: '2026-09-25T11:00:00.000Z' };
  const right = { number: 8, closedAt: '2026-09-25T12:00:00.000Z', updatedAt: '2026-09-25T11:30:00.000Z' };
  assert.ok(compareClosedIssues(left, right) > 0);
  assert.ok(compareClosedIssues(right, left) < 0);
  assert.equal(compareClosedIssues(left, { ...left }), 0);
});

/**
 * Board 179 left the tie rule in the comparator body but nothing in this package
 * asserted it, so it was one edit away from changing silently. Two issues
 * closed at the identical instant are broken by the HIGHER issue number first,
 * which is the descending-number half of the comparator's `right.number -
 * left.number`. Recorded here as the settled decision.
 */
test('two issues closed at the identical instant break the tie by higher issue number first', () => {
  const at = '2026-09-25T12:00:00.000Z';
  const tied = [
    { number: 5, closedAt: at, updatedAt: '2026-09-25T10:00:00.000Z' },
    { number: 9, closedAt: at, updatedAt: '2026-09-25T10:00:00.000Z' },
    { number: 6, closedAt: at, updatedAt: '2026-09-25T10:00:00.000Z' },
  ];
  assert.deepEqual(tied.slice().sort(compareClosedIssues).map((key) => key.number), [9, 6, 5]);
});

/**
 * The missing-`closedAt` fallback was likewise unspecified by any core test. It
 * orders by the issue's own `updatedAt`, so an issue the board closed without
 * recording a closing time sorts by when it was last touched rather than being
 * dropped to one end of the list or sorted by its number.
 */
test('a null closedAt falls back to updatedAt rather than to the issue number', () => {
  assert.equal(closingTimeOf({ closedAt: null, updatedAt: '2026-09-25T09:00:00.000Z' }), '2026-09-25T09:00:00.000Z');
  assert.equal(
    closingTimeOf({ closedAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T23:00:00.000Z' }),
    '2026-09-25T09:00:00.000Z',
  );
  const mixed = [
    { number: 1, closedAt: null, updatedAt: '2026-09-25T16:00:00.000Z' },
    { number: 2, closedAt: '2026-09-25T15:00:00.000Z', updatedAt: '2026-09-25T15:00:00.000Z' },
    { number: 3, closedAt: null, updatedAt: '2026-09-25T17:00:00.000Z' },
  ];
  assert.deepEqual(mixed.slice().sort(compareClosedIssues).map((key) => key.number), [3, 1, 2]);
});

/**
 * The materialized list pages are where the order is actually fixed
 * (`orderedSummaries` in board-v3-store.ts), before any page size is applied.
 * Board 179 was a change to this path and nothing in core asserted it, so the
 * regression was invisible to `test:core`.
 */
test('the materialized closed pages are ordered by closing time across the store', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  const initialized = await client.initialize();
  await closeInGivenOrder(client, 4, [4, 1, 3, 2]);

  const page = await store(server).readIssuePage(initialized.credential, 'closed', 1);
  assert.deepEqual(numbers(page.entries), [2, 3, 1, 4]);
  for (const entry of page.entries) {
    assert.equal(entry.state, 'closed');
    assert.ok(entry.closedAt, 'a closed summary carries the timestamp it was closed at');
  }
});

test('listIssueSummaries returns the closed issues in closing-time order', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  await closeInGivenOrder(client, 4, [4, 1, 3, 2]);

  assert.deepEqual(numbers(await client.listIssueSummaries('closed')), [2, 3, 1, 4]);
});

/**
 * The order is chosen before the page size, so it survives paging: the issue
 * closed first is last overall and therefore lands on the final page rather
 * than the first. A per-page number sort would put it on page 1.
 */
test('closing-time order survives paging: the first-closed issue is on the last page', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  const initialized = await client.initialize();

  const count = 55;
  const closeOrder = [];
  for (let number = 1; number <= count; number += 1) {
    await client.createIssue(`Issue ${number}`, 'body');
  }
  // Close odd numbers ascending first, then even numbers: the closing order is
  // neither ascending nor descending in issue number.
  for (let number = 1; number <= count; number += 2) closeOrder.push(number);
  for (let number = 2; number <= count; number += 2) closeOrder.push(number);
  for (const number of closeOrder) await client.close(number);

  const reader = store(server);
  const first = await reader.readIssuePage(initialized.credential, 'closed', 1);
  const second = await reader.readIssuePage(initialized.credential, 'closed', 2);
  assert.equal(first.total, count);
  assert.equal(first.entries.length, 50);
  assert.equal(second.entries.length, 5);

  const listed = numbers(await client.listIssueSummaries('closed'));
  assert.equal(listed.length, count);
  assert.equal(new Set(listed).size, count);
  assert.deepEqual(listed, [...closeOrder].reverse());
  assert.deepEqual([...numbers(first.entries), ...numbers(second.entries)], listed);
});

/**
 * Open and closed are ordered independently: the open list is queue order, and
 * a closed issue must not be reordered by the closed comparator into the open
 * page or out of the closed one.
 */
test('the closed order does not leak into the open list', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  for (let number = 1; number <= 3; number += 1) await client.createIssue(`Issue ${number}`, 'body');
  await client.close(1);
  await client.close(3);

  assert.deepEqual(numbers(await client.listIssueSummaries('open')), [2]);
  assert.deepEqual(numbers(await client.listIssueSummaries('closed')), [3, 1]);
});
