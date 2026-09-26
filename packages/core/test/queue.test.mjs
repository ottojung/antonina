import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSigningKey } from '../dist/canonical.js';
import { emptyBoard } from '../dist/model.js';
import {
  createTrustAnchor,
  emptyOperationLog,
  parseSignedBoardOperation,
  signBoardOperation,
  verifyAndReplayOperationLog,
} from '../dist/operations.js';

// The queue is a durable half of the signed board log, so it gets its own file:
// these tests sign, append and replay `queue.reorder` operations, which nothing
// else in the suite does.
const timestamp = (minute) => `2026-09-25T12:${String(minute).padStart(2, '0')}:00.000Z`;

async function setup() {
  const root = await generateSigningKey();
  const anchor = await createTrustAnchor('board-test', root);
  const log = emptyOperationLog(anchor);
  return { root, anchor, log };
}

async function append(log, signer, kind, payload, minute) {
  const operation = await signBoardOperation({
    boardId: log.boardId,
    previous: log.head,
    timestamp: timestamp(minute),
    nonce: `${kind}-${minute}`,
    kind,
    payload,
  }, signer);
  log.operations.push(operation);
  log.head = operation.opId;
  return operation;
}

async function initialized() {
  const state = await setup();
  await append(state.log, state.root, 'board.initialize', { board: emptyBoard() }, 0);
  return state;
}

/** A board with open issues 1..`open` and, when asked for, a closed one after them. */
async function queued(open, { closed = 0 } = {}) {
  const state = await initialized();
  let minute = 1;
  for (let number = 1; number <= open + closed; number += 1) {
    await append(state.log, state.root, 'issue.create', { number, title: `Issue ${number}`, body: '' }, minute);
    minute += 1;
  }
  for (let number = open + 1; number <= open + closed; number += 1) {
    await append(state.log, state.root, 'issue.close', { number }, minute);
    minute += 1;
  }
  state.minute = minute;
  return state;
}

function clone(value) {
  return structuredClone(value);
}

/** Removes the last operation, leaving the log as it was before the candidate. */
function withoutLastOperation(log) {
  const trimmed = clone(log);
  trimmed.operations.pop();
  trimmed.head = trimmed.operations.at(-1).opId;
  return trimmed;
}

test('a root-signed queue reorder verifies and replays in the submitted order', async () => {
  const { root, anchor, log } = await queued(4);
  await append(log, root, 'queue.reorder', { numbers: [3, 1, 4, 2] }, 5);

  const replayed = await verifyAndReplayOperationLog(log, anchor);

  // Neither ascending nor descending, so an implementation that sorted would fail here.
  assert.deepEqual(replayed.queue, [3, 1, 4, 2]);
  assert.deepEqual(replayed.board.issues.map((issue) => issue.number), [1, 2, 3, 4]);
});

test('replaying the same reordered log twice yields identical state including the queue', async () => {
  const { root, anchor, log } = await queued(3);
  await append(log, root, 'queue.reorder', { numbers: [2, 3, 1] }, 4);

  const first = await verifyAndReplayOperationLog(log, anchor);
  const second = await verifyAndReplayOperationLog(clone(log), anchor);

  assert.deepEqual(second, first);
  assert.deepEqual(first.queue, [2, 3, 1]);
});

test('the reordered queue survives a reload of the persisted log alone', async () => {
  const { root, anchor, log } = await queued(3);
  await append(log, root, 'queue.reorder', { numbers: [3, 2, 1] }, 4);

  // What a reader that never saw the ordering request sees: the stored JSON.
  const persisted = JSON.parse(JSON.stringify(log));
  const reloaded = await verifyAndReplayOperationLog(persisted, anchor);

  assert.deepEqual(reloaded.queue, [3, 2, 1]);
  assert.equal(reloaded.head, log.head);
});

test('a partial queue reorder is rejected and commits nothing', async () => {
  const { root, anchor, log } = await queued(4);
  await append(log, root, 'queue.reorder', { numbers: [2, 1, 3] }, 5);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /every open issue exactly once/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2, 3, 4]);
});

test('a queue reorder with a duplicated issue cannot be signed at all', async () => {
  const { root, anchor, log } = await queued(3);

  // The payload parser is the duplicate boundary, so a duplicated list is not
  // signable and can never reach the replay invariant.
  await assert.rejects(
    () => append(log, root, 'queue.reorder', { numbers: [1, 2, 2] }, 4),
    /Queue-reorder payload is malformed/,
  );
  assert.equal(log.operations.length, 4);
  const committed = await verifyAndReplayOperationLog(log, anchor);
  assert.deepEqual(committed.queue, [1, 2, 3]);
});

test('a queue reorder naming a closed issue is rejected and commits nothing', async () => {
  const { root, anchor, log } = await queued(3, { closed: 1 });
  await append(log, root, 'queue.reorder', { numbers: [1, 2, 3, 4] }, 5);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /every open issue exactly once/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2, 3]);
});

test('a queue reorder naming an issue the board never had is rejected and commits nothing', async () => {
  const { root, anchor, log } = await queued(3);
  await append(log, root, 'queue.reorder', { numbers: [1, 2, 3, 99] }, 4);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /every open issue exactly once/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2, 3]);
});

test('a queue reorder that drops an open issue while keeping the list length is rejected', async () => {
  const { root, anchor, log } = await queued(4, { closed: 1 });
  await append(log, root, 'queue.reorder', { numbers: [1, 2, 3, 5] }, 6);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /every open issue exactly once/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2, 3, 4]);
});

test('an empty queue reorder is accepted for a board with no open issues', async () => {
  const { root, anchor, log } = await queued(0);
  await append(log, root, 'queue.reorder', { numbers: [] }, 1);

  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.deepEqual(replayed.queue, []);
});

test('a delegated credential without queue.reorder cannot reorder the queue', async () => {
  const { root, anchor, log } = await queued(2);
  const editor = await generateSigningKey();
  await append(log, root, 'authority.delegate', {
    childKeyId: editor.keyId,
    childPublicKey: editor.publicKey,
    capabilities: ['issue.edit'],
  }, 3);
  await append(log, editor, 'queue.reorder', { numbers: [2, 1] }, 4);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /lacks required capability queue\.reorder/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('a delegated credential holding queue.reorder can reorder the queue', async () => {
  const { root, anchor, log } = await queued(2);
  const editor = await generateSigningKey();
  await append(log, root, 'authority.delegate', {
    childKeyId: editor.keyId,
    childPublicKey: editor.publicKey,
    capabilities: ['issue.edit', 'queue.reorder'],
  }, 3);
  await append(log, editor, 'queue.reorder', { numbers: [2, 1] }, 4);

  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.deepEqual(replayed.queue, [2, 1]);
});

test('the queue follows the issue lifecycle, asserted after every step', async () => {
  const { root, anchor, log } = await queued(0);
  const at = async () => (await verifyAndReplayOperationLog(log, anchor)).queue;

  assert.deepEqual(await at(), []);

  await append(log, root, 'issue.create', { number: 1, title: 'One', body: '' }, 1);
  await append(log, root, 'issue.create', { number: 2, title: 'Two', body: '' }, 2);
  await append(log, root, 'issue.create', { number: 3, title: 'Three', body: '' }, 3);
  assert.deepEqual(await at(), [1, 2, 3], 'create appends');

  await append(log, root, 'queue.reorder', { numbers: [3, 1, 2] }, 4);
  assert.deepEqual(await at(), [3, 1, 2], 'reorder replaces the whole queue');

  await append(log, root, 'issue.close', { number: 1 }, 5);
  assert.deepEqual(await at(), [3, 2], 'close removes the number');

  await append(log, root, 'issue.reopen', { number: 1 }, 6);
  assert.deepEqual(await at(), [3, 2, 1], 'reopen re-adds the number');

  await append(log, root, 'issue.delete', { number: 2 }, 7);
  assert.deepEqual(await at(), [3, 1], 'delete removes the number');

  await append(log, root, 'issue.create', { number: 4, title: 'Four', body: '' }, 8);
  assert.deepEqual(await at(), [3, 1, 4], 'a later create appends to the reordered queue');
});

test('board initialization seeds the queue from the imported open issues in issue order', async () => {
  const { root, anchor, log } = await setup();
  const issue = (number, state) => ({
    number,
    title: `Imported ${number}`,
    body: '',
    state,
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    messages: [],
  });
  await append(log, root, 'board.initialize', {
    board: {
      schemaVersion: 2,
      nextIssueNumber: 4,
      issues: [issue(1, 'closed'), issue(2, 'open'), issue(3, 'open')],
      resources: [],
    },
  }, 1);

  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.deepEqual(replayed.queue, [2, 3]);
});

test('board deletion leaves the queue as it was and ends the history', async () => {
  const { root, anchor, log } = await queued(2);
  await append(log, root, 'queue.reorder', { numbers: [2, 1] }, 3);
  await append(log, root, 'board.delete', {}, 4);

  const deleted = await verifyAndReplayOperationLog(log, anchor);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.queue, [2, 1]);
});

/** A well-formed signed `queue.reorder` operation, used only as a payload host. */
async function signedReorder(root, minute) {
  const state = await initialized();
  return append(state.log, root, 'queue.reorder', { numbers: [1] }, minute);
}

async function withMalformedReorder(payload) {
  const { root, anchor, log } = await queued(2);
  const operation = await signedReorder(root, 3);
  log.operations.push({ ...clone(operation), payload, previous: log.head, signerKeyId: root.keyId });
  log.head = log.operations.at(-1).opId;
  return { root, anchor, log };
}

test('a queue reorder payload with a duplicated entry is refused by the parser', async () => {
  const { anchor, log } = await withMalformedReorder({ numbers: [1, 1] });

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /Queue-reorder payload is malformed/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('a queue reorder payload with a non-integer entry is refused by the parser', async () => {
  const { anchor, log } = await withMalformedReorder({ numbers: [1.5, 2] });

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /Queue-reorder payload is malformed/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('a queue reorder payload with an unknown extra key is refused by the parser', async () => {
  const { anchor, log } = await withMalformedReorder({ numbers: [1, 2], priority: 'high' });

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /Queue-reorder payload is malformed/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('a queue reorder payload that is missing its numbers key is refused by the parser', async () => {
  const { anchor, log } = await withMalformedReorder({ order: [1, 2] });

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /Queue-reorder payload is malformed/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('a queue reorder payload that is not an array is refused by the parser', async () => {
  const { anchor, log } = await withMalformedReorder({ numbers: '1,2' });

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /Queue-reorder payload is malformed/);
  const committed = await verifyAndReplayOperationLog(withoutLastOperation(log), anchor);
  assert.deepEqual(committed.queue, [1, 2]);
});

test('the queue reorder payload parser accepts a whole-list permutation of open issue numbers', async () => {
  const { root, anchor, log } = await queued(3);
  const operation = await append(log, root, 'queue.reorder', { numbers: [3, 2, 1] }, 4);

  const parsed = parseSignedBoardOperation(JSON.parse(JSON.stringify(operation)));
  assert.deepEqual(parsed.payload, { numbers: [3, 2, 1] });
  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.deepEqual(replayed.queue, [3, 2, 1]);
});

test('the queue reorder payload parser refuses every number that is not a positive safe integer', async () => {
  const { root } = await initialized();
  const host = await signedReorder(root, 1);
  const wire = JSON.parse(JSON.stringify(host));

  // Hostile values that JSON can still carry, none of which may reach the queue.
  const hostile = [0, -1, 1.5, 1e21, '1', Number.MAX_SAFE_INTEGER + 1, null, true];

  for (const value of hostile) {
    const carried = JSON.parse(JSON.stringify(value));
    assert.throws(
      () => parseSignedBoardOperation({ ...wire, payload: { numbers: [carried, 2] } }),
      /Queue-reorder payload is malformed/,
      'payload entry ' + String(carried),
    );
  }

  const accepted = parseSignedBoardOperation({ ...wire, payload: { numbers: [2, 1] } });
  assert.deepEqual(accepted.payload, { numbers: [2, 1] });
});
