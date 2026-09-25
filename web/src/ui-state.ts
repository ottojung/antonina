import type { BoardIssue, BoardResource } from './model';

export type IssueFilter = 'open' | 'closed' | 'all';

export function visibleIssues(issues: BoardIssue[], filter: IssueFilter): BoardIssue[] {
  return issues
    .filter((issue) => filter === 'all' || issue.state === filter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.number - left.number);
}

export function issueCounts(issues: BoardIssue[]): Record<IssueFilter, number> {
  const open = issues.filter((issue) => issue.state === 'open').length;
  const closed = issues.length - open;
  return { open, closed, all: issues.length };
}

export function groupResources(resources: BoardResource[]): Array<[string, BoardResource[]]> {
  const groups = new Map<string, BoardResource[]>();
  for (const resource of resources) groups.set(resource.host, [...(groups.get(resource.host) ?? []), resource]);
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, entries]) => [host, entries.sort((left, right) => left.path.localeCompare(right.path))]);
}

export function formatUpdatedAt(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return 'just now';
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed >= 0 && elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
