import { BoardTrustRequiredError } from './api';
import type { Board, BoardIssue, BoardResource } from './model';

export type IssueFilter = 'open' | 'closed' | 'all';

export type BoardLoad =
  | { status: 'loading' }
  | { status: 'uninitialized' }
  | { status: 'untrusted' }
  | { status: 'ready'; board: Board }
  | { status: 'failed'; message: string };

export const FIRST_RUN_COPY = {
  title: 'No Antonina board yet',
  body: 'Initializing the board makes this browser its first editor and stores the board’s root signing credential in this browser. Copy that credential and the board’s public trust anchor from Settings and share them with the other browsers and agents that need to read or edit the board.',
  action: 'Initialize board',
  recheck: 'Check again',
  raced: 'Another browser initialized the board first; this browser is read-only.',
} as const;

export const TRUST_COPY = {
  title: 'This board needs its trust anchor',
  body: 'The signed board already exists, and this browser cannot verify its history without the board’s public trust anchor. Paste the anchor to read the board read-only; editing still needs a credential.',
  action: 'Trust this board',
  hint: 'The trust anchor is public and comes from the browser or agent that initialized the board.',
} as const;

export const ISSUE_FORM_HINT = 'The description holds the task context; the conversation holds updates and questions.';

export const READ_ONLY_CALLOUT = {
  title: 'Read-only board',
  body: 'You can read every issue and resource. Enable editing in this browser to make changes.',
} as const;

const FILTER_LABELS: Record<IssueFilter, string> = { open: 'Open', closed: 'Closed', all: 'All' };

export function filterLabel(filter: IssueFilter): string {
  return FILTER_LABELS[filter];
}

export function emptyIssueList(filter: IssueFilter, hasWriteAccess: boolean): { title: string; body: string } {
  return {
    title: filter === 'all' ? 'No issues' : `No ${FILTER_LABELS[filter].toLowerCase()} issues`,
    body: hasWriteAccess
      ? 'Create an issue to give the work a shared record.'
      : 'No issues match this filter yet.',
  };
}

export function loadedBoard(load: BoardLoad): Board | undefined {
  return load.status === 'ready' ? load.board : undefined;
}

export function boardLoaded(board: Board | null): BoardLoad {
  return board ? { status: 'ready', board } : { status: 'uninitialized' };
}

export function boardLoadFailed(load: BoardLoad, message: string): BoardLoad {
  return loadedBoard(load) ? load : { status: 'failed', message };
}

export function trustRequired(cause: unknown): boolean {
  return cause instanceof BoardTrustRequiredError;
}
export function firstRunResolved(load: BoardLoad, cause: unknown): { load: BoardLoad; error?: string } {
  if (load.status === 'ready') return { load };
  return { load, error: cause instanceof Error ? cause.message : String(cause) };
}

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
