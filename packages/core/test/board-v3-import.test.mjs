import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SignedBoardStore } from '../dist/board-store.js';
import { fakeSkrynia } from './fake-skrynia.mjs';
import {
  buildLegacyBoard,
  LEGACY_FIXTURE,
} from './fixtures/legacy-v3-board.mjs';

/**
 * Test-owned state and config roots. Every test here runs against an in-memory
 * Skrynia and an explicit credential, so it never reaches the operator's board,
 * but the roots are redirected anyway so no path under test can read or write
 * ambient Antonina state.
 */
const roots = await mkdtemp(join(tmpdir(), 'antonina-v3-import-'));
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
 * A server holding a pre-cutover board, plus the credential that opens it.
 *
 * The credential's storage capability is the one the pointer was created with,
 * which is how a real board's credential works: Skrynia minted it for the pointer
 * object and it is what derives every shard locator.
 */
function legacyServer() {
  const server = fakeSkrynia();
  let tick = 0;
  let id = 0;
  const store = new SignedBoardStore({
    fetch: server.fetch.bind(server),
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, (tick += 1))),
    newId: () => `import-test-${++id}`,
  });
  // Initialize a board to obtain a real credential and the capability, then
  // replace its contents wholesale with the fixture. The credential is then
  // genuinely the one a pre-cutover board would have issued.
  return { server, store, capability: server.capability };
}

async function withLegacyBoard(run) {
  const { server, store } = legacyServer();
  const bootstrap = await store.initialize({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1,
      title: 'placeholder',
      body: '',
      state: 'open',
      createdAt: '2026-09-20T09:00:00.000Z',
      updatedAt: '2026-09-20T09:00:00.000Z',
      messages: [],
    }],
    resources: [],
    targets: [],
    dispatches: [],
  });
  const credential = bootstrap.credential;
  const fixture = buildLegacyBoard(credential.storageCapability, {
    boardId: credential.boardId,
    rootKeyId: credential.rootKeyId,
  });
  // Replace the namespace with the fixture. The pointer keeps the capability the
  // store was created with, so the credential still opens it.
  const pointer = server.objects.get('board-v2');
  for (const key of [...server.objects.keys()]) {
    if (key !== 'board-v2') server.objects.delete(key);
  }
  for (const [key, entry] of fixture.objects) {
    if (key === 'board-v2') continue;
    server.objects.set(key, entry);
  }
  server.objects.set('board-v2', {
    ...pointer,
    value: fixture.objects.get('board-v2').value,
  });
  return run({ server, store, credential, fixture, tick: 0 });
}

test('a pre-cutover board is not served, and says why by name', async () => {
  await withLegacyBoard(async ({ store, credential }) => {
    // Every read path refuses, by name, with the action that fixes it. The
    // refusal is the boundary: the runtime must not quietly read the old shape.
    for (const read of [
      () => store.readOverview(credential),
      () => store.getIssue(credential, 1),
      () => store.getQueue(credential),
      () => store.readIssuePage(credential, 'open', 1),
      () => store.readFeed(credential, { limit: 5 }),
      () => store.readWithCredential(credential),
      () => store.appendFast(credential, { kind: 'issue.comment', payload: { number: 1, author: 'a', body: 'b' } }),
    ]) {
      await assert.rejects(read, /must be imported/);
    }
  });
});

test('an import plan reports what would be carried across and writes nothing', async () => {
  await withLegacyBoard(async ({ server, store, credential, fixture }) => {
    const before = server.objects.size;
    const report = await store.importBoard(credential);

    assert.equal(report.state, 'needs-import');
    assert.equal(report.cutover, false, 'a plan must not cut over');
    assert.equal(report.fromRevision, 7);
    assert.equal(report.toRevision, null);
    assert.equal(report.issues, LEGACY_FIXTURE.issues.length);
    assert.equal(
      report.comments,
      LEGACY_FIXTURE.issues.reduce((total, issue) => total + issue.messages, 0),
    );
    assert.equal(report.feedEntries, fixture.feedEntryCount);
    assert.equal(report.queueLength, 3);
    assert.equal(report.resources, 1);
    assert.equal(report.targets, 1);
    assert.equal(report.dispatches, 1);
    assert.equal(report.equivalent, true, JSON.stringify(report.checks));
    // The checks are named, so a failure says which property broke.
    for (const name of ['issues', 'queue', 'resources', 'targets', 'dispatches', 'feed', 'feedServedNewestFirst', 'nextIssueNumber', 'feedCount', 'openIssueCount', 'closedIssueCount']) {
      assert.ok(
        report.checks.some((check) => check.name === name && check.equal),
        `check ${name} must be present and passing`,
      );
    }
    // The plan writes shards but publishes nothing, so the pointer is untouched
    // and the board is still refusing reads.
    assert.equal(server.objects.get('board-v2').value.format, 'materialized-snapshots');
    await assert.rejects(() => store.readOverview(credential), /must be imported/);
    assert.ok(server.objects.size > before, 'a plan does materialize shards to verify against');
  });
});

test('an import reproduces the board exactly, and the runtime serves the new store', async () => {
  await withLegacyBoard(async ({ server, store, credential, fixture }) => {
    const report = await store.importBoard(credential, { confirm: true });
    assert.equal(report.cutover, true);
    assert.equal(report.state, 'cutover-complete');
    assert.equal(report.equivalent, true, JSON.stringify(report.checks.filter((check) => !check.equal)));

    // Cut over: the pointer is the current format, and every read now works.
    assert.equal(pointerOf(server).format, 'compact-materialized-snapshots');
    const cutover = await store.cutoverState(credential);
    assert.equal(cutover.state, 'cutover-complete');

    const board = (await store.readWithCredential(credential)).state.board;
    assert.equal(board.issues.length, LEGACY_FIXTURE.issues.length);
    assert.equal(board.nextIssueNumber, 6);
    assert.deepEqual(
      board.issues.map((issue) => issue.number),
      LEGACY_FIXTURE.issues.map((issue) => issue.number),
    );
    // Bodies, states, timestamps and every comment with its author survive.
    for (const summary of LEGACY_FIXTURE.issues) {
      const issue = board.issues.find((candidate) => candidate.number === summary.number);
      assert.equal(issue.body, summary.body, `body of issue ${summary.number}`);
      assert.equal(issue.state, summary.state, `state of issue ${summary.number}`);
      assert.equal(issue.messages.length, summary.messages, `comments on issue ${summary.number}`);
      assert.equal(issue.createdAt, '2026-09-20T09:00:00.000Z');
      assert.ok(issue.messages.every((message) => message.author.startsWith('author-')));
      assert.ok(issue.messages.every((message) => message.body.includes(`on issue ${summary.number}`)));
    }
    // The queue order, and the closed list a reader pages through.
    assert.deepEqual(await store.getQueue(credential), [1, 2, 5]);
    const closed = await store.readIssuePage(credential, 'closed', 1);
    assert.equal(closed.entries[0].number, 3);
    assert.equal(closed.total, 1);
    // The catalog.
    assert.equal(board.resources[0].path, '/srv/legacy');
    assert.equal(board.targets[0].id, 'legacy-target');
    assert.equal(board.dispatches[0].issueNumber, 1);
    // The feed, in order, across its pages, with the deleted issue's comments
    // resolved even though the issue does not exist.
    const { entries, total } = await readAllFeed(store, credential);
    assert.equal(entries.length, fixture.feedEntryCount);
    assert.equal(total, fixture.feedEntryCount);
    for (let index = 1; index < entries.length; index += 1) {
      assert.equal(entries[index].position, entries[index - 1].position - 1, 'served newest-first');
    }
    const deletedComments = entries.filter(
      (entry) => entry.issueNumber === LEGACY_FIXTURE.deletedIssue.number,
    );
    assert.equal(deletedComments.length, LEGACY_FIXTURE.deletedIssue.messages);
    for (const id of fixture.deletedIssueMessageIds) {
      const entry = entries.find((candidate) => candidate.messageId === id);
      assert.ok(entry, `a deleted issue's comment ${id} must be in the feed`);
      assert.ok(entry.body.includes(`on issue ${LEGACY_FIXTURE.deletedIssue.number}`));
      assert.ok(entry.author.startsWith('author-'));
    }
    // And the deleted issue is genuinely not a live issue any more.
    assert.equal(await store.getIssue(credential, LEGACY_FIXTURE.deletedIssue.number), null);
  });
});

test('the imported store is compact: no superseded artifact is carried across', async () => {
  await withLegacyBoard(async ({ server, store, credential, fixture }) => {
    const before = server.objects.size;
    const report = await store.importBoard(credential, { confirm: true });

    // Every shard the old store named is still there, untouched: the import does
    // not delete, because Skrynia will not delete an immutable object and the old
    // store is left whole for Skrynia to remove wholesale.
    const legacyShardKeys = [
      ...fixture.keys.directory,
      ...fixture.keys.openPages,
      ...fixture.keys.closedPages,
      ...fixture.keys.feedPages,
      ...fixture.keys.issues.map(([, key]) => key),
      fixture.keys.queue,
      fixture.keys.catalog,
      fixture.keys.meta,
    ];
    for (const key of legacyShardKeys) {
      assert.ok(server.objects.has(key), `the pre-cutover store must be left whole: ${key}`);
    }

    // The cutover property, stated exactly: not one of the imported shards is a
    // ref the old store used. Everything the new store names is a content
    // address, so the new store shares no object with the old one and the old one
    // is unreachable the moment the pointer moves.
    const pointer = server.objects.get('board-v2').value;
    const meta = await resolveRef(server, credential, pointer.metaRef);
    const importedRefs = await closureOf(server, credential, meta);
    assert.ok(importedRefs.length > 0);
    for (const ref of importedRefs) {
      assert.match(ref, /^v3:/, `the imported store must reference only content addresses, not ${ref}`);
      const key = await keyOf(server, credential, ref);
      assert.equal(
        legacyShardKeys.includes(key),
        false,
        `the imported store references a pre-cutover object: ${ref}`,
      );
    }
    assert.equal(report.importedRefs, importedRefs.length);
    // The report names the residue an operator is being asked to have removed.
    assert.ok(report.legacyStore.shardObjects > 0);
    assert.match(report.legacyStore.note, /Skrynia removes it/);
    // And the new store grows from here at the bounded rate, not the old one.
    const after = server.objects.size;
    for (let index = 0; index < 40; index += 1) {
      await store.appendFast(credential, {
        kind: 'issue.comment',
        payload: { number: 1, author: 'tester', body: `after import ${index}` },
      });
    }
    assert.ok(
      server.objects.size - after <= 12,
      `40 comments on the imported board grew the namespace by ${server.objects.size - after} objects`,
    );
  });
});

test('an import is idempotent, and a second one is refused rather than repeated', async () => {
  await withLegacyBoard(async ({ server, store, credential }) => {
    await store.importBoard(credential, { confirm: true });
    const head = pointerOf(server).head;
    const again = await store.importBoard(credential, { confirm: true });
    assert.equal(again.state, 'cutover-complete');
    assert.equal(again.cutover, false, 'a second import must not re-publish the board');
    assert.equal(pointerOf(server).head, head, 'the board must not be rewritten at a new head');
    assert.equal(again.issues, LEGACY_FIXTURE.issues.length);
  });
});

test('an import does not publish a board that fails verification', async () => {
  await withLegacyBoard(async ({ server, store, credential }) => {
    // Break the source so the rebuilt board cannot match it: a comment page the
    // feed needs is gone, so the source is unreadable and nothing is published.
    const fixturePages = [...server.objects.entries()]
      .filter(([, entry]) => Array.isArray(entry.value?.messages))
      .map(([key]) => key);
    assert.ok(fixturePages.length > 0);
    server.objects.delete(fixturePages[0]);

    await assert.rejects(() => store.importBoard(credential, { confirm: true }));
    // The pointer is untouched, so the board is still the pre-cutover one and the
    // operator's data is not lost or half-replaced.
    assert.equal(pointerOf(server).format, 'materialized-snapshots');
    await assert.rejects(() => store.readOverview(credential), /must be imported/);
  });
});

async function readAllFeed(store, credential) {
  const entries = [];
  let page = await store.readFeed(credential, { limit: 50 });
  let total = page.total;
  entries.push(...page.entries);
  while (page.nextCursor !== null) {
    page = await store.readFeed(credential, { limit: 50, cursor: page.nextCursor });
    entries.push(...page.entries);
    total = page.total;
  }
  return { entries, total };
}

/** The live pointer, read straight from the double the store writes to. */
function pointerOf(server) {
  return server.objects.get('board-v2').value;
}

/**
 * Resolves a logical ref to the object stored under it, the way the store does.
 *
 * The locator is a hash of the capability and the ref, so a test that wants to
 * assert on a shard cannot reach it by name. Deriving it the same way keeps the
 * assertion on the storage side of the boundary rather than inside the store.
 */
async function keyOf(server, credential, ref) {
  const value = await resolveRef(server, credential, ref);
  void value;
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256')
    .update(credential.storageCapability + ':' + ref)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'board-v3-' + digest;
}

async function resolveRef(server, credential, ref) {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256')
    .update(credential.storageCapability + ':' + ref)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return server.objects.get('board-v3-' + digest)?.value ?? null;
}

/** Every ref a meta pins, walked the way a reader walks it. */
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
    const directory = await resolveRef(server, credential, ref);
    for (const entry of directory?.entries ?? []) {
      refs.add(entry.ref);
      const snapshot = await resolveRef(server, credential, entry.ref);
      for (const commentRef of snapshot?.commentRefs ?? []) refs.add(commentRef);
    }
  }
  return [...refs];
}
