import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BoardApi,
  BoardMissingError,
  BoardTrustRequiredError,
} from '../dist/api.js';
import { OperationLogVerificationError } from '../dist/operations.js';
import { validateManagedRoots } from '../dist/managed-roots.js';
import {
  collectiblePaths,
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

// The re-check gathers the candidate's filesystem facts itself, so the
// registered paths have to be real ones. A temporary root stands in for the
// configured managed root, resolved so that it is the same directory in both
// coordinate systems even where the temporary directory sits behind a symlink.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'antonina-collection-')));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));
const WORKTREE = `${ROOT}/project`;
const BUILD = `${ROOT}/build`;

// The configured managed collection root every destructive re-check is judged
// against. The root contains both registered paths above; nothing else in these
// tests is collectible, because nothing else is inside a managed root.
const rootsOf = (spelled) => {
  const result = validateManagedRoots(spelled.map((path) => ({ spelled: path, resolved: path })));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.roots;
};

const MANAGED = rootsOf([ROOT]);

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

  const live = await writer.loadState();
  const liveBoardId = writer.accessState().boardId;
  const cases = [
    [failing(new BoardMissingError()), 'board-missing'],
    [failing(new BoardTrustRequiredError('no anchor')), 'board-unverifiable'],
    [failing(new TypeError('fetch failed')), 'board-read-failed'],
    [failing(new Error('the signed log is malformed')), 'board-read-failed'],
    [async () => null, 'board-state-rejected'],
    [async () => ({ boardId: 'board', state: { head: 42 } }), 'board-state-rejected'],
    [async () => ({ boardId: '', state: { head: 'head' } }), 'board-state-rejected'],
    [failing(new OperationLogVerificationError('bad head')), 'board-state-rejected'],
    // A well-formed board and a real head that says the board was deleted. The
    // registry half of collection establishes for itself that a deleted board is
    // unverified state, rather than relying on `BoardApi` to refuse to serve one.
    [async () => ({ boardId: liveBoardId, state: { ...live, deleted: true } }), 'board-unverifiable'],
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

  // The deleted-state case spelled out, because it is the one that could
  // otherwise be satisfied by the right answer for the wrong reason: this board
  // really is well formed, really does register the path, and really has the
  // head that called it collectible a moment ago. A deleted board still decides
  // nothing, and the only thing that stops it is this module's own rule.
  const deleted = await readCollectionSnapshot(HOST, async () => ({
    boardId: liveBoardId,
    state: { ...live, deleted: true },
  }));
  assert.equal(deleted.verified, false);
  assert.equal(deleted.failure.kind, 'board-unverifiable');
  assert.match(deleted.failure.message, /deleted/);
  assert.deepEqual(collectiblePaths(deleted), []);
  assert.throws(() => openCollectionClaim(deleted, WORKTREE), /protected/);
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
  assert.deepEqual(mine.decisions.map((entry) => entry.path).sort(), ['/srv/other', BUILD, WORKTREE]);
  // Another host's registered path is a decision this host does not own, so it
  // can never be claimed from a snapshot taken on this host, and it is reported
  // as another host's path rather than as an unregistered one.
  assert.deepEqual(protectionOf(mine, '/srv/other'), {
    host: OTHER_HOST,
    path: '/srv/other',
    status: 'protected',
    issues: [{ number: open[0].number, state: 'open' }],
    basis: 'other-host',
  });
  assert.throws(() => openCollectionClaim(mine, '/srv/other'), /protected/);

  await writer.close(open[0].number);
  await writer.close(open[1].number);
  await writer.close(open[2].number);
  const theirs = await readCollectionSnapshot(OTHER_HOST, reader);
  assert.deepEqual(collectiblePaths(theirs), ['/srv/other']);
  assert.equal(protectionOf(theirs, '/srv/other').status, 'collectible');
  // The same path read from the other host's snapshot is this host's
  // neighbour's, and still not this host's to delete.
  assert.deepEqual(protectionOf(theirs, WORKTREE), {
    host: HOST,
    path: WORKTREE,
    status: 'protected',
    issues: [{ number: open[0].number, state: 'closed' }, { number: open[1].number, state: 'closed' }],
    basis: 'other-host',
  });
  assert.throws(() => openCollectionClaim(theirs, WORKTREE), /protected/);

  // A host with nothing of its own still reads the whole board, so it can name
  // what every other host's paths are, and collects none of them.
  const stranger = await readCollectionSnapshot('lubko://nobody-home', reader);
  assert.equal(stranger.verified, true);
  assert.deepEqual(
    stranger.decisions.map((entry) => entry.path).sort(),
    ['/srv/other', BUILD, WORKTREE],
  );
  assert.deepEqual(collectiblePaths(stranger), []);
  assert.equal(protectionOf(stranger, WORKTREE).status, 'protected');
  assert.equal(protectionOf(stranger, WORKTREE).basis, 'other-host');
  assert.throws(() => openCollectionClaim(stranger, WORKTREE), /protected/);
});

test('a path registered on two hosts is decided by this host, not by the neighbour that sorts first', async () => {
  const { writer, open } = await seeded();
  // The same absolute path registered on both hosts: a resource is identified
  // by the (host, path) pair, so both registrations are legitimate. The foreign
  // host sorts before HOST, so a lookup that ignores the host finds the other
  // host's decision first.
  await writer.addResourceDependency('lubko://aaa-neighbour', WORKTREE, open[0].number);
  const reader = readerFor(writer);
  assert.equal('lubko://aaa-neighbour' < HOST, true);

  await writer.close(open[0].number);
  await writer.close(open[1].number);
  await writer.close(open[2].number);

  const mine = await readCollectionSnapshot(HOST, reader);
  assert.deepEqual(collectiblePaths(mine), [WORKTREE, BUILD].sort());
  // The other host's copy of the path is still protected, but this host owns the
  // path, so the answer is this host's verified one and the two agree.
  assert.deepEqual(protectionOf(mine, WORKTREE), {
    host: HOST,
    path: WORKTREE,
    status: 'collectible',
    issues: [{ number: open[0].number, state: 'closed' }, { number: open[1].number, state: 'closed' }],
    basis: 'snapshot-verified',
  });
  assert.equal(collectiblePaths(mine).includes(WORKTREE), true);
  assert.equal(openCollectionClaim(mine, WORKTREE).path, WORKTREE);

  // A path only this host registered is the neighbour's `other-host`, and the
  // neighbour decides its own copy of the shared path for itself.
  const theirs = await readCollectionSnapshot('lubko://aaa-neighbour', reader);
  assert.deepEqual(protectionOf(theirs, WORKTREE).basis, 'snapshot-verified');
  assert.deepEqual(protectionOf(theirs, BUILD), {
    host: HOST,
    path: BUILD,
    status: 'protected',
    issues: [{ number: open[2].number, state: 'closed' }],
    basis: 'other-host',
  });
});

test('an unverified snapshot is empty of decisions however it was built', () => {
  // The type of the unverified branch leaves no room for a decision, so this
  // record is only reachable by ignoring the type or by hand-building one. It
  // must still decide nothing: no consumer may read a collectible path out of
  // a snapshot that never verified a board.
  const smuggled = {
    verified: false,
    host: HOST,
    boardId: null,
    head: null,
    decisions: [{ host: HOST, path: WORKTREE, status: 'collectible', issues: [] }],
    failure: { kind: 'board-read-failed', message: 'gone' },
  };
  assert.deepEqual(collectiblePaths(smuggled), []);
  assert.deepEqual(protectionOf(smuggled, WORKTREE), {
    host: HOST,
    path: WORKTREE,
    status: 'protected',
    issues: [],
    basis: 'snapshot-unverified',
  });
  assert.throws(() => openCollectionClaim(smuggled, WORKTREE), /protected/);
});

/**
 * The re-check builds its own verifying read from a `BoardApi` and gathers the
 * candidate's filesystem facts itself, so a test cannot hand it a reader of its
 * own or facts of its own; the only things a test chooses are the client and
 * the managed-root judgment.
 */
const recheck = (claim, writer, options = {}) => recheckCollectionClaim(
  claim,
  writer,
  options.roots ?? MANAGED,
);

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
  assert.throws(() => openCollectionClaim(snapshot, ROOT), /protected/);
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
  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'collect');
  assert.equal(authorized.reason, 'still-collectible');
  // The board moved on between the snapshot and the re-check, so the claim's
  // revision is not one the re-check read: it reports the revision it verified
  // and declines to vouch for the one the claim named.
  assert.equal(authorized.snapshotHead, null);
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

  const authorized = await recheck(claim, writer);
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

  const authorized = await recheck(claim, writer);
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

  // A client that cannot reach the board at all. The re-check is given the
  // client, not a reader, so the failure has to be the client's own.
  const broken = api(fakeSkrynia(), {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const authorized = await recheck(claim, broken);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'board-unverifiable');
  assert.equal(authorized.recheckHead, null);

  await writer.deleteBoard();
  const afterDelete = await recheck(claim, writer);
  assert.equal(afterDelete.outcome, 'withheld');
  assert.equal(afterDelete.reason, 'board-unverifiable');
});

test('a re-check against a different board withholds', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, readerFor(writer)), WORKTREE);

  // A second, real board: an honest client that simply is not talking to the
  // board the claim came from. The re-check builds its own read, so this is
  // reached by handing it the wrong client rather than a wrong reader.
  const elsewhere = api(fakeSkrynia(), { newId: () => 'another-board' });
  await elsewhere.initialize();

  const authorized = await recheck(claim, elsewhere);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'wrong-board');
  assert.equal(authorized.status, 'protected');
});

test('one re-check authorizes one deletion, and a copy of it is not that authorization', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);
  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, reader), WORKTREE);
  const authorized = await recheck(claim, writer);

  // A shallow copy is a different record, and only the record the re-check
  // issued is a live authorization, so a copy cannot be committed either.
  assert.throws(() => commitCollectionDeletion({ ...authorized }), /not a live authorization/);
  assert.throws(
    () => commitCollectionDeletion({
      state: 'authorized',
      outcome: 'collect',
      reason: 'still-collectible',
      host: HOST,
      path: WORKTREE,
      boardId: authorized.boardId,
      snapshotHead: authorized.snapshotHead,
      recheckHead: authorized.recheckHead,
      status: 'collectible',
    }),
    /not a live authorization/,
  );

  assert.equal(commitCollectionDeletion(authorized).outcome, 'collect');
  assert.throws(() => commitCollectionDeletion(authorized), /not a live authorization/);
});

test('a board cannot authorise collecting a configured managed root', async () => {
  const { writer, open } = await seeded();
  // The board registers the configured managed root itself. Protection and
  // registry say it owes nothing to any open issue, which is exactly the case
  // where a board acting on its own authority would authorise removing the root
  // that defines every other collection permission.
  await writer.addResourceDependency(HOST, ROOT, open[0].number);
  await writer.close(open[0].number);

  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.deepEqual(collectiblePaths(snapshot), [ROOT]);
  const claim = openCollectionClaim(snapshot, ROOT);

  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'candidate-is-managed-root');
  assert.equal(authorized.status, 'protected');
  assert.equal(commitCollectionDeletion(authorized).outcome, 'withheld');
});

test('a board cannot authorise collecting a path no managed root contains', async () => {
  const { writer, open } = await seeded();
  // A perfectly well-formed absolute path the registry is happy to call
  // collectible, and that lives in no configured managed root at all.
  const unmanaged = '/etc/antonina';
  await writer.addResourceDependency(HOST, unmanaged, open[0].number);
  await writer.close(open[0].number);

  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.deepEqual(collectiblePaths(snapshot), [unmanaged]);
  const claim = openCollectionClaim(snapshot, unmanaged);

  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'outside-managed-roots');
  assert.equal(authorized.status, 'protected');
  assert.equal(commitCollectionDeletion(authorized).outcome, 'withheld');
});

test('a collect authorization is impossible for a candidate whose own facts resolve elsewhere', async () => {
  const { writer, open } = await seeded();
  // The registry calls this path collectible and it is spelled inside the managed
  // root, so nothing but the filesystem can refuse it. But a component of the
  // path is a symlink out of the root: the directory that holds the candidate is
  // really /etc. A caller that guessed the facts -- resolved path equal to the
  // spelled path, parent equal to the root -- would have collected /etc, and the
  // re-check gathers the facts itself, so it cannot.
  symlinkSync('/etc', join(ROOT, 'link'));
  const escaping = `${ROOT}/link/antonina`;
  await writer.addResourceDependency(HOST, escaping, open[0].number);
  await writer.close(open[0].number);

  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, readerFor(writer)), escaping);
  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'not-managed-collectible');
  assert.equal(authorized.status, 'protected');
  assert.equal(authorized.path, escaping);
  assert.equal(commitCollectionDeletion(authorized).outcome, 'withheld');
});

test('a candidate whose filesystem facts cannot be gathered is withheld, not collected', async () => {
  const { writer, open } = await seeded();
  // Registered and collectible, spelled inside the managed root, but the
  // directory that would contain it is not there, so there is no fact about
  // where the candidate really is. There is no eligible answer without them.
  const absent = `${ROOT}/never-created/candidate`;
  await writer.addResourceDependency(HOST, absent, open[0].number);
  await writer.close(open[0].number);

  const claim = openCollectionClaim(await readCollectionSnapshot(HOST, readerFor(writer)), absent);
  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'candidate-facts-unavailable');
  assert.equal(authorized.status, 'protected');
});

test('a hand-built state cannot mint a collect authorization', async () => {
  const { writer, open } = await seeded();
  // A reader that lies: it reports the live board with every issue closed, so
  // the snapshot is verified and calls the path collectible. Nothing here is a
  // real board revision.
  const liar = async () => {
    const state = await writer.loadState();
    return {
      boardId: writer.accessState().boardId,
      state: {
        ...state,
        board: {
          ...state.board,
          issues: state.board.issues.map((issue) => ({ ...issue, state: 'closed' })),
        },
      },
    };
  };

  const forged = await readCollectionSnapshot(HOST, liar);
  assert.equal(forged.verified, true);
  assert.deepEqual(collectiblePaths(forged), [WORKTREE, BUILD].sort());
  const claim = openCollectionClaim(forged, WORKTREE);

  // The snapshot is a real object and the claim is a real claim, but the
  // re-check reads the board itself: the same client, one moment later, still
  // has open issues, so there is nothing to collect.
  const authorized = await recheck(claim, writer);
  assert.equal(authorized.outcome, 'withheld');
  assert.equal(authorized.reason, 'became-protected');
  assert.equal(authorized.recheckHead, writer.getRememberedHead());

  // The reader is gone from the destructive path altogether: it is not a
  // parameter a caller can pass, and neither are the candidate's filesystem
  // facts.
  assert.equal(recheckCollectionClaim.length, 3);
});

test('a path this module cannot canonicalise is protected, and a sweep survives it', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const snapshot = await readCollectionSnapshot(HOST, readerFor(writer));
  assert.deepEqual(collectiblePaths(snapshot), [WORKTREE]);

  // A malformed candidate in a sweep must not take the sweep with it, and must
  // not be decided by whatever it resembles.
  for (const malformed of ['workspace/project', '/workspace/project/', '/workspace/../etc']) {
    assert.deepEqual(protectionOf(snapshot, malformed), {
      host: HOST,
      path: malformed,
      status: 'protected',
      issues: [],
      basis: 'path-not-canonical',
    }, malformed);
  }
  assert.throws(() => openCollectionClaim(snapshot, '/workspace/project/'), /path-not-canonical/);

  // The well-formed candidates in the same sweep are still decided normally.
  assert.equal(protectionOf(snapshot, WORKTREE).status, 'collectible');
  assert.equal(protectionOf(snapshot, '  ' + WORKTREE + '  ').status, 'collectible');
});

test('a host that is not already canonical yields an unverified snapshot', async () => {
  const { writer, open } = await seeded();
  await writer.close(open[0].number);
  await writer.close(open[1].number);
  const reader = readerFor(writer);

  for (const malformed of ['server', 'https://server', 'lubko://', 'lubko://a/b']) {
    const snapshot = await readCollectionSnapshot(malformed, reader);
    assert.equal(snapshot.verified, false, malformed);
    assert.equal(snapshot.failure.kind, 'host-not-canonical', malformed);
    assert.equal(snapshot.head, null);
    assert.deepEqual(snapshot.decisions, []);
    assert.deepEqual(collectiblePaths(snapshot), []);
    assert.throws(() => openCollectionClaim(snapshot, WORKTREE), /protected/);
  }

  // The unverified shape itself never throws on the way out, so an operator
  // reading a failure for a malformed host gets one.
  assert.equal(
    unverifiedCollectionSnapshot('not-a-host', { kind: 'host-not-canonical', message: 'x' }).host,
    'not-a-host',
  );
  assert.equal((await readCollectionSnapshot(HOST, reader)).verified, true);
});

test('a snapshot names the board and revision it decided from, and cannot be minted by a caller', async () => {
  const { writer, open } = await seeded();
  const reader = readerFor(writer);
  const first = await readCollectionSnapshot(HOST, reader);
  await writer.comment(open[0].number, 'root', 'traffic');
  const second = await readCollectionSnapshot(HOST, reader);

  assert.equal(first.boardId, writer.accessState().boardId);
  assert.notEqual(first.head, second.head);
  assert.equal(second.head, writer.getRememberedHead());

  // The board identity and the revision come from the read itself, so a
  // verified snapshot is only ever one of the board the client is actually
  // talking about: there is no exported constructor that takes a board id.
  const exported = await import('../dist/collection.js');
  assert.equal(exported.collectionSnapshot, undefined);
  const api = await import('../dist/api.js');
  assert.equal(api.collectionSnapshot, undefined);
});
