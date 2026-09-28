import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PublicCliUsageError,
  preparePublicCommand,
  publicCommandPaths,
} from '../dist/packages/cli/src/public-cli.js';

function run(namespace, args) {
  const plan = preparePublicCommand(namespace, args);
  assert.equal(plan.kind, 'run');
  return plan.args;
}

test('board issue commands require named data options and translate them to the board adapter', () => {
  assert.deepEqual(
    run('board', ['create', '--title', 'A title', '--body', 'A body']),
    ['create', 'A title', '--body', 'A body'],
  );
  assert.deepEqual(
    run('board', ['comment', '--id', '42', '--body', 'hello', '--author', 'me']),
    ['comment', '42', 'hello', '--author', 'me'],
  );
  assert.deepEqual(
    run('board', ['queue', 'reorder', '--id', '3', '--id', '1', '--id', '2']),
    ['queue', 'reorder', '3', '1', '2'],
  );
});

test('old positional data arguments are rejected at the public CLI boundary', () => {
  assert.throws(
    () => preparePublicCommand('board', ['show', '42']),
    (error) => error instanceof PublicCliUsageError && /every data argument must use a named --option/.test(error.message),
  );
  assert.throws(
    () => preparePublicCommand('board', ['create', 'title', '--body', 'body']),
    (error) => error instanceof PublicCliUsageError && /unexpected positional argument/.test(error.message),
  );
  assert.throws(
    () => preparePublicCommand('agent', ['run', '--id', 'a11d', 'do work']),
    (error) => error instanceof PublicCliUsageError && /unexpected positional argument/.test(error.message),
  );
});

test('option values can contain whitespace, newlines, punctuation and leading dashes', () => {
  const body = '--heading\nline two: [x] $HOME';
  assert.deepEqual(
    run('board', ['comment', '--id', '7', '--body=' + body]),
    ['comment', '7', body],
  );
  assert.deepEqual(
    run('agent', ['run', '--id', 'cafe', '--prompt=--do-not-parse-this-as-an-option', '--detach']),
    ['run', '--id', 'cafe', '--prompt', '--do-not-parse-this-as-an-option', '--detach'],
  );
});

test('board create never accepts a caller-supplied issue id', () => {
  assert.throws(
    () => preparePublicCommand('board', ['create', '--id', '9', '--title', 'title']),
    (error) => error instanceof PublicCliUsageError && /unknown option --id/.test(error.message),
  );
});

test('every public leaf command has both long and short help', () => {
  for (const namespace of ['agent', 'board', 'daemon']) {
    for (const path of publicCommandPaths(namespace)) {
      for (const flag of ['--help', '-h']) {
        const plan = preparePublicCommand(namespace, [...path, flag]);
        assert.equal(plan.kind, 'help', namespace + ' ' + path.join(' ') + ' ' + flag);
        assert.match(plan.text, /^Usage: antonina /);
        assert.match(plan.text, /-h, --help/);
      }
    }
  }
});

test('namespace and board command groups also have help', () => {
  assert.equal(preparePublicCommand('board', ['--help']).kind, 'help');
  assert.equal(preparePublicCommand('board', ['credential', '--help']).kind, 'help');
  assert.equal(preparePublicCommand('board', ['queue', '-h']).kind, 'help');
});

test('unknown options and duplicate scalar options are rejected', () => {
  assert.throws(
    () => preparePublicCommand('board', ['show', '--number', '1']),
    (error) => error instanceof PublicCliUsageError && /unknown option --number/.test(error.message),
  );
  assert.throws(
    () => preparePublicCommand('board', ['show', '--id', '1', '--id', '2']),
    (error) => error instanceof PublicCliUsageError && /--id was provided more than once/.test(error.message),
  );
});
