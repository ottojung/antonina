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

test('agent prompt is not retained as an alias for run', () => {
  assert.throws(
    () => preparePublicCommand('agent', ['prompt', '--id', 'a11d', '--prompt', 'work']),
    (error) => error instanceof PublicCliUsageError && /unknown agent command: prompt/.test(error.message),
  );
  const help = preparePublicCommand('agent', ['--help']);
  assert.equal(help.kind, 'help');
  assert.match(help.text, /\brun\b/);
  assert.doesNotMatch(help.text, /\bprompt\b/);
});

test('board create never accepts a caller-supplied issue id', () => {
  assert.throws(
    () => preparePublicCommand('board', ['create', '--id', '9', '--title', 'title']),
    (error) => error instanceof PublicCliUsageError && /unknown option --id/.test(error.message),
  );
});

test('the public CLI can retract a target caveat and its guidance references', () => {
  assert.deepEqual(
    run('board', ['target', 'set', '--id', 'phoebe-dev', '--clear-limitations', '--clear-guidance']),
    ['target', 'set', 'phoebe-dev', '--clear-limitations', '--clear-guidance'],
  );
  assert.deepEqual(
    run('board', ['target', 'set', '--id', 'phoebe-dev', '--limitation', 'a caveat', '--guidance', 'docs/skills/a.md']),
    ['target', 'set', 'phoebe-dev', '--limitation', 'a caveat', '--guidance', 'docs/skills/a.md'],
  );
  // The help has to name the retraction, or an operator with a terminal has no
  // way to learn that a note can be withdrawn at all.
  const help = preparePublicCommand('board', ['target', 'set', '--help']);
  assert.equal(help.kind, 'help');
  assert.match(help.text, /--clear-limitations/);
  assert.match(help.text, /Retract the target/);
  // `target add` states notes but has nothing to retract.
  const add = preparePublicCommand('board', ['target', 'add', '--help']);
  assert.equal(add.kind, 'help');
  assert.equal(/--clear-/.test(add.text), false);
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


test('collection commands require --page and single-item reads do not accept it', () => {
  assert.deepEqual(run('board', ['list', '--page', '2']), ['list', '--page', '2']);
  assert.deepEqual(run('board', ['queue', 'list', '--page', '3']), ['queue', 'list', '--page', '3']);
  assert.deepEqual(run('board', ['feed', '--page', '4']), ['feed', '--page', '4']);
  assert.deepEqual(
    run('board', ['resource', 'list', '--host', 'marceline-dev', '--page', '2']),
    ['resource', 'list', '--host', 'marceline-dev', '--page', '2'],
  );
  assert.deepEqual(run('board', ['target', 'list', '--page', '2']), ['target', 'list', '--page', '2']);
  assert.deepEqual(
    run('board', ['collect', 'list', '--host', 'marceline-dev', '--page', '2']),
    ['collect', 'list', '--host', 'marceline-dev', '--page', '2'],
  );
  assert.deepEqual(run('agent', ['list', '--page', '2']), ['list', '--page', '2']);

  for (const [namespace, argv] of [
    ['board', ['list']],
    ['board', ['queue', 'list']],
    ['board', ['feed']],
    ['board', ['resource', 'list']],
    ['board', ['target', 'list']],
    ['board', ['collect', 'list', '--host', 'marceline-dev']],
    ['agent', ['list']],
  ]) {
    assert.throws(
      () => preparePublicCommand(namespace, argv),
      (error) => error instanceof PublicCliUsageError && /--page is required/.test(error.message),
      namespace + ' ' + argv.join(' '),
    );
  }

  const listHelp = preparePublicCommand('board', ['list', '--help']);
  assert.equal(listHelp.kind, 'help');
  assert.match(listHelp.text, /--page <value>.*required/);

  const feedHelp = preparePublicCommand('board', ['feed', '--help']);
  assert.equal(feedHelp.kind, 'help');
  assert.match(feedHelp.text, /--page <value>.*required/);
  assert.doesNotMatch(feedHelp.text, /--cursor/);
  assert.throws(
    () => preparePublicCommand('board', ['feed', '--page', '1', '--cursor', 'legacy']),
    (error) => error instanceof PublicCliUsageError && /unknown option --cursor/.test(error.message),
  );

  assert.throws(
    () => preparePublicCommand('board', ['show', '--id', '1', '--page', '2']),
    (error) => error instanceof PublicCliUsageError && /unknown option --page/.test(error.message),
  );
  assert.throws(
    () => preparePublicCommand('agent', ['status', '--id', 'a11d', '--page', '2']),
    (error) => error instanceof PublicCliUsageError && /unknown option --page/.test(error.message),
  );
});
