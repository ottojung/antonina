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
