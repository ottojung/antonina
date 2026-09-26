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

export function browserStorage(): BoardKeyStorage {
  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

/**
 * A browser's signed board session. It holds the one public trust anchor that
 * makes the board readable and, once a credential has been pasted or
 * initialized, the secret credential that makes it editable. A page load only
 * ever reads; nothing here creates the board.
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
   * One read of the whole verified board state, so a refresh learns the shared
   * priority order in the same pass that learns the issues. Every render reads
   * this one snapshot; nothing here re-reads or caches a queue of its own.
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
   * Adopts a board trust anchor so this browser can read it, and returns the
   * whole state that call verified — the same shape `readState` hands back,
   * queue beside board. Trusting reads and verifies the log once, so the
   * session is ready to render and no second read is needed.
   */
  async trust(anchorText: string): Promise<VerifiedBoardState> {
    const anchor = await parseBoardTrustAnchorText(anchorText);
    const state = await this.api.trustBoard(anchor);
    this.storage.set(BOARD_TRUST_STORAGE_KEY, serializeBoardTrustAnchor(anchor));
    this.rememberHead();
    return state;
  }

  /**
   * Creates the board, keeps its root credential in this browser, and returns
   * the state the create verified, so the first load needs no second read.
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
