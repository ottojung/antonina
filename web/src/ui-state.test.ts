import { describe, expect, it } from 'vitest';
import type { BoardIssue } from './model';
import { formatUpdatedAt, groupResources, issueCounts, visibleIssues } from './ui-state';

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
