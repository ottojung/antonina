import { generateSigningKey } from './canonical.js';
import {
  createBoardCredential,
  credentialSigningKey,
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
import { boardFeed, type BoardFeedPage, type BoardFeedRequest } from './feed.js';
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
  log: BoardOperationLog;
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

  async read(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard | null> {
    // Reads re-probe while v3 is absent so a long-lived browser notices when
    // another writer migrates the board instead of staying on frozen board-v2.
    if (this.shardedAvailable !== true) {
      this.shardedAvailable = await this.sharded.exists();
    }
    if (this.shardedAvailable) {
      try {
        return await this.sharded.read(anchor, previouslyAcceptedHead);
      } catch (error) {
        if (error instanceof ShardedBoardStoreError) {
          throw fromShardedError(error);
        }
        throw error;
      }
    }
    return this.readLegacy(anchor, previouslyAcceptedHead);
  }

  async require(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard> {
    const stored = await this.read(anchor, previouslyAcceptedHead);
    if (!stored) throw new BoardMissingError();
    return stored;
  }

  /**
   * The read an operation is built on. A board deleted since this client last
   * read it can never carry another operation, whoever signed it.
   */
  private async requireAppendable(
    anchor: BoardTrustAnchor,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const stored = await this.require(anchor, previouslyAcceptedHead);
    if (stored.state.deleted) throw new BoardDeletedError();
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
    const state = await verifyAndReplayOperationLog(
      value,
      anchor,
      previouslyAcceptedHead === undefined ? {} : { previouslyAcceptedHead },
    );
    return { log: value as BoardOperationLog, state, etag };
  }

  private async requireLegacyAppendable(
    anchor: BoardTrustAnchor,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const stored = await this.readLegacy(anchor, previouslyAcceptedHead);
    if (stored === null) throw new BoardMissingError();
    if (stored.state.deleted) throw new BoardDeletedError();
    return stored;
  }

  async signedBoardExists(): Promise<boolean> {
    this.shardedAvailable = await this.sharded.exists();
    if (this.shardedAvailable) return true;
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
    await verifyAndReplayOperationLog(initialized, anchor);

    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Skrynia-Mode': 'capability-write',
      },
      body: JSON.stringify(initialized),
    });
    if (response.status === 409) {
      throw new SignedBoardStoreError('Antonina signed board already exists; refusing to replace its trust root');
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
    // We have just created board-v2 and already know v3 was absent from the
    // existence check. Read the object we created directly rather than probing
    // v3 again before its first migration.
    const stored = await this.readLegacy(anchor, operation.opId);
    if (stored === null) throw new BoardMissingError();
    return { ...stored, credential };
  }

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    if (credential.keyId !== anchor.rootKeyId || credential.publicKey !== anchor.rootPublicKey) {
      throw new SignedBoardStoreError('Antonina accepts only the shared root board credential');
    }
    if (request.kind === 'authority.delegate' || request.kind === 'authority.revoke') {
      throw new SignedBoardStoreError('Antonina delegated credential operations are disabled');
    }

    // A fresh client may attach after another client has already migrated the
    // board. Probe once while availability is unknown; a client that already
    // read legacy v2 has cached false and keeps the legacy mutation's original
    // single-read failure semantics.
    if (this.shardedAvailable === null) {
      this.shardedAvailable = await this.sharded.exists();
    }

    if (this.shardedAvailable !== true) {
      const legacy = await this.requireLegacyAppendable(anchor, previouslyAcceptedHead);

      // V3 deliberately keeps reads public but keeps writes authenticated. Old
      // Skrynia releases generated a different capability for every new object,
      // so they cannot shard an existing board without replacing credentials.
      // Stay on board-v2 until the server supports reusing this credential's
      // existing board storage capability.
      if (!await this.sharded.supportsSharedCapability(credential.storageCapability)) {
        this.shardedAvailable = false;
        return this.appendLegacy(credential, request, previouslyAcceptedHead);
      }

      try {
        await this.sharded.migrate(legacy, credential.storageCapability);
        this.shardedAvailable = true;
      } catch (error) {
        if (error instanceof ShardedBoardStoreError
            && (error.status === 404 || error.status === 405 || error.status === 501)) {
          this.shardedAvailable = false;
          return this.appendLegacy(credential, request, previouslyAcceptedHead);
        }
        if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
        throw error;
      }
    }

    try {
      return await this.sharded.append(credential, request, previouslyAcceptedHead);
    } catch (error) {
      if (error instanceof ShardedBoardStoreError) throw fromShardedError(error);
      throw error;
    }
  }

  private async appendLegacy(
    credential: BoardCredential,
    request: AppendOperationRequest,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const anchor = credentialTrustAnchor(credential);
    const signer = credentialSigningKey(credential);
    const requestedTimestamp = request.timestamp ?? this.now().toISOString();
    const nonce = request.nonce ?? this.newId();
    let stored = await this.requireLegacyAppendable(anchor, previouslyAcceptedHead);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const timestamp = canonicalTimestampAtOrAfter(
        requestedTimestamp,
        stored.log.operations.at(-1)?.timestamp,
      );
      const payload = typeof request.payload === 'function'
        ? request.payload(stored.state)
        : request.payload;
      const operation = await signBoardOperation({
        boardId: anchor.boardId,
        previous: stored.log.head,
        timestamp,
        nonce,
        kind: request.kind,
        payload,
      }, signer);
      const candidate = appendToLog(stored.log, operation);
      await verifyAndReplayOperationLog(candidate, anchor, {
        previouslyAcceptedHead: stored.state.head,
      });

      const response = await this.fetcher(this.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Skrynia-Capability': credential.storageCapability,
          'If-Match': stored.etag,
        },
        body: JSON.stringify(candidate),
      });
      if (response.status === 412) {
        stored = await this.requireLegacyAppendable(anchor, stored.state.head);
        continue;
      }
      if (response.status !== 200) throw this.httpError('PUT', SIGNED_BOARD_KEY, response);

      return this.require(anchor, operation.opId);
    }

    throw new SignedBoardStoreError('Antonina board changed too often; signed operation was not committed');
  }

  async getIssue(
    anchor: BoardTrustAnchor,
    number: number,
    previouslyAcceptedHead?: string | null,
  ): Promise<BoardIssue | null> {
    if (this.shardedAvailable === true || await this.refreshShardedAvailability()) {
      return this.sharded.getIssue(anchor, number);
    }
    const stored = await this.read(anchor, previouslyAcceptedHead);
    return stored?.state.board.issues.find((issue) => issue.number === number) ?? null;
  }

  async readIssuePage(
    anchor: BoardTrustAnchor,
    state: IssueState,
    page: number,
  ): Promise<IssueListPage | null> {
    if (this.shardedAvailable !== true && !await this.refreshShardedAvailability()) return null;
    return this.sharded.readIssuePage(anchor, state, page);
  }

  async getQueue(
    anchor: BoardTrustAnchor,
    previouslyAcceptedHead?: string | null,
  ): Promise<number[] | null> {
    if (this.shardedAvailable === true || await this.refreshShardedAvailability()) {
      return this.sharded.getQueue(anchor);
    }
    const stored = await this.read(anchor, previouslyAcceptedHead);
    return stored === null ? null : [...stored.state.queue];
  }

  async readFeed(
    anchor: BoardTrustAnchor,
    request: BoardFeedRequest = {},
    previouslyAcceptedHead?: string | null,
  ): Promise<BoardFeedPage | null> {
    if (this.shardedAvailable === true || await this.refreshShardedAvailability()) {
      const page = await this.sharded.readFeed(anchor, request);
      if (page !== null) return page;
    }
    const stored = await this.read(anchor, previouslyAcceptedHead);
    return stored === null ? null : boardFeed(stored.log, request);
  }

  private async refreshShardedAvailability(): Promise<boolean> {
    this.shardedAvailable = await this.sharded.exists();
    return this.shardedAvailable;
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
