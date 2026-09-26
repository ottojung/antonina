import { describe, expect, it } from 'vitest';
import { BoardDeletedError, BoardTrustRequiredError } from './api';
import { emptyBoard, type Board, type BoardIssue } from './model';
import {
  boardDeleted,
  boardLoadFailed,
  boardLoaded,
  DELETED_COPY,
  emptyIssueList,
  filterLabel,
  firstRunResolved,
  firstRunUnresolved,
  formatUpdatedAt,
  groupResources,
  issueCounts,
  loadedBoard,
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

describe('issue UI state', () => {
  it('filters and sorts issues by most recently updated', () => {
    const issues = [issue(1, 'open', '2026-09-24T10:00:00.000Z'), issue(2, 'closed'), issue(3, 'open')];
    expect(visibleIssues(issues, 'open').map((entry) => entry.number)).toEqual([3, 1]);
    expect(visibleIssues(issues, 'closed').map((entry) => entry.number)).toEqual([2]);
    expect(visibleIssues(issues, 'all').map((entry) => entry.number)).toEqual([3, 2, 1]);
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

  it('keeps empty-state copy distinct from the read-only access callout', () => {
    expect(emptyIssueList('all', false).body).not.toBe(READ_ONLY_CALLOUT.body);
    expect(emptyIssueList('all', true).body).not.toBe(READ_ONLY_CALLOUT.body);
  });
});

describe('board load state', () => {
  const board: Board = { ...emptyBoard(), nextIssueNumber: 2, issues: [issue(1, 'open')] };

  it('resolves a read to the first-run state while the board is missing', () => {
    expect(boardLoaded(null)).toEqual({ status: 'uninitialized' });
    expect(boardLoaded(board)).toEqual({ status: 'ready', board });
  });

  it('turns a failed initialization whose board now exists into a read-only board', () => {
    const resolved = firstRunResolved(boardLoaded(board), new Error('The Antonina board already exists'));
    expect(resolved.load).toEqual({ status: 'ready', board });
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
    const cause = new BoardDeletedError('Antonina board has been deleted');
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
    const ready: BoardLoad = { status: 'ready', board };
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
