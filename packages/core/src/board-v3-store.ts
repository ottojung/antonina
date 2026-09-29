import {
  base64UrlEncode,
  canonicalBytes,
  sha256,
  sha256Id,
  type CanonicalValue,
} from './canonical.js';
import {
  credentialTrustAnchor,
  verifyBoardCredential,
  type BoardCredential,
} from './credential.js';
import {
  feedEntries,
  feedLimit,
  parseFeedCursor,
  type BoardFeedEntry,
  type BoardFeedPage,
  type BoardFeedRequest,
} from './feed.js';
import {
  type Board,
  type BoardDispatch,
  type BoardExecutionTarget,
  type BoardIssue,
  type BoardMessage,
  type BoardResource,
  type IssueState,
} from './model.js';
import {
  OPLOG_SCHEMA_VERSION,
  applyBoardMutation,
  parseUnsignedBoardOperation,
  unMigratedBoardReport,
  type BoardOperationPayload,
  type BoardTrustAnchor,
  type SignedBoardOperation,
  type VerifiedBoardState,
} from './operations.js';
import type {
  AppendOperationRequest,
  SignedBoardStoreOptions,
  StoredSignedBoard,
} from './board-store.js';

export const SHARDED_BOARD_SCHEMA_VERSION = 2 as const;
export const V3_ISSUE_PAGE_SIZE = 50;
export const V3_COMMENT_PAGE_SIZE = 50;
export const V3_FEED_PAGE_SIZE = 50;

const POINTER_FORMAT = 'materialized-snapshots' as const;
const POINTER_KEY = 'board-v2';
const DIRECTORY_PAGE_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 6;
const textEncoder = new TextEncoder();

/**
 * A shard ref is the digest of the shard's own canonical bytes, so it names a
 * value rather than a revision. Nothing overwrites a shard: a POST whose ref is
 * already present is answered 409 and treated as confirmation. That is what
 * makes the ref safe to reuse, and reuse is what bounds storage -- a directory
 * page, list page, issue snapshot, queue or catalog that a mutation did not
 * change resolves to the ref that is already stored, so it is written once for
 * the life of the board rather than once per mutation.
 *
 * It also means a shard carries no `revision` field. A revision differs on every
 * mutation, so a shard that recorded it would hash differently every time and
 * could never be shared. Revision authority lives in the meta object the
 * pointer names, which `readMeta` cross-checks against the pointer.
 */
const SHARD_REF_PREFIX = 'v3:';

/**
 * Generations of materialization kept reachable, counted back from the pointer.
 *
 * A writer reads the generation it is superseding, commits the new one, and
 * then deletes the refs that generation pinned and the new one does not. The
 * live set is therefore the pointer's generation plus the one before it, no
 * matter how many mutations have been applied: a store's object count tracks
 * its live board size, not its mutation count.
 *
 * Retaining the superseded generation is what buys back the safety that naming
 * shards by revision gave for free. There is no lease or compare-and-delete in
 * Skrynia, so the only way to let a slow reader finish is to keep what it may
 * still be reading. One retained generation is the smallest window that still
 * covers a reader that read the pointer and then completed its reads; a reader
 * that stalls across two further commits can see a 404 for a shard it was
 * reading. Widening this is a one-line latency-for-safety trade, and it is the
 * single knob in this file that the immutable design did not have.
 */
const RETAINED_GENERATIONS = 1;

interface JsonObject<T> {
  value: T;
  etag: string;
}

export interface ShardedBoardPointer {
  schemaVersion: 3;
  format: typeof POINTER_FORMAT;
  boardId: string;
  rootKeyId: string;
  head: string;
  revision: number;
  metaRef: string;
}

export interface ShardedBoardMeta {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  rootKeyId: string;
  head: string;
  revision: number;
  updatedAt: string;
  migratedFrom: string | null;
  nextIssueNumber: number;
  issueCount: number;
  openIssueCount: number;
  closedIssueCount: number;
  directoryRefs: Array<string | null>;
  openPageRefs: string[];
  closedPageRefs: string[];
  queueRef: string;
  catalogRef: string;
  feedPageRefs: string[];
  feedCount: number;
  deleted: boolean;
  /**
   * The meta ref of the generation this one superseded, so a later generation
   * can find its ancestors without a listing primitive.
   *
   * This chain is the only reason the per-generation meta objects do not
   * accumulate. A meta is named by the pointer rather than by another meta, so
   * it is outside the `pinnedRefs` closure and `reclaim` never sees it; the
   * chain is what lets a writer walk back and delete the metas that have aged
   * past `RETAINED_GENERATIONS`. It is `null` on a meta written before the
   * chain existed, which reads as "no ancestors", and on the first meta of a
   * board.
   */
  retainsMetaRef: string | null;
}

interface DirectoryEntry {
  number: number;
  ref: string;
}

interface DirectoryPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  page: number;
  entries: DirectoryEntry[];
}

interface IssueCore {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
}

interface IssueSnapshot {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  number: number;
  /**
   * A deleted issue keeps one tombstone snapshot in the directory instead of
   * vanishing from it. The tombstone pins nothing but its own `commentRefs`,
   * and that is the point: a comment page is rewritten on every later comment to
   * its issue, so the feed can only address a comment by (issue, index) if the
   * issue is still resolvable after it is deleted. One small object per deleted
   * issue is the entire cost of keeping every deleted issue's comments readable
   * from the feed, and it replaces the unbounded pile of orphaned comment pages
   * the previous model left behind.
   */
  deleted: boolean;
  issue: IssueCore | null;
  closedAt: string | null;
  messageCount: number;
  commentRefs: string[];
}

interface CommentPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  number: number;
  page: number;
  messages: BoardMessage[];
}

export interface IssueListSummary {
  number: number;
  title: string;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  messageCount: number;
  hasBody: boolean;
}

/**
 * A list page as a caller sees it. `revision` is not stored in the shard -- it
 * differs on every mutation and would defeat ref sharing -- so it is filled in
 * from the meta, which is the same revision for every shard of a generation.
 */
export interface IssueListPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  state: IssueState;
  page: number;
  revision: number;
  total: number;
  entries: IssueListSummary[];
}

type StoredIssueListPage = Omit<IssueListPage, 'revision'>;

export interface BoardOverview {
  boardId: string;
  head: string;
  revision: number;
  deleted: boolean;
  queue: number[];
  issues: IssueListSummary[];
  resources: BoardResource[];
  targets: BoardExecutionTarget[];
  dispatches: BoardDispatch[];
}

interface QueueSnapshot {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  numbers: number[];
}

interface CatalogSnapshot {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  resources: BoardResource[];
  targets: BoardExecutionTarget[];
  dispatches: BoardDispatch[];
}

type StoredFeedEntry = Omit<BoardFeedEntry, 'author' | 'body'> & {
  author?: string | null;
  body?: string | null;
  /**
   * How a comment entry reaches its message. `commentRef` names a comment page
   * directly and is what this model wrote before shards became reclaimable; it
   * is read for compatibility and no longer written, because the page it names
   * is rewritten by every later comment to that issue and so cannot be pinned
   * once superseded. `commentIndex` is the addressable form: the issue's
   * messages are append-only, so index `i` is page `floor(i / 50)`, element
   * `i % 50`, of whatever the issue's current snapshot pins.
   */
  commentRef?: string;
  commentIndex?: number;
};

interface FeedPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  page: number;
  entries: StoredFeedEntry[];
}

interface StateBundle {
  meta: ShardedBoardMeta;
  state: VerifiedBoardState;
  issueRefs: Map<number, string>;
  issueSnapshots: Map<number, IssueSnapshot>;
  messageCounts: Map<number, number>;
  closedAt: Map<number, string>;
  directoryPages: Map<number, DirectoryPage>;
}

export class ShardedBoardStoreError extends Error {
  readonly status: number | null;
  readonly method: string | null;

  constructor(message: string, options: { cause?: unknown; status?: number; method?: string } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status ?? null;
    this.method = options.method ?? null;
  }
}

function defaultId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSafeCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ShardedBoardStoreError(`Antonina v3 ${name} is malformed`);
  }
  return value as number;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ShardedBoardStoreError(`Antonina v3 ${name} is malformed`);
  }
  return value;
}

function canonicalTimestampAtOrAfter(value: string, floor: string): string {
  const millis = Date.parse(value);
  const floorMillis = Date.parse(floor);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value || !Number.isFinite(floorMillis)) {
    throw new ShardedBoardStoreError('Antonina v3 timestamp is malformed');
  }
  return new Date(Math.max(millis, floorMillis)).toISOString();
}

function pointerOf(value: unknown): ShardedBoardPointer | null {
  if (!isRecord(value)
      || value.schemaVersion !== 3
      || value.format !== POINTER_FORMAT
      || typeof value.boardId !== 'string'
      || typeof value.rootKeyId !== 'string'
      || typeof value.head !== 'string'
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 1
      || typeof value.metaRef !== 'string') {
    return null;
  }
  return {
    schemaVersion: 3,
    format: POINTER_FORMAT,
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    head: value.head,
    revision: value.revision as number,
    metaRef: value.metaRef,
  };
}

export function parseShardedBoardPointer(value: unknown): ShardedBoardPointer | null {
  return pointerOf(value);
}

function parseMeta(value: unknown): ShardedBoardMeta {
  if (!isRecord(value)
      || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
      || typeof value.boardId !== 'string'
      || typeof value.rootKeyId !== 'string'
      || typeof value.head !== 'string'
      || typeof value.updatedAt !== 'string'
      || (value.migratedFrom !== null && typeof value.migratedFrom !== 'string')
      || !Array.isArray(value.directoryRefs)
      || !Array.isArray(value.openPageRefs)
      || !Array.isArray(value.closedPageRefs)
      || typeof value.queueRef !== 'string'
      || typeof value.catalogRef !== 'string'
      || !Array.isArray(value.feedPageRefs)
      || typeof value.deleted !== 'boolean') {
    throw new ShardedBoardStoreError('Antonina v3 metadata is malformed');
  }
  const directoryRefs = value.directoryRefs.map((entry) => {
    if (entry !== null && typeof entry !== 'string') {
      throw new ShardedBoardStoreError('Antonina v3 directory references are malformed');
    }
    return entry;
  });
  const strings = (entries: unknown[], name: string): string[] => entries.map((entry) => {
    if (typeof entry !== 'string') throw new ShardedBoardStoreError(`Antonina v3 ${name} are malformed`);
    return entry;
  });
  return {
    schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    head: value.head,
    revision: requireSafeCount(value.revision, 'revision'),
    updatedAt: value.updatedAt,
    migratedFrom: value.migratedFrom,
    nextIssueNumber: requireSafeCount(value.nextIssueNumber, 'next issue number'),
    issueCount: requireSafeCount(value.issueCount, 'issue count'),
    openIssueCount: requireSafeCount(value.openIssueCount, 'open issue count'),
    closedIssueCount: requireSafeCount(value.closedIssueCount, 'closed issue count'),
    directoryRefs,
    openPageRefs: strings(value.openPageRefs, 'open page references'),
    closedPageRefs: strings(value.closedPageRefs, 'closed page references'),
    queueRef: value.queueRef,
    catalogRef: value.catalogRef,
    feedPageRefs: strings(value.feedPageRefs, 'feed page references'),
    feedCount: requireSafeCount(value.feedCount, 'feed count'),
    deleted: value.deleted,
    retainsMetaRef: typeof value.retainsMetaRef === 'string' ? value.retainsMetaRef : null,
  };
}

function coreOf(issue: BoardIssue): IssueCore {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function issueFromCore(core: IssueCore, messages: BoardMessage[]): BoardIssue {
  return {
    number: core.number,
    title: core.title,
    body: core.body,
    state: core.state,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    messages,
  };
}

function directoryPageNumber(issueNumber: number): number {
  return Math.floor((issueNumber - 1) / DIRECTORY_PAGE_SIZE) + 1;
}

/**
 * The ref a shard is stored under: the digest of its own canonical bytes.
 *
 * The preimage is the value, not the ref, so the mapping is total in both
 * directions: equal values always collide onto one object, and a ref can only
 * ever be resolved to the value that produced it. The caller must not
 * construct a ref any other way, which is why the kind/page/head triple is no
 * longer a ref: a name derived from a revision changes every mutation even when
 * the value has not, and a name derived from a value does not.
 */
async function shardRef(value: unknown): Promise<string> {
  return SHARD_REF_PREFIX + base64UrlEncode(
    await sha256(canonicalBytes(value as CanonicalValue)),
  );
}

function jsonSame(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function closedAtFromBoard(board: Board): Map<number, string> {
  return new Map(
    board.issues
      .filter((issue) => issue.state === 'closed')
      .map((issue) => [issue.number, issue.updatedAt] as const),
  );
}

function latestBoardTimestamp(board: Board, fallback: string): string {
  const timestamps: string[] = [fallback];
  for (const issue of board.issues) {
    timestamps.push(issue.createdAt, issue.updatedAt);
    for (const message of issue.messages) timestamps.push(message.createdAt);
  }
  for (const resource of board.resources) timestamps.push(resource.createdAt, resource.updatedAt);
  for (const target of board.targets) timestamps.push(target.createdAt, target.updatedAt);
  for (const dispatch of board.dispatches) timestamps.push(dispatch.recordedAt);
  return new Date(Math.max(...timestamps.map((value) => Date.parse(value)))).toISOString();
}

function closedAtFromLegacy(log: NonNullable<StoredSignedBoard['log']>, board: Board): Map<number, string> {
  const result = new Map<number, string>();
  for (const issue of board.issues) {
    if (issue.state === 'closed') result.set(issue.number, issue.updatedAt);
  }
  for (const operation of log.operations) {
    if (operation.kind === 'issue.close') {
      result.set((operation.payload as { number: number }).number, operation.timestamp);
    } else if (operation.kind === 'issue.reopen' || operation.kind === 'issue.delete') {
      result.delete((operation.payload as { number: number }).number);
    }
  }
  return result;
}

function orderedSummaries(
  state: VerifiedBoardState,
  closedAt: Map<number, string>,
  issueState: IssueState,
  messageCounts?: Map<number, number>,
): IssueListSummary[] {
  const byNumber = new Map(state.board.issues.map((issue) => [issue.number, issue]));
  const ordered = issueState === 'open'
    ? state.queue.flatMap((number) => {
        const issue = byNumber.get(number);
        return issue?.state === 'open' ? [issue] : [];
      })
    : state.board.issues
        .filter((issue) => issue.state === 'closed')
        .sort((left, right) => {
          const time = (closedAt.get(right.number) ?? right.updatedAt)
            .localeCompare(closedAt.get(left.number) ?? left.updatedAt);
          return time || right.number - left.number;
        });
  return ordered.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? (closedAt.get(issue.number) ?? issue.updatedAt) : null,
    messageCount: messageCounts?.get(issue.number) ?? issue.messages.length,
    hasBody: issue.body.length > 0,
  }));
}

function issueFromSummary(summary: IssueListSummary): BoardIssue {
  return {
    number: summary.number,
    title: summary.title,
    // Mutation validation only needs to preserve whether a body exists for
    // untouched issues. The real body is loaded only for the issue being edited.
    body: summary.hasBody ? 'materialized' : '',
    state: summary.state,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messages: [],
  };
}

function paginate<T>(entries: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let offset = 0; offset < entries.length; offset += size) {
    pages.push(entries.slice(offset, offset + size));
  }
  return pages;
}

function feedCursor(entry: Pick<BoardFeedEntry, 'at' | 'position'>): string {
  return 'v1.' + base64UrlEncode(textEncoder.encode(JSON.stringify([entry.at, entry.position])));
}

function feedEntryForMutation(
  kind: AppendOperationRequest['kind'],
  payload: BoardOperationPayload,
  before: BoardIssue | undefined,
  after: BoardIssue | undefined,
  id: string,
  at: string,
  position: number,
): BoardFeedEntry | null {
  let feedKind: BoardFeedEntry['kind'];
  let issue: BoardIssue | undefined = after ?? before;
  let author: string | null = null;
  let body: string | null = null;
  switch (kind) {
    case 'issue.create':
      feedKind = 'issue-created';
      break;
    case 'issue.edit':
      feedKind = 'issue-edited';
      break;
    case 'issue.comment': {
      feedKind = 'comment-added';
      const comment = payload as { author: string; body: string };
      author = comment.author;
      body = comment.body;
      break;
    }
    case 'issue.close':
      feedKind = 'issue-closed';
      break;
    case 'issue.reopen':
      feedKind = 'issue-reopened';
      break;
    case 'issue.delete':
      feedKind = 'issue-deleted';
      break;
    default:
      return null;
  }
  if (issue === undefined) throw new ShardedBoardStoreError('Issue mutation has no materialized issue');
  return {
    id,
    kind: feedKind,
    at,
    position,
    issueNumber: issue.number,
    title: issue.title,
    state: issue.state,
    messageId: kind === 'issue.comment' ? id : null,
    author,
    body,
  };
}

/**
 * Strips a comment entry's body out of the feed and leaves behind the address
 * that can find it again.
 *
 * The address is the comment's index within its issue, not the ref of the
 * comment page that held it when the entry was written. A comment page is
 * rewritten by every later comment to the same issue, so a ref recorded here
 * would name an object the reclamation is entitled to delete -- and, worse, the
 * entry recording it can be in an already-sealed feed page that nothing will ever
 * rewrite, so the dangling reference would be permanent. The issue's messages
 * are append-only, so an index is stable for the life of the issue and resolves
 * against whatever the issue's current snapshot pins.
 */
function compactFeedEntry(entry: BoardFeedEntry, commentIndex?: number): StoredFeedEntry {
  const { author, body, ...base } = entry;
  if (entry.kind === 'comment-added' && commentIndex !== undefined) {
    return { ...base, commentIndex };
  }
  return base;
}

export interface BoardSweepReport {
  /** The generation the sweep ran for, or `null` before the first mutation. */
  revision: number | null;
  /** Shard objects the last successful sweep deleted. */
  reclaimed: number;
  /**
   * Shard objects the last sweep identified as superseded but could not
   * delete. A non-zero value is a leak, and the common cause is a board that
   * predates the sweep: Skrynia refuses to delete an `immutable` object, so
   * every object written by the pre-fix model is permanently undeletable by
   * Antonina and only Skrynia's own namespace-level collection can remove it.
   */
  retained: number;
  at: string | null;
  error: string | null;
}

export interface BoardCompactionReport {
  boardId: string;
  revision: number;
  /**
   * Shard objects the current generation pins: the whole of what the live board
   * costs, and the floor storage cannot go below without losing product data.
   */
  reachableRefs: number;
  /** Revisions still retained for in-flight readers, oldest first. */
  retainedGenerationRevisions: number[];
  /**
   * How many shard objects this board's retention chain still holds that have
   * aged out. The same number whether or not the run was confirmed, so an
   * operator can compare a report against the run that follows it.
   */
  reclaimableRefs: number;
  reclaimedRefs: number;
  retainedRefs: number;
  lastSweep: BoardSweepReport;
}

export class ShardedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly pointerUrl: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private lastSweep: BoardSweepReport = {
    revision: null,
    reclaimed: 0,
    retained: 0,
    at: null,
    error: null,
  };

  constructor(options: SignedBoardStoreOptions = {}) {
    if (options.maxAttempts !== undefined && options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be positive');
    }
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? '/_skrynia').replace(/\/$/, '');
    this.pointerUrl = `${this.baseUrl}/store/antonina/${encodeURIComponent(POINTER_KEY)}`;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  private async locator(storageCapability: string, logicalRef: string): Promise<string> {
    const bytes = textEncoder.encode(storageCapability + ':' + logicalRef);
    return 'board-v3-' + base64UrlEncode(await sha256(bytes));
  }

  private async url(storageCapability: string, logicalRef: string): Promise<string> {
    return `${this.baseUrl}/store/antonina/${encodeURIComponent(await this.locator(storageCapability, logicalRef))}`;
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new ShardedBoardStoreError(`${context} returned invalid JSON`, { cause });
    }
  }

  private error(method: string, key: string, response: Response): ShardedBoardStoreError {
    return new ShardedBoardStoreError(
      `Skrynia ${method} Antonina ${key} failed (${response.status})`,
      { status: response.status, method },
    );
  }

  async readPointer(): Promise<JsonObject<ShardedBoardPointer> | null> {
    const response = await this.fetcher(this.pointerUrl, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.error('GET', POINTER_KEY, response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new ShardedBoardStoreError('Skrynia board pointer returned no ETag');
    const value = await this.parseJson(response, 'Skrynia board pointer');
    const pointer = pointerOf(value);
    return pointer === null ? null : { value: pointer, etag };
  }

  private async getJson<T>(storageCapability: string, logicalRef: string): Promise<JsonObject<T> | null> {
    const response = await this.fetcher(await this.url(storageCapability, logicalRef), { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.error('GET', logicalRef, response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new ShardedBoardStoreError(`Skrynia v3 object ${logicalRef} returned no ETag`);
    return {
      value: await this.parseJson(response, `Skrynia v3 object ${logicalRef}`) as T,
      etag,
    };
  }

  private async requireJson<T>(storageCapability: string, logicalRef: string): Promise<JsonObject<T>> {
    const value = await this.getJson<T>(storageCapability, logicalRef);
    if (value === null) {
      throw new ShardedBoardStoreError('Antonina board key does not open the current materialized snapshot');
    }
    return value;
  }

  /**
   * Publishes one shard under the ref its own content names.
   *
   * The mode is `capability-write`, not `immutable`, and that is the whole fix.
   * Nothing is overwritten either way -- a POST against an occupied ref is a 409
   * and is confirmed below, not forced -- so no reader can observe a shard
   * change under it, and a crash before the pointer CAS still leaves objects no
   * reader can reach. What changes is that a superseded shard is now *deletable*
   * once the pointer has moved past it, which is what lets the object count
   * track the live board instead of the mutation count.
   *
   * The 409 confirmation re-derives the stored object's ref from its content
   * rather than comparing the response to what was sent. A content-addressed ref
   * makes that the only check that is exact: the stored bytes may be ordered
   * differently from the canonical bytes that were hashed, so a structural
   * comparison would accept a value that is not the one this ref names.
   */
  private async writeShard(
    storageCapability: string,
    value: unknown,
  ): Promise<string> {
    const ref = await shardRef(value);
    const response = await this.fetcher(await this.url(storageCapability, ref), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'capability-write',
        'X-Skrynia-Capability': storageCapability,
      },
      body: JSON.stringify(value),
    });
    if (response.status === 201) return ref;
    if (response.status !== 409) throw this.error('POST', ref, response);
    const current = await this.requireJson<unknown>(storageCapability, ref);
    if (await shardRef(current.value) !== ref) {
      throw new ShardedBoardStoreError(`Antonina shard collision at ${ref}`);
    }
    return ref;
  }

  /**
   * Removes one superseded shard. Best-effort by design: this runs after the
   * pointer has already committed, so a failure here is a leak, never a lost
   * write, and it is counted and reported rather than thrown.
   */
  private async deleteShard(storageCapability: string, ref: string): Promise<boolean> {
    const response = await this.fetcher(await this.url(storageCapability, ref), {
      method: 'DELETE',
      headers: { 'X-Skrynia-Capability': storageCapability },
    });
    if (response.status === 200) return true;
    // 404 is already the goal state, and 403 is a shard written under the
    // pre-fix immutable mode, which Skrynia will not delete. Both are counted
    // by the caller, which reports them rather than repeating them forever.
    return false;
  }

  private async commitPointer(
    storageCapability: string,
    etag: string,
    pointer: ShardedBoardPointer,
  ): Promise<boolean> {
    const response = await this.fetcher(this.pointerUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Capability': storageCapability,
        'If-Match': etag,
      },
      body: JSON.stringify(pointer),
    });
    if (response.status === 412) return false;
    if (response.status !== 200) throw this.error('PUT', POINTER_KEY, response);
    return true;
  }

  private async readMeta(
    pointer: ShardedBoardPointer,
    credential: BoardCredential,
  ): Promise<ShardedBoardMeta> {
    const anchor = credentialTrustAnchor(credential);
    if (pointer.boardId !== anchor.boardId || pointer.rootKeyId !== anchor.rootKeyId) {
      throw new ShardedBoardStoreError('Antonina board pointer does not match this credential');
    }
    const stored = await this.requireJson<unknown>(credential.storageCapability, pointer.metaRef);
    const meta = parseMeta(stored.value);
    if (meta.boardId !== pointer.boardId
        || meta.rootKeyId !== pointer.rootKeyId
        || meta.head !== pointer.head
        || meta.revision !== pointer.revision) {
      throw new ShardedBoardStoreError('Antonina materialized metadata does not match its board pointer');
    }
    return meta;
  }

  /**
   * Reads a meta the pointer does not name, which is how the retention chain is
   * walked. The board identity is still checked -- a chain that led to another
   * board's meta would be a store-wide corruption, not a stale read -- but there
   * is no head or revision to cross-check against, because that is exactly what
   * makes the meta an ancestor.
   *
   * It returns `null` for a ref that is already gone rather than throwing. The
   * chain records what was superseded, not what survives: a board that has been
   * reclaiming has already deleted most of its ancestors, so a missing one is
   * the normal end of the walk and not a corrupt store.
   */
  private async readAncestorMeta(
    credential: BoardCredential,
    ref: string,
  ): Promise<ShardedBoardMeta | null> {
    const anchor = credentialTrustAnchor(credential);
    const stored = await this.getJson<unknown>(credential.storageCapability, ref);
    if (stored === null) return null;
    const meta = parseMeta(stored.value);
    if (meta.boardId !== anchor.boardId || meta.rootKeyId !== anchor.rootKeyId) {
      throw new ShardedBoardStoreError('Antonina retained metadata belongs to another board');
    }
    return meta;
  }

  private async readDirectoryPage(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    page: number,
  ): Promise<DirectoryPage | null> {
    const ref = meta.directoryRefs[page - 1];
    if (ref === undefined || ref === null) return null;
    const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || value.page !== page
        || !Array.isArray(value.entries)) {
      throw new ShardedBoardStoreError('Antonina issue directory page is malformed');
    }
    const entries = value.entries.map((entry) => {
      if (!isRecord(entry) || !Number.isSafeInteger(entry.number) || typeof entry.ref !== 'string') {
        throw new ShardedBoardStoreError('Antonina issue directory entry is malformed');
      }
      return { number: entry.number as number, ref: entry.ref };
    });
    return {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      page,
      entries,
    };
  }

  private async readIssueSnapshot(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    ref: string,
    withMessages: boolean,
  ): Promise<{ snapshot: IssueSnapshot; issue: BoardIssue | null }> {
    const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || !Number.isSafeInteger(value.number)
        || typeof value.deleted !== 'boolean'
        || (value.issue !== null && !isRecord(value.issue))
        || (value.closedAt !== null && typeof value.closedAt !== 'string')
        || !Number.isSafeInteger(value.messageCount)
        || !Array.isArray(value.commentRefs)) {
      throw new ShardedBoardStoreError('Antonina issue snapshot is malformed');
    }
    // A tombstone has no core to validate. It is the only shape in which `issue`
    // is null, and it exists so the deleted issue's comment pages stay pinned.
    const coreValue = value.issue;
    let core: IssueCore | null = null;
    if (coreValue !== null) {
      if (!Number.isSafeInteger(coreValue.number)
          || typeof coreValue.title !== 'string'
          || typeof coreValue.body !== 'string'
          || (coreValue.state !== 'open' && coreValue.state !== 'closed')
          || typeof coreValue.createdAt !== 'string'
          || typeof coreValue.updatedAt !== 'string') {
        throw new ShardedBoardStoreError('Antonina issue core is malformed');
      }
      core = {
        number: coreValue.number as number,
        title: coreValue.title,
        body: coreValue.body,
        state: coreValue.state,
        createdAt: coreValue.createdAt,
        updatedAt: coreValue.updatedAt,
      };
      if (core.number !== (value.number as number)) {
        throw new ShardedBoardStoreError('Antonina issue snapshot number mismatch');
      }
    }
    if (value.deleted === true && core !== null) {
      throw new ShardedBoardStoreError('Antonina tombstone snapshot carries an issue core');
    }
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      number: value.number as number,
      deleted: value.deleted,
      issue: core,
      closedAt: value.closedAt,
      messageCount: requireSafeCount(value.messageCount, 'message count'),
      commentRefs: value.commentRefs.map((entry) => requireText(entry, 'comment reference')),
    };
    if (!withMessages || core === null) {
      return { snapshot, issue: core === null ? null : issueFromCore(core, []) };
    }

    const pages = await Promise.all(snapshot.commentRefs.map(async (commentRef, index) => {
      const pageStored = await this.requireJson<unknown>(credential.storageCapability, commentRef);
      const pageValue = pageStored.value;
      if (!isRecord(pageValue)
          || pageValue.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
          || pageValue.boardId !== meta.boardId
          || pageValue.number !== snapshot.number
          || pageValue.page !== index + 1
          || !Array.isArray(pageValue.messages)) {
        throw new ShardedBoardStoreError('Antonina comment page is malformed');
      }
      return clone(pageValue.messages as BoardMessage[]);
    }));
    const messages = pages.flat();
    if (messages.length !== snapshot.messageCount) {
      throw new ShardedBoardStoreError('Antonina issue message count does not match its comment pages');
    }
    return { snapshot, issue: issueFromCore(core, messages) };
  }

  /**
   * Resolves an issue by number through the directory, tombstone or not. This is
   * the resolution a feed entry uses, so it must not skip the tombstone: a
   * comment on a deleted issue is still board history and still has to hydrate.
   */
  private async readIssueSnapshotByNumber(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    number: number,
  ): Promise<{ snapshot: IssueSnapshot; issue: BoardIssue | null } | null> {
    const directory = await this.readDirectoryPage(credential, meta, directoryPageNumber(number));
    const entry = directory?.entries.find((candidate) => candidate.number === number);
    if (entry === undefined) return null;
    return this.readIssueSnapshot(credential, meta, entry.ref, true);
  }

  private async readQueue(credential: BoardCredential, meta: ShardedBoardMeta): Promise<number[]> {
    const stored = await this.requireJson<unknown>(credential.storageCapability, meta.queueRef);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || !Array.isArray(value.numbers)
        || !value.numbers.every((number) => Number.isSafeInteger(number))) {
      throw new ShardedBoardStoreError('Antonina queue snapshot is malformed');
    }
    return [...value.numbers as number[]];
  }

  private async readCatalog(credential: BoardCredential, meta: ShardedBoardMeta): Promise<CatalogSnapshot> {
    const stored = await this.requireJson<unknown>(credential.storageCapability, meta.catalogRef);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || !Array.isArray(value.resources)
        || !Array.isArray(value.targets)
        || !Array.isArray(value.dispatches)) {
      throw new ShardedBoardStoreError('Antonina catalog snapshot is malformed');
    }
    return {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      resources: clone(value.resources as BoardResource[]),
      targets: clone(value.targets as BoardExecutionTarget[]),
      dispatches: clone(value.dispatches as BoardDispatch[]),
    };
  }

  private async readBundle(
    credential: BoardCredential,
    pointer: ShardedBoardPointer,
  ): Promise<StateBundle> {
    const meta = await this.readMeta(pointer, credential);
    const directoryPages = new Map<number, DirectoryPage>();
    const issueRefs = new Map<number, string>();
    for (let page = 1; page <= meta.directoryRefs.length; page += 1) {
      const directory = await this.readDirectoryPage(credential, meta, page);
      if (directory === null) continue;
      directoryPages.set(page, directory);
      for (const entry of directory.entries) issueRefs.set(entry.number, entry.ref);
    }
    const issueSnapshots = new Map<number, IssueSnapshot>();
    const messageCounts = new Map<number, number>();
    const closedAt = new Map<number, string>();
    const issues = await Promise.all([...issueRefs.entries()].map(async ([number, ref]) => {
      const result = await this.readIssueSnapshot(credential, meta, ref, true);
      issueSnapshots.set(number, result.snapshot);
      messageCounts.set(number, result.snapshot.messageCount);
      if (result.snapshot.closedAt !== null) closedAt.set(number, result.snapshot.closedAt);
      // A tombstone keeps its directory entry and its comment pages pinned, and
      // contributes no issue to the board: it is a reachability record, not a
      // live one.
      return result.issue;
    }));
    const live = issues.filter((issue): issue is BoardIssue => issue !== null);
    live.sort((left, right) => left.number - right.number);
    const queue = await this.readQueue(credential, meta);
    const catalog = await this.readCatalog(credential, meta);
    const board: Board = {
      schemaVersion: 3,
      nextIssueNumber: meta.nextIssueNumber,
      issues: live,
      resources: catalog.resources,
      targets: catalog.targets,
      dispatches: catalog.dispatches,
    };
    return {
      meta,
      state: {
        board,
        queue,
        authorities: [],
        deleted: meta.deleted,
        head: meta.head,
        // Shards are read in the current format. A board that was migrated
        // into this store recorded that in `meta.migratedFrom` when it was
        // written, not on every read, so the read itself migrated nothing.
        migration: unMigratedBoardReport(),
      },
      issueRefs,
      issueSnapshots,
      messageCounts,
      closedAt,
      directoryPages,
    };
  }

  private async readMutationBundle(
    credential: BoardCredential,
    pointer: ShardedBoardPointer,
  ): Promise<StateBundle> {
    const meta = await this.readMeta(pointer, credential);
    const [queue, catalog, openPages, closedPages] = await Promise.all([
      this.readQueue(credential, meta),
      this.readCatalog(credential, meta),
      Promise.all(meta.openPageRefs.map((_, index) =>
        this.readIssuePageFromMeta(credential, meta, 'open', index + 1))),
      Promise.all(meta.closedPageRefs.map((_, index) =>
        this.readIssuePageFromMeta(credential, meta, 'closed', index + 1))),
    ]);
    const summaries = [
      ...openPages.flatMap((page) => page.entries),
      ...closedPages.flatMap((page) => page.entries),
    ];
    const closedAt = new Map<number, string>();
    const messageCounts = new Map<number, number>();
    for (const summary of summaries) {
      messageCounts.set(summary.number, summary.messageCount);
      if (summary.closedAt !== null) closedAt.set(summary.number, summary.closedAt);
    }
    const issues = summaries.map(issueFromSummary).sort((left, right) => left.number - right.number);
    return {
      meta,
      state: {
        board: {
          schemaVersion: 3,
          nextIssueNumber: meta.nextIssueNumber,
          issues,
          resources: catalog.resources,
          targets: catalog.targets,
          dispatches: catalog.dispatches,
        },
        queue,
        authorities: [],
        deleted: meta.deleted,
        head: meta.head,
        migration: unMigratedBoardReport(),
      },
      issueRefs: new Map(),
      issueSnapshots: new Map(),
      messageCounts,
      closedAt,
      directoryPages: new Map(),
    };
  }

  private async materializeIssue(
    credential: BoardCredential,
    boardId: string,
    issue: BoardIssue,
    closedAt: string | null,
    previous?: IssueSnapshot,
    commentsChanged = false,
  ): Promise<{ ref: string; superseded: string[] }> {
    let commentRefs = previous === undefined ? [] : [...previous.commentRefs];
    const superseded: string[] = [];
    if (commentsChanged) {
      const pageNumber = Math.floor((issue.messages.length - 1) / V3_COMMENT_PAGE_SIZE) + 1;
      const pageEntries = issue.messages.slice(
        (pageNumber - 1) * V3_COMMENT_PAGE_SIZE,
        pageNumber * V3_COMMENT_PAGE_SIZE,
      );
      const page: CommentPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        number: issue.number,
        page: pageNumber,
        messages: clone(pageEntries),
      };
      // The tail page is rewritten by every later comment, so it is the one
      // comment page that is superseded often. That is bounded by the sweep and
      // not by the number of comments: pages before it are never rewritten, so
      // they resolve to the same refs for the life of the issue.
      const ref = await this.writeShard(credential.storageCapability, page);
      if (commentRefs.length < pageNumber) commentRefs.push(ref);
      else {
        superseded.push(commentRefs[pageNumber - 1]!);
        commentRefs[pageNumber - 1] = ref;
      }
    }
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      number: issue.number,
      deleted: false,
      issue: coreOf(issue),
      closedAt,
      messageCount: issue.messages.length,
      commentRefs,
    };
    return { ref: await this.writeShard(credential.storageCapability, snapshot), superseded };
  }

  /**
   * The tombstone written in place of a deleted issue's snapshot. It pins the
   * comment pages that were live at deletion, which is all of them: a deleted
   * issue takes no further comments, so those pages stop being rewritten and
   * stay valid for the feed indefinitely.
   */
  private async materializeTombstone(
    credential: BoardCredential,
    boardId: string,
    number: number,
    previous: IssueSnapshot,
  ): Promise<string> {
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      number,
      deleted: true,
      issue: null,
      closedAt: null,
      messageCount: previous.messageCount,
      commentRefs: [...previous.commentRefs],
    };
    return this.writeShard(credential.storageCapability, snapshot);
  }

  private async writeDirectoryPage(
    credential: BoardCredential,
    boardId: string,
    page: number,
    entries: DirectoryEntry[],
    superseded: string | null,
  ): Promise<{ ref: string; superseded: string[] }> {
    const value: DirectoryPage = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      page,
      entries: [...entries].sort((left, right) => left.number - right.number),
    };
    const ref = await this.writeShard(credential.storageCapability, value);
    return { ref, superseded: superseded === null ? [] : [superseded] };
  }

  /**
   * Writes the list pages and reports which previous refs they replaced.
   *
   * The replaced set is not a cache and not a second bookkeeping pass: it is
   * what makes reclamation possible without enumerating anything. The invariant
   * is that a mutation carries every shard it did not change forward by
   * reference, so the refs a generation stops pinning are exactly the ones its
   * successor replaced -- and the successor is the only writer that knows them.
   * The pages past the end of a shortened list are replaced by nothing, so they
   * are reported explicitly rather than by comparing the two ref lists.
   */
  private async writeIssueListPages(
    credential: BoardCredential,
    boardId: string,
    state: VerifiedBoardState,
    closedAt: Map<number, string>,
    issueState: IssueState,
    previousState: VerifiedBoardState | null,
    previousClosedAt: Map<number, string> | null,
    previousRefs: string[],
    messageCounts?: Map<number, number>,
    previousMessageCounts?: Map<number, number>,
  ): Promise<{ refs: string[]; superseded: string[] }> {
    const nextPages = paginate(
      orderedSummaries(state, closedAt, issueState, messageCounts),
      V3_ISSUE_PAGE_SIZE,
    );
    const previousPages = previousState === null || previousClosedAt === null
      ? []
      : paginate(
          orderedSummaries(previousState, previousClosedAt, issueState, previousMessageCounts),
          V3_ISSUE_PAGE_SIZE,
        );
    const refs: string[] = [];
    const superseded: string[] = [];
    for (let index = 0; index < nextPages.length; index += 1) {
      const entries = nextPages[index]!;
      const previous = previousPages[index];
      // Carrying the previous ref forward when the page is byte-identical is
      // what makes a mutation that does not touch this list free. It is a
      // consequence of the ref naming content, not a separate cache: the ref
      // that would be written is the ref already stored, so the POST is a 409
      // confirmation.
      if (previous !== undefined && jsonSame(previous, entries) && previousRefs[index] !== undefined) {
        refs.push(previousRefs[index]!);
        continue;
      }
      const value: StoredIssueListPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        state: issueState,
        page: index + 1,
        total: state.board.issues.filter((issue) => issue.state === issueState).length,
        entries: clone(entries),
      };
      const ref = await this.writeShard(credential.storageCapability, value);
      const previousRef = previousRefs[index];
      if (previousRef !== undefined) superseded.push(previousRef);
      refs.push(ref);
    }
    for (let index = nextPages.length; index < previousRefs.length; index += 1) {
      superseded.push(previousRefs[index]!);
    }
    return { refs, superseded };
  }

  private async appendFeed(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    entry: BoardFeedEntry | null,
    commentIndex?: number,
  ): Promise<{ refs: string[]; count: number; superseded: string[] }> {
    if (entry === null) {
      return { refs: [...meta.feedPageRefs], count: meta.feedCount, superseded: [] };
    }
    const refs = [...meta.feedPageRefs];
    const pageNumber = Math.floor(meta.feedCount / V3_FEED_PAGE_SIZE) + 1;
    let entries: StoredFeedEntry[] = [];
    if (meta.feedCount % V3_FEED_PAGE_SIZE !== 0) {
      const previousRef = refs[pageNumber - 1];
      if (previousRef === undefined) throw new ShardedBoardStoreError('Antonina feed page reference is missing');
      const previous = await this.requireJson<unknown>(credential.storageCapability, previousRef);
      if (!isRecord(previous.value) || !Array.isArray(previous.value.entries)) {
        throw new ShardedBoardStoreError('Antonina feed page is malformed');
      }
      entries = clone(previous.value.entries as StoredFeedEntry[]);
    }
    entries.push(compactFeedEntry(entry, commentIndex));
    const page: FeedPage = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      page: pageNumber,
      entries,
    };
    // Only the tail feed page is rewritten; every sealed page is carried in
    // `refs` and never written again, so feed storage is O(entries) rather than
    // O(entries^2).
    const ref = await this.writeShard(credential.storageCapability, page);
    const superseded = refs[pageNumber - 1] === undefined ? [] : [refs[pageNumber - 1]!];
    refs[pageNumber - 1] = ref;
    return { refs, count: meta.feedCount + 1, superseded };
  }

  private async writeQueueSnapshot(
    credential: BoardCredential,
    boardId: string,
    numbers: number[],
  ): Promise<string> {
    const value: QueueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      numbers: [...numbers],
    };
    return this.writeShard(credential.storageCapability, value);
  }

  private async writeCatalogSnapshot(
    credential: BoardCredential,
    boardId: string,
    board: Board,
  ): Promise<string> {
    const value: CatalogSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      resources: clone(board.resources),
      targets: clone(board.targets),
      dispatches: clone(board.dispatches),
    };
    return this.writeShard(credential.storageCapability, value);
  }

  private async writeMeta(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
  ): Promise<string> {
    return this.writeShard(credential.storageCapability, meta);
  }

  /**
   * Every shard object one generation's meta pins, as refs.
   *
   * This is the reachability closure, and it is used only by `compact`'s report
   * -- never on the mutation path. Enumerating it requires reading every
   * directory page and every issue snapshot, which is precisely the work the
   * summary-only read path exists to avoid, so a mutation derives what it may
   * delete from the shards it itself replaced instead. Skrynia exposes no
   * listing primitive to Antonina, so this closure is also the only shard set
   * that can be reasoned about at all: anything not named by a meta is invisible
   * to a writer, which is why the superseded meta objects are reclaimed through
   * the retention chain rather than by scanning.
   */
  private async pinnedRefs(credential: BoardCredential, meta: ShardedBoardMeta): Promise<Set<string>> {
    const refs = new Set<string>([
      ...meta.openPageRefs,
      ...meta.closedPageRefs,
      ...meta.feedPageRefs,
      meta.queueRef,
      meta.catalogRef,
    ]);
    for (let page = 1; page <= meta.directoryRefs.length; page += 1) {
      const ref = meta.directoryRefs[page - 1];
      if (ref === null || ref === undefined) continue;
      refs.add(ref);
      const directory = await this.readDirectoryPage(credential, meta, page);
      for (const entry of directory?.entries ?? []) {
        refs.add(entry.ref);
        const snapshot = await this.readIssueSnapshot(credential, meta, entry.ref, false);
        for (const commentRef of snapshot.snapshot.commentRefs) refs.add(commentRef);
      }
    }
    return refs;
  }

  /**
   * Deletes the refs a committed mutation superseded.
   *
   * It runs after the pointer has already committed and never throws: the
   * commit is the mutation, and a failed reclamation is a leak that the next
   * mutation retries, not a failed write. The count of what it could not delete
   * is returned so an operator can see a board whose reclamation is not keeping
   * up -- which is exactly the state a board upgraded from the immutable model
   * is in, because Skrynia refuses to delete an immutable object at all.
   */
  private async reclaim(
    credential: BoardCredential,
    refs: string[],
  ): Promise<{ reclaimed: number; retained: number }> {
    let reclaimed = 0;
    for (const ref of new Set(refs)) {
      if (await this.deleteShard(credential.storageCapability, ref)) reclaimed += 1;
    }
    return { reclaimed, retained: new Set(refs).size - reclaimed };
  }

  /**
   * Deletes the meta objects that have aged past the retention window.
   *
   * A meta is outside the shard closure because the pointer names it, and it is
   * the one object that is necessarily different on every generation. Without
   * this the fix would move the unbounded growth from shards to metas and the
   * store would still grow with the mutation count, just more slowly.
   *
   * The walk descends from the superseded generation and tolerates a chain that
   * has already been cut. It has to: the chain records what was superseded, not
   * what still exists, and a healthy board's ancestors are reclaimed by earlier
   * walks, so a missing ref is the normal end of the walk rather than an error.
   */
  private async reclaimRetention(
    credential: BoardCredential,
    superseded: ShardedBoardMeta,
  ): Promise<number> {
    let cursor = superseded.retainsMetaRef;
    for (let kept = 1; cursor !== null && kept < RETAINED_GENERATIONS; kept += 1) {
      const meta = await this.readAncestorMeta(credential, cursor);
      if (meta === null) return 0;
      cursor = meta.retainsMetaRef;
    }
    let reclaimed = 0;
    for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
      if (await this.deleteShard(credential.storageCapability, cursor)) reclaimed += 1;
      const meta = await this.readAncestorMeta(credential, cursor);
      if (meta === null) break;
      cursor = meta.retainsMetaRef;
    }
    return reclaimed;
  }

  async migrate(
    stored: StoredSignedBoard,
    credentialValue: BoardCredential,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    if (stored.state.deleted) throw new ShardedBoardStoreError('Antonina board has been deleted');

    const revision = 1;
    const head = stored.state.head;
    const closedAt = stored.log === null
      ? closedAtFromBoard(stored.state.board)
      : closedAtFromLegacy(stored.log, stored.state.board);
    const issueRefs = new Map<number, string>();
    const directoryPages = new Map<number, DirectoryEntry[]>();
    const commentIndexes = new Map<string, number>();

    for (const issue of stored.state.board.issues) {
      const commentRefs: string[] = [];
      const pages = paginate(issue.messages, V3_COMMENT_PAGE_SIZE);
      for (let index = 0; index < pages.length; index += 1) {
        const page = index + 1;
        const messages = pages[index]!;
        const value: CommentPage = {
          schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
          boardId: anchor.boardId,
          number: issue.number,
          page,
          messages: clone(messages),
        };
        commentRefs.push(await this.writeShard(credential.storageCapability, value));
        for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
          commentIndexes.set(messages[messageIndex]!.id, (page - 1) * V3_COMMENT_PAGE_SIZE + messageIndex);
        }
      }
      const snapshot: IssueSnapshot = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: anchor.boardId,
        number: issue.number,
        deleted: false,
        issue: coreOf(issue),
        closedAt: closedAt.get(issue.number) ?? null,
        messageCount: issue.messages.length,
        commentRefs,
      };
      const issueRef = await this.writeShard(credential.storageCapability, snapshot);
      issueRefs.set(issue.number, issueRef);
      const pageNumber = directoryPageNumber(issue.number);
      const entries = directoryPages.get(pageNumber) ?? [];
      entries.push({ number: issue.number, ref: issueRef });
      directoryPages.set(pageNumber, entries);
    }

    const maxDirectoryPage = stored.state.board.nextIssueNumber <= 1
      ? 0
      : directoryPageNumber(stored.state.board.nextIssueNumber - 1);
    const directoryRefs: Array<string | null> = [];
    for (let page = 1; page <= maxDirectoryPage; page += 1) {
      const entries = directoryPages.get(page);
      if (entries === undefined || entries.length === 0) {
        directoryRefs.push(null);
        continue;
      }
      directoryRefs.push((await this.writeDirectoryPage(credential, anchor.boardId, page, entries, null)).ref);
    }

    const queueRef = await this.writeQueueSnapshot(credential, anchor.boardId, stored.state.queue);
    const catalogRef = await this.writeCatalogSnapshot(credential, anchor.boardId, stored.state.board);

    const { refs: openPageRefs } = await this.writeIssueListPages(
      credential,
      anchor.boardId,
      stored.state,
      closedAt,
      'open',
      null,
      null,
      [],
    );
    const { refs: closedPageRefs } = await this.writeIssueListPages(
      credential,
      anchor.boardId,
      stored.state,
      closedAt,
      'closed',
      null,
      null,
      [],
    );

    // V3 feed positions are contiguous materialized-feed positions, not
    // offsets into the legacy operation log. Normalize once during migration so
    // later snapshot-native entries can append at feedCount without collisions
    // even when the old log contained non-feed operations.
    const legacyFeed: StoredFeedEntry[] = stored.log === null
      ? []
      : feedEntries(stored.log)
          .sort((left, right) => left.position - right.position)
          .map((entry, position) => {
            const positioned = { ...entry, position };
            const index = entry.kind === 'comment-added' && entry.messageId !== null
              ? commentIndexes.get(entry.messageId)
              : undefined;
            return compactFeedEntry(positioned, index);
          });
    const feedPageRefs: string[] = [];
    const feedPages = paginate(legacyFeed, V3_FEED_PAGE_SIZE);
    for (let index = 0; index < feedPages.length; index += 1) {
      const page: FeedPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: anchor.boardId,
        page: index + 1,
        entries: clone(feedPages[index]!),
      };
      feedPageRefs.push(await this.writeShard(credential.storageCapability, page));
    }

    const updatedAt = stored.log === null
      ? latestBoardTimestamp(stored.state.board, this.now().toISOString())
      : (stored.log.operations.at(-1)?.timestamp ?? this.now().toISOString());
    const meta: ShardedBoardMeta = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: anchor.boardId,
      rootKeyId: anchor.rootKeyId,
      head,
      revision,
      updatedAt,
      migratedFrom: stored.log === null ? null : head,
      nextIssueNumber: stored.state.board.nextIssueNumber,
      issueCount: stored.state.board.issues.length,
      openIssueCount: stored.state.board.issues.filter((issue) => issue.state === 'open').length,
      closedIssueCount: stored.state.board.issues.filter((issue) => issue.state === 'closed').length,
      directoryRefs,
      openPageRefs,
      closedPageRefs,
      queueRef,
      catalogRef,
      feedPageRefs,
      feedCount: legacyFeed.length,
      deleted: false,
      retainsMetaRef: null,
    };
    const metaRef = await this.writeMeta(credential, meta);
    const pointer: ShardedBoardPointer = {
      schemaVersion: 3,
      format: POINTER_FORMAT,
      boardId: anchor.boardId,
      rootKeyId: anchor.rootKeyId,
      head,
      revision,
      metaRef,
    };
    if (!await this.commitPointer(credential.storageCapability, stored.etag, pointer)) {
      throw new ShardedBoardStoreError('Antonina legacy board changed during migration', {
        status: 412,
        method: 'PUT',
      });
    }
    return {
      log: null,
      state: {
        ...clone(stored.state),
        authorities: [],
        head,
      },
      etag: `v3:${head}`,
    };
  }

  async read(
    credentialValue: BoardCredential,
  ): Promise<StoredSignedBoard | null> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointerStored = await this.readPointer();
    if (pointerStored === null) return null;
    const bundle = await this.readBundle(credential, pointerStored.value);
    return {
      log: null,
      state: bundle.state,
      etag: `v3:${pointerStored.value.head}`,
    };
  }

  private async appendInternal(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
    compact: boolean,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    if (request.kind === 'authority.delegate' || request.kind === 'authority.revoke') {
      throw new ShardedBoardStoreError('Antonina uses one shared board key; delegated authorities are disabled');
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const pointerStored = await this.readPointer();
      if (pointerStored === null) throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
      const pointer = pointerStored.value;
      const bundle = compact
        ? await this.readMutationBundle(credential, pointer)
        : await this.readBundle(credential, pointer);
      if (bundle.state.deleted) throw new ShardedBoardStoreError('Antonina board has been deleted');

      const rawPayload = typeof request.payload === 'function'
        ? request.payload(clone(bundle.state))
        : request.payload;
      const timestamp = canonicalTimestampAtOrAfter(
        request.timestamp ?? this.now().toISOString(),
        bundle.meta.updatedAt,
      );
      const nonce = request.nonce ?? this.newId();

      // Reuse the strict operation payload parser only as a validator and
      // normalizer. V3 does not persist, verify, or replay an operation log.
      const validated = parseUnsignedBoardOperation({
        schemaVersion: OPLOG_SCHEMA_VERSION,
        boardId: pointer.boardId,
        previous: pointer.head,
        signerKeyId: credential.rootKeyId,
        timestamp,
        nonce,
        kind: request.kind,
        payload: rawPayload,
      });
      const payload = validated.payload;
      const revision = pointer.revision + 1;
      const head = await sha256Id('sha256', canonicalBytes({
        boardId: pointer.boardId,
        previous: pointer.head,
        revision,
        timestamp,
        nonce,
        kind: request.kind,
        payload: payload as unknown as CanonicalValue,
      }));

      const payloadNumber = isRecord(payload) ? payload.number : undefined;
      const beforeIssueNumber = typeof payloadNumber === 'number' && Number.isSafeInteger(payloadNumber)
        ? payloadNumber
        : null;

      // The compact path starts from list summaries. Only issue mutations that
      // actually need the issue body/messages hydrate that one issue, and only
      // the directory page containing the touched issue is read. A delete reads
      // the snapshot but not its messages: the tombstone it writes carries the
      // comment refs, and the comments themselves are untouched by a delete.
      if (compact && beforeIssueNumber !== null && request.kind.startsWith('issue.')) {
        const pageNumber = directoryPageNumber(beforeIssueNumber);
        const directory = await this.readDirectoryPage(credential, bundle.meta, pageNumber);
        if (directory !== null) bundle.directoryPages.set(pageNumber, directory);
        const entry = directory?.entries.find((candidate) => candidate.number === beforeIssueNumber);
        if (request.kind !== 'issue.create' && entry !== undefined) {
          const detail = await this.readIssueSnapshot(
            credential,
            bundle.meta,
            entry.ref,
            request.kind !== 'issue.delete',
          );
          if (detail.issue === null) {
            throw new ShardedBoardStoreError(`Operation references deleted issue ${beforeIssueNumber}`);
          }
          bundle.issueSnapshots.set(beforeIssueNumber, detail.snapshot);
          const index = bundle.state.board.issues.findIndex(
            (issue) => issue.number === beforeIssueNumber,
          );
          if (index < 0) {
            throw new ShardedBoardStoreError(`Operation references missing issue ${beforeIssueNumber}`);
          }
          if (detail.issue === null) {
            throw new ShardedBoardStoreError(`Operation references deleted issue ${beforeIssueNumber}`);
          }
          bundle.state.board.issues[index] = detail.issue;
        }
      }

      const beforeIssue = beforeIssueNumber === null
        ? undefined
        : bundle.state.board.issues.find((issue) => issue.number === beforeIssueNumber);

      const pseudoOperation: SignedBoardOperation = {
        schemaVersion: OPLOG_SCHEMA_VERSION,
        boardId: pointer.boardId,
        previous: pointer.head,
        signerKeyId: credential.rootKeyId,
        timestamp,
        nonce,
        kind: request.kind,
        payload,
        opId: head,
        signature: '',
      };
      const applied = applyBoardMutation(
        pseudoOperation,
        bundle.state.board,
        bundle.state.queue,
      );
      const candidate: VerifiedBoardState = {
        board: applied.board,
        queue: applied.queue,
        authorities: [],
        deleted: applied.deleted,
        head,
        // A mutation does not re-migrate anything, so the candidate carries the
        // migration report of the bundle it was derived from rather than a
        // newly invented one.
        migration: bundle.state.migration,
      };

      const afterIssue = beforeIssueNumber === null
        ? candidate.board.issues.at(-1)
        : candidate.board.issues.find((issue) => issue.number === beforeIssueNumber);
      const nextClosedAt = new Map(bundle.closedAt);
      if (request.kind === 'issue.close' && beforeIssueNumber !== null) {
        nextClosedAt.set(beforeIssueNumber, timestamp);
      } else if ((request.kind === 'issue.reopen' || request.kind === 'issue.delete')
          && beforeIssueNumber !== null) {
        nextClosedAt.delete(beforeIssueNumber);
      }
      const nextMessageCounts = new Map(bundle.messageCounts);
      if (request.kind === 'issue.delete' && beforeIssueNumber !== null) {
        nextMessageCounts.delete(beforeIssueNumber);
      } else if (request.kind.startsWith('issue.') && beforeIssueNumber !== null && afterIssue !== undefined) {
        nextMessageCounts.set(beforeIssueNumber, afterIssue.messages.length);
      }

      const nextIssueRefs = new Map(bundle.issueRefs);
      const nextDirectoryRefs = [...bundle.meta.directoryRefs];
      // The refs this mutation stops pinning. Collected as the writer goes
      // rather than derived afterwards, so a mutation never has to enumerate
      // the board to find out what it may delete -- which is what would
      // otherwise force a full hydration on every write.
      const superseded: string[] = [];
      const issueMutation = request.kind.startsWith('issue.');
      if (issueMutation && beforeIssueNumber !== null) {
        const directoryPage = directoryPageNumber(beforeIssueNumber);
        const currentDirectory = bundle.directoryPages.get(directoryPage);
        const entries = currentDirectory === undefined ? [] : clone(currentDirectory.entries);
        const entryIndex = entries.findIndex((entry) => entry.number === beforeIssueNumber);
        const previousEntryRef = entryIndex >= 0 ? entries[entryIndex]!.ref : null;

        if (request.kind === 'issue.delete') {
          nextIssueRefs.delete(beforeIssueNumber);
          // The entry is replaced by a tombstone rather than removed, so the
          // deleted issue's comment pages stay pinned and its feed entries stay
          // resolvable. Its issue leaves the board: the tombstone carries no
          // core, so no reader counts it as live.
          const previousSnapshot = bundle.issueSnapshots.get(beforeIssueNumber);
          if (previousSnapshot === undefined) {
            throw new ShardedBoardStoreError(`Operation references missing issue ${beforeIssueNumber}`);
          }
          const tombstone = await this.materializeTombstone(
            credential,
            pointer.boardId,
            beforeIssueNumber,
            previousSnapshot,
          );
          if (previousEntryRef !== null) superseded.push(previousEntryRef);
          if (entryIndex >= 0) entries[entryIndex] = { number: beforeIssueNumber, ref: tombstone };
        } else {
          if (afterIssue === undefined) throw new ShardedBoardStoreError('Issue mutation produced no issue snapshot');
          const previousSnapshot = bundle.issueSnapshots.get(beforeIssueNumber);
          const materialized = await this.materializeIssue(
            credential,
            pointer.boardId,
            afterIssue,
            nextClosedAt.get(beforeIssueNumber) ?? null,
            previousSnapshot,
            request.kind === 'issue.comment',
          );
          nextIssueRefs.set(beforeIssueNumber, materialized.ref);
          superseded.push(...materialized.superseded);
          if (previousEntryRef !== null) superseded.push(previousEntryRef);
          if (entryIndex >= 0) entries[entryIndex] = { number: beforeIssueNumber, ref: materialized.ref };
          else entries.push({ number: beforeIssueNumber, ref: materialized.ref });
        }

        const previousDirectoryRef = nextDirectoryRefs[directoryPage - 1] ?? null;
        if (entries.length === 0) {
          nextDirectoryRefs[directoryPage - 1] = null;
          if (previousDirectoryRef !== null) superseded.push(previousDirectoryRef);
        } else {
          const written = await this.writeDirectoryPage(
            credential,
            pointer.boardId,
            directoryPage,
            entries,
            previousDirectoryRef,
          );
          nextDirectoryRefs[directoryPage - 1] = written.ref;
          superseded.push(...written.superseded);
        }
      } else if (request.kind === 'issue.create') {
        // The create payload always names the new issue, but keep this branch
        // for type clarity if the payload shape changes in the future.
        throw new ShardedBoardStoreError('Issue-create payload has no issue number');
      }

      while (nextDirectoryRefs.length > 0 && nextDirectoryRefs.at(-1) === null) {
        nextDirectoryRefs.pop();
      }

      const queueChanged = !jsonSame(bundle.state.queue, candidate.queue);
      const queueRef = queueChanged
        ? await this.writeQueueSnapshot(credential, pointer.boardId, candidate.queue)
        : bundle.meta.queueRef;
      if (queueChanged) superseded.push(bundle.meta.queueRef);

      const beforeCatalog = {
        resources: bundle.state.board.resources,
        targets: bundle.state.board.targets,
        dispatches: bundle.state.board.dispatches,
      };
      const afterCatalog = {
        resources: candidate.board.resources,
        targets: candidate.board.targets,
        dispatches: candidate.board.dispatches,
      };
      const catalogChanged = !jsonSame(beforeCatalog, afterCatalog);
      const catalogRef = catalogChanged
        ? await this.writeCatalogSnapshot(credential, pointer.boardId, candidate.board)
        : bundle.meta.catalogRef;
      if (catalogChanged) superseded.push(bundle.meta.catalogRef);

      const open = await this.writeIssueListPages(
        credential,
        pointer.boardId,
        candidate,
        nextClosedAt,
        'open',
        bundle.state,
        bundle.closedAt,
        bundle.meta.openPageRefs,
        nextMessageCounts,
        bundle.messageCounts,
      );
      const closed = await this.writeIssueListPages(
        credential,
        pointer.boardId,
        candidate,
        nextClosedAt,
        'closed',
        bundle.state,
        bundle.closedAt,
        bundle.meta.closedPageRefs,
        nextMessageCounts,
        bundle.messageCounts,
      );
      superseded.push(...open.superseded, ...closed.superseded);
      const openPageRefs = open.refs;
      const closedPageRefs = closed.refs;

      const feedEntry = feedEntryForMutation(
        request.kind,
        payload,
        beforeIssue,
        afterIssue,
        head,
        timestamp,
        bundle.meta.feedCount,
      );
      // The index is the comment's own position in the issue, which is what
      // makes it stable: a comment page is rewritten by every later comment, so
      // a ref recorded here would name an object the reclamation may delete,
      // while an index resolves against whatever the issue pins now.
      const feedCommentIndex = request.kind === 'issue.comment' && afterIssue !== undefined
        ? afterIssue.messages.length - 1
        : undefined;
      const feed = await this.appendFeed(credential, bundle.meta, feedEntry, feedCommentIndex);
      superseded.push(...feed.superseded);

      const meta: ShardedBoardMeta = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: pointer.boardId,
        rootKeyId: pointer.rootKeyId,
        head,
        revision,
        updatedAt: timestamp,
        migratedFrom: bundle.meta.migratedFrom,
        nextIssueNumber: candidate.board.nextIssueNumber,
        issueCount: candidate.board.issues.length,
        openIssueCount: candidate.board.issues.filter((issue) => issue.state === 'open').length,
        closedIssueCount: candidate.board.issues.filter((issue) => issue.state === 'closed').length,
        directoryRefs: nextDirectoryRefs,
        openPageRefs,
        closedPageRefs,
        queueRef,
        catalogRef,
        feedPageRefs: feed.refs,
        feedCount: feed.count,
        deleted: candidate.deleted,
        // Both reclamation facts are about the commit that is about to happen,
        // so the first generation that can report them is the next one. They are
        // carried here rather than in the returning value because the return
        // value is the mutation's result, not the store's health.


        retainsMetaRef: pointer.metaRef,
      };
      const metaRef = await this.writeMeta(credential, meta);
      const nextPointer: ShardedBoardPointer = {
        schemaVersion: 3,
        format: POINTER_FORMAT,
        boardId: pointer.boardId,
        rootKeyId: pointer.rootKeyId,
        head,
        revision,
        metaRef,
      };
      if (!await this.commitPointer(
        credential.storageCapability,
        pointerStored.etag,
        nextPointer,
      )) {
        // The objects this attempt wrote are unreferenced and the pointer never
        // moved, so they are inert. The next attempt re-derives the same shards
        // and its own reclamation covers them, which is why nothing is swept
        // here: a lost race must not delete shards a winning writer is about to
        // publish.
        continue;
      }
      await this.sweepAfterCommit(credential, bundle.meta, meta, superseded);
      return {
        log: null,
        state: candidate,
        etag: `v3:${head}`,
      };
    }

    throw new ShardedBoardStoreError('Antonina board changed too often; mutation was not committed');
  }

  /**
   * The reclamation that follows a committed mutation, isolated so that a
   * failure in it cannot fail the mutation.
   *
   * This is the only place superseded materialization is removed, and it runs
   * strictly after the pointer CAS: before the commit the superseded generation
   * is still what a concurrent reader is reading, and after it the new
   * generation is what every reader will see. Everything it deletes is named by
   * the superseded generation's own meta and by nothing in the new one.
   */
  private async sweepAfterCommit(
    credential: BoardCredential,
    supersededMeta: ShardedBoardMeta,
    committed: ShardedBoardMeta,
    supersededRefs: string[],
  ): Promise<void> {
    try {
      const shards = await this.reclaim(credential, supersededRefs);
      const metas = await this.reclaimRetention(credential, supersededMeta);
      this.lastSweep = {
        revision: committed.revision,
        reclaimed: shards.reclaimed + metas,
        retained: shards.retained,
        at: this.now().toISOString(),
        error: null,
      };
    } catch (error) {
      // A leak, not a lost write. Recorded so the compaction report can say so.
      this.lastSweep = {
        revision: committed.revision,
        reclaimed: 0,
        retained: 0,
        at: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
  ): Promise<StoredSignedBoard> {
    return this.appendInternal(credentialValue, request, false);
  }

  async appendFast(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
  ): Promise<StoredSignedBoard> {
    return this.appendInternal(credentialValue, request, true);
  }

  private async requirePointerForCredential(
    credentialValue: BoardCredential,
  ): Promise<{ credential: BoardCredential; pointer: ShardedBoardPointer; meta: ShardedBoardMeta }> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointerStored = await this.readPointer();
    if (pointerStored === null) throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
    const meta = await this.readMeta(pointerStored.value, credential);
    return { credential, pointer: pointerStored.value, meta };
  }

  /**
   * What the last mutation's reclamation did. Read by the compaction report, and
   * exposed here so a test can assert reclamation happened without having to
   * count objects in the fake store.
   */
  sweepReport(): BoardSweepReport {
    return { ...this.lastSweep };
  }

  /**
   * Reports the store's storage shape, and reclaims what this board's own
   * retention chain says has aged out when `confirm` is set.
   *
   * Reclamation is behind an explicit confirmation for the same reason
   * `collect delete` is: it deletes objects, so a front end must be able to show
   * an operator what would go before anything goes. Without `confirm` this
   * computes the same numbers and deletes nothing.
   *
   * On a board that has been sweeping since the fix there is nothing left to
   * reclaim and the report is a description of a healthy store. Its purpose is
   * the board that has NOT been sweeping -- one written by the pre-fix immutable
   * model, whose superseded objects Antonina cannot delete because Skrynia
   * refuses to delete an immutable object -- and the honest accounting of what
   * remains there.
   */
  async compact(
    credentialValue: BoardCredential,
    options: { confirm?: boolean } = {},
  ): Promise<BoardCompactionReport> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointerStored = await this.readPointer();
    if (pointerStored === null) {
      throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
    }
    const meta = await this.readMeta(pointerStored.value, credential);
    const reachable = await this.pinnedRefs(credential, meta);
    // The chain records history, not survival, so a missing ancestor ends the
    // walk rather than failing the report. On a board that has been reclaiming
    // that is the ordinary case.
    const chain: Array<{ ref: string; revision: number }> = [];
    let cursor: string | null = meta.retainsMetaRef;
    for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
      const ancestor = await this.readAncestorMeta(credential, cursor);
      if (ancestor === null) break;
      chain.push({ ref: cursor, revision: ancestor.revision });
      cursor = ancestor.retainsMetaRef;
    }
    const retainedMetas = chain.slice(0, RETAINED_GENERATIONS);
    const staleMetas = chain.slice(RETAINED_GENERATIONS);
    let reclaimed = 0;
    if (options.confirm === true) {
      for (const { ref } of staleMetas) {
        if (await this.deleteShard(credential.storageCapability, ref)) reclaimed += 1;
      }
    }
    return {
      boardId: meta.boardId,
      revision: meta.revision,
      reachableRefs: reachable.size,
      retainedGenerationRevisions: retainedMetas.map((entry) => entry.revision),
      reclaimedRefs: reclaimed,
      reclaimableRefs: staleMetas.length,
      retainedRefs: staleMetas.length - reclaimed,
      lastSweep: this.sweepReport(),
    };
  }

  async getIssue(
    credentialValue: BoardCredential,
    number: number,
  ): Promise<BoardIssue | null> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const resolved = await this.readIssueSnapshotByNumber(credential, meta, number);
    return resolved?.issue ?? null;
  }

  private async readIssuePageFromMeta(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    state: IssueState,
    page: number,
  ): Promise<IssueListPage> {
    const refs = state === 'open' ? meta.openPageRefs : meta.closedPageRefs;
    const total = state === 'open' ? meta.openIssueCount : meta.closedIssueCount;
    const ref = refs[page - 1];
    if (ref === undefined) {
      return {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: meta.boardId,
        state,
        page,
        revision: meta.revision,
        total,
        entries: [],
      };
    }
    const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || value.state !== state
        || value.page !== page
        || !Array.isArray(value.entries)) {
      throw new ShardedBoardStoreError('Antonina issue list page is malformed');
    }
    // The stored page carries no revision: a field that differs on every
    // mutation would make the page's ref differ too, and then no list page a
    // mutation did not touch could ever be shared. The revision reported to a
    // caller is the meta's, which is the same revision for every shard of the
    // generation the page belongs to.
    return { ...(clone(value) as unknown as IssueListPage), revision: meta.revision };
  }

  async readIssuePage(
    credentialValue: BoardCredential,
    state: IssueState,
    page: number,
  ): Promise<IssueListPage> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new ShardedBoardStoreError('Antonina issue page must be a positive integer');
    }
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    return this.readIssuePageFromMeta(credential, meta, state, page);
  }

  async readOverview(credentialValue: BoardCredential): Promise<BoardOverview> {
    const { credential, pointer, meta } = await this.requirePointerForCredential(credentialValue);
    const [queue, catalog, openPages, closedPages] = await Promise.all([
      this.readQueue(credential, meta),
      this.readCatalog(credential, meta),
      Promise.all(meta.openPageRefs.map((_, index) =>
        this.readIssuePageFromMeta(credential, meta, 'open', index + 1))),
      Promise.all(meta.closedPageRefs.map((_, index) =>
        this.readIssuePageFromMeta(credential, meta, 'closed', index + 1))),
    ]);
    return {
      boardId: meta.boardId,
      head: pointer.head,
      revision: pointer.revision,
      deleted: meta.deleted,
      queue,
      issues: [
        ...openPages.flatMap((page) => page.entries),
        ...closedPages.flatMap((page) => page.entries),
      ],
      resources: catalog.resources,
      targets: catalog.targets,
      dispatches: catalog.dispatches,
    };
  }

  async getQueue(credentialValue: BoardCredential): Promise<number[]> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    return this.readQueue(credential, meta);
  }

  private async hydrateFeedEntry(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    entry: StoredFeedEntry,
  ): Promise<BoardFeedEntry> {
    if (entry.kind !== 'comment-added') {
      return {
        id: entry.id,
        kind: entry.kind,
        at: entry.at,
        position: entry.position,
        issueNumber: entry.issueNumber,
        title: entry.title,
        state: entry.state,
        messageId: entry.messageId,
        author: null,
        body: null,
      };
    }

    if (entry.commentRef === undefined && entry.commentIndex === undefined) {
      if (typeof entry.author !== 'string' || typeof entry.body !== 'string') {
        throw new ShardedBoardStoreError('Antonina inline feed comment is malformed');
      }
      return {
        id: entry.id,
        kind: entry.kind,
        at: entry.at,
        position: entry.position,
        issueNumber: entry.issueNumber,
        title: entry.title,
        state: entry.state,
        messageId: entry.messageId,
        author: entry.author,
        body: entry.body,
      };
    }

    if (!Number.isSafeInteger(entry.commentIndex) || (entry.commentIndex as number) < 0) {
      throw new ShardedBoardStoreError('Antonina feed comment reference is malformed');
    }
    // The address is an index into the issue's messages, so the comment page is
    // whichever one the issue's *current* snapshot pins. A page is rewritten by
    // every later comment to that issue, which is why the entry cannot name a
    // page ref: the reclamation is entitled to delete the superseded one, and a
    // sealed feed entry naming it would dangle permanently. A deleted issue
    // resolves through its tombstone, so its comments stay readable too.
    const index = entry.commentIndex as number;
    const resolved = await this.readIssueSnapshotByNumber(credential, meta, entry.issueNumber);
    if (resolved === null) {
      throw new ShardedBoardStoreError('Antonina feed comment names an unresolvable issue');
    }
    const commentRef = resolved.snapshot.commentRefs[Math.floor(index / V3_COMMENT_PAGE_SIZE)];
    if (commentRef === undefined) {
      throw new ShardedBoardStoreError('Antonina feed comment index is past the issue thread');
    }
    const stored = await this.requireJson<unknown>(credential.storageCapability, commentRef);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || value.number !== entry.issueNumber
        || !Array.isArray(value.messages)) {
      throw new ShardedBoardStoreError('Antonina feed comment page is malformed');
    }
    const message = value.messages[index % V3_COMMENT_PAGE_SIZE];
    if (!isRecord(message)
        || typeof message.id !== 'string'
        || message.id !== entry.messageId
        || typeof message.author !== 'string'
        || typeof message.body !== 'string') {
      throw new ShardedBoardStoreError('Antonina feed comment message is malformed');
    }
    return {
      id: entry.id,
      kind: entry.kind,
      at: entry.at,
      position: entry.position,
      issueNumber: entry.issueNumber,
      title: entry.title,
      state: entry.state,
      messageId: entry.messageId,
      author: message.author,
      body: message.body,
    };
  }

  async readFeed(
    credentialValue: BoardCredential,
    request: BoardFeedRequest = {},
  ): Promise<BoardFeedPage> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const limit = feedLimit(request.limit);
    const cursor = request.cursor === undefined || request.cursor === null
      ? null
      : parseFeedCursor(request.cursor);
    const entries: StoredFeedEntry[] = [];
    for (let page = meta.feedPageRefs.length; page >= 1 && entries.length < limit + 1; page -= 1) {
      const ref = meta.feedPageRefs[page - 1]!;
      const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
      if (!isRecord(stored.value) || !Array.isArray(stored.value.entries)) {
        throw new ShardedBoardStoreError('Antonina feed page is malformed');
      }
      const pageEntries = [...stored.value.entries as StoredFeedEntry[]]
        .sort((left, right) => right.position - left.position)
        .filter((entry) => cursor === null || entry.position < cursor.position);
      entries.push(...pageEntries);
    }
    const pageEntries = entries.slice(0, limit);
    const last = pageEntries.at(-1);
    const hydrated = await Promise.all(
      pageEntries.map((entry) => this.hydrateFeedEntry(credential, meta, entry)),
    );
    return {
      entries: hydrated,
      nextCursor: entries.length > limit && last !== undefined ? feedCursor(last) : null,
      total: meta.feedCount,
      limit,
    };
  }
}
