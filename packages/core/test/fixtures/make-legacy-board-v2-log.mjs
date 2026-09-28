#!/usr/bin/env node
// Regenerates `board-v2-populated-operation-log.json`.
//
// The point of this fixture is that it is not hand-written: it is produced by
// the real board code of the release that persisted the format, so the bytes
// and the signatures are the ones 0.1.0 actually wrote. Proving that needs a
// build of the old code:
//
//   git archive 907f7ad packages/core | tar -x -C /tmp/legacy
//   (cd /tmp/legacy/packages/core && tsc -p tsconfig.json)
//   node packages/core/test/fixtures/make-legacy-board-v2-log.mjs /tmp/legacy/packages/core/dist
//
// 907f7ad is the last commit whose `model.ts` still declared
// `BOARD_SCHEMA_VERSION = 2`; the very next board change is the v2 -> v3
// execution-target break this fixture has to survive.
//
// This is a maintenance script, not a test: it needs a checkout of retired code
// and therefore cannot run in CI. `node --test` never invokes it.
//
// The signing key below is a throwaway key generated once for this fixture and
// committed on purpose. It is a synthetic board with no authority anywhere: it
// can only ever sign more operations on the fixture itself, which is what makes
// the fixture reproducible byte for byte.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const legacyDist = process.argv[2];
if (!legacyDist) {
  throw new Error('usage: make-legacy-board-v2-log.mjs <path-to-legacy-core-dist>');
}

const legacy = (name) => import(pathToFileURL(join(legacyDist, name)).href);

const ROOT = {
  keyId: 'ed25519:-y9TTfl1XE8ZeROsfH-JZx-XgILqwoN0V4jl7itnTR8',
  publicKey: 'QlkyS0Org1pBgnGz8VRYtf0K7_L_J3R_z9NmJAGmN48',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIIcl33zeE-gtzBcuqxw02dHc9_rFTAYDBcimwJdRD_zZ',
};
const CHILD = {
  keyId: 'ed25519:Vp2GP2F7SOLExy7wSO_56Z0FcZuyCyve-CgikP1aC44',
  publicKey: 'tE0Mll0deXE5eP8RvAzLGisdds3jouum6bMtTLJ9DBk',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIEePfaPIxK91KRcAPqeo14yQYrD4Ndrif5_ZcXRI1gOD',
};

const BOARD_ID = 'board-fixture-v2-populated';
const at = (minute) => `2026-09-20T09:${String(minute).padStart(2, '0')}:00.000Z`;

const { createTrustAnchor, emptyOperationLog, signBoardOperation, verifyAndReplayOperationLog } =
  await legacy('operations.js');
const { keyIdFromPublicKey } = await legacy('canonical.js');

const CHILD_KEY_ID = await keyIdFromPublicKey(CHILD.publicKey);
if (CHILD_KEY_ID !== CHILD.keyId) throw new Error('child key fixture is inconsistent');
const ROOT_KEY_ID = await keyIdFromPublicKey(ROOT.publicKey);
if (ROOT_KEY_ID !== ROOT.keyId) throw new Error('root key fixture is inconsistent');

const anchor = await createTrustAnchor(BOARD_ID, ROOT);
const log = emptyOperationLog(anchor);

async function append(signer, kind, payload, minute) {
  const operation = await signBoardOperation({
    boardId: BOARD_ID,
    previous: log.head,
    timestamp: at(minute),
    nonce: `fixture-${kind}-${minute}`,
    kind,
    payload,
  }, signer);
  log.operations.push(operation);
  log.head = operation.opId;
  return operation;
}

// A populated board of the shape 0.1.0 persisted: two issues with content, one
// of them closed and carrying a message, one that an operation will edit, and
// two resources depending on different issues.
const seededBoard = {
  schemaVersion: 2,
  nextIssueNumber: 5,
  issues: [
    {
      number: 1,
      title: 'Migrate the persisted board format',
      body: 'Signed by 0.1.0 and never rewritten since.',
      state: 'open',
      createdAt: at(1),
      updatedAt: at(1),
      messages: [],
    },
    {
      number: 2,
      title: 'Collect the finished archive',
      body: 'Closed before the signing that carries it.',
      state: 'closed',
      createdAt: at(2),
      updatedAt: at(3),
      messages: [{
        id: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        author: '71a1',
        body: 'closing this one; the resource can be collected',
        createdAt: at(3),
      }],
    },
    {
      number: 3,
      title: 'Rehearse the reopen path',
      body: 'Closed and reopened by the operations below.',
      state: 'open',
      createdAt: at(4),
      updatedAt: at(4),
      messages: [],
    },
    {
      number: 4,
      title: 'Write the migration fixtures',
      body: 'This board is one of them.',
      state: 'open',
      createdAt: at(5),
      updatedAt: at(5),
      messages: [],
    },
  ],
  resources: [
    {
      host: 'lubko://gpu-01',
      path: '/srv/work',
      issueNumbers: [1, 3],
      createdAt: at(6),
      updatedAt: at(6),
    },
    {
      host: 'lubko://gpu-02',
      path: '/srv/archive',
      issueNumbers: [2],
      createdAt: at(7),
      updatedAt: at(7),
    },
  ],
};

await append(ROOT, 'board.initialize', { board: seededBoard }, 0);
await append(ROOT, 'authority.delegate', {
  childKeyId: CHILD.keyId,
  childPublicKey: CHILD.publicKey,
  capabilities: ['issue.comment', 'issue.create', 'resource.modify'],
}, 1);
await append(CHILD, 'issue.create', {
  number: 5,
  title: 'Collect from the closed issue',
  body: 'Created by a delegated key.',
}, 2);
await append(ROOT, 'issue.edit', {
  number: 1,
  title: null,
  body: 'Signed by 0.1.0, edited by 0.1.0, and never rewritten since.',
}, 3);
await append(CHILD, 'issue.comment', { number: 1, author: '73a1', body: 'comment from the delegated key' }, 4);
await append(ROOT, 'issue.comment', { number: 1, author: '71a1', body: 'comment from the root key' }, 5);
await append(ROOT, 'issue.close', { number: 3 }, 6);
await append(ROOT, 'issue.reopen', { number: 3 }, 7);
await append(CHILD, 'resource.add', { number: 5, host: 'lubko://gpu-01', path: '/srv/work' }, 8);
await append(ROOT, 'resource.remove', { number: 2, host: 'lubko://gpu-02', path: '/srv/archive' }, 9);
await append(ROOT, 'queue.reorder', { numbers: [5, 1, 3, 4] }, 10);
await append(ROOT, 'authority.revoke', { keyId: CHILD.keyId }, 11);
await append(ROOT, 'issue.create', { number: 6, title: 'After the revocation', body: 'Root-signed tail.' }, 12);

// The fixture is only worth committing if the code that wrote it accepted it.
const replayed = await verifyAndReplayOperationLog(JSON.parse(JSON.stringify(log)), anchor);
if (replayed.board.schemaVersion !== 2) throw new Error('legacy build did not replay a v2 board');
// The queue order the fixture is meant to pin: the reorder, then the issue
// created after it.
if (replayed.queue.join(',') !== '5,1,3,4,6') {
  throw new Error(`legacy queue order is not the one the fixture intends: ${replayed.queue.join(',')}`);
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'board-v2-populated-operation-log.json'), `${JSON.stringify(log, null, 2)}\n`);
process.stdout.write(`wrote ${log.operations.length} signed operations (head ${log.head})\n`);
