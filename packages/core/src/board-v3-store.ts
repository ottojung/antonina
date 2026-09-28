import { base64UrlEncode, type CanonicalValue } from './canonical.js';
import {
  credentialSigningKey,
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
  type BoardIssue,
  type BoardMessage,
  type BoardDispatch,
  type BoardExecutionTarget,
  type BoardResource,
  type IssueState,
} from './model.js';
import {
  OPLOG_SCHEMA_VERSION,
  parseSignedBoardOperation,
  signBoardOperation,
  verifyAndReplayOperationLog,
  type BoardOperationLog,
  type BoardOperationPayload,
  type BoardTrustAnchor,
  type SignedBoardOperation,
  type VerifiedAuthority,
  type VerifiedBoardState,
} from './operations.js';
import type {
  AppendOperationRequest,
  SignedBoardStoreOptions,
  StoredSignedBoard,
} from './board-store.js';

export const SHARDED_BOARD_SCHEMA_VERSION = 1 as const;
export const SHARDED_META_KEY = 'board-v3-meta';
export const SHARDED_LOG_PREFIX = 'board-v3-log';
export const SHARDED_ISSUE_PREFIX = 'board-v3-issue';
export const SHARDED_COMMENT_PREFIX = 'board-v3-comments';
export const SHARDED_OPEN_PREFIX = 'board-v3-issues-open';
export const SHARDED_CLOSED_PREFIX = 'board-v3-issues-closed';
export const SHARDED_QUEUE_KEY = 'board-v3-queue';
export const SHARDED_CATALOG_KEY = 'board-v3-catalog';
export const SHARDED_AUTHORITIES_KEY = 'board-v3-authorities';
export const SHARDED_FEED_PREFIX = 'board-v3-feed';

export const V3_LOG_CHUNK_SIZE = 100;
export const V3_ISSUE_PAGE_SIZE = 50;
export const V3_COMMENT_PAGE_SIZE = 50;
export const V3_FEED_PAGE_SIZE = 50;

const DEFAULT_MAX_ATTEMPTS = 6;
const textEncoder = new TextEncoder();

export interface ShardedBoardMeta {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  rootKeyId: string;
  head: string;
  operationCount: number;
  /** Number of immutable, full log chunks preceding tailOperations. */
  logChunkCount: number;
  /** The committed mutable tail; bounded to V3_LOG_CHUNK_SIZE operations. */
  tailOperations: SignedBoardOperation[];
  /** Highest committed revision fully reflected in all materialized caches. */
  materializedRevision: number;
  nextIssueNumber: number;
  issueCount: number;
  openIssueCount: number;
  closedIssueCount: number;
  openPageCount: number;
  closedPageCount: number;
  feedCount: number;
  feedPageCount: number;
  deleted: boolean;
  migratedFrom: string;
}

interface ShardedLogChunk {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  chunk: number;
  operations: SignedBoardOperation[];
}

interface IssueCore {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  createdAt: string;
  updatedAt: string;
}

interface ShardedIssueRecord {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  number: number;
  revision: number;
  deleted: boolean;
  issue: IssueCore | null;
  messageCount: number;
  commentPageCount: number;
}

interface ShardedCommentPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  number: number;
  page: number;
  revision: number;
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

export interface IssueListPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  state: IssueState;
  page: number;
  revision: number;
  total: number;
  entries: IssueListSummary[];
}

interface ShardedQueue {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  revision: number;
  numbers: number[];
}

interface ShardedCatalog {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  revision: number;
  resources: BoardResource[];
  targets: BoardExecutionTarget[];
  dispatches: BoardDispatch[];
}

interface ShardedAuthorities {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  revision: number;
  authorities: VerifiedAuthority[];
}

interface ShardedFeedPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  page: number;
  revision: number;
  entries: BoardFeedEntry[];
}

interface JsonObject<T> {
  value: T;
  etag: string;
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

function padded(value: number): string {
  return String(value).padStart(9, '0');
}

function logKey(chunk: number): string {
  return `${SHARDED_LOG_PREFIX}-${padded(chunk)}`;
}

function issueKey(number: number): string {
  return `${SHARDED_ISSUE_PREFIX}-${padded(number)}`;
}

function commentKey(number: number, page: number): string {
  return `${SHARDED_COMMENT_PREFIX}-${padded(number)}-${padded(page)}`;
}

function issuePageKey(state: IssueState, page: number): string {
  return `${state === 'open' ? SHARDED_OPEN_PREFIX : SHARDED_CLOSED_PREFIX}-${padded(page)}`;
}

function feedPageKey(page: number): string {
  return `${SHARDED_FEED_PREFIX}-${padded(page)}`;
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

function parseMeta(value: unknown): ShardedBoardMeta {
  if (!isRecord(value)
      || value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
      || typeof value.boardId !== 'string'
      || typeof value.rootKeyId !== 'string'
      || typeof value.head !== 'string'
      || typeof value.deleted !== 'boolean'
      || typeof value.migratedFrom !== 'string') {
    throw new ShardedBoardStoreError('Antonina v3 metadata is malformed');
  }
  return {
    schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
    boardId: value.boardId,
    rootKeyId: value.rootKeyId,
    head: value.head,
    operationCount: requireSafeCount(value.operationCount, 'operation count'),
    logChunkCount: requireSafeCount(value.logChunkCount, 'log chunk count'),
    tailOperations: Array.isArray(value.tailOperations)
      ? value.tailOperations.map(parseSignedBoardOperation)
      : (() => { throw new ShardedBoardStoreError('Antonina v3 tail operations are malformed'); })(),
    materializedRevision: requireSafeCount(value.materializedRevision, 'materialized revision'),
    nextIssueNumber: requireSafeCount(value.nextIssueNumber, 'next issue number'),
    issueCount: requireSafeCount(value.issueCount, 'issue count'),
    openIssueCount: requireSafeCount(value.openIssueCount, 'open issue count'),
    closedIssueCount: requireSafeCount(value.closedIssueCount, 'closed issue count'),
    openPageCount: requireSafeCount(value.openPageCount, 'open page count'),
    closedPageCount: requireSafeCount(value.closedPageCount, 'closed page count'),
    feedCount: requireSafeCount(value.feedCount, 'feed count'),
    feedPageCount: requireSafeCount(value.feedPageCount, 'feed page count'),
    deleted: value.deleted,
    migratedFrom: value.migratedFrom,
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

function issueRecord(boardId: string, issue: BoardIssue, revision: number): ShardedIssueRecord {
  return {
    schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
    boardId,
    number: issue.number,
    revision,
    deleted: false,
    issue: coreOf(issue),
    messageCount: issue.messages.length,
    commentPageCount: Math.ceil(issue.messages.length / V3_COMMENT_PAGE_SIZE),
  };
}

function deletedIssueRecord(boardId: string, number: number, revision: number): ShardedIssueRecord {
  return {
    schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
    boardId,
    number,
    revision,
    deleted: true,
    issue: null,
    messageCount: 0,
    commentPageCount: 0,
  };
}

function closedAtByIssue(log: BoardOperationLog, board: Board): Map<number, string> {
  const closed = new Map<number, string>();
  for (const issue of board.issues) {
    if (issue.state === 'closed') closed.set(issue.number, issue.updatedAt);
  }
  for (const operation of log.operations) {
    if (operation.kind === 'issue.close') {
      const payload = operation.payload as { number: number };
      closed.set(payload.number, operation.timestamp);
    } else if (operation.kind === 'issue.reopen' || operation.kind === 'issue.delete') {
      const payload = operation.payload as { number: number };
      closed.delete(payload.number);
    }
  }
  return closed;
}

function orderedIssues(state: VerifiedBoardState, log: BoardOperationLog, issueState: IssueState): BoardIssue[] {
  const byNumber = new Map(state.board.issues.map((issue) => [issue.number, issue]));
  if (issueState === 'open') {
    return state.queue.flatMap((number) => {
      const issue = byNumber.get(number);
      return issue?.state === 'open' ? [issue] : [];
    });
  }
  const closedAt = closedAtByIssue(log, state.board);
  return state.board.issues
    .filter((issue) => issue.state === 'closed')
    .sort((left, right) => {
      const time = (closedAt.get(right.number) ?? right.updatedAt)
        .localeCompare(closedAt.get(left.number) ?? left.updatedAt);
      return time || right.number - left.number;
    });
}

function summaries(state: VerifiedBoardState, log: BoardOperationLog, issueState: IssueState): IssueListSummary[] {
  const closedAt = closedAtByIssue(log, state.board);
  return orderedIssues(state, log, issueState).map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? (closedAt.get(issue.number) ?? issue.updatedAt) : null,
    messageCount: issue.messages.length,
    hasBody: issue.body.length > 0,
  }));
}

function issuePages(
  boardId: string,
  state: VerifiedBoardState,
  log: BoardOperationLog,
  issueState: IssueState,
  revision: number,
): IssueListPage[] {
  const entries = summaries(state, log, issueState);
  const pages: IssueListPage[] = [];
  for (let offset = 0; offset < entries.length; offset += V3_ISSUE_PAGE_SIZE) {
    pages.push({
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      state: issueState,
      page: Math.floor(offset / V3_ISSUE_PAGE_SIZE) + 1,
      revision,
      total: entries.length,
      entries: entries.slice(offset, offset + V3_ISSUE_PAGE_SIZE),
    });
  }
  return pages;
}

function feedPages(boardId: string, log: BoardOperationLog, revision: number): ShardedFeedPage[] {
  const ascending = [...feedEntries(log)].sort((left, right) => left.position - right.position);
  const pages: ShardedFeedPage[] = [];
  for (let offset = 0; offset < ascending.length; offset += V3_FEED_PAGE_SIZE) {
    pages.push({
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      page: Math.floor(offset / V3_FEED_PAGE_SIZE) + 1,
      revision,
      entries: ascending.slice(offset, offset + V3_FEED_PAGE_SIZE),
    });
  }
  return pages;
}

function metaFor(
  log: BoardOperationLog,
  state: VerifiedBoardState,
  migratedFrom: string,
  materializedRevision: number,
): ShardedBoardMeta {
  const feedCount = feedEntries(log).length;
  const open = state.board.issues.filter((issue) => issue.state === 'open').length;
  const closed = state.board.issues.filter((issue) => issue.state === 'closed').length;
  // Keep at least one committed operation in the CAS-controlled tail. Full
  // chunks before it are immutable once sealed.
  const logChunkCount = Math.floor((log.operations.length - 1) / V3_LOG_CHUNK_SIZE);
  const tailOperations = log.operations.slice(logChunkCount * V3_LOG_CHUNK_SIZE);
  return {
    schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
    boardId: log.boardId,
    rootKeyId: log.rootKeyId,
    head: state.head,
    operationCount: log.operations.length,
    logChunkCount,
    tailOperations,
    materializedRevision,
    nextIssueNumber: state.board.nextIssueNumber,
    issueCount: state.board.issues.length,
    openIssueCount: open,
    closedIssueCount: closed,
    openPageCount: Math.ceil(open / V3_ISSUE_PAGE_SIZE),
    closedPageCount: Math.ceil(closed / V3_ISSUE_PAGE_SIZE),
    feedCount,
    feedPageCount: Math.ceil(feedCount / V3_FEED_PAGE_SIZE),
    deleted: state.deleted,
    migratedFrom,
  };
}

function appendToLog(log: BoardOperationLog, operation: SignedBoardOperation): BoardOperationLog {
  return {
    ...clone(log),
    head: operation.opId,
    operations: [...log.operations, operation],
  };
}

function canonicalTimestampAtOrAfter(value: string, floor?: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new ShardedBoardStoreError('Signed board operation timestamp must be canonical ISO-8601 UTC');
  }
  if (floor === undefined) return value;
  const floorMillis = Date.parse(floor);
  if (!Number.isFinite(floorMillis)) throw new ShardedBoardStoreError('Signed board timestamp floor is malformed');
  return new Date(Math.max(millis, floorMillis)).toISOString();
}

function feedCursor(entry: Pick<BoardFeedEntry, 'at' | 'position'>): string {
  return 'v1.' + base64UrlEncode(textEncoder.encode(JSON.stringify([entry.at, entry.position])));
}

export class ShardedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SignedBoardStoreOptions = {}) {
    if (options.maxAttempts !== undefined && options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be positive');
    }
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? '/_skrynia').replace(/\/$/, '');
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  private url(key: string): string {
    return `${this.baseUrl}/store/antonina/${encodeURIComponent(key)}`;
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new ShardedBoardStoreError(`${context} returned invalid JSON`, { cause: error });
    }
  }

  private httpError(method: string, key: string, response: Response): ShardedBoardStoreError {
    return new ShardedBoardStoreError(
      `Skrynia ${method} antonina/${key} failed (${response.status})`,
      { status: response.status, method },
    );
  }

  private async getJson<T>(key: string): Promise<JsonObject<T> | null> {
    const response = await this.fetcher(this.url(key), { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.httpError('GET', key, response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new ShardedBoardStoreError(`Skrynia GET antonina/${key} returned no ETag`);
    return { value: await this.parseJson(response, `Skrynia GET antonina/${key}`) as T, etag };
  }

  private async createPublic(key: string, value: unknown): Promise<boolean> {
    const response = await this.fetcher(this.url(key), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'public-write',
      },
      body: JSON.stringify(value),
    });
    if (response.status === 409) return false;
    if (response.status !== 201) throw this.httpError('POST', key, response);
    return true;
  }

  private async putPublic(key: string, value: unknown, etag?: string): Promise<boolean> {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (etag !== undefined) headers.set('If-Match', etag);
    const response = await this.fetcher(this.url(key), {
      method: 'PUT',
      headers,
      body: JSON.stringify(value),
    });
    if (response.status === 412) return false;
    if (response.status !== 200) throw this.httpError('PUT', key, response);
    return true;
  }

  private async upsertPublic(key: string, value: unknown): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const current = await this.getJson<unknown>(key);
      if (current === null) {
        if (await this.createPublic(key, value)) return;
      } else {
        // Projection writes can overlap after the canonical metadata CAS.
        // Never let an older committed revision overwrite a newer projection.
        if (isRecord(current.value) && isRecord(value)
            && Number.isSafeInteger(current.value.revision)
            && Number.isSafeInteger(value.revision)
            && (current.value.revision as number) > (value.revision as number)) {
          return;
        }
        if (await this.putPublic(key, value, current.etag)) return;
      }
    }
    throw new ShardedBoardStoreError(`Antonina v3 object ${key} changed too often`);
  }

  async exists(): Promise<boolean> {
    return (await this.getJson<unknown>(SHARDED_META_KEY)) !== null;
  }

  async loadMeta(anchor?: BoardTrustAnchor): Promise<JsonObject<ShardedBoardMeta> | null> {
    const stored = await this.getJson<unknown>(SHARDED_META_KEY);
    if (stored === null) return null;
    const meta = parseMeta(stored.value);
    if (anchor !== undefined
        && (meta.boardId !== anchor.boardId || meta.rootKeyId !== anchor.rootKeyId)) {
      throw new ShardedBoardStoreError('Antonina v3 metadata does not match the configured trust anchor');
    }
    return { value: meta, etag: stored.etag };
  }

  private async readChunk(boardId: string, chunk: number): Promise<JsonObject<ShardedLogChunk>> {
    const stored = await this.getJson<unknown>(logKey(chunk));
    if (stored === null || !isRecord(stored.value)
        || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || stored.value.boardId !== boardId
        || stored.value.chunk !== chunk
        || !Array.isArray(stored.value.operations)) {
      throw new ShardedBoardStoreError(`Antonina v3 log chunk ${chunk} is missing or malformed`);
    }
    return {
      etag: stored.etag,
      value: {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        chunk,
        operations: stored.value.operations.map(parseSignedBoardOperation),
      },
    };
  }

  private async readLog(meta: ShardedBoardMeta): Promise<BoardOperationLog> {
    if (meta.tailOperations.length < 1 || meta.tailOperations.length > V3_LOG_CHUNK_SIZE) {
      throw new ShardedBoardStoreError('Antonina v3 log tail size is malformed');
    }
    const chunks = await Promise.all(
      Array.from({ length: meta.logChunkCount }, (_, index) => this.readChunk(meta.boardId, index + 1)),
    );
    for (const chunk of chunks) {
      if (chunk.value.operations.length !== V3_LOG_CHUNK_SIZE) {
        throw new ShardedBoardStoreError('Antonina v3 sealed log chunk is not full');
      }
    }
    const operations = [
      ...chunks.flatMap((chunk) => chunk.value.operations),
      ...meta.tailOperations,
    ];
    if (operations.length !== meta.operationCount) {
      throw new ShardedBoardStoreError('Antonina v3 log length does not match its committed operation count');
    }
    if (operations.at(-1)?.opId !== meta.head) {
      throw new ShardedBoardStoreError('Antonina v3 metadata head does not match its committed log');
    }
    return {
      schemaVersion: OPLOG_SCHEMA_VERSION,
      boardId: meta.boardId,
      rootKeyId: meta.rootKeyId,
      head: meta.head,
      operations,
    };
  }

  async read(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    const log = await this.readLog(metaStored.value);
    const state = await verifyAndReplayOperationLog(
      log,
      anchor,
      previouslyAcceptedHead === undefined ? {} : { previouslyAcceptedHead },
    );
    return { log, state, etag: metaStored.etag };
  }

  private async writeIssue(boardId: string, issue: BoardIssue, revision: number): Promise<void> {
    await this.upsertPublic(issueKey(issue.number), issueRecord(boardId, issue, revision));
    const changedPage = issue.messages.length === 0
      ? 0
      : Math.floor((issue.messages.length - 1) / V3_COMMENT_PAGE_SIZE) + 1;
    if (changedPage > 0) {
      const offset = (changedPage - 1) * V3_COMMENT_PAGE_SIZE;
      const page: ShardedCommentPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        number: issue.number,
        page: changedPage,
        revision,
        messages: issue.messages.slice(offset, offset + V3_COMMENT_PAGE_SIZE),
      };
      await this.upsertPublic(commentKey(issue.number, changedPage), page);
    }
  }

  private async writeAllComments(boardId: string, issue: BoardIssue, revision: number): Promise<void> {
    await this.upsertPublic(issueKey(issue.number), issueRecord(boardId, issue, revision));
    const pages = Math.ceil(issue.messages.length / V3_COMMENT_PAGE_SIZE);
    await Promise.all(Array.from({ length: pages }, async (_, index) => {
      const pageNumber = index + 1;
      const page: ShardedCommentPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        number: issue.number,
        page: pageNumber,
        revision,
        messages: issue.messages.slice(index * V3_COMMENT_PAGE_SIZE, (index + 1) * V3_COMMENT_PAGE_SIZE),
      };
      await this.upsertPublic(commentKey(issue.number, pageNumber), page);
    }));
  }

  private async writeQueue(boardId: string, state: VerifiedBoardState, revision: number): Promise<void> {
    const value: ShardedQueue = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      revision,
      numbers: [...state.queue],
    };
    await this.upsertPublic(SHARDED_QUEUE_KEY, value);
  }

  private async writeCatalog(boardId: string, state: VerifiedBoardState, revision: number): Promise<void> {
    const value: ShardedCatalog = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      revision,
      resources: clone(state.board.resources),
      targets: clone(state.board.targets),
      dispatches: clone(state.board.dispatches),
    };
    await this.upsertPublic(SHARDED_CATALOG_KEY, value);
  }

  private async writeAuthorities(boardId: string, state: VerifiedBoardState, revision: number): Promise<void> {
    const value: ShardedAuthorities = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      revision,
      authorities: clone(state.authorities),
    };
    await this.upsertPublic(SHARDED_AUTHORITIES_KEY, value);
  }

  private async writeIssuePages(
    boardId: string,
    state: VerifiedBoardState,
    log: BoardOperationLog,
    revision: number,
    issueState: IssueState,
  ): Promise<void> {
    const pages = issuePages(boardId, state, log, issueState, revision);
    await Promise.all(pages.map((page) => this.upsertPublic(issuePageKey(issueState, page.page), page)));
  }

  private async writeFeedPages(boardId: string, log: BoardOperationLog, revision: number): Promise<void> {
    const pages = feedPages(boardId, log, revision);
    await Promise.all(pages.map((page) => this.upsertPublic(feedPageKey(page.page), page)));
  }

  private async writeAllMaterialized(
    state: VerifiedBoardState,
    log: BoardOperationLog,
    revision: number,
  ): Promise<void> {
    const boardId = log.boardId;
    await Promise.all(state.board.issues.map((issue) => this.writeAllComments(boardId, issue, revision)));
    await this.writeQueue(boardId, state, revision);
    await this.writeCatalog(boardId, state, revision);
    await this.writeAuthorities(boardId, state, revision);
    await this.writeIssuePages(boardId, state, log, revision, 'open');
    await this.writeIssuePages(boardId, state, log, revision, 'closed');
    await this.writeFeedPages(boardId, log, revision);
  }

  async migrate(stored: StoredSignedBoard): Promise<StoredSignedBoard> {
    const existing = await this.loadMeta();
    if (existing !== null) {
      const anchor = {
        boardId: stored.log.boardId,
        rootKeyId: stored.log.rootKeyId,
        rootPublicKey: '',
      };
      if (existing.value.boardId !== anchor.boardId || existing.value.rootKeyId !== anchor.rootKeyId) {
        throw new ShardedBoardStoreError('Existing Antonina v3 board belongs to another trust root');
      }
      return stored;
    }

    const revision = stored.log.operations.length;
    const sealedChunkCount = Math.floor((stored.log.operations.length - 1) / V3_LOG_CHUNK_SIZE);
    const chunks: ShardedLogChunk[] = Array.from({ length: sealedChunkCount }, (_, index) => ({
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: stored.log.boardId,
      chunk: index + 1,
      operations: stored.log.operations.slice(
        index * V3_LOG_CHUNK_SIZE,
        (index + 1) * V3_LOG_CHUNK_SIZE,
      ),
    }));

    await Promise.all(chunks.map((chunk) => this.upsertPublic(logKey(chunk.chunk), chunk)));
    await this.writeAllMaterialized(stored.state, stored.log, revision);

    const meta = metaFor(stored.log, stored.state, stored.state.head, revision);
    const created = await this.createPublic(SHARDED_META_KEY, meta);
    if (!created) {
      const winner = await this.loadMeta();
      if (winner === null
          || winner.value.boardId !== meta.boardId
          || winner.value.rootKeyId !== meta.rootKeyId) {
        throw new ShardedBoardStoreError('Concurrent Antonina v3 migration chose another trust root');
      }
    }
    return stored;
  }

  private async ensureSealedTail(meta: ShardedBoardMeta): Promise<void> {
    if (meta.tailOperations.length !== V3_LOG_CHUNK_SIZE) return;
    const chunkNumber = meta.logChunkCount + 1;
    const chunk: ShardedLogChunk = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      chunk: chunkNumber,
      operations: clone(meta.tailOperations),
    };
    const created = await this.createPublic(logKey(chunkNumber), chunk);
    if (created) return;
    const existing = await this.readChunk(meta.boardId, chunkNumber);
    const existingIds = existing.value.operations.map((operation) => operation.opId);
    const expectedIds = chunk.operations.map((operation) => operation.opId);
    if (existingIds.length !== expectedIds.length
        || existingIds.some((id, index) => id !== expectedIds[index])) {
      throw new ShardedBoardStoreError('Antonina v3 sealed log chunk conflicts with committed tail');
    }
  }

  private async materializeOperation(
    previous: VerifiedBoardState,
    candidate: VerifiedBoardState,
    log: BoardOperationLog,
    operation: SignedBoardOperation,
    revision: number,
  ): Promise<void> {
    const boardId = log.boardId;
    const payload = operation.payload as { number?: number };

    switch (operation.kind) {
      case 'issue.create':
      case 'issue.edit':
      case 'issue.comment':
      case 'issue.close':
      case 'issue.reopen': {
        const number = payload.number;
        if (number === undefined) throw new ShardedBoardStoreError('Issue mutation has no issue number');
        const issue = candidate.board.issues.find((entry) => entry.number === number);
        if (!issue) throw new ShardedBoardStoreError('Issue disappeared while materializing v3');
        await this.writeIssue(boardId, issue, revision);

        if (operation.kind === 'issue.edit' || operation.kind === 'issue.comment') {
          await this.writeIssuePages(boardId, candidate, log, revision, issue.state);
        } else {
          await this.writeIssuePages(boardId, candidate, log, revision, 'open');
          await this.writeIssuePages(boardId, candidate, log, revision, 'closed');
          await this.writeQueue(boardId, candidate, revision);
        }
        break;
      }
      case 'issue.delete': {
        const number = payload.number;
        if (number === undefined) throw new ShardedBoardStoreError('Issue delete has no issue number');
        await this.upsertPublic(issueKey(number), deletedIssueRecord(boardId, number, revision));
        await this.writeIssuePages(boardId, candidate, log, revision, 'open');
        await this.writeIssuePages(boardId, candidate, log, revision, 'closed');
        await this.writeQueue(boardId, candidate, revision);
        await this.writeCatalog(boardId, candidate, revision);
        break;
      }
      case 'queue.reorder':
        await this.writeQueue(boardId, candidate, revision);
        await this.writeIssuePages(boardId, candidate, log, revision, 'open');
        break;
      case 'resource.add':
      case 'resource.remove':
      case 'target.register':
      case 'target.set':
      case 'dispatch.record':
        await this.writeCatalog(boardId, candidate, revision);
        break;
      case 'authority.delegate':
      case 'authority.revoke':
        await this.writeAuthorities(boardId, candidate, revision);
        break;
      case 'board.delete':
        break;
      case 'board.initialize':
        throw new ShardedBoardStoreError('Antonina v3 cannot append a second board initialization');
    }

    const beforeFeed = feedEntries({
      schemaVersion: OPLOG_SCHEMA_VERSION,
      boardId: log.boardId,
      rootKeyId: log.rootKeyId,
      head: previous.head,
      operations: log.operations.slice(0, -1),
    }).length;
    const afterFeed = feedEntries(log);
    if (afterFeed.length > beforeFeed) {
      const newest = afterFeed[0];
      if (newest !== undefined) {
        const pageNumber = Math.floor(beforeFeed / V3_FEED_PAGE_SIZE) + 1;
        const existing = await this.getJson<unknown>(feedPageKey(pageNumber));
        let entries: BoardFeedEntry[] = [];
        if (existing !== null && isRecord(existing.value) && Array.isArray(existing.value.entries)) {
          entries = (existing.value.entries as BoardFeedEntry[]).filter((entry) => entry.position < newest.position);
        }
        const page: ShardedFeedPage = {
          schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
          boardId,
          page: pageNumber,
          revision,
          entries: [...entries, newest].sort((left, right) => left.position - right.position),
        };
        await this.upsertPublic(feedPageKey(pageNumber), page);
      }
    }
  }

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    const signer = credentialSigningKey(credential);
    const requestedTimestamp = request.timestamp ?? this.now().toISOString();
    const nonce = request.nonce ?? this.newId();

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const metaStored = await this.loadMeta(anchor);
      if (metaStored === null) throw new ShardedBoardStoreError('Antonina v3 metadata does not exist');
      const meta = metaStored.value;
      const log = await this.readLog(meta);
      const state = await verifyAndReplayOperationLog(
        log,
        anchor,
        previouslyAcceptedHead === undefined ? {} : { previouslyAcceptedHead },
      );
      if (state.deleted) throw new ShardedBoardStoreError('Antonina board has been deleted');

      // A prior canonical commit can survive a cache-write failure. Repair all
      // projections before accepting another mutation; fast readers fall back
      // to the signed log while materializedRevision trails operationCount.
      if (meta.materializedRevision !== meta.operationCount) {
        await this.writeAllMaterialized(state, log, meta.operationCount);
        const repaired = { ...meta, materializedRevision: meta.operationCount };
        if (!await this.putPublic(SHARDED_META_KEY, repaired, metaStored.etag)) continue;
        continue;
      }

      const payload = typeof request.payload === 'function'
        ? request.payload(state)
        : request.payload;
      const operation = await signBoardOperation({
        boardId: anchor.boardId,
        previous: log.head,
        timestamp: canonicalTimestampAtOrAfter(requestedTimestamp, log.operations.at(-1)?.timestamp),
        nonce,
        kind: request.kind,
        payload,
      }, signer);
      const candidateLog = appendToLog(log, operation);
      const candidateState = await verifyAndReplayOperationLog(candidateLog, anchor, {
        previouslyAcceptedHead: state.head,
      });

      // When the bounded tail is full, publish it once as an immutable chunk.
      // Both racing writers seal exactly the same committed tail, so a 409 is
      // harmless only when the existing chunk has the same operation IDs.
      await this.ensureSealedTail(meta);

      const revision = meta.operationCount + 1;
      const committedMeta = metaFor(
        candidateLog,
        candidateState,
        meta.migratedFrom,
        meta.materializedRevision,
      );
      if (!await this.putPublic(SHARDED_META_KEY, committedMeta, metaStored.etag)) continue;

      // The signed operation is canonical now. Materialized objects are a
      // repairable acceleration layer, never the commit point.
      let materialized = false;
      try {
        await this.materializeOperation(state, candidateState, candidateLog, operation, revision);
        materialized = true;
      } catch {
        // Leave materializedRevision behind. Fast reads will fall back to the
        // canonical signed log, and the next writer repairs all projections.
      }

      let finalMeta = await this.loadMeta(anchor);
      if (materialized
          && finalMeta !== null
          && finalMeta.value.head === operation.opId
          && finalMeta.value.materializedRevision < revision) {
        const repaired = { ...finalMeta.value, materializedRevision: revision };
        if (await this.putPublic(SHARDED_META_KEY, repaired, finalMeta.etag)) {
          finalMeta = await this.loadMeta(anchor);
        }
      }
      if (finalMeta === null) {
        throw new ShardedBoardStoreError('Antonina v3 metadata disappeared after commit');
      }
      return { log: candidateLog, state: candidateState, etag: finalMeta.etag };
    }

    throw new ShardedBoardStoreError('Antonina v3 board changed too often; signed operation was not committed');
  }

  async getIssue(anchor: BoardTrustAnchor, number: number): Promise<BoardIssue | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) {
      return this.getIssueFromCanonical(anchor, number);
    }
    const stored = await this.getJson<unknown>(issueKey(number));
    if (stored === null || !isRecord(stored.value)) return null;
    const value = stored.value;
    if (value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || value.boardId !== metaStored.value.boardId
        || value.number !== number
        || !Number.isSafeInteger(value.revision)
        || (value.revision as number) > metaStored.value.operationCount
        || typeof value.deleted !== 'boolean') {
      return this.getIssueFromCanonical(anchor, number);
    }
    if (value.deleted) return null;
    if (!isRecord(value.issue)
        || !Number.isSafeInteger(value.messageCount)
        || !Number.isSafeInteger(value.commentPageCount)) {
      return this.getIssueFromCanonical(anchor, number);
    }

    const pageCount = value.commentPageCount as number;
    const pages = await Promise.all(Array.from({ length: pageCount }, (_, index) =>
      this.getJson<unknown>(commentKey(number, index + 1))));
    const messages: BoardMessage[] = [];
    for (const [index, page] of pages.entries()) {
      if (page === null || !isRecord(page.value)
          || page.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
          || page.value.boardId !== metaStored.value.boardId
          || page.value.number !== number
          || page.value.page !== index + 1
          || !Number.isSafeInteger(page.value.revision)
          || (page.value.revision as number) > metaStored.value.operationCount
          || !Array.isArray(page.value.messages)) {
        return this.getIssueFromCanonical(anchor, number);
      }
      messages.push(...(page.value.messages as BoardMessage[]));
    }
    if (messages.length !== value.messageCount) return this.getIssueFromCanonical(anchor, number);

    const core = value.issue;
    return {
      number: core.number as number,
      title: core.title as string,
      body: core.body as string,
      state: core.state as IssueState,
      createdAt: core.createdAt as string,
      updatedAt: core.updatedAt as string,
      messages: clone(messages),
    };
  }

  private async getIssueFromCanonical(anchor: BoardTrustAnchor, number: number): Promise<BoardIssue | null> {
    const stored = await this.read(anchor);
    return stored?.state.board.issues.find((issue) => issue.number === number) ?? null;
  }

  async readIssuePage(
    anchor: BoardTrustAnchor,
    state: IssueState,
    page: number,
  ): Promise<IssueListPage | null> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new ShardedBoardStoreError('Antonina issue page must be a positive integer');
    }
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) return null;
    const maxPage = state === 'open' ? metaStored.value.openPageCount : metaStored.value.closedPageCount;
    if (page > maxPage) {
      return {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: metaStored.value.boardId,
        state,
        page,
        revision: metaStored.value.operationCount,
        total: state === 'open' ? metaStored.value.openIssueCount : metaStored.value.closedIssueCount,
        entries: [],
      };
    }
    const stored = await this.getJson<unknown>(issuePageKey(state, page));
    if (stored === null || !isRecord(stored.value)
        || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || stored.value.boardId !== metaStored.value.boardId
        || stored.value.state !== state
        || stored.value.page !== page
        || !Number.isSafeInteger(stored.value.revision)
        || (stored.value.revision as number) > metaStored.value.operationCount
        || !Array.isArray(stored.value.entries)) {
      return null;
    }
    return clone(stored.value as unknown as IssueListPage);
  }

  async getQueue(anchor: BoardTrustAnchor): Promise<number[] | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) return null;
    const stored = await this.getJson<unknown>(SHARDED_QUEUE_KEY);
    if (stored === null || !isRecord(stored.value)
        || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || stored.value.boardId !== metaStored.value.boardId
        || !Number.isSafeInteger(stored.value.revision)
        || (stored.value.revision as number) > metaStored.value.operationCount
        || !Array.isArray(stored.value.numbers)) {
      return null;
    }
    return [...stored.value.numbers as number[]];
  }

  async readFeed(anchor: BoardTrustAnchor, request: BoardFeedRequest = {}): Promise<BoardFeedPage | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) return null;
    const limit = feedLimit(request.limit);
    const cursor = request.cursor === undefined || request.cursor === null
      ? null
      : parseFeedCursor(request.cursor);
    const entries: BoardFeedEntry[] = [];

    for (let page = metaStored.value.feedPageCount; page >= 1 && entries.length < limit + 1; page -= 1) {
      const stored = await this.getJson<unknown>(feedPageKey(page));
      if (stored === null || !isRecord(stored.value)
          || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
          || stored.value.boardId !== metaStored.value.boardId
          || !Number.isSafeInteger(stored.value.revision)
          || (stored.value.revision as number) > metaStored.value.operationCount
          || !Array.isArray(stored.value.entries)) {
        return null;
      }
      const pageEntries = [...stored.value.entries as BoardFeedEntry[]]
        .sort((left, right) => right.position - left.position)
        .filter((entry) => cursor === null || entry.position < cursor.position);
      entries.push(...pageEntries);
    }

    const pageEntries = entries.slice(0, limit);
    const last = pageEntries.at(-1);
    return {
      entries: clone(pageEntries),
      nextCursor: entries.length > limit && last !== undefined ? feedCursor(last) : null,
      total: metaStored.value.feedCount,
      limit,
    };
  }

  async readAuthorities(anchor: BoardTrustAnchor): Promise<VerifiedAuthority[] | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) return null;
    const stored = await this.getJson<unknown>(SHARDED_AUTHORITIES_KEY);
    if (stored === null || !isRecord(stored.value)
        || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || stored.value.boardId !== metaStored.value.boardId
        || !Number.isSafeInteger(stored.value.revision)
        || (stored.value.revision as number) > metaStored.value.operationCount
        || !Array.isArray(stored.value.authorities)) {
      return null;
    }
    return clone(stored.value.authorities as VerifiedAuthority[]);
  }

  async readCatalog(anchor: BoardTrustAnchor): Promise<{
    resources: BoardResource[];
    targets: BoardExecutionTarget[];
    dispatches: BoardDispatch[];
  } | null> {
    const metaStored = await this.loadMeta(anchor);
    if (metaStored === null) return null;
    if (metaStored.value.materializedRevision !== metaStored.value.operationCount) return null;
    const stored = await this.getJson<unknown>(SHARDED_CATALOG_KEY);
    if (stored === null || !isRecord(stored.value)
        || stored.value.schemaVersion !== SHARDED_BOARD_SCHEMA_VERSION
        || stored.value.boardId !== metaStored.value.boardId
        || !Number.isSafeInteger(stored.value.revision)
        || (stored.value.revision as number) > metaStored.value.operationCount
        || !Array.isArray(stored.value.resources)
        || !Array.isArray(stored.value.targets)
        || !Array.isArray(stored.value.dispatches)) {
      return null;
    }
    return {
      resources: clone(stored.value.resources as BoardResource[]),
      targets: clone(stored.value.targets as BoardExecutionTarget[]),
      dispatches: clone(stored.value.dispatches as BoardDispatch[]),
    };
  }
}
