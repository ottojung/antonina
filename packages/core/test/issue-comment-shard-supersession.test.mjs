import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

/**
 * Board issue 174, the residual the 0322Z verification front named and declined
 * to clear: `writeShard` reclamation of superseded comment shards.
 *
 * The front's words were that it is "NOT verified that the new paged read cannot
 * be handed a snapshot whose `commentRefs` still names a reclaimed shard", and it
 * named the event that would settle it: supersede a comment shard via
 * `writeShard`, then assert `readIssueCommentPage` against the resulting
 * snapshot. These tests do that against the real store and the real
 * fake-Skrynia double -- no mocks of the store itself.
 *
 * What the mechanism is, as read in the source and then MEASURED below rather
 * than inferred:
 *
 *   * `writeShard` (board-v3-store.ts:1234) never overwrites. It derives a
 *     content-addressed ref from the value and POSTs to it, so superseding a
 *     comment page writes a NEW object and leaves the old one in place.
 *   * The rewrite of `commentRefs` is not a separate step. `materializeIssue`
 *     (1690) substitutes the new ref into a copy of the previous map, and the
 *     whole map travels inside the issue snapshot that `writeShard` writes and
 *     that the new meta names. The superseded ref is recorded in the same
 *     generation's `supersededRefs`.
 *   * Reclamation is strictly AFTER the pointer CAS (`sweepAfterCommit`, 3212)
 *     and is gated on `RETENTION_MIN_AGE_MS` (300 s) and `RETAINED_GENERATIONS`
 *     (1). So the generation that recorded a superseded ref has to be a full
 *     generation old AND past the window before the delete happens.
 *   * Therefore the atomicity is the pointer CAS, and the question "can
 *     `commentRefs` name a shard that does not exist" becomes "can the sweep
 *     delete a ref the CURRENT generation pins", which `writtenRefs` and
 *     `introducedRefs` exist to answer.
 *
 * Retention arithmetic in these tests: the clock is moved a full hour forward
 * (3600 s, twelve retention windows) wherever reclamation is meant to run, and
 * NOT moved wherever the window is meant to hold. One further commit is needed
 * after a window passes, because the window is measured against the meta that
 * RECORDED the ref, not the one that superseded it -- which is precisely why a
 * superseded comment shard is still readable one generation later.
 */

const STAMP = '2026-09-28T17:00:00.000Z';
const BASE_MS = Date.UTC(2026, 9, 28, 18, 0, 0);
const ONE_WINDOW_MS = 3_600_000;

/** Mutable clock, and a fetch hook, so a test can intercept the pointer CAS. */
function harness(server, { startMs = 0, maxAttempts = 1 } = {}) {
  let clock = startMs;
  let id = 0;
  let onPutPointer = null;
  const base = server.fetch.bind(server);
  const store = new SignedBoardStore({
    fetch: (url, init = {}) => {
      if ((init.method ?? 'GET') === 'PUT' && String(url).endsWith('board-v2') && onPutPointer !== null) {
        return onPutPointer();
      }
      return base(url, init);
    },
    newId: () => `supersession-${++id}`,
    now: () => new Date(BASE_MS + clock),
    maxAttempts,
  });
  return {
    store,
    advance: (ms) => { clock += ms; },
    refusePointerCas: () => {
      onPutPointer = () => new Response(null, { status: 412 });
    },
    allowPointerCas: () => { onPutPointer = null; },
  };
}

function message(index, body = `message ${index + 1}`) {
  return {
    id: 'sha256:' + (index + 1).toString(16).padStart(43, '0'),
    author: 'tester',
    body,
    createdAt: STAMP,
  };
}

/** One open issue carrying `count` comments, i.e. `ceil(count / 50)` shards. */
async function boardWithComments(count) {
  const server = fakeSkrynia();
  const h = harness(server);
  const initialized = await h.store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Supersession',
      body: 'the description',
      state: 'open',
      createdAt: STAMP,
      updatedAt: STAMP,
      messages: Array.from({ length: count }, (_, index) => message(index)),
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  return { server, ...h, initialized };
}

/** Comment shards for issue 1 as `[storageKey, value]`, ordered by page. */
function commentShards(server) {
  return [...server.objects.entries()]
    .filter(([, entry]) => entry.value?.number === 1 && Array.isArray(entry.value?.messages))
    .sort((left, right) => left[1].value.page - right[1].value.page);
}

/**
 * The storage key a logical ref resolves to, recomputed the way the store does
 * it: `board-v3-` plus base64url(sha256(storageCapability + ':' + ref)).
 *
 * Needed because `commentRefs` holds LOGICAL refs (`v3:...`) while the double
 * stores objects under their LOCATOR. Comparing a ref against an object key
 * directly would be comparing two different namespaces and would silently
 * assert nothing, which is the failure mode this helper exists to prevent.
 */
function storageKeyOf(credential, ref) {
  const digest = createHash('sha256')
    .update(`${credential.storageCapability}:${ref}`)
    .digest('base64url');
  return `board-v3-${digest}`;
}

/** The storage key of the tail comment shard holding `body` as its last message. */
function tailShardHolding(server, body) {
  const entry = commentShards(server).find(
    ([, shard]) => shard.value.messages.at(-1).body === body);
  assert.ok(entry, `a comment shard ending in "${body}" exists`);
  return entry[0];
}

/** The live meta: the one materialized object the current pointer names. */
function liveMeta(server) {
  const head = server.objects.get('board-v2').value.head;
  const entry = [...server.objects.values()].find(
    (candidate) => candidate.value?.directoryRefs !== undefined && candidate.value.head === head);
  assert.ok(entry, 'the pointer names a materialized meta that exists');
  return entry.value;
}

/**
 * The PUBLISHED issue snapshot, resolved the way a reader resolves it: pointer
 * -> meta -> directory page -> entry ref -> object.
 *
 * Not "the newest snapshot object on disk". Those differ exactly when a commit
 * writes shards and then loses its pointer CAS, and the difference is the whole
 * subject of this file, so a helper that conflated them would assert the
 * opposite of what it claims.
 */
function liveSnapshot(server, credential) {
  const meta = liveMeta(server);
  const directory = meta.directoryRefs.find((ref) => ref !== null);
  const page = server.objects.get(storageKeyOf(credential, directory)).value;
  const entry = page.entries.find((candidate) => candidate.number === 1);
  assert.ok(entry, 'the directory names issue 1');
  const snapshot = server.objects.get(storageKeyOf(credential, entry.ref));
  assert.ok(snapshot, 'the directory names an issue snapshot that exists');
  return snapshot.value;
}

/** The PUBLISHED issue snapshot's own ref, i.e. what the directory names for it. */
function liveIssueRef(server, credential) {
  const meta = liveMeta(server);
  const directory = meta.directoryRefs.find((ref) => ref !== null);
  const page = server.objects.get(storageKeyOf(credential, directory)).value;
  return page.entries.find((candidate) => candidate.number === 1).ref;
}

const comment = (body) => ({ kind: 'issue.comment', payload: { number: 1, author: 'tester', body } });

test('superseding a comment shard writes a new ref and leaves the old shard in place', async () => {
  const { server, store, initialized } = await boardWithComments(60);

  const before = commentShards(server);
  assert.equal(before.length, 2, '60 comments are a full 50-message shard plus a tail shard');
  const supersededKey = before[1][0];
  const supersededLast = before[1][1].value.messages.at(-1).body;
  assert.equal(supersededLast, 'message 60');

  // The tail page is rewritten by every later comment, so this is the
  // supersession the residual is about.
  await store.appendFast(initialized.credential, comment('newest 1'));

  const after = commentShards(server);
  assert.equal(after.length, 3,
    'writeShard POSTed a NEW content-addressed object; it did not overwrite the old shard');
  assert.equal(server.objects.has(supersededKey), true,
    'the superseded shard is still on disk immediately after the commit');
  assert.equal(server.objects.get(supersededKey).value.messages.at(-1).body, 'message 60',
    'and it still holds exactly what it held before, unmutated');
  assert.equal(store.sweepReport().skipped, true,
    'the retention window held, so the sweep reclaimed nothing');

  // The paged read resolves against the snapshot this commit published.
  const page2 = await store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.equal(page2.total, 61);
  assert.equal(page2.pageCount, 2);
  assert.equal(page2.messages.length, 11);
  assert.equal(page2.messages[0].body, 'message 51', 'the rewritten page, in order');
  assert.equal(page2.messages.at(-1).body, 'newest 1');

  // Page 1 was never rewritten, so its ref is carried forward untouched.
  const page1 = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.messages[0].body, 'message 1');
  assert.equal(page1.messages.at(-1).body, 'message 50');
});

test('commentRefs is rewritten in the same commit that supersedes the shard', async () => {
  const { server, store, initialized } = await boardWithComments(60);

  const before = liveSnapshot(server, initialized.credential);
  assert.equal(before.commentRefs.length, 2);
  const supersededRef = before.commentRefs[1];
  const carriedRef = before.commentRefs[0];

  await store.appendFast(initialized.credential, comment('newest 1'));

  const after = liveSnapshot(server, initialized.credential);
  const meta = liveMeta(server);

  // The rewrite is in the PUBLISHED snapshot, not merely on disk.
  assert.equal(after.commentRefs.length, 2);
  assert.notEqual(after.commentRefs[1], supersededRef,
    'the published snapshot names the new tail ref');
  assert.equal(after.commentRefs[0], carriedRef, 'an untouched page ref is carried forward');
  assert.equal(after.messageCount, 61, 'the count moved in the same snapshot');

  // The superseded ref is recorded on the same generation's meta, so the delete
  // is later, ordered, and never a guess from the reader's side.
  assert.equal(meta.supersededRefs.includes(supersededRef), true,
    'the superseded comment shard ref is recorded on the generation that replaced it');
  assert.equal(meta.supersededRefs.includes(carriedRef), false,
    'a ref the generation still pins is not in its own delete set');

  // The atomicity claim as a set relation: nothing the live snapshot names is in
  // the live generation's delete set.
  const live = new Set(after.commentRefs);
  assert.equal([...live].some((ref) => meta.supersededRefs.includes(ref)), false,
    'live commentRefs and this generation delete set are disjoint');

  // And every page resolves, one shard at a time.
  for (const page of [1, 2]) {
    const read = await store.readIssueCommentPage(initialized.credential, 1, page);
    assert.ok(read.messages.length > 0, `page ${page} resolves`);
  }
});

test('after the window closes, the sweep reclaims the superseded shard and the read still holds', async () => {
  const { server, store, initialized, advance } = await boardWithComments(60);

  const originalTail = commentShards(server)[1][0];
  await store.appendFast(initialized.credential, comment('newest 1'));
  const firstTail = tailShardHolding(server, 'newest 1');

  // Reclamation is gated on the AGE OF THE GENERATION THAT RECORDED THE REF, not
  // on the generation that superseded it. `originalTail` was recorded as
  // superseded by generation 2, whose meta was written before the clock moved, so
  // the very next commit past the window does reclaim it -- while `firstTail`,
  // recorded by the generation being committed right now, is in no delete set
  // anyone walks yet. Measured here rather than read off the constants.
  advance(ONE_WINDOW_MS);
  await store.appendFast(initialized.credential, comment('newest 2'));
  assert.ok(store.sweepReport().reclaimed > 0, 'the sweep ran');
  assert.equal(server.objects.has(originalTail), false,
    'the superseded comment shard is genuinely gone from storage');
  assert.equal(server.objects.has(firstTail), true,
    'the shard the just-committed generation superseded is still inside the window');

  // One more generation and one more window, and the second one goes too.
  advance(ONE_WINDOW_MS);
  await store.appendFast(initialized.credential, comment('newest 3'));
  assert.ok(store.sweepReport().reclaimed > 0, 'the sweep ran again');
  assert.equal(server.objects.has(firstTail), false,
    'the shard superseded a generation later is now gone as well');

  // The live ref map names none of the reclaimed shards -- the negative form of
  // the residual: a published snapshot cannot name a shard that does not exist.
  const live = liveSnapshot(server, initialized.credential);
  assert.equal(live.commentRefs.length, 2);
  assert.equal(live.messageCount, 63);
  const liveKeys = live.commentRefs.map((ref) => storageKeyOf(initialized.credential, ref));
  assert.equal(liveKeys.includes(originalTail), false);
  assert.equal(liveKeys.includes(firstTail), false);
  assert.equal(liveKeys.every((key) => server.objects.has(key)), true,
    'every comment ref the live snapshot names resolves to an object that exists');

  // Every page still reads, so no ref the snapshot names was reclaimed.
  const page1 = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.messages.at(-1).body, 'message 50');
  const page2 = await store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.equal(page2.total, 63);
  assert.equal(page2.pageCount, 2);
  assert.equal(page2.messages.length, 13);
  assert.equal(page2.messages[0].body, 'message 51');
  assert.equal(page2.messages.at(-1).body, 'newest 3');

  // The whole thread still reassembles in order: no page lost, none served twice.
  const thread = await store.getIssue(initialized.credential, 1);
  assert.equal(thread.messages.length, 63);
  const expected = [
    ...Array.from({ length: 60 }, (_, index) => `message ${index + 1}`),
    'newest 1',
    'newest 2',
    'newest 3',
  ];
  assert.equal(thread.messages.map((entry) => entry.body).join('|'), expected.join('|'));

  // A page past the end touches no comment shard at all.
  const past = await store.readIssueCommentPage(initialized.credential, 1, 99);
  assert.equal(past.total, 63);
  assert.equal(past.messages.length, 0);
  assert.equal(store.sweepReport().retained, 0, 'nothing failed or was refused');
});

test('an interrupted commit leaves commentRefs naming only resolvable shards', async () => {
  // The atomicity question stated negatively: fail the pointer CAS so every
  // shard the attempt wrote exists but NOTHING is published and nothing is
  // swept. A reader must then still be served by the previous generation, whose
  // refs all still resolve -- no 404 on a comment shard, and no new ref map
  // against old content.
  const server = fakeSkrynia();
  const h = harness(server, { maxAttempts: 3 });
  const initialized = await h.store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Interrupted',
      body: 'the description',
      state: 'open',
      createdAt: STAMP,
      updatedAt: STAMP,
      messages: Array.from({ length: 60 }, (_, index) => message(index)),
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });

  const published = liveSnapshot(server, initialized.credential);
  assert.equal(published.messageCount, 60);
  const queueKeyBefore = storageKeyOf(initialized.credential, liveMeta(server).queueRef);

  h.advance(ONE_WINDOW_MS);
  h.refusePointerCas();
  await assert.rejects(
    () => h.store.appendFast(initialized.credential, comment('never published')),
    /changed too often/i,
  );
  h.allowPointerCas();

  // A lost CAS is not a failed write: nothing published, nothing swept.
  assert.equal(h.store.sweepReport().reclaimed, 0, 'a lost CAS reclaims nothing');
  const stillPublished = liveSnapshot(server, initialized.credential);
  assert.equal(stillPublished.messageCount, 60, 'the interrupted write published nothing');
  assert.deepEqual(stillPublished.commentRefs, published.commentRefs,
    'the ref map is unchanged, so no ref it names was superseded');

  // Both pages resolve against the still-published snapshot.
  const page1 = await h.store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.messages.at(-1).body, 'message 50');
  const page2 = await h.store.readIssueCommentPage(initialized.credential, 1, 2);
  assert.equal(page2.total, 60);
  assert.equal(page2.messages.length, 10);
  assert.equal(page2.messages.at(-1).body, 'message 60');

  // The attempt's shards are inert garbage, not a dangling reference.
  const orphanKeys = new Set(commentShards(server)
    .filter(([, shard]) => shard.value.messages.some((entry) => entry.body === 'never published'))
    .map(([key]) => key));
  assert.ok(orphanKeys.size > 0, 'the attempt did write a shard for the comment');
  const liveKeys = new Set(stillPublished.commentRefs
    .map((ref) => storageKeyOf(initialized.credential, ref)));
  assert.equal([...orphanKeys].some((key) => liveKeys.has(key)), false,
    'no unpublished shard ref reached the published ref map');
  assert.equal([...liveKeys].every((key) => server.objects.has(key)), true,
    'every ref the published snapshot names still exists');

  // And nothing the PUBLISHED meta pins was swept away by the abandoned attempt.
  // A sweep that ran on a lost CAS would delete the generation the pointer still
  // names, because the abandoned attempt's supersededRefs list is computed
  // against a generation that is still live.
  assert.equal(server.objects.has(queueKeyBefore), true,
    'the live meta still pins a queue shard that exists');
  const overview = await h.store.readOverview(initialized.credential);
  assert.equal(overview.issues.length, 1);
});

test('an A->B->A edit does not re-establish a ref, and the sweep still leaves the read whole', async () => {
  // MEASURED, and the measurement is the point of keeping this case. An earlier
  // version of this comment claimed that editing a body A -> B -> A "writes A's
  // ref again", and inferred from that a re-establishment the sweep had to
  // survive. That inference is false for an ISSUE SNAPSHOT, and the assertions
  // here do not establish it: with `if (pinnedAgain.has(ref)) continue;` removed
  // from `reclaimOutsideWindow`, this test still passes.
  //
  // The reason is measured below rather than argued. An `IssueSnapshot` embeds
  // `issue.updatedAt`, which advances on every edit, so the second 'AAA' is not
  // the first 'AAA' byte-for-byte and content addressing gives it a different
  // ref. Nothing is re-established, so there is no re-established ref for the
  // sweep to get wrong. The `pinnedAgain` guard's witness is the NEXT test, whose
  // close/reopen really does return the queue shard to identical content.
  //
  // What this case does establish, and what would regress if the sweep overran a
  // live generation: an edit storm followed by a reclaiming sweep leaves the
  // issue readable and every comment ref the published snapshot names present.
  const { server, store, initialized, advance } = await boardWithComments(1);

  const firstEditRef = liveIssueRef(server, initialized.credential);
  await store.appendFast(initialized.credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: null, body: 'BBB' },
  });
  await store.appendFast(initialized.credential, {
    kind: 'issue.edit',
    payload: { number: 1, title: null, body: 'AAA' },
  });

  // The premise this case is NOT built on, asserted so it cannot be assumed:
  // the body came back to 'AAA' and the ref did not.
  const secondEditRef = liveIssueRef(server, initialized.credential);
  assert.equal(server.objects.get(storageKeyOf(initialized.credential, secondEditRef)).value.issue.body, 'AAA',
    'the edit round-tripped the body');
  assert.notEqual(secondEditRef, firstEditRef,
    'but the snapshot embeds issue.updatedAt, so the round trip did NOT re-establish the first ref');

  advance(ONE_WINDOW_MS);
  await store.appendFast(initialized.credential, comment('trigger the sweep'));

  assert.ok(store.sweepReport().reclaimed > 0, 'the sweep ran and reclaimed');
  const live = liveSnapshot(server, initialized.credential);
  const page = await store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(page.issue.body, 'AAA', 'the live snapshot survived the sweep');
  assert.equal(page.messages.length, 2);
  assert.equal(page.total, 2);
  assert.equal(live.messageCount, 2);
  assert.equal(live.commentRefs
    .every((ref) => server.objects.has(storageKeyOf(initialized.credential, ref))), true,
  'every comment ref the live snapshot names still exists after the sweep');
});
test('a ref re-established by a later generation survives the sweep that recorded it', async () => {
  // The non-vacuity test for the guard, and the reason this file measures the
  // sweep rather than trusting it. Closing and reopening an issue returns the
  // queue to exactly the content it had before, so the queue shard written at
  // generation 1 is written AGAIN at generation 3 -- a ref recorded as
  // superseded by generation 2 and pinned by generation 3. Reclaiming on the
  // recorded list alone deletes a live shard, and the failure surfaces as a 404
  // that `requireJson` reports as a credential problem, on the live meta.
  //
  // This is the same failure the residual describes -- a published generation
  // naming a shard the sweep deleted -- reached through the meta rather than
  // through `commentRefs`. It is here because removing the guard makes THIS fail
  // while every comment-shard assertion above still passes, which is exactly the
  // evidence that the comment-shard tests are not what is holding the property
  // up on their own.
  const server = fakeSkrynia();
  const h = harness(server);
  const initialized = await h.store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'Re-establishment',
      body: 'AAA',
      state: 'open',
      createdAt: STAMP,
      updatedAt: STAMP,
      messages: [message(0)],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });

  await h.store.appendFast(initialized.credential, { kind: 'issue.close', payload: { number: 1 } });
  await h.store.appendFast(initialized.credential, { kind: 'issue.reopen', payload: { number: 1 } });

  h.advance(ONE_WINDOW_MS);
  await h.store.appendFast(initialized.credential, comment('trigger the sweep'));
  assert.ok(h.store.sweepReport().reclaimed > 0, 'the sweep ran and reclaimed');

  // Every ref the live meta pins still resolves. This is the whole assertion: on
  // the mutated store the queue ref is gone and this throws the 404 the code
  // reports as a credential problem.
  const meta = liveMeta(server);
  const named = [
    ...meta.directoryRefs.filter((ref) => ref !== null),
    ...meta.openPageRefs.filter((ref) => ref !== null),
    ...meta.closedPageRefs.filter((ref) => ref !== null),
    meta.queueRef,
    meta.catalogRef,
    ...meta.feedPageRefs.filter((ref) => ref !== null),
  ];
  const missing = named.filter(
    (ref) => !server.objects.has(storageKeyOf(initialized.credential, ref)));
  assert.deepEqual(missing, [], 'every ref the live meta pins still exists after the sweep');

  // And the reads that consume those refs both work.
  const overview = await h.store.readOverview(initialized.credential);
  assert.equal(overview.issues.length, 1);
  const page = await h.store.readIssueCommentPage(initialized.credential, 1, 1);
  assert.equal(page.issue.state, 'open');
  assert.equal(page.messages.length, 2);
});
