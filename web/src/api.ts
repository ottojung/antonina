import {
  BoardApi,
  BoardMissingError,
  type BoardAccessState,
  type BoardApiOptions,
  type BoardInitialization,
} from '../../packages/core/src/api';
import {
  BOARD_CREDENTIAL_STORAGE_KEY,
  BOARD_HEAD_STORAGE_KEY,
  BOARD_TRUST_STORAGE_KEY,
  parseBoardCredentialText,
  parseBoardTrustAnchorText,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
} from '../../packages/core/src/credential';
import type { BoardTrustAnchor, VerifiedBoardState } from '../../packages/core/src/operations';
import type { BoardFeedPage, BoardFeedRequest } from '../../packages/core/src/feed';

export {
  parseBoardCredentialText,
  parseBoardTrustAnchorText,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
} from '../../packages/core/src/credential';

export interface BoardKeyStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * The one shape a feed read has, and the reason `BrowserBoardSession.readFeed`
 * is a bound property rather than a method.
 *
 * The feed tab is handed the session's read as a prop and calls it on its own,
 * so anything this type admits has to be callable with no receiver. TypeScript
 * cannot enforce that: a prototype method satisfies a bare function type and
 * only throws once it is detached. Naming the shape here, on the session that
 * provides it, is what makes the obligation visible to the compiler's callers.
 */
export type FeedRead = (request?: BoardFeedRequest) => Promise<BoardFeedPage>;

export function browserStorage(): BoardKeyStorage {
  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

/**
 * A browser board session. The public trust anchor identifies the board, while
 * the one shared board credential is required for all live board access. A
 * page load only reads; nothing here creates the board.
 */
export class BrowserBoardSession {
  readonly api: BoardApi;
  private readonly storage: BoardKeyStorage;

  constructor(storage: BoardKeyStorage = browserStorage(), options: BoardApiOptions = {}) {
    this.storage = storage;
    this.api = new BoardApi({
      ...options,
      credential: readStored<BoardCredential>(storage, BOARD_CREDENTIAL_STORAGE_KEY),
      trustAnchor: readStored<BoardTrustAnchor>(storage, BOARD_TRUST_STORAGE_KEY),
      rememberedHead: storage.get(BOARD_HEAD_STORAGE_KEY),
    });
  }

  hasCredential(): boolean {
    return this.api.getCredential() !== null;
  }

  /**
   * Reads the current materialized board snapshot. The core store follows the
   * pointer to issue, queue and catalog snapshots; no operation history is
   * reconstructed.
   */
  async readState(): Promise<VerifiedBoardState | null> {
    try {
      const state = await this.api.loadState();
      this.rememberHead();
      return state;
    } catch (error) {
      if (error instanceof BoardMissingError) return null;
      throw error;
    }
  }

  /**
   * One page of the materialized board activity stream, newest first.
   *
   * The request goes directly to `BoardApi.readFeed`, which reads persisted
   * feed pages and returns their continuation token. The browser does not
   * derive or reconstruct activity history.
   *
   * It is an arrow-function property and not a `readonly` method on purpose.
   * The feed tab takes this as a bare function prop and calls it on its own, so
   * a method that reads `this` would throw `Cannot read properties of undefined`
   * the moment it was detached, and TypeScript cannot catch that: a method value
   * satisfies a bare function type. Binding it to the session here means the
   * declared type and the runtime agree, for this caller and every future one.
   */
  readonly readFeed: FeedRead = async (request = {}) => this.api.readFeed(request);

  /**
   * Adopts the public identity anchor for a board. It does not grant access:
   * reading the materialized board still requires the shared board credential.
   */
  async trust(anchorText: string): Promise<VerifiedBoardState> {
    const anchor = await parseBoardTrustAnchorText(anchorText);
    const state = await this.api.trustBoard(anchor);
    this.storage.set(BOARD_TRUST_STORAGE_KEY, serializeBoardTrustAnchor(anchor));
    this.rememberHead();
    return state;
  }

  /**
   * Creates the board, materializes its initial snapshot, and keeps the shared
   * board credential in this browser.
   */
  async initialize(): Promise<BoardInitialization> {
    const initialized = await this.api.initialize();
    this.persistCredential(initialized.credential);
    this.storage.set(BOARD_TRUST_STORAGE_KEY, serializeBoardTrustAnchor(initialized.trustAnchor));
    this.rememberHead();
    return initialized;
  }

  /** Enables editing with a credential that another browser or an agent shared. */
  async enableEditing(credentialText: string): Promise<BoardAccessState> {
    const credential = await parseBoardCredentialText(credentialText);
    const access = await this.api.verifyCredential(credential);
    this.persistCredential(credential);
    return access;
  }

  clearCredential(): void {
    this.api.clearCredential();
    this.storage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
  }

  credentialText(): string | null {
    const credential = this.api.getCredential();
    return credential === null ? null : serializeBoardCredential(credential);
  }

  trustAnchorText(): string | null {
    const anchor = this.api.getTrustAnchor();
    return anchor === null ? null : serializeBoardTrustAnchor(anchor);
  }

  private persistCredential(credential: BoardCredential): void {
    this.storage.set(BOARD_CREDENTIAL_STORAGE_KEY, serializeBoardCredential(credential));
  }

  private rememberHead(): void {
    const head = this.api.getRememberedHead();
    if (head !== null) this.storage.set(BOARD_HEAD_STORAGE_KEY, head);
  }
}

function readStored<T>(storage: BoardKeyStorage, key: string): T | null {
  const stored = storage.get(key);
  if (stored === null) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function createBrowserBoardApi(
  storage: BoardKeyStorage = browserStorage(),
  options: BoardApiOptions = {},
): BrowserBoardSession {
  return new BrowserBoardSession(storage, options);
}

export * from '../../packages/core/src/api';
