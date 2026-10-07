import type { BoardOverview, IssueCommentPage, IssueListSummary } from './board-v3-store.js';
import { newestCommentAt } from './board-v3-store.js';
import {
  ANTONINA_NAMESPACE,
  BoardDeletedError,
  BoardMissingError,
  DEFAULT_BOARD_BASE_URL,
  SIGNED_BOARD_KEY,
  SignedBoardStore,
  SignedBoardStoreError,
  type BoardCutoverState,
  type BoardImportReport,
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
  parseExecutionTargetAccessMethod,
  parseExecutionTargetBackend,
  parseExecutionTargetCapability,
  parseExecutionTargetGarbageCollection,
  parseExecutionTargetKind,
  parseExecutionTargetPersistence,
  parseExecutionTargetStatus,
  resourceViews,
  selectExecutionTarget,
  targetViews,
  type Board,
  type BoardDispatch,
  type BoardExecutionTarget,
  type BoardIssue,
  type BoardResource,
  type BoardReview,
  type ReviewVerdict,
  type ExecutionTargetAccessMethod,
  type ExecutionTargetBackend,
  type ExecutionTargetCapability,
  type ExecutionTargetGarbageCollection,
  type ExecutionTargetKind,
  type ExecutionTargetPersistence,
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
  type HostBytesMeasurement,
} from './host-daemon.js';
import {
  CURRENT_PERSISTED_BOARD_VERSION,
  NoPersistedBoardMigrationPathError,
  PersistedBoardMigrationError,
  SUPPORTED_PERSISTED_BOARD_VERSIONS,
  UnsupportedPersistedBoardVersionError,
  migratePersistedBoard,
  persistedBoardMigrationChain,
  type PersistedBoardMigration,
  type PersistedBoardVersion,
} from './migrations.js';
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

export interface ReviewRecordInput {
  number: number;
  /** The exact commit reviewed, or empty when the review named none. */
  commit: string;
  verdict: ReviewVerdict;
  reviewer: string;
  rationale: string;
}

export const MAX_ISSUE_BODY_CHARACTERS = 1_000;
export const MAX_COMMENT_BODY_CHARACTERS = 1_000;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function requireMaximumCharacters(value: string, maximum: number, label: string): void {
  if (characterCount(value) > maximum) {
    throw new AntoninaApiError(`${label} must be at most ${maximum} characters`);
  }
}

/**
 * The descriptive fields of a target operation, canonicalized and carried only
 * where the caller supplied them. A caller who omits a field does not write an
 * empty one: an absent field reads through the backend's and kind's own defaults,
 * which is what a target registered before these fields existed reads as, so
 * omitting a field never has to mean "clear it".
 *
 * A note list is canonicalized all the way here rather than left half-done for
 * the model: the record a caller builds is refused downstream if it repeats a
 * note or carries a blank one, and a refusal that arrives only after the
 * operation has been signed is a refusal the caller never gets to act on. So
 * the API produces the sorted, duplicate-free list of non-empty notes the model
 * requires, or refuses before anything is signed.
 *
 * An empty list is passed through rather than refused, because it is how a
 * caller retracts a note: it is the field saying it should not be there, and
 * `operations.ts` omits the field from the record for exactly that reason. The
 * model refuses an empty list on a *record*, which is where an empty list would
 * be a stored claim rather than a retraction.
 */
function canonicalNoteList(notes: readonly string[], label: string): string[] {
  if (notes.some((note) => note.trim() === '')) {
    throw new AntoninaApiError(`An execution target ${label} cannot be blank`);
  }
  return [...new Set(notes)].sort();
}

function canonicalTargetNotes(input: {
  displayName?: string;
  accessMethod?: ExecutionTargetAccessMethod;
  persistence?: ExecutionTargetPersistence;
  garbageCollection?: ExecutionTargetGarbageCollection;
  limitations?: readonly string[];
  guidance?: readonly string[];
}): Record<string, unknown> {
  const displayName = input.displayName;
  if (displayName !== undefined && displayName.trim() === '') {
    throw new AntoninaApiError('An execution target display name cannot be blank');
  }
  return {
    ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
    ...(input.accessMethod !== undefined ? { accessMethod: parseExecutionTargetAccessMethod(input.accessMethod) } : {}),
    ...(input.persistence !== undefined ? { persistence: parseExecutionTargetPersistence(input.persistence) } : {}),
    ...(input.garbageCollection !== undefined
      ? { garbageCollection: parseExecutionTargetGarbageCollection(input.garbageCollection) }
      : {}),
    ...(input.limitations !== undefined ? { limitations: canonicalNoteList(input.limitations, 'limitation') } : {}),
    ...(input.guidance !== undefined ? { guidance: canonicalNoteList(input.guidance, 'guidance reference') } : {}),
  };
}

/** The board exists but this client has not been given its board credential. */
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
 * perform a second board read just to learn the queue beside the board.
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
  /** True once the one shared board key in this credential has opened the board. */
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
   * Authentication is deliberately all-or-nothing for now: any existing
   * Antonina credential carrying the board's one shared key grants the whole
   * board. There are no roles or per-action capabilities in the live model.
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
   * Deliberately creates the materialized board and adopts its board
   * credential. The only way to create a board; reading never does, and a
   * second initializer is refused instead of taking the trust root.
   */
  async initialize(initialBoard: Board = emptyBoard()): Promise<BoardInitialization> {
    if (await this.store.signedBoardExists()) {
      throw new AntoninaApiError('The Antonina board already exists');
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
   * Verifies one existing Antonina board credential. All issued credentials are
   * equivalent for now: possession grants the whole board, with no roles or
   * per-action capabilities.
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

    this.anchor = anchor;
    this.credential = credential;
    const overview = await this.store.readOverview(credential, this.rememberedHead);
    if (overview.deleted) throw new BoardDeletedError();
    this.rememberedHead = overview.head;
    this.storageRejected = false;
    this.credentialRejection = null;
    this.credentialAccepted = true;
    return this.accessState();
  }

  accessState(): BoardAccessState {
    const anchor = this.requireAnchor();
    return {
      boardId: anchor.boardId,
      keyId: this.credentialAccepted ? (this.credential?.keyId ?? null) : null,
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

  /**
   * Lightweight board read for list-oriented clients. It reads materialized
   * list pages, queue and catalog only; issue bodies and comment pages are not
   * fetched until getIssue() is called.
   */
  async loadOverview(): Promise<BoardOverview> {
    const credential = await this.fastReadCredential();
    const overview = await this.store.readOverview(credential, this.rememberedHead);
    if (overview.deleted) throw new BoardDeletedError();
    this.rememberedHead = overview.head;
    this.credentialAccepted = true;
    this.credentialRejection = null;
    return clone(overview);
  }

  async loadBoard(): Promise<Board> {
    return clone((await this.readStored()).state.board);
  }

  async listIssueSummaries(state?: IssueState): Promise<IssueListSummary[]> {
    const credential = await this.fastReadCredential();
    const states: IssueState[] = state === undefined ? ['open', 'closed'] : [state];
    const summaries: IssueListSummary[] = [];
    for (const issueState of states) {
      let listedCount = 0;
      for (let page = 1; ; page += 1) {
        const listed = await this.store.readIssuePage(credential, issueState, page);
        if (listed === null) {
          const issues = (await this.loadBoard()).issues;
          return issues
            .filter((issue) => state === undefined || issue.state === state)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt,
              closedAt: issue.state === 'closed' ? issue.updatedAt : null,
              messageCount: issue.messages.length,
              lastActivityAt: newestCommentAt(issue.messages),
              hasBody: issue.body.length > 0,
            }))
            .sort((left, right) => left.number - right.number);
        }
        summaries.push(...listed.entries);
        listedCount += listed.entries.length;
        if (listed.entries.length === 0 || listedCount >= listed.total) break;
      }
    }
    return summaries.map(clone);
  }

  async listIssues(state?: IssueState): Promise<BoardIssue[]> {
    const credential = await this.fastReadCredential();
    const states: IssueState[] = state === undefined ? ['open', 'closed'] : [state];
    const numbers: number[] = [];
    for (const issueState of states) {
      let listedCount = 0;
      for (let page = 1; ; page += 1) {
        const listed = await this.store.readIssuePage(credential, issueState, page);
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
    const issues = await Promise.all(numbers.map((number) => this.store.getIssue(credential, number, this.rememberedHead)));
    return issues
      .filter((issue): issue is BoardIssue => issue !== null)
      .sort((left, right) => left.number - right.number)
      .map(clone);
  }

  async getIssue(number: number): Promise<BoardIssue> {
    const credential = await this.fastReadCredential();
    const issue = await this.store.getIssue(credential, number, this.rememberedHead);
    if (issue === null) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return clone(issue);
  }

  /**
   * Read one reverse-chronological comment page for an issue while preserving
   * chronological order inside the page. Page 1 contains the newest comments.
   * The issue description is returned on every page.
   */
  async getIssuePage(number: number, page: number): Promise<BoardIssue> {
    const credential = await this.fastReadCredential();
    const issue = await this.store.getIssuePage(credential, number, page, this.rememberedHead);
    if (issue === null) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return clone(issue);
  }

  /**
   * One bounded page of an issue's conversation, newest-first.
   *
   * Page 1 holds the MOST RECENT comments and higher page numbers walk backward
   * into older history, so a reader who opens an issue sees its current state
   * without having to page. This is the same page `getIssuePage` returns for
   * the same number: board issue 206 exists because these two reads used to
   * disagree, one counting from the oldest comment and one from the newest, so
   * the CLI and the web rendered the same thread in opposite page order.
   *
   * Order inside a page is chronological and deterministic: it is storage
   * position, which is unique per comment, so two comments sharing a timestamp
   * are still ordered rather than left to an unstable tie-break.
   *
   * This exists beside `getIssue` and does not replace it. `getIssue` is the
   * whole issue — every message — and its callers (the CLI's issue view,
   * `listIssues`) ask for that. A client paging through a conversation does not,
   * and reassembling a 5,000-message thread to draw 50 of them is the cost this
   * read removes: it fetches the issue's own shard and at most the two comment
   * shards the window straddles, and a page past the end fetches none at all.
   */
  async getIssueCommentPage(number: number, page: number): Promise<IssueCommentPage> {
    const credential = await this.fastReadCredential();
    const read = await this.store.readIssueCommentPage(credential, number, page);
    if (read === null) throw new AntoninaApiError('Antonina issue ' + number + ' does not exist');
    return clone(read);
  }

  /**
   * One page of the materialized chronological board feed, newest first.
   * V3 stores feed pages directly; reading the feed never reconstructs history.
   */
  async readFeed(request: BoardFeedRequest = {}): Promise<BoardFeedPage> {
    const credential = await this.fastReadCredential();
    const page = await this.store.readFeed(credential, request, this.rememberedHead);
    if (page === null) throw new BoardMissingError();
    return page;
  }

  /**
   * Which side of the format cutover the board is on.
   *
   * `needs-import` is the state a user has to be told about: the board is stored
   * in the pre-cutover format, this build will not serve it, and an import is the
   * only way forward. Reading the board in that state fails by name rather than
   * silently returning stale or partial data.
   */
  async cutoverState(): Promise<BoardCutoverState> {
    const credential = await this.fastReadCredential();
    return this.store.cutoverState(credential);
  }

  /**
   * Imports a pre-cutover board into the current format and switches over to it.
   *
   * Destructive in the sense that `collect delete` is, and gated the same way:
   * without `confirm` it is a plan that writes nothing.
   */
  async importBoard(options: { confirm?: boolean } = {}): Promise<BoardImportReport> {
    const credential = this.requireCredential();
    const report = await this.store.importBoard(credential, options);
    // A cutover replaces the board, so anything the caller remembered about its
    // head is no longer a thing this client has seen.
    this.rememberedHead = null;
    return report;
  }


  async getQueue(): Promise<number[]> {
    const credential = await this.fastReadCredential();
    const queue = await this.store.getQueue(credential, this.rememberedHead);
    if (queue !== null) return [...queue];
    return [...(await this.readStored()).state.queue];
  }

  async reorderQueue(numbers: number[]): Promise<number[]> {
    const committed = await this.append('queue.reorder', { numbers: [...numbers] });
    return [...committed.state.queue];
  }

  async createIssue(title: string, body = ''): Promise<BoardIssue> {
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle) throw new AntoninaApiError('Issue title is required');
    requireMaximumCharacters(cleanBody, MAX_ISSUE_BODY_CHARACTERS, 'Issue body');
    let createdNumber = 0;
    const committed = await this.append(
      'issue.create',
      (state) => {
        createdNumber = state.board.nextIssueNumber;
        if (createdNumber >= MAX_SAFE_INTEGER) throw new AntoninaApiError('Antonina issue number space is exhausted');
        return { number: createdNumber, title: cleanTitle, body: cleanBody };
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

  /**
   * Records one review verdict about one exact commit of an issue's work.
   *
   * This is the board-side half of the review step in
   * docs/skills/itinerary-antonina.md: the verdict is a signed board operation
   * rather than a sentence in a comment, because {@link close} has to be able to
   * refuse a blocked issue without reading anybody's prose. An approval that
   * names the commit a block was recorded against is refused rather than stored,
   * so the override this repository has a documented history of cannot be
   * expressed as a state the board accepts.
   */
  async recordReview(input: ReviewRecordInput): Promise<BoardReview> {
    const reviewer = input.reviewer.trim();
    const rationale = input.rationale.trim();
    if (!reviewer) throw new AntoninaApiError('Review reviewer is required');
    if (!rationale) throw new AntoninaApiError('Review rationale is required');
    const committed = await this.append(
      'review.record',
      {
        number: input.number,
        commit: input.commit.trim(),
        verdict: input.verdict,
        reviewer,
        rationale,
      },
    );
    const review = this.requireIssue(committed.state.board.issues, input.number).review;
    if (review === undefined) throw new AntoninaApiError('Antonina review record disappeared after mutation');
    return clone(review);
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
    displayName?: string;
    accessMethod?: ExecutionTargetAccessMethod;
    persistence?: ExecutionTargetPersistence;
    garbageCollection?: ExecutionTargetGarbageCollection;
    limitations?: readonly string[];
    guidance?: readonly string[];
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
        ...canonicalTargetNotes(input),
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
      displayName?: string;
      limitations?: readonly string[];
      guidance?: readonly string[];
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
        ...canonicalTargetNotes(changes),
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
    requireMaximumCharacters(cleanBody, MAX_COMMENT_BODY_CHARACTERS, 'Comment body');
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
    await this.append('issue.delete', { number });
    // This API promises a full Board, not the compact mutation working set.
    // Deletion is rare enough that hydrating the surviving threads here is the
    // explicit cost of that return type rather than a cost paid by every write.
    return this.loadBoard();
  }

  async deleteBoard(): Promise<void> {
    await this.append('board.delete', {});
  }

  async delegateCredential(_capabilities: readonly BoardCapability[]): Promise<BoardCredential> {
    throw new AntoninaApiError('Antonina uses one shared board credential; delegation is disabled');
  }

  async revokeCredential(_keyId: string): Promise<VerifiedAuthority[]> {
    throw new AntoninaApiError('Antonina uses one shared board credential; revocation is disabled');
  }

  async listAuthorities(): Promise<VerifiedAuthority[]> {
    throw new AntoninaApiError('Antonina uses one shared board credential; authority lists are not part of the live access model');
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

  /** Fast materialized reads are addressed by the same one board key. */
  private async fastReadCredential(): Promise<BoardCredential> {
    if (this.credential === null) {
      if (!await this.store.signedBoardExists()) throw new BoardMissingError();
      throw new BoardTrustRequiredError('Antonina board exists; this client has no board credential');
    }
    if (!this.credentialAccepted) await this.verifyCredential(this.credential);
    return this.requireCredential();
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
    // Reaching a materialized board through readWithCredential already proves
    // possession of the one board-wide key. There is deliberately no second
    // authority or capability check.
    this.credentialAccepted = this.credential !== null;
    this.credentialRejection = null;
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
  private async readStored(_anchor: BoardTrustAnchor | null = this.anchor): Promise<StoredSignedBoard> {
    if (this.credential === null) {
      if (await this.store.signedBoardExists()) {
        throw new BoardTrustRequiredError('Antonina board exists; this client has no board credential');
      }
      throw new BoardMissingError();
    }
    const stored = await this.store.readWithCredential(this.credential, this.rememberedHead);
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
      const stored = await this.store.appendFast(
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
export type {
  BoardCutoverState,
  BoardImportReport,
  BoardOverview,
  BoardSweepReport,
  IssueCommentPage,
  IssueListPage,
  IssueListSummary,
} from './board-v3-store.js';
export { compareIssueActivity, issueLastActivityOf, newestCommentAt } from './board-v3-store.js';
export {
  EXECUTION_TARGET_ACCESS_METHODS,
  EXECUTION_TARGET_BACKENDS,
  EXECUTION_TARGET_CAPABILITIES,
  EXECUTION_TARGET_GARBAGE_COLLECTION,
  EXECUTION_TARGET_GUIDANCE,
  EXECUTION_TARGET_KINDS,
  EXECUTION_TARGET_PERSISTENCE,
  EXECUTION_TARGET_STATUSES,
  canonicalTargetId,
  canonicalTargetRequirements,
  defaultExecutionTargetAccessMethod,
  defaultExecutionTargetPersistence,
  executionTargetAccess,
  guidancePathDefect,
  parseExecutionTargetAccessMethod,
  parseExecutionTargetBackend,
  parseExecutionTargetCapability,
  parseExecutionTargetGarbageCollection,
  parseExecutionTargetKind,
  parseExecutionTargetPersistence,
  parseExecutionTargetStatus,
  selectExecutionTarget,
  targetIdForHost,
  targetViews,
  type ExecutionTargetAccess,
} from './model.js';
export {
  DAEMON_HEALTHS,
  DEFAULT_STALE_AFTER_MS,
  HOST_LIVENESSES,
  HOST_MEASUREMENT_REASONS,
  formatHostBytes,
  hostBytes,
  hostLiveness,
  hostViewForTarget,
  unavailableHostBytes,
  type DaemonHostReport,
  type DaemonHostView,
  type HostBytes,
  type HostBytesMeasurement,
  type HostCpu,
  type HostFilesystem,
  type HostLiveness,
  type HostMeasurementReason,
  type HostMemory,
  type HostTelemetry,
} from './host-daemon.js';
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
export {
  CURRENT_PERSISTED_BOARD_VERSION,
  NoPersistedBoardMigrationPathError,
  PersistedBoardMigrationError,
  SUPPORTED_PERSISTED_BOARD_VERSIONS,
  UnsupportedPersistedBoardVersionError,
  migratePersistedBoard,
  persistedBoardMigrationChain,
} from './migrations.js';
export type {
  MigratedPersistedBoard,
  PersistedBoardMigration,
  PersistedBoardVersion,
  SupersededPersistedBoardVersion,
} from './migrations.js';
export type { BoardMigrationReport } from './operations.js';
