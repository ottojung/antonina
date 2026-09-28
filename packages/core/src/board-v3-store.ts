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
}

interface DirectoryEntry {
  number: number;
  ref: string;
}

interface DirectoryPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  page: number;
  revision: number;
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
  revision: number;
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
  revision: number;
  numbers: number[];
}

interface CatalogSnapshot {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  revision: number;
  resources: BoardResource[];
  targets: BoardExecutionTarget[];
  dispatches: BoardDispatch[];
}

interface FeedPage {
  schemaVersion: typeof SHARDED_BOARD_SCHEMA_VERSION;
  boardId: string;
  page: number;
  revision: number;
  entries: BoardFeedEntry[];
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

function pageRef(kind: string, head: string, page: number): string {
  return `${kind}:${head}:${String(page).padStart(9, '0')}`;
}

function singletonRef(kind: string, head: string): string {
  return `${kind}:${head}`;
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

export class ShardedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private readonly pointerUrl: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

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

  private async writeImmutable(storageCapability: string, logicalRef: string, value: unknown): Promise<void> {
    const response = await this.fetcher(await this.url(storageCapability, logicalRef), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'immutable',
      },
      body: JSON.stringify(value),
    });
    if (response.status === 201) return;
    if (response.status !== 409) throw this.error('POST', logicalRef, response);
    const current = await this.requireJson<unknown>(storageCapability, logicalRef);
    if (!jsonSame(current.value, value)) {
      throw new ShardedBoardStoreError(`Antonina immutable snapshot collision at ${logicalRef}`);
    }
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
      revision: requireSafeCount(value.revision, 'directory revision'),
      entries,
    };
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
    const commentRefs = value.commentRefs.map((entry) => requireText(entry, 'comment reference'));
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      number: value.number as number,
      revision: requireSafeCount(value.revision, 'issue revision'),
      issue: {
        number: coreValue.number as number,
        title: coreValue.title,
        body: coreValue.body,
        state: coreValue.state,
        createdAt: coreValue.createdAt,
        updatedAt: coreValue.updatedAt,
      },
      closedAt: value.closedAt,
      messageCount: requireSafeCount(value.messageCount, 'message count'),
      commentRefs,
    };
    if (snapshot.number !== snapshot.issue.number) {
      throw new ShardedBoardStoreError('Antonina issue snapshot number mismatch');
    }
    if (!withMessages) return { snapshot, issue: issueFromCore(snapshot.issue, []) };

    const pages = await Promise.all(commentRefs.map(async (commentRef, index) => {
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
    return { snapshot, issue: issueFromCore(snapshot.issue, messages) };
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
      revision: requireSafeCount(value.revision, 'catalog revision'),
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
    revision: number,
    head: string,
    issue: BoardIssue,
    closedAt: string | null,
    previous?: IssueSnapshot,
    commentsChanged = false,
  ): Promise<string> {
    let commentRefs = previous === undefined ? [] : [...previous.commentRefs];
    if (commentsChanged) {
      const pageNumber = Math.floor((issue.messages.length - 1) / V3_COMMENT_PAGE_SIZE) + 1;
      const pageEntries = issue.messages.slice(
        (pageNumber - 1) * V3_COMMENT_PAGE_SIZE,
        pageNumber * V3_COMMENT_PAGE_SIZE,
      );
      const ref = pageRef(`comments:${issue.number}`, head, pageNumber);
      const page: CommentPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        number: issue.number,
        page: pageNumber,
        revision,
        messages: clone(pageEntries),
      };
      await this.writeImmutable(credential.storageCapability, ref, page);
      if (commentRefs.length < pageNumber) commentRefs.push(ref);
      else commentRefs[pageNumber - 1] = ref;
    }
    const ref = singletonRef(`issue:${issue.number}`, head);
    const snapshot: IssueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      number: issue.number,
      revision,
      issue: coreOf(issue),
      closedAt,
      messageCount: issue.messages.length,
      commentRefs,
    };
    await this.writeImmutable(credential.storageCapability, ref, snapshot);
    return ref;
  }

  private async writeDirectoryPage(
    credential: BoardCredential,
    boardId: string,
    revision: number,
    head: string,
    page: number,
    entries: DirectoryEntry[],
  ): Promise<string> {
    const ref = pageRef('directory', head, page);
    const value: DirectoryPage = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      page,
      revision,
      entries: [...entries].sort((left, right) => left.number - right.number),
    };
    await this.writeImmutable(credential.storageCapability, ref, value);
    return ref;
  }

  private async writeIssueListPages(
    credential: BoardCredential,
    boardId: string,
    revision: number,
    head: string,
    state: VerifiedBoardState,
    closedAt: Map<number, string>,
    issueState: IssueState,
    previousState: VerifiedBoardState | null,
    previousClosedAt: Map<number, string> | null,
    previousRefs: string[],
  ): Promise<string[]> {
    const nextPages = paginate(orderedSummaries(state, closedAt, issueState), V3_ISSUE_PAGE_SIZE);
    const previousPages = previousState === null || previousClosedAt === null
      ? []
      : paginate(orderedSummaries(previousState, previousClosedAt, issueState), V3_ISSUE_PAGE_SIZE);
    const refs: string[] = [];
    for (let index = 0; index < nextPages.length; index += 1) {
      const entries = nextPages[index]!;
      const previous = previousPages[index];
      if (previous !== undefined && jsonSame(previous, entries) && previousRefs[index] !== undefined) {
        refs.push(previousRefs[index]!);
        continue;
      }
      const page = index + 1;
      const ref = pageRef(issueState === 'open' ? 'open' : 'closed', head, page);
      const value: IssueListPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId,
        state: issueState,
        page,
        revision,
        total: state.board.issues.filter((issue) => issue.state === issueState).length,
        entries: clone(entries),
      };
      await this.writeImmutable(credential.storageCapability, ref, value);
      refs.push(ref);
    }
    return refs;
  }

  private async appendFeed(
    credential: BoardCredential,
    meta: ShardedBoardMeta,
    revision: number,
    head: string,
    entry: BoardFeedEntry | null,
  ): Promise<{ refs: string[]; count: number }> {
    if (entry === null) return { refs: [...meta.feedPageRefs], count: meta.feedCount };
    const refs = [...meta.feedPageRefs];
    const pageNumber = Math.floor(meta.feedCount / V3_FEED_PAGE_SIZE) + 1;
    let entries: BoardFeedEntry[] = [];
    if (meta.feedCount % V3_FEED_PAGE_SIZE !== 0) {
      const previousRef = refs[pageNumber - 1];
      if (previousRef === undefined) throw new ShardedBoardStoreError('Antonina feed page reference is missing');
      const previous = await this.requireJson<unknown>(credential.storageCapability, previousRef);
      if (!isRecord(previous.value) || !Array.isArray(previous.value.entries)) {
        throw new ShardedBoardStoreError('Antonina feed page is malformed');
      }
      entries = clone(previous.value.entries as BoardFeedEntry[]);
    }
    entries.push(entry);
    const ref = pageRef('feed', head, pageNumber);
    const page: FeedPage = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId: meta.boardId,
      page: pageNumber,
      revision,
      entries,
    };
    await this.writeImmutable(credential.storageCapability, ref, page);
    refs[pageNumber - 1] = ref;
    return { refs, count: meta.feedCount + 1 };
  }

  private async writeQueueSnapshot(
    credential: BoardCredential,
    boardId: string,
    revision: number,
    head: string,
    numbers: number[],
  ): Promise<string> {
    const ref = singletonRef('queue', head);
    const value: QueueSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      revision,
      numbers: [...numbers],
    };
    await this.writeImmutable(credential.storageCapability, ref, value);
    return ref;
  }

  private async writeCatalogSnapshot(
    credential: BoardCredential,
    boardId: string,
    revision: number,
    head: string,
    board: Board,
  ): Promise<string> {
    const ref = singletonRef('catalog', head);
    const value: CatalogSnapshot = {
      schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
      boardId,
      revision,
      resources: clone(board.resources),
      targets: clone(board.targets),
      dispatches: clone(board.dispatches),
    };
    await this.writeImmutable(credential.storageCapability, ref, value);
    return ref;
  }

  private async writeMeta(
    credential: BoardCredential,
    head: string,
    meta: ShardedBoardMeta,
  ): Promise<string> {
    const ref = singletonRef('meta', head);
    await this.writeImmutable(credential.storageCapability, ref, meta);
    return ref;
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

    for (const issue of stored.state.board.issues) {
      const commentRefs: string[] = [];
      const pages = paginate(issue.messages, V3_COMMENT_PAGE_SIZE);
      for (let index = 0; index < pages.length; index += 1) {
        const page = index + 1;
        const ref = pageRef(`comments:${issue.number}`, head, page);
        const value: CommentPage = {
          schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
          boardId: anchor.boardId,
          number: issue.number,
          page,
          revision,
          messages: clone(pages[index]!),
        };
        await this.writeImmutable(credential.storageCapability, ref, value);
        commentRefs.push(ref);
      }
      const issueRef = singletonRef(`issue:${issue.number}`, head);
      const snapshot: IssueSnapshot = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: anchor.boardId,
        number: issue.number,
        revision,
        issue: coreOf(issue),
        closedAt: closedAt.get(issue.number) ?? null,
        messageCount: issue.messages.length,
        commentRefs,
      };
      await this.writeImmutable(credential.storageCapability, issueRef, snapshot);
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
      directoryRefs.push(await this.writeDirectoryPage(
        credential,
        anchor.boardId,
        revision,
        head,
        page,
        entries,
      ));
    }

    const queueRef = await this.writeQueueSnapshot(
      credential,
      anchor.boardId,
      revision,
      head,
      stored.state.queue,
    );
    const catalogRef = await this.writeCatalogSnapshot(
      credential,
      anchor.boardId,
      revision,
      head,
      stored.state.board,
    );

    const openPageRefs = await this.writeIssueListPages(
      credential,
      anchor.boardId,
      revision,
      head,
      stored.state,
      closedAt,
      'open',
      null,
      null,
      [],
    );
    const closedPageRefs = await this.writeIssueListPages(
      credential,
      anchor.boardId,
      revision,
      head,
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
    const legacyFeed = stored.log === null
      ? []
      : feedEntries(stored.log)
          .sort((left, right) => left.position - right.position)
          .map((entry, position) => ({ ...entry, position }));
    const feedPageRefs: string[] = [];
    const feedPages = paginate(legacyFeed, V3_FEED_PAGE_SIZE);
    for (let index = 0; index < feedPages.length; index += 1) {
      const pageNumber = index + 1;
      const ref = pageRef('feed', head, pageNumber);
      const page: FeedPage = {
        schemaVersion: SHARDED_BOARD_SCHEMA_VERSION,
        boardId: anchor.boardId,
        page: pageNumber,
        revision,
        entries: clone(feedPages[index]!),
      };
      await this.writeImmutable(credential.storageCapability, ref, page);
      feedPageRefs.push(ref);
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
    };
    const metaRef = await this.writeMeta(credential, head, meta);
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

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    if (request.kind === 'authority.delegate' || request.kind === 'authority.revoke') {
      throw new ShardedBoardStoreError('Antonina uses one shared board key; delegated authorities are disabled');
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const pointerStored = await this.readPointer();
      if (pointerStored === null) throw new ShardedBoardStoreError('Antonina materialized board pointer does not exist');
      const pointer = pointerStored.value;
      const bundle = await this.readBundle(credential, pointer);
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

      const nextIssueRefs = new Map(bundle.issueRefs);
      const nextDirectoryRefs = [...bundle.meta.directoryRefs];
      const issueMutation = request.kind.startsWith('issue.');
      if (issueMutation && beforeIssueNumber !== null) {
        const directoryPage = directoryPageNumber(beforeIssueNumber);
        const currentDirectory = bundle.directoryPages.get(directoryPage);
        const entries = currentDirectory === undefined ? [] : clone(currentDirectory.entries);
        const entryIndex = entries.findIndex((entry) => entry.number === beforeIssueNumber);

        if (request.kind === 'issue.delete') {
          nextIssueRefs.delete(beforeIssueNumber);
          if (entryIndex >= 0) entries.splice(entryIndex, 1);
        } else {
          if (afterIssue === undefined) throw new ShardedBoardStoreError('Issue mutation produced no issue snapshot');
          const previousSnapshot = bundle.issueSnapshots.get(beforeIssueNumber);
          const issueRef = await this.materializeIssue(
            credential,
            pointer.boardId,
            revision,
            head,
            afterIssue,
            nextClosedAt.get(beforeIssueNumber) ?? null,
            previousSnapshot,
            request.kind === 'issue.comment',
          );
          nextIssueRefs.set(beforeIssueNumber, issueRef);
          if (entryIndex >= 0) entries[entryIndex] = { number: beforeIssueNumber, ref: issueRef };
          else entries.push({ number: beforeIssueNumber, ref: issueRef });
        }

        if (entries.length === 0) {
          nextDirectoryRefs[directoryPage - 1] = null;
        } else {
          nextDirectoryRefs[directoryPage - 1] = await this.writeDirectoryPage(
            credential,
            pointer.boardId,
            revision,
            head,
            directoryPage,
            entries,
          );
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
        ? await this.writeQueueSnapshot(credential, pointer.boardId, revision, head, candidate.queue)
        : bundle.meta.queueRef;

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
      const catalogRef = jsonSame(beforeCatalog, afterCatalog)
        ? bundle.meta.catalogRef
        : await this.writeCatalogSnapshot(credential, pointer.boardId, revision, head, candidate.board);

      const openPageRefs = await this.writeIssueListPages(
        credential,
        pointer.boardId,
        revision,
        head,
        candidate,
        nextClosedAt,
        'open',
        bundle.state,
        bundle.closedAt,
        bundle.meta.openPageRefs,
      );
      const closedPageRefs = await this.writeIssueListPages(
        credential,
        pointer.boardId,
        revision,
        head,
        candidate,
        nextClosedAt,
        'closed',
        bundle.state,
        bundle.closedAt,
        bundle.meta.closedPageRefs,
      );

      const feedEntry = feedEntryForMutation(
        request.kind,
        payload,
        beforeIssue,
        afterIssue,
        head,
        timestamp,
        bundle.meta.feedCount,
      );
      const feed = await this.appendFeed(
        credential,
        bundle.meta,
        revision,
        head,
        feedEntry,
      );

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
      };
      const metaRef = await this.writeMeta(credential, head, meta);
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
        continue;
      }
      return {
        log: null,
        state: candidate,
        etag: `v3:${head}`,
      };
    }

    throw new ShardedBoardStoreError('Antonina board changed too often; mutation was not committed');
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

  async getIssue(
    credentialValue: BoardCredential,
    number: number,
  ): Promise<BoardIssue | null> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const page = await this.readDirectoryPage(credential, meta, directoryPageNumber(number));
    const entry = page?.entries.find((candidate) => candidate.number === number);
    if (entry === undefined) return null;
    return (await this.readIssueSnapshot(credential, meta, entry.ref, true)).issue;
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
        || !Number.isSafeInteger(value.revision)
        || !Array.isArray(value.entries)) {
      throw new ShardedBoardStoreError('Antonina issue list page is malformed');
    }
    return clone(value as unknown as IssueListPage);
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

  async readFeed(
    credentialValue: BoardCredential,
    request: BoardFeedRequest = {},
  ): Promise<BoardFeedPage> {
    const { credential, meta } = await this.requirePointerForCredential(credentialValue);
    const limit = feedLimit(request.limit);
    const cursor = request.cursor === undefined || request.cursor === null
      ? null
      : parseFeedCursor(request.cursor);
    const entries: BoardFeedEntry[] = [];
    for (let page = meta.feedPageRefs.length; page >= 1 && entries.length < limit + 1; page -= 1) {
      const ref = meta.feedPageRefs[page - 1]!;
      const stored = await this.requireJson<unknown>(credential.storageCapability, ref);
      if (!isRecord(stored.value) || !Array.isArray(stored.value.entries)) {
        throw new ShardedBoardStoreError('Antonina feed page is malformed');
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
      total: meta.feedCount,
      limit,
    };
  }
}
