/**
 * Criterion 3 of board issue 304: old persisted target data must not break
 * startup or board migration, and must not lose unrelated issue or resource
 * data.
 *
 * The v3 board shape carried a target catalog and dispatch assignments. This
 * suite builds a *real* signed v3 board -- the committed v2 fixture stamped v3
 * with populated `targets` and `dispatches`, re-signed with the fixture's
 * throwaway root key, which is what an intermediate release that wrote v3
 * boards into the signed operation log produced -- and opens it through the
 * production paths. It asserts that:
 *
 *   - the migration gate lifts v3 to the current version and drops exactly the
 *     two obsolete collections;
 *   - opening through signature verification and replay yields a board equal to
 *     the same history opened at v2, so nothing else was lost;
 *   - opening rewrites nothing, and is idempotent.
 *
 * Every test runs against a test-owned `XDG_STATE_HOME` and `XDG_CONFIG_HOME`,
 * so no path under test can read or write the operator's state or credentials.
 * The store is an in-memory Skrynia double and the credential is explicit, so
 * the operator's board is never reached.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SignedBoardStore } from '../dist/board-store.js';
import { canonicalJson } from '../dist/canonical.js';
import { createBoardCredential } from '../dist/credential.js';
import * as migrations from '../dist/migrations.js';
import * as model from '../dist/model.js';
import { signBoardOperation, verifyAndReplayOperationLog } from '../dist/operations.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

const roots = await mkdtemp(join(tmpdir(), 'antonina-v3-targets-migration-'));
const previousStateHome = process.env.XDG_STATE_HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_STATE_HOME = join(roots, 'state');
process.env.XDG_CONFIG_HOME = join(roots, 'config');
test.after(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(roots, { recursive: true, force: true });
});

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'board-v2-populated-operation-log.json',
);

/**
 * The throwaway root key the committed v2 fixture was signed with, restated
 * here the same way `migrations.test.mjs` restates it: the public half is the
 * anchor a reader trusts, and the private half is what re-signs the history at
 * v3. It is a test key, not a secret.
 */
const ROOT_KEY = {
  keyId: 'ed25519:-y9TTfl1XE8ZeROsfH-JZx-XgILqwoN0V4jl7itnTR8',
  publicKey: 'QlkyS0Org1pBgnGz8VRYtf0K7_L_J3R_z9NmJAGmN48',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIIcl33zeE-gtzBcuqxw02dHc9_rFTAYDBcimwJdRD_zZ',
};

/** The committed fixture, read fresh so no test shares a mutation. */
function storedLog() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

/** The trust anchor of the fixture, read from the fixture rather than restated. */
function fixtureAnchor(log) {
  return { boardId: log.boardId, rootKeyId: log.rootKeyId, rootPublicKey: ROOT_KEY.publicKey };
}

/**
 * A v3 board carrying the fixture's real issues and resources plus a populated
 * target catalog and dispatch assignments. Two targets and two dispatches, so
 * the migration is not exercised against a single-element collection.
 */
function v3Board(log) {
  const board = log.operations[0].payload.board;
  return {
    schemaVersion: model.PREVIOUS_BOARD_SCHEMA_VERSION,
    nextIssueNumber: board.nextIssueNumber,
    issues: structuredClone(board.issues),
    resources: structuredClone(board.resources),
    targets: [
      {
        id: 'legacy-target',
        backend: 'lubko',
        kind: 'persistent-host',
        status: 'available',
        capabilities: ['persistent-filesystem'],
        address: 'lubko://gpu-01',
        description: 'a legacy execution target',
        limitations: ['one job at a time'],
        guidance: ['docs/skills/resources.md'],
        createdAt: '2026-09-20T09:40:00.000Z',
        updatedAt: '2026-09-20T09:40:00.000Z',
      },
      {
        id: 'legacy-target-2',
        backend: 'lubko',
        kind: 'ephemeral',
        status: 'draining',
        capabilities: [],
        address: 'lubko://gpu-99',
        description: 'another legacy target',
        limitations: [],
        guidance: [],
        createdAt: '2026-09-20T09:41:00.000Z',
        updatedAt: '2026-09-20T09:41:00.000Z',
      },
    ],
    dispatches: [
      { issueNumber: 1, targetId: 'legacy-target', rationale: 'the only target', recordedAt: '2026-09-20T09:50:00.000Z' },
      { issueNumber: 2, targetId: 'legacy-target-2', rationale: 'draining anyway', recordedAt: '2026-09-20T09:51:00.000Z' },
    ],
  };
}

/**
 * The same history, re-signed with the v3 board in the initialize operation.
 * Every operation keeps its timestamp, nonce and payload; only the board object
 * the first operation carries is the v3 one, so the v3 history and the v2
 * fixture are the same board data at two persisted versions.
 */
async function v3Log(log) {
  const operations = [];
  let previous = null;
  for (const original of log.operations) {
    const payload = original.kind === 'board.initialize' ? { board: v3Board(log) } : original.payload;
    const operation = await signBoardOperation({
      boardId: log.boardId,
      previous,
      timestamp: original.timestamp,
      nonce: original.nonce,
      kind: original.kind,
      payload,
    }, ROOT_KEY);
    operations.push(operation);
    previous = operation.opId;
  }
  return { ...log, operations, head: previous };
}

/**
 * Message ids are content-addressed from the signed operation history, so
 * re-signing changes them. Everything a migration must preserve is the rest.
 */
function withoutMessageIds(board) {
  return {
    ...board,
    issues: board.issues.map((issue) => ({
      ...issue,
      messages: issue.messages.map(({ id: _id, ...message }) => message),
    })),
  };
}

test('a populated v3 board migrates to the current version through the gate, dropping only targets and dispatches', () => {
  const board = v3Board(storedLog());
  const migrated = migrations.migratePersistedBoard(board);
  assert.equal(migrated.fromVersion, model.PREVIOUS_BOARD_SCHEMA_VERSION);
  assert.deepEqual(migrated.throughVersions, [model.BOARD_SCHEMA_VERSION]);
  assert.equal(migrated.board.schemaVersion, model.BOARD_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(migrated.board, 'targets'), false);
  assert.equal(Object.hasOwn(migrated.board, 'dispatches'), false);
  // Unrelated data is carried across byte for byte, including the raw catalog.
  assert.deepEqual(migrated.board.issues, board.issues.map(issue => ({ ...issue, number: String(issue.number) })));
  assert.deepEqual(migrated.board.resources, board.resources.map(resource => ({ ...resource, issueNumbers: resource.issueNumbers.map(String) })));
  assert.equal(migrated.board.nextIssueNumber, board.nextIssueNumber);
});

test('a populated v3 board opens through signature verification and replay with no unrelated data loss', async () => {
  const log = storedLog();
  const anchor = fixtureAnchor(log);
  const signedV3 = await v3Log(log);

  // The same history at v2, opened the same way, is the control: the v3 open
  // must yield the same board data, so only the obsolete collections differ.
  const baseline = await verifyAndReplayOperationLog(log, anchor);
  const opened = await verifyAndReplayOperationLog(signedV3, anchor);

  assert.equal(opened.migration.persistedVersion, model.PREVIOUS_BOARD_SCHEMA_VERSION);
  assert.deepEqual(opened.migration.throughVersions, [model.BOARD_SCHEMA_VERSION]);
  assert.equal(Object.hasOwn(opened.board, 'targets'), false);
  assert.equal(Object.hasOwn(opened.board, 'dispatches'), false);
  assert.deepEqual(withoutMessageIds(opened.board), withoutMessageIds(baseline.board));
  assert.deepEqual(opened.queue, baseline.queue);
  // Message ids are still present and well formed, so nothing was dropped in
  // place of the two retired collections.
  assert.ok(opened.board.issues.every((issue) => issue.messages.every((message) => /^sha256:/.test(message.id))));
});

test('opening a populated v3 board rewrites nothing and is idempotent', async () => {
  const log = storedLog();
  const anchor = fixtureAnchor(log);
  const signedV3 = await v3Log(log);
  const before = canonicalJson(signedV3);

  const first = await verifyAndReplayOperationLog(signedV3, anchor);
  const second = await verifyAndReplayOperationLog(signedV3, anchor);
  assert.deepEqual(second, first);
  assert.equal(canonicalJson(signedV3), before, 'opening must not rewrite the persisted v3 bytes');
});

test('a populated v3 board opens through the store read path with nothing else lost', async () => {
  const log = storedLog();
  const anchor = fixtureAnchor(log);
  const signedV3 = await v3Log(log);

  const server = fakeSkrynia();
  server.signed = signedV3;
  const store = new SignedBoardStore({ fetch: server.fetch.bind(server) });
  const credential = await createBoardCredential(anchor, ROOT_KEY, server.capability);

  const before = canonicalJson(server.signed);
  const opened = await store.require(anchor);
  assert.equal(opened.state.migration.persistedVersion, model.PREVIOUS_BOARD_SCHEMA_VERSION);
  assert.deepEqual(opened.state.migration.throughVersions, [model.BOARD_SCHEMA_VERSION]);
  assert.equal(Object.hasOwn(opened.state.board, 'targets'), false);
  assert.equal(Object.hasOwn(opened.state.board, 'dispatches'), false);
  assert.equal(opened.state.board.issues.length, 6);
  assert.equal(opened.state.board.resources[0].path, '/srv/work');
  assert.equal(canonicalJson(server.signed), before, 'opening must not rewrite what is stored');

  // The credential read path (what a migrated board is located by) agrees.
  const reread = await store.readWithCredential(credential);
  assert.notEqual(reread, null);
  assert.deepEqual(withoutMessageIds(reread.state.board), withoutMessageIds(opened.state.board));
});
