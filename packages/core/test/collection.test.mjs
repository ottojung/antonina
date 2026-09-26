import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardApi,
  BoardMissingError,
  BoardTrustRequiredError,
} from '../dist/api.js';
import { OperationLogVerificationError } from '../dist/operations.js';
import {
  collectiblePaths,
  collectionSnapshot,
  commitCollectionDeletion,
  openCollectionClaim,
  protectionOf,
  readCollectionSnapshot,
  recheckCollectionClaim,
  unverifiedCollectionSnapshot,
  boardApiCollectionReader,
} from '../dist/collection.js';

const STAMP = '2026-09-25T12:00:00.000Z';
const HOST = 'lubko://server';
const OTHER_HOST = 'lubko://other';
const WORKTREE = '/workspace/project';
const BUILD = '/workspace/build';

// A minimal Skrynia stand-in: the collector's only contact with the board is
// this store, so the re-check tests exercise the real verified read path.
function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        return signed === null
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify(signed), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: etag() },
          });
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(JSON.stringify({ mode: 'capability-write', capability }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) {
          return new Response(JSON.stringify({ error: 'invalid capability' }), { status: 403 });
        }
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function api(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `collection-${++sequence}`,
    ...options,
  });
}

/**
 * A live board: issue 1 open, issue 2 open, issue 3 open, with a worktree
 * registered against 1 and 2 and a build directory against 3 alone.
 */
async function seeded() {
  const server = fakeSkrynia();
  const writer = api(server);
  const initialized = await writer.initialize();
  const open = [];
  for (let number = 1; number <= 3; number += 1) open.push(await writer.createIssue(`Issue ${number}`));
  await writer.addResourceDependency(HOST, WORKTREE, open[0].number);
  await writer.addResourceDependency(HOST, WORKTREE, open[1].number);
  await writer.addResourceDependency(HOST, BUILD, open[2].number);
  return { server, writer, open };
}

function readerFor(writer) {
  return boardApiCollectionReader(writer);
}

const failing = (error) => async () => {
  throw error;
};

test('closing the last open dependent issue makes a path collectible, reopening protects it again', async () => {
  const { writer, open } = await seeded();
  const reader = readerFor(writer);

  const before = await readCollectionSnapshot(HOST, reader);
  assert.equal(before.verified, true);
  assert.equal(before.head, writer.getRememberedHead());
  assert.deepEqual(collectiblePaths(before), []);
  assert.deepEqual(protectionOf(before, WORKTREE), {
    host: HOST,
    path: WORKTREE,
    status: 'protected',
    issues: [{ number: 1, state: 'open' }, { number: 2, state: 'open' }],
    basis: 'snapshot-verified',
  });

  await writer.close(open[1].number);
  const partly = await readCollectionSnapshot(HOST, reader);
  assert.equal(protectionOf(partly, WORKTREE).status, 'protected');
  assert.equal(protectionOf(partly, WORKTREE).issues.at(-1).state, 'closed');

  await writer.close(open[0].number);
  const collectible = await readCollectionSnapshot(HOST, reader);
  assert.equal(protectionOf(collectible, WORKTREE).status, 'collectible');
  assert.deepEqual(collectiblePaths(collectible), [WORKTREE]);
  assert.deepEqual(collectible.decisions.find((entry) => entry.path === WORKTREE).issues, [
    { number: 1, state: 'closed' },
    { number: 2, state: 'closed' },
  ]);

  await writer.reopen(open[0].number);
  const reopened = await readCollectionSnapshot(HOST, reader);
  assert.equal(protectionOf(reopened, WORKTREE).status, 'protected');
  assert.deepEqual(collectiblePaths(reopened), []);
});

test('deleting the last dependent issue unregisters the path instead of freeing it', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const beforeDelete = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.deepEqual(collectiblePaths(beforeDelete), [WORKTREE]);

  await writer.deleteIssue(open[0].number);
  await writer.deleteIssue(open[1].number);

  const after = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.equal(after.verified, true);
  assert.deepEqual(collectiblePaths(after), []);
  // The registry no longer lists the path, so it is not a path this collector
  // may delete: an undecided path is a protected path.
  assert.deepEqual(protectionOf(after, WORKTREE), {
    host: HOST,
    path: WORKTREE,
    status: 'protected',
    issues: [],
    basis: 'not-registered',
  });
});

test('a resource with no dependency, or one whose issue is gone, is never a protection decision', async () => {
  const { writer } = await seeded();
  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  const state = await writer.loadState();
  const at = (mutate) => async () => ({
    boardId: snapshot.boardId,
    state: mutate(structuredClone(state)),
  });

  // A resource registered against nothing: the canonical parser refuses it, so
  // it is unverified state rather than a vacuously collectible path.
  const dependentless = await readCollectionSnapshot(HOST, at((copy) => {
    copy.board.resources[0].issueNumbers = [];
  }));
  assert.equal(dependentless.verified, false);
  assert.equal(dependentless.failure.kind, 'board-state-rejected');
  assert.deepEqual(collectiblePaths(dependentless), []);
  assert.equal(protectionOf(dependentless, WORKTREE).status, 'protected');
  assert.equal(protectionOf(dependentless, WORKTREE).basis, 'snapshot-unverified');

  // A resource whose dependent issue no longer exists is the same case: it
  // cannot be read as collectible, so it is protected like everything else.
  const dangling = await readCollectionSnapshot(HOST, at((copy) => {
    copy.board.resources[0].issueNumbers = [99];
  }));
  assert.equal(dangling.verified, false);
  assert.deepEqual(collectiblePaths(dangling), []);
  assert.throws(() => openCollectionClaim(dangling, WORKTREE), /protected/);

  // The same board, unmodified, still decides normally: the fail-closed cases
  // above are refusals, not a permanent loss of the registry.
  assert.equal(snapshot.verified, true);
  assert.equal(protectionOf(snapshot, WORKTREE).status, 'protected');
  assert.deepEqual(collectiblePaths(snapshot), []);
});

test('every way of failing to read the board leaves every path protected', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  // The same board, and the same reader, one moment before it goes unreadable.
  assert.deepEqual(collectiblePaths(await readCollectionSnapshot(HOST, readerFor(writer))), [WORKTREE]);

  const cases = [
    [failing(new BoardMissingError()), 'board-missing'],
    [failing(new BoardTrustRequiredError('no anchor')), 'board-unverifiable'],
    [failing(new TypeError('fetch failed')), 'board-read-failed'],
    [failing(new Error('the signed log is malformed')), 'board-read-failed'],
    [async () => null, 'board-state-rejected'],
    [async () => ({ boardId: 'board', state: { head: 42 } }), 'board-state-rejected'],
    [async () => ({ boardId: '', state: {} }), 'board-state-rejected'],
    [failing(new OperationLogVerificationError('bad head')), 'board-state-rejected'],
  ];

  for (const [reader, kind] of cases) {
    const snapshot = await readCollectionSnapshot(HOST, reader);
    assert.equal(snapshot.verified, false, kind);
    assert.equal(snapshot.failure.kind, kind);
    assert.equal(snapshot.head, null);
    assert.deepEqual(snapshot.decisions, []);
    assert.deepEqual(collectiblePaths(snapshot), []);
    assert.equal(protectionOf(snapshot, WORKTREE).status, 'protected');
    assert.throws(() => openCollectionClaim(snapshot, WORKTREE), /protected/);
  }

  // An unconfigured client on a host with no board at all is fail-closed too.
  const absent = await readCollectionSnapshot(HOST, readerFor(api(fakeSkrynia())));
  assert.equal(absent.verified, false);
  assert.equal(absent.failure.kind, 'board-missing');
  assert.deepEqual(collectiblePaths(absent), []);
});

test('a deleted board is not an empty registry', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  await writer.deleteBoard();

  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.equal(snapshot.verified, false);
  assert.equal(snapshot.failure.kind, 'board-unverifiable');
  assert.deepEqual(collectiblePaths(snapshot), []);
  assert.equal(protectionOf(snapshot, WORKTREE).status, 'protected');
});

test('a host sees only its own resources, and a host absent from the registry decides nothing', async () => {
  const { writer, open } = await seeded();
  await writer.addResourceDependency(OTHER_HOST, '/srv/other', open[0].number);
  const reader = readerFor(writer);

  const mine = await readCollectionSnapshot(HOST, reader);
  assert.deepEqual(collectiblePaths(mine), []);
  assert.deepEqual(mine.decisions.map((entry) => entry.path).sort(), [BUILD, WORKTREE]);
  // Another host's registered path is not in this host's decision, so it can
  // never be claimed from a snapshot taken on this host.
  assert.equal(protectionOf(mine, '/srv/other').status, 'protected');
  assert.equal(protectionOf(mine, '/srv/other').basis, 'not-registered');
  assert.throws(() => openCollectionClaim(mine, '/srv/other'), /protected/);

  await writer.close(open[0].number);
  await writer.close(open[1].number);
  await writer.close(open[2].number);
  const theirs = await readCollectionSnapshot(OTHER_HOST, reader);
  assert.deepEqual(collectiblePaths(theirs), ['/srv/other']);
  assert.equal(protectionOf(theirs, WORKTREE).status, 'protected');

  const stranger = await readCollectionSnapshot('lubko://nobody-home', reader);
  assert.equal(stranger.verified, true);
  assert.deepEqual(stranger.decisions, []);
  assert.deepEqual(collectiblePaths(stranger), []);
  assert.equal(protectionOf(stranger, WORKTREE).status, 'protected');
  assert.equal(protectionOf(stranger, WORKTREE).basis, 'not-registered');
  assert.throws(() => openCollectionClaim(stranger, WORKTREE), /protected/);
});

test('a claim can only be opened for a collectible path on the snapshot host', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  const claim = openCollectionClaim(snapshot, WORKTREE);
  assert.deepEqual(claim, {
    state: 'claimed',
    host: HOST,
    path: WORKTREE,
    boardId: snapshot.boardId,
    snapshotHead: snapshot.head,
  });
  assert.throws(() => openCollectionClaim(snapshot, '/workspace'), /protected/);
  assert.throws(
    () => openCollectionClaim(unverifiedCollectionSnapshot(HOST, { kind: 'board-missing', message: 'gone' }), WORKTREE),
    /protected/,
  );
});

test('the re-check authorizes a path that is still collectible at a later revision', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const snapshot = await readCollectionSnapshot(HOST, reader);
  const claim = openCollectionClaim(snapshot, WORKTREE);

  await writer.comment(open[0].number, 'root', 'unrelated board traffic');
  const authorized = await recheckCollectionClaim(claim, reader);
  assert.equal(authorized.outcome, 'collect');
  assert.equal(authorized.reason, 'still-collectible');
  assert.equal(authorized.snapshotHead, snapshot.head);
  assert.notEqual(authorized.recheckHead, snapshot.head);
  assert.deepEqual(commitCollectionDeletion(authorized), {
    state: 'spent',
    outcome: 'collect',
    reason: 'still-collectible',
    host: HOST,
    path: WORKTREE,
    recheckHead: authorized.recheckHead,
  });
});

test('a path protected after the snapshot is withheld by the re-check, not deleted from it', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const snapshot = await readCollectionSnapshot(HOST, reader);
  const claim = openCollectionClaim(snapshot, WORKTREE);

  // The concurrent board change the snapshot cannot see: the issue is reopened
  // and a fresh dependency is registered against the same path.
  await writer.reopen(open[0].number);
  await writer.addResourceDependency(HOST, WORKTREE, open[2].number);

  const authorized = await recheckCollectionClaim(claim, reader);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'became-protected');
  assert.equal(authorized.status, 'protected');
  assert.equal(authorized.recheckHead, writer.getRememberedHead());
  const completed = commitCollectionDeletion(authorized);
  assert.equal(completed.outcome, 'withheld');
});

test('the re-check withholds a path that stopped being registered', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, reader), WORKTREE);

  await writer.deleteIssue(open[0].number);
  await writer.deleteIssue(open[1].number);

  const authorized = await recheckCollectionClaim(claim, reader);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'unregistered');
  assert.equal(authorized.status, 'protected');
});

test('a re-check that cannot be completed withholds instead of falling back on the snapshot', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, reader), WORKTREE);

  const broken = failing(new TypeError('fetch failed'));
  const authorized = await recheckCollectionClaim(claim, broken);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'board-unverifiable');
  assert.equal(authorized.recheckHead, null);

  await writer.deleteBoard();
  const afterDelete = await recheckCollectionClaim(claim, reader);
  assert.equal(afterDelete.outcome, 'withheld');
  assert.equal(afterDelete.reason, 'board-unverifiable');
});

test('a re-check against a different board withholds', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, readerFor(writer)), WORKTREE);

  const elsewhere = api(fakeSkrynia());
  const initialized = await elsewhere.initialize();
  const foreign = async () => ({
    boardId: initialized.trustAnchor.boardId === 'board' ? 'another-board' : 'board',
    state: await elsewhere.loadState(),
  });

  const authorized = await recheckCollectionClaim(claim, foreign);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'wrong-board');
  assert.equal(authorized.status, 'protected');
});

test('one re-check cannot be spent into two deletions', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, reader), WORKTREE);
  const authorized = await recheckCollectionClaim(claim, reader);

  assert.equal(commitCollectionDeletion(authorized).outcome, 'collect');
  assert.throws(() => commitCollectionDeletion(authorized), /already spent/);
});

test('a snapshot names the board and revision it decided from', async () => {
  const { writer, open } = await seeded();
  const reader = readerFor(writer);
  const first = await readCollectionSnapshot(HOST, reader);
  await writer.comment(open[0].number, 'root', 'traffic');
  const second = await readCollectionSnapshot(HOST, reader);

  assert.equal(first.boardId, writer.accessState().boardId);
  assert.notEqual(first.head, second.head);
  assert.equal(second.head, writer.getRememberedHead());

  const forged = { boardId: 'anything', state: await writer.loadState() };
  const direct = collectionSnapshot(forged, HOST);
  assert.equal(direct.boardId, 'anything');
  assert.equal(direct.head, writer.getRememberedHead());
  assert.equal(direct.failure, null);
});
