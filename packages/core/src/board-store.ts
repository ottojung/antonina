import { generateSigningKey } from './canonical.js';
import {
  createBoardCredential,
  credentialSigningKey,
  credentialTrustAnchor,
  verifyBoardCredential,
  type BoardCredential,
} from './credential.js';
import { emptyBoard, parseBoard, type Board } from './model.js';
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

export const ANTONINA_NAMESPACE = 'antonina';
export const SIGNED_BOARD_KEY = 'board-v2';
export const LEGACY_BOARD_KEY = 'board-v1';
export const DEFAULT_BOARD_BASE_URL = 'https://vau.place/_skrynia';

const DEFAULT_MAX_ATTEMPTS = 6;

export class SignedBoardStoreError extends Error {}

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

export class SignedBoardStore {
  private readonly fetcher: typeof fetch;
  private readonly signedUrl: string;
  private readonly legacyUrl: string;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SignedBoardStoreOptions = {}) {
    if (options.maxAttempts !== undefined && options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be positive');
    }
    const baseUrl = (options.baseUrl ?? '/_skrynia').replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.signedUrl = `${baseUrl}/store/${encodeURIComponent(ANTONINA_NAMESPACE)}/${encodeURIComponent(SIGNED_BOARD_KEY)}`;
    this.legacyUrl = `${baseUrl}/store/${encodeURIComponent(ANTONINA_NAMESPACE)}/${encodeURIComponent(LEGACY_BOARD_KEY)}`;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
  }

  async read(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard | null> {
    const response = await this.fetcher(this.signedUrl, { cache: 'no-store' });
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

  async require(anchor: BoardTrustAnchor, previouslyAcceptedHead?: string | null): Promise<StoredSignedBoard> {
    const stored = await this.read(anchor, previouslyAcceptedHead);
    if (!stored) throw new SignedBoardStoreError('Antonina signed board does not exist');
    return stored;
  }

  async readLegacyBoard(): Promise<Board | null> {
    const response = await this.fetcher(this.legacyUrl, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.httpError('GET', LEGACY_BOARD_KEY, response);
    return parseBoard(await this.parseJson(response, 'Skrynia GET antonina/board-v1'));
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
      timestamp: this.now().toISOString(),
      nonce: this.newId(),
      kind: 'board.initialize',
      payload: { board },
    }, root);
    const initialized = appendToLog(log, operation);
    const verified = await verifyAndReplayOperationLog(initialized, anchor);

    const response = await this.fetcher(this.signedUrl, {
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
    const stored = await this.require(anchor, operation.opId);
    return { ...stored, state: verified.head === stored.state.head ? stored.state : stored.state, credential };
  }

  async append(
    credentialValue: BoardCredential,
    request: AppendOperationRequest,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    const signer = credentialSigningKey(credential);
    const timestamp = request.timestamp ?? this.now().toISOString();
    const nonce = request.nonce ?? this.newId();
    let stored = await this.require(anchor, previouslyAcceptedHead);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
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

      const response = await this.fetcher(this.signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Skrynia-Capability': credential.storageCapability,
          'If-Match': stored.etag,
        },
        body: JSON.stringify(candidate),
      });
      if (response.status === 412) {
        stored = await this.require(anchor, stored.state.head);
        continue;
      }
      if (response.status !== 200) throw this.httpError('PUT', SIGNED_BOARD_KEY, response);

      const committed = await this.require(anchor, operation.opId);
      return committed;
    }

    throw new SignedBoardStoreError('Antonina board changed too often; signed operation was not committed');
  }

  async verifyStorageCapability(
    credentialValue: BoardCredential,
    previouslyAcceptedHead?: string | null,
  ): Promise<StoredSignedBoard> {
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    let stored = await this.require(anchor, previouslyAcceptedHead);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const response = await this.fetcher(this.signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Skrynia-Capability': credential.storageCapability,
          'If-Match': stored.etag,
        },
        body: JSON.stringify(stored.log),
      });
      if (response.status === 412) {
        stored = await this.require(anchor, stored.state.head);
        continue;
      }
      if (response.status !== 200) throw this.httpError('PUT', SIGNED_BOARD_KEY, response);
      return this.require(anchor, stored.state.head);
    }

    throw new SignedBoardStoreError('Antonina board changed too often to verify its storage capability');
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new SignedBoardStoreError(`${context} returned invalid JSON`, { cause: error });
    }
  }

  private httpError(method: string, key: string, response: Response): SignedBoardStoreError {
    return new SignedBoardStoreError(`Skrynia ${method} ${ANTONINA_NAMESPACE}/${key} failed (${response.status})`);
  }
}
