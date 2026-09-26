import {
  BoardApi,
  type BoardAccessState,
  type BoardApiOptions,
  type BoardInitialization,
} from '../../packages/core/src/api';
import {
  BOARD_CREDENTIAL_STORAGE_KEY,
  BOARD_HEAD_STORAGE_KEY,
  BOARD_TRUST_STORAGE_KEY,
  credentialTrustAnchor,
  parseBoardCredential,
  parseBoardCredentialText,
  parseBoardTrustAnchor,
  parseBoardTrustAnchorText,
  serializeBoardCredential,
  serializeBoardTrustAnchor,
  type BoardCredential,
} from '../../packages/core/src/credential';
import type { Board } from '../../packages/core/src/model';
import type { BoardCapability, BoardTrustAnchor, VerifiedAuthority } from '../../packages/core/src/operations';

export interface BrowserStateStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type BrowserBoardBootstrap =
  | { kind: 'ready'; board: Board; credentialWarning?: string }
  | { kind: 'missing'; legacyAvailable: boolean; credentialWarning?: string }
  | { kind: 'untrusted'; credentialWarning?: string };

function browserStorage(): BrowserStateStorage {
  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

function sameAnchor(left: BoardTrustAnchor, right: BoardTrustAnchor): boolean {
  return left.boardId === right.boardId
    && left.rootKeyId === right.rootKeyId
    && left.rootPublicKey === right.rootPublicKey;
}

export class BrowserBoardApi extends BoardApi {
  private readonly stateStorage: BrowserStateStorage;
  private readonly startupWarnings: string[] = [];

  constructor(storage: BrowserStateStorage = browserStorage(), options: BoardApiOptions = {}) {
    let credential: BoardCredential | null = null;
    let trustAnchor: BoardTrustAnchor | null = null;
    let rememberedHead: string | null = null;

    const rawCredential = storage.get(BOARD_CREDENTIAL_STORAGE_KEY);
    if (rawCredential !== null) {
      try {
        credential = parseBoardCredential(JSON.parse(rawCredential));
      } catch {
        storage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
      }
    }

    const rawTrust = storage.get(BOARD_TRUST_STORAGE_KEY);
    if (rawTrust !== null) {
      try {
        trustAnchor = parseBoardTrustAnchor(JSON.parse(rawTrust));
      } catch {
        storage.remove(BOARD_TRUST_STORAGE_KEY);
      }
    }

    if (credential !== null && trustAnchor !== null
        && !sameAnchor(credentialTrustAnchor(credential), trustAnchor)) {
      storage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
      credential = null;
    }

    const rawHead = storage.get(BOARD_HEAD_STORAGE_KEY);
    if (rawHead !== null) {
      if (/^sha256:[A-Za-z0-9_-]{43}$/.test(rawHead)) rememberedHead = rawHead;
      else storage.remove(BOARD_HEAD_STORAGE_KEY);
    }

    super({
      ...options,
      credential: options.credential ?? credential,
      trustAnchor: options.trustAnchor ?? trustAnchor,
      rememberedHead: options.rememberedHead ?? rememberedHead,
    });
    this.stateStorage = storage;

    if (rawCredential !== null && credential === null) {
      this.startupWarnings.push('The stored Antonina credential was malformed or did not match the trusted board and was removed.');
    }
    if (rawTrust !== null && trustAnchor === null) {
      this.startupWarnings.push('The stored Antonina trust anchor was malformed and was removed.');
    }
    if (rawHead !== null && rememberedHead === null) {
      this.startupWarnings.push('The stored Antonina board head was malformed and was removed.');
    }
  }

  async bootstrap(): Promise<BrowserBoardBootstrap> {
    const warning = this.startupWarnings.length === 0 ? undefined : this.startupWarnings.join(' ');
    if (!await this.signedBoardExists()) {
      return {
        kind: 'missing',
        legacyAvailable: await this.legacyBoardExists(),
        ...(warning === undefined ? {} : { credentialWarning: warning }),
      };
    }
    if (this.getTrustAnchor() === null) {
      return { kind: 'untrusted', ...(warning === undefined ? {} : { credentialWarning: warning }) };
    }

    let credentialWarning = warning;
    let board = await this.loadBoard();
    const credential = this.getCredential();
    if (credential !== null) {
      try {
        await this.verifyCredential(credential);
        board = await this.loadBoard();
      } catch (error) {
        super.clearCredential();
        this.stateStorage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
        this.persistPublicState();
        const detail = error instanceof Error ? error.message : 'credential verification failed';
        credentialWarning = 'Stored editing credential was rejected; this browser remains read-only. ' + detail;
      }
    }
    return {
      kind: 'ready',
      board,
      ...(credentialWarning === undefined ? {} : { credentialWarning }),
    };
  }

  override async initialize(initialBoard?: Board): Promise<BoardInitialization> {
    const result = await super.initialize(initialBoard);
    this.persistAll();
    return result;
  }

  override async migrateLegacy(): Promise<BoardInitialization> {
    const result = await super.migrateLegacy();
    this.persistAll();
    return result;
  }

  override async loadBoard(): Promise<Board> {
    const board = await super.loadBoard();
    this.persistPublicState();
    return board;
  }

  override async verifyCredential(
    credentialValue: BoardCredential | null = this.getCredential(),
  ): Promise<BoardAccessState> {
    const result = await super.verifyCredential(credentialValue);
    this.persistAll();
    return result;
  }

  async importCredentialText(text: string): Promise<BoardAccessState> {
    const credential = await parseBoardCredentialText(text.trim());
    return this.verifyCredential(credential);
  }

  async importTrustText(text: string): Promise<Board> {
    const anchor = await parseBoardTrustAnchorText(text.trim());
    const board = await super.trustBoard(anchor);
    this.persistPublicState();
    return board;
  }

  override clearCredential(): void {
    super.clearCredential();
    this.stateStorage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
    this.persistPublicState();
  }

  override async delegateCredential(capabilities: readonly BoardCapability[]): Promise<BoardCredential> {
    const delegated = await super.delegateCredential(capabilities);
    this.persistAll();
    return delegated;
  }

  override async revokeCredential(keyId: string): Promise<VerifiedAuthority[]> {
    const authorities = await super.revokeCredential(keyId);
    this.persistAll();
    return authorities;
  }

  exportCredentialText(): string | null {
    const credential = this.getCredential();
    return credential === null ? null : serializeBoardCredential(credential);
  }

  exportTrustText(): string | null {
    const trust = this.getTrustAnchor();
    return trust === null ? null : serializeBoardTrustAnchor(trust);
  }

  private persistPublicState(): void {
    const trust = this.getTrustAnchor();
    if (trust === null) this.stateStorage.remove(BOARD_TRUST_STORAGE_KEY);
    else this.stateStorage.set(BOARD_TRUST_STORAGE_KEY, serializeBoardTrustAnchor(trust));
    const head = this.getRememberedHead();
    if (head === null) this.stateStorage.remove(BOARD_HEAD_STORAGE_KEY);
    else this.stateStorage.set(BOARD_HEAD_STORAGE_KEY, head);
  }

  private persistAll(): void {
    this.persistPublicState();
    const credential = this.getCredential();
    if (credential === null) this.stateStorage.remove(BOARD_CREDENTIAL_STORAGE_KEY);
    else this.stateStorage.set(BOARD_CREDENTIAL_STORAGE_KEY, serializeBoardCredential(credential));
  }
}

export function createBrowserBoardApi(
  storage: BrowserStateStorage = browserStorage(),
  options: BoardApiOptions = {},
): BrowserBoardApi {
  return new BrowserBoardApi(storage, options);
}

export * from '../../packages/core/src/api';
export {
  BOARD_CREDENTIAL_STORAGE_KEY,
  BOARD_HEAD_STORAGE_KEY,
  BOARD_TRUST_STORAGE_KEY,
} from '../../packages/core/src/credential';
