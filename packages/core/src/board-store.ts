import { generateSigningKey } from './canonical.js';
import {
  createBoardCredential,
  credentialTrustAnchor,
  verifyBoardCredential,
  type BoardCredential,
} from './credential.js';
import { emptyBoard, parseBoard, type Board, type BoardIssue, type IssueState } from './model.js';
import {
  createTrustAnchor,
  emptyOperationLog,
  signBoardOperation,
  verifyAndReplayOperationLog,
  type BoardOperationKind,
  type BoardOperationLog,
  type BoardOperationPayload,
  type BoardTrustAnchor,
  type SignedBoardOperation,
  type VerifiedBoardState,
} from './operations.js';
import { type BoardFeedPage, type BoardFeedRequest } from './feed.js';
import {
  ShardedBoardStore,
  ShardedBoardStoreError,
  type IssueListPage,
} from './board-v3-store.js';

export const ANTONINA_NAMESPACE = 'antonina';
export const SIGNED_BOARD_KEY = 'board-v2';
export const DEFAULT_BOARD_BASE_URL = 'https://vau.place/_skrynia';

const DEFAULT_MAX_ATTEMPTS = 6;

export class SignedBoardStoreError extends Error {
  /** The Skrynia HTTP status, when this error came from a response. */
  readonly status: number | null;
  /** The Skrynia HTTP method this request used, when it reached a response. */
  readonly method: string | null;

  constructor(message: string, options: { cause?: unknown; status?: number; method?: string } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status ?? null;
    this.method = options.method ?? null;
  }
}

function fromShardedError(error: ShardedBoardStoreError): SignedBoardStoreError {
  const options: { cause: unknown; status?: number; method?: string } = { cause: error };
  if (error.status !== null) options.status = error.status;
  if (error.method !== null) options.method = error.method;
  return new SignedBoardStoreError(error.message, options);
}

/** The signed board does not exist at its Skrynia key. */
export class BoardMissingError extends SignedBoardStoreError {
  constructor() {
    super('Antonina signed board does not exist');
  }
}

/** The signed board was deliberately deleted, so its key can never be used again. */
export class BoardDeletedError extends SignedBoardStoreError {
  constructor() {
    super('Antonina board has been deleted');
  }
}

export interface SignedBoardStoreOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  maxAttempts?: number;
  now?: () => Date;
  newId?: () => string;
}

export interface StoredSignedBoard {
  /** Present only while reading the legacy board-v2 format for one-time migration. */
  log: BoardOperationLog | null;
  state: VerifiedBoardState;
  etag: string;
}

export interface InitializeSignedBoardResult extends StoredSignedBoard {
  credential: BoardCredential;
}

export interface AppendOperationRequest {
  kind: Exclude<BoardOperationKind, 'board.initialize'>;
  payload: BoardOperationPayload | ((state: VerifiedBoardState) => BoardOperationPayload);
  timestamp?: string;
  nonce?: string;
}

function defaultId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneLog(log: BoardOperationLog): BoardOperationLog {
  return structuredClone(log);
}

function appendToLog(log: BoardOperationLog, operation: SignedBoardOperation): BoardOperationLog {
  return {
    ...cloneLog(log),
    head: operation.opId,
    operations: [...log.operations, operation],
  };
}

function canonicalTimestampAtOrAfter(value: string, floor?: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new SignedBoardStoreError('Signed board operation timestamp must be canonical ISO-8601 UTC');
  }
  if (floor === undefined) return value;
  const floorMillis = Date.parse(floor);
  if (!Number.isFinite(floorMillis)) throw new SignedBoardStoreError('Signed board timestamp floor is malformed');
  return new Date(Math.max(millis, floorMillis)).toISOString();
}

function boardTimestampFloor(board: Board): string | undefined {
  const timestamps: string[] = [];
  for (const issue of board.issues) {
    timestamps.push(issue.createdAt, issue.updatedAt);
    for (const message of issue.messages) timestamps.push(message.createdAt);
  }
  for (const resource of board.resources) timestamps.push(resource.createdAt, resource.updatedAt);
  if (timestamps.length === 0) return undefined;
  const millis = timestamps.map((timestamp) => Date.parse(timestamp));
  if (millis.some((value) => !Number.isFinite(value))) {
    throw new SignedBoardStoreError('Initial board contains a malformed timestamp');
  }
  return new Date(Math.max(...millis)).toISOString();
}

export class SignedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sharded: ShardedBoardStore;
  /** Known v3 availability for this client; false still re-probes on reads. */
  private shardedAvailable: boolean | null = null;

  constructor(options: SignedBoardStoreOptions = {}) {
    if (options.maxAttempts !== undefined && options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be positive');
    }
    const baseUrl = (options.baseUrl ?? '/_skrynia').replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.url = `${baseUrl}/store/${encodeURIComponent(ANTONINA_NAMESPACE)}/${encodeURIComponent(SIGNED_BOARD_KEY)}`;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.sharded = new ShardedBoardStore(options);
  }

  /**
   * Legacy trust-anchor-only read retained for board-v2 compatibility tests and
   * one-time migration. V3 deliberately cannot be located without the board
   * credential's one shared key.
   */
  async read(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard | null> {
    if (await this.sharded.readPointer() !== null) {
      throw new SignedBoardStoreError('Antonina materialized board requires its board credential');
    }
    return this.readLegacy(anchor, previouslyAcceptedHead);
  }

  async readWithCredential(
    credentialValue: BoardCredential,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard | null> {
    const credential = await verifyBoardCredential(credentialValue);
    const pointer = await this.sharded.readPointer();
    if (pointer !== null) {
      try {
        return await this.sharded.read(credential);
      } catch (error) {
        if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
        throw error;
      }
    }

    let legacy = await this.readLegacy(credentialTrustAnchor(credential), previouslyAcceptedHead);
    if (legacy === null) return null;
    if (legacy.state.deleted) throw new BoardDeletedError();

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        return await this.sharded.migrate(legacy, credential);
      } catch (error) {
        if (error instanceof ShardedBoardStoreError && error.status === 412) {
          const refreshed = await this.readLegacy(
            credentialTrustAnchor(credential),
            legacy.state.head,
          );
          if (refreshed === null) throw new BoardMissingError();
          legacy = refreshed;
          continue;
        }
        if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
        throw error;
      }
    }
    throw new SignedBoardStoreError('Antonina board changed too often during v3 migration');
  }

  async require(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard> {
    const stored = await this.read(anchor, previouslyAcceptedHead);
    if (!stored) throw new BoardMissingError();
    return stored;
  }

  private async readLegacy(
    anchor: BoardTrustAnchor,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard | null> {
    const response = await this.fetcher(this.url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.httpError('GET', SIGNED_BOARD_KEY, response);
    const etag = response.headers.get('ETag');
    if (!etag) throw new SignedBoardStoreError('Skrynia GET antonina/board-v2 returned no ETag');
    const value = await this.parseJson(response, 'Skrynia GET antonina/board-v2');
    if (await this.sharded.readPointer() !== null) {
      throw new SignedBoardStoreError('Antonina materialized board requires its board credential');
    }
    const state = await verifyAndReplayOperationLog(
      value,
      anchor,
      previouslyAcceptedHead === undefined ? {} : { previouslyAcceptedHead },
    );
    return { log: value as BoardOperationLog, state, etag };
  }

  async signedBoardExists(): Promise<boolean> {
    const response = await this.fetcher(this.url, { cache: 'no-store' });
    if (response.status === 404) return false;
    if (response.status === 200) return true;
    throw this.httpError('GET', SIGNED_BOARD_KEY, response);
  }

  async initialize(initialBoard: Board = emptyBoard()): Promise<InitializeSignedBoardResult> {
    const board = parseBoard(initialBoard);
    const root = await generateSigningKey();
    const boardId = this.newId();
    const anchor = await createTrustAnchor(boardId, root);
    const log = emptyOperationLog(anchor);
    const operation = await signBoardOperation({
      boardId,
      previous: null,
      timestamp: canonicalTimestampAtOrAfter(this.now().toISOString(), boardTimestampFloor(board)),
      nonce: this.newId(),
      kind: 'board.initialize',
      payload: { board },
    }, root);
    const initialized = appendToLog(log, operation);
    const state = await verifyAndReplayOperationLog(initialized, anchor);

    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'capability-write',
      },
      body: JSON.stringify(initialized),
    });
    if (response.status === 409) {
      throw new SignedBoardStoreError('Antonina board already exists; refusing to replace its trust root');
    }
    if (response.status !== 201) throw this.httpError('POST', SIGNED_BOARD_KEY, response);

    const created = await this.parseJson(response, 'Skrynia POST antonina/board-v2');
    if (typeof created !== 'object' || created === null
        || !('mode' in created) || !('capability' in created)
        || created.mode !== 'capability-write'
        || typeof created.capability !== 'string') {
      throw new SignedBoardStoreError('Skrynia did not return the storage capability for Antonina board-v2');
    }

    const credential = await createBoardCredential(anchor, root, created.capability);
    const legacy: StoredSignedBoard = {
      log: initialized,
      state,
      etag: response.headers.get('ETag') ?? '',
    };

    // POST responses do not have to expose the object ETag, so read the legacy
    // object exactly once to obtain the CAS token used by migration.
    const readableLegacy = await this.readLegacy(anchor, operation.opId);
    if (readableLegacy === null) throw new BoardMissingError();
    const materialized = await this.sharded.migrate(readableLegacy, credential);
    return { ...materialized, credential };
  }

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    if (request.kind === 'authority.delegate' || request.kind === 'authority.revoke') {
      throw new SignedBoardStoreError('Antonina uses one shared board key; delegated authorities are disabled');
    }

    if (await this.sharded.readPointer() === null) {
      const migrated = await this.readWithCredential(credential, previouslyAcceptedHead);
      if (migrated === null) throw new BoardMissingError();
    }
    try {
      return await this.sharded.append(credential, request);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  private async ensureMaterialized(
    credential: BoardCredential,
    previouslyAcceptedHead?: string | null,
  ): Promise<void> {
    if (await this.sharded.readPointer() !== null) return;
    const migrated = await this.readWithCredential(credential, previouslyAcceptedHead);
    if (migrated === null) throw new BoardMissingError();
  }

  async getIssue(
    credentialValue: BoardCredential,
    number: number,
    previouslyAcceptedHead?: string | null,
  ): Promise<BoardIssue | null> {
    const credential = await verifyBoardCredential(credentialValue);
    await this.ensureMaterialized(credential, previouslyAcceptedHead);
    try {
      return await this.sharded.getIssue(credential, number);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  async readIssuePage(
    credentialValue: BoardCredential,
    state: IssueState,
    page: number,
  ): Promise<IssueListPage | null> {
    const credential = await verifyBoardCredential(credentialValue);
    await this.ensureMaterialized(credential);
    try {
      return await this.sharded.readIssuePage(credential, state, page);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  async getQueue(
    credentialValue: BoardCredential,
    previouslyAcceptedHead?: string | null,
  ): Promise<number[] | null> {
    const credential = await verifyBoardCredential(credentialValue);
    await this.ensureMaterialized(credential, previouslyAcceptedHead);
    try {
      return await this.sharded.getQueue(credential);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  async readFeed(
    credentialValue: BoardCredential,
    request: BoardFeedRequest = {},
    previouslyAcceptedHead?: string | null,
  ): Promise<BoardFeedPage | null> {
    const credential = await verifyBoardCredential(credentialValue);
    await this.ensureMaterialized(credential, previouslyAcceptedHead);
    try {
      return await this.sharded.readFeed(credential, request);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new SignedBoardStoreError(`${context} returned invalid JSON`, { cause: error });
    }
  }

  private httpError(method: string, key: string, response: Response): SignedBoardStoreError {
    return new SignedBoardStoreError(
      `Skrynia ${method} ${ANTONINA_NAMESPACE}/${key} failed (${response.status})`,
      { status: response.status, method },
    );
  }
}
