import { generateSigningKey } from './canonical.js';
import {
  ANTONINA_NAMESPACE,
  BoardMissingError,
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
  parseBoardCapability,
  type BoardCapability,
  type BoardOperationKind,
  type BoardOperationPayload,
  type BoardTrustAnchor,
  type VerifiedAuthority,
  type VerifiedBoardState,
} from './operations.js';

export {
  ANTONINA_NAMESPACE,
  BoardMissingError,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
  SignedBoardStoreError,
};

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

/** The signed board was deliberately deleted, so its key can never be used again. */
export class BoardDeletedError extends AntoninaApiError {}

/**
 * Skrynia refused the storage capability this credential carries, so the
 * client is read-only until it is given a credential copied after that
 * capability was rotated.
 */
export class BoardStorageRejectedError extends AntoninaApiError {
  constructor(cause: unknown) {
    super('Skrynia refused the storage capability in this board credential; copy a fresh credential from a board editor', { cause });
  }
}

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
  storageRejected: boolean;
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
  return [...new Set(values.map((value) => parseBoardCapability(value)))].sort();
}

function hasMutationCapability(capabilities: readonly BoardCapability[]): boolean {
  return capabilities.some((capability) => MUTATING_CAPABILITIES.has(capability));
}

export class BoardApi {
  private readonly store: SignedBoardStore;
  private credential: BoardCredential | null;
  private anchor: BoardTrustAnchor | null;
  private rememberedHead: string | null;
  private storageRejected = false;
  /** `null` until a verified log has said what this credential may do. */
  private effectiveCapabilities: BoardCapability[] | null = null;

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
    return this.effectiveCapabilities === null ? [] : [...this.effectiveCapabilities];
  }

  /**
   * Edit access is what the verified log grants this credential, minus any
   * storage capability Skrynia has already refused. It is never established by
   * a probe: reading the board writes nothing.
   */
  hasWriteAccess(): boolean {
    return !this.storageRejected && hasMutationCapability(this.getEffectiveCapabilities());
  }

  clearCredential(): void {
    this.credential = null;
    this.storageRejected = false;
    this.effectiveCapabilities = null;
  }

  async signedBoardExists(): Promise<boolean> {
    return this.store.signedBoardExists();
  }

  /**
   * The tri-state read both front ends share: a missing board is `null`, a
   * board this client cannot verify is `BoardTrustRequiredError`, and an
   * existing board is only readable through a configured trust anchor.
   */
  async readBoard(): Promise<Board | null> {
    try {
      return clone((await this.readStored()).state.board);
    } catch (error) {
      if (error instanceof BoardMissingError) return null;
      throw error;
    }
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
    this.storageRejected = false;
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
    const stored = await this.readStored(anchor);
    this.anchor = anchor;
    return clone(stored.state.board);
  }

  /**
   * Verifies a credential against the board's own history: it must be a real
   * signature over a live authority that holds the delegated capabilities. It
   * never writes, so it cannot discover a stale storage capability; the first
   * real mutation reports that.
   */
  async verifyCredential(credentialValue: BoardCredential | null = this.credential): Promise<BoardAccessState> {
    if (credentialValue === null) {
      // Board state first, so `access` on an unconfigured machine asks for
      // initialization rather than for a credential that cannot exist yet.
      await this.readStored();
      throw new AntoninaApiError('Antonina board credential is required');
    }
    const credential = await verifyBoardCredential(credentialValue);
    const anchor = credentialTrustAnchor(credential);
    if (this.anchor !== null && !sameAnchor(this.anchor, anchor)) {
      throw new AntoninaApiError('Antonina credential does not match the trusted board root');
    }

    const stored = await this.readStored(anchor);
    const authority = this.requireActiveAuthority(stored.state, credential.keyId);
    this.anchor = anchor;
    this.credential = credential;
    this.storageRejected = false;
    this.effectiveCapabilities = [...authority.capabilities];
    return this.accessState();
  }

  accessState(): BoardAccessState {
    const anchor = this.requireAnchor();
    return {
      boardId: anchor.boardId,
      keyId: this.credential?.keyId ?? null,
      rootKeyId: anchor.rootKeyId,
      capabilities: this.getEffectiveCapabilities(),
      storageRejected: this.storageRejected,
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
    const held = this.getEffectiveCapabilities();
    for (const capability of normalized) {
      if (!held.includes(capability)) {
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

  /** States one requirement; `verifyCredential` reports the same miss. */
  private requireCredential(): BoardCredential {
    if (this.credential === null) throw new AntoninaApiError('Antonina board credential is required');
    return this.credential;
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
      this.effectiveCapabilities = null;
      return;
    }
    const authority = state.authorities.find((candidate) => candidate.keyId === this.credential?.keyId);
    this.effectiveCapabilities = !authority || authority.revoked ? [] : [...authority.capabilities];
  }

  /** `acceptDeleted` is set only by the append that performed the deletion. */
  private acceptStored(stored: StoredSignedBoard, acceptDeleted = false): void {
    if (stored.state.deleted && !acceptDeleted) {
      throw new BoardDeletedError('Antonina board has been deleted');
    }
    this.rememberedHead = stored.state.head;
    this.refreshEffectiveCapabilities(stored.state);
  }

  /**
   * The one read path every read command and read command result goes through.
   * It reports a missing board and an unverifiable board as two distinct
   * failures, and it never creates or writes the board.
   */
  private async readStored(anchor: BoardTrustAnchor | null = this.anchor): Promise<StoredSignedBoard> {
    if (anchor === null) {
      if (await this.store.signedBoardExists()) {
        throw new BoardTrustRequiredError('Antonina signed board exists; this client has no trust anchor for it');
      }
      throw new BoardMissingError();
    }
    const stored = await this.store.read(anchor, this.rememberedHead);
    if (stored === null) throw new BoardMissingError();
    this.acceptStored(stored);
    return stored;
  }

  private async requireUsableCredential(capability: BoardCapability): Promise<BoardCredential> {
    if (this.credential === null || this.effectiveCapabilities === null) {
      // `verifyCredential` establishes board state before it asks for a
      // credential, through the same one read path every command uses. It
      // throws when there is no credential, so `requireCredential` below
      // only narrows the type.
      await this.verifyCredential(this.credential);
    }
    const credential = this.requireCredential();
    if (!this.effectiveCapabilities?.includes(capability)) {
      throw new AntoninaApiError('Antonina credential lacks required capability ' + capability);
    }
    return credential;
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
      this.acceptStored(stored, kind === 'board.delete');
      this.storageRejected = false;
      return stored;
    } catch (error) {
      if (error instanceof SignedBoardStoreError && error.status === 403) {
        this.storageRejected = true;
        throw new BoardStorageRejectedError(error);
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
