import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { base64UrlEncode, canonicalBytes, sha256 } from '../dist/canonical.js';
import { fakeSkrynia } from './fake-skrynia.mjs';
import { contractSkrynia } from './skrynia-contract.mjs';

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
 * Every shard one generation's meta pins, walked the way a reader walks it.
 *
 * This is the closure a reader that resolved a given pointer depends on, and it
 * is what the retention-window tests assert over. Deriving it here rather than
 * calling the store is deliberate: a helper built on the store's own read path
 * would re-resolve the *live* pointer and pass with the retained generation
 * deleted.
 */
async function closureOf(server, credential, meta) {
  const refs = new Set([
    ...meta.openPageRefs,
    ...meta.closedPageRefs,
    ...meta.feedPageRefs,
    meta.queueRef,
    meta.catalogRef,
  ]);
  for (const ref of meta.directoryRefs) {
    if (ref === null) continue;
    refs.add(ref);
    const directory = await resolve(server, credential, ref);
    for (const entry of directory?.entries ?? []) {
      refs.add(entry.ref);
      const snapshot = await resolve(server, credential, entry.ref);
      for (const commentRef of snapshot?.commentRefs ?? []) refs.add(commentRef);
    }
  }
  return [...refs];
}

/** One issue, hydrated, through a *given* meta rather than the live pointer. */
async function readIssueAt(server, credential, meta, number) {
  for (const ref of meta.directoryRefs) {
    if (ref === null) continue;
    const directory = await resolve(server, credential, ref);
    const entry = directory?.entries.find((candidate) => candidate.number === number);
    if (entry === undefined) continue;
    const snapshot = await resolve(server, credential, entry.ref);
    const messages = [];
    for (const commentRef of snapshot.commentRefs) {
      const page = await resolve(server, credential, commentRef);
      messages.push(...(page?.messages ?? []));
    }
    return { ...snapshot.issue, messages };
  }
  throw new Error(`issue ${number} is not in this generation`);
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
 *
 * The step is one simulated MINUTE per timestamp the store takes, and that is
 * load-bearing rather than cosmetic. The retention window is
 * `RETENTION_MIN_AGE_MS = 300_000` -- five minutes, sized against a full board
 * hydration -- and a store ticking one second at a time would never leave the
 * window, so nothing would ever be reclaimed and every count in this file would
 * be measuring an un-reclaimed store. At a minute a tick the window holds the
 * handful of generations it is supposed to hold, which is what a real board
 * looks like, and the retention tests below drive the window explicitly through
 * `clock.advance` rather than by counting commits.
 */
const MINUTE_MS = 60_000;

/**
 * The store's `RETENTION_MIN_AGE_MS`, restated here so the tests below drive the
 * window deliberately rather than by counting commits. It is duplicated on
 * purpose: a test that reads the constant out of the module under test cannot
 * fail when the constant is wrong, and "five minutes" is the property these tests
 * are pinning.
 */
const RETENTION_WINDOW_MS = 5 * MINUTE_MS;

function makeClock(startMs, stepMs = MINUTE_MS) {
  let ms = startMs;
  return {
    now: () => {
      ms += stepMs;
      return new Date(ms);
    },
    /** Jump the wall clock, which is how a test crosses the retention window. */
    advance: (byMs) => {
      ms += byMs;
    },
  };
}

/**
 * A second store over the same server. It shares the clock by default, and it
 * has to: the retention window is decided by comparing a meta's `updatedAt`
 * against the writer's own clock, so a second store on a fresh clock would be
 * reading a board whose metas are from the future and would reclaim nothing.
 */
function makeStore(server, clock = makeClock(Date.UTC(2026, 8, 29, 12, 0, 0))) {
  let id = 0;
  const board = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: clock.now,
    newId: () => `v3-storage-test-${++id}`,
  });
  return { board, clock };
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
    /**
     * Objects that are not feed pages.
     *
     * Feed pages are product history and are meant to grow with the number of
     * comments. Everything else is materialization: directory pages, issue
     * snapshots, tombstones, comment pages, list pages, the queue, the catalog
     * and the metas. Counting them apart is what lets a test assert bounded
     * materialization without also asserting that the product stops growing.
     */
    nonFeed: objects.filter(([, entry]) => !isFeedPage(entry.value)).length,
  };
}

/** A materialized feed page: paged entries, and the only shard kind that is history. */
function isFeedPage(value) {
  return Array.isArray(value?.entries) && value.page !== undefined && value.state === undefined;
}

async function seed(server, issueCount, stepMs) {
  const { board, clock } = makeStore(server, makeClock(Date.UTC(2026, 8, 29, 12, 0, 0), stepMs));
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
  return { board, credential: initialized.credential, clock };
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

test('every shard is reclaimable by any client holding only the board key', async () => {
  const server = fakeSkrynia();
  const { board, credential, clock } = await seed(server, 2);

  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'reclaimable' },
  });

  // The whole fix in one assertion, and the specific thing that went wrong
  // before: the pre-fix model wrote every shard as `immutable`, which Skrynia
  // will not delete at all, and a first attempt at the fix wrote them as
  // `capability-write`, whose per-object capability no later client can present.
  const modes = new Set(shards(server).map(([, entry]) => entry.mode));
  assert.deepEqual([...modes], ['public-write']);

  // A `capability-write` shard would be un-deletable in practice: Skrynia mints
  // a fresh capability for that object and keeps only its hash, so the only
  // value that authorizes the DELETE is the one the creating response returned,
  // to a process that no longer exists. This asserts the property reclamation
  // actually depends on -- a second store instance, holding nothing but the
  // board credential, can delete a shard written by the first.
  const stale = shards(server).map(([key]) => key);
  assert.ok(stale.length > 0);
  const second = makeStore(server, clock).board;
  const cutover = await second.cutoverState(credential);
  assert.equal(cutover.state, 'cutover-complete');
  for (let index = 0; index < 4; index += 1) {
    await second.appendFast(credential, {
      kind: 'issue.edit',
      payload: { number: 2, title: 'Issue 2', body: `revision ${index}` },
    });
  }
  const after = new Set(shards(server).map(([key]) => key));
  const reclaimed = stale.filter((key) => !after.has(key));
  assert.ok(reclaimed.length > 0, 'a later client must be able to reclaim earlier shards');
});

test('the fake models Skrynia minting a fresh capability per capability-write object', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 1);

  // Guard on the double itself. If this ever stops holding, the growth numbers
  // above are being produced by a server more permissive than the real one and
  // the suite would be green for the wrong reason -- which is exactly the defect
  // the real per-object capability semantics exposed.
  const pointerCapability = server.capabilityOf('board-v2');
  assert.ok(pointerCapability);
  assert.notEqual(pointerCapability, server.capability);

  const url = (key) => `${'https://example.invalid/_skrynia'}/store/antonina/${key}`;
  // The minted capability authorizes its own object...
  const ok = await server.fetch(url('board-v2'), {
    method: 'PUT',
    headers: { 'X-Skrynia-Capability': pointerCapability, 'If-Match': `"v${server.revision}"` },
    body: JSON.stringify(server.signed),
  });
  assert.equal(ok.status, 200);
  // ...and the board credential, which is that same value, is a different thing
  // from the ambient capability the double also exposes.
  const wrong = await server.fetch(url('board-v2'), {
    method: 'DELETE',
    headers: { 'X-Skrynia-Capability': server.capability },
  });
  assert.equal(wrong.status, 403);
  // A capability-write object a client cannot name a capability for is left
  // alone, so a wrong capability is a refusal and never a silent no-op.
  assert.equal(server.objects.has('board-v2'), true);

  // The board still works afterwards, which is the property that matters: the
  // refusal above was the fake being right, not the store being broken.
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'after the refusal' },
  });
  const overview = await board.readOverview(credential);
  assert.equal(overview.issues[0].messageCount, 1);
});

test('a shard re-established by content addressing is not reclaimed', async () => {
  const server = fakeSkrynia();
  const { board, credential, clock } = await seed(server, 3, 1000);
  const meta = () => resolve(server, credential, server.objects.get('board-v2').value.metaRef);

  // Reorder the queue A -> B -> A. A queue snapshot is just its numbers, so
  // putting the order back writes the *same* content-addressed ref again, and
  // that ref is in the first reorder's superseded list. Reclaiming purely on the
  // recorded list would then delete a shard the live generation pins, and the
  // next read of the board would fail to open.
  const before = (await meta()).queueRef;
  await board.appendFast(credential, { kind: 'queue.reorder', payload: { numbers: [2, 1, 3] } });
  const reordered = (await meta()).queueRef;
  await board.appendFast(credential, { kind: 'queue.reorder', payload: { numbers: [1, 2, 3] } });
  const restored = (await meta()).queueRef;

  assert.notEqual(reordered, before, 'a reorder must change the queue ref');
  assert.equal(restored, before, 'restoring the order must restore the same content-addressed ref');

  // Commit past the retention window, so the recorded list really is walked and
  // the reclaim that would collect that ref actually runs. The clock jump is
  // what crosses the window: without it the sweep correctly declines, and this
  // test would pass for the wrong reason.
  clock.advance(RETENTION_WINDOW_MS + MINUTE_MS);
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'after the revert' },
  });
  const sweep = board.sweepReport();
  assert.equal(sweep.skipped, false, 'the sweep must run once the window has passed');
  assert.ok(
    sweep.reclaimed > 0,
    'the sweep outside the retention window must actually reclaim something, '
    + 'or this test is asserting nothing',
  );
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 2, author: 'tester', body: 'and another' },
  });

  // The ref the live generation pins is still there, and the board reads.
  assert.equal((await meta()).queueRef, before);
  assert.notEqual(
    await resolve(server, credential, before),
    null,
    'a re-established shard was reclaimed out from under the live generation',
  );
  assert.deepEqual(await board.getQueue(credential), [1, 2, 3]);
  const issue = await board.getIssue(credential, 1);
  assert.ok(issue, 'the board must still open after a reverted reorder');
  assert.equal(issue.messages[0].body, 'after the revert');
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

test('a resolved generation stays fully readable for the whole retention window', async () => {
  const server = fakeSkrynia();
  // A SECOND-resolution clock here, deliberately: the property under test is that
  // the window is measured in time, so the commits have to be close together in
  // time and be many of them. The growth tests above use the minute-resolution
  // default, which is the opposite situation -- a long quiet board -- and both are
  // real.
  const { board, credential, clock } = await seed(server, 2, 1000);

  // Build a generation worth reading: an issue with a comment, so the closure
  // spans a comment page, an issue snapshot, a directory page, list pages, a feed
  // page, the queue and the catalog. Then edit it, so the commits below replace
  // several of those shards at once.
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'generation two' },
  });
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'generation three' },
  });
  const capturedPointer = server.objects.get('board-v2').value;
  const capturedMeta = await resolve(server, credential, capturedPointer.metaRef);
  const capturedClosure = await closureOf(server, credential, capturedMeta);
  const capturedMetaKey = await keyForRef(credential, capturedPointer.metaRef);
  assert.ok(capturedClosure.length >= 6, 'the captured generation must be worth reading');

  // Commit repeatedly, and keep committing until the clock has moved past the
  // whole window. This is the property the store claims and the one the review
  // measured it did not have: the previous version of this test committed ONCE
  // and asserted the window was one commit wide, which is a commit count wearing
  // a window's name. Here the number of commits is irrelevant and only the
  // elapsed time matters -- these four commits land inside a minute of simulated
  // time and the window is five.
  const editsInsideWindow = 4;
  for (let index = 0; index < editsInsideWindow; index += 1) {
    await board.appendFast(credential, {
      kind: 'issue.edit',
      payload: { number: 1, title: 'Issue 1', body: `generation ${index + 4}` },
    });
    // The property, read the way a reader holding the older pointer would read
    // it: through the captured pointer, to the captured meta, to every shard that
    // meta pins. Not through readOverview, which re-resolves the LIVE pointer and
    // would pass with the whole captured generation deleted underneath it.
    for (const ref of capturedClosure) {
      assert.notEqual(
        await resolve(server, credential, ref),
        null,
        `a shard the captured generation pins was reclaimed ${index + 1} commit(s) in, `
        + `still inside the window: ${ref}`,
      );
    }
    assert.equal(
      server.objects.get('board-v2').value.revision,
      capturedPointer.revision + index + 1,
      'the commits under test must have landed',
    );
    assert.ok(
      board.sweepReport().skipped,
      `the sweep must decline while the captured generation is inside the window `
      + `(commit ${index + 1})`,
    );
  }
  assert.ok(
    (server.objects.get('board-v2').value.revision - capturedPointer.revision) > 1,
    'more than one commit must have landed, or this test is the old one-commit test',
  );
  // And the captured generation's own comment body is still readable, which is
  // the user-visible form of the same property.
  const retainedIssue = await readIssueAt(server, credential, capturedMeta, 1);
  assert.equal(retainedIssue.messages.length, 1);
  assert.equal(retainedIssue.messages[0].body, 'generation two');

  // Now the window closes. One commit after the clock has moved past it, the
  // captured generation's shards -- and the meta that named them -- are gone, and
  // the board is still readable. This is the other half: a window that never
  // closes is not a window, it is a leak.
  clock.advance(RETENTION_WINDOW_MS + MINUTE_MS);
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'after the window' },
  });
  assert.equal(board.sweepReport().skipped, false, 'the sweep must run once the window has passed');
  assert.ok(board.sweepReport().reclaimed > 0, 'a sweep outside the window must reclaim something');
  // The live generation's closure is exactly the set of captured refs that are
  // still pinned -- shards whose content did not change are shared with the live
  // generation and must NOT be reclaimed -- so the two assertions are the same
  // assertion stated from both sides, and between them they are exact: nothing
  // the live generation pins went, and nothing else survived.
  const liveMeta = await resolve(server, credential, server.objects.get('board-v2').value.metaRef);
  const live = await closureOf(server, credential, liveMeta);
  for (const ref of live) {
    assert.notEqual(
      await resolve(server, credential, ref),
      null,
      `the sweep reclaimed a ref the live generation pins: ${ref}`,
    );
  }
  for (const ref of capturedClosure) {
    if (live.includes(ref)) continue;
    assert.equal(
      await resolve(server, credential, ref),
      null,
      `a shard outside the retention window is still present: ${ref}`,
    );
  }
  assert.ok(
    capturedClosure.some((ref) => !live.includes(ref)),
    'the commits must have replaced at least one shard, or this test proves nothing',
  );
  assert.equal(
    server.objects.has(capturedMetaKey),
    false,
    'the meta outside the retention window is still present',
  );
  const liveIssue = await readIssueAt(server, credential, liveMeta, 1);
  assert.equal(liveIssue.body, 'after the window', 'the live board must survive its own reclamation');
});

test('a superseded shard survives the window and then goes, and the window is time', async () => {
  const server = fakeSkrynia();
  const { board, credential, clock } = await seed(server, 1, 1000);

  // The ref of the issue-1 snapshot at each generation, so the test can watch a
  // specific ref through the window instead of inferring the window from totals.
  const snapshotRefAt = async () => {
    const pointer = server.objects.get('board-v2').value;
    const meta = await resolve(server, credential, pointer.metaRef);
    for (const page of meta.directoryRefs) {
      if (page === null) continue;
      const directory = await resolve(server, credential, page);
      const entry = directory?.entries.find((candidate) => candidate.number === 1);
      if (entry !== undefined) return entry.ref;
    }
    return null;
  };
  const exists = async (ref) => ref !== null && await resolve(server, credential, ref) !== null;

  // Four edits, each replacing the issue snapshot. Every one of the superseded
  // refs is more than one generation old by the end, so a commit-count rule would
  // have deleted all of them. A time rule deletes none of them yet, because the
  // whole run is four simulated minutes and the window is five.
  const history = [await snapshotRefAt()];
  for (let index = 0; index < 4; index += 1) {
    await board.appendFast(credential, {
      kind: 'issue.edit',
      payload: { number: 1, title: 'Issue 1', body: `revision ${index}` },
    });
    history.push(await snapshotRefAt());
  }
  assert.notEqual(history[0], history[1], 'each edit must produce a distinct snapshot ref');
  for (let generation = 0; generation < history.length - 1; generation += 1) {
    assert.ok(
      await exists(history[generation]),
      `a snapshot ref superseded ${history.length - 1 - generation} generation(s) ago must `
      + 'survive while it is still inside the retention window',
    );
  }

  // Past the window. The oldest recorded set is eligible; the generations newer
  // than the window are not, and the live one never is.
  clock.advance(RETENTION_WINDOW_MS + MINUTE_MS);
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'past the window' },
  });
  assert.equal(await exists(history[0]), false, 'the oldest superseded ref must be reclaimed');
  assert.equal(
    await exists(history[history.length - 1]),
    true,
    'the ref the live generation pins must never be reclaimed',
  );

  // The live generation pins a shard that exists, and the ref the live
  // generation pins is the newest one, not any of the superseded ones.
  const liveMeta = await resolve(server, credential, server.objects.get('board-v2').value.metaRef);
  const live = await closureOf(server, credential, liveMeta);
  for (const ref of live) {
    assert.notEqual(await resolve(server, credential, ref), null, `live ref reclaimed: ${ref}`);
  }
  const newest = await snapshotRefAt();
  assert.ok(live.includes(newest), 'the live closure must pin the live snapshot ref');
  assert.equal(
    history.filter((ref) => live.includes(ref)).length,
    0,
    'a superseded snapshot ref must not still be pinned by the live generation',
  );
  assert.ok(
    shards(server).length <= 40,
    `five edits left ${shards(server).length} objects; the window is not closing`,
  );
});



test('repeated create/comment/delete cycles do not grow the store', async () => {
  const server = fakeSkrynia();
  const { board, credential } = await seed(server, 3);

  // The board's live size never changes: three issues, throughout, with the
  // churn all on a fourth that is created, commented on and deleted every round.
  // A tombstone per deletion is materialization, not product history, so this is
  // the loop that separates the two.
  const rounds = 200;
  const marks = [];
  for (let round = 0; round < rounds; round += 1) {
    const number = 4 + round;
    await board.appendFast(credential, {
      kind: 'issue.create',
      payload: { number, title: `Churn ${round}`, body: '' },
    });
    await board.appendFast(credential, {
      kind: 'issue.comment',
      payload: { number, author: 'tester', body: `comment ${round}` },
    });
    await board.appendFast(credential, { kind: 'issue.delete', payload: { number } });
    if ((round + 1) % 50 === 0) marks.push({ rounds: round + 1, ...usage(server) });
  }

  // The live board is what the user sees, and it never moved.
  const overview = await board.readOverview(credential);
  assert.equal(overview.issues.length, 3, 'the live board must be back to its three issues');

  // The store, however, must not have grown by two objects per round forever.
  // The test separates the two kinds of growth rather than setting one total
  // bound, because only one of them is a defect.
  //
  //   * feed pages are product history. One comment per round means the feed
  //     genuinely grows, and requirement 4 says that history is retained. A
  //     bound that forbade it would be forbidding the product.
  //   * everything else is materialization, and requirement 1 says it must track
  //     live board size. Tombstones and the comment pages they pin are the two per
  //     round that the pre-fix design leaked; both are inside a fixed window now.
  const first = marks[0];
  const last = marks[marks.length - 1];
  const roundsApart = last.rounds - first.rounds;
  // The ceiling is the retention window, not the round count. A pre-fix store
  // grows by 2 objects per round and is at 400 by round 200; this one plateaus at
  // the window whatever the round count becomes. The bound is stated in objects so
  // the test fails on a count rather than on a rate it has to derive.
  assert.ok(
    last.nonFeed <= 220,
    `${roundsApart} create/comment/delete rounds left ${last.nonFeed} non-feed objects `
    + `(${first.nonFeed} -> ${last.nonFeed}) on a board of constant live size`,
  );
  // And the marginal cost is far below the 2-per-round leak: over the last three
  // quarters of the run the store must be adding well under one object per round.
  assert.ok(
    (last.nonFeed - first.nonFeed) / roundsApart < 0.5,
    `non-feed objects grew at ${((last.nonFeed - first.nonFeed) / roundsApart).toFixed(2)} `
    + `per round over ${roundsApart} rounds; pre-fix this is 2.00 per delete`,
  );
  // A deleted issue leaves nothing behind: no tombstone, no comment page, no
  // directory entry. The directory is the issue's live set and nothing else.
  const meta = await resolve(server, credential, server.objects.get('board-v2').value.metaRef);
  const liveNumbers = [];
  for (const ref of meta.directoryRefs) {
    if (ref === null) continue;
    const directory = await resolve(server, credential, ref);
    for (const entry of directory.entries) liveNumbers.push(entry.number);
  }
  assert.deepEqual(liveNumbers, [1, 2, 3], 'only the live issues may be in the directory');
  // The format carries no tombstone bookkeeping: the meta names no such field,
  // which is asserted on the raw object so a reintroduction is caught even if a
  // parser starts tolerating it again.
  assert.equal(
    Object.hasOwn(meta, 'retiringTombstones'),
    false,
    'the format must not carry tombstone bookkeeping at all',
  );
  // The last deleted issue's comment is still readable, because the feed entry
  // carries its own text: deleting an issue costs nothing and loses nothing.
  const feed = await board.readFeed(credential, { limit: 5 });
  const latest = feed.entries.find((entry) => entry.kind === 'comment-added');
  assert.equal(latest.body, `comment ${rounds - 1}`);
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

/**
 * A Skrynia that answers a shard DELETE with a chosen status.
 *
 * This is how the reclaim premise is falsified on demand. The premise -- that
 * `public-write` is reclaimable, so a client holding only the board key can
 * delete a shard it did not create -- is a dated observation of one deployment
 * (probed 2026-09-29), not a specification. If a future deployment stops
 * accepting unauthenticated DELETE, every sweep becomes a no-op, the namespace
 * regrows exactly as it did before this format existed, and the board hits its
 * quota again. Nothing about the code can prevent that; what the code can do is
 * make it visible, and that is what these tests pin.
 */
function refusingDeletes(server, status) {
  const attempts = { count: 0, keys: new Set() };
  const keyOf = (url) => decodeURIComponent(String(url).split('/').at(-1));
  const fetchWithPolicy = async (url, init) => {
    if (init?.method === 'DELETE' && String(url).includes('/board-v3-')) {
      attempts.count += 1;
      attempts.keys.add(keyOf(url));
      return new Response(JSON.stringify({ error: 'refused' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return server.fetch(url, init);
  };
  return { server, fetchWithPolicy, attempts };
}

test('a server that refuses DELETE is counted, reported, and never silent', async () => {
  // 403 is the status with no benign cause on this path: nothing in the delete set
  // was ever written `immutable`, so a refusal means the policy changed.
  const { server, fetchWithPolicy, attempts } = refusingDeletes(fakeSkrynia(), 403);
  let tick = 0;
  let id = 0;
  const clock = { ms: Date.UTC(2026, 8, 29, 12, 0, 0) };
  const board = new SignedBoardStore({
    fetch: fetchWithPolicy,
    now: () => new Date((clock.ms += 1000) + (tick += 0)),
    newId: () => `refused-${++id}`,
  });
  const initialized = await board.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Issue 1',
      body: 'body',
      state: 'open',
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      messages: [],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  const credential = initialized.credential;

  // Inside the window: the sweep must not even try, so a refusal costs nothing.
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision one' },
  });
  assert.equal(attempts.count, 0, 'a sweep inside the window must not issue a DELETE at all');
  assert.equal(board.sweepReport().skipped, true);

  // Past the window: every DELETE is refused, and each one is counted as a
  // refusal -- separately from a failure, and never silently.
  clock.ms += RETENTION_WINDOW_MS + MINUTE_MS;
  const before = shards(server).length;
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision two' },
  });
  const sweep = board.sweepReport();
  assert.ok(attempts.count > 0, 'the sweep outside the window must have tried to reclaim');
  assert.equal(sweep.reclaimed, 0, 'a refused delete is not a reclaim');
  assert.ok(sweep.refused > 0, 'a 403 must be counted as a refusal');
  assert.equal(sweep.failed, 0, 'a 403 is a policy answer, not a transport failure to retry');
  assert.equal(sweep.error, null);
  assert.ok(
    shards(server).length > before,
    'nothing may be reclaimed when every delete is refused',
  );

  // The count is durable, not per-process: the next generation carries it, and
  // the report an operator reads carries it. This is the whole of the fix for a
  // silent failure -- the previous design counted it in a method with no callers.
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision three' },
  });
  const report = await board.importBoard(credential);
  assert.equal(report.state, 'cutover-complete');
  assert.ok(
    report.storage.unreclaimableShards > 0,
    'the operator report must show that objects are not being reclaimed',
  );
  assert.match(report.storage.note, /growing faster than it is reclaimed/);
  // And the number only ever goes up: it is a count of identifications, and a
  // later healthy sweep must not erase the history of the refusals.
  const carried = report.storage.unreclaimableShards;
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision four' },
  });
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision five' },
  });
  const later = await board.importBoard(credential);
  assert.ok(
    later.storage.unreclaimableShards >= carried,
    `the durable leak total went backwards: ${carried} -> ${later.storage.unreclaimableShards}`,
  );
  // The board still works. A reclamation that cannot delete anything is a storage
  // problem, and must not become a correctness one.
  const live = await board.getIssue(credential, 1);
  assert.equal(live?.body, 'revision five');
});

test('a delete that finds the object already gone is a goal state, not a refusal', async () => {
  // The 404/403 conflation the review named: a lost race between two reclaimers,
  // or a second pass over an already-swept set, produces 404 and is completely
  // benign. It is counted in the running total (the object may have been in the
  // namespace) but it is never a refusal, because a refusal is the signal that
  // the reclaim premise has stopped holding.
  const { server, fetchWithPolicy, attempts } = refusingDeletes(fakeSkrynia(), 404);
  let id = 0;
  const clock = { ms: Date.UTC(2026, 8, 29, 12, 0, 0) };
  const board = new SignedBoardStore({
    fetch: fetchWithPolicy,
    now: () => new Date((clock.ms += 1000)),
    newId: () => `absent-${++id}`,
  });
  const initialized = await board.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Issue 1',
      body: 'body',
      state: 'open',
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      messages: [],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  const credential = initialized.credential;
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision one' },
  });
  clock.ms += RETENTION_WINDOW_MS + MINUTE_MS;
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision two' },
  });
  const sweep = board.sweepReport();
  assert.ok(attempts.count > 0);
  assert.equal(sweep.refused, 0, 'a 404 is not a refusal');
  assert.equal(sweep.failed, 0, 'a 404 is not a failure');
  assert.equal(sweep.reclaimed, 0, 'a 404 is not a reclaim either');
  assert.ok(sweep.retained > 0, 'a 404 is still counted in the running leak total');
  // One more commit, because the durable total is written by the generation AFTER
  // the sweep that measured it -- the sweep runs after its own meta is committed,
  // so the count always lags by exactly one generation.
  await board.appendFast(credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: 'Issue 1', body: 'revision three' },
  });
  const report = await board.importBoard(credential);
  assert.ok(report.storage.unreclaimableShards > 0, 'the running total must reach the report');
  assert.match(report.storage.note, /keeping up|may no longer hold/);
});

test('the store holds the live generation, the ones inside the window, and nothing else', async () => {
  // A correctness test, not an upper-bound test.
  //
  // Every count in this file is monotone in deletion: deleting sooner only makes
  // a count smaller, so a count cannot tell "reclaimed exactly the superseded
  // set" from "reclaimed everything, including shards a reader inside the
  // window is still reading". This one can. It reconstructs the exact set of
  // objects the store is entitled to hold -- the live generation's closure, plus
  // the closure of every generation still inside the window, plus their metas --
  // and requires the namespace to equal it. An over-deleting sweep leaves
  // something missing and fails; an under-deleting one leaves something extra and
  // fails too. The two failure directions a count cannot see.
  const server = fakeSkrynia();
  const { board, credential, clock } = await seed(server, 3, 1000);

  // A mixed workload, tracked so it stays legal: a closed issue cannot be edited
  // or commented on, and a workload that trips over that would be testing the
  // wrong thing. Each kind replaces a different set of shards, which is what
  // makes the eligible set differ from generation to generation.
  const state = new Map([[1, 'open'], [2, 'open'], [3, 'open']]);
  const mixed = async (index) => {
    const number = (index % 3) + 1;
    const open = state.get(number) === 'open';
    if (index % 4 === 0) {
      await board.appendFast(credential, {
        kind: 'issue.comment',
        payload: { number, author: 'tester', body: `comment ${index}` },
      });
    } else if (index % 4 === 1 && open) {
      await board.appendFast(credential, {
        kind: 'issue.edit',
        payload: { number, title: `Issue ${number} ${index}`, body: `body ${index}` },
      });
    } else if (open) {
      await board.appendFast(credential, { kind: 'issue.close', payload: { number } });
      state.set(number, 'closed');
    } else {
      await board.appendFast(credential, { kind: 'issue.reopen', payload: { number } });
      state.set(number, 'open');
    }
  };
  // A queue reorder A -> B -> A in the middle, so the store also exercises a ref
  // that is recorded as superseded and then written again: an over-deleting sweep
  // takes that one first.
  for (let index = 0; index < 12; index += 1) await mixed(index);
  // Read the queue the board actually holds rather than deriving it: the runtime
  // owns which issues are queued, and a workload that guesses is testing the
  // guess.
  const queueNow = async () => [...await board.getQueue(credential)].sort((a, b) => a - b);
  const first = await queueNow();
  if (first.length > 1) {
    await board.appendFast(credential, { kind: 'queue.reorder', payload: { numbers: [...first].reverse() } });
  }
  for (let index = 12; index < 24; index += 1) await mixed(index);
  const second = await queueNow();
  if (second.length > 1) {
    await board.appendFast(credential, { kind: 'queue.reorder', payload: { numbers: second } });
  }
  for (let index = 24; index < 36; index += 1) await mixed(index);

  /** Every generation still reachable through the meta chain, newest first. */
  const chainOf = async () => {
    const chain = [];
    let metaRef = server.objects.get('board-v2').value.metaRef;
    for (let depth = 0; depth < 200; depth += 1) {
      const meta = await resolve(server, credential, metaRef);
      if (meta === null) break;
      chain.push({ metaRef, meta });
      if (meta.retainsMetaRef === null) break;
      metaRef = meta.retainsMetaRef;
    }
    return chain;
  };

  /**
   * Every object the store is entitled to hold right now, computed from the data
   * and never from the store's own opinion of what it did.
   *
   * Three disjoint parts, and all three are derived from the meta chain:
   *
   *   1. each generation still inside the window, its whole read closure and its
   *      own meta -- what a reader holding that pointer needs;
   *   2. each generation still inside the window's `supersededRefs` -- objects it
   *      has already stopped pinning but may not yet delete, because the
   *      generation that recorded them is itself inside the window;
   *   3. a ref an OLDER generation recorded as superseded that a NEWER generation
   *      has since written again -- the A->B->A edit. Those are past due and are
   *      deliberately not deleted, because the newer generation pins them.
   *
   * Nothing else may be there. An object outside this set is garbage no reader
   * can reach; an object missing from it is a board that does not open. Both
   * directions are asserted below, which is what a count cannot do.
   */
  const entitledObjects = async () => {
    const chain = await chainOf();
    const inside = [];
    for (const generation of chain) {
      if (clock.ms - Date.parse(generation.meta.updatedAt) >= RETENTION_WINDOW_MS) break;
      inside.push(generation);
    }
    const entitled = new Set();
    for (const { metaRef, meta } of inside) {
      entitled.add(await keyForRef(credential, metaRef));
      for (const ref of await closureOf(server, credential, meta)) {
        entitled.add(await keyForRef(credential, ref));
      }
      for (const ref of meta.supersededRefs) entitled.add(await keyForRef(credential, ref));
    }
    // "Newer" is the store's own order, so it is the chain index.
    const introducedAt = new Map();
    chain.forEach(({ meta }, index) => {
      for (const ref of meta.introducedRefs) {
        if (!introducedAt.has(ref)) introducedAt.set(ref, index);
      }
    });
    for (let index = inside.length; index < chain.length; index += 1) {
      for (const ref of chain[index].meta.supersededRefs) {
        const back = introducedAt.get(ref);
        if (back !== undefined && back < index) entitled.add(await keyForRef(credential, ref));
      }
    }
    return { entitled, chain, inside };
  };

  const { entitled, chain, inside } = await entitledObjects();
  assert.ok(chain.length >= 2, 'the chain must hold more than the live generation');
  assert.ok(inside.length >= 2, 'the window must hold more than one generation here');
  assert.ok(
    entitled.size > 20,
    `the entitled set is implausibly small (${entitled.size}); the test is not measuring a board`,
  );

  // The exact set, both ways. `shards` is everything except the pointer.
  const present = new Set(shards(server).map(([key]) => key));
  assert.deepEqual(
    [...entitled].filter((key) => !present.has(key)),
    [],
    'the store reclaimed an object a generation inside the window pins, or one '
    + 'that is still pending reclamation',
  );
  assert.deepEqual(
    [...present].filter((key) => !entitled.has(key)),
    [],
    'the store holds an object no generation inside the window pins and no '
    + 'generation has recorded: it is garbage no reader can reach',
  );

  // And the same statement again after the window has closed on everything but
  // the live generation, which is the state the store is in most of the time.
  clock.advance(RETENTION_WINDOW_MS + MINUTE_MS);
  await board.appendFast(credential, {
    kind: 'issue.comment',
    payload: { number: 1, author: 'tester', body: 'after the window' },
  });
  const later = await entitledObjects();
  assert.equal(
    later.inside.length,
    1,
    'one commit after the jump, only the live generation is inside the window',
  );
  const presentAfter = new Set(shards(server).map(([key]) => key));
  assert.deepEqual(
    [...later.entitled].filter((key) => !presentAfter.has(key)),
    [],
    'a sweep outside the window reclaimed something a retained generation pins',
  );
  assert.deepEqual(
    [...presentAfter].filter((key) => !later.entitled.has(key)),
    [],
    'a sweep outside the window left something behind that nothing pins',
  );
  assert.ok(
    later.entitled.size < entitled.size,
    'the window must actually have closed on something, or nothing was reclaimed',
  );
});



test('an externally overwritten shard is detected when it is next rewritten', async () => {
  // public-write objects are anonymously overwritable on the real server, so
  // "no reader can observe a shard change" is a statement about Antonina's write
  // discipline, not about Skrynia. This pins exactly what content addressing buys
  // against that, and it is narrower than "detected":
  //
  //   * a shard's ref is the digest of its intended content, so the next write of
  //     that content gets a 409 whose stored body no longer hashes to the ref, and
  //     writeShard fails loudly rather than accepting the object as its own;
  //   * a *read* of an overwritten shard is NOT detected. This design makes no
  //     claim about that, and the test does not pretend otherwise.
  const server = contractSkrynia();
  let tick = 0;
  let id = 0;
  const board = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, (tick += 1))),
    newId: () => `overwrite-${++id}`,
  });
  const initialized = await board.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Issue 1',
      body: 'original body',
      state: 'open',
      createdAt: '2026-09-29T12:00:00.000Z',
      updatedAt: '2026-09-29T12:00:00.000Z',
      messages: [],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  // A fixed timestamp on every edit, so "second body" at this instant is
  // byte-identical each time. That is what makes the rewrite below re-post the
  // *same* ref rather than a new one, which is the only way to reach the 409.
  const at = '2026-09-29T12:05:00.000Z';
  const first = await board.appendFast(initialized.credential, {
    kind: 'issue.edit',
    timestamp: at,
    payload: { number: 1, title: 'Issue 1', body: 'second body' },
  });
  assert.equal(first.state.board.issues[0].body, 'second body');

  // The snapshot shard for "second body", located the way a locator holder would:
  // it is reachable from the pointer, and addressing it needs no credential.
  const pointer = server.objects.get('board-v2').value;
  const meta = await resolveStored(server, initialized.credential, pointer.metaRef);
  const directory = await resolveStored(server, initialized.credential, meta.directoryRefs[0]);
  const snapshotKey = await keyForRef(initialized.credential, directory.entries[0].ref);
  const original = server.objects.get(snapshotKey).value;

  // Tamper: replace the body of an object that is still named by a live meta.
  const response = await server.fetch(`https://example.invalid/_skrynia/store/antonina/${snapshotKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...original, issue: { ...original.issue, body: 'tampered body' } }),
  });
  // The real server accepts this. If the double ever refuses it, it has drifted
  // from the deployment and this whole file is measuring a fiction.
  assert.equal(response.status, 200, 'the contract double must model anonymous overwrite');
  assert.equal(
    server.objects.get(snapshotKey).value.issue.body,
    'tampered body',
    'the overwrite must have replaced the body for the rest of this test to mean anything',
  );

  // Writing the same content again is the detection point: the ref is the digest
  // of "second body", the object now holds "tampered body", and re-deriving the
  // stored object does not reproduce the ref.
  await assert.rejects(
    () => board.appendFast(initialized.credential, {
      kind: 'issue.edit',
      timestamp: at,
      payload: { number: 1, title: 'Issue 1', body: 'second body' },
    }),
    /shard collision/,
    'rewriting a shard whose stored body no longer matches its ref must fail loudly',
  );
  // And the board is left serving the generation it was serving, not a shard
  // someone else wrote.
  const after = await board.readOverview(initialized.credential);
  assert.equal(after.revision, pointer.revision);
});

/** The Skrynia key a logical ref resolves to, the way the store derives it. */
async function keyForRef(credential, ref) {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256')
    .update(credential.storageCapability + ':' + ref)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'board-v3-' + digest;
}

/** The object stored under a ref, the way the store reads it. */
async function resolveStored(server, credential, ref) {
  return server.objects.get(await keyForRef(credential, ref))?.value ?? null;
}

