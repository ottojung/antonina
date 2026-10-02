import { BoardDeletedError, BoardTrustRequiredError, DEFAULT_FEED_LIMIT } from './api';
import type {
  BoardFeedEntry,
  BoardFeedEntryKind,
  BoardFeedPage,
  BoardFeedRequest,
  BoardOverview,
  FeedRead,
  IssueListSummary,
} from './api';
import type { BoardIssue, BoardResource, VerifiedBoardState } from './model';

export type IssueFilter = 'open' | 'closed' | 'all';

/**
 * A loaded board carries its shared priority order beside it. There is no
 * status here without a queue: a board whose order has not been read is a
 * `failed` load, never a list quietly sorted some other way.
 */
export type BoardSummary = Pick<BoardOverview, 'issues' | 'resources' | 'targets' | 'dispatches'>;

export type BoardLoad =
  | { status: 'loading' }
  | { status: 'uninitialized' }
  | { status: 'untrusted' }
  | { status: 'deleted' }
  | { status: 'ready'; board: BoardSummary; queue: number[]; head: string }
  | { status: 'failed'; message: string };

export const FIRST_RUN_COPY = {
  title: 'No Antonina board yet',
  body: 'Initializing the board creates its shared board credential and stores it in this browser. Copy that credential from Settings and share it only with browsers and agents that should have full board access.',
  action: 'Initialize board',
  recheck: 'Check again',
  raced: 'Another browser initialized the board first; enter its board credential to continue.',
  initialized: 'Board initialized; this browser holds the board credential',
  readFailed: 'The board was created but could not be read back',
} as const;

export const BOARD_KEY_COPY = {
  title: 'Enter the board credential',
  body: 'This Antonina board is private to people who have its shared credential. The credential grants full read and write access.',
  action: 'Open board',
  hint: 'Paste the full Antonina board credential JSON shared by another browser or agent.',
} as const;

export const DELETED_COPY = {
  title: 'This board was deleted',
  body: 'The board was deleted on purpose, and its key can never be initialized again. Start from a board that still exists, or ask the people who shared this one what to use instead.',
} as const;

export type AccessCallout = { title: string; body: string; action: string };

export type ReadOnlyAccess = 'read-only' | 'rejected';

export type BoardAccess = 'editable' | ReadOnlyAccess;

export const READ_ONLY_CALLOUT = {
  title: 'Board credential required',
  body: 'Enter the board credential to access this board.',
  action: 'Enter credential',
} as const;

export const COMPOSER_READ_ONLY_CALLOUT = {
  title: 'Board credential required',
  body: 'Enter the board credential to access this board.',
  action: 'Enter credential',
} as const;

export const REJECTED_CREDENTIAL_COPY = {
  title: 'This board rejected the credential in this browser',
  body: 'The board credential stored in this browser was rejected. Paste a valid credential to access the board.',
  action: 'Paste a valid credential',
} as const;

export const ISSUE_FORM_HINT = 'The description holds the task context; the conversation holds updates and questions.';

export const ISSUE_FORM_SUBMIT_HINT = 'Ctrl+Enter or Cmd+Enter creates the issue from the description.';

/**
 * Advertised next to the composer's own submit button, so the shortcut is
 * discoverable where the alternative to it sits.
 */
export const COMPOSER_SUBMIT_HINT = 'Ctrl+Enter or Cmd+Enter posts this message.';

export const WRITE_ACCESS_SUMMARY = 'The board credential grants full read and write access to Antonina.';

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

export function loadedBoard(load: BoardLoad): BoardSummary | undefined {
  return load.status === 'ready' ? load.board : undefined;
}

function summarizeIssue(issue: BoardIssue): IssueListSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    messageCount: issue.messages.length,
    hasBody: issue.body.length > 0,
  };
}

export function boardLoaded(state: VerifiedBoardState | null): BoardLoad {
  if (state === null) return { status: 'uninitialized' };
  return {
    status: 'ready',
    board: {
      issues: state.board.issues.map(summarizeIssue),
      resources: state.board.resources,
      targets: state.board.targets,
      dispatches: state.board.dispatches,
    },
    queue: state.queue,
    head: state.head,
  };
}

export function overviewLoaded(overview: BoardOverview | null): BoardLoad {
  if (overview === null) return { status: 'uninitialized' };
  return {
    status: 'ready',
    board: {
      issues: overview.issues,
      resources: overview.resources,
      targets: overview.targets,
      dispatches: overview.dispatches,
    },
    queue: overview.queue,
    head: overview.head,
  };
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
export function openQueueOrder<T extends Pick<BoardIssue, 'number' | 'state'>>(issues: readonly T[], queue: readonly number[]): number[] {
  const open = new Set(issues.filter((issue) => issue.state === 'open').map((issue) => issue.number));
  return queue.filter((number) => open.has(number));
}

/**
 * Closed issues. The queue holds open issues by construction, so a closed
 * issue has no priority position to take and is listed in ascending issue
 * number: oldest closed work first, a stable order that does not shuffle as
 * timestamps move.
 */
export function closedIssueOrder<T extends Pick<BoardIssue, 'number' | 'state'>>(issues: readonly T[]): number[] {
  return issues.filter((issue) => issue.state === 'closed').map((issue) => issue.number).sort((left, right) => left - right);
}

/**
 * The issues a filter shows. `open` is the shared queue, `closed` is the
 * unqueued tail, and `all` is the queue first with the closed tail after it, so
 * the open work a reader came for is always at the top in priority order.
 */
export function visibleIssues<T extends Pick<BoardIssue, 'number' | 'state'>>(issues: readonly T[], queue: readonly number[], filter: IssueFilter): T[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const open = openQueueOrder(issues, queue).map((number) => byNumber.get(number)!);
  if (filter === 'open') return open;
  const closed = closedIssueOrder(issues).map((number) => byNumber.get(number)!);
  return filter === 'closed' ? closed : [...open, ...closed];
}

/**
 * How many issues one page of the Issues list holds.
 *
 * 50 is the number the board's own storage and feed pages use, so the browser's
 * page and the paged records behind it agree on a chunk rather than the list
 * inventing a second one. It is a default argument throughout, never a number
 * repeated at a call site.
 */
export const ISSUE_PAGE_SIZE = 50;

/**
 * How many pages a list of `total` issues occupies: one page for an empty list,
 * because "page 1 of 1" is the only page there is and not a division by zero.
 */
export function issuePageCount(total: number, pageSize = ISSUE_PAGE_SIZE): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/**
 * The page the list may actually be showing, given the page that was asked for.
 *
 * This is the whole clamping rule, and it is deliberately the simplest one that
 * satisfies every case the list has to survive: the requested page is preserved
 * whenever a page of that number still exists, and clamped to the last existing
 * page otherwise. Nothing here knows what caused the change, so a create, a
 * close, a reopen, a delete, a reorder, a filter change and a periodic board
 * re-read are all the same event — the list got shorter or longer — and all get
 * the same answer.
 *
 * The consequence worth stating: a reader on page 3 of 3 who closes the top
 * issue stays on the last page rather than being thrown back to page 1, and a
 * reader who opens an issue and comes back finds the same page unless it no
 * longer exists. A page is never reset to 1 by a mutation; only an out-of-range
 * index moves, and it only ever moves down.
 */
export function clampIssuePage(page: number, total: number, pageSize = ISSUE_PAGE_SIZE): number {
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, issuePageCount(total, pageSize));
}

/**
 * The one page of an already-ordered list, clamped the same way. Pagination is a
 * slice of the semantic order `visibleIssues` produced and never a second sort:
 * open issues stay in the board's queue order, closed issues keep their stable
 * order, and `all` is still open-first. Only the window onto that order moves.
 */
export function issuePage<T>(items: readonly T[], page: number, pageSize = ISSUE_PAGE_SIZE): T[] {
  const index = clampIssuePage(page, items.length, pageSize);
  return items.slice((index - 1) * pageSize, index * pageSize);
}

/**
 * The position line: which issues are on screen out of how many the filter
 * matched. An empty list says so in its own words rather than claiming a range
 * it has none of.
 */
export function issuePageRange(total: number, page: number, pageSize = ISSUE_PAGE_SIZE): string {
  if (total <= 0) return 'No issues';
  const index = clampIssuePage(page, total, pageSize);
  const from = (index - 1) * pageSize + 1;
  return `${from}–${Math.min(from + pageSize - 1, total)} of ${total}`;
}

/** Whether there is more than one page at all, so a short list is never given dead controls. */
export function hasIssuePages(total: number, pageSize = ISSUE_PAGE_SIZE): boolean {
  return issuePageCount(total, pageSize) > 1;
}

export const ISSUE_PAGE_PREVIOUS = 'Previous page';

export const ISSUE_PAGE_NEXT = 'Next page';

/**
 * How many comments one page of a conversation holds.
 *
 * 50 for the same reason `ISSUE_PAGE_SIZE` is 50, and it is the number the
 * board's comment shards already use, so a page in the browser is exactly one
 * shard on the wire and the two cannot drift into a page that straddles two.
 */
export const COMMENT_PAGE_SIZE = 50;

/**
 * The conversation's paging, as the same model the Issues list uses.
 *
 * These are the helpers above applied to a message count rather than an issue
 * count, with the comment page size. They are not a second implementation: the
 * count, the clamp, the range line and the "is there more than one page"
 * question are all answered by `issuePageCount`, `clampIssuePage`,
 * `issuePageRange` and `hasIssuePages`, so the Issues list and an issue's
 * conversation cannot disagree about what a page number means or what happens
 * to one that no longer exists.
 */
export function commentPageCount(total: number, pageSize = COMMENT_PAGE_SIZE): number {
  return issuePageCount(total, pageSize);
}

/**
 * The page a conversation may actually be showing, given the page that was asked
 * for. Out of range moves down onto the last existing page, exactly as
 * `clampIssuePage` does for the list, so a post that made the thread longer and
 * a delete that made it shorter are both the same event to a reader: the list
 * got longer or shorter.
 */
export function clampCommentPage(page: number, total: number, pageSize = COMMENT_PAGE_SIZE): number {
  return clampIssuePage(page, total, pageSize);
}

/** Which comments are on screen out of how many the thread holds. */
export function commentPageRange(total: number, page: number, pageSize = COMMENT_PAGE_SIZE): string {
  return issuePageRange(total, page, pageSize);
}

/** Whether the conversation is long enough to be worth paging at all. */
export function hasCommentPages(total: number, pageSize = COMMENT_PAGE_SIZE): boolean {
  return hasIssuePages(total, pageSize);
}

/** The page after a post, which is where a newly written comment lands. */
export function lastCommentPage(total: number, pageSize = COMMENT_PAGE_SIZE): number {
  return commentPageCount(total, pageSize);
}

/** What a conversation's Previous/Next control announces itself as paging. */
export const COMMENT_PAGES_LABEL = 'Issue conversation pages';

/** What the Issues list's own Previous/Next control announces itself as paging. */
export const ISSUE_LIST_PAGES_LABEL = 'Issue list pages';

/**
 * How many resources one page of the Resources view holds.
 *
 * 50 for the same reason `ISSUE_PAGE_SIZE` and `COMMENT_PAGE_SIZE` are 50: it is
 * the page size `packages/core` already uses for board collections
 * (`DEFAULT_COLLECTION_PAGE_SIZE`, which `board resource list --page` slices
 * with), so the browser's page and the CLI's page are the same chunk and cannot
 * drift apart into two different definitions of a page.
 *
 * What this paging is, precisely: a window onto what the browser already holds.
 * It is NOT a bounded read, and it does not make one. The board's resources are
 * not paged in storage — they live inline in the board's single catalog shard,
 * which `BoardStore.readOverview` returns whole and which
 * `BoardApi.listResources` in `packages/core/src/api.ts` also reads whole via
 * `loadBoard()` before `resourceViews` filters it. So
 * `antonina board resource list --page N` slices after fetching everything, and
 * this view slices after an overview that already carried everything. What that
 * buys is 50 rendered cards instead of all of them, and a page number in the
 * URL; what it does not buy is fewer bytes. A true bounded read needs the
 * catalog itself sharded into resource pages — a storage-format change, not a UI
 * change, and deliberately out of scope here.
 */
export const RESOURCE_PAGE_SIZE = 50;

/**
 * The Resources view's paging, as the same model the Issues list and an issue's
 * conversation already use.
 *
 * Exactly as the comment helpers above: `RESOURCE_PAGE_SIZE` is the argument and
 * the count, the clamp, the range line and the "is there more than one page"
 * question are all answered by `issuePageCount`, `clampIssuePage`,
 * `issuePageRange` and `hasIssuePages`. So the Resources view cannot disagree
 * with the Issues list about what a page number means, where an out-of-range one
 * lands, or when the controls disappear.
 */
export function resourcePageCount(total: number, pageSize = RESOURCE_PAGE_SIZE): number {
  return issuePageCount(total, pageSize);
}

/**
 * The page the Resources view may actually be showing, given the page that was
 * asked for. Out of range moves down onto the last existing page, exactly as
 * `clampIssuePage` does: registering a resource lengthens the list, removing a
 * dependency shortens it, and both are the same event to a reader.
 */
export function clampResourcePage(page: number, total: number, pageSize = RESOURCE_PAGE_SIZE): number {
  return clampIssuePage(page, total, pageSize);
}

/**
 * The one page of the board's resources, in the order the board holds them.
 *
 * Pagination is a window onto the board's own resource order and never a second
 * sort of it: grouping still happens afterwards and still sorts hosts and paths
 * inside the page (`groupResources`), exactly as it does for an unpaged board.
 * So a page that happens to hold two hosts draws two host sections, and a host
 * whose resources straddle a page boundary appears on both pages rather than
 * being pulled onto one of them.
 */
export function resourcePage<T>(resources: readonly T[], page: number, pageSize = RESOURCE_PAGE_SIZE): T[] {
  const index = clampResourcePage(page, resources.length, pageSize);
  return resources.slice((index - 1) * pageSize, index * pageSize);
}

/**
 * There is deliberately no `resourcePageRange` or `hasResourcePages` beside
 * these.
 *
 * The Resources view draws its position line and its Previous/Next boundaries
 * through the shared `IssuePagination` control, which already answers both
 * questions with `issuePageRange` and `hasIssuePages` — and its position line
 * reads `1–50 of 126` without naming a noun, so it is exactly as true of
 * resources as it is of issues. A resource-specific copy of those two helpers
 * would be a second answer to a question the list already answers, free to drift
 * from the Issues list's.
 */

/** What the Resources view's own Previous/Next control announces itself as paging. */
export const RESOURCE_LIST_PAGES_LABEL = 'Resource list pages';

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

export function issueCounts<T extends Pick<BoardIssue, 'state'>>(issues: readonly T[]): Record<IssueFilter, number> {
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

export const FEED_HINT = 'Materialized board activity, newest first: creations, edits, comments, closures and reopenings, each at the moment it was committed.';

/**
 * How each feed entry kind reads on one line. A mapping over the whole
 * vocabulary rather than a chain of comparisons, so a kind added to
 * `BOARD_FEED_ENTRY_KINDS` is a type error here instead of silently rendering
 * as the last case. These are the same six verbs `antonina board feed` prints,
 * so the browser and the CLI name the same event the same way.
 */
export const FEED_VERB: { readonly [K in BoardFeedEntryKind]: string } = {
  'issue-created': 'created',
  'issue-edited': 'edited',
  'comment-added': 'commented',
  'issue-closed': 'closed',
  'issue-reopened': 'reopened',
  'issue-deleted': 'deleted',
};

/**
 * The badge that tells the six kinds apart at a glance, and as a class name the
 * row is styled from. Also total over the vocabulary, for the same reason.
 */
export const FEED_KIND_LABEL: { readonly [K in BoardFeedEntryKind]: string } = {
  'issue-created': 'Created',
  'issue-edited': 'Edited',
  'comment-added': 'Comment',
  'issue-closed': 'Closed',
  'issue-reopened': 'Reopened',
  'issue-deleted': 'Deleted',
};

/**
 * One line describing the operation the entry names. The author's name and the
 * body appear only for a comment, because the log records them only there: no
 * other kind has them, and inventing one from the collapsed view would be an
 * event the board never committed.
 */
export function feedEntrySummary(entry: BoardFeedEntry): string {
  if (entry.kind === 'comment-added' && typeof entry.author === 'string') {
    return `${FEED_VERB['comment-added']} by ${entry.author}: ${typeof entry.body === 'string' ? entry.body : ''}`;
  }
  return `${FEED_VERB[entry.kind]} — ${entry.title}`;
}

export const FEED_EMPTY = {
  title: 'No activity recorded yet',
  body: 'Entries appear here as soon as the board records its first operation.',
} as const;

export const FEED_COUNT_LABEL = (shown: number, total: number) => `${shown} of ${total} recorded entries`;

/**
 * How many entries one page of the feed holds.
 *
 * It is the projection's own `DEFAULT_FEED_LIMIT` rather than a number written
 * here, for the reason `feedFirstPageRequest` exists: a page in the browser and a
 * page of `antonina board feed` are the same page, and two literals that both
 * say 50 is two values that can drift. It is 50, which is also `ISSUE_PAGE_SIZE`
 * and `COMMENT_PAGE_SIZE`, so every numbered page on the board is one chunk.
 */
export const FEED_PAGE_SIZE = DEFAULT_FEED_LIMIT;

/**
 * The feed's paging, as the same model the Issues list and a conversation use.
 *
 * These are the `issuePage*` helpers applied to the feed's own entry count and
 * page size, exactly as `commentPage*` applies them to a message count. They are
 * not a second implementation: the page count, the clamp, the range line and the
 * "is there more than one page" question are all answered by the same four
 * functions, so the feed cannot disagree with the rest of the board about what a
 * page number means or what happens to one that no longer exists.
 */
export function feedPageCount(total: number, pageSize = FEED_PAGE_SIZE): number {
  return issuePageCount(total, pageSize);
}

/**
 * The page of the feed the reader may actually be on, given the page that was
 * asked for. Out of range moves down onto the last existing page, exactly as
 * `clampIssuePage` does, so a feed that got shorter between reads keeps the
 * reader on a page that exists instead of blanking the tab.
 */
export function clampFeedPage(page: number, total: number, pageSize = FEED_PAGE_SIZE): number {
  return clampIssuePage(page, total, pageSize);
}

/**
 * Which entries are on screen out of how many the log holds.
 *
 * The count is `total`, which the projection reports for the whole feed rather
 * than for the page, so the range line is about the log and not about the window
 * onto it — the same thing `issuePageRange` says about a filtered issue list.
 */
export function feedPageRange(total: number, page: number, pageSize = FEED_PAGE_SIZE): string {
  return issuePageRange(total, page, pageSize);
}

/** Whether the log is long enough to be worth paging at all. */
export function hasFeedPages(total: number, pageSize = FEED_PAGE_SIZE): boolean {
  return hasIssuePages(total, pageSize);
}

/** What the feed's Previous/Next control announces itself as paging. */
export const FEED_PAGES_LABEL = 'Board feed pages';

/**
 * The one shape the feed is read through, wherever it is called from: the bare
 * function the tab receives as a prop. It is `FeedRead` from the session module
 * rather than a second declaration, so the tab and the thing that hands it a
 * read cannot drift apart into two shapes that each look right.
 */
export type { FeedRead } from './api';

/**
 * The request the feed tab opens with, and the request any page after the first
 * is reached by. It asks the core projection for its own default page — 50
 * entries — rather than naming a number here, so the browser and
 * `antonina board feed` have one default rather than two that can drift.
 */
export function feedFirstPageRequest(): BoardFeedRequest {
  return { limit: FEED_PAGE_SIZE };
}

/**
 * The numbered feed page the reader asked for, as the ONE page that is kept.
 *
 * The projection's API is cursor-based and that stays an implementation detail
 * of this function: to reach page `page` it walks forward from the newest page,
 * handing each token back to the projection exactly as it arrived, and returns
 * only the page that was asked for. Nothing merges and nothing accumulates, so
 * the number of entries the caller holds is the number of entries on one page
 * however deep into the log the reader has been — which is the whole point, and
 * is the same shape the public CLI's `readNumberedFeedPage` produces.
 *
 * A `page` below 1 is page 1, and a page past the end of the log is the last
 * page that exists: both are the `clampIssuePage` rule this model already uses
 * everywhere else. The page that exists is only known once the newest page has
 * been read — it is the page that reports the log's `total` — so that read
 * happens first and the clamp follows it, rather than an out-of-range link
 * asking the projection for a page it has no entries for.
 *
 * The walk costs one request per page, because a cursor names a position and
 * not an offset. That is a cost of the cursor API and is stated in the report
 * for issue 174 as a `packages/core` concern; it is not worked around here,
 * because a browser-side offset the server cannot honour would be an invention.
 */
export async function readFeedPage(readFeed: FeedRead, page: number, pageSize = FEED_PAGE_SIZE): Promise<BoardFeedPage> {
  const newest = await readFeed(feedFirstPageRequest());
  const wanted = clampFeedPage(page, newest.total, pageSize);
  let current = newest;
  for (let number = 1; number < wanted; number += 1) {
    // The projection stops issuing tokens at the end of the log. A page number
    // past that point has no entries behind it, so the walk stops rather than
    // asking again, and the empty page it ends on keeps the log's own `total`
    // so the caller still knows how long the feed is.
    if (current.nextCursor === null) {
      return { entries: [], nextCursor: null, total: current.total, limit: current.limit };
    }
    current = await readFeed({ limit: pageSize, cursor: current.nextCursor });
  }
  return current;
}

/**
 * The two kinds the board genuinely cannot report, said out loud where a reader
 * would otherwise assume they are merely missing.
 *
 * A message edit is inexpressible because a board message is immutable and there
 * is no message-edit operation to project, and a per-field issue-edit history is
 * not recorded because an edit operation names the issue, not the field it
 * changed. An `issue-edited` entry says an edit was committed at that instant;
 * it does not and cannot say which part of the issue it changed. Nothing here
 * renders a placeholder that would imply either exists.
 */
export const FEED_UNTRACKED_COPY =
  'The board does not record edits to messages, or which field an issue edit changed, so neither appears here.';

/**
 * The issues the board view knows about that the entries in hand report nothing
 * for. This is the set difference and nothing else: a pure function of what it
 * is given, with no opinion about whether the claim built on it is yet true.
 *
 * An issue already present when the materialized feed begins has no creation
 * entry: no feed event ever named its creation, so the feed cannot place it and
 * does not. The CLI cannot tell that apart from an empty board and prints an
 * empty feed, but a browser can, because it holds both the board view and the
 * feed. No entry is invented for such an issue, and it is not ordered or
 * timestamped here, because the board recorded no such feed event.
 *
 * What this cannot say on its own is that the issue predates the log. It can
 * only say the entries it was handed do not mention it, and on a paged feed
 * that is exactly as true of an issue created ten operations ago and left off
 * the first page. `unplacedIssueNumbers` is the gated form.
 */
export function untrackedIssueNumbers<T extends Pick<BoardIssue, 'number'>>(issues: readonly T[], entries: BoardFeedEntry[]): number[] {
  const tracked = new Set(entries.map((entry) => entry.issueNumber));
  return issues.filter((issue) => !tracked.has(issue.number)).map((issue) => issue.number).sort((left, right) => left - right);
}

/**
 * The issues the feed cannot place, or none at all while any page is unread.
 *
 * The claim is only true about a log the reader has read to the end. An issue
 * that appears in no entry of a partial walk may simply be waiting on the next
 * page, and saying it "predates the log" then would be a statement about a log
 * nobody has read — a caveat that fires on healthy, heavily-active boards and
 * teaches the reader to ignore it, which is worse than saying nothing.
 *
 * So the caveat waits for exhaustion. The projection reports a continuation
 * token while entries remain, and hands back `null` only at the end of the log;
 * the count of what is in hand then has to cover the `total` the same page
 * reported, so a merged walk that somehow came up short does not make the claim
 * either. Once the walk is complete the difference above is real: every issue on
 * the board that the whole log never names was in the initialize snapshot.
 *
 * While a continuation token is outstanding the answer is no issues, and the
 * view says nothing rather than something weaker. A board that is entirely
 * untracked is still reported, as soon as the reader has walked the feed to its
 * end and can honestly be told the log holds nothing for those issues.
 *
 * WHAT NUMBERED PAGING COSTS HERE, STATED RATHER THAN PAPERED OVER (board 173).
 * This gate needs the WHOLE log's entries in hand, and numbered pagination
 * deliberately keeps only one page: the tab that renders page 3 of a 60-entry log
 * holds 50 entries and a `nextCursor`, so the honest answer here is no issues and
 * the caveat stays silent. That is the safe direction — the alternative would be
 * a claim about every issue on the board made from a single page of entries — but
 * it does mean the browser no longer raises this caveat, where the old
 * append-everything walk did once a reader had walked to the end. The rule is
 * unchanged, and the view that feeds it a complete walk still satisfies it;
 * restoring the caveat for a paged reader needs the union of issue numbers across
 * the log, which is a `packages/core` projection question rather than something to
 * re-accumulate in the browser.
 */
export function unplacedIssueNumbers<T extends Pick<BoardIssue, 'number'>>(issues: readonly T[], entries: BoardFeedEntry[], nextCursor: string | null, total: number): number[] {
  if (nextCursor !== null || entries.length < total) return [];
  return untrackedIssueNumbers(issues, entries);
}

/**
 * The caveat for a log read to its end, and only then. The wording names the
 * exhaustion it depends on, so the sentence cannot be read as a claim made from
 * a partial walk.
 */
export const FEED_TRUNCATED_COPY = (numbers: number[]) =>
  `You have read the whole feed, and it records no activity for these issues. They were already on the board when the materialized feed began, so the feed cannot show when they were created or changed: ${numbers.map((number) => `#${number}`).join(', ')}.`;

export function formatUpdatedAt(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return 'just now';
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed >= 0 && elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
