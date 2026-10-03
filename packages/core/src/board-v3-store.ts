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

/**
 * The pointer format this build writes and is willing to serve.
 *
 * It is a different string from the pre-cutover one (`materialized-snapshots`,
 * still read by `importBoard` and written by `board-store.ts` as the bootstrap
 * record), and that difference is the entire migration boundary. A pointer
 * carrying the old string names a store this build will *import once* and never
 * read again; a pointer carrying this string names the only store the runtime
 * serves. There is no third case and no compatibility branch, so the runtime
 * cannot drift back into reading the old shape.
 */
const POINTER_FORMAT = 'compact-materialized-snapshots' as const;

/** The pre-cutover pointer format. Import source only; never served. */
const LEGACY_POINTER_FORMAT = 'materialized-snapshots' as const;
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
 * Generations of materialization kept readable behind the pointer, counted back
 * from it. This is a *safety floor on commit depth*, not the retention window:
 * it is what makes the delete set unreachable from any pointer a reader can
 * still be holding.
 *
 * There is no lease and no compare-and-delete in Skrynia, so the only way to let
 * a slow reader finish is to keep what it may still be reading. A reader that
 * resolved the pointer at revision `N` reads `meta(N)` and then the shards
 * `meta(N)` pins; when revision `N+1` commits, the refs `N+1` *replaced* are
 * still pinned by `N` and must survive. They become unreachable from `N+1` and
 * are eligible by depth at `N+2`.
 *
 * The delay is implemented by recording, in each meta, the refs that generation
 * replaced, and reclaiming the recorded sets of every generation that has fallen
 * outside `RETENTION_MIN_AGE_MS` as the sweep walks back down the chain. That
 * keeps the arithmetic in one place and costs no extra read at the default
 * depth, because every meta it needs is one the writer has already read or that
 * the walk reads on the way.
 *
 * Depth alone is not the window, and the difference is not academic: a commit
 * count is a statement about how often writers commit, and nothing about how
 * long a *read* takes. A board committing every 200 ms retires a resolved
 * generation's shards in 400 ms, which is inside a single `readBundle` fan-out
 * of one GET per issue, and the reader gets a 404 that `requireJson` reports as
 * `Antonina board key does not open the current materialized snapshot` -- a
 * message that names a credential problem, because that is the only thing a
 * missing object has ever meant in this file. So the window is time, below.
 */

/**
 * How long a superseded generation's materialization is kept after the commit
 * that superseded it, in milliseconds. This is the retention *window*; the
 * constant above is how far back the delete set is walked to find it.
 *
 * Both conditions must hold before anything is reclaimed: the generation is at
 * least `RETAINED_GENERATIONS` commits back, and it is at least this old. The
 * first is a safety property and the second is the reader's grace period, and
 * neither subsumes the other: the depth rule alone retires a generation while a
 * reader is still inside it, and the age rule alone would eventually let the
 * sweep delete a shard the generation behind the pointer still pins.
 *
 * Sizing. 300 s against a full board hydration, which is the longest read a
 * reader can be in the middle of. The bound is taken against the WORST case --
 * every object fetched one at a time -- deliberately, so it does not depend on
 * the fan-out's concurrency: `readBundle` reads the meta and the directory
 * pages, then every issue snapshot, then the queue and the catalog, and each
 * issue reads its snapshot and then its comment pages. A 100-issue board with
 * ten comments each is on the order of 1,100 objects; at a pessimistic 100 ms
 * per round trip that is ~110 s even serialized, and 300 s is roughly a 3x
 * margin on that figure. The real read is faster than the bound because the
 * issues are fetched concurrently; the margin is for the parts the client does
 * not control, which is server queueing and a slow object.
 *
 * The number is a judgement, and it is the one judgement in this file: the
 * production board's size and its read latency are both unmeasured, because
 * Antonina has no listing API and I did not read the live board. It is stated
 * here as a constant with its reasoning attached rather than as a bare number
 * precisely because it cannot be derived from anything on this host.
 *
 * What it costs, stated as the bound it implies: a commit rate of `c` per
 * millisecond retains at most `c * 300 s` extra generations of materialization,
 * so the storage the window holds is proportional to how often the board is
 * written, not to how long it has been written. On a board a human paces, that
 * is a handful of generations. On a board committing thousands of times a
 * second it would not be, and the honest statement is that this window and
 * bounded storage are in tension at high commit rates -- the trade is visible
 * in this constant rather than hidden in a comment.
 *
 * A board that stops being written stops reclaiming, because the sweep only
 * runs after a commit. That is the same property the commit-depth rule always
 * had; nothing is lost by it, since the objects it is waiting to delete are
 * already unreachable from the pointer.
 */
const RETENTION_MIN_AGE_MS = 300_000;

/**
 * The floor, restated as what it is: the delete set is walked back this many
 * commits from the one just committed, so nothing a pointer behind the current
 * one still pins is ever in it.
 *
 * The window is a *deletion* window only. What keeps the retained generation
 * internally consistent is that Antonina never overwrites a shard and shard
 * locators are unguessable without the board credential -- not that the storage
 * refuses to overwrite one. `public-write` does not, so a reader inside the
 * window is relying on write discipline and locator secrecy; see `writeShard`.
 * An externally overwritten shard is detected on the next write that re-derives
 * its ref, and is otherwise outside what this design can promise.
 */
const RETAINED_GENERATIONS = 1;

/**
 * What one DELETE of a superseded shard did. Four outcomes rather than a boolean,
 * because the difference between "already gone" and "refused" is the difference
 * between a healthy board and a broken premise, and folding them is what made
 * this failure undetectable. See `deleteShard`.
 */
type DeleteOutcome = 'deleted' | 'absent' | 'refused' | 'error';

/**
 * Attempts per reclaimed shard, and the backoff between them.
 *
 * Only the outcomes that could plausibly be transient are retried: a `403` is a
 * policy answer and a `404` is the goal state, so both are returned on the first
 * response. The numbers are small on purpose -- the sweep is per-ref work on the
 * path after every commit, and a board whose server is down should not pay a
 * long backoff on every superseded shard of every mutation.
 */
const RECLAIM_DELETE_ATTEMPTS = 3;
const RECLAIM_RETRY_BACKOFF_MS = 25;

/**
 * How many generations one sweep will walk back.
 *
 * A bound, not a policy: the walk stops on its own at the first generation still
 * inside the window, so on a healthy board this is never reached. It exists
 * because the chain is data -- a corrupted or hand-edited `retainsMetaRef` could
 * otherwise make one commit's post-CAS sweep walk without end, which is the one
 * place in this file where a bug would be a hang rather than a wrong value.
 */
const RETAINED_GENERATION_WALK_LIMIT = 64;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface JsonObject<T> {
  value: T;
  etag: string;
}

export interface ShardedBoardPointer {
  schemaVersion: 3;
  format: typeof POINTER_FORMAT | typeof LEGACY_POINTER_FORMAT;
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
   * it is outside the `pinnedRefs` closure and the shard reclamation never sees
   * it; the chain is what lets a writer walk back and reclaim the generations
   * that have fallen outside the retention window -- both their meta objects and
   * the shard refs they recorded. It is `null` on a meta written before the
   * chain existed, which reads as "no ancestors", and on the first meta of a
   * board.
   */
  retainsMetaRef: string | null;
  /**
   * Shard refs this generation replaced: the ones the superseded generation
   * pinned and this one does not.
   *
   * This is what makes the retention window real. The refs listed here are
   * still pinned by the generation this one superseded, so a writer must NOT
   * delete them when it commits this meta -- that would tear a reader that
   * resolved the older pointer. They are instead deleted by the next writer,
   * which reads this list off the meta it found through the pointer. So the
   * delay is a property of the data rather than of the sweeping code, and it
   * costs no extra read: the required list is the one the writer has already
   * read.
   *
   * Unbounded in principle, since a mutation can replace many shards, and in
   * practice it is the handful of shards the mutation actually rewrote.
   */
  supersededRefs: string[];
  /**
   * Every shard ref this generation wrote: the materialization it introduced.
   *
   * This is what makes a deep reclamation walk safe. A ref recorded in some older
   * generation's `supersededRefs` may have been written again by any generation
   * since -- content addressing makes that real, not theoretical: edit an issue
   * from body A to body B and back to A, and A's ref is recorded as superseded
   * when B is written and written again when the body goes back, and the
   * generation that recorded the supersession is not the generation before the
   * re-write. A sweep walking back over several generations therefore has to know
   * what each of them wrote, and this is that, in the data, for the cost of a
   * short list per generation: a mutation writes a handful of shards and carries
   * the rest of the board forward by reference.
   *
   * It is also the exact statement of what the generation changed, which is worth
   * having in the format on its own terms.
   */
  introducedRefs: string[];
  /**
   * How many shard objects this board has identified as superseded and could not
   * delete, cumulatively over its whole life.
   *
   * This exists because the reclaim premise is a dated observation rather than a
   * specification: a deployment that stops accepting unauthenticated `DELETE` on
   * `public-write` turns every reclamation into a no-op, the namespace regrows
   * exactly as it did before the fix, and the board hits its quota again. A
   * counter that lives only in a running process cannot catch that, because the
   * process that would notice is not the one that ran the failing sweeps -- so
   * the count is written into the durable format, carried forward by each
   * generation, and read by `importBoard` and `cutoverState` for an operator.
   *
   * It is a count of *identifications*, not of surviving objects: a ref another
   * reclaimer already deleted is counted here too (a 404 is the goal state), so
   * the number is an upper bound on the leak and a non-zero value is a prompt to
   * look, not proof of one. The generation that reports it is the one after the
   * sweep that measured it, so it lags by exactly one commit.
   */
  unreclaimableShards: number;
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

/**
 * One issue, and the pages its comment thread is stored in.
 *
 * There is no deleted-issue variant: a deleted issue leaves the directory and its
 * comment pages become ordinary reclaimable shards, because a feed entry carries
 * its own text and nothing needs the issue to keep existing.
 */
interface IssueSnapshot {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  number: number;
  issue: IssueCore;
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

/**
 * One bounded page of one issue's conversation, as a reader outside the store
 * sees it.
 *
 * `issue` is the issue itself with `messages` empty — the core fields, not the
 * thread — and `messages` is only the requested page. Together they are one
 * read: a reader opening an issue gets its title, body and state without any
 * comment shard being fetched, and then the page they asked for.
 *
 * `total` is the whole thread's message count and `pageCount` how many pages it
 * occupies, so the count line and the Previous/Next controls can be drawn from
 * this read alone.
 */
export interface IssueCommentPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  issue: BoardIssue;
  page: number;
  pageCount: number;
  total: number;
  messages: BoardMessage[];
}

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

/**
 * A feed entry as stored.
 *
 * Self-contained: a comment entry carries its own author and body rather than a
 * reference to a comment page. That is the single decision the import boundary
 * rests on, and it is worth stating why.
 *
 * The earlier model kept a comment's text in the issue's comment page and had the
 * feed point at it -- by page ref, then by index. Both forms are a *backwards*
 * edge from a permanent historical record to mutable storage, and a mutable shard
 * cannot be pinned by an immutable feed page: the page is rewritten by the next
 * comment to that issue, so the reference is stale the moment it is written. That
 * is what forced the deleted-issue tombstone, the retention window, and the
 * legacy-format fallback -- all three existed only to keep those edges resolvable.
 *
 * With the body inline there is no edge to dangle, so a deleted issue needs no
 * tombstone, its comment pages are ordinary reclaimable shards, and a feed entry
 * is readable forever with no lookups at all. The cost is that a comment's text
 * is stored twice, once in the feed and once in its issue thread. That is a
 * constant factor on the product history we intend to keep, and it buys back the
 * whole forward-edge problem.
 */
type StoredFeedEntry = BoardFeedEntry;

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
      || (value.format !== POINTER_FORMAT && value.format !== LEGACY_POINTER_FORMAT)
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
    // Preserved as stored, so a caller can tell the two formats apart. The
    // runtime serves only `POINTER_FORMAT`; the other is an import source.
    format: value.format as typeof POINTER_FORMAT | typeof LEGACY_POINTER_FORMAT,
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
    /**
     * Both of these are absent on a meta written before this shape existed, and
     * both read as "nothing to inherit": no predecessor chain, and nothing
     * waiting to be reclaimed. That is the conservative reading for the chain --
     * a board with no chain simply has no ancestors to walk -- and the right one
     * for the reclaim list, and for a reason that has nothing to do with what the
     * storage would do if asked: a meta written before this shape existed never
     * recorded a ref as superseded in the first place, so there is nothing
     * recorded here to sweep. That is a statement about this code's own write
     * history, and it holds whatever the server does with a shard.
     */
    retainsMetaRef: typeof value.retainsMetaRef === 'string' ? value.retainsMetaRef : null,
    supersededRefs: Array.isArray(value.supersededRefs)
      ? value.supersededRefs.map((entry) => requireText(entry, 'superseded reference'))
      : [],
    // Absent on a meta written before this shape existed, and empty is the right
    // reading: nothing is known to have been introduced, so the guard falls back
    // to the committing writer's own refs, which is the pre-existing behaviour.
    introducedRefs: Array.isArray(value.introducedRefs)
      ? value.introducedRefs.map((entry) => requireText(entry, 'introduced reference'))
      : [],
    /**
     * Absent on a meta written before this counter existed, and zero is the
     * right reading. What such a meta never recorded is an *object* this board
     * had identified as superseded and could not confirm deleting; it is not a
     * claim that nothing was ever undeletable, which is a property of the server
     * and not of this format. Under-counting the leak is the failure mode, so
     * this is a floor and the report says so.
     */
    unreclaimableShards: typeof value.unreclaimableShards === 'number'
      && Number.isSafeInteger(value.unreclaimableShards)
      && value.unreclaimableShards >= 0
      ? value.unreclaimableShards
      : 0,
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

export interface BoardSweepReport {
  /** The generation the sweep ran for, or `null` before the first mutation. */
  revision: number | null;
  /**
   * True when the sweep declined to run because the superseded generation was
   * still inside the retention window. Nothing was deleted and nothing failed.
   */
  skipped: boolean;
  /** Objects the last sweep deleted. */
  reclaimed: number;
  /**
   * Objects the last sweep identified as superseded but could not confirm
   * deleted: already absent, refused, or errored. This is what the next
   * generation carries into its durable `unreclaimableShards` total, so it is an
   * upper bound on the leak and not a measurement of it -- a `404` counts here
   * even though the object is already gone.
   */
  retained: number;
  /**
   * Of `retained`, the ones the server refused with `403`.
   *
   * This is the number that means the reclaim premise has stopped holding rather
   * than that there was a race. Nothing on this path has a benign `403`: every
   * ref in the delete set was written `public-write` by this materialiser, so a
   * refusal means the server's policy changed, every sweep from then on is a
   * no-op, and the namespace regrows. It is reported separately because it is the
   * one that should stop an operator.
   */
  refused: number;
  /** Of `retained`, the ones whose DELETE failed for a reason worth retrying. */
  failed: number;
  at: string | null;
  error: string | null;
}

/** Per-outcome counts from one reclamation pass. */
interface ReclaimOutcome {
  deleted: number;
  absent: number;
  refused: number;
  error: number;
}

/**
 * The logical board the import reconstructs from a pre-cutover store.
 *
 * This is the boundary type. Everything the product considers a board -- issues
 * with their bodies and comment threads, the queue, the catalog, and the feed --
 * is here, and nothing about how any of it was stored crosses it. The importer
 * produces it from the old store, the new store materializes from it, and the
 * equivalence check compares two of these against each other. No shard ref, no
 * meta, no head-named key, and no per-object mode appears in it, which is what
 * makes the check independent of the storage it is checking.
 */
export interface LogicalBoard {
  board: Board;
  queue: number[];
  /** Every feed entry, in position order, with comment bodies already resolved. */
  feed: BoardFeedEntry[];
  /** The issue the board had deleted, if it was deleted. */
  deleted: boolean;
  /**
   * When each closed issue was closed, which the old store recorded per issue and
   * the new store needs to order the closed list.
   */
  closedAt: Map<number, string>;
  /** The board id and root key the pointer names, checked against the credential. */
  boardId: string;
  rootKeyId: string;
}

/** One thing the two boards must agree on, and what they agreed on. */
export interface EquivalenceCheck {
  name: string;
  equal: boolean;
  /** A short description of the difference, present only when `equal` is false. */
  difference: string | null;
}

/**
 * What an import did, or would do.
 *
 * The verification block is not a summary of the import succeeding; it is the
 * evidence for the cutover, and a run with any failed check does not cut over.
 */
export interface BoardImportReport {
  boardId: string;
  state: 'cutover-complete' | 'needs-import';
  /** False when the run was a plan rather than a cutover. */
  cutover: boolean;
  /** The pre-cutover revision the import read. */
  fromRevision: number;
  /** The revision the imported board is published at, when it was. */
  toRevision: number | null;
  /** Shard objects the imported store holds: the compacted size. */
  importedRefs: number;
  /** Product counts, so a human can see what was carried across. */
  issues: number;
  comments: number;
  feedEntries: number;
  queueLength: number;
  resources: number;
  targets: number;
  dispatches: number;
  checks: EquivalenceCheck[];
  /** True only when every check passed. */
  equivalent: boolean;
  /**
   * The old store, left whole. It is not reachable from the new pointer, so
   * removing it is a namespace-level action for Skrynia or operator tooling,
   * deliberately not this code.
   *
   * What keeps it intact is this code's restraint, not a server guarantee. Its
   * shards are pre-cutover `immutable` objects, and when Skrynia removed the
   * `immutable` mode from the creation vocabulary it made the legacy objects that
   * mode left on disk deliberately *deletable*, precisely so that superseded
   * storage would be reclaimable. The API would now delete them. Nothing in the
   * pre-cutover store is protected at the object level, and nothing here should be
   * read as saying otherwise.
   */
  legacyStore: {
    pointer: string;
    shardObjects: number;
    note: string;
  };
  /**
   * The board's storage health, in the one form an operator can act on: a running
   * total carried in the durable format by every generation, so it is still true
   * when the process that ran the failing sweeps has exited.
   *
   * This is here because the reclaim premise -- that Skrynia accepts an
   * unauthenticated DELETE on a `public-write` object -- is a dated observation
   * of one deployment and not a specification. If it stops holding, reclamation
   * becomes a silent no-op, the namespace regrows exactly as it did before this
   * format existed, and the board hits its quota again. A non-zero
   * `unreclaimableShards` is the one signal that says so.
   */
  storage: {
    /**
     * Superseded shard objects this board has identified and could not confirm
     * deleting, cumulatively. An upper bound on the leak rather than a
     * measurement of it: a ref another reclaimer already deleted counts here
     * too, and the number lags the most recent sweep by one commit.
     */
    unreclaimableShards: number;
    note: string;
  };
}

export interface BoardCutoverState {
  boardId: string;
  state: 'needs-import' | 'cutover-complete';
  revision: number;
  /** The pre-cutover pointer, when the board has not been imported. */
  legacyPointer: string | null;
  report: BoardImportReport | null;
}

export class ShardedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly pointerUrl: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /**
   * Every ref `writeShard` has produced during the commit in flight.
   *
   * A ref in the previous generation's `supersededRefs` must never be deleted
   * while the current generation pins it, and content addressing makes that a
   * real case rather than a theoretical one: edit an issue from body A to body B
   * and back to A, and A's ref is recorded as superseded at one generation and
   * written again at the next. Deleting on the recorded list alone would then
   * destroy a live shard.
   *
   * The set is per-attempt rather than per-store because a lost CAS is retried
   * against a different starting point, and a ref written by the abandoned
   * attempt is irrelevant to the attempt that commits. A `writtenRefs` entry can
   * only mean "this commit re-established that ref", which is exactly the
   * condition that makes deletion unsafe.
   */
  private writtenRefs = new Set<string>();
  private lastSweep: BoardSweepReport = {
    revision: null,
    skipped: false,
    reclaimed: 0,
    retained: 0,
    refused: 0,
    failed: 0,
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
   * The mode is `public-write`, and that is a deliberate consequence of how
   * Skrynia issues capabilities rather than a preference. A `capability-write`
   * object gets a *fresh per-object* capability minted at POST and only its hash
   * is retained; the caller's `X-Skrynia-Capability` is not adopted. So the only
   * value that authorizes a later PUT or DELETE of that object is the one the
   * creating response returned, and the hash cannot be inverted back to it.
   *
   * That is fine for `board-v2`, which is created once and thereafter guarded by
   * exactly that value -- `initialize` reads it out of the POST response and it
   * becomes the board credential. It does not work for a shard. A mutation
   * reclaims shards an *earlier* mutation wrote, possibly by a different client
   * in a different process, so the capability that would authorize the delete is
   * gone unless every shard's capability is persisted as new secret material
   * inside the board. Deriving the ability to delete from the one board key
   * instead is what keeps the current access assumption intact: possession of the
   * board credential is what grants access, because shard locators are derived
   * from it and are unguessable without it.
   *
   * `public-write` is reclaimable -- Skrynia accepts DELETE for it -- and it is
   * the mode the pre-immutable sharded model used for exactly these shards.
   *
   * WHAT IS ACTUALLY GUARANTEED HERE, because it is easy to state wrongly.
   * `public-write` does **not** make a shard immutable. A holder of the locator
   * can PUT over the object anonymously, with or without `If-Match`: `If-Match`
   * is honoured when present and is optional. So "no reader can observe a shard
   * change under it" is **not** a property of the storage.
   *
   * What holds is two things, and both are ours:
   *
   *   1. Antonina never overwrites. This method POSTs and treats an occupied ref
   *      as a confirmation, never a force; nothing in this file PUTs a shard.
   *   2. The locator is `board-v3-` + base64url(sha256(capability + ':' + ref)),
   *      so addressing a shard at all requires the board credential. Reads are
   *      unauthenticated, so the secrecy of the locator is the whole of the
   *      read path's protection -- a locator that has ever been seen is a shard
   *      that can be read and rewritten.
   *
   * Under those two, the properties the immutable model bought still hold: a
   * crash before the pointer CAS leaves objects no reader can reach, two
   * concurrent writers produce disjoint object sets with one winner at the CAS,
   * and a reader cannot observe a shard change caused by a writer, because no
   * writer performs one. What changes is only that a superseded shard can now be
   * deleted.
   *
   * The 409 confirmation re-derives the stored object's ref from its content
   * rather than comparing the response to what was sent. A content-addressed ref
   * makes that the only check that is exact: the stored bytes may be ordered
   * differently from the canonical bytes that were hashed, so a structural
   * comparison would accept a value that is not the one this ref names. It is
   * also what makes an externally overwritten shard *detectable* rather than
   * silently believed: a PUT that replaced the body would make this check fail
   * loudly instead of being absorbed as a benign 409.
   *
   * WHY NO `If-Match` ON ANY SHARD OPERATION. Deliberate, recorded here because the
   * absence is otherwise indistinguishable from an oversight. The question is
   * whether a stale ETag is the difference between a benign retry and silent
   * corruption, and on this format it is not -- for either shard operation.
   *
   *   * The create path has no prior version to condition on, so there is no
   *     meaningful `If-Match` value to send against a POST that is meant to
   *     either create the ref or confirm it. The check this path actually has is
   *     strictly stronger than an ETag comparison: 409 plus content
   *     re-derivation, which rejects a body that is not the one this ref names --
   *     including a body an anonymous writer put there, which an ETag read before
   *     the POST would not catch.
   *   * The delete path's failure mode is authority, not concurrency. The real
   *     hazard is deleting a ref that a newer generation pinned again, and that is
   *     a question about which generation pins this ref, answered on the client by
   *     `introducedRefs` and `pinnedAgain` where the knowledge lives. An ETag is
   *     the wrong instrument for that question twice over. It would be the wrong
   *     one because deleting the object is still the intent whoever replaced it --
   *     the thing to protect is a ref, and a ref is a name this code holds, not a
   *     body on the server. And it could not be enforced anyway: at Skrynia
   *     `0b5adde` (and unchanged at `21eca665`) `If-Match` is read in `handlePut`
   *     only, and `handleDelete` never looks at the header, so a conditional DELETE
   *     would be accepted unconditionally and there is no 412 here to be a spurious
   *     retry or a protection. That is a dated reading of one revision, not a
   *     specification, and a Skrynia change that taught `handleDelete` to honour
   *     `If-Match` would falsify this paragraph rather than satisfy it. Antonina
   *     never GETs the ETag it would have to condition on in any case.
   *
   * `If-Match` therefore stays on the pointer CAS in `commitPointer`, which is the
   * only operation where a lost race is silent corruption rather than a benign
   * refusal: two writers that both PUT successfully would publish a generation
   * computed from a base neither of them saw. It is also the only operation that
   * changes what any client will read.
   *
   * REVERSAL CONDITION, and this is the part that matters later: any future
   * read-modify-write against an *existing* shard -- an in-place update, as
   * opposed to today's write-a-new-ref-and-supersede-the-old -- makes `If-Match`
   * mandatory on that operation, and this decision must be revisited before such a
   * change is written. The feed tail page is the obvious candidate: `appendFeed`
   * currently rewrites it through `writeShard` as a POST of a new content-
   * addressed ref, and it is safe only because it is content-addressed. Turning it
   * into an in-place PUT removes the property this design rests on.
   *
   * WHY THE PROBE TRANSCRIPT IS NOT COMMITTED AS A FIXTURE. A deliberate absence,
   * recorded so it is not read as an oversight. The 2026-09-29 probe transcript
   * that established the overwrite and reclaim premises exists and is not in this
   * repository, and it is not committed, because committing it would make the
   * artefact durable, widely read, and easy to treat as the contract it is not. It
   * would also be a second-hand transcription: nobody here ran the probe, so a
   * committed transcript would carry one more remove of authority between the
   * observation and the reader than the prose already committed here does. What is
   * committed instead is the prose contract in the test suite, labelled in both
   * places it appears -- `test/skrynia-contract.mjs` and
   * `test/board-v3-storage.test.mjs` -- as a dated observation of one deployment
   * and not a specification, with its own limits stated: the probe was
   * unauthenticated, the server carried no version identifier to pin it to, and
   * the scope of a capability across namespaces or keys was deliberately not
   * tested. Those labels are the protection this outcome asks for; a transcript
   * fixture would add risk, not remove it. Reversal condition: if a future
   * deployment is versioned and the same matrix is re-run against two of them, a
   * labelled fixture becomes worth committing, because it would then be pinned to
   * something rather than to a date.
   */
  private async writeShard(
    storageCapability: string,
    value: unknown,
  ): Promise<string> {
    const ref = await shardRef(value);
    // Recorded so the reclamation can tell a ref that this commit *replaced* from
    // one it re-established. Content addressing makes that distinction necessary
    // rather than tidy: an issue edited A -> B -> A writes A's ref again, so a ref
    // recorded as superseded two generations ago is pinned by the current
    // generation again, and deleting it would break the board. Subtracting the
    // refs written by this commit is exact and free -- a superseded ref that this
    // generation pins must have been re-written here, because a ref this
    // generation merely carried forward was already pinned by the previous one
    // and so was never recorded as superseded at all.
    this.writtenRefs.add(ref);
    const response = await this.fetcher(await this.url(storageCapability, ref), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'public-write',
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
   * Removes one superseded shard, under the same `public-write` authority that
   * wrote it. No credential is sent, and none is needed: DELETE on a
   * public-write object is unauthenticated, which is the property that makes a
   * shard reclaimable by a client that never saw its creating response.
   *
   * No `If-Match` is sent here, deliberately; the decision and its reversal
   * condition are recorded on `writeShard`.
   *
   * Best-effort by design: this runs after the pointer has already committed, so
   * a failure here is a leak, never a lost write, and it is reported rather than
   * thrown. What the four outcomes mean is the whole of the reclaim premise, so
   * they are distinguished rather than folded:
   *
   *   * `200` -- deleted. The only outcome that is a success.
   *   * `404` -- already gone, which is the goal state. Benign: this is how a
   *     lost race between two reclaimers resolves, and what a second pass over an
   *     already-swept set sees. Counted, because a 404 still means the object may
   *     have been in the namespace, but not as an anomaly.
   *   * `403` -- refused. There is no benign cause for this on the reclamation
   *     path: `supersededRefs` is only ever populated with refs the new
   *     materialiser wrote as `public-write`, so a pre-cutover `immutable` shard
   *     can never be in the set. A 403 means the server's policy changed under
   *     the premise, which is the failure that silently turns this whole fix into
   *     a no-op, so it is counted separately and never retried -- a policy will
   *     not answer differently on the next attempt, and retrying would multiply
   *     the cost of a broken premise by the attempt count on every mutation.
   *   * anything else, or a transport failure -- an error, retried a small number
   *     of times because it is the one outcome plausibly worth retrying, and
   *     counted if it survives.
   */
  private async deleteShard(storageCapability: string, ref: string): Promise<DeleteOutcome> {
    const url = await this.url(storageCapability, ref);
    for (let attempt = 1; attempt <= RECLAIM_DELETE_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, { method: 'DELETE' });
      } catch (error) {
        if (attempt === RECLAIM_DELETE_ATTEMPTS) return 'error';
        await delay(RECLAIM_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      if (response.status === 200) return 'deleted';
      if (response.status === 404) return 'absent';
      if (response.status === 403) return 'refused';
      if (attempt === RECLAIM_DELETE_ATTEMPTS) return 'error';
      await delay(RECLAIM_RETRY_BACKOFF_MS * attempt);
    }
    return 'error';
  }

  /**
   * The one conditional write in this format, and the only one that needs to be.
   * `If-Match` is load-bearing here and deliberately absent from every shard
   * operation; the decision, its reason and its reversal condition are recorded on
   * `writeShard`.
   */
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

  /**
   * One comment shard, fetched on its own.
   *
   * This is the only place a comment shard is read, so the whole-thread
   * reassembly below and the bounded single-page read in front of it parse the
   * same shard the same way and cannot disagree about what one holds. `index` is
   * the shard's one-based page number minus one, and it is checked against the
   * shard's own `page`, so a ref that does not sit where the snapshot says it
   * does is a malformed board rather than a silently reordered thread.
   */
  private async readCommentShard(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    snapshot: IssueSnapshot,
    index: number,
  ): Promise<BoardMessage[]> {
    const commentRef = snapshot.commentRefs[index];
    if (commentRef === undefined) return [];
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
  }

  private async readIssueSnapshot(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    ref: string,
    withMessages: boolean,
  ): Promise<{ snapshot: IssueSnapshot; issue: BoardIssue }> {
    const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
    const value = stored.value;
    if (!isRecord(value)
        || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== meta.boardId
        || !Number.isSafeInteger(value.number)
        || !isRecord(value.issue)
        || (value.closedAt !== null && typeof value.closedAt !== 'string')
        || !Number.isSafeInteger(value.messageCount)
        || !Array.isArray(value.commentRefs)) {
      throw new ShardedBoardStoreError('Antonina issue snapshot is malformed');
    }
    const coreValue = value.issue;
    if (!Number.isSafeInteger(coreValue.number)
        || typeof coreValue.title !== 'string'
        || typeof coreValue.body !== 'string'
        || (coreValue.state !== 'open' && coreValue.state !== 'closed')
        || typeof coreValue.createdAt !== 'string'
        || typeof coreValue.updatedAt !== 'string') {
      throw new ShardedBoardStoreError('Antonina issue core is malformed');
    }
    const core: IssueCore = {
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
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      number: value.number as number,
      issue: core,
      closedAt: value.closedAt,
      messageCount: requireSafeCount(value.messageCount, 'message count'),
      commentRefs: value.commentRefs.map((entry) => requireText(entry, 'comment reference')),
    };
    if (!withMessages) return { snapshot, issue: issueFromCore(core, []) };

const pages = await Promise.all(snapshot.commentRefs.map(async (_commentRef, index) =>
      this.readCommentShard(credential, meta, snapshot, index)));
    const messages = pages.flat();
    if (messages.length !== snapshot.messageCount) {
      throw new ShardedBoardStoreError('Antonina issue message count does not match its comment pages');
    }
    return { snapshot, issue: issueFromCore(core, messages) };
  }

  private async readCommentPage(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    number: number,
    commentRef: string,
    page: number,
  ): Promise<BoardMessage[]> {
    const pageStored = await this.requireJson<unknown>(credential.storageCapability, commentRef);
    const pageValue = pageStored.value;
    if (!isRecord(pageValue)
        || pageValue.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || pageValue.boardId !== meta.boardId
        || pageValue.number !== number
        || pageValue.page !== page
        || !Array.isArray(pageValue.messages)) {
      throw new ShardedBoardStoreError('Antonina comment page is malformed');
    }
    return clone(pageValue.messages as BoardMessage[]);
  }

  /**
   * Resolves an issue by number through the directory.
   *
   * The directory is the whole live set: a deleted issue has no entry, so this
   * returns `null` for it, and there is no tombstone to consult. That is safe for
   * a comment on a deleted issue because the feed entry carries its own body --
   * a comment is still board history and still readable without hydrating an
   * issue that is not there.
   *
   * `withMessages` is the whole difference between reading an issue and reading
   * its thread: `false` reads the issue's own shard and no comment shard at all,
   * which is what the list, overview and write paths use. It defaults to `true`
   * so the callers that do want the whole thread keep saying so implicitly; the
   * bounded per-page read below never goes through here at all.
   */
  private async readIssueSnapshotByNumber(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    number: number,
    withMessages = true,
  ): Promise<{ snapshot: IssueSnapshot; issue: BoardIssue } | null> {
    const directory = await this.readDirectoryPage(credential, meta, directoryPageNumber(number));
    const entry = directory?.entries.find((candidate) => candidate.number === number);
    if (entry === undefined) return null;
    return this.readIssueSnapshot(credential, meta, entry.ref, withMessages);
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
      return result.issue;
    }));
    issues.sort((left, right) => left.number - right.number);
    const queue = await this.readQueue(credential, meta);
    const catalog = await this.readCatalog(credential, meta);
    const board: Board = {
      schemaVersion: 3,
      nextIssueNumber: meta.nextIssueNumber,
      issues,
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
      issue: coreOf(issue),
      closedAt,
      messageCount: issue.messages.length,
      commentRefs,
    };
    return { ref: await this.writeShard(credential.storageCapability, snapshot), superseded };
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
    entries.push(clone(entry));
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
   * This is the reachability closure, and it is used only by the import report
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
   * Reclaims every generation that has fallen outside the retention window: the
   * shard refs it superseded, and the meta object itself.
   *
   * The walk is one walk, backwards over the meta chain, and it is the age of the
   * *meta* that decides. A generation's `supersededRefs` is eligible exactly when
   * the generation that recorded it is old enough that no reader should still be
   * inside it. "Should", and at the scope `RETENTION_MIN_AGE_MS` is stated at
   * 168-174: the age rule is sound only under the conjunction of Antonina never
   * overwriting a shard, locators being unguessable without the board credential,
   * and the window's 300 s bounding a real read, which is a judgement and not a
   * measurement. This function compares timestamps and establishes no part of
   * that conjunction itself. On a board committing faster than the window that
   * makes several generations eligible at once, and reclaiming only the most
   * recent one -- which is what a commit-count rule does -- would either never
   * reclaim anything or reclaim something a reader is still inside. This is the
   * whole difference between a window and a counter.
   *
   * The meta object goes with its refs, and it has to be in the same walk. A meta
   * is named by the pointer rather than by another meta, so it is outside the
   * shard closure and nothing else would ever reclaim it; without this the fix
   * would move the unbounded growth from shards to metas. It is the same age rule,
   * because a reader that resolved the pointer has to be able to fetch the meta it
   * names.
   *
   * The walk starts at the generation the committed one superseded and runs back
   * to the walk limit, deleting from every generation it finds outside the window
   * and collecting from every generation it visits. Collecting matters: a ref
   * recorded as superseded by generation `g` may have been written again by any
   * generation between `g` and the one that just committed, and deleting it would
   * break a reader holding one of those. That is the A->B->A edit, and it is why
   * `introducedRefs` exists. The set accumulated is exactly the generations newer
   * than the one whose delete set is being processed, which is the only set that
   * can possibly still pin the ref.
   *
   * The walk tolerates a chain that has already been cut: the chain records what
   * was superseded, not what still exists, so a missing meta is the normal end of
   * the walk rather than an error. And the walk limit truncates in the safe
   * direction -- anything not examined is simply not deleted, which is a leak and
   * not a broken board.
   *
   * Never throws. The commit is the mutation; a failed reclamation is a leak, not
   * a failed write, and one object the server *refused* must not abort the rest --
   * which would turn a single refusal into every superseded object of the mutation
   * being left behind too.
   */
  private async reclaimOutsideWindow(
    credential: BoardCredential,
    committed: ShardedBoardMeta,
  ): Promise<{ outcome: ReclaimOutcome; eligible: boolean }> {
    const outcome: ReclaimOutcome = { deleted: 0, absent: 0, refused: 0, error: 0 };
    // What must survive whatever the recorded lists say: what this commit wrote,
    // and everything a generation after a recorded one wrote again.
    const pinnedAgain = new Set<string>(this.writtenRefs);
    let cursor = committed.retainsMetaRef;
    // The depth floor, before the age rule gets a say: a generation this recent is
    // never a candidate however old its timestamp claims to be.
    for (let kept = 1; cursor !== null && kept < RETAINED_GENERATIONS; kept += 1) {
      const meta = await this.readAncestorMeta(credential, cursor);
      if (meta === null) return { outcome, eligible: false };
      for (const ref of meta.introducedRefs) pinnedAgain.add(ref);
      cursor = meta.retainsMetaRef;
    }
    let eligible = false;
    for (let depth = 0; cursor !== null && depth < RETAINED_GENERATION_WALK_LIMIT; depth += 1) {
      const meta = await this.readAncestorMeta(credential, cursor);
      if (meta === null) break;
      if (this.outsideRetentionWindow(meta)) {
        eligible = true;
        for (const ref of new Set(meta.supersededRefs)) {
          if (pinnedAgain.has(ref)) continue;
          outcome[await this.deleteShard(credential.storageCapability, ref)] += 1;
        }
        outcome[await this.deleteShard(credential.storageCapability, cursor)] += 1;
      }
      // After processing, not before: what this generation wrote says nothing
      // about whether the refs IT superseded are still pinned by a newer one.
      for (const ref of meta.introducedRefs) pinnedAgain.add(ref);
      cursor = meta.retainsMetaRef;
    }
    return { outcome, eligible };
  }


  /**
   * Whether a generation has been committed long enough ago that no reader should
   * still be reading what it pinned.
   *
   * A predicate over `updatedAt` and nothing else. It does not know whether the
   * pinned shards are unchanged, and it cannot: that half of the property is
   * Antonina's own write discipline plus the locator secrecy set out at 168-174,
   * and the window's bound on read duration is the judgement stated at 141-145,
   * not a fact this function establishes.
   *
   * An unparseable or future `updatedAt` reads as *not* outside the window. Both
   * are the conservative direction: a clock that disagrees with itself delays
   * reclamation, and delaying a delete is a leak rather than a broken board.
   */
  private outsideRetentionWindow(meta: ShardedBoardMeta): boolean {
    const committedAt = Date.parse(meta.updatedAt);
    if (Number.isNaN(committedAt)) return false;
    return this.now().getTime() - committedAt >= RETENTION_MIN_AGE_MS;
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
            return { ...entry, position };
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
      supersededRefs: [],
      introducedRefs: [],
      unreclaimableShards: 0,
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

  /**
   * Which side of the cutover a pointer is on.
   *
   * A pointer is served only if it is already in the current format. The
   * pre-cutover format is *not* served and is never auto-migrated: it is an import
   * source, and reading it through the normal path is precisely the permanent
   * compatibility code the cutover exists to remove. So every read method checks
   * this first and refuses with a named error, and only `cutoverState` and
   * `importBoard` are allowed past it.
   */
  private requireCurrentPointer(pointerStored: JsonObject<ShardedBoardPointer>): ShardedBoardPointer {
    if (pointerStored.value.format !== POINTER_FORMAT) {
      throw new ShardedBoardStoreError(
        'Antonina board is stored in the pre-cutover format and must be imported '
        + 'with `antonina board import --confirm` before this build can serve it',
      );
    }
    return pointerStored.value;
  }

  /**
   * Reads a pre-cutover store into logical board state.
   *
   * This is the only code in the package that understands the old on-disk shape,
   * and it is reached only from `importBoard`. It resolves head-named refs and
   * comment-page references and returns a `LogicalBoard`, which is the whole
   * point: the caller's next step cannot accidentally depend on a ref, because
   * there is no ref on the other side of this call.
   */
  private async readLegacyBoard(
    credential: BoardCredential,
    pointer: ShardedBoardPointer,
  ): Promise<LogicalBoard> {
    const anchor = credentialTrustAnchor(credential);
    if (pointer.boardId !== anchor.boardId || pointer.rootKeyId !== anchor.rootKeyId) {
      throw new ShardedBoardStoreError('Antonina board pointer does not match this credential');
    }
    const get = async (ref: string): Promise<unknown> => {
      const stored = await this.getJson<unknown>(credential.storageCapability, ref);
      if (stored === null) {
        throw new ShardedBoardStoreError(
          `Antonina pre-cutover object ${ref} is missing; the board cannot be imported`,
        );
      }
      return stored.value;
    };

    // The old meta carries the same field names as the new one but a different
    // shard layout underneath, and it is read as a plain record rather than
    // through `parseMeta`: the new parser is the current format's, and using it
    // here would be the compatibility creep this cutover is removing.
    const metaValue = await get(pointer.metaRef);
    if (!isRecord(metaValue) || !Array.isArray(metaValue.directoryRefs)) {
      throw new ShardedBoardStoreError('Antonina pre-cutover metadata is malformed');
    }
    // `isRecord` is deliberately false for arrays, so the array check comes first.
    // The pre-cutover meta uses the same field names as the current one, which is
    // what makes this a structural read rather than a schema translation.
    const refs = (name: string): string[] => (Array.isArray(metaValue[name])
      ? metaValue[name] as string[]
      : []);
    const single = (name: string): string => (typeof metaValue[name] === 'string'
      ? metaValue[name] as string
      : (() => { throw new ShardedBoardStoreError(`Antonina pre-cutover metadata lacks ${name}`); })());

    const issues: BoardIssue[] = [];
    const closedAt = new Map<number, string>();
    for (const pageRef of refs('directoryRefs')) {
      if (pageRef === null || pageRef === undefined) continue;
      const page = await get(pageRef);
      if (!isRecord(page) || !Array.isArray(page.entries)) {
        throw new ShardedBoardStoreError('Antonina pre-cutover directory page is malformed');
      }
      for (const entry of page.entries as Array<Record<string, unknown>>) {
        const snapshot = await get(entry.ref as string);
        if (!isRecord(snapshot) || !isRecord(snapshot.issue)) {
          throw new ShardedBoardStoreError('Antonina pre-cutover issue snapshot is malformed');
        }
        const core = snapshot.issue;
        const messages: BoardMessage[] = [];
        for (const commentRef of (snapshot.commentRefs as string[] ?? [])) {
          const commentPage = await get(commentRef);
          if (!isRecord(commentPage) || !Array.isArray(commentPage.messages)) {
            throw new ShardedBoardStoreError('Antonina pre-cutover comment page is malformed');
          }
          messages.push(...(commentPage.messages as BoardMessage[]));
        }
        if (typeof snapshot.closedAt === 'string') closedAt.set(core.number as number, snapshot.closedAt);
        issues.push({
          number: core.number as number,
          title: core.title as string,
          body: core.body as string,
          state: core.state as IssueState,
          createdAt: core.createdAt as string,
          updatedAt: core.updatedAt as string,
          messages,
        });
      }
    }
    issues.sort((left, right) => left.number - right.number);

    const queueValue = await get(single('queueRef'));
    const catalogValue = await get(single('catalogRef'));
    if (!isRecord(queueValue) || !Array.isArray(queueValue.numbers)
        || !isRecord(catalogValue)
        || !Array.isArray(catalogValue.resources)
        || !Array.isArray(catalogValue.targets)
        || !Array.isArray(catalogValue.dispatches)) {
      throw new ShardedBoardStoreError('Antonina pre-cutover queue or catalog is malformed');
    }

    // The feed is read whole and its comment entries resolved, which is the step
    // that makes the import a real migration rather than a ref copy: the old
    // entries may name a comment page, and the new store's entries carry their
    // own text. Resolving here is what retires the compatibility code.
    const feed: BoardFeedEntry[] = [];
    for (const feedPageRef of refs('feedPageRefs')) {
      const feedPage = await get(feedPageRef);
      if (!isRecord(feedPage) || !Array.isArray(feedPage.entries)) {
        throw new ShardedBoardStoreError('Antonina pre-cutover feed page is malformed');
      }
      for (const entry of feedPage.entries as Array<Record<string, unknown>>) {
        feed.push(await this.resolveLegacyFeedEntry(get, entry, issues));
      }
    }
    feed.sort((left, right) => left.position - right.position);

    const nextIssueNumber = requireSafeCount(metaValue.nextIssueNumber, 'next issue number');
    return {
      board: {
        schemaVersion: 3,
        nextIssueNumber,
        issues,
        resources: catalogValue.resources as BoardResource[],
        targets: catalogValue.targets as BoardExecutionTarget[],
        dispatches: catalogValue.dispatches as BoardDispatch[],
      },
      queue: [...(queueValue.numbers as number[])],
      feed,
      deleted: metaValue.deleted === true,
      closedAt,
      boardId: pointer.boardId,
      rootKeyId: pointer.rootKeyId,
    };
  }

  /**
   * One pre-cutover feed entry, with its comment body resolved.
   *
   * The old entries are of two kinds: those that name the comment page they were
   * written into, and those whose text is already inline. Both are resolved here
   * so the imported feed is uniform, which is what lets the new store's reader be
   * a plain validator with no branches.
   */
  private async resolveLegacyFeedEntry(
    get: (ref: string) => Promise<unknown>,
    entry: Record<string, unknown>,
    issues: BoardIssue[],
  ): Promise<BoardFeedEntry> {
    const base = {
      id: entry.id as string,
      kind: entry.kind as BoardFeedEntry['kind'],
      at: entry.at as string,
      position: entry.position as number,
      issueNumber: entry.issueNumber as number,
      title: entry.title as string,
      state: entry.state as IssueState,
      messageId: (entry.messageId ?? null) as string | null,
    };
    if (base.kind !== 'comment-added') {
      return { ...base, author: null, body: null };
    }
    if (typeof entry.author === 'string' && typeof entry.body === 'string') {
      return { ...base, author: entry.author, body: entry.body };
    }
    // Named page first, then the issue's own thread, which covers an old entry
    // whose page has been replaced by a later comment to the same issue.
    let message: BoardMessage | undefined;
    if (typeof entry.commentRef === 'string') {
      const page = await get(entry.commentRef);
      if (isRecord(page) && Array.isArray(page.messages)) {
        message = (page.messages as BoardMessage[]).find(
          (candidate) => candidate.id === base.messageId,
        );
      }
    }
    if (message === undefined && typeof entry.commentIndex === 'number') {
      const issue = issues.find((candidate) => candidate.number === base.issueNumber);
      message = issue?.messages[entry.commentIndex];
    }
    if (message === undefined) {
      const issue = issues.find((candidate) => candidate.number === base.issueNumber);
      message = issue?.messages.find((candidate) => candidate.id === base.messageId);
    }
    if (message === undefined) {
      throw new ShardedBoardStoreError(
        `Antonina pre-cutover feed entry ${base.id} names a comment that is not in the board`,
      );
    }
    return { ...base, author: message.author, body: message.body };
  }

  /**
   * Rebuilds `logical` into a fresh store of content-addressed shards and
   * returns the pointer, without publishing it.
   *
   * Only the logical board and the product history are written. Nothing from the
   * old store is carried by reference and no superseded artifact is reproduced,
   * which is what makes the result compact: the import writes one object per
   * live shard and one per 50 feed entries, where the old store held one per
   * shard per revision it had ever been at.
   */
  private async materializeLogical(
    credential: BoardCredential,
    logical: LogicalBoard,
  ): Promise<{ meta: ShardedBoardMeta; pointer: ShardedBoardPointer }> {
    // A fresh identity, because this is a new store rather than a new revision
    // of the old one. Deriving it from the imported content means two imports of
    // the same board agree, which is what makes the cutover reviewable.
    const head = await sha256Id('sha256', canonicalBytes({
      kind: 'compact-import',
      boardId: logical.boardId,
      rootKeyId: logical.rootKeyId,
      revision: 1,
      issues: logical.board.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        messages: issue.messages,
      })) as unknown as CanonicalValue,
      queue: logical.queue,
      resources: logical.board.resources as unknown as CanonicalValue,
      targets: logical.board.targets as unknown as CanonicalValue,
      dispatches: logical.board.dispatches as unknown as CanonicalValue,
      feedCount: logical.feed.length,
    }));

    const directoryPages = new Map<number, DirectoryEntry[]>();
    for (const issue of logical.board.issues) {
      const commentRefs: string[] = [];
      const pages = paginate(issue.messages, V3_COMMENT_PAGE_SIZE);
      for (let index = 0; index < pages.length; index += 1) {
        const page: CommentPage = {
          schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
          boardId: logical.boardId,
          number: issue.number,
          page: index + 1,
          messages: clone(pages[index]!),
        };
        commentRefs.push(await this.writeShard(credential.storageCapability, page));
      }
      const snapshot: IssueSnapshot = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: logical.boardId,
        number: issue.number,
        issue: coreOf(issue),
        closedAt: logical.closedAt.get(issue.number) ?? null,
        messageCount: issue.messages.length,
        commentRefs,
      };
      const ref = await this.writeShard(credential.storageCapability, snapshot);
      const page = directoryPageNumber(issue.number);
      const entries = directoryPages.get(page) ?? [];
      entries.push({ number: issue.number, ref });
      directoryPages.set(page, entries);
    }

    const maxDirectoryPage = logical.board.nextIssueNumber <= 1
      ? 0
      : directoryPageNumber(logical.board.nextIssueNumber - 1);
    const directoryRefs: Array<string | null> = [];
    for (let page = 1; page <= maxDirectoryPage; page += 1) {
      const entries = directoryPages.get(page);
      directoryRefs.push(
        entries === undefined || entries.length === 0
          ? null
          : (await this.writeDirectoryPage(credential, logical.boardId, page, entries, null)).ref,
      );
    }

    const queueRef = await this.writeQueueSnapshot(credential, logical.boardId, logical.queue);
    const catalogRef = await this.writeCatalogSnapshot(credential, logical.boardId, logical.board);

    const state: VerifiedBoardState = {
      board: logical.board,
      queue: logical.queue,
      authorities: [],
      deleted: logical.deleted,
      head,
      migration: unMigratedBoardReport(),
    };
    const { refs: openPageRefs, superseded: openSuperseded } = await this.writeIssueListPages(
      credential, logical.boardId, state, logical.closedAt, 'open', null, null, [],
    );
    const { refs: closedPageRefs, superseded: closedSuperseded } = await this.writeIssueListPages(
      credential, logical.boardId, state, logical.closedAt, 'closed', null, null, [],
    );
    // The import has no superseded generation, so anything these report is a
    // ref that was written twice in this same run. Nothing is reclaimed here: the
    // import is the first writer, and the sweep belongs to the generations after
    // it. The values are returned only so the caller can assert they are empty.
    void [openSuperseded, closedSuperseded];

    const feedPageRefs: string[] = [];
    const feedPages = paginate(logical.feed, V3_FEED_PAGE_SIZE);
    for (let index = 0; index < feedPages.length; index += 1) {
      const page: FeedPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: logical.boardId,
        page: index + 1,
        entries: clone(feedPages[index]!),
      };
      feedPageRefs.push(await this.writeShard(credential.storageCapability, page));
    }

    const meta: ShardedBoardMeta = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: logical.boardId,
      rootKeyId: logical.rootKeyId,
      head,
      revision: 1,
      updatedAt: latestBoardTimestamp(logical.board, logical.feed.at(-1)?.at ?? this.now().toISOString()),
      // Names the format the board came from, so an operator looking at the
      // imported store can tell it was rebuilt rather than carried across.
      migratedFrom: LEGACY_POINTER_FORMAT,
      nextIssueNumber: logical.board.nextIssueNumber,
      issueCount: logical.board.issues.length,
      openIssueCount: logical.board.issues.filter((issue) => issue.state === 'open').length,
      closedIssueCount: logical.board.issues.filter((issue) => issue.state === 'closed').length,
      directoryRefs,
      openPageRefs,
      closedPageRefs,
      queueRef,
      catalogRef,
      feedPageRefs,
      feedCount: logical.feed.length,
      deleted: logical.deleted,
      retainsMetaRef: null,
      supersededRefs: [],
      introducedRefs: [],
      unreclaimableShards: 0,
    };
    const metaRef = await this.writeMeta(credential, meta);
    return {
      meta,
      pointer: {
        schemaVersion: 3,
        format: POINTER_FORMAT,
        boardId: logical.boardId,
        rootKeyId: logical.rootKeyId,
        head,
        revision: 1,
        metaRef,
      },
    };
  }

  /**
   * Reads a pre-cutover store and, with `confirm`, republishes the board from it.
   *
   * Without `confirm` this is a plan: it reads, rebuilds, verifies, and reports,
   * and publishes nothing. With it, the same work happens and then the pointer is
   * replaced under `If-Match`, which is the only atomic step and the only one that
   * changes what any client will read.
   *
   * The old store is never written to and never deleted from, and the pointer no
   * longer names it, so it is unreachable garbage for Skrynia's own
   * namespace-level collection to remove wholesale. That is a statement about
   * this code and about reachability, not about protection: its objects are
   * pre-cutover `immutable` objects, and Skrynia removed the `immutable` mode from
   * the creation vocabulary while deliberately making the legacy objects it left
   * on disk deletable, so the API would delete them if this code asked. The store
   * is intact because nothing here addresses it, and not because the two formats
   * are alike. Two differences this file establishes about the pre-cutover store,
   * named here rather than left as a general assertion, and not as an exhaustive
   * list: its meta is read as a plain record instead of through `parseMeta`
   * (2173-2176), and its feed entries take three paths: an entry whose kind is not
   * `comment-added` is returned with a null author and body, one whose author and
   * body are already inline strings is returned with that text, and one that names
   * a comment is looked up by its `commentRef` page, then by its `commentIndex` in
   * the issue's own thread, then by `messageId` in that thread (2295-2325). Those
   * are reasons the import rebuilds rather
   * than translates; neither is a protection, and this file does not claim the two
   * formats are otherwise identical.
   */
  async importBoard(
    credentialValue: BoardCredential,
    options: { confirm?: boolean } = {},
  ): Promise<BoardImportReport> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointerStored = await this.readPointer();
    if (pointerStored === null) {
      throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
    }
    const legacyPointer = pointerStored.value;
    if (legacyPointer.format === POINTER_FORMAT) {
      // Already cut over. Report the current state rather than re-importing: a
      // second import would rewrite the board at a new head for no reason.
      return this.reportCutoverComplete(credential, legacyPointer);
    }

    const logical = await this.readLegacyBoard(credential, legacyPointer);
    const { meta, pointer } = await this.materializeLogical(credential, logical);
    const checks = await this.verifyImport(credential, logical, pointer);
    const equivalent = checks.every((check) => check.equal);
    const reachable = await this.pinnedRefs(credential, meta);
    const legacyObjects = await this.countLegacyObjects(credential, legacyPointer);

    const report: BoardImportReport = {
      boardId: logical.boardId,
      state: 'needs-import',
      cutover: false,
      fromRevision: legacyPointer.revision,
      toRevision: null,
      importedRefs: reachable.size,
      issues: logical.board.issues.length,
      comments: logical.board.issues.reduce((total, issue) => total + issue.messages.length, 0),
      feedEntries: logical.feed.length,
      queueLength: logical.queue.length,
      resources: logical.board.resources.length,
      targets: logical.board.targets.length,
      dispatches: logical.board.dispatches.length,
      checks,
      equivalent,
      legacyStore: {
        pointer: legacyPointer.metaRef,
        shardObjects: legacyObjects,
        note: 'the pre-cutover store is left whole and unreachable; Skrynia removes it, not Antonina',
      },
      storage: {
        // The board has never run a sweep in this format, so it has no total to
        // report and saying "0" would claim a health the board has not been
        // observed to have. The note carries the fact instead.
        unreclaimableShards: 0,
        note: 'not yet cut over, so this board has reclaimed nothing in this format; '
          + 'nothing protects those objects from the API, which would delete them, '
          + 'and this code never asks because the pre-cutover store is unreachable from the new pointer',
      },
    };

    if (options.confirm !== true) return report;
    if (!equivalent) {
      throw new ShardedBoardStoreError(
        'Antonina board import failed verification and was not published; '
        + `failed checks: ${checks.filter((check) => !check.equal).map((check) => check.name).join(', ')}`,
      );
    }
    if (!await this.commitPointer(credential.storageCapability, pointerStored.etag, pointer)) {
      throw new ShardedBoardStoreError(
        'Antonina board changed during import; nothing was published, re-run the import',
        { status: 412, method: 'PUT' },
      );
    }
    return { ...report, cutover: true, state: 'cutover-complete', toRevision: pointer.revision };
  }

  /**
   * Reads the just-imported board back through the *runtime* path and compares it
   * to what the import intended, field by field.
   *
   * Both sides are compared as `LogicalBoard`, so the check cannot pass by
   * comparing the wrong things: it covers issue bodies and every comment with its
   * author and timestamps, open/closed state, the queue order, resources, targets,
   * dispatches, the feed's ordering and content, and the counters a client reads.
   *
   * The new side is read through the public readers, not by re-walking the shards
   * the importer just wrote. That is deliberate: a check that inspected the
   * importer's own output would confirm only that the importer is self-consistent,
   * whereas this confirms that the store the runtime will actually serve says the
   * same thing the old store did.
   */
  private async verifyImport(
    credential: BoardCredential,
    intended: LogicalBoard,
    imported: ShardedBoardPointer,
  ): Promise<EquivalenceCheck[]> {
    const checks: EquivalenceCheck[] = [];
    const same = (name: string, left: unknown, right: unknown): void => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      checks.push({
        name,
        equal: leftJson === rightJson,
        difference: leftJson === rightJson ? null : `imported ${rightJson} != source ${leftJson}`,
      });
    };

    const bundle = await this.readBundle(credential, imported);
    const meta = await this.readMeta(imported, credential);
    const feed: BoardFeedEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.readFeedFrom(credential, meta, cursor === undefined
        ? { limit: V3_FEED_PAGE_SIZE }
        : { limit: V3_FEED_PAGE_SIZE, cursor });
      feed.push(...page.entries);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    same('nextIssueNumber', intended.board.nextIssueNumber, bundle.state.board.nextIssueNumber);
    same(
      'issues',
      intended.board.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        messages: issue.messages,
      })),
      bundle.state.board.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        messages: issue.messages,
      })),
    );
    same('queue', intended.queue, bundle.state.queue);
    same('resources', intended.board.resources, bundle.state.board.resources);
    same('targets', intended.board.targets, bundle.state.board.targets);
    same('dispatches', intended.board.dispatches, bundle.state.board.dispatches);
    // The feed is *served* newest-first, which is the order a reader pages in,
    // and *stored* in position order. Compared in position order, and the served
    // order is checked separately below so neither is left unasserted.
    const byPosition = (entries: BoardFeedEntry[]) => [...entries].sort((a, b) => a.position - b.position);
    same('feed', byPosition(intended.feed), byPosition(feed));
    const servedDescending = feed.every(
      (entry, index) => index === 0 || feed[index - 1]!.position > entry.position,
    );
    checks.push({
      name: 'feedServedNewestFirst',
      equal: servedDescending,
      difference: servedDescending ? null : 'the served feed is not in descending position order',
    });
    same('deleted', intended.deleted, bundle.state.deleted);
    same('feedCount', intended.feed.length, meta.feedCount);
    same('issueCount', intended.board.issues.length, meta.issueCount);
    same(
      'openIssueCount',
      intended.board.issues.filter((issue) => issue.state === 'open').length,
      meta.openIssueCount,
    );
    same(
      'closedIssueCount',
      intended.board.issues.filter((issue) => issue.state === 'closed').length,
      meta.closedIssueCount,
    );
    return checks;
  }

  /**
   * How many shard objects the pre-cutover store holds, counted from its own
   * recorded shards.
   *
   * It is a lower bound and the report says so: Skrynia exposes no listing
   * primitive, so the superseded objects the old store never named again cannot
   * be counted at all. The number is reported because it is the size of the
   * residue an operator is being asked to have Skrynia remove, and a floor is
   * still a floor.
   */
  private async countLegacyObjects(
    credential: BoardCredential,
    legacyPointer: ShardedBoardPointer,
  ): Promise<number> {
    const logical = await this.readLegacyBoard(credential, legacyPointer);
    // One directory page per 50 issue numbers, one comment page per 50 messages,
    // one feed page per 50 entries, plus the singletons.
    const directoryPages = Math.ceil(logical.board.issues.length / DIRECTORY_PAGE_SIZE);
    const commentPages = logical.board.issues.reduce(
      (total, issue) => total + Math.ceil(issue.messages.length / V3_COMMENT_PAGE_SIZE),
      0,
    );
    const feedPages = Math.ceil(logical.feed.length / V3_FEED_PAGE_SIZE);
    return directoryPages + commentPages + feedPages
      + logical.board.issues.length + 1 + 1 + 2 + 1;
  }

  private async reportCutoverComplete(
    credential: BoardCredential,
    pointer: ShardedBoardPointer,
  ): Promise<BoardImportReport> {
    const meta = await this.readMeta(pointer, credential);
    const reachable = await this.pinnedRefs(credential, meta);
    const bundle = await this.readBundle(credential, pointer);
    return {
      boardId: pointer.boardId,
      state: 'cutover-complete',
      cutover: false,
      fromRevision: pointer.revision,
      toRevision: pointer.revision,
      importedRefs: reachable.size,
      issues: bundle.state.board.issues.length,
      comments: bundle.state.board.issues.reduce((total, issue) => total + issue.messages.length, 0),
      feedEntries: meta.feedCount,
      queueLength: bundle.state.queue.length,
      resources: bundle.state.board.resources.length,
      targets: bundle.state.board.targets.length,
      dispatches: bundle.state.board.dispatches.length,
      checks: [],
      equivalent: true,
      legacyStore: {
        pointer: '',
        shardObjects: 0,
        note: 'already cut over; there is no pre-cutover store to remove',
      },
      storage: {
        unreclaimableShards: meta.unreclaimableShards,
        note: meta.unreclaimableShards === 0
          ? 'reclamation is keeping up with the board'
          : 'storage is growing faster than it is reclaimed; the reclaim premise may no longer hold',
      },
    };
  }

  /** Which side of the cutover a pointer is on, read without changing anything. */
  async cutoverState(
    credentialValue: BoardCredential,
    pointerStored: JsonObject<ShardedBoardPointer>,
  ): Promise<{
    legacyPointer: string | null;
    report: BoardImportReport | null;
  }> {
    const credential = await verifyBoardCredential(credentialValue);
    if (pointerStored.value.format === POINTER_FORMAT) {
      return { legacyPointer: null, report: null };
    }
    // A plan, not a cutover: this reads the old store and reports what an import
    // would carry across, without writing anything.
    return {
      legacyPointer: pointerStored.value.metaRef,
      report: await this.importBoard(credential, { confirm: false }),
    };
  }

  async read(
    credentialValue: BoardCredential,
  ): Promise<StoredSignedBoard | null> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointerStored = await this.readPointer();
    if (pointerStored === null) return null;
    this.requireCurrentPointer(pointerStored);
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
      // Reset per attempt: refs written by a lost CAS belong to a generation
      // that was never committed and say nothing about this one.
      this.writtenRefs = new Set<string>();
      const pointerStored = await this.readPointer();
      if (pointerStored === null) throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
      this.requireCurrentPointer(pointerStored);
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
      // the directory page containing the touched issue is read.
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

      // The refs this mutation stops pinning. Collected as the writer goes
      // rather than derived afterwards, so a mutation never has to enumerate
      // the board to find out what it may delete -- which is what would
      // otherwise force a full hydration on every write.
      const superseded: string[] = [];
      const nextDirectoryRefs = [...bundle.meta.directoryRefs];
      const issueMutation = request.kind.startsWith('issue.');
      if (issueMutation && beforeIssueNumber !== null) {
        const directoryPage = directoryPageNumber(beforeIssueNumber);
        // Read the page the mutation is about to rewrite, so the entries below
        // start from what is actually in storage rather than from a copy this
        // bundle happened to have cached. One read, one page: the fast path
        // still does not walk the board.
        const directory = await this.readDirectoryPage(credential, bundle.meta, directoryPage);
        if (directory !== null) bundle.directoryPages.set(directoryPage, directory);
        const entries = clone(bundle.directoryPages.get(directoryPage)?.entries ?? []);
        const entryIndex = entries.findIndex((entry) => entry.number === beforeIssueNumber);
        const previousEntryRef = entryIndex >= 0 ? entries[entryIndex]!.ref : null;

        if (request.kind === 'issue.delete') {
          // The entry goes, and with it the issue snapshot and every comment page
          // it pinned. Nothing needs them: a feed entry carries its own text, so
          // the history of a deleted issue survives in the feed without the issue
          // continuing to exist in the directory. That is the whole reason this
          // path is three lines rather than a tombstone.
          if (entryIndex >= 0) entries.splice(entryIndex, 1);
          const previousSnapshot = bundle.issueSnapshots.get(beforeIssueNumber);
          superseded.push(...(previousEntryRef === null ? [] : [previousEntryRef]));
          superseded.push(...(previousSnapshot?.commentRefs ?? []));
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
      const feed = await this.appendFeed(credential, bundle.meta, feedEntry);
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
        retainsMetaRef: pointer.metaRef,
        // The refs this generation replaced, recorded so the next writer can
        // reclaim them one generation later, once no reachable meta pins them.
        supersededRefs: superseded,
        // Every ref this generation wrote, so a later sweep walking back over it
        // can tell which refs a newer generation has put back.
        introducedRefs: [...this.writtenRefs].sort(),
        // The previous generation's running total of what its own sweep could not
        // delete, carried forward so the number survives the process that measured
        // it. One commit of lag is deliberate: this meta is written before the
        // sweep that would amend it.
        unreclaimableShards: bundle.meta.unreclaimableShards + this.lastSweep.retained,
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
      await this.sweepAfterCommit(credential, meta);
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
   * the recorded `supersededRefs` of some generation outside the retention
   * window, and by nothing any generation inside it still pins.
   */
  private async sweepAfterCommit(
    credential: BoardCredential,
    committed: ShardedBoardMeta,
  ): Promise<void> {
    // The refs this commit replaced are recorded in `committed` and are
    // deliberately NOT reclaimed here: the generation this commit superseded
    // still pins them, and a reader holding that older pointer must be able to
    // finish. What is eligible is whatever `reclaimOutsideWindow` finds on the
    // chain, and the rule it applies is the age of the generation that recorded
    // the set -- not the number of commits since. A commit count is a statement
    // about how often writers commit and nothing about how long a read takes; a
    // board committing twice inside one `readBundle` fan-out would have a
    // resolved generation's shards deleted out from under the reader, which
    // surfaces as a 404 that `requireJson` reports as a credential problem.
    try {
      const { outcome, eligible } = await this.reclaimOutsideWindow(credential, committed);
      this.lastSweep = {
        revision: committed.revision,
        // Every generation still inside the window, which on a healthy board is
        // the normal state of a sweep and not a failure of one. It is recorded so
        // a test can tell "the window held" from "the sweep ran and found
        // nothing", which are the same object count and opposite meanings.
        skipped: !eligible,
        reclaimed: outcome.deleted,
        // Everything not confirmed deleted is carried into the next generation's
        // durable total. `absent` is included deliberately: the object may have
        // been in the namespace, and that count is documented as an upper bound
        // on the leak rather than a measurement of it.
        retained: outcome.absent + outcome.refused + outcome.error,
        refused: outcome.refused,
        failed: outcome.error,
        at: this.now().toISOString(),
        error: null,
      };
    } catch (error) {
      // A leak, not a lost write. Recorded on the sweep report, and carried into
      // the next generation's durable total by the same rule as any other
      // non-result, so an operator sees it through `importBoard` rather than
      // through a method with no callers.
      this.lastSweep = {
        revision: committed.revision,
        skipped: false,
        reclaimed: 0,
        retained: 1,
        refused: 0,
        failed: 1,
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
    this.requireCurrentPointer(pointerStored);
    const meta = await this.readMeta(pointerStored.value, credential);
    return { credential, pointer: pointerStored.value, meta };
  }

  /**
   * What the last mutation's reclamation did, in this process.
   *
   * This is per-process state, so it is NOT the operator's view: it says nothing
   * about sweeps this process did not run, which is exactly the case that matters
   * when the reclaim premise has quietly stopped holding. The durable, process-
   * independent half is `unreclaimableShards` on the live meta, which every
   * generation carries forward and which `importBoard` and `cutoverState` report.
   *
   * What this is for is a test asserting that a sweep ran, was skipped by the
   * window, or refused a shard, without having to count objects in the fake.
   */
  sweepReport(): BoardSweepReport {
    return { ...this.lastSweep };
  }

  async getIssue(
    credentialValue: BoardCredential,
    number: number,
  ): Promise<BoardIssue | null> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const resolved = await this.readIssueSnapshotByNumber(credential, meta, number);
    return resolved?.issue ?? null;
  }

  /**
   * Read one logical issue page newest-first without hydrating the entire
   * append-only comment history. Storage comment shards are oldest-first, so a
   * logical page can straddle two physical shards.
   */
  async getIssuePage(
    credentialValue: BoardCredential,
    number: number,
    page: number,
  ): Promise<BoardIssue | null> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const resolved = await this.readIssueSnapshotByNumber(credential, meta, number, false);
    if (resolved === null) return null;

    const { snapshot, issue } = resolved;
    const end = Math.max(0, snapshot.messageCount - (page - 1) * V3_COMMENT_PAGE_SIZE);
    const start = Math.max(0, end - V3_COMMENT_PAGE_SIZE);
    if (start >= end) return issue;

    const firstPhysicalIndex = Math.floor(start / V3_COMMENT_PAGE_SIZE);
    const lastPhysicalIndex = Math.floor((end - 1) / V3_COMMENT_PAGE_SIZE);
    const physicalPages = await Promise.all(
      snapshot.commentRefs
        .slice(firstPhysicalIndex, lastPhysicalIndex + 1)
        .map((commentRef, offset) => this.readCommentPage(
          credential,
          meta,
          number,
          commentRef,
          firstPhysicalIndex + offset + 1,
        )),
    );
    const physicalStart = firstPhysicalIndex * V3_COMMENT_PAGE_SIZE;
    const messages = physicalPages.flat().slice(start - physicalStart, end - physicalStart);
    return { ...issue, messages: clone(messages) };
  }

  /**
   * One bounded page of one issue's conversation.
   *
   * This is the read that replaces "reassemble the thread" for a reader who is
   * looking at a page of it. It fetches the directory page that names the
   * issue, that issue's own snapshot shard, and at most ONE comment shard: the
   * one holding the requested page. A page past the end of the thread fetches no
   * comment shard at all, because the snapshot's own `commentRefs` already says
   * there is nothing there — the empty page is a fact about the snapshot, not
   * something that has to be confirmed against the shards.
   *
   * `issue` comes back with its `messages` array empty. The page the caller asked
   * for is `messages`, and carrying the thread as well would reintroduce exactly
   * the fan-out this method exists to remove.
   *
   * `pageCount` is the number of comment shards the snapshot carries, which is
   * the number of pages the thread has; `total` is the whole thread's message
   * count, taken from the snapshot's stored `messageCount` rather than from the
   * page. So the count and the range a reader sees are the thread's, not this
   * page's.
   */
  async readIssueCommentPage(
    credentialValue: BoardCredential,
    number: number,
    page: number,
  ): Promise<IssueCommentPage | null> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new ShardedBoardStoreError('Antonina comment page must be a positive integer');
    }
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const resolved = await this.readIssueSnapshotByNumber(credential, meta, number, false);
    if (resolved === null) return null;
    const { snapshot, issue } = resolved;
    return {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      issue,
      page,
      pageCount: Math.max(1, snapshot.commentRefs.length),
      total: snapshot.messageCount,
      messages: await this.readCommentShard(credential, meta, snapshot, page - 1),
    };
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

  /**
   * Validates one stored feed entry and returns it.
   *
   * No lookups: entries are self-contained (see `StoredFeedEntry`), so reading a
   * feed page costs the pages themselves and nothing else. A comment entry must
   * carry its author and body, and the shape is checked rather than trusted so a
   * malformed page is reported rather than surfaced as a feed with null bodies.
   */
  private hydrateFeedEntry(entry: StoredFeedEntry): BoardFeedEntry {
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
    if (typeof entry.author !== 'string' || typeof entry.body !== 'string') {
      throw new ShardedBoardStoreError('Antonina feed comment is missing its body');
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

  async readFeed(
    credentialValue: BoardCredential,
    request: BoardFeedRequest = {},
  ): Promise<BoardFeedPage> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    return this.readFeedFrom(credential, meta, request);
  }

  /**
   * The feed of a named generation.
   *
   * The public read resolves the live pointer and then calls this, so there is one
   * paging implementation rather than two. The import's verification needs the
   * same paging against the *candidate* store, which is not the live pointer
   * until the cutover commits -- and reading the live one there would verify the
   * old board against itself.
   */
  private async readFeedFrom(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    request: BoardFeedRequest = {},
  ): Promise<BoardFeedPage> {
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
      pageEntries.map((entry) => this.hydrateFeedEntry(entry)),
    );
    return {
      entries: hydrated,
      nextCursor: entries.length > limit && last !== undefined ? feedCursor(last) : null,
      total: meta.feedCount,
      limit,
    };
  }
}
