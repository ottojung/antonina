import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardIncompatibilityError,
  BOARD_SCHEMA_VERSION,
  PREVIOUS_BOARD_SCHEMA_VERSION,
  LEGACY_BOARD_SCHEMA_VERSION,
  emptyBoard,
  parseBoard,
  parseLegacyBoardV2,
  parseLegacyBoardV3,
  parsePersistedBoard,
} from '../dist/model.js';
import { migratePersistedBoard, everySupersededVersionHasAMigration } from '../dist/migrations.js';

const at = '2026-09-24T00:00:00.000Z';
const issue = (number = '1') => ({
  number, title: 'An issue', body: '', state: 'open',
  createdAt: at, updatedAt: at, messages: [],
});
const resource = () => ({
  host: 'lubko://phoebe-dev', path: '/workspace/project',
  issueNumbers: ['1'], createdAt: at, updatedAt: at,
});

function rejected(board) {
  try { parseBoard(board); }
  catch (error) {
    assert.ok(error instanceof BoardIncompatibilityError);
    return error;
  }
  assert.fail('invalid board should be refused');
}

test('current boards contain issues and resources but no centralized execution catalog', () => {
  const board = emptyBoard();
  assert.equal(board.schemaVersion, BOARD_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(board).sort(), ['issues', 'nextIssueNumber', 'schemaVersion']);
  assert.deepEqual(parseBoard(board), board);
  assert.equal(rejected({ ...board, targets: [] }).defect.kind, 'key-set');
  assert.equal(rejected({ ...board, dispatches: [] }).defect.kind, 'key-set');
});

test('the schema mismatch is distinguished from a field-shape mistake', () => {
  const board = emptyBoard();
  const future = rejected({ ...board, schemaVersion: BOARD_SCHEMA_VERSION + 1 });
  assert.equal(future.defect.kind, 'schema-version-mismatch');
  const malformed = rejected({ ...board, issues: 'not an array' });
  assert.equal(malformed.defect.field, 'issues');
});

test('malformed nested issues and resources are rejected with useful indexed diagnostics', () => {
  const value = { ...emptyBoard(), nextIssueNumber: 2, issues: [issue()], resources: [resource()] };
  assert.deepEqual(parseBoard(value), value);
  const invalidIssue = rejected({ ...value, issues: [{ ...issue(), state: 'waiting' }] });
  assert.equal(invalidIssue.defect.subject, 'board issue at index 0');
  const invalidResource = rejected({ ...value, resources: [{ ...resource(), issueNumbers: ['2'] }] });
  assert.match(invalidResource.message, /resource|issue/i);
});

test('v2 and v3 historical formats remain readable but project into the v4 shape', () => {
  const v2 = { schemaVersion: LEGACY_BOARD_SCHEMA_VERSION, nextIssueNumber: 2,
    issues: [issue()], resources: [resource()] };
  const v3 = { ...v2, schemaVersion: PREVIOUS_BOARD_SCHEMA_VERSION,
    targets: [{ id: 'legacy-only' }], dispatches: [{ targetId: 'legacy-only' }] };
  assert.deepEqual(parseLegacyBoardV2(v2), v2);
  assert.deepEqual(parseLegacyBoardV3(v3), v3);
  assert.deepEqual(parsePersistedBoard(v3), v3);
  for (const legacy of [v2, v3]) {
    const projection = migratePersistedBoard(legacy).board;
    assert.deepEqual(projection, { ...v2, schemaVersion: BOARD_SCHEMA_VERSION });
    assert.equal(Object.hasOwn(projection, 'targets'), false);
    assert.equal(Object.hasOwn(projection, 'dispatches'), false);
  }
  assert.equal(everySupersededVersionHasAMigration(), true);
});

test('legacy-only records cannot be inserted in the active canonical representation', () => {
  const board = emptyBoard();
  for (const extra of [
    { targets: [{ id: 'old' }] },
    { dispatches: [{ targetId: 'old' }] },
  ]) {
    assert.equal(rejected({ ...board, ...extra }).defect.kind, 'key-set');
  }
});

test('a parser failure does not quote secret fields or untrusted contents', () => {
  const secret = 'private-credential-token-123';
  const bad = rejected({ ...emptyBoard(), issues: [secret] });
  assert.equal(bad.message.includes(secret), false);
});
