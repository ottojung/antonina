import { BoardDeletedError, BoardTrustRequiredError } from './api';
import type { Board, BoardIssue, BoardResource, VerifiedBoardState } from './model';

export type IssueFilter = 'open' | 'closed' | 'all';

/**
 * A loaded board carries its shared priority order beside it. There is no
 * status here without a queue: a board whose order has not been read is a
 * `failed` load, never a list quietly sorted some other way.
 */
export type BoardLoad =
  | { status: 'loading' }
  | { status: 'uninitialized' }
  | { status: 'untrusted' }
  | { status: 'deleted' }
  | { status: 'ready'; board: Board; queue: number[] }
  | { status: 'failed'; message: string };

export const FIRST_RUN_COPY = {
  title: 'No Antonina board yet',
  body: 'Initializing the board makes this browser its first editor and stores the board’s root signing credential in this browser. Copy that credential and the board’s public trust anchor from Settings and share them with the other browsers and agents that need to read or edit the board.',
  action: 'Initialize board',
  recheck: 'Check again',
  raced: 'Another browser initialized the board first; this browser is read-only.',
  initialized: 'Board initialized; this browser holds the root signing credential',
  readFailed: 'The board was created but could not be read back',
} as const;

export const TRUST_COPY = {
  title: 'This board needs its trust anchor',
  body: 'The signed board already exists, and this browser cannot verify its history without the board’s public trust anchor. Paste the anchor to read the board read-only; editing still needs a credential.',
  action: 'Trust this board',
  hint: 'The trust anchor is public and comes from the browser or agent that initialized the board.',
} as const;

export const DELETED_COPY = {
  title: 'This board was deleted',
  body: 'The board was deleted on purpose, and its key can never be initialized again. Start from a board that still exists, or ask the people who shared this one what to use instead.',
} as const;

export type AccessCallout = { title: string; body: string; action: string };

export type ReadOnlyAccess = 'read-only' | 'rejected';

export type BoardAccess = 'editable' | ReadOnlyAccess;

export const READ_ONLY_CALLOUT = {
  title: 'Read-only board',
  body: 'You can read every issue and resource. Enable editing in this browser to make changes.',
  action: 'Enable editing',
} as const;

export const COMPOSER_READ_ONLY_CALLOUT = {
  title: 'Want to join the conversation?',
  body: 'Enable editing in this browser to make changes.',
  action: 'Enable editing',
} as const;

export const REJECTED_CREDENTIAL_COPY = {
  title: 'This board rejected the credential in this browser',
  body: 'The board credential stored in this browser was rejected, so the board is read-only. Paste a fresh credential that this board still accepts.',
  action: 'Paste a fresh credential',
} as const;

export const ISSUE_FORM_HINT = 'The description holds the task context; the conversation holds updates and questions.';

export const ISSUE_FORM_SUBMIT_HINT = 'Ctrl+Enter creates the issue from the description.';

export const WRITE_ACCESS_SUMMARY = 'Write access allows issue, description, dependency, status, and priority order changes.';

export const QUEUE_HINT = 'Issues are listed in the board’s shared priority order. Select an issue to place it at any position in one commit.';

export const QUEUE_MOVE_LABELS: Record<QueueDirection, string> = {
  earlier: 'Move one place earlier in the priority queue',
  later: 'Move one place later in the priority queue',
};

/** The named alternative to stepping: choose any position in the queue in one commit. */
export const QUEUE_MOVE_TO_LABEL = 'Move to a chosen position in the priority queue';

export const QUEUE_REORDERED_NOTICE = 'Priority order saved for everyone on this board';

export const QUEUE_REORDER_FAILED = 'The priority order could not be saved';

/** The drag payload the issue rows carry between themselves. */
export const QUEUE_DRAG_TYPE = 'text/plain';

/** A stored credential the board refused is its own state, not a browser holding none. */
export function boardAccess(hasWriteAccess: boolean, credentialRejected: boolean): BoardAccess {
  if (hasWriteAccess) return 'editable';
  return credentialRejected ? 'rejected' : 'read-only';
}

export function accessCallout(access: ReadOnlyAccess, readOnly?: AccessCallout): AccessCallout;
export function accessCallout(access: BoardAccess, readOnly?: AccessCallout): AccessCallout | null;
export function accessCallout(access: BoardAccess, readOnly: AccessCallout = READ_ONLY_CALLOUT): AccessCallout | null {
  if (access === 'editable') return null;
  return access === 'rejected' ? REJECTED_CREDENTIAL_COPY : readOnly;
}

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

export function boardLoaded(state: VerifiedBoardState | null): BoardLoad {
  return state ? { status: 'ready', board: state.board, queue: state.queue } : { status: 'uninitialized' };
}

/**
 * One verified read, one outcome, for every path that turns a verified state
 * into a load. A read that found no board has not loaded one, so it is a
 * failure and not a success with nothing behind it: the trust path and the
 * first-run path both say so here, so neither has an inline check of its own.
 */
export function boardReadOutcome(state: VerifiedBoardState | null): { load: BoardLoad; error?: string } {
  return state ? { load: boardLoaded(state) } : { load: { status: 'failed', message: FIRST_RUN_COPY.readFailed }, error: FIRST_RUN_COPY.readFailed };
}

export function boardLoadFailed(load: BoardLoad, message: string): BoardLoad {
  return loadedBoard(load) ? load : { status: 'failed', message };
}

export function trustRequired(cause: unknown): boolean {
  return cause instanceof BoardTrustRequiredError;
}

/** A deleted board is terminal: retrying can never bring it back. */
export function boardDeleted(cause: unknown): boolean {
  return cause instanceof BoardDeletedError;
}
export function firstRunResolved(load: BoardLoad, cause: unknown): { load: BoardLoad; error?: string } {
  if (load.status === 'ready') return { load };
  return { load, error: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * Classifies a failed first-run read by cause: a board that appeared under this
 * browser now needs its trust anchor, and any other failure is reported as the
 * read failure it is instead of being passed off as a missing board.
 */
export function firstRunUnresolved(cause: unknown): BoardLoad {
  if (trustRequired(cause)) return { status: 'untrusted' };
  if (boardDeleted(cause)) return { status: 'deleted' };
  return { status: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
}

/** What a verified read of the board is: the state it read, or the reason it failed. */
export type BoardRead = { state: VerifiedBoardState | null } | { failure: unknown };

/** What a first run leaves on screen: one load, and at most one outcome. */
export interface FirstRunOutcome {
  load: BoardLoad;
  error?: string;
  notice?: string;
}

/**
 * The whole first-run decision in one place, so its four outcomes cannot drift
 * apart.
 *
 * A board this browser created is the state the create itself verified: the
 * load is that state and only that, so a create that yields no state is the
 * read failure it is, never a success with nothing behind it. A create that
 * delivered no state — it was refused, or the read that settles it threw — is
 * reported by the read that follows: a board that is there now was created by
 * someone else, so this browser is read-only with no error, and anything else
 * is reported as itself with its own reason.
 */
export function firstRunOutcome(created: BoardRead, afterRefusal?: BoardRead): FirstRunOutcome {
  if ('state' in created) {
    const read = boardReadOutcome(created.state);
    return read.error ? read : { ...read, notice: FIRST_RUN_COPY.initialized };
  }
  const read = afterRefusal ?? { failure: created.failure };
  const load = 'state' in read ? boardLoaded(read.state) : firstRunUnresolved(read.failure);
  const resolved = firstRunResolved(load, created.failure);
  return resolved.error ? resolved : { load: resolved.load, notice: FIRST_RUN_COPY.raced };
}

/**
 * The open issues' numbers in the board's shared priority order.
 *
 * The queue is the only ordering concept in this app, and a queue the board
 * could commit is every open issue exactly once — `exactOpenIssueQueue` in
 * `packages/core/src/operations.ts` rejects anything else, and
 * `docs/intent-records/board.md` records it as a board invariant. So this is
 * one walk of the committed queue with the closed issues filtered out: the
 * result is the board's order, never one the browser invented. There is no
 * other order to fall back to, so nothing is sorted or appended here.
 */
export function openQueueOrder(issues: BoardIssue[], queue: number[]): number[] {
  const open = new Set(issues.filter((issue) => issue.state === 'open').map((issue) => issue.number));
  return queue.filter((number) => open.has(number));
}

/**
 * Closed issues. The queue holds open issues by construction, so a closed
 * issue has no priority position to take and is listed in ascending issue
 * number: oldest closed work first, a stable order that does not shuffle as
 * timestamps move.
 */
export function closedIssueOrder(issues: BoardIssue[]): number[] {
  return issues.filter((issue) => issue.state === 'closed').map((issue) => issue.number).sort((left, right) => left - right);
}

/**
 * The issues a filter shows. `open` is the shared queue, `closed` is the
 * unqueued tail, and `all` is the queue first with the closed tail after it, so
 * the open work a reader came for is always at the top in priority order.
 */
export function visibleIssues(issues: BoardIssue[], queue: number[], filter: IssueFilter): BoardIssue[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const open = openQueueOrder(issues, queue).map((number) => byNumber.get(number)!);
  if (filter === 'open') return open;
  const closed = closedIssueOrder(issues).map((number) => byNumber.get(number)!);
  return filter === 'closed' ? closed : [...open, ...closed];
}

/**
 * Moves one queued issue to another slot, returning the whole reordered queue.
 * A commit is only accepted when it names every open issue exactly once, so a
 * move sends the entire list, never the pair it swapped. `null` means the board
 * would not change: an issue that is not queued, a slot outside the queue, or a
 * move to the position the issue already holds — which is how "earlier" at the
 * head and "later" at the tail become no-ops instead of rejected writes.
 */
export function moveQueueIssue(order: number[], number: number, to: number): number[] | null {
  const from = order.indexOf(number);
  if (from === -1 || !Number.isInteger(to) || to < 0 || to >= order.length || to === from) return null;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, number);
  return next;
}

export type QueueDirection = 'earlier' | 'later';

export function moveQueueEarlier(order: number[], number: number): number[] | null {
  const from = order.indexOf(number);
  return from > 0 ? moveQueueIssue(order, number, from - 1) : null;
}

export function moveQueueLater(order: number[], number: number): number[] | null {
  const from = order.indexOf(number);
  return from !== -1 ? moveQueueIssue(order, number, from + 1) : null;
}

/** Whether a move control has anywhere to move to, so a boundary press is offered as a no-op. */
export function canMoveInQueue(order: number[], number: number, direction: QueueDirection): boolean {
  return (direction === 'earlier' ? moveQueueEarlier(order, number) : moveQueueLater(order, number)) !== null;
}

/** The one-based slots a move-to control offers: every position the queue has. */
export function queueSlots(order: number[]): number[] {
  return order.map((_, index) => index + 1);
}

/**
 * Moves an issue to a chosen position, the one-based number a move-to control
 * names. It is `moveQueueIssue` and nothing else: the same whole-queue
 * permutation the step controls and a drop commit, so a keyboard user places an
 * issue exactly as a drag would.
 */
export function moveQueueTo(order: number[], number: number, to: number): number[] | null {
  return moveQueueIssue(order, number, to - 1);
}

/**
 * The accessible name of the selected row's move-to control: which issue it
 * places, and that the option numbers are the queue's one-based positions.
 * The control is offered on the selected row alone — a select per row would be
 * one option per slot per row — so its name has to carry the whole instruction.
 */
export function queueMoveToLabel(number: number, slots: number): string {
  return `${QUEUE_MOVE_TO_LABEL}: #${number} (positions run from 1 to ${slots})`;
}

/** The one-based position an issue holds in the shared queue, or 0 when unqueued. */
export function queuePosition(order: number[], number: number): number {
  const index = order.indexOf(number);
  return index === -1 ? 0 : index + 1;
}

export function priorityLabel(position: number): string {
  return position > 0 ? `Priority ${position}` : 'Not in the queue';
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
