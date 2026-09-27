import { base64UrlDecode, base64UrlEncode } from './canonical.js';
import type { IssueState } from './model.js';
import type {
  BoardOperationLog,
  IssueCommentPayload,
  IssueCreatePayload,
  IssueEditPayload,
  IssueReferencePayload,
  SignedBoardOperation,
} from './operations.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The kinds of board activity the feed reports, and the whole vocabulary.
 *
 * The feed is a projection over the signed operation log, and every kind here is
 * one recorded operation. The board DOES record that an issue was closed and
 * that it was reopened, and it records each edit and each comment with the
 * instant it was committed: `issue.close`, `issue.reopen`, `issue.edit` and
 * `issue.comment` are all in `BOARD_OPERATION_KINDS`. What the collapsed
 * `Board` view cannot express is only the history: `BoardIssue` keeps one
 * `createdAt`, one `updatedAt` and a `messages` array of immutable
 * `{id, author, body, createdAt}` records, so the view shows that an issue is
 * closed but not that it was closed at a named instant, and it cannot say
 * whether the single `updatedAt` was an edit, a comment, a closure or a
 * reopen. Reading the log instead of the view is what makes the difference
 * between those real, separately timestamped events.
 *
 * The vocabulary is exactly the issue-scoped operation kinds, one entry each, so
 * it is total over what the projection can produce. A message edit stays absent
 * because it is genuinely inexpressible: `BoardMessage` is immutable and there
 * is no message-edit operation kind to project.
 */
export const BOARD_FEED_ENTRY_KINDS = [
  'issue-created',
  'issue-edited',
  'comment-added',
  'issue-closed',
  'issue-reopened',
  'issue-deleted',
] as const;

export type BoardFeedEntryKind = (typeof BOARD_FEED_ENTRY_KINDS)[number];

export interface BoardFeedEntry {
  /**
   * The entry's identity within the feed: the identity of the operation that
   * produced it, which is unique across a board by construction and is what a
   * caller matches an entry against.
   */
  id: string;
  kind: BoardFeedEntryKind;
  /** The operation's own instant, the time the thing actually happened. */
  at: string;
  /**
   * The entry's index in the operation log. The log is append-only, so a
   * position never moves, and the log's own order is the feed's tie-break.
   */
  position: number;
  issueNumber: number;
  /**
   * The issue's title as of this operation: what a create or a title edit set,
   * otherwise the title in force when the operation was committed.
   */
  title: string;
  /** The issue's state as this operation left it. */
  state: IssueState;
  /** The message identity for `comment-added`, which is the operation's own. */
  messageId: string | null;
  /** The message author for `comment-added`, else `null`. */
  author: string | null;
  /** The message body for `comment-added`, else `null`. */
  body: string | null;
}

export interface BoardFeedPage {
  entries: BoardFeedEntry[];
  /** The token that requests the entries after these, or `null` at the end. */
  nextCursor: string | null;
  /** How many entries the whole feed holds, not just this page. */
  total: number;
  limit: number;
}

export const DEFAULT_FEED_LIMIT = 50;

/** The hard ceiling, so a caller cannot ask for an unbounded projection. */
export const MAX_FEED_LIMIT = 500;

export const FEED_CURSOR_VERSION = 'v1';

interface FeedPosition {
  at: string;
  position: number;
}

/**
 * The total order of the feed is the log's own order, read backwards: newest
 * operation first. The log guarantees nondecreasing timestamps, so the two
 * agree, and unlike a timestamp it the log position is unique, so every entry
 * has a position no other entry shares and "the entries after this one" is a
 * single well-defined set even when every operation shares one millisecond.
 */
function compareEntries(left: FeedPosition, right: FeedPosition): number {
  return right.position - left.position;
}

function cursorOf(entry: FeedPosition): string {
  const payload = JSON.stringify([entry.at, entry.position]);
  return FEED_CURSOR_VERSION + '.' + base64UrlEncode(textEncoder.encode(payload));
}

/**
 * A continuation token is the log position of the last operation the caller has
 * seen, plus its instant so a printed token is readable. That is what makes a
 * walk lossless: the next page is every entry at a lower position, i.e. every
 * operation committed earlier, and because a position is a place in an
 * append-only log rather than a lookup key, a walk neither skips nor repeats an
 * entry and a token stays meaningful even for an operation that is no longer
 * part of the board view.
 */
export function parseFeedCursor(value: string): FeedPosition {
  const [version, encoded] = value.split('.', 2);
  if (version !== FEED_CURSOR_VERSION || encoded === undefined || encoded.length === 0) {
    throw new Error('Antonina board feed cursor is malformed');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(base64UrlDecode(encoded)));
  } catch {
    throw new Error('Antonina board feed cursor is malformed');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new Error('Antonina board feed cursor is malformed');
  }
  const [at, position] = decoded as [unknown, unknown];
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))
      || !Number.isSafeInteger(position) || (position as number) < 0) {
    throw new Error('Antonina board feed cursor is malformed');
  }
  return { at, position: position as number };
}

function entryOf(
  operation: SignedBoardOperation,
  position: number,
  kind: BoardFeedEntryKind,
  issueNumber: number,
  title: string,
  state: IssueState,
  comment: IssueCommentPayload | null = null,
): BoardFeedEntry {
  return {
    id: operation.opId,
    kind,
    at: operation.timestamp,
    position,
    issueNumber,
    title,
    state,
    messageId: comment === null ? null : operation.opId,
    author: comment?.author ?? null,
    body: comment?.body ?? null,
  };
}

/** What the walk over the log knows about an issue as it reaches each operation. */
interface IssueHistory {
  title: string;
  state: IssueState;
}

/**
 * Every issue-scoped operation in the log, newest first.
 *
 * This is a pure function of the log: identical log state always yields the
 * identical stream, and nothing here reads a clock, a cache, or a UI. Each entry
 * reports exactly the operation it names, at that operation's instant, with no
 * inference: there is no "last changed" entry, because one such entry would have
 * to claim that an edit, a comment, a closure and a reopen were the same event.
 *
 * One thing the projection deliberately does not report is an issue that was
 * already present in the `board.initialize` snapshot. It predates the log, so
 * the log never recorded when it was created, and inventing an entry for it
 * would assert something no operation says.
 */
export function feedEntries(log: BoardOperationLog): BoardFeedEntry[] {
  const histories = new Map<number, IssueHistory>();
  const entries: BoardFeedEntry[] = [];
  for (const [position, operation] of log.operations.entries()) {
    switch (operation.kind) {
      case 'issue.create': {
        const payload = operation.payload as IssueCreatePayload;
        const history = { title: payload.title, state: 'open' as IssueState };
        histories.set(payload.number, history);
        entries.push(entryOf(operation, position, 'issue-created', payload.number, history.title, history.state));
        break;
      }
      case 'issue.edit': {
        const payload = operation.payload as IssueEditPayload;
        const history = histories.get(payload.number);
        if (history === undefined) break;
        if (payload.title !== null) history.title = payload.title;
        entries.push(entryOf(operation, position, 'issue-edited', payload.number, history.title, history.state));
        break;
      }
      case 'issue.comment': {
        const payload = operation.payload as IssueCommentPayload;
        const history = histories.get(payload.number);
        if (history === undefined) break;
        entries.push(entryOf(operation, position, 'comment-added', payload.number, history.title, history.state, payload));
        break;
      }
      case 'issue.close':
      case 'issue.reopen': {
        const payload = operation.payload as IssueReferencePayload;
        const history = histories.get(payload.number);
        if (history === undefined) break;
        history.state = operation.kind === 'issue.close' ? 'closed' : 'open';
        entries.push(entryOf(
          operation,
          position,
          operation.kind === 'issue.close' ? 'issue-closed' : 'issue-reopened',
          payload.number,
          history.title,
          history.state,
        ));
        break;
      }
      case 'issue.delete': {
        const payload = operation.payload as IssueReferencePayload;
        const history = histories.get(payload.number);
        if (history === undefined) break;
        // The title and the state in force at the deletion are what the entry
        // reports; nothing can happen to the issue afterwards.
        entries.push(entryOf(operation, position, 'issue-deleted', payload.number, history.title, history.state));
        histories.delete(payload.number);
        break;
      }
      default:
        break;
    }
  }
  return entries.sort(compareEntries);
}

export interface BoardFeedRequest {
  limit?: number;
  /** A token from a previous page, or `null`/absent for the newest page. */
  cursor?: string | null;
}

export function feedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_FEED_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Antonina board feed limit must be a positive integer');
  }
  return Math.min(limit, MAX_FEED_LIMIT);
}

/**
 * One page of the feed, newest first, with the token that continues it.
 *
 * `total` counts the whole feed rather than the page so a caller can tell an
 * exhausted stream from a page-limited one without walking to the end.
 */
export function boardFeed(log: BoardOperationLog, request: BoardFeedRequest = {}): BoardFeedPage {
  const limit = feedLimit(request.limit);
  const ordered = feedEntries(log);
  const cursor = request.cursor === undefined || request.cursor === null ? null : parseFeedCursor(request.cursor);
  const remaining = cursor === null ? ordered : ordered.filter((entry) => entry.position < cursor.position);
  const entries = remaining.slice(0, limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: remaining.length > entries.length && last !== undefined ? cursorOf(last) : null,
    total: ordered.length,
    limit,
  };
}
