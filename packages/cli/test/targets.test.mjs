import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi } from '../dist/packages/core/src/api.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

const STAMP = '2026-09-25T12:00:00.000Z';

// A home directory that cannot exist, so a board command that fell through to
// the ambient `$HOME` would find no configuration rather than the operator's.
const TEST_HOME = '/nonexistent-antonina-target-test-home';

function jsonResponse(value, status = 200, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        return signed === null ? new Response(null, { status: 404 }) : jsonResponse(signed, 200, etag());
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return jsonResponse({ mode: 'capability-write', capability }, 201);
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) return jsonResponse({ error: 'invalid capability' }, 403);
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function client(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `cli-target-${++sequence}`,
    ...options,
  });
}

function run(argv, owner) {
  const out = [];
  const err = [];
  const io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  return runBoardCommand(argv, { env: {}, home: TEST_HOME, io, createClient: () => owner })
    .then((code) => ({ code, out, err }));
}

const PHOEBE = [
  'target', 'add', 'phoebe-dev',
  '--backend', 'lubko',
  '--kind', 'persistent-host',
  '--address', 'lubko://phoebe-dev',
  '--capability', 'network-egress',
  '--capability', 'persistent-filesystem',
  '--description', 'persistent Lubko workstation',
];

const ACTIONS = [
  'target', 'add', 'github-actions',
  '--backend', 'github-actions',
  '--kind', 'ephemeral-environment',
  '--capability', 'container-isolation',
  '--capability', 'ephemeral-lifetime',
  '--capability', 'network-egress',
];

test('the CLI registers and lists execution targets of different backends', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();

  const added = await run(PHOEBE, owner);
  assert.equal(added.code, 0);
  assert.equal(added.out[0], 'phoebe-dev [lubko/persistent-host] available'
    + ' [network-egress, persistent-filesystem] lubko://phoebe-dev');
  assert.equal(added.err.length, 0);

  assert.equal((await run(ACTIONS, owner)).code, 0);
  assert.equal((await run(['target', 'add', 'github-actions', '--backend', 'github-actions', '--kind', 'ephemeral-environment'], owner)).code, 1);

  const listed = await run(['target', 'list'], owner);
  assert.equal(listed.code, 0);
  assert.equal(listed.out[0].startsWith('github-actions [github-actions/ephemeral-environment] available'), true);
  assert.equal(listed.out[0].includes('no-host'), true);
  assert.equal(listed.out[1].startsWith('phoebe-dev [lubko/persistent-host] available'), true);

  const filtered = await run(['target', 'list', '--backend', 'lubko', '--json'], owner);
  assert.deepEqual(JSON.parse(filtered.out[0]).map((target) => target.id), ['phoebe-dev']);

  const shown = await run(['target', 'show', 'phoebe-dev', '--json'], owner);
  assert.equal(JSON.parse(shown.out[0]).address, 'lubko://phoebe-dev');
  assert.equal((await run(['target', 'show', 'nowhere'], owner)).code, 1);
});

test('the CLI relates a registered resource to the target that owns its host', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  await owner.createIssue('Work here');
  assert.equal((await run(PHOEBE, owner)).code, 0);
  assert.equal((await run(['resource', 'add', '1', 'lubko://phoebe-dev', '/workspace/project-worktree'], owner)).code, 0);

  const resources = await run(['resource', 'list', '--json'], owner);
  assert.equal(JSON.parse(resources.out[0])[0].targetId, 'phoebe-dev');

  const targets = await run(['target', 'list'], owner);
  assert.equal(targets.out[0].includes('resource /workspace/project-worktree -> #1'), true);
});

test('the CLI retires a target by status without rewriting what it can do', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  await run(PHOEBE, owner);

  const retired = await run(['target', 'set', 'phoebe-dev', '--status', 'unavailable', '--json'], owner);
  assert.equal(JSON.parse(retired.out[0]).status, 'unavailable');
  assert.deepEqual(JSON.parse(retired.out[0]).capabilities, ['network-egress', 'persistent-filesystem']);
  assert.equal(JSON.parse(retired.out[0]).description, 'persistent Lubko workstation');
  assert.equal((await run(['target', 'set', 'nowhere', '--status', 'available'], owner)).code, 1);
});

test('the CLI selects a target and reports why it chose that one', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  await run(PHOEBE, owner);
  await run(ACTIONS, owner);

  const selected = await run(['dispatch', 'select', '--capability', 'persistent-filesystem'], owner);
  assert.equal(selected.code, 0);
  assert.equal(selected.out[0].startsWith('selected phoebe-dev: '), true);
  assert.match(selected.out[0], /fewest capabilities the request did not ask for/);
  // Both candidates are named, so the choice is inspectable rather than opaque.
  assert.equal(selected.out.length, 3);
  assert.match(selected.out[1], /github-actions .*refused: capability=persistent-filesystem/);
  assert.match(selected.out[2], /phoebe-dev .*eligible/);

  const ephemeral = await run(['dispatch', 'select', '--capability', 'ephemeral-lifetime'], owner);
  assert.equal(ephemeral.out[0].startsWith('selected github-actions: '), true);

  const json = await run(['dispatch', 'select', '--target', 'phoebe-dev', '--json'], owner);
  const selection = JSON.parse(json.out[0]);
  assert.equal(selection.target.id, 'phoebe-dev');
  assert.equal(selection.rule, 'requested-target');
  assert.deepEqual(selection.considered.map((entry) => entry.targetId), ['github-actions', 'phoebe-dev']);
});

test('the CLI refuses an impossible routing request and names the candidates', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  await run(PHOEBE, owner);

  const unknown = await run(['dispatch', 'select', '--target', 'nowhere'], owner);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err[0], /requested target nowhere is not registered/);

  const impossible = await run(['dispatch', 'select', '--capability', 'accelerated-compute'], owner);
  assert.equal(impossible.code, 1);
  assert.match(impossible.err[0], /no registered available target meets the declared requirements/);
  assert.match(impossible.err[1], /phoebe-dev .*refused: capability=accelerated-compute/);
  assert.equal(impossible.out.length, 0);
});

test('the CLI records which target a job ran on', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  await owner.createIssue('Route me');
  await run(PHOEBE, owner);
  await run(ACTIONS, owner);

  const recorded = await run(['dispatch', 'record', '1', '--target', 'phoebe-dev', '--json'], owner);
  assert.equal(recorded.code, 0);
  assert.equal(JSON.parse(recorded.out[0]).targetId, 'phoebe-dev');

  const rerouted = await run(['dispatch', 'record', '1', '--backend', 'github-actions'], owner);
  assert.match(rerouted.out[0], /^Dispatched #1 to github-actions; /);

  const board = await owner.loadBoard();
  assert.equal(board.dispatches.length, 1, 'one dispatch record per job');
  assert.equal(board.dispatches[0].targetId, 'github-actions');

  const human = await run(['target', 'list'], owner);
  assert.equal(human.out[0].includes('dispatched #1'), true);

  assert.equal((await run(['dispatch', 'record', '99', '--target', 'phoebe-dev'], owner)).code, 1);
  assert.equal((await run(['dispatch', 'record'], owner)).code, 1);
});

test('the target commands parse only the typed vocabulary', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();

  for (const argv of [
    ['target', 'add', 'phoebe-dev', '--kind', 'persistent-host', '--address', 'lubko://phoebe-dev'],
    ['target', 'add', 'phoebe-dev', '--backend', 'ssh', '--kind', 'persistent-host', '--address', 'lubko://phoebe-dev'],
    ['target', 'add', 'phoebe-dev', '--backend', 'lubko', '--kind', 'vm'],
    ['target', 'add', 'phoebe-dev', '--backend', 'lubko', '--kind', 'persistent-host'],
    ['target', 'add', 'phoebe-dev', '--backend', 'lubko', '--kind', 'persistent-host', '--address', 'lubko://x', '--capability', 'teleport'],
    ['target', 'add', 'phoebe_dev', '--backend', 'lubko', '--kind', 'persistent-host', '--address', 'lubko://x'],
    ['target', 'set', 'phoebe-dev', '--status', 'sleeping'],
    ['target', 'list', '--backend', 'ssh'],
    ['dispatch', 'select', '--capability', 'teleport'],
    ['target', 'list', 'extra'],
    ['target', 'nonsense'],
    ['dispatch', 'nonsense'],
  ]) {
    const { code, err } = await run(argv, owner);
    assert.equal(code, 1, argv.join(' '));
    assert.match(err[0], /^antonina board: /, argv.join(' '));
  }
  assert.equal((await owner.loadBoard()).targets.length, 0);
});

test('the new read commands name initialization while the board is missing', async () => {
  const server = fakeSkrynia();
  const missing = 'antonina board: Antonina signed board does not exist; run: antonina board initialize to create it';
  for (const command of [['target', 'list'], ['target', 'show', 'phoebe-dev'], ['dispatch', 'select'], ['dispatch', 'record', '1']]) {
    const { code, err } = await run(command, client(server));
    assert.equal(code, 1, command.join(' '));
    assert.equal(err[0], missing, command.join(' '));
  }
  assert.equal(server.signed, null);
});

test('the CLI refuses to catalog a persistent host on the github-actions backend', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();

  // A well-formed persistent host in every other respect, so the backend/kind
  // pairing is the only reason this can be refused.
  const refused = await run([
    'target', 'add', 'actions-runner',
    '--backend', 'github-actions',
    '--kind', 'persistent-host',
    '--address', 'lubko://actions-runner',
    '--capability', 'network-egress',
    '--capability', 'persistent-filesystem',
  ], owner);
  assert.equal(refused.code, 1);
  assert.match(refused.err[0], /github-actions backend runs ephemeral environments only/);
  assert.equal((await owner.loadBoard()).targets.length, 0);
});

test('an empty catalog is reported as empty rather than as a failure', async () => {
  const server = fakeSkrynia();
  const owner = client(server);
  await owner.initialize();
  const empty = await run(['target', 'list'], owner);
  assert.equal(empty.out[0], 'No execution targets are registered.');

  const unroutable = await run(['dispatch', 'select'], owner);
  assert.equal(unroutable.code, 1);
  assert.match(unroutable.err[0], /no execution targets are registered/);
});
