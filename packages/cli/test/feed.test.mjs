import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardApi } from '../dist/packages/core/src/api.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

// Test safety: no command in this file may read or mutate the operator's Antonina
// state, so `XDG_STATE_HOME` and `XDG_CONFIG_HOME` are pointed at unreachable
// test-owned paths. `home` is unreachable too and the client is injected, so
// nothing here can resolve to the operator's configuration.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-feed-test-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-feed-test-config';

const TEST_HOME = '/nonexistent-antonina-feed-test-home';

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
        if (headers.get('If-Match') !== etag()) return jsonResponse({ error: 'stale' }, 412);
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
    now: () => new Date('2026-09-25T00:00:00.000Z'),
    newId: () => `feed-${++sequence}`,
    ...options,
  });
}

function memoryIo() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

function run(argv, reader) {
  const capture = memoryIo();
  // `home` is unreachable, so no command in this file can fall through to the
  // operator's ambient configuration; the client is injected, so nothing is read
  // from `$XDG_CONFIG_HOME` or `$XDG_STATE_HOME` at all.
  return runBoardCommand(argv, {
    env: {},
    home: TEST_HOME,
    io: capture.io,
    createClient: () => reader,
  }).then((code) => ({ code, ...capture }));
}

async function boardWithActivity() {
  const server = fakeSkrynia();
  const owner = client(server);
  const initialized = await owner.initialize();
  await owner.createIssue('Feed me', 'the body');
  await owner.comment(1, 'ada', 'first');
  await owner.editIssueBody(1, 'the body, edited');
  await owner.close(1);
  await owner.reopen(1);
  return client(server, { credential: initialized.credential });
}

test('board feed prints every recorded operation, newest first, and names the continuation', async () => {
  const reader = await boardWithActivity();
  const { code, out, err } = await run(['feed'], reader);

  assert.equal(code, 0);
  assert.deepEqual(err, []);
  // Every operation in this fixture shares one instant, so the only order that
  // can separate these lines is the order the log committed them, read newest
  // first. Creation, comment, edit, closure and reopen are five events, not one.
  assert.equal(out.length, 5);
  assert.match(out[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z {2}#1 \[open\] reopened {2}Feed me$/);
  assert.match(out[1], /\[closed\] closed {2}Feed me$/);
  assert.match(out[2], /\[open\] edited {2}Feed me$/);
  assert.match(out[3], /\[open\] commented by ada: first$/);
  assert.match(out[4], /\[open\] created {2}Feed me$/);
  // The whole feed fits the default page, so there is nothing to continue to.
  assert.equal(out.filter((line) => line.startsWith('next: ')).length, 0);

  const first = await run(['feed', '--limit', '1'], reader);
  assert.equal(first.code, 0);
  assert.equal(first.out.length, 2);
  assert.ok(first.out[1].startsWith('next: v1.'));
  // A token taken from the printed output is the token the next page takes.
  const second = await run(['feed', '--limit', '1', '--cursor', first.out[1].slice('next: '.length)], reader);
  assert.equal(second.code, 0);
  // Paging one entry at a time reproduces the single-page lines in order.
  assert.deepEqual([first.out[0], second.out[0]], out.slice(0, 2));
});

test('board feed --json is the whole page, machine readable, and requires the board credential', async () => {
  const reader = await boardWithActivity();
  const { code, out } = await run(['feed', '--json'], reader);

  assert.equal(code, 0);
  const page = JSON.parse(out[0]);
  assert.equal(page.total, 5);
  assert.equal(page.limit, 50);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.entries.map((entry) => entry.kind), [
    'issue-reopened', 'issue-closed', 'issue-edited', 'comment-added', 'issue-created',
  ]);
  const comment = page.entries[3];
  // Entry identity is the identity of the operation that produced it.
  assert.match(comment.id, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(comment.messageId, comment.id);
  assert.equal(comment.author, 'ada');
  assert.equal(comment.body, 'first');
  assert.equal(comment.issueNumber, 1);
  // The state each entry reports is the state its own operation left, not the
  // board's final state: the comment was written while the issue was open.
  assert.equal(comment.state, 'open');
  assert.equal(page.entries[1].state, 'closed');
  // The closure and the reopen are two entries, not one "updated" line.
  assert.equal(page.entries.filter((entry) => entry.at === comment.at).length, 5);
});

test('board feed pages with --cursor and --limit without loss or repeat', async () => {
  const server = fakeSkrynia();
  const owner = client(server, { now: () => new Date('2026-09-25T00:00:00.000Z') });
  const initialized = await owner.initialize();
  for (let index = 0; index < 4; index += 1) {
    await owner.createIssue('Issue ' + index, '');
    await owner.comment(index + 1, 'ada', 'note ' + index);
  }
  const reader = client(server, { credential: initialized.credential });

  const whole = await run(['feed', '--json', '--limit', '500'], reader);
  const expected = JSON.parse(whole.out[0]).entries.map((entry) => entry.id);

  const walked = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const argv = ['feed', '--json', '--limit', '3'];
    if (cursor !== null) argv.push('--cursor', cursor);
    const { code, out } = await run(argv, reader);
    assert.equal(code, 0);
    const page = JSON.parse(out[0]);
    walked.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  assert.equal(cursor, null);
  // Every board operation in this board shares one instant, so this walk is a
  // walk through a fully tied stream: it must still reproduce the projection.
  assert.deepEqual(walked, expected);
  assert.equal(new Set(walked).size, expected.length);
});

test('board feed refuses a nonsense limit or cursor rather than guessing', async () => {
  const reader = await boardWithActivity();
  const badLimit = await run(['feed', '--limit', 'zero'], reader);
  assert.equal(badLimit.code, 1);
  assert.match(badLimit.err[0], /--limit must be a positive integer/);

  const badCursor = await run(['feed', '--cursor', 'not-a-cursor'], reader);
  assert.equal(badCursor.code, 1);
  assert.match(badCursor.err[0], /feed cursor is malformed/);
});

test('board feed names initialization while the board is missing and creates nothing', async () => {
  const server = fakeSkrynia();
  const { code, err } = await run(['feed'], client(server));
  assert.equal(code, 1);
  assert.match(err[0], /^antonina board: Antonina signed board does not exist/);
  assert.equal(server.signed, null);
});

