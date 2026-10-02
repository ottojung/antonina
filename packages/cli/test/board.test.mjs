import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeSkrynia } from '../../core/test/fake-skrynia.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI compiles its own copy of packages/core, so the test drives the exact
// module graph the shipped executable runs, including its error identities.
import { BoardApi } from '../dist/packages/core/src/api.js';
import { serializeBoardCredential, serializeBoardTrustAnchor } from '../dist/packages/core/src/credential.js';
import {
  runBoardCommand,
  configuredIdentity,
  BOARD_BASE_URL_ENV,
} from '../dist/packages/cli/src/board.js';
import { boardConfigDir } from '../dist/packages/cli/src/board-config.js';

const STAMP = '2026-09-25T12:00:00.000Z';

// A home directory that cannot exist, so a board command that fell through to
// the ambient `$HOME` would find no configuration rather than the operator's.
const TEST_HOME = '/nonexistent-antonina-test-home';

// A filesystem that is never read, for the path-resolution assertions that are
// about naming and not about contents.
const noFs = { readFileSync: () => assert.fail('no configuration file should be read') };

/**
 * A real, throwaway `$XDG_CONFIG_HOME/antonina` holding exactly `files`.
 *
 * The CLI resolves its configuration directory from the environment, so this is
 * the whole isolation story for the config tests: a real temporary directory, a
 * real `XDG_CONFIG_HOME` pointing at it, and a home that cannot exist. No test
 * in this file can read or mutate the operator's `~/.config/antonina`.
 */
function configDirectory(files) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-board-config-'));
  const dir = join(root, 'antonina');
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, { mode: 0o600 });
  }
  return { root, dir, env: { XDG_CONFIG_HOME: root }, home: TEST_HOME };
}

function jsonResponse(value, status = 200, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function client(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `cli-${++sequence}`,
    ...options,
  });
}

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function run(argv, context) {
  const capture = memoryIo();
  // `home` is a deliberately unreachable directory: these tests must resolve the
  // configuration root from the environment they are given and never from the
  // ambient `$HOME/.config/antonina` they happen to run under.
  return runBoardCommand(argv, { env: {}, home: TEST_HOME, io: capture.io, ...context }).then((code) => ({ code, ...capture }));
}

test('board CLI emits deterministic JSON list output for a board-key holder', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  const initialized = await owner.initialize();
  await owner.createIssue('First', 'signed board');

  const reader = client(server, { credential: initialized.credential });
  const capture = memoryIo();
  const code = await runBoardCommand(['list', '--page', '1', '--json'], { env: {}, home: TEST_HOME, io: capture.io, createClient: () => reader });

  assert.equal(code, 0);
  assert.equal(JSON.parse(capture.out[0])[0].title, 'First');
  assert.deepEqual(capture.err, []);
});

test('board show pages newest comments while retaining the issue description', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  const initialized = await owner.initialize();
  await owner.createIssue('Paged', 'issue description');
  for (let index = 1; index <= 55; index += 1) {
    await owner.comment(1, 'worker', 'comment-' + String(index).padStart(2, '0'));
  }

  const reader = client(server, { credential: initialized.credential });
  const first = await run(['show', '1', '--page', '1', '--json'], { createClient: () => reader });
  assert.equal(first.code, 0, first.err.join('\n'));
  const firstIssue = JSON.parse(first.out[0]);
  assert.equal(firstIssue.body, 'issue description');
  assert.equal(firstIssue.messages.length, 50);
  assert.equal(firstIssue.messages[0].body, 'comment-06');
  assert.equal(firstIssue.messages[49].body, 'comment-55');

  const second = await run(['show', '1', '--page', '2', '--json'], { createClient: () => reader });
  assert.equal(second.code, 0, second.err.join('\n'));
  const secondIssue = JSON.parse(second.out[0]);
  assert.equal(secondIssue.body, 'issue description');
  assert.deepEqual(secondIssue.messages.map((message) => message.body), [
    'comment-01',
    'comment-02',
    'comment-03',
    'comment-04',
    'comment-05',
  ]);

  const third = await run(['show', '1', '--page', '3', '--json'], { createClient: () => reader });
  assert.equal(third.code, 0, third.err.join('\n'));
  const thirdIssue = JSON.parse(third.out[0]);
  assert.equal(thirdIssue.body, 'issue description');
  assert.deepEqual(thirdIssue.messages, []);
});

test('board CLI requires author from flag or environment', async () => {
  const capture = memoryIo();
  const code = await runBoardCommand(['comment', '1', 'hello'], {
    env: {},
    home: TEST_HOME,
    io: capture.io,
    createClient: () => client(fakeSkrynia()),
  });
  assert.equal(code, 1);
  assert.match(capture.err[0], /ANTONINA_BOARD_AUTHOR/);
});

test('no board CLI command creates a missing board', async () => {
  const server = fakeSkrynia();
  const methods = [];
  const reader = client(server, { fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); } });

  for (const command of [['list', '--page', '1'], ['access'], ['queue', 'list', '--page', '1'], ['create', 'Mine']]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.match(err[0], /^antonina board: /, command.join(' '));
  }

  assert.equal(methods.includes('POST'), false);
  assert.equal(server.signed, null);
});

test('every read command names initialization while the board is missing', async () => {
  const server = fakeSkrynia();
  const missing = 'antonina board: Antonina board does not exist; run: antonina board initialize to create it';

  for (const command of [
    ['list', '--page', '1'],
    ['list', '--page', '1', '--json'],
    ['show', '1', '--page', '1'],
    ['queue', 'list', '--page', '1'],
    ['resource', 'list', '--page', '1'],
    ['collect', 'list', '--page', '1', '--host', 'lubko://host-1'],
  ]) {
    const { code, err } = await run(command, { createClient: () => client(server) });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], missing, command.join(' '));
  }

  assert.equal(server.signed, null);
});

test('mutating commands name initialization before they demand a credential', async () => {
  const server = fakeSkrynia();
  const missing = 'antonina board: Antonina board does not exist; run: antonina board initialize to create it';
  const methods = [];
  const reader = client(server, { fetch: async (url, init = {}) => { methods.push(init.method); return server.fetch(url, init); } });

  for (const command of [
    ['access'],
    ['create', 'Mine'],
    ['close', '1'],
    ['resource', 'add', '1', 'lubko://host', '/workspace'],
  ]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], missing, command.join(' '));
  }

  assert.equal(methods.includes('POST'), false);
  assert.equal(methods.includes('PUT'), false);
  assert.equal(server.signed, null);
});

test('a client on an existing board with no credential is told exactly that', async () => {
  const server = fakeSkrynia();
  const initialized = await client(server).initialize();
  const reader = client(server, { trustAnchor: initialized.trustAnchor });

  for (const command of [['access'], ['create', 'Mine']]) {
    const { code, err } = await run(command, { createClient: () => reader });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], 'antonina board: Antonina board exists; this client has no board credential; save the shared board credential as $XDG_CONFIG_HOME/antonina/credential.json', command.join(' '));
  }

  assert.equal(server.signed.revision, 1);
});

test('every read command names the board credential when access is not configured', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();
  const untrusted = 'antonina board: Antonina board exists; this client has no board credential; '
    + 'save the shared board credential as $XDG_CONFIG_HOME/antonina/credential.json';

  for (const command of [
    ['list', '--page', '1'],
    ['show', '1', '--page', '1'],
    ['queue', 'list', '--page', '1'],
    ['resource', 'list', '--page', '1'],
    ['collect', 'list', '--page', '1', '--host', 'lubko://host-1'],
  ]) {
    const { code, err } = await run(command, { createClient: () => client(server) });
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], untrusted, command.join(' '));
  }
});

test('a missing board fails closed for a client that holds a valid credential', async () => {
  const elsewhere = await client(fakeSkrynia()).initialize();
  const server = fakeSkrynia();
  const writer = client(server, { credential: elsewhere.credential });
  await assert.rejects(() => writer.createIssue('Mine'), /does not exist/);

  const { code, err } = await run(['create', 'Mine'], { createClient: () => writer });

  assert.equal(code, 1);
  assert.equal(err[0], 'antonina board: Antonina board does not exist; run: antonina board initialize to create it');
  assert.equal(server.signed, null);
});

test('board CLI reports an existing board instead of taking the trust root again', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();

  const { code, err } = await run(['initialize'], { createClient: () => client(server) });

  assert.equal(code, 1);
  assert.match(err[0], /already exists/);
});

test('board CLI reports the integrity anchor and board credential after initialization', async () => {
  const server = fakeSkrynia();
  const { code, out } = await run(['initialize', '--json'], { createClient: () => client(server) });

  assert.equal(code, 0);
  const printed = JSON.parse(out[0]);
  assert.equal(printed.credential.keyId, printed.trustAnchor.rootKeyId);
  assert.equal(printed.state.board.nextIssueNumber, 1);
  assert.equal(server.signed.format, 'compact-materialized-snapshots');
  assert.equal(server.signed.revision, 1);
});

test('board CLI hands the initializer the integrity anchor and board credential', async () => {
  const server = fakeSkrynia();
  const { out } = await run(['initialize'], { createClient: () => client(server) });
  const anchor = JSON.parse(out[2]);
  const credential = JSON.parse(out[4]);

  assert.equal(out[1], 'Integrity anchor (public; does not grant board access):');
  assert.equal(serializeBoardTrustAnchor(anchor), out[2]);
  assert.equal(out[3], 'Board credential (secret; grants full access):');
  assert.equal(serializeBoardCredential(credential), out[4]);
  // The credential carries the capability Skrynia minted for the pointer object
  // itself, which is what authorizes every later CAS of that object.
  assert.equal(credential.storageCapability, server.capabilityOf('board-v2'));
  assert.equal(credential.rootKeyId, anchor.rootKeyId);
});

test('board CLI prints only the credential for a pipe-friendly initialization', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(['initialize', '--credential'], { createClient: () => client(server) });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.equal(out.length, 1);
  const credential = JSON.parse(out[0]);
  assert.equal(out[0], serializeBoardCredential(credential));
  // The credential carries the capability Skrynia minted for the pointer object
  // itself, which is what authorizes every later CAS of that object.
  assert.equal(credential.storageCapability, server.capabilityOf('board-v2'));
});

test('board CLI prints only the public integrity anchor for a pipe-friendly initialization', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(['initialize', '--trust-anchor'], { createClient: () => client(server) });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.equal(out.length, 1);
  const anchor = JSON.parse(out[0]);
  assert.equal(out[0], serializeBoardTrustAnchor(anchor));
  assert.ok(anchor.rootKeyId);
  assert.equal('credential' in anchor, false);
});

test('board CLI refuses to print both initialization values at once', async () => {
  const server = fakeSkrynia();
  const { code, out, err } = await run(
    ['initialize', '--credential', '--trust-anchor'],
    { createClient: () => client(server) },
  );

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /one value at a time/);
  assert.equal(server.signed, null);
});

test('board CLI refuses to print a secret value as JSON', async () => {
  const server = fakeSkrynia();
  const conflict = 'antonina board: --json cannot be combined with --credential or --trust-anchor';

  for (const argv of [['initialize', '--credential', '--json'], ['initialize', '--trust-anchor', '--json']]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.equal(err.length, 1, argv.join(' '));
    assert.equal(err[0], conflict, argv.join(' '));
    assert.equal(server.signed, null, argv.join(' '));
  }
});

test('board CLI refuses a repeated or unrecognized flag to initialize', async () => {
  const server = fakeSkrynia();
  const unexpected = 'antonina board: unexpected arguments for initialize';

  for (const argv of [
    ['initialize', '--credential', '--credential'],
    ['initialize', '--credential', 'stray'],
    ['initialize', '--unknown'],
  ]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.equal(err.length, 1, argv.join(' '));
    assert.equal(err[0], unexpected, argv.join(' '));
    assert.equal(server.signed, null, argv.join(' '));
  }
});

test('a pipe-friendly initialization leaves stdout empty when the board already exists', async () => {
  const server = fakeSkrynia();
  await client(server).initialize();

  for (const argv of [['initialize', '--credential'], ['initialize', '--trust-anchor']]) {
    const { code, out, err } = await run(argv, { createClient: () => client(server) });
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.match(err[0], /already exists/);
    assert.equal(/storageCapability|rootKeyId/.test(err.join('\n')), false);
  }
});

test('a board command takes its board credential and optional integrity anchor from config files', async () => {
  const initialized = await client(fakeSkrynia()).initialize();
  const config = configDirectory({
    'trust.json': serializeBoardTrustAnchor(initialized.trustAnchor),
    'credential.json': serializeBoardCredential(initialized.credential),
  });

  // Nothing here exports a variable: the identity a board command runs as is
  // read entirely out of the configuration directory.
  const identity = configuredIdentity({ env: config.env, io: { stdout() {}, stderr() {} } });
  assert.deepEqual(identity.trustAnchor, initialized.trustAnchor);
  assert.deepEqual(identity.credential, initialized.credential);

  // And the loader is what `runBoardCommand` itself consults: a malformed file
  // in that same directory stops the command, which an unread directory would not.
  const broken = configDirectory({ 'credential.json': 'not json' });
  const { code, err } = await run(['list', '--page', '1'], { env: broken.env, home: broken.home });
  assert.equal(code, 1);
  assert.match(err[0], /credential\.json must contain valid JSON/);
});

test('the config directory follows XDG_CONFIG_HOME and the home fallback', () => {
  assert.equal(
    boardConfigDir({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/op', fs: noFs }),
    '/xdg/antonina',
  );
  // An unset *and* an empty `XDG_CONFIG_HOME` both fall back: an empty value is
  // an unset value here, never the current directory.
  for (const env of [{ XDG_CONFIG_HOME: '' }, {}]) {
    assert.equal(boardConfigDir({ env, home: '/home/op', fs: noFs }), '/home/op/.config/antonina');
  }
  assert.notEqual(boardConfigDir({ env: { XDG_CONFIG_HOME: '' }, home: '/home/op', fs: noFs }), 'antonina');
});

test('a board command refuses a config file it cannot parse and names its path', async () => {
  const notJson = configDirectory({ 'trust.json': 'not json' });
  const badJson = await run(['list', '--page', '1'], { env: notJson.env, home: notJson.home });
  assert.equal(badJson.code, 1);
  assert.match(badJson.err[0], /trust\.json must contain valid JSON/);

  const wrongShape = configDirectory({ 'credential.json': '{"schemaVersion":1}' });
  const badShape = await run(['list', '--page', '1'], { env: wrongShape.env, home: wrongShape.home });
  assert.equal(badShape.code, 1);
  assert.match(badShape.err[0], /credential\.json: Antonina board credential is malformed/);

  // The rejected value's secret never reaches the operator's terminal.
  assert.equal(/storageCapability|privateKey/.test(badShape.err.join('\n')), false);
});

test('a board command has no identity when the config files are absent', async () => {
  const io = { stdout() {}, stderr() {} };
  // A directory that does not exist at all, and a real one holding something
  // else, are both "nothing is configured" rather than failures.
  for (const config of [{ env: { XDG_CONFIG_HOME: TEST_HOME }, home: TEST_HOME }, configDirectory({ 'notes.txt': 'hello' })]) {
    const identity = configuredIdentity({ env: config.env, io });
    assert.equal(identity.trustAnchor, null, config.env.XDG_CONFIG_HOME);
    assert.equal(identity.credential, null, config.env.XDG_CONFIG_HOME);
  }

  // An unconfigured board is not an error at load time; it fails closed as soon
  // as a command actually needs the board, naming initialization.
  const { code, err } = await run(['list', '--page', '1'], { env: { XDG_CONFIG_HOME: TEST_HOME }, home: TEST_HOME, createClient: () => client(fakeSkrynia()) });
  assert.equal(code, 1);
  assert.match(err[0], /does not exist; run: antonina board initialize/);
});

test('the injected home resolves the config directory when XDG_CONFIG_HOME is unset', async () => {
  // The home fallback has to be reachable through the command context, not just
  // through the path helper: this is the only thing keeping a test that exports
  // no XDG_CONFIG_HOME off the ambient `~/.config/antonina`.
  const initialized = await client(fakeSkrynia()).initialize();
  const home = mkdtempSync(join(tmpdir(), 'antonina-board-home-'));
  mkdirSync(join(home, '.config', 'antonina'), { recursive: true });
  writeFileSync(join(home, '.config', 'antonina', 'trust.json'), serializeBoardTrustAnchor(initialized.trustAnchor));

  const identity = configuredIdentity({ env: {}, home, io: { stdout() {}, stderr() {} } });
  assert.deepEqual(identity.trustAnchor, initialized.trustAnchor);
  assert.equal(identity.credential, null);
});

test('a mismatched integrity anchor and board credential are still refused', async () => {
  const first = await client(fakeSkrynia()).initialize();
  const second = await client(fakeSkrynia()).initialize();
  const mismatched = configDirectory({
    'credential.json': serializeBoardCredential(first.credential),
    'trust.json': serializeBoardTrustAnchor(second.trustAnchor),
  });

  const capture = memoryIo();
  const code = await runBoardCommand(['access'], {
    env: mismatched.env,
    home: mismatched.home,
    io: capture.io,
    createClient: () => new BoardApi({
      baseUrl: mismatched.env[BOARD_BASE_URL_ENV],
      ...configuredIdentity({ env: mismatched.env, io: capture.io }),
    }),
  });

  assert.equal(code, 1);
  assert.match(capture.err[0], /does not match the configured board trust anchor/);
});

async function queuedBoard() {
  const server = fakeSkrynia();
  const owner = client(server);
  const initialized = await owner.initialize();
  for (const title of ['One', 'Two', 'Three']) await owner.createIssue(title);
  return { server, initialized, client: client(server, { credential: initialized.credential, trustAnchor: initialized.trustAnchor }) };
}

test('board CLI queue reorder prints the committed order on one line', async () => {
  const board = await queuedBoard();
  const before = board.server.signed.revision;
  const { code, out, err } = await run(['queue', 'reorder', '3', '1', '2'], { createClient: () => board.client });

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, ['#3 #1 #2']);
  assert.equal(board.server.signed.revision, before + 1);
  assert.deepEqual(await board.client.getQueue(), [3, 1, 2]);
});

test('board CLI queue list prints the reordered order in human and JSON form', async () => {
  const board = await queuedBoard();
  await run(['queue', 'reorder', '3', '1', '2'], { createClient: () => board.client });

  const human = await run(['queue', 'list', '--page', '1'], { createClient: () => board.client });
  assert.equal(human.code, 0);
  assert.deepEqual(human.out, ['#3 #1 #2']);

  const json = await run(['queue', 'list', '--page', '1', '--json'], { createClient: () => board.client });
  assert.equal(json.code, 0);
  assert.deepEqual(json.out, ['[3,1,2]']);
  assert.deepEqual(JSON.parse(json.out[0]), [3, 1, 2]);
});

test('board CLI queue reorder refuses a permutation that is not the open issues and changes nothing', async () => {
  const board = await queuedBoard();
  await board.client.reorderQueue([2, 1, 3]);
  const stored = board.server.signed;

  for (const argv of [
    ['queue', 'reorder', '1', '2'],
    ['queue', 'reorder', '2', '3', '99'],
  ]) {
    const { code, out, err } = await run(argv, { createClient: () => board.client });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.match(err[0], /^antonina board: /, argv.join(' '));
    assert.match(err[0], /every open issue exactly once/, argv.join(' '));
    assert.equal(board.server.signed, stored, argv.join(' '));
  }
});

test('board CLI queue reorder refuses a closed issue and changes nothing', async () => {
  const board = await queuedBoard();
  await board.client.close(3);
  const stored = board.server.signed;

  const { code, out, err } = await run(['queue', 'reorder', '1', '2', '3'], { createClient: () => board.client });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /every open issue exactly once/);
  assert.equal(board.server.signed, stored);
  assert.deepEqual(await board.client.getQueue(), [1, 2]);
});

test('board CLI rejects a queue reorder argument that is not a positive integer before any write', async () => {
  const board = await queuedBoard();
  const methods = [];
  const watched = client(board.server, {
    credential: board.initialized.credential,
    trustAnchor: board.initialized.trustAnchor,
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return board.server.fetch(url, init); },
  });

  for (const argv of [['queue', 'reorder', '0'], ['queue', 'reorder', '-1'], ['queue', 'reorder', '01']]) {
    const { code, out, err } = await run(argv, { createClient: () => watched });
    assert.equal(code, 1, argv.join(' '));
    assert.deepEqual(out, [], argv.join(' '));
    assert.match(err[0], /ISSUE must be a positive integer/, argv.join(' '));
  }

  assert.deepEqual(methods, [], 'a malformed argument never reaches the store');
  assert.equal(board.server.signed.revision, 4);
});

test('board CLI refuses a duplicated queue reorder without writing it', async () => {
  const board = await queuedBoard();
  const stored = board.server.signed;
  const methods = [];
  const watched = client(board.server, {
    credential: board.initialized.credential,
    trustAnchor: board.initialized.trustAnchor,
    fetch: async (url, init = {}) => { methods.push(init.method ?? 'GET'); return board.server.fetch(url, init); },
  });

  const { code, out, err } = await run(['queue', 'reorder', '1', '1'], { createClient: () => watched });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /^antonina board: /);
  assert.match(err[0], /Queue-reorder payload is malformed/);
  assert.equal(methods.includes('PUT'), false);
  assert.equal(board.server.signed, stored);
  assert.deepEqual(await board.client.getQueue(), [1, 2, 3]);
});

test('board CLI queue reorder without issue numbers is a usage error', async () => {
  const board = await queuedBoard();
  const stored = board.server.signed;

  const { code, out, err } = await run(['queue', 'reorder'], { createClient: () => board.client });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.equal(err[0], 'antonina board: queue reorder requires issue numbers');
  assert.equal(board.server.signed, stored);
});

test('board CLI queue reorder requires a credential and leaves the board alone', async () => {
  const board = await queuedBoard();
  const reader = client(board.server, { trustAnchor: board.initialized.trustAnchor });
  const stored = board.server.signed;

  const { code, err } = await run(['queue', 'reorder', '3', '2', '1'], { createClient: () => reader });

  assert.equal(code, 1);
  assert.equal(err[0], 'antonina board: Antonina board exists; this client has no board credential; save the shared board credential as $XDG_CONFIG_HOME/antonina/credential.json');
  assert.equal(board.server.signed, stored);
});


test('collection reads require an explicit page and board issue pages follow queue priority', async () => {
  const summaries = Array.from({ length: 55 }, (_, index) => ({
    number: index + 1,
    title: 'Issue ' + (index + 1),
    state: 'open',
    createdAt: STAMP,
    updatedAt: STAMP,
    closedAt: null,
    messageCount: 0,
    hasBody: false,
  }));
  const queue = Array.from({ length: 55 }, (_, index) => 55 - index);
  const reader = {
    listIssueSummaries: async () => summaries,
    getQueue: async () => queue,
  };

  const missing = await run(['list', '--json'], { createClient: () => reader });
  assert.equal(missing.code, 1);
  assert.match(missing.err[0], /--page is required/);

  const first = await run(['list', '--page', '1', '--json'], { createClient: () => reader });
  assert.equal(first.code, 0);
  const firstPage = JSON.parse(first.out[0]);
  assert.equal(firstPage.length, 50);
  assert.equal(firstPage[0].number, 55);
  assert.equal(firstPage.at(-1).number, 6);

  const second = await run(['list', '--page', '2', '--json'], { createClient: () => reader });
  assert.equal(second.code, 0);
  assert.deepEqual(JSON.parse(second.out[0]).map((issue) => issue.number), [5, 4, 3, 2, 1]);

  const queueSecond = await run(['queue', 'list', '--page', '2', '--json'], { createClient: () => reader });
  assert.equal(queueSecond.code, 0);
  assert.deepEqual(JSON.parse(queueSecond.out[0]), [5, 4, 3, 2, 1]);

  const badPage = await run(['list', '--page', '0'], { createClient: () => reader });
  assert.equal(badPage.code, 1);
  assert.match(badPage.err[0], /--page must be a positive integer/);
});

test('board review records a verdict and the blocked close is refused and reported', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  const issue = await owner.createIssue('Kawun handoff', 'branch-to-PR handoff and review lifecycle');

  const recorded = await run(['review', String(issue.number), '--verdict', 'request-changes',
    '--commit', 'aaaaaaa', '--reviewer', 'independent',
    '--rationale', 'Error: recommend no merge'], { createClient: () => owner });
  assert.equal(recorded.code, 0, recorded.err.join('\n'));
  assert.match(recorded.out[0], /Review #1 request-changes by independent about aaaaaaa/);

  // The refusal is what the operator sees: exit 1, and a line that names the
  // blocker rather than a generic failure.
  const closed = await run(['close', String(issue.number)], { createClient: () => owner });
  assert.equal(closed.code, 1);
  assert.match(closed.err.join('\n'), /unresolved review blocker recorded by independent against commit aaaaaaa/);
  assert.equal((await owner.getIssue(issue.number)).state, 'open');

  // And the human form of `show` says the same thing without being asked.
  const shown = await run(['show', String(issue.number)], { createClient: () => owner });
  assert.equal(shown.code, 0);
  assert.match(shown.out.join('\n'), /Review: request-changes/);
  assert.match(shown.out.join('\n'), /Completion blocked:/);
});

test('board review refuses the same-commit override and accepts the fixed commit', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  const issue = await owner.createIssue('Override attempt');
  await run(['review', String(issue.number), '--verdict', 'request-changes', '--commit', 'aaaaaaa',
    '--reviewer', 'independent', '--rationale', 'recommend no merge'], { createClient: () => owner });

  const override = await run(['review', String(issue.number), '--verdict', 'approve', '--commit', 'aaaaaaa',
    '--reviewer', 'front', '--rationale', 'proceed anyway'], { createClient: () => owner });
  assert.equal(override.code, 1);
  assert.match(override.err.join('\n'), /an approval cannot clear the review blocker/);

  const approval = await run(['review', String(issue.number), '--verdict', 'approve', '--commit', 'bbbbbbb',
    '--reviewer', 'independent', '--rationale', 'blocker addressed'], { createClient: () => owner });
  assert.equal(approval.code, 0, approval.err.join('\n'));
  const closed = await run(['close', String(issue.number)], { createClient: () => owner });
  assert.equal(closed.code, 0, closed.err.join('\n'));
});

test('board review names its own missing arguments', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  const issue = await owner.createIssue('Incomplete review');

  const noVerdict = await run(['review', String(issue.number), '--rationale', 'r'], { createClient: () => owner });
  assert.equal(noVerdict.code, 1);
  assert.match(noVerdict.err[0], /review requires --verdict/);

  const badVerdict = await run(['review', String(issue.number), '--verdict', 'recommend-no-merge',
    '--rationale', 'r', '--reviewer', 'independent'], { createClient: () => owner });
  assert.equal(badVerdict.code, 1);
  assert.match(badVerdict.err[0], /Unknown Antonina review verdict/);
});
