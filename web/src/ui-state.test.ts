import { describe, expect, it } from 'vitest';
import { BoardDeletedError, BoardTrustRequiredError } from './api';
import { BOARD_FEED_ENTRY_KINDS, type BoardFeedEntry } from './api';
import { BOARD_SCHEMA_VERSION, emptyBoard, type Board, type BoardIssue, type VerifiedBoardState } from './model';
import {
  accessCallout,
  boardAccess,
  boardDeleted,
  boardLoadFailed,
  boardLoaded,
  boardReadOutcome,
  COMPOSER_READ_ONLY_CALLOUT,
  COMPOSER_SUBMIT_HINT,
  DELETED_COPY,
  emptyIssueList,
  filterLabel,
  firstRunOutcome,
  FIRST_RUN_COPY,
  firstRunResolved,
  firstRunUnresolved,
  feedEntrySummary,
  FEED_KIND_LABEL,
  FEED_TRUNCATED_COPY,
  FEED_UNTRACKED_COPY,
  FEED_VERB,
  formatUpdatedAt,
  groupResources,
  ISSUE_FORM_HINT,
  ISSUE_FORM_SUBMIT_HINT,
  issueCounts,
  loadedBoard,
  moveQueueEarlier,
  moveQueueIssue,
  moveQueueLater,
  moveQueueTo,
  canMoveInQueue,
  closedIssueOrder,
  openQueueOrder,
  priorityLabel,
  QUEUE_HINT,
  QUEUE_MOVE_LABELS,
  QUEUE_MOVE_TO_LABEL,
  QUEUE_REORDERED_NOTICE,
  WRITE_ACCESS_SUMMARY,
  queuePosition,
  queueMoveToLabel,
  queueSlots,
  REJECTED_CREDENTIAL_COPY,
  trustRequired,
  unplacedIssueNumbers,
  untrackedIssueNumbers,
  visibleIssues,
  BOARD_KEY_COPY,
  READ_ONLY_CALLOUT,
  type BoardLoad,
} from './ui-state';

const timestamp = '2026-09-24T12:00:00.000Z';
function issue(number: number, state: 'open' | 'closed', updatedAt = timestamp): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: updatedAt, updatedAt, messages: [] };
}
function state(overrides: Partial<VerifiedBoardState> = {}): VerifiedBoardState {
  return {
    board: emptyBoard(),
    queue: [],
    authorities: [],
    deleted: false,
    head: 'head',
    // Derived: the board above is as current as this build can read, so the
    // migration record must be the as-current one and stay that way at a bump.
    migration: { persistedVersion: BOARD_SCHEMA_VERSION, throughVersions: [] },
    ...overrides,
  };
}

describe('issue UI state', () => {
  // Issue #19 replaced the previous "most recently updated first" presentation
  // sort, so that test is gone rather than kept as a fallback: a timestamp sort
  // is exactly the browser-local priority the shared queue forbids. These are
  // its replacements, and they are deliberately stronger than it was — the
  // queue decides the order even when a timestamp says otherwise.
  it('shows open issues in the shared queue order, not by recency', () => {
    const issues = [issue(1, 'open', '2026-09-24T23:00:00.000Z'), issue(2, 'open', '2026-09-24T01:00:00.000Z'), issue(3, 'open')];
    expect(visibleIssues(issues, [2, 3, 1], 'open').map((entry) => entry.number)).toEqual([2, 3, 1]);
    expect(visibleIssues(issues, [1, 2, 3], 'open').map((entry) => entry.number)).toEqual([1, 2, 3]);
  });

  it('takes the open order straight from the shared queue, for every queue the board could commit', () => {
    const issues = [issue(1, 'open'), issue(2, 'open'), issue(3, 'open')];
    for (const queue of [[1, 2, 3], [3, 2, 1], [2, 1, 3], [3, 1, 2]]) {
      expect(openQueueOrder(issues, queue)).toEqual(queue);
    }
  });

  it('leaves a closed issue out of the order, because the queue holds open issues only', () => {
    const issues = [issue(1, 'open'), issue(2, 'open'), issue(3, 'closed'), issue(4, 'closed')];
    expect(openQueueOrder(issues, [2, 1])).toEqual([2, 1]);
    expect(queuePosition([2, 1], 3)).toBe(0);
    expect(priorityLabel(queuePosition([2, 1], 3))).toBe('Not in the queue');
  });

  it('lists closed issues outside the queue, most recently closed first, under every filter', () => {
    const issues = [issue(1, 'open'), issue(4, 'closed', '2026-09-24T23:00:00.000Z'), issue(2, 'open'), issue(3, 'closed')];
    expect(visibleIssues(issues, [2, 1], 'closed').map((entry) => entry.number)).toEqual([4, 3]);
    expect(visibleIssues(issues, [2, 1], 'all').map((entry) => entry.number)).toEqual([2, 1, 4, 3]);
    expect(visibleIssues(issues, [2, 1], 'open').map((entry) => entry.number)).toEqual([2, 1]);
  });

  it('counts every issue view', () => {
    const issues = [issue(1, 'open'), issue(2, 'closed'), issue(3, 'open')];
    expect(issueCounts(issues)).toEqual({ open: 2, closed: 1, all: 3 });
  });

  it('groups resources by host for a separate hierarchical view', () => {
    const resources = [
      { host: 'lubko://z', path: '/b', issueNumbers: [1], createdAt: timestamp, updatedAt: timestamp },
      { host: 'lubko://a', path: '/one', issueNumbers: [1], createdAt: timestamp, updatedAt: timestamp },
      { host: 'lubko://a', path: '/two', issueNumbers: [2], createdAt: timestamp, updatedAt: timestamp },
    ];
    expect(groupResources(resources).map(([host, entries]) => [host, entries.map((entry) => entry.path)])).toEqual([
      ['lubko://a', ['/one', '/two']],
      ['lubko://z', ['/b']],
    ]);
  });

  it('formats recent and older update times', () => {
    const now = new Date('2026-09-24T12:30:00.000Z');
    expect(formatUpdatedAt('2026-09-24T12:29:30.000Z', now)).toBe('just now');
    expect(formatUpdatedAt('2026-09-24T11:45:00.000Z', now)).toBe('45m ago');
    expect(formatUpdatedAt('2026-09-24T09:00:00.000Z', now)).toBe('3h ago');
  });
});

describe('priority queue moves', () => {
  const order = [4, 2, 9, 1];

  it('sends a whole-list permutation for a single move, not the pair it swapped', () => {
    expect(moveQueueEarlier(order, 9)).toEqual([4, 9, 2, 1]);
    expect(moveQueueLater(order, 4)).toEqual([2, 4, 9, 1]);
    expect(moveQueueIssue(order, 1, 0)).toEqual([1, 4, 2, 9]);
    for (const next of [moveQueueEarlier(order, 9), moveQueueLater(order, 4), moveQueueIssue(order, 1, 0)]) {
      expect(next).not.toBeNull();
      expect([...(next as number[])].sort((left, right) => left - right)).toEqual([...order].sort((left, right) => left - right));
      expect(next).toHaveLength(order.length);
    }
  });

  it('refuses a boundary move instead of sending a queue the board would reject', () => {
    expect(moveQueueEarlier(order, 4)).toBeNull();
    expect(moveQueueLater(order, 1)).toBeNull();
    expect(canMoveInQueue(order, 4, 'earlier')).toBe(false);
    expect(canMoveInQueue(order, 4, 'later')).toBe(true);
    expect(canMoveInQueue(order, 1, 'earlier')).toBe(true);
    expect(canMoveInQueue(order, 1, 'later')).toBe(false);
  });

  it('refuses an unqueued issue, an out-of-range slot, and a move onto itself', () => {    expect(moveQueueEarlier(order, 77)).toBeNull();
    expect(moveQueueLater(order, 77)).toBeNull();
    expect(moveQueueIssue(order, 2, 0)).toEqual([2, 4, 9, 1]);
    expect(moveQueueIssue(order, 2, 1)).toBeNull();
    expect(moveQueueIssue(order, 2, order.length)).toBeNull();
    expect(moveQueueIssue(order, 2, -1)).toBeNull();
    expect(canMoveInQueue(order, 77, 'earlier')).toBe(false);
  });

  it('moves a middle issue in both directions and leaves the order untouched', () => {
    expect(moveQueueEarlier(order, 2)).toEqual([2, 4, 9, 1]);
    expect(moveQueueLater(order, 2)).toEqual([4, 9, 2, 1]);
    expect(order).toEqual([4, 2, 9, 1]);
  });

  it('reports the one-based position of a queued issue and none for an unqueued one', () => {
    expect(queuePosition(order, 4)).toBe(1);
    expect(queuePosition(order, 1)).toBe(4);
    expect(queuePosition(order, 77)).toBe(0);
    expect(priorityLabel(queuePosition(order, 9))).toBe('Priority 3');
  });

  it('offers every position as a move-to slot and moves there in one whole-queue commit', () => {
    expect(queueSlots(order)).toEqual([1, 2, 3, 4]);
    expect(moveQueueTo(order, 1, 1)).toEqual([1, 4, 2, 9]);
    expect(moveQueueTo(order, 4, 4)).toEqual([2, 9, 1, 4]);
    expect(moveQueueTo(order, 2, 2)).toBeNull();
    expect(moveQueueTo(order, 77, 1)).toBeNull();
    expect(moveQueueTo(order, 1, 5)).toBeNull();
    // The same permutation the step controls and a drop commit, never a pair.
    expect(moveQueueTo(order, 1, 1)).toEqual(moveQueueIssue(order, 1, 0));
    for (const next of [moveQueueTo(order, 1, 1), moveQueueTo(order, 4, 4)]) {
      expect([...(next as number[])].sort((left, right) => left - right)).toEqual([...order].sort((left, right) => left - right));
    }
  });

  it('names the issue and the slot range a move-to control places, so the numbers can be read aloud', () => {
    expect(queueMoveToLabel(1, 4)).toBe('Move to a chosen position in the priority queue: #1 (positions run from 1 to 4)');
  });
});

describe('board copy', () => {
  it('title-cases filter labels in the DOM instead of relying on CSS', () => {
    expect(filterLabel('open')).toBe('Open');
    expect(filterLabel('closed')).toBe('Closed');
    expect(filterLabel('all')).toBe('All');
  });

  it('describes an empty issue list for the current filter and access level', () => {
    expect(emptyIssueList('open', true).title).toBe('No open issues');
    expect(emptyIssueList('all', true).title).toBe('No issues');
    expect(emptyIssueList('open', true).body).toBe('Create an issue to give the work a shared record.');
    expect(emptyIssueList('open', false)).toEqual({ title: 'No open issues', body: 'No issues match this filter yet.' });
  });

  it('states that the one board credential grants full access', () => {
    expect(WRITE_ACCESS_SUMMARY).toContain('full read and write access');
    expect(QUEUE_HINT).toContain('shared priority order');
  });

  it('names both step directions and the chosen position for the non-drag controls', () => {
    expect(QUEUE_MOVE_LABELS.earlier).toBe('Move one place earlier in the priority queue');
    expect(QUEUE_MOVE_LABELS.later).toBe('Move one place later in the priority queue');
    expect(QUEUE_MOVE_TO_LABEL).toBe('Move to a chosen position in the priority queue');
    expect(QUEUE_REORDERED_NOTICE).toContain('everyone');
  });

  it('explains the create form and advertises its shortcut without a second hint', () => {
    expect(ISSUE_FORM_HINT).toBe('The description holds the task context; the conversation holds updates and questions.');
    expect(ISSUE_FORM_HINT).not.toContain('Ctrl');
    expect(ISSUE_FORM_SUBMIT_HINT).toBe('Ctrl+Enter or Cmd+Enter creates the issue from the description.');
  });

  it('advertises the composer shortcut next to the button it stands in for', () => {
    expect(COMPOSER_SUBMIT_HINT).toBe('Ctrl+Enter or Cmd+Enter posts this message.');
  });

  it('keeps empty-state copy distinct from the read-only access callout', () => {
    expect(emptyIssueList('all', false).body).not.toBe(READ_ONLY_CALLOUT.body);
    expect(emptyIssueList('all', true).body).not.toBe(READ_ONLY_CALLOUT.body);
  });

  it('names the access state the user is in and gives a rejected credential its own callout', () => {
    expect(boardAccess(true, false)).toBe('editable');
    expect(boardAccess(true, true)).toBe('editable');
    expect(boardAccess(false, false)).toBe('read-only');
    expect(boardAccess(false, true)).toBe('rejected');

    expect(accessCallout('editable')).toBeNull();
    expect(accessCallout('read-only')).toBe(READ_ONLY_CALLOUT);
    expect(accessCallout('rejected')).toBe(REJECTED_CREDENTIAL_COPY);
    expect(accessCallout('read-only', COMPOSER_READ_ONLY_CALLOUT)).toBe(COMPOSER_READ_ONLY_CALLOUT);
    expect(accessCallout('rejected', COMPOSER_READ_ONLY_CALLOUT)).toBe(REJECTED_CREDENTIAL_COPY);

    expect(COMPOSER_READ_ONLY_CALLOUT.title).toBe('Board credential required');
    expect(REJECTED_CREDENTIAL_COPY.body).not.toBe(READ_ONLY_CALLOUT.body);
    expect(REJECTED_CREDENTIAL_COPY.body).not.toBe(COMPOSER_READ_ONLY_CALLOUT.body);
    expect(REJECTED_CREDENTIAL_COPY.action).not.toBe(READ_ONLY_CALLOUT.action);
  });
});

describe('board load state', () => {
  const board: Board = { ...emptyBoard(), nextIssueNumber: 2, issues: [issue(1, 'open')] };
  const verified = state({ board, queue: [1] });
  const summaryBoard = {
    issues: [{
      number: 1,
      title: 'Issue 1',
      state: 'open' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      messageCount: 0,
      hasBody: false,
    }],
    resources: [],
    targets: [],
    dispatches: [],
  };
  const ready: BoardLoad = { status: 'ready', board: summaryBoard, queue: [1], head: 'head' };

  it('resolves a read to the first-run state while the board is missing', () => {
    expect(boardLoaded(null)).toEqual({ status: 'uninitialized' });
    expect(boardLoaded(verified)).toEqual(ready);
  });

  it('turns a failed initialization whose board now exists into a read-only board', () => {
    const resolved = firstRunResolved(boardLoaded(verified), new Error('The Antonina board already exists'));
    expect(resolved.load).toEqual(ready);
    expect(resolved.error).toBeUndefined();
  });

  it('keeps the first-run state and surfaces the cause while the board is still missing', () => {
    const resolved = firstRunResolved(boardLoaded(null), new Error('Skrynia POST antonina/board-v2 failed (503)'));
    expect(resolved.load).toEqual({ status: 'uninitialized' });
    expect(resolved.error).toBe('Skrynia POST antonina/board-v2 failed (503)');
  });

  it('distinguishes a board that needs its trust anchor from a read failure', () => {
    expect(trustRequired(new BoardTrustRequiredError('no trust anchor'))).toBe(true);
    expect(trustRequired(new Error('Skrynia GET antonina/board-v2 failed (503)'))).toBe(false);
    expect(boardLoadFailed({ status: 'untrusted' }, 'boom')).toEqual({ status: 'failed', message: 'boom' });
    expect(loadedBoard({ status: 'untrusted' })).toBeUndefined();
  });

  it('sends a first-run client that lost the initialize race to the trust anchor screen', () => {
    expect(firstRunUnresolved(new BoardTrustRequiredError('no trust anchor'))).toEqual({ status: 'untrusted' });
  });

  it('reports a board this browser created as ready, with the queue that create verified', () => {
    const outcome = firstRunOutcome({ state: verified });
    expect(outcome.load).toEqual(ready);
    expect(outcome.error).toBeUndefined();
    expect(outcome.notice).toBe(FIRST_RUN_COPY.initialized);
  });

  it('reports a lost first-run race as read-only, with no error', () => {
    const outcome = firstRunOutcome(
      { failure: new Error('The Antonina board already exists') },
      { state: verified },
    );
    expect(outcome.load).toEqual(ready);
    expect(outcome.error).toBeUndefined();
    expect(outcome.notice).toBe(FIRST_RUN_COPY.raced);
  });

  it('reports a create that failed for its own reason as itself, not as a race', () => {
    const outcome = firstRunOutcome(
      { failure: new Error('Skrynia POST antonina/board-v2 failed (503)') },
      { state: null },
    );
    expect(outcome.load).toEqual({ status: 'uninitialized' });
    expect(outcome.error).toBe('Skrynia POST antonina/board-v2 failed (503)');
    expect(outcome.notice).toBeUndefined();
  });

  it('classifies a read that threw after the create by its own cause, keeping the real reason', () => {
    const outcome = firstRunOutcome(
      { failure: new Error('Skrynia POST antonina/board-v2 failed (503)') },
      { failure: new BoardTrustRequiredError('no trust anchor') },
    );
    expect(outcome.load).toEqual({ status: 'untrusted' });
    expect(outcome.error).toBe('Skrynia POST antonina/board-v2 failed (503)');
    expect(outcome.notice).toBeUndefined();
  });

  it('never reports a read that found no board after a create as a success', () => {
    const outcome = firstRunOutcome({ state: null });
    expect(outcome.load).toEqual({ status: 'failed', message: FIRST_RUN_COPY.readFailed });
    expect(outcome.error).toBe(FIRST_RUN_COPY.readFailed);
    expect(outcome.notice).toBeUndefined();
  });

  it('applies the same no-board rule to the trust path', () => {
    expect(boardReadOutcome(verified)).toEqual({ load: ready });
    expect(boardReadOutcome(null)).toEqual({
      load: { status: 'failed', message: FIRST_RUN_COPY.readFailed },
      error: FIRST_RUN_COPY.readFailed,
    });
  });

  it('treats a deleted board as terminal instead of retryable', () => {
    const cause = new BoardDeletedError();
    expect(boardDeleted(cause)).toBe(true);
    expect(trustRequired(cause)).toBe(false);
    expect(firstRunUnresolved(cause)).toEqual({ status: 'deleted' });
    expect(DELETED_COPY.body).toContain('can never be initialized again');
  });

  it('reports a failed first-run read as the failure it is, not as a missing board', () => {
    expect(firstRunUnresolved(new Error('Skrynia GET antonina/board-v2 failed (503)')))
      .toEqual({ status: 'failed', message: 'Skrynia GET antonina/board-v2 failed (503)' });
  });

  it('explains that the shared board credential is required for access', () => {
    expect(BOARD_KEY_COPY.action).toBe('Open board');
    expect(BOARD_KEY_COPY.body).toContain('shared credential');
    expect(BOARD_KEY_COPY.body).toContain('full read and write access');
  });

  it('keeps the last good board when a later read fails', () => {
    expect(boardLoadFailed(ready, 'Skrynia GET failed (503)')).toBe(ready);
    expect(loadedBoard(boardLoadFailed(ready, 'Skrynia GET failed (503)'))).toBe(summaryBoard);
  });

  it('fails terminally only while no board has ever loaded', () => {
    expect(boardLoadFailed({ status: 'loading' }, 'boom')).toEqual({ status: 'failed', message: 'boom' });
    expect(boardLoadFailed({ status: 'uninitialized' }, 'boom')).toEqual({ status: 'failed', message: 'boom' });
    expect(boardLoadFailed({ status: 'failed', message: 'old' }, 'new')).toEqual({ status: 'failed', message: 'new' });
    expect(loadedBoard({ status: 'failed', message: 'boom' })).toBeUndefined();
  });
});

describe('the feed, as the browser presents it', () => {
  const STAMP = '2026-09-25T12:00:00.000Z';
  const feedEntry = (overrides: Partial<BoardFeedEntry> = {}): BoardFeedEntry => ({
    id: 'op-1', kind: 'issue-created', at: STAMP, position: 3, issueNumber: 4, title: 'Issue 4',
    state: 'open', messageId: null, author: null, body: null, ...overrides,
  });
  const issue = (number: number): BoardIssue => ({
    number, title: 'Issue ' + number, body: '', state: 'open', createdAt: STAMP, updatedAt: STAMP, messages: [],
  });

  it('names every kind the projection can produce, and no other', () => {
    // The mappings are total over the vocabulary, so a kind added to the core
    // feed is a compile error here rather than a row that silently reads as
    // the last case.
    expect(Object.keys(FEED_VERB).sort()).toEqual([...BOARD_FEED_ENTRY_KINDS].sort());
    expect(Object.keys(FEED_KIND_LABEL).sort()).toEqual([...BOARD_FEED_ENTRY_KINDS].sort());
  });

  it('says the same verb the CLI prints for each kind', () => {
    expect(FEED_VERB).toEqual({
      'issue-created': 'created',
      'issue-edited': 'edited',
      'comment-added': 'commented',
      'issue-closed': 'closed',
      'issue-reopened': 'reopened',
      'issue-deleted': 'deleted',
    });
  });

  it('summarises each kind from the fields that kind actually has', () => {
    expect(feedEntrySummary(feedEntry())).toBe('created — Issue 4');
    expect(feedEntrySummary(feedEntry({ kind: 'issue-closed', state: 'closed' }))).toBe('closed — Issue 4');
    expect(feedEntrySummary(feedEntry({ kind: 'issue-reopened' }))).toBe('reopened — Issue 4');
    expect(feedEntrySummary(feedEntry({ kind: 'issue-edited' }))).toBe('edited — Issue 4');
    expect(feedEntrySummary(feedEntry({ kind: 'issue-deleted' }))).toBe('deleted — Issue 4');
    // The author and the body are the comment payload's, and are read only
    // there: no other kind carries them, and none is invented for one.
    expect(feedEntrySummary(feedEntry({ kind: 'comment-added', author: 'Lubko', body: 'on it' }))).toBe('commented by Lubko: on it');
    expect(feedEntrySummary(feedEntry({
      kind: 'comment-added',
      author: undefined as unknown as null,
      body: undefined as unknown as null,
    }))).toBe('commented — Issue 4');
  });

  it('reports the issues the log never named, and only those', () => {
    expect(untrackedIssueNumbers([issue(1), issue(2)], [feedEntry({ issueNumber: 2 })])).toEqual([1]);
    expect(untrackedIssueNumbers([issue(1)], [feedEntry({ issueNumber: 1 })])).toEqual([]);
    // A deleted issue is one the log did record, at its deletion.
    expect(untrackedIssueNumbers([], [feedEntry({ kind: 'issue-deleted', issueNumber: 9 })])).toEqual([]);
    expect(untrackedIssueNumbers([issue(2), issue(1)], [])).toEqual([1, 2]);
  });

  it('says the predates-the-log caveat in terms of the issues it cannot place', () => {
    expect(FEED_TRUNCATED_COPY([1])).toContain('#1');
    expect(FEED_TRUNCATED_COPY([1, 2])).toContain('#1, #2');
    expect(FEED_TRUNCATED_COPY([1])).toContain('already on the board when the materialized feed began');
    // The sentence names the exhaustion it depends on, so it cannot be quoted
    // as a claim made from a partial walk.
    expect(FEED_TRUNCATED_COPY([1])).toContain('read the whole feed');
  });

  it('makes the claim only once the whole log is in hand', () => {
    const sixty = Array.from({ length: 60 }, (_, index) => issue(index + 1));
    const firstFifty = Array.from({ length: 50 }, (_, index) => feedEntry({ issueNumber: 50 - index }));

    // The set difference itself still holds: the first page mentions 50 issues.
    expect(untrackedIssueNumbers(sixty, firstFifty)).toHaveLength(10);
    // A token outstanding means the walk is unfinished, so the claim is withheld
    // even though the difference is ten issues long.
    expect(unplacedIssueNumbers(sixty, firstFifty, 'v1.more', 55)).toEqual([]);
    // And a walk that came up short against the total the page reported is no
    // more complete than one with a token left.
    expect(unplacedIssueNumbers(sixty, firstFifty, null, 55)).toEqual([]);
    // Only with no token and every counted entry held does the difference
    // become a fact about the log.
    expect(unplacedIssueNumbers(sixty, firstFifty, null, 50)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(unplacedIssueNumbers([issue(1)], [feedEntry({ issueNumber: 1 })], null, 1)).toEqual([]);
  });

  it('names the two kinds the board does not record, without implying a row for them', () => {
    expect(FEED_UNTRACKED_COPY).toContain('edits to messages');
    expect(FEED_UNTRACKED_COPY).toContain('which field an issue edit changed');
  });
});
