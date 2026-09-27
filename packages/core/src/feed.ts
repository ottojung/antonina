import { base64UrlDecode, base64UrlEncode } from './canonical.js';
import type { Board, IssueState } from './model.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The kinds of board activity the feed reports, and the whole vocabulary.
 *
 * The board records when an issue was created, when an issue was last changed,
 * and when each message was written. It does not record which field of an issue
 * a change touched, when an issue was closed or reopened, or that a message was
 * ever edited: `BoardIssue` carries one `createdAt`, one `updatedAt` and a
 * `messages` array of immutable `{id, author, body, createdAt}` records, and
 * `BOARD_OPERATION_KINDS` has no message-edit operation. So the feed names only
 * what the board can answer, and the enumeration is the promise that it will
 * never name more.
 */
export const BOARD_FEED_ENTRY_KINDS = ['issue-created', 'issue-updated', 'comment-added'] as const;

export type BoardFeedEntryKind = (typeof BOARD_FEED_ENTRY_KINDS)[number];

export interface BoardFeedEntry {
  /**
   * The entry's identity within the feed: kind, issue number, and the message
   * identity for a comment. Unique across a board, and the value a continuation
   * token points at.
   */
  id: string;
  kind: BoardFeedEntryKind;
  /** When the reported thing happened, as the board recorded it. */
  at: string;
  issueNumber: number;
  title: string;
  /** The issue's state at the time of the projection, not a state change. */
  state: IssueState;
  /** The message identity for `comment-added`, else `null`. */
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

function feedEntryId(kind: BoardFeedEntryKind, issueNumber: number, messageId: string | null): string {
  return kind + ':' + issueNumber + ':' + (messageId ?? '-');
}

/**
 * The total order of the feed: newest first, and within one instant a fixed,
 * nameable order. A timestamp alone is not an order, because the board can
 * record several changes in the same millisecond; these three fields make the
 * comparison strict, so every entry has a position no other entry shares and
 * "the entries after this one" is a single well-defined set.
 */
function compareEntries(left: BoardFeedEntry, right: BoardFeedEntry): number {
  const leftAt = Date.parse(left.at);
  const rightAt = Date.parse(right.at);
  if (leftAt !== rightAt) return rightAt - leftAt;
  const leftKind = BOARD_FEED_ENTRY_KINDS.indexOf(left.kind);
  const rightKind = BOARD_FEED_ENTRY_KINDS.indexOf(right.kind);
  if (leftKind !== rightKind) return leftKind - rightKind;
  if (left.issueNumber !== right.issueNumber) return left.issueNumber - right.issueNumber;
  const leftMessage = left.messageId ?? '';
  const rightMessage = right.messageId ?? '';
  if (leftMessage === rightMessage) return 0;
  return leftMessage < rightMessage ? -1 : 1;
}

function cursorOf(entry: BoardFeedEntry): string {
  const payload = JSON.stringify([entry.at, entry.kind, entry.issueNumber, entry.messageId]);
  return FEED_CURSOR_VERSION + '.' + base64UrlEncode(textEncoder.encode(payload));
}

/**
 * A continuation token is the whole ordering key of the last entry the caller
 * has seen, not its timestamp alone. That is what makes a walk lossless: the
 * next page is every entry that compares strictly after that key, so an entry
 * that shares the last entry's millisecond is either already delivered (it
 * sorts before the key) or still pending (it sorts after), never both and
 * never neither.
 */
export function parseFeedCursor(value: string): BoardFeedEntry {
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
  if (!Array.isArray(decoded) || decoded.length !== 4) {
    throw new Error('Antonina board feed cursor is malformed');
  }
  const [at, kind, issueNumber, messageId] = decoded as [unknown, unknown, unknown, unknown];
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))
      || typeof kind !== 'string'
      || !(BOARD_FEED_ENTRY_KINDS as readonly string[]).includes(kind)
      || !Number.isSafeInteger(issueNumber) || (issueNumber as number) <= 0
      || (messageId !== null && typeof messageId !== 'string')) {
    throw new Error('Antonina board feed cursor is malformed');
  }
  return {
    id: feedEntryId(kind as BoardFeedEntryKind, issueNumber as number, messageId as string | null),
    kind: kind as BoardFeedEntryKind,
    at,
    issueNumber: issueNumber as number,
    title: '',
    state: 'open',
    messageId: messageId as string | null,
    author: null,
    body: null,
  };
}

function issueEntries(issue: Board['issues'][number]): BoardFeedEntry[] {
  const base = {
    issueNumber: issue.number,
    title: issue.title,
    state: issue.state,
  };
  return [
    {
      ...base,
      id: feedEntryId('issue-created', issue.number, null),
      kind: 'issue-created',
      at: issue.createdAt,
      messageId: null,
      author: null,
      body: null,
    },
    {
      ...base,
      id: feedEntryId('issue-updated', issue.number, null),
      kind: 'issue-updated',
      at: issue.updatedAt,
      messageId: null,
      author: null,
      body: null,
    },
    ...issue.messages.map((message) => ({
      ...base,
      id: feedEntryId('comment-added', issue.number, message.id),
      kind: 'comment-added' as const,
      at: message.createdAt,
      messageId: message.id,
      author: message.author,
      body: message.body,
    })),
  ];
}

/**
 * Every entry the board can support, in the total order above.
 *
 * The projection is a pure function of the board: identical board state always
 * yields the identical stream, and nothing here reads a clock, a cache, or a
 * UI. Two board fields become two issue entries rather than one, because
 * creation and last change are genuinely different instants and a caller
 * asking "what is new here" wants both.
 */
export function feedEntries(board: Board): BoardFeedEntry[] {
  return board.issues.flatMap(issueEntries).sort(compareEntries);
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
export function boardFeed(board: Board, request: BoardFeedRequest = {}): BoardFeedPage {
  const limit = feedLimit(request.limit);
  const ordered = feedEntries(board);
  const cursor = request.cursor === undefined || request.cursor === null ? null : parseFeedCursor(request.cursor);
  const remaining = cursor === null ? ordered : ordered.filter((entry) => compareEntries(entry, cursor) > 0);
  const entries = remaining.slice(0, limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor: remaining.length > entries.length && last !== undefined ? cursorOf(last) : null,
    total: ordered.length,
    limit,
  };
}
