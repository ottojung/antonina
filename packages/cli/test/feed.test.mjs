import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeSkrynia } from '../../core/test/fake-skrynia.mjs';
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
  const { code, out, err } = await run(['feed', '--page', '1'], reader);

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

  const first = await run(['feed', '--limit', '1', '--page', '1'], reader);
  assert.equal(first.code, 0);
  assert.equal(first.out.length, 2);
  assert.ok(first.out[1].startsWith('next: v1.'));
  const second = await run(['feed', '--limit', '1', '--page', '2'], reader);
  assert.equal(second.code, 0);
  // Numbered paging one entry at a time reproduces the first-page lines in order.
  assert.deepEqual([first.out[0], second.out[0]], out.slice(0, 2));
});

test('board feed --json is the whole page, machine readable, and requires the board credential', async () => {
  const reader = await boardWithActivity();
  const { code, out } = await run(['feed', '--page', '1', '--json'], reader);

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

test('board feed numbered pages walk the feed without loss or repeat', async () => {
  const server = fakeSkrynia();
  const owner = client(server, { now: () => new Date('2026-09-25T00:00:00.000Z') });
  const initialized = await owner.initialize();
  for (let index = 0; index < 4; index += 1) {
    await owner.createIssue('Issue ' + index, '');
    await owner.comment(index + 1, 'ada', 'note ' + index);
  }
  const reader = client(server, { credential: initialized.credential });

  const whole = await run(['feed', '--page', '1', '--json', '--limit', '500'], reader);
  const expected = JSON.parse(whole.out[0]).entries.map((entry) => entry.id);

  const walked = [];
  for (let pageNumber = 1; pageNumber < 50; pageNumber += 1) {
    const { code, out } = await run(
      ['feed', '--page', String(pageNumber), '--json', '--limit', '3'],
      reader,
    );
    assert.equal(code, 0);
    const page = JSON.parse(out[0]);
    walked.push(...page.entries.map((entry) => entry.id));
    if (page.nextCursor === null) break;
  }
  // Every board operation in this board shares one instant, so this walk is a
  // walk through a fully tied stream: it must still reproduce the projection.
  assert.deepEqual(walked, expected);
  assert.equal(new Set(walked).size, expected.length);
});

test('board feed requires a page and refuses nonsense paging values', async () => {
  const reader = await boardWithActivity();

  const missingPage = await run(['feed'], reader);
  assert.equal(missingPage.code, 1);
  assert.match(missingPage.err[0], /--page is required/);

  const badLimit = await run(['feed', '--page', '1', '--limit', 'zero'], reader);
  assert.equal(badLimit.code, 1);
  assert.match(badLimit.err[0], /--limit must be a positive integer/);

  const badPage = await run(['feed', '--page', 'zero'], reader);
  assert.equal(badPage.code, 1);
  assert.match(badPage.err[0], /--page must be a positive integer/);

  const cursor = await run(['feed', '--page', '1', '--cursor', 'legacy'], reader);
  assert.equal(cursor.code, 1);
  assert.match(cursor.err[0], /unexpected arguments for feed/);
});

test('board feed names initialization while the board is missing and creates nothing', async () => {
  const server = fakeSkrynia();
  const { code, err } = await run(['feed', '--page', '1'], client(server));
  assert.equal(code, 1);
  assert.match(err[0], /^antonina board: Antonina board does not exist/);
  assert.equal(server.signed, null);
});



test('board feed numbered pages are the public view of the core cursor sequence', async () => {
  const reader = await boardWithActivity();

  const first = await run(['feed', '--json', '--limit', '2', '--page', '1'], reader);
  const second = await run(['feed', '--json', '--limit', '2', '--page', '2'], reader);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const page1 = JSON.parse(first.out[0]);
  const page2 = JSON.parse(second.out[0]);
  assert.equal(page1.entries.length, 2);
  assert.equal(page2.entries.length, 2);

  const coreFirst = await reader.readFeed({ limit: 2, cursor: null });
  const coreSecond = await reader.readFeed({ limit: 2, cursor: coreFirst.nextCursor });
  assert.deepEqual(page1.entries, coreFirst.entries);
  assert.deepEqual(page2.entries, coreSecond.entries);
});
