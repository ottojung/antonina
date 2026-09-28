import assert from 'node:assert/strict';
import test from 'node:test';

// The CLI compiles its own copy of packages/core, so this drives the module
// graph the shipped executable runs, including the error identity it reports.
import { BoardIncompatibilityError } from '../dist/packages/core/src/board-diagnostics.js';
import {
  BOARD_SCHEMA_VERSION,
  LEGACY_BOARD_SCHEMA_VERSION,
} from '../dist/packages/core/src/model.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

const TEST_HOME = '/nonexistent-antonina-test-home';

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

/** A client whose every read fails the way an unreadable board makes them fail. */
function unreadableBoard(error) {
  return new Proxy({}, { get: () => () => Promise.reject(error) });
}

function run(argv, error) {
  const capture = memoryIo();
  return runBoardCommand(argv, {
    env: {},
    home: TEST_HOME,
    io: capture.io,
    createClient: () => unreadableBoard(error),
  }).then((code) => ({ code, ...capture }));
}

const mismatch = new BoardIncompatibilityError({
  kind: 'schema-version-mismatch',
  subject: 'board',
  field: 'schemaVersion',
  // The core parser reports a mismatch by stringifying both versions, so the
  // fixture the CLI is handed is built from the same two constants the parser
  // would have used. A hard-stamped pair would drift from the message this
  // file then asserts on.
  found: String(LEGACY_BOARD_SCHEMA_VERSION),
  expected: String(BOARD_SCHEMA_VERSION),
  missingKeys: [],
  unexpectedKeys: [],
});

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
  const version = await run(['list'], mismatch);
  assert.equal(version.code, 1);
  assert.match(
    version.err.join('\n'),
    new RegExp(`schema version is ${LEGACY_BOARD_SCHEMA_VERSION}, but this build reads schema version ${BOARD_SCHEMA_VERSION}`),
  );
  assert.doesNotMatch(version.err.join('\n'), /incompatible or malformed/);

  const field = await run(['list'], malformedField);
  assert.equal(field.code, 1);
  assert.match(field.err.join('\n'), /board execution target at index 1 has a malformed field backend/);
  assert.match(field.err.join('\n'), /expected one of lubko, github-actions/);
  assert.doesNotMatch(field.err.join('\n'), /incompatible or malformed/);

  // The two are told apart, not merely both reported.
  assert.notEqual(version.err.join('\n'), field.err.join('\n'));
});

test('a board read failure is reported on stderr and not on stdout', async () => {
  const { out, err } = await run(['list', '--json'], mismatch);
  assert.deepEqual(out, [], 'a failed JSON read must not print a partial payload');
  assert.match(err.join('\n'), new RegExp(`schema version is ${LEGACY_BOARD_SCHEMA_VERSION}`));
});
