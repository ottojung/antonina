import { describe, expect, it } from 'vitest';
import { BoardDeletedError, BoardTrustRequiredError } from './api';
import { emptyBoard, type Board, type BoardIssue, type VerifiedBoardState } from './model';
import {
  accessCallout,
  boardAccess,
  boardDeleted,
  boardLoadFailed,
  boardLoaded,
  COMPOSER_READ_ONLY_CALLOUT,
  DELETED_COPY,
  emptyIssueList,
  filterLabel,
  firstRunResolved,
  firstRunUnresolved,
  formatUpdatedAt,
  groupResources,
  ISSUE_FORM_HINT,
  ISSUE_FORM_SUBMIT_HINT,
  issueCounts,
  loadedBoard,
  moveQueueEarlier,
  moveQueueIssue,
  moveQueueLater,
  canMoveInQueue,
  closedIssueOrder,
  openQueueOrder,
  priorityLabel,
  QUEUE_HINT,
  QUEUE_MOVE_LABELS,
  QUEUE_REORDERED_NOTICE,
  WRITE_ACCESS_SUMMARY,
  queuePosition,
  REJECTED_CREDENTIAL_COPY,
  trustRequired,
  visibleIssues,
  TRUST_COPY,
  READ_ONLY_CALLOUT,
  type BoardLoad,
} from './ui-state';

const timestamp = '2026-09-24T12:00:00.000Z';
function issue(number: number, state: 'open' | 'closed', updatedAt = timestamp): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: updatedAt, updatedAt, messages: [] };
}
function state(overrides: Partial<VerifiedBoardState> = {}): VerifiedBoardState {
  return { board: emptyBoard(), queue: [], authorities: [], deleted: false, head: 'head', ...overrides };
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

  it('keeps every open issue exactly once whatever the queue contains', () => {
    const issues = [issue(1, 'open'), issue(2, 'open'), issue(3, 'open')];
    for (const queue of [[], [1], [3, 1], [1, 1, 2, 2, 3], [2, 2], [9, 1], [1, 2, 3, 3, 4]]) {
      const order = openQueueOrder(issues, queue);
      expect([...order].sort((left, right) => left - right)).toEqual([1, 2, 3]);
    }
  });

  it('drops queue entries with no open issue and appends ones the queue missed', () => {
    const issues = [issue(1, 'open'), issue(2, 'open'), issue(3, 'closed')];
    expect(openQueueOrder(issues, [3, 2, 1])).toEqual([2, 1]);
    expect(openQueueOrder(issues, [2])).toEqual([2, 1]);
    expect(openQueueOrder(issues, [])).toEqual([1, 2]);
  });

  it('lists closed issues outside the queue, oldest first, under every filter', () => {
    const issues = [issue(1, 'open'), issue(4, 'closed', '2026-09-24T23:00:00.000Z'), issue(2, 'open'), issue(3, 'closed')];
    expect(visibleIssues(issues, [2, 1], 'closed').map((entry) => entry.number)).toEqual([3, 4]);
    expect(visibleIssues(issues, [2, 1], 'all').map((entry) => entry.number)).toEqual([2, 1, 3, 4]);
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

  it('names priority as part of what write access allows, and says the order is shared', () => {
    expect(WRITE_ACCESS_SUMMARY).toContain('priority order');
    expect(WRITE_ACCESS_SUMMARY).toContain('status');
    expect(QUEUE_HINT).toContain('shared priority order');
  });

  it('names both move directions for the accessible, non-drag controls', () => {
    expect(QUEUE_MOVE_LABELS.earlier).toBe('Move earlier in the priority queue');
    expect(QUEUE_MOVE_LABELS.later).toBe('Move later in the priority queue');
    expect(QUEUE_REORDERED_NOTICE).toContain('everyone');
  });

  it('explains the create form and advertises its shortcut without a second hint', () => {
    expect(ISSUE_FORM_HINT).toBe('The description holds the task context; the conversation holds updates and questions.');
    expect(ISSUE_FORM_HINT).not.toContain('Ctrl');
    expect(ISSUE_FORM_SUBMIT_HINT).toBe('Ctrl+Enter creates the issue from the description.');
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

    expect(COMPOSER_READ_ONLY_CALLOUT.title).toBe('Want to join the conversation?');
    expect(REJECTED_CREDENTIAL_COPY.body).not.toBe(READ_ONLY_CALLOUT.body);
    expect(REJECTED_CREDENTIAL_COPY.body).not.toBe(COMPOSER_READ_ONLY_CALLOUT.body);
    expect(REJECTED_CREDENTIAL_COPY.action).not.toBe(READ_ONLY_CALLOUT.action);
  });
});

describe('board load state', () => {
  const board: Board = { ...emptyBoard(), nextIssueNumber: 2, issues: [issue(1, 'open')] };
  const verified = state({ board, queue: [1] });

  it('resolves a read to the first-run state while the board is missing', () => {
    expect(boardLoaded(null)).toEqual({ status: 'uninitialized' });
    expect(boardLoaded(verified)).toEqual({ status: 'ready', board, queue: [1] });
  });

  it('turns a failed initialization whose board now exists into a read-only board', () => {
    const resolved = firstRunResolved(boardLoaded(verified), new Error('The Antonina board already exists'));
    expect(resolved.load).toEqual({ status: 'ready', board, queue: [1] });
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

  it('explains that the trust anchor is public and only unlocks reading', () => {
    expect(TRUST_COPY.action).toBe('Trust this board');
    expect(TRUST_COPY.body).toContain('public trust anchor');
  });

  it('keeps the last good board when a later read fails', () => {
    const ready: BoardLoad = { status: 'ready', board, queue: [1] };
    expect(boardLoadFailed(ready, 'Skrynia GET failed (503)')).toBe(ready);
    expect(loadedBoard(boardLoadFailed(ready, 'Skrynia GET failed (503)'))).toBe(board);
  });

  it('fails terminally only while no board has ever loaded', () => {
    expect(boardLoadFailed({ status: 'loading' }, 'boom')).toEqual({ status: 'failed', message: 'boom' });
    expect(boardLoadFailed({ status: 'uninitialized' }, 'boom')).toEqual({ status: 'failed', message: 'boom' });
    expect(boardLoadFailed({ status: 'failed', message: 'old' }, 'new')).toEqual({ status: 'failed', message: 'new' });
    expect(loadedBoard({ status: 'failed', message: 'boom' })).toBeUndefined();
  });
});
