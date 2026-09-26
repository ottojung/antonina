import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardApi } from '../../core/dist/api.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

const CAPABILITY = 'a'.repeat(64);
const stamp = '2026-09-24T10:00:00.000Z';

function issue(number = 1, state = 'open') {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: stamp, updatedAt: stamp, messages: [] };
}
function board(issues = [issue()], nextIssueNumber = 2, resources = []) {
  return { schemaVersion: 2, nextIssueNumber, issues, resources };
}
function response(value, status = 200, etag) {
  return new Response(JSON.stringify(value), { status, headers: etag === undefined ? {} : { ETag: etag } });
}
function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

test('board CLI emits deterministic JSON list output', async () => {
  const client = new BoardApi({
    fetch: async () => response(board(), 200, '"v1"'),
  });
  const capture = memoryIo();
  const code = await runBoardCommand(['list', '--json'], { env: {}, io: capture.io, createClient: () => client });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(capture.out[0]), [issue()]);
  assert.deepEqual(capture.err, []);
});

test('board CLI requires author from flag or environment', async () => {
  const capture = memoryIo();
  const code = await runBoardCommand(['comment', '1', 'hello'], {
    env: {},
    io: capture.io,
    createClient: () => new BoardApi({ capability: CAPABILITY }),
  });
  assert.equal(code, 1);
  assert.match(capture.err[0], /ANTONINA_BOARD_AUTHOR/);
});

test('core retries create against the latest ETag and counter', async () => {
  const initial = board();
  const winner = board([issue(), { ...issue(2), title: 'Winner' }], 3);
  const final = board([...winner.issues, { ...issue(3), title: 'Mine' }], 4);
  const responses = [
    response(initial, 200, '"v1"'),
    response({}, 412),
    response(winner, 200, '"v2"'),
    response({}, 200),
    response(final, 200, '"v3"'),
  ];
  const requests = [];
  const client = new BoardApi({
    capability: CAPABILITY,
    now: () => new Date(stamp),
    fetch: async (_url, init) => {
      requests.push(init);
      const next = responses.shift();
      if (!next) throw new Error('response queue exhausted');
      return next;
    },
  });
  const created = await client.createIssue('Mine');
  assert.equal(created.number, 3);
  assert.match(String(requests[1].body), /"number":2/);
  assert.match(String(requests[3].body), /"number":3/);
});

test('no board CLI command creates a missing board', async () => {
  const requests = [];
  const client = new BoardApi({
    capability: CAPABILITY,
    fetch: async (_url, init) => {
      requests.push(init);
      return response({ error: 'not_found' }, 404);
    },
  });

  for (const command of [['list'], ['create', 'Mine'], ['resource', 'add', '1', 'lubko://server', '/path']]) {
    const capture = memoryIo();
    const code = await runBoardCommand(command, { env: {}, io: capture.io, createClient: () => client });
    assert.equal(code, 1, command.join(' '));
    assert.match(capture.err[0], /Antonina board does not exist/);
  }

  assert.equal(requests.length, 3);
  assert.equal(requests.every((init) => init?.method === undefined), true);
});

test('core fails capability validation before network', async () => {
  let calls = 0;
  const client = new BoardApi({
    capability: 'bad',
    fetch: async () => { calls += 1; return response(board(), 200, '"v1"'); },
  });
  await assert.rejects(() => client.close(1), /64 hexadecimal/);
  assert.equal(calls, 0);
});
