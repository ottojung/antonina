import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSigningKey } from '../dist/canonical.js';
import { emptyBoard } from '../dist/model.js';
import {
  BOARD_CAPABILITIES,
  createTrustAnchor,
  emptyOperationLog,
  signBoardOperation,
  verifyAndReplayOperationLog,
} from '../dist/operations.js';

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

function clone(value) {
  return structuredClone(value);
}

test('valid root operations verify and replay deterministically', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'issue.create', { number: 1, title: 'First', body: 'body' }, 1);
  await append(log, root, 'issue.comment', { number: 1, author: 'root', body: 'hello' }, 2);
  await append(log, root, 'resource.add', { number: 1, host: 'lubko://host', path: '/workspace' }, 3);

  const first = await verifyAndReplayOperationLog(log, anchor);
  const second = await verifyAndReplayOperationLog(clone(log), anchor);
  assert.deepEqual(second, first);
  assert.equal(first.board.issues[0].title, 'First');
  assert.equal(first.board.issues[0].messages[0].body, 'hello');
  assert.deepEqual(first.queue, [1]);
  assert.deepEqual(first.board.resources[0].issueNumbers, [1]);
});

test('equal and attenuated delegated capabilities are accepted', async () => {
  const { root, anchor, log } = await initialized();
  const parent = await generateSigningKey();
  const child = await generateSigningKey();
  const parentCapabilities = ['authority.delegate', 'issue.comment', 'issue.create'];

  await append(log, root, 'authority.delegate', {
    childKeyId: parent.keyId,
    childPublicKey: parent.publicKey,
    capabilities: parentCapabilities,
  }, 1);
  await append(log, parent, 'authority.delegate', {
    childKeyId: child.keyId,
    childPublicKey: child.publicKey,
    capabilities: ['issue.comment', 'issue.create'],
  }, 2);
  await append(log, child, 'issue.create', { number: 1, title: 'Delegated', body: '' }, 3);

  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.equal(replayed.board.issues[0].title, 'Delegated');
  assert.deepEqual(
    replayed.authorities.find((authority) => authority.keyId === child.keyId).capabilities,
    ['issue.comment', 'issue.create'],
  );
});

test('capability escalation in delegation is rejected', async () => {
  const { root, anchor, log } = await initialized();
  const parent = await generateSigningKey();
  const child = await generateSigningKey();

  await append(log, root, 'authority.delegate', {
    childKeyId: parent.keyId,
    childPublicKey: parent.publicKey,
    capabilities: ['authority.delegate', 'issue.create'],
  }, 1);
  await append(log, parent, 'authority.delegate', {
    childKeyId: child.keyId,
    childPublicKey: child.publicKey,
    capabilities: ['authority.delegate', 'issue.create', 'issue.delete'],
  }, 2);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /capability escalation/);
});

test('operation signed by a key lacking the required capability is rejected', async () => {
  const { root, anchor, log } = await initialized();
  const child = await generateSigningKey();

  await append(log, root, 'authority.delegate', {
    childKeyId: child.keyId,
    childPublicKey: child.publicKey,
    capabilities: ['issue.comment'],
  }, 1);
  await append(log, child, 'issue.create', { number: 1, title: 'Not allowed', body: '' }, 2);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /issue\.create/);
});

test('forged signatures and signer-key substitutions are rejected', async () => {
  const { root, anchor, log } = await initialized();
  const operation = await append(log, root, 'issue.create', { number: 1, title: 'Signed', body: '' }, 1);
  const attacker = await generateSigningKey();

  const forgedSignature = clone(log);
  forgedSignature.operations[1].signature = (await signBoardOperation({
    boardId: log.boardId,
    previous: log.operations[0].opId,
    timestamp: operation.timestamp,
    nonce: operation.nonce,
    kind: operation.kind,
    payload: operation.payload,
  }, attacker)).signature;
  await assert.rejects(() => verifyAndReplayOperationLog(forgedSignature, anchor), /signature/);

  const forgedSigner = clone(log);
  forgedSigner.operations[1].signerKeyId = attacker.keyId;
  await assert.rejects(() => verifyAndReplayOperationLog(forgedSigner, anchor), /(identity hash|unknown)/);
});

test('revoking a parent invalidates the parent and every descendant', async () => {
  const { root, anchor, log } = await initialized();
  const parent = await generateSigningKey();
  const child = await generateSigningKey();

  await append(log, root, 'authority.delegate', {
    childKeyId: parent.keyId,
    childPublicKey: parent.publicKey,
    capabilities: ['authority.delegate', 'issue.create'],
  }, 1);
  await append(log, parent, 'authority.delegate', {
    childKeyId: child.keyId,
    childPublicKey: child.publicKey,
    capabilities: ['issue.create'],
  }, 2);
  await append(log, root, 'authority.revoke', { keyId: parent.keyId }, 3);
  await append(log, child, 'issue.create', { number: 1, title: 'After revoke', body: '' }, 4);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /unknown or revoked/);
});

test('destructive issue deletion requires its own capability', async () => {
  const { root, anchor, log } = await initialized();
  const editor = await generateSigningKey();

  await append(log, root, 'issue.create', { number: 1, title: 'Keep', body: '' }, 1);
  await append(log, root, 'authority.delegate', {
    childKeyId: editor.keyId,
    childPublicKey: editor.publicKey,
    capabilities: ['issue.edit'],
  }, 2);
  await append(log, editor, 'issue.delete', { number: 1 }, 3);

  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /issue\.delete/);
});

test('history removal, reordering, replay, and head replacement are detected', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'issue.create', { number: 1, title: 'One', body: '' }, 1);
  await append(log, root, 'issue.create', { number: 2, title: 'Two', body: '' }, 2);

  const removed = clone(log);
  removed.operations.splice(1, 1);
  await assert.rejects(() => verifyAndReplayOperationLog(removed, anchor), /predecessor chain/);

  const reordered = clone(log);
  [reordered.operations[1], reordered.operations[2]] = [reordered.operations[2], reordered.operations[1]];
  await assert.rejects(() => verifyAndReplayOperationLog(reordered, anchor), /predecessor chain/);

  const replayed = clone(log);
  replayed.operations.push(clone(replayed.operations[2]));
  replayed.head = replayed.operations.at(-1).opId;
  await assert.rejects(() => verifyAndReplayOperationLog(replayed, anchor), /(predecessor chain|duplicate)/);

  const wrongHead = clone(log);
  wrongHead.head = wrongHead.operations[1].opId;
  await assert.rejects(() => verifyAndReplayOperationLog(wrongHead, anchor), /head/);
});

test('rollback to an older valid prefix is rejected when a previously accepted head is remembered', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'issue.create', { number: 1, title: 'One', body: '' }, 1);
  const acceptedHead = log.head;
  await append(log, root, 'issue.create', { number: 2, title: 'Two', body: '' }, 2);

  const oldPrefix = clone(log);
  oldPrefix.operations.pop();
  oldPrefix.head = acceptedHead;

  const freshReplay = await verifyAndReplayOperationLog(oldPrefix, anchor);
  assert.equal(freshReplay.head, acceptedHead);
  await assert.rejects(
    () => verifyAndReplayOperationLog(oldPrefix, anchor, { previouslyAcceptedHead: log.head }),
    /previously accepted head/,
  );
});

test('history from another board or root cannot be spliced in', async () => {
  const left = await initialized();
  const right = await setup();
  await append(right.log, right.root, 'board.initialize', { board: emptyBoard() }, 0);

  await assert.rejects(() => verifyAndReplayOperationLog(right.log, left.anchor), /trust anchor/);

  const spliced = clone(left.log);
  spliced.operations.push(clone(right.log.operations[0]));
  spliced.head = right.log.head;
  await assert.rejects(() => verifyAndReplayOperationLog(spliced, left.anchor), /(different board|predecessor chain)/);
});

test('initialization attests a non-empty starting board as root-signed state', async () => {
  const { root, anchor, log } = await setup();
  const initial = {
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Imported',
      body: 'initial snapshot',
      state: 'open',
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
      messages: [],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  };
  await append(log, root, 'board.initialize', { board: initial }, 1);

  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.equal(replayed.board.issues[0].title, 'Imported');
  assert.equal(replayed.queue[0], 1);
});

test('root has the complete capability vocabulary and board deletion is terminal', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'board.delete', {}, 1);
  const deleted = await verifyAndReplayOperationLog(log, anchor);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(
    deleted.authorities.find((authority) => authority.keyId === root.keyId).capabilities,
    [...BOARD_CAPABILITIES],
  );

  await append(log, root, 'issue.create', { number: 1, title: 'Too late', body: '' }, 2);
  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /follow board deletion/);
});


test('operation history rejects timestamp regression', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'issue.create', { number: 1, title: 'Later', body: '' }, 2);
  await append(log, root, 'issue.comment', { number: 1, author: 'root', body: 'earlier clock' }, 1);
  await assert.rejects(() => verifyAndReplayOperationLog(log, anchor), /timestamps must be nondecreasing/);
});

test('repeated resource registration is a deterministic no-op', async () => {
  const { root, anchor, log } = await initialized();
  await append(log, root, 'issue.create', { number: 1, title: 'Resource owner', body: '' }, 1);
  await append(log, root, 'resource.add', { number: 1, host: 'lubko://host', path: '/workspace' }, 2);
  await append(log, root, 'resource.add', { number: 1, host: 'lubko://host', path: '/workspace' }, 3);
  const replayed = await verifyAndReplayOperationLog(log, anchor);
  assert.equal(replayed.board.resources.length, 1);
  assert.deepEqual(replayed.board.resources[0].issueNumbers, [1]);
  assert.equal(replayed.board.resources[0].updatedAt, timestamp(2));
});
