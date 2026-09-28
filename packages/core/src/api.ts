import {
  ANTONINA_NAMESPACE,
  BoardDeletedError,
  BoardMissingError,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
  SignedBoardStore,
  SignedBoardStoreError,
  type SignedBoardStoreOptions,
  type StoredSignedBoard,
} from './board-store.js';
import {
  credentialTrustAnchor,
  parseBoardCredential,
  parseBoardTrustAnchor,
  verifyBoardCredential,
  verifyBoardTrustAnchor,
  type BoardCredential,
  type CredentialRejection,
} from './credential.js';
import {
  BOARD_FEED_ENTRY_KINDS,
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  boardFeed,
  feedEntries,
  parseFeedCursor,
  type BoardFeedEntry,
  type BoardFeedEntryKind,
  type BoardFeedPage,
  type BoardFeedRequest,
} from './feed.js';
import {
  MAX_SAFE_INTEGER,
  canonicalHost,
  canonicalPath,
  canonicalTargetId,
  emptyBoard,
  parseExecutionTargetBackend,
  parseExecutionTargetCapability,
  parseExecutionTargetKind,
  parseExecutionTargetStatus,
  resourceViews,
  selectExecutionTarget,
  targetViews,
  type Board,
  type BoardDispatch,
  type BoardExecutionTarget,
  type BoardIssue,
  type BoardResource,
  type ExecutionTargetBackend,
  type ExecutionTargetCapability,
  type ExecutionTargetKind,
  type ExecutionTargetStatus,
  type IssueState,
  type ResourceView,
  type TargetRequest,
  type TargetSelection,
  type TargetView,
} from './model.js';
import {
  daemonHostViews,
  type DaemonHostReport,
  type DaemonHostView,
} from './host-daemon.js';
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
  BoardDeletedError,
  BoardMissingError,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
  SignedBoardStoreError,
};

export class AntoninaApiError extends Error {}

/** The signed board exists but this client cannot verify it without a trust anchor. */
export class BoardTrustRequiredError extends AntoninaApiError {}

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

/**
 * A selection that named no target. It carries the whole selection so a caller
 * can see which targets were considered and why each was refused, instead of
 * reading only the message.
 */
export class TargetSelectionError extends AntoninaApiError {
  readonly selection: TargetSelection;

  constructor(selection: TargetSelection) {
    super(selection.rationale);
    this.selection = selection;
  }
}

export interface BoardApiOptions extends SignedBoardStoreOptions {
  credential?: BoardCredential | null;
  trustAnchor?: BoardTrustAnchor | null;
  rememberedHead?: string | null;
}

export interface BoardAccessState {
  boardId: string;
  /**
   * The verified authority's key, or `null` when this client has no verified
   * authority on the board. It is never the key a credential declares about
   * itself, so it stays `null` for a credential the board did not accept.
   */
  keyId: string | null;
  rootKeyId: string;
  capabilities: BoardCapability[];
  /** Why a configured credential is not an active authority, or `null`. */
  credentialRejection: CredentialRejection | null;
  storageRejected: boolean;
  canEdit: boolean;
}

/**
 * The whole verified state the create read, beside the one-time keys. It is
 * the same `VerifiedBoardState` a read hands back, so a caller never has to
 * read the log a second time to learn the queue beside the board.
 */
export interface BoardInitialization {
  state: VerifiedBoardState;
  credential: BoardCredential;
  trustAnchor: BoardTrustAnchor;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameAnchor(left: BoardTrustAnchor, right: BoardTrustAnchor): boolean {
  return left.boardId === right.boardId
    && left.rootKeyId === right.rootKeyId
    && left.rootPublicKey === right.rootPublicKey;
}

export class BoardApi {
  private readonly store: SignedBoardStore;
  private credential: BoardCredential | null;
  private anchor: BoardTrustAnchor | null;
  private rememberedHead: string | null;
  private storageRejected = false;
  /** True only for the one shared root board credential. */
  private credentialAccepted = false;
  private credentialRejection: CredentialRejection | null = null;

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
    return this.credentialAccepted ? [...BOARD_CAPABILITIES] : [];
  }

  /**
   * Authentication is deliberately all-or-nothing for now: the one shared root
   * credential grants every board mutation. There are no roles or delegated
   * capabilities in the live access model.
   */
  hasWriteAccess(): boolean {
    return this.credentialAccepted && !this.storageRejected;
  }

  clearCredential(): void {
    this.credential = null;
    this.storageRejected = false;
    this.credentialAccepted = false;
    this.credentialRejection = null;
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
    await this.acceptStored(initialized);
    this.storageRejected = false;
    return {
      state: clone(initialized.state),
      credential: clone(initialized.credential),
      trustAnchor: clone(this.anchor),
    };
  }

  /**
   * Adopts a trust anchor and returns the whole state that read verified, queue
   * beside board, so adopting a board never costs a second read of the log.
   */
  async trustBoard(anchorValue: BoardTrustAnchor): Promise<VerifiedBoardState> {
    const anchor = await verifyBoardTrustAnchor(anchorValue);
    if (this.anchor !== null && !sameAnchor(this.anchor, anchor)) {
      throw new AntoninaApiError('Refusing to replace the trusted Antonina board root implicitly');
    }
    const stored = await this.readStored(anchor);
    this.anchor = anchor;
    return clone(stored.state);
  }

  /**
   * Verifies the one shared board credential. For now there are no roles,
   * delegated credentials, or per-action capabilities: the root credential is
   * full access and every other credential is rejected.
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

    if (credential.keyId !== anchor.rootKeyId || credential.publicKey !== anchor.rootPublicKey) {
      this.credentialAccepted = false;
      this.credentialRejection = 'unknown';
      throw new AntoninaApiError('Antonina accepts only the shared root board credential');
    }

    await this.readStored(anchor);
    this.anchor = anchor;
    this.credential = credential;
    this.storageRejected = false;
    this.credentialRejection = null;
    this.credentialAccepted = true;
    return this.accessState();
  }

  accessState(): BoardAccessState {
    const anchor = this.requireAnchor();
    return {
      boardId: anchor.boardId,
      keyId: this.credentialAccepted ? anchor.rootKeyId : null,
      rootKeyId: anchor.rootKeyId,
      capabilities: this.getEffectiveCapabilities(),
      credentialRejection: this.credentialRejection,
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
    const anchor = await this.fastReadAnchor();
    const states: IssueState[] = state === undefined ? ['open', 'closed'] : [state];
    const numbers: number[] = [];
    for (const issueState of states) {
      let listedCount = 0;
      for (let page = 1; ; page += 1) {
        const listed = await this.store.readIssuePage(anchor, issueState, page);
        if (listed === null) {
          const issues = (await this.loadBoard()).issues;
          return issues
            .filter((issue) => state === undefined || issue.state === state)
            .sort((left, right) => left.number - right.number);
        }
        numbers.push(...listed.entries.map((entry) => entry.number));
        listedCount += listed.entries.length;
        if (listed.entries.length === 0 || listedCount >= listed.total) break;
      }
    }
    const issues = await Promise.all(numbers.map((number) => this.store.getIssue(anchor, number, this.rememberedHead)));
    return issues
      .filter((issue): issue is BoardIssue => issue !== null)
      .sort((left, right) => left.number - right.number)
      .map(clone);
  }

  async getIssue(number: number): Promise<BoardIssue> {
    const anchor = await this.fastReadAnchor();
    const issue = await this.store.getIssue(anchor, number, this.rememberedHead);
    if (issue === null) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return clone(issue);
  }

  /**
   * One page of the unified chronological board feed, newest first, with the
   * continuation token for the entries after it. The page is a projection over
   * the verified operation log rather than over the collapsed board view, so
   * every entry names an operation the log actually recorded. It needs no
   * credential and writes nothing.
   */
  async readFeed(request: BoardFeedRequest = {}): Promise<BoardFeedPage> {
    const anchor = await this.fastReadAnchor();
    const page = await this.store.readFeed(anchor, request, this.rememberedHead);
    if (page !== null) return page;
    return boardFeed((await this.readStored()).log, request);
  }

  async getQueue(): Promise<number[]> {
    const anchor = await this.fastReadAnchor();
    const queue = await this.store.getQueue(anchor, this.rememberedHead);
    if (queue !== null) return [...queue];
    return [...(await this.readStored()).state.queue];
  }

  async reorderQueue(numbers: number[]): Promise<number[]> {
    const committed = await this.append('queue.reorder', { numbers: [...numbers] });
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
    );
    return clone(this.requireIssue(committed.state.board.issues, createdNumber));
  }

  async editIssueBody(number: number, body: string): Promise<BoardIssue> {
    const committed = await this.append(
      'issue.edit',
      { number, title: null, body: body.trim() },
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
    );
    return clone(committed.state.board.resources);
  }

  /**
   * The canonical catalog of execution targets, each with the durable
   * resources its host carries and the issues dispatched to it.
   */
  async listTargets(): Promise<TargetView[]> {
    return targetViews(await this.loadBoard());
  }

  async getTarget(id: string): Promise<BoardExecutionTarget> {
    const target = (await this.loadBoard()).targets.find((entry) => entry.id === id);
    if (!target) throw new AntoninaApiError('Antonina execution target ' + id + ' is not registered');
    return clone(target);
  }

  /**
   * The persistent hosts a daemon has reported, each related to the target
   * catalog, and how fresh each report is.
   *
   * This is a read of a caller-supplied set of host-local reports joined
   * against the verified board. It appends nothing, needs no credential, and
   * never rewrites a target's recorded status: a report is evidence about a
   * host, not an edit to the registration an operator placed in the catalog. A
   * board that is not readable yields no hosts rather than an error, so a host
   * with telemetry to report is still reportable on a machine with no board.
   */
  async daemonHosts(
    reports: readonly DaemonHostReport[],
    options: { nowMs: number; staleAfterMs?: number },
  ): Promise<DaemonHostView[]> {
    const board = await this.readBoard();
    return clone(daemonHostViews(reports, { ...options, board }));
  }

  /**
   * Registers a target and refuses before it is signed anything an internally
   * inconsistent record would state, so the catalog never holds a target whose
   * kind and capabilities disagree.
   */
  async registerTarget(input: {
    id: string;
    backend: ExecutionTargetBackend;
    kind: ExecutionTargetKind;
    capabilities: readonly ExecutionTargetCapability[];
    address: string | null;
    description?: string;
  }): Promise<BoardExecutionTarget> {
    const id = canonicalTargetId(input.id);
    const address = input.address === null ? null : canonicalHost(input.address);
    const capabilities = [...input.capabilities].sort();
    const committed = await this.append(
      'target.register',
      {
        id,
        backend: parseExecutionTargetBackend(input.backend),
        kind: parseExecutionTargetKind(input.kind),
        capabilities: capabilities.map(parseExecutionTargetCapability),
        address,
        description: input.description ?? '',
      },
    );
    return this.requireTarget(committed.state.board, id);
  }

  /**
   * Replaces the mutable part of a target record. Backend, kind, and address
   * are fixed at registration: a different backend or host is a different
   * target, not a reconfigured one.
   */
  async setTarget(
    id: string,
    changes: {
      status: ExecutionTargetStatus;
      capabilities: readonly ExecutionTargetCapability[];
      description: string;
    },
  ): Promise<BoardExecutionTarget> {
    const targetId = canonicalTargetId(id);
    const committed = await this.append(
      'target.set',
      {
        id: targetId,
        status: parseExecutionTargetStatus(changes.status),
        capabilities: [...changes.capabilities].sort().map(parseExecutionTargetCapability),
        description: changes.description,
      },
    );
    return this.requireTarget(committed.state.board, targetId);
  }

  /**
   * Decides where a job runs, without recording anything. The selection is a
   * pure function of the verified board and the request, so the same request
   * against the same board answers the same way and says why.
   */
  async selectTarget(request: TargetRequest = {}): Promise<TargetSelection> {
    const selection = selectExecutionTarget(await this.loadBoard(), request);
    if (selection.outcome !== 'selected') throw new TargetSelectionError(selection);
    return selection;
  }

  /**
   * Records which target a job ran on. The target is chosen by the same
   * deterministic selection every caller uses, and a request that cannot be
   * satisfied is refused with the rationale attached rather than resolved to
   * some other target.
   */
  async recordDispatch(issueNumber: number, request: TargetRequest = {}): Promise<BoardDispatch> {
    const selection = selectExecutionTarget(await this.loadBoard(), { ...request });
    if (selection.outcome !== 'selected' || selection.target === null) {
      throw new TargetSelectionError(selection);
    }
    const committed = await this.append(
      'dispatch.record',
      { number: issueNumber, targetId: selection.target.id, rationale: selection.rationale },
    );
    const dispatch = committed.state.board.dispatches.find((entry) => entry.issueNumber === issueNumber);
    if (!dispatch) throw new AntoninaApiError('Antonina dispatch record disappeared after mutation');
    return clone(dispatch);
  }

  async comment(number: number, author: string, body: string): Promise<BoardIssue> {
    const cleanAuthor = author.trim();
    const cleanBody = body.trim();
    if (!cleanAuthor) throw new AntoninaApiError('Message author is required');
    if (!cleanBody) throw new AntoninaApiError('Message body is required');
    const committed = await this.append(
      'issue.comment',
      { number, author: cleanAuthor, body: cleanBody },
    );
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async close(number: number): Promise<BoardIssue> {
    const committed = await this.append('issue.close', { number });
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async reopen(number: number): Promise<BoardIssue> {
    const committed = await this.append('issue.reopen', { number });
    return clone(this.requireIssue(committed.state.board.issues, number));
  }

  async deleteIssue(number: number): Promise<Board> {
    const committed = await this.append('issue.delete', { number });
    return clone(committed.state.board);
  }

  async deleteBoard(): Promise<void> {
    await this.append('board.delete', {});
  }

  async delegateCredential(_capabilities: readonly BoardCapability[]): Promise<BoardCredential> {
    throw new AntoninaApiError('Antonina uses one shared root board credential; delegation is disabled');
  }

  async revokeCredential(_keyId: string): Promise<VerifiedAuthority[]> {
    throw new AntoninaApiError('Antonina uses one shared root board credential; revocation is disabled');
  }

  async listAuthorities(): Promise<VerifiedAuthority[]> {
    throw new AntoninaApiError('Antonina uses one shared root board credential; authority lists are not part of the live access model');
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

  /**
   * Fast materialized reads still require the same public trust anchor as the
   * canonical signed log. On a fresh client, route through the canonical read
   * once so the existing missing-vs-untrusted distinction is preserved.
   */
  private async fastReadAnchor(): Promise<BoardTrustAnchor> {
    if (this.anchor === null) await this.readStored();
    return this.requireAnchor();
  }

  private requireIssue(issues: BoardIssue[], number: number): BoardIssue {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return issue;
  }

  private requireTarget(board: Board, id: string): BoardExecutionTarget {
    const target = board.targets.find((candidate) => candidate.id === id);
    if (!target) throw new AntoninaApiError('Antonina execution target disappeared after mutation');
    return clone(target);
  }

  private async refreshEffectiveAuthority(_state: VerifiedBoardState): Promise<void> {
    if (this.credential === null) {
      this.credentialAccepted = false;
      this.credentialRejection = null;
      return;
    }
    try {
      const credential = await verifyBoardCredential(this.credential);
      const anchor = credentialTrustAnchor(credential);
      this.credentialAccepted = credential.keyId === anchor.rootKeyId
        && credential.publicKey === anchor.rootPublicKey;
      this.credentialRejection = this.credentialAccepted ? null : 'unknown';
    } catch {
      this.credentialAccepted = false;
      this.credentialRejection = 'unverified';
    }
  }

  /** `acceptDeleted` is set only by the append that performed the deletion. */
  private async acceptStored(stored: StoredSignedBoard, acceptDeleted = false): Promise<void> {
    if (stored.state.deleted && !acceptDeleted) {
      throw new BoardDeletedError();
    }
    this.rememberedHead = stored.state.head;
    await this.refreshEffectiveAuthority(stored.state);
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
    await this.acceptStored(stored);
    return stored;
  }

  private async requireUsableCredential(): Promise<BoardCredential> {
    if (this.credential === null || !this.credentialAccepted) {
      await this.verifyCredential(this.credential);
    }
    return this.requireCredential();
  }

  private async append(
    kind: Exclude<BoardOperationKind, 'board.initialize'>,
    payload: BoardOperationPayload | ((state: VerifiedBoardState) => BoardOperationPayload),
  ): Promise<StoredSignedBoard> {
    const credential = await this.requireUsableCredential();
    try {
      const stored = await this.store.append(
        credential,
        { kind, payload },
        this.rememberedHead,
      );
      await this.acceptStored(stored, kind === 'board.delete');
      this.storageRejected = false;
      return stored;
    } catch (error) {
      if (error instanceof SignedBoardStoreError && error.status === 403 && error.method === 'PUT') {
        this.storageRejected = true;
        throw new BoardStorageRejectedError(error);
      }
      throw error;
    }
  }
}

export { BOARD_CAPABILITIES } from './operations.js';
export { emptyBoard, parseBoard } from './model.js';
export {
  BOARD_FEED_ENTRY_KINDS,
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  boardFeed,
  feedEntries,
  feedLimit,
  parseFeedCursor,
} from './feed.js';
export type { BoardFeedEntry, BoardFeedEntryKind, BoardFeedPage, BoardFeedRequest } from './feed.js';
export {
  EXECUTION_TARGET_BACKENDS,
  EXECUTION_TARGET_CAPABILITIES,
  EXECUTION_TARGET_KINDS,
  EXECUTION_TARGET_STATUSES,
  canonicalTargetId,
  canonicalTargetRequirements,
  parseExecutionTargetBackend,
  parseExecutionTargetCapability,
  parseExecutionTargetKind,
  parseExecutionTargetStatus,
  selectExecutionTarget,
  targetIdForHost,
  targetViews,
} from './model.js';
export {
  boardApiCollectionReader,
  collectiblePaths,
  commitCollectionDeletion,
  openCollectionClaim,
  protectionOf,
  readCollectionSnapshot,
  recheckCollectionClaim,
  unverifiedCollectionSnapshot,
} from './collection.js';
export type { Board, BoardIssue, BoardResource, IssueState, ResourceView } from './model.js';
export type {
  BoardDispatch,
  BoardExecutionTarget,
  ExecutionTargetBackend,
  ExecutionTargetCapability,
  ExecutionTargetKind,
  ExecutionTargetStatus,
  TargetConsideration,
  TargetRequest,
  TargetRequirementMiss,
  TargetRequirements,
  TargetSelection,
  TargetSelectionOutcome,
  TargetView,
} from './model.js';
export type {
  AuthorizedCollection,
  CandidateFactsGatherer,
  CollectionClaim,
  CollectionFailure,
  CollectionFailureKind,
  CollectionOutcomeReason,
  CollectionReader,
  CollectionSnapshot,
  CompletedCollection,
  ProtectionDecision,
  ProtectionStatus,
  ProtectionVerdict,
  VerifiedBoardRead,
  VerifiedCollectionSnapshot,
  UnverifiedCollectionSnapshot,
} from './collection.js';
export type { BoardCredential, CredentialAuthority, CredentialRejection } from './credential.js';
export type {
  BoardCapability,
  BoardTrustAnchor,
  VerifiedAuthority,
  VerifiedBoardState,
} from './operations.js';
export type { CandidatePathFacts } from './managed-roots.js';
