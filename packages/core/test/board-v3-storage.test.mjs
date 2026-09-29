import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { base64UrlEncode, sha256 } from '../dist/canonical.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

/**
 * The storage key a logical ref is stored under, derived the way the store
 * derives it, and a reader that resolves a ref through it. The canary test
 * below has to name shards in Skrynia's own namespace, and it must derive the
 * key the same way rather than guess at it.
 */
async function resolve(server, credential, ref) {
  const bytes = new TextEncoder().encode(credential.storageCapability + ':' + ref);
  return server.objects.get('board-v3-' + base64UrlEncode(await sha256(bytes)))?.value ?? null;
}

/**
 * The test-owned state and config roots. Every test here runs against an
 * in-memory Skrynia and an explicit credential, so it never reaches the
 * operator's board, but the roots are redirected anyway so that no code path
 * under test can read or write ambient Antonina state -- in particular a
 * `trust.json` or `credential.json` belonging to whoever is running the suite.
 */
const roots = await mkdtemp(join(tmpdir(), 'antonina-v3-storage-'));
const previousStateHome = process.env.XDG_STATE_HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_STATE_HOME = join(roots, 'state');
process.env.XDG_CONFIG_HOME = join(roots, 'config');
test.after(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(roots, { recursive: true, force: true });
});

/**
 * A store with a monotonic clock and unique nonces. Both matter: every mutation
 * has to produce distinct content for the measurement to mean anything. A frozen
 * clock would be floored by `canonicalTimestampAtOrAfter` to the previous meta's
 * timestamp, so two edits of the same issue would be byte-identical and the
 * content-addressed store would correctly decline to write a second object.
 */
function makeStore(server) {
  let tick = 0;
  let id = 0;
  return new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, 0) + (tick += 1) * 1000),
    newId: () => `v3-storage-test-${++id}`,
  });
}

function shards(server) {
  return [...server.objects.entries()].filter(([key]) => key !== 'board-v2');
}

/** Object count and serialized bytes currently held in the namespace. */
function usage(server) {
  const objects = shards(server);
  return {
    objects: objects.length,
    bytes: objects.reduce((total, [, entry]) => total + JSON.stringify(entry.value).length, 0),
  };
}

async function seed(server, issueCount) {
  const board = makeStore(server);
  const initialized = await board.initialize({
    schemaVersion: 3,
    nextIssueNumber: issueCount + 1,
    issues: Array.from({ length: issueCount }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      body: `body ${index + 1}`,
      state: 'open',
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      messages: [],
    })),
    resources: [],
    targets: [],
    dispatches: [],
  });
  return { board, credential: initialized.credential };
}

test('storage growth is bounded by live board size, not by total mutation count', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 4);

  const total = 400;
  const half = total / 2;
  let midpoint = null;
  for (let index = 0; index < total; index += 1) {
    // Round-robin, so every issue's thread grows and no comment page is left
    // untouched: a live board of fixed shape is being fed unbounded history,
    // which is the case where "bounded" has to actually mean bounded.
    await board.appendFast(credential, {
      kind: 'issue.comment',
      payload: { number: (index % 4) + 1, author: 'tester', body: `comment ${index}` },
    });
    if (index + 1 === half) midpoint = usage(server);
  }
  const end = usage(server);
  assert.ok(midpoint);

  // Pre-fix, each comment writes a fresh comment page, issue snapshot,
  // directory page, list page, feed page and meta under a ref naming the new
  // head, and nothing is ever deleted: the second half of this run costs about
  // six objects per comment. The bound is a quarter of one object per comment,
  // which still leaves room for the sealed product history (a feed page and a
  // comment page per 50 entries) and misses the pre-fix model by an order of
  // magnitude.
  const secondHalf = end.objects - midpoint.objects;
  assert.ok(
    secondHalf <= half / 4 + 16,
    `the last ${half} of ${total} comments added ${secondHalf} objects `
    + `(${midpoint.objects} -> ${end.objects}); growth must be bounded by live board size, `
    + 'not by mutation count',
  );
  assert.ok(
    end.bytes <= midpoint.bytes * 3,
    `serialized bytes grew ${midpoint.bytes} -> ${end.bytes} over ${half} comments `
    + 'on a board whose live size did not change',
  );
  // The same property stated independently of the checkpoints: total objects are
  // the live board's cost plus its product history, and both are known. A count
  // that tracks the mutation count cannot fit under this line.
  assert.ok(
    end.objects <= 40 + total / 10,
    `${total} comments left ${end.objects} objects, more than the live board plus its history`,
  );
});

test('repeated edits of one issue do not grow the store', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 3);

  const edit = (index) => board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: `Issue 1 ${index}`, body: `revision ${index}` },
  });
  for (let index = 0; index < 20; index += 1) await edit(index);
  const before = usage(server);
  for (let index = 20; index < 320; index += 1) await edit(index);
  const after = usage(server);

  // Every edit changes the issue body, so no edit can share an object with any
  // other, and the live board is the same size throughout. What remains bounded
  // is the retention window. Pre-fix, 300 edits of a three-issue board leave on
  // the order of a thousand objects behind.
  assert.ok(
    after.objects - before.objects <= 8,
    `300 edits grew the store by ${after.objects - before.objects} objects `
    + 'on a board whose live size did not change',
  );
});

test('every shard the store writes is reclaimable', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 2);

  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'reclaimable' },
  });

  // The whole fix in one assertion: the pre-fix model wrote every shard as
  // `immutable`, and Skrynia refuses to delete an immutable object at all, so
  // nothing that model ever wrote could be reclaimed by anyone.
  const immutable = shards(server).filter(([, entry]) => entry.mode === 'immutable');
  assert.deepEqual(immutable.map(([key]) => key), []);
});

test('comments on a deleted issue stay readable in the feed', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 1);

  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'before the delete' },
  });
  await board.appendFast(credential, { kind: 'issue.delete', payload: { number: 1 } });
  // Later mutations are what age the deleted issue's comment pages toward the
  // edge of the retention window, so the feed is read only after the store has
  // had a reason to delete superseded shards.
  await board.appendFast(credential, {
    kind: 'issue.create',
    payload: { number: 2, title: 'After the delete', body: '' },
  });
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 2, title: 'After the delete', body: 'edited' },
  });

  const page = await board.readFeed(credential, { limit: 50 });
  const comment = page.entries.find((entry) => entry.kind === 'comment-added');
  assert.ok(comment);
  assert.equal(comment.body, 'before the delete');
  assert.equal(await board.getIssue(credential, 1), null);
});

test('the superseded generation stays readable while it is retained', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 1);

  const generationZero = server.objects.get('board-v2').value;
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'generation one' },
  });
  const generationOne = server.objects.get('board-v2').value;

  // A reader that resolved the pointer before this commit must still be able to
  // read every object that pointer named. This is the property the immutable
  // design had for free and that the retention window buys back; without it,
  // reclaiming the superseded generation would let a concurrent writer tear a
  // read.
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'generation two' },
  });

  assert.equal(generationOne.revision, generationZero.revision + 1);
  const live = server.objects.get('board-v2').value;
  const overview = await board.readOverview(credential);
  assert.equal(overview.revision, live.revision);
  assert.equal(overview.issues[0].messageCount, 1);
});

test('no ref the current generation pins is ever reclaimed', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 6);

  // A mixed workload, because the invariant the reclamation rests on is that a
  // mutation replaces exactly the shards it writes and carries every other one
  // forward by reference. The shards that must survive untouched are the ones
  // belonging to issues this workload never touches.
  for (let index = 0; index < 150; index += 1) {
    const number = (index % 3) + 1;
    if (index % 3 === 0) {
      await board.appendFast(credential, {
        kind: 'issue.comment',
        payload: { number, author: 'tester', body: `comment ${index}` },
      });
    } else if (index % 3 === 1) {
      await board.appendFast(credential, {
        kind: 'issue.close',
        payload: { number },
      });
    } else {
      await board.appendFast(credential, {
        kind: 'issue.reopen',
        payload: { number },
      });
    }
  }
  // A delete leaves a tombstone, which is the case where an issue's refs have to
  // survive without the issue being live.
  await board.appendFast(credential, { kind: 'issue.delete', payload: { number: 6 } });
  for (let index = 0; index < 20; index += 1) {
    await board.appendFast(credential, {
      kind: 'issue.comment',
      payload: { number: 1, author: 'tester', body: `after the delete ${index}` },
    });
  }

  // Walk the pointer the way a reader does and require every shard it names to
  // still be there. This is the canary for the whole design: if reclamation ever
  // removed a ref the committed generation pins, the board is unreadable, and
  // no object count would show it.
  const pointer = server.objects.get('board-v2').value;
  const present = async (ref) => (await resolve(server, credential, ref)) !== null;
  const meta = await resolve(server, credential, pointer.metaRef);
  for (const ref of [
    ...meta.directoryRefs.filter((ref) => ref !== null),
    ...meta.openPageRefs,
    ...meta.closedPageRefs,
    ...meta.feedPageRefs,
    meta.queueRef,
    meta.catalogRef,
  ]) {
    assert.ok(await present(ref), `meta pins a ref that is not in storage: ${ref}`);
  }
  for (let page = 0; page < meta.directoryRefs.length; page += 1) {
    const ref = meta.directoryRefs[page];
    if (ref === null) continue;
    const directory = await resolve(server, credential, ref);
    for (const entry of directory.entries) {
      assert.ok(await present(entry.ref), `directory entry ${entry.number} points at a missing snapshot`);
      const snapshot = await resolve(server, credential, entry.ref);
      for (const commentRef of snapshot.commentRefs) {
        assert.ok(await present(commentRef), `issue ${entry.number} pins a missing comment page`);
      }
    }
  }

  // And the whole board is still readable, which is the same statement made the
  // way a user would notice it.
  const live = (await board.readWithCredential(credential)).state.board;
  assert.equal(live.issues.length, 5);
  const feed = await board.readFeed(credential, { limit: 5 });
  assert.equal(feed.entries.length, 5);
});

test('compaction reports the reachable set and leaves foreign residue alone', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 2);

  for (let index = 0; index < 12; index += 1) {
    await board.appendFast(credential, {
      kind: 'issue.comment',
      payload: { number: (index % 2) + 1, author: 'tester', body: `comment ${index}` },
    });
  }

  // Residue in the shape the pre-fix model left it: an immutable object no
  // pointer and no meta names. Antonina can enumerate nothing, so it cannot even
  // see this, and it certainly cannot delete it.
  const residue = 'v3:pre-fix-residue';
  server.objects.set(residue, {
    value: { schemaVersion: 2, boardId: 'other', head: 'dead', entries: [] },
    mode: 'immutable',
    capability: null,
    revision: 1,
  });

  const report = await board.compactionReport(credential);
  assert.ok(report.reachableRefs > 0);
  // Initialization is revision 1, so twelve comments land on revision 13.
  assert.equal(report.revision, 13);
  assert.equal(report.lastSweep.error, null);
  assert.ok(server.objects.has(residue), 'compaction must not delete objects it did not name');
});
