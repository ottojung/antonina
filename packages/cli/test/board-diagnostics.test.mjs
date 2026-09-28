import assert from 'node:assert/strict';
import test from 'node:test';

// The CLI compiles its own copy of packages/core, so this drives the module
// graph the shipped executable runs, including the error identity it reports.
import { BoardIncompatibilityError } from '../dist/packages/core/src/board-diagnostics.js';
import {
  BOARD_SCHEMA_VERSION,
  emptyBoard,
  PERSISTED_BOARD_VERSIONS,
} from '../dist/packages/core/src/model.js';
import {
  CURRENT_PERSISTED_BOARD_VERSION,
  migratePersistedBoard,
  NoPersistedBoardMigrationPathError,
  UnsupportedPersistedBoardVersionError,
} from '../dist/packages/core/src/migrations.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

const TEST_HOME = '/nonexistent-antonina-test-home';

// A version this build cannot read at all, one below the oldest it still reads,
// and one this build cannot have been written by, one above the one it writes.
// Both are derived, so a bump cannot turn either refusal case into an
// acceptance case.
const UNREADABLE_BOARD_SCHEMA_VERSION = PERSISTED_BOARD_VERSIONS[0] - 1;
const FUTURE_BOARD_SCHEMA_VERSION = BOARD_SCHEMA_VERSION + 1;

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

/**
 * A client whose every read fails the way an unreadable board makes them fail.
 * The read is the real gate, not a hand-built error: the command layer is handed
 * whatever the gate threw, so driving it from the gate is the only way this file
 * can say anything about versions at all. A hand-built
 * `BoardIncompatibilityError` would leave every version assertion below a
 * restatement of its own fixture, which is what this used to be.
 */
function unreadableBoard(read) {
  return new Proxy({}, { get: () => () => read() });
}

function run(argv, read) {
  const capture = memoryIo();
  return runBoardCommand(argv, {
    env: {},
    home: TEST_HOME,
    io: capture.io,
    createClient: () => unreadableBoard(read),
  }).then((code) => ({ code, ...capture }));
}

/** A stored board carrying a version, read through the real gate. */
const readBoardAt = (schemaVersion) => () => migratePersistedBoard({ ...emptyBoard(), schemaVersion });

const readUnreadableBoard = readBoardAt(UNREADABLE_BOARD_SCHEMA_VERSION);
const readFutureBoard = readBoardAt(FUTURE_BOARD_SCHEMA_VERSION);

const malformedField = new BoardIncompatibilityError({
  kind: 'element',
  subject: 'board execution target at index 1',
  field: 'backend',
  found: 'a string',
  expected: 'one of lubko, github-actions',
  missingKeys: [],
  unexpectedKeys: [],
});

/**
 * The operator has to be told which failure this is. The board command reports
 * whatever the read threw, so a specific diagnosis in the core parser reaches
 * the terminal without the command layer having to know anything about boards;
 * these cases pin that down, because a change on either side that collapses the
 * two back into one generic line would not otherwise fail anything.
 */
test('a board read failure reaches the operator as the specific reason', async () => {
  const tooOld = await run(['list'], readUnreadableBoard);
  assert.equal(tooOld.code, 1);
  assert.match(
    tooOld.err.join('\n'),
    new RegExp(`no migration from persisted board format version ${UNREADABLE_BOARD_SCHEMA_VERSION} `),
  );
  assert.match(tooOld.err.join('\n'), new RegExp(`to version ${CURRENT_PERSISTED_BOARD_VERSION};`));
  assert.doesNotMatch(tooOld.err.join('\n'), /incompatible or malformed/);

  const tooNew = await run(['list'], readFutureBoard);
  assert.equal(tooNew.code, 1);
  assert.match(
    tooNew.err.join('\n'),
    new RegExp(`cannot open a board persisted at format version ${FUTURE_BOARD_SCHEMA_VERSION}`),
  );
  assert.match(tooNew.err.join('\n'), new RegExp(`writes version ${CURRENT_PERSISTED_BOARD_VERSION}\\.`));
  assert.doesNotMatch(tooNew.err.join('\n'), /incompatible or malformed/);

  const field = await run(['list'], () => Promise.reject(malformedField));
  assert.equal(field.code, 1);
  assert.match(field.err.join('\n'), /board execution target at index 1 has a malformed field backend/);
  assert.match(field.err.join('\n'), /expected one of lubko, github-actions/);
  assert.doesNotMatch(field.err.join('\n'), /incompatible or malformed/);

  // The three are told apart, not merely all reported.
  assert.notEqual(tooOld.err.join('\n'), tooNew.err.join('\n'));
  assert.notEqual(tooOld.err.join('\n'), field.err.join('\n'));
});

test('a board read failure is reported on stderr and not on stdout', async () => {
  const { out, err } = await run(['list', '--json'], readUnreadableBoard);
  assert.deepEqual(out, [], 'a failed JSON read must not print a partial payload');
  assert.match(err.join('\n'), new RegExp(`no migration from persisted board format version ${UNREADABLE_BOARD_SCHEMA_VERSION}`));
});

/**
 * The version assertions above are only worth reading because the fixture is a
 * real board read. This pins the refusals themselves, so the operator-facing
 * sentences in the test above are checked against what the gate actually does
 * rather than against a hand-built error's own fields.
 */
test('the refusals this file reports come from the gate, named for the version read', () => {
  const tooOld = captureThrow(readUnreadableBoard);
  assert.ok(tooOld instanceof NoPersistedBoardMigrationPathError);
  assert.equal(tooOld.persistedVersion, UNREADABLE_BOARD_SCHEMA_VERSION);
  // A board from a newer build is a different diagnosis, not the same sentence.
  const tooNew = captureThrow(readFutureBoard);
  assert.ok(tooNew instanceof UnsupportedPersistedBoardVersionError);
  assert.equal(tooNew.persistedVersion, FUTURE_BOARD_SCHEMA_VERSION);
  // The version the reader writes is named by the refusal, and is the one this
  // build writes — neither side of that pair is restated from the other.
  assert.match(tooNew.message, new RegExp(`writes version ${CURRENT_PERSISTED_BOARD_VERSION}\\.`));
  assert.equal(CURRENT_PERSISTED_BOARD_VERSION, BOARD_SCHEMA_VERSION);
  assert.ok(!PERSISTED_BOARD_VERSIONS.includes(UNREADABLE_BOARD_SCHEMA_VERSION));
  assert.ok(!PERSISTED_BOARD_VERSIONS.includes(FUTURE_BOARD_SCHEMA_VERSION));
});

function captureThrow(read) {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'the read was supposed to be refused' });
}
