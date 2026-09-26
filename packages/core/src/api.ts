import { generateSigningKey } from './canonical.js';
import {
  ANTONINA_NAMESPACE,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
  SignedBoardStore,
  SignedBoardStoreError,
  type SignedBoardStoreOptions,
  type StoredSignedBoard,
} from './board-store.js';
import {
  createBoardCredential,
  credentialTrustAnchor,
  parseBoardCredential,
  parseBoardTrustAnchor,
  verifyBoardCredential,
  verifyBoardTrustAnchor,
  type BoardCredential,
} from './credential.js';
import {
  MAX_SAFE_INTEGER,
  canonicalHost,
  canonicalPath,
  emptyBoard,
  resourceViews,
  type Board,
  type BoardIssue,
  type BoardResource,
  type IssueState,
  type ResourceView,
} from './model.js';
import {
  BOARD_CAPABILITIES,
  type BoardCapability,
  type BoardOperationKind,
  type BoardOperationPayload,
  type BoardTrustAnchor,
  type VerifiedAuthority,
  type VerifiedBoardState,
} from './operations.js';

export {
  ANTONINA_NAMESPACE,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
};
export const BOARD_KEY = SIGNED_BOARD_KEY;

const MUTATING_CAPABILITIES = new Set<BoardCapability>([
  'issue.create',
  'issue.edit',
  'issue.delete',
  'issue.comment',
  'issue.state',
  'queue.reorder',
  'resource.modify',
  'board.delete',
  'authority.delegate',
  'authority.revoke',
]);

export class AntoninaApiError extends Error {}

/** The signed board exists but this client cannot verify it without a trust anchor. */
export class BoardTrustRequiredError extends AntoninaApiError {}

export interface BoardApiOptions extends SignedBoardStoreOptions {
  credential?: BoardCredential | null;
  trustAnchor?: BoardTrustAnchor | null;
  rememberedHead?: string | null;
}

export interface BoardAccessState {
  boardId: string;
  keyId: string | null;
  rootKeyId: string;
  capabilities: BoardCapability[];
  storageVerified: boolean;
  canEdit: boolean;
}

export interface BoardInitialization {
  board: Board;
  credential: BoardCredential;
  trustAnchor: BoardTrustAnchor;
  head: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameAnchor(left: BoardTrustAnchor, right: BoardTrustAnchor): boolean {
  return left.boardId === right.boardId
    && left.rootKeyId === right.rootKeyId
    && left.rootPublicKey === right.rootPublicKey;
}

function normalizeCapabilities(values: readonly BoardCapability[]): BoardCapability[] {
  const unique = [...new Set(values)];
  for (const capability of unique) {
    if (!(BOARD_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new AntoninaApiError('Unknown Antonina board capability: ' + String(capability));
    }
  }
  return unique.sort();
}

function hasMutationCapability(capabilities: readonly BoardCapability[]): boolean {
  return capabilities.some((capability) => MUTATING_CAPABILITIES.has(capability));
}

export class BoardApi {
  private readonly store: SignedBoardStore;
  private credential: BoardCredential | null;
  private anchor: BoardTrustAnchor | null;
  private rememberedHead: string | null;
  private storageVerified = false;
  private effectiveCapabilities: BoardCapability[] = [];

  constructor(options: BoardApiOptions = {}) {
    this.store = new SignedBoardStore(options);
    this.credential = options.credential === undefined || options.credential === null
      ? null
      : parseBoardCredential(options.credential);
    const credentialAnchor = this.credential === null ? null : credentialTrustAnchor(this.credential);
    const configuredAnchor = options.trustAnchor === undefined || options.trustAnchor === null
      ? null
      : parseBoardTrustAnchor(options.trustAnchor);
    if (credentialAnchor !== null && configuredAnchor !== null && !sameAnchor(credentialAnchor, configuredAnchor)) {
      throw new AntoninaApiError('Antonina credential does not match the configured board trust anchor');
    }
    this.anchor = configuredAnchor ?? credentialAnchor;
    this.rememberedHead = options.rememberedHead ?? null;
  }

  getCredential(): BoardCredential | null {
    return this.credential === null ? null : clone(this.credential);
  }

  getTrustAnchor(): BoardTrustAnchor | null {
    return this.anchor === null ? null : clone(this.anchor);
  }

  getRememberedHead(): string | null {
    return this.rememberedHead;
  }

  getEffectiveCapabilities(): BoardCapability[] {
    return [...this.effectiveCapabilities];
  }

  hasWriteAccess(): boolean {
    return this.storageVerified && hasMutationCapability(this.effectiveCapabilities);
  }

  clearCredential(): void {
    this.credential = null;
    this.storageVerified = false;
    this.effectiveCapabilities = [];
  }

  async signedBoardExists(): Promise<boolean> {
    return this.store.signedBoardExists();
  }

  /**
   * Reads the signed board without ever creating it; a missing board is `null`
   * and an existing board is only readable through a configured trust anchor.
   */
  async readBoard(): Promise<Board | null> {
    if (this.anchor === null) {
      if (await this.store.signedBoardExists()) {
        throw new BoardTrustRequiredError('Antonina signed board exists; this client has no trust anchor for it');
      }
      return null;
    }
    const stored = await this.store.read(this.anchor, this.rememberedHead);
    if (stored === null) return null;
    this.acceptStored(stored);
    return clone(stored.state.board);
  }

  /**
   * Deliberately creates the signed board and adopts its one-time root
   * credential. The only way to create a board; reading never does, and a
   * second initializer is refused instead of taking the trust root.
   */
  async initialize(initialBoard: Board = emptyBoard()): Promise<BoardInitialization> {
    if (await this.store.signedBoardExists()) {
      throw new AntoninaApiError('The Antonina signed board already exists');
    }
    const initialized = await this.store.initialize(initialBoard);
    this.anchor = credentialTrustAnchor(initialized.credential);
    this.credential = initialized.credential;
    this.acceptStored(initialized);
    this.storageVerified = true;
    this.refreshEffectiveCapabilities(initialized.state);
    return {
      board: clone(initialized.state.board),
      credential: clone(initialized.credential),
      trustAnchor: clone(this.anchor),
      head: initialized.state.head,
    };
  }

  async trustBoard(anchorValue: BoardTrustAnchor): Promise<Board> {
    const anchor = await verifyBoardTrustAnchor(anchorValue);
    if (this.anchor !== null && !sameAnchor(this.anchor, anchor)) {
      throw new AntoninaApiError('Refusing to replace the trusted Antonina board root implicitly');
    }
    const stored = await this.store.require(anchor, this.rememberedHead);
    this.anchor = anchor;
    this.acceptStored(stored);
    this.storageVerified = false;
    this.refreshEffectiveCapabilities(stored.state);
    return clone(stored.state.board);
  }

  async verifyCredential(credentialValue: BoardCredential | null = this.credential): Promise<BoardAccessState> {
    if (credentialValue === null) throw new AntoninaApiError('Antonina board credential is required');
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    if (this.anchor !== null && !sameAnchor(this.anchor, anchor)) {
      throw new AntoninaApiError('Antonina credential does not match the trusted board root');
    }

    let stored: StoredSignedBoard;
    try {
      stored = await this.store.verifyStorageCapability(credential, this.rememberedHead);
    } catch (error) {
      this.storageVerified = false;
      this.effectiveCapabilities = [];
      throw error;
    }

    const authority = this.requireActiveAuthority(stored.state, credential.keyId);
    this.anchor = anchor;
    this.credential = credential;
    this.acceptStored(stored);
    this.storageVerified = true;
    this.effectiveCapabilities = [...authority.capabilities];
    return this.accessState();
  }

  accessState(): BoardAccessState {
    const anchor = this.requireAnchor();
    return {
      boardId: anchor.boardId,
      keyId: this.credential?.keyId ?? null,
      rootKeyId: anchor.rootKeyId,
      capabilities: [...this.effectiveCapabilities],
      storageVerified: this.storageVerified,
      canEdit: this.hasWriteAccess(),
    };
  }

  async loadState(): Promise<VerifiedBoardState> {
    const stored = await this.readStored();
    return clone(stored.state);
  }

  async loadBoard(): Promise<Board> {
    return clone((await this.readStored()).state.board);
  }

  async listIssues(state?: IssueState): Promise<BoardIssue[]> {
    const issues = (await this.loadBoard()).issues;
    return issues
      .filter((issue) => state === undefined || issue.state === state)
      .sort((left, right) => left.number - right.number);
  }

  async getIssue(number: number): Promise<BoardIssue> {
    return clone(this.requireIssue((await this.loadBoard()).issues, number));
  }

  async getQueue(): Promise<number[]> {
    return [...(await this.readStored()).state.queue];
  }

  async reorderQueue(numbers: number[]): Promise<number[]> {
    const committed = await this.append('queue.reorder', { numbers: [...numbers] }, 'queue.reorder');
    return [...committed.state.queue];
  }

  async createIssue(title: string, body = ''): Promise<BoardIssue> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new AntoninaApiError('Issue title is required');
    let createdNumber = 0;
    const committed = await this.append(
      'issue.create',
      (state) => {
        createdNumber = state.board.nextIssueNumber;
        if (createdNumber >= MAX_SAFE_INTEGER) throw new AntoninaApiError('Antonina issue number space is exhausted');
        return { number: createdNumber, title: cleanTitle, body: body.trim() };
      },
      'issue.create',
    );
    return clone(this.requireIssue(committed.state.board.issues, createdNumber));
  }

  async editIssueBody(number: number, body: string): Promise<BoardIssue> {
    const committed = await this.append(
      'issue.edit',
      { number, title: null, body: body.trim() },
      'issue.edit',
    );
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async listResources(host?: string, issueNumber?: number): Promise<ResourceView[]> {
    return resourceViews(await this.loadBoard(), host, issueNumber);
  }

  async addResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      throw new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource');
    }
    const committed = await this.append(
      'resource.add',
      { number: issueNumber, host: cleanHost, path: cleanPath },
      'resource.modify',
    );
    const resource = committed.state.board.resources.find(
      (entry) => entry.host === cleanHost && entry.path === cleanPath,
    );
    if (!resource) throw new AntoninaApiError('Antonina resource disappeared after mutation');
    return clone(resource);
  }

  async removeResourceDependency(host: string, path: string, issueNumber: number): Promise<BoardResource[]> {
    let cleanHost: string;
    let cleanPath: string;
    try {
      cleanHost = canonicalHost(host);
      cleanPath = canonicalPath(path);
    } catch (error) {
      throw new AntoninaApiError(error instanceof Error ? error.message : 'Invalid resource');
    }
    const committed = await this.append(
      'resource.remove',
      { number: issueNumber, host: cleanHost, path: cleanPath },
      'resource.modify',
    );
    return clone(committed.state.board.resources);
  }

  async comment(number: number, author: string, body: string): Promise<BoardIssue> {
    const cleanAuthor = author.trim();
    const cleanBody = body.trim();
    if (!cleanAuthor) throw new AntoninaApiError('Message author is required');
    if (!cleanBody) throw new AntoninaApiError('Message body is required');
    const committed = await this.append(
      'issue.comment',
      { number, author: cleanAuthor, body: cleanBody },
      'issue.comment',
    );
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async close(number: number): Promise<BoardIssue> {
    const committed = await this.append('issue.close', { number }, 'issue.state');
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async reopen(number: number): Promise<BoardIssue> {
    const committed = await this.append('issue.reopen', { number }, 'issue.state');
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async deleteIssue(number: number): Promise<Board> {
    const committed = await this.append('issue.delete', { number }, 'issue.delete');
    return clone(committed.state.board);
  }

  async deleteBoard(): Promise<void> {
    await this.append('board.delete', {}, 'board.delete');
  }

  async delegateCredential(capabilities: readonly BoardCapability[]): Promise<BoardCredential> {
    const current = await this.requireUsableCredential('authority.delegate');
    const normalized = normalizeCapabilities(capabilities);
    for (const capability of normalized) {
      if (!this.effectiveCapabilities.includes(capability)) {
        throw new AntoninaApiError('Delegation cannot add capability ' + capability);
      }
    }
    const child = await generateSigningKey();
    await this.append(
      'authority.delegate',
      {
        childKeyId: child.keyId,
        childPublicKey: child.publicKey,
        capabilities: normalized,
      },
      'authority.delegate',
    );
    return createBoardCredential(this.requireAnchor(), child, current.storageCapability);
  }

  async revokeCredential(keyId: string): Promise<VerifiedAuthority[]> {
    const committed = await this.append(
      'authority.revoke',
      { keyId },
      'authority.revoke',
    );
    return clone(committed.state.authorities);
  }

  async listAuthorities(): Promise<VerifiedAuthority[]> {
    return clone((await this.readStored()).state.authorities);
  }

  private requireAnchor(): BoardTrustAnchor {
    if (this.anchor === null) {
      throw new AntoninaApiError('Antonina board trust anchor is required before board state can be accepted');
    }
    return this.anchor;
  }

  private requireIssue(issues: BoardIssue[], number: number): BoardIssue {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return issue;
  }

  private requireActiveAuthority(state: VerifiedBoardState, keyId: string): VerifiedAuthority {
    const authority = state.authorities.find((candidate) => candidate.keyId === keyId);
    if (!authority || authority.revoked) {
      throw new AntoninaApiError('Antonina board credential is unknown or revoked');
    }
    return authority;
  }

  private refreshEffectiveCapabilities(state: VerifiedBoardState): void {
    if (this.credential === null) {
      this.effectiveCapabilities = [];
      return;
    }
    const authority = state.authorities.find((candidate) => candidate.keyId === this.credential?.keyId);
    if (!authority || authority.revoked) {
      this.storageVerified = false;
      this.effectiveCapabilities = [];
      return;
    }
    this.effectiveCapabilities = [...authority.capabilities];
  }

  private acceptStored(stored: StoredSignedBoard): void {
    if (stored.state.deleted) throw new AntoninaApiError('Antonina board has been deleted');
    this.rememberedHead = stored.state.head;
    this.refreshEffectiveCapabilities(stored.state);
  }

  private async readStored(): Promise<StoredSignedBoard> {
    const stored = await this.store.require(this.requireAnchor(), this.rememberedHead);
    this.acceptStored(stored);
    return stored;
  }

  private async requireUsableCredential(capability: BoardCapability): Promise<BoardCredential> {
    if (this.credential === null) throw new AntoninaApiError('Antonina board credential is required');
    if (!this.storageVerified) await this.verifyCredential(this.credential);
    if (!this.effectiveCapabilities.includes(capability)) {
      throw new AntoninaApiError('Antonina credential lacks required capability ' + capability);
    }
    return this.credential;
  }

  private async append(
    kind: Exclude<BoardOperationKind, 'board.initialize'>,
    payload: BoardOperationPayload | ((state: VerifiedBoardState) => BoardOperationPayload),
    capability: BoardCapability,
  ): Promise<StoredSignedBoard> {
    const credential = await this.requireUsableCredential(capability);
    try {
      const stored = await this.store.append(
        credential,
        { kind, payload },
        this.rememberedHead,
      );
      this.acceptStored(stored);
      this.storageVerified = true;
      return stored;
    } catch (error) {
      if (error instanceof SignedBoardStoreError && /failed \(403\)/.test(error.message)) {
        this.storageVerified = false;
      }
      throw error;
    }
  }
}

export { BOARD_CAPABILITIES } from './operations.js';
export { emptyBoard, parseBoard } from './model.js';
export type { Board, BoardIssue, BoardResource, IssueState, ResourceView } from './model.js';
export type { BoardCredential } from './credential.js';
export type {
  BoardCapability,
  BoardTrustAnchor,
  VerifiedAuthority,
  VerifiedBoardState,
} from './operations.js';
