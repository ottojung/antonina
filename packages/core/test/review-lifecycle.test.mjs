import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi } from '../dist/api.js';
import { parseBoard, reviewBlocksCompletion } from '../dist/model.js';
import { fakeSkrynia } from './fake-skrynia.mjs';

// The branch-to-PR handoff's review step, at the level a caller meets it.
//
// docs/skills/itinerary-antonina.md makes "no unresolved review blocker remains"
// part of the completion predicate and states that a pull request is a review
// mechanism rather than an authority boundary. These tests are about the first
// half of that: the blocker is something the board holds and the close path
// obeys, rather than a sentence in a comment an orchestrator may or may not
// have read. They do not depend on any GitHub authority, because none of this
// is reachable through a pull request.

function api(server) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date('2026-10-02T22:00:00.000Z'),
    newId: () => `review-${++sequence}`,
  });
}

/**
 * A second client holding only what a restart would hold: the published trust
 * anchor, the credential and the remembered head. Everything it reads comes off
 * the store rather than out of the writer's memory, which is the point of every
 * test below that uses it.
 */
function readerApi(server, writer) {
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date('2026-10-02T22:05:00.000Z'),
    newId: () => 'review-reader',
    trustAnchor: writer.getTrustAnchor(),
    credential: writer.getCredential(),
    rememberedHead: writer.getRememberedHead(),
  });
}

test('a review blocker refuses the close and leaves the issue in the queue', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Kawun handoff', 'branch-to-PR handoff and review lifecycle');

  await client.recordReview({
    number: issue.number,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    verdict: 'request-changes',
    reviewer: 'independent',
    rationale: 'Error: recommend no merge, the handoff drops the blocker',
  });

  await assert.rejects(
    () => client.close(issue.number),
    /unresolved review blocker recorded by independent against commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  const still = await client.getIssue(issue.number);
  assert.equal(still.state, 'open');
  assert.equal((await client.getQueue()).includes(issue.number), true);
});

test('the blocker survives a fresh reader, so a restart is not a way around it', async () => {
  const server = fakeSkrynia();
  const writer = api(server);
  await writer.initialize();
  const issue = await writer.createIssue('Survives materialization');
  await writer.recordReview({
    number: issue.number,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    verdict: 'request-changes',
    reviewer: 'independent',
    rationale: 'recommend no merge',
  });

  // A second client holding only the published trust anchor and credential
  // reads through the sharded store rather than through the writer's memory.
  const reader = new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date('2026-10-02T22:05:00.000Z'),
    newId: () => 'review-reader',
    trustAnchor: writer.getTrustAnchor(),
    credential: writer.getCredential(),
    rememberedHead: writer.getRememberedHead(),
  });
  const reread = await reader.getIssue(issue.number);
  assert.equal(reread.review.verdict, 'request-changes');
  assert.equal(reread.review.commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await assert.rejects(() => reader.close(issue.number), /unresolved review blocker/);

  // And the verdict is on the issue list projection, not only the detail read:
  // the write path rebuilds its working issue from that projection, so a list
  // that dropped the verdict would hand the next mutation an unblocked issue.
  const [summary] = await reader.listIssueSummaries('open');
  assert.equal(summary.review.verdict, 'request-changes');
});

test('the same-commit override is refused, and the fix-as-a-new-commit path works', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Override attempt');
  await client.recordReview({
    number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'request-changes',
    reviewer: 'independent', rationale: 'recommend no merge',
  });

  await assert.rejects(
    () => client.recordReview({
      number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'approve',
      reviewer: 'front', rationale: 'proceed anyway',
    }),
    /an approval cannot clear the review blocker recorded against commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
  );
  await assert.rejects(() => client.close(issue.number), /unresolved review blocker/);

  const approval = await client.recordReview({
    number: issue.number, commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', verdict: 'approve',
    reviewer: 'independent', rationale: 'blocker addressed',
  });
  assert.equal(approval.commit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const closed = await client.close(issue.number);
  assert.equal(closed.state, 'closed');
  assert.equal((await client.getQueue()).includes(issue.number), false);
});

test('an unreviewed issue closes, because an absent review is not an approval', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Never reviewed');
  assert.equal((await client.getIssue(issue.number)).review, undefined);
  assert.equal((await client.close(issue.number)).state, 'closed');
});

test('a recorded verdict names the commit it is about, and an empty commit is accepted', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('No commit named');
  const review = await client.recordReview({
    number: issue.number, commit: '', verdict: 'request-changes',
    reviewer: 'independent', rationale: 'blocked before a tree existed',
  });
  assert.equal(review.commit, '');
  await assert.rejects(() => client.close(issue.number), /against no named commit/);
});

test('an empty reviewer or rationale is refused before anything is written', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Incomplete review');
  await assert.rejects(
    () => client.recordReview({
      number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'approve', reviewer: '  ', rationale: 'fine',
    }),
    /Review reviewer is required/,
  );
  await assert.rejects(
    () => client.recordReview({
      number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'approve', reviewer: 'a', rationale: '',
    }),
    /Review rationale is required/,
  );
});

test('reviewBlocksCompletion is the predicate, and it reads a parsed board', () => {
  assert.equal(reviewBlocksCompletion({ number: 1 }), null);
  assert.equal(reviewBlocksCompletion({
    number: 1,
    review: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'approve', reviewer: 'a', rationale: 'ok', recordedAt: '2026-10-02T22:00:00.000Z' },
  }), null);
  assert.match(reviewBlocksCompletion({
    number: 1,
    review: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'request-changes', reviewer: 'a', rationale: 'no merge', recordedAt: '2026-10-02T22:00:00.000Z' },
  }), /commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: no merge/);

  // A board carrying the field still parses, and one carrying a verdict this
  // build does not know is refused rather than read as "no blocker".
  const base = {
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [{
      number: 1, title: 'T', body: '', state: 'open',
      createdAt: '2026-10-02T22:00:00.000Z', updatedAt: '2026-10-02T22:00:00.000Z', messages: [],
      review: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'request-changes', reviewer: 'a', rationale: 'r', recordedAt: '2026-10-02T22:00:00.000Z' },
    }],
    resources: [],
    targets: [],
    dispatches: [],
  };
  assert.equal(parseBoard(base).issues[0].review.verdict, 'request-changes');
  assert.throws(
    () => parseBoard({ ...base, issues: [{ ...base.issues[0], review: { ...base.issues[0].review, verdict: 'recommend-no-merge' } }] }),
    /verdict/,
  );
});

// Repairs D1 and D3 of /workspace/BOARD44-F1REVIEW-1128Z.md, at the level a
// caller meets them rather than at the store's own reader. The store test in
// board-v3-store.test.mjs pins the named refusal in each materialized position;
// this one pins what the caller gets: a `null` in the issue snapshot is a false
// clear unless the close is refused, and a `null` in the list projection is a
// crash unless the mutation path refuses it by name. Before the repair the first
// of these closed a blocked issue and the second died of
// `TypeError: summary.outstandingBlocks is not iterable`.

/**
 * Rewrites `null` into `field` of the shards that materialize the issue in
 * exactly one position -- the issue snapshot or the list projection -- the way
 * another writer of the same object would, and leaves the ref naming the new
 * content. One position at a time, because the two readers are separate
 * questions: a null in both would let whichever reader still refuses answer for
 * the other, and a test that cannot tell which reader refused proves nothing
 * about either.
 */
async function writeStoredNull(server, field, position) {
  const shards = [...server.objects.entries()].filter(([, entry]) => {
    if (position === 'the issue snapshot') return entry.value?.issue?.[field] !== undefined;
    return (entry.value?.entries ?? []).some((summary) => summary?.[field] !== undefined);
  });
  assert.ok(shards.length >= 1, `${field} must be materialized in ${position}`);
  for (const [key] of shards) {
    const entry = server.objects.get(key);
    const stored = entry.value.issue !== undefined
      ? { ...entry.value, issue: { ...entry.value.issue, [field]: null } }
      : {
        ...entry.value,
        entries: entry.value.entries.map((summary) => (
          summary[field] === undefined ? summary : { ...summary, [field]: null }
        )),
      };
    const response = await server.fetch(`https://example.invalid/_skrynia/store/antonina/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Skrynia-Capability': server.capabilityOf(key) },
      body: JSON.stringify(stored),
    });
    assert.equal(response.status, 200, 'the contract double must model anonymous overwrite');
    const reread = server.objects.get(key).value;
    assert.equal((reread.issue ?? reread.entries[0])[field], null, 'the overwrite must land');
  }
}

test('a stored review of null cannot be closed, because the refusal is not a clear', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Blocked, then unreadable');
  await client.recordReview({
    number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'request-changes',
    reviewer: 'independent', rationale: 'recommend no merge',
  });
  await assert.rejects(() => client.close(issue.number), /unresolved review blocker/);

  await writeStoredNull(server, 'review', 'the issue snapshot');

  const reader = readerApi(server, client);
  await assert.rejects(
    () => reader.getIssue(issue.number),
    /stored review verdict is malformed/,
    'a stored null is a value that failed to load, not an issue that was never reviewed',
  );
  await assert.rejects(
    () => reader.close(issue.number),
    /stored review verdict is malformed/,
    'the close must refuse rather than read the blocked issue as unreviewed',
  );
  // The list projection was not touched and still serves the intact verdict: what
  // is refused is the shape the snapshot reader was handed, not the whole board.
  const [summary] = await reader.listIssueSummaries('open');
  assert.equal(summary.review.verdict, 'request-changes');
  assert.equal((await client.getQueue()).includes(issue.number), true, 'the issue must still be open');
});

test('a stored outstanding-block list of null is a named refusal on the mutation path, not a crash', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Blocked, then an unreadable block list');
  await client.recordReview({
    number: issue.number, commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'request-changes',
    reviewer: 'independent', rationale: 'recommend no merge',
  });

  await writeStoredNull(server, 'outstandingBlocks', 'the list projection');

  // The compact write path rebuilds its working issue from the list projection
  // through `issueFromSummary`, which is where a leaked `null` was iterated. The
  // refusal must arrive before that, and it must be the store's own name for the
  // shape rather than a TypeError from a spread three frames deeper.
  const reader = readerApi(server, client);
  // The mutation path is asserted first, because that is the read the crash
  // happened on, and a later assertion must not be the one that reports it.
  await reader.comment(issue.number, 'tester', 'an update').then(
    () => assert.fail('a stored outstanding-block list of null was accepted by the mutation path'),
    (error) => {
      assert.match(error.message, /stored outstanding review blocks are malformed/);
      assert.notEqual(error.constructor.name, 'TypeError', 'this must be a named refusal, not a crash');
    },
  );
  await assert.rejects(
    () => reader.listIssueSummaries('open'),
    /stored outstanding review blocks are malformed/,
  );
  await assert.rejects(
    () => reader.close(issue.number),
    /stored outstanding review blocks are malformed/,
    'the close path must refuse the shape by name too',
  );
});
