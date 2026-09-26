import {
  canonicalHost,
  canonicalPath,
  parseBoard,
  resourceViews,
  type ResourceDependencyView,
  type ResourceView,
} from './model.js';
import {
  BoardDeletedError,
  BoardMissingError,
  BoardTrustRequiredError,
  type BoardApi,
} from './api.js';
import {
  OperationLogVerificationError,
  type VerifiedBoardState,
} from './operations.js';
import { SignedBoardStoreError } from './board-store.js';

/**
 * The registry half of resource-driven host garbage collection.
 *
 * This module owns the *collection snapshot*: the verified board revision a
 * decision was made from, the protection answer derived from it, and the
 * re-check protocol a caller must follow immediately before a destructive
 * action. It decides only whether a path is still *owed protection*. Whether a
 * path is safe to touch at all belongs to the path-safety front, and is
 * deliberately unknown here.
 *
 * The protection rule is not reimplemented here. `resourceViews()` in
 * `model.ts` owns it, and a resource registered against issues that no longer
 * exist, or against no issue at all, is not a case this module has an
 * opinion about: the canonical board parser rejects both, so such state is
 * unverified state and the snapshot is fail-closed.
 */

/** One authoritative read: a verified board revision and the board it belongs to. */
export interface VerifiedBoardRead {
  boardId: string;
  state: VerifiedBoardState;
}

/**
 * A read that can only produce verified board state. `boardApiCollectionReader`
 * is the way to obtain one, so no caller has to know how verification works.
 */
export type CollectionReader = () => Promise<VerifiedBoardRead>;

export function boardApiCollectionReader(api: BoardApi): CollectionReader {
  return async () => {
    // The state read first: it is the read that establishes which board this
    // client is talking about, and its failure is the failure to report.
    const state = await api.loadState();
    return { boardId: api.accessState().boardId, state };
  };
}

export type ProtectionStatus = 'protected' | 'collectible';

/** Why a snapshot exists without being a protection decision. */
export type CollectionFailureKind =
  | 'board-missing'
  | 'board-unverifiable'
  | 'board-read-failed'
  | 'board-state-rejected';

export interface CollectionFailure {
  kind: CollectionFailureKind;
  message: string;
}

export interface ProtectionDecision {
  host: string;
  path: string;
  status: ProtectionStatus;
  /**
   * The dependent issues and their states exactly as `resourceViews()`
   * reported them, so a decision can be inspected without re-deriving it.
   */
  issues: ResourceDependencyView[];
}

export interface VerifiedCollectionSnapshot {
  verified: true;
  host: string;
  boardId: string;
  /** The board revision this decision was made from. */
  head: string;
  /**
   * Every resource the verified revision registers, on every host, so a path
   * another host registered is distinguishable from a path nobody registered.
   * Only decisions on `host` are this collector's to act on.
   */
  decisions: ProtectionDecision[];
  failure: null;
}

export interface UnverifiedCollectionSnapshot {
  verified: false;
  host: string;
  boardId: null;
  head: null;
  /** No decision may be derived from failed board state, so there are none. */
  decisions: readonly [];
  failure: CollectionFailure;
}

/**
 * A snapshot is a discriminated union on `verified`, so a snapshot that says
 * a path is collectible is unrepresentable unless it was built from a verified
 * board revision.
 */
export type CollectionSnapshot = VerifiedCollectionSnapshot | UnverifiedCollectionSnapshot;

export interface ProtectionVerdict {
  host: string;
  path: string;
  status: ProtectionStatus;
  issues: ResourceDependencyView[];
  /**
   * Why the answer is what it is: the canonical rule applied to a verified
   * snapshot, or the snapshot declining to answer.
   */
  basis:
    | 'snapshot-verified'
    | 'snapshot-unverified'
    | 'not-registered'
    | 'other-host';
}

function decisionFromView(view: ResourceView): ProtectionDecision {
  return {
    host: view.host,
    path: view.path,
    status: view.protected ? 'protected' : 'collectible',
    issues: view.issues.map((dependency) => ({ ...dependency })),
  };
}

/**
 * The only constructor of a snapshot that claims anything, and it is
 * module-private: `readCollectionSnapshot` is the sole public way to obtain a
 * verified snapshot, so a caller cannot mint one and choose its `boardId` or
 * revision. It requires a `VerifiedBoardRead`, which the board store produces
 * only after replaying and verifying the signed log, so no snapshot can be built
 * from state that was merely fetched. The board is put back through the
 * canonical parser before any decision is derived from it, so a resource
 * registered against an issue that does not exist, or against no issue at all,
 * cannot be decided here: it is rejected as unverified state instead of read as
 * a collectible path.
 */
function collectionSnapshot(read: VerifiedBoardRead, host: string): VerifiedCollectionSnapshot {
  const scoped = canonicalHost(host);
  return {
    verified: true,
    host: scoped,
    boardId: read.boardId,
    head: read.state.head,
    decisions: resourceViews(parseBoard(read.state.board)).map(decisionFromView),
    failure: null,
  };
}

export function unverifiedCollectionSnapshot(
  host: string,
  failure: CollectionFailure,
): UnverifiedCollectionSnapshot {
  return {
    verified: false,
    host: canonicalHost(host),
    boardId: null,
    head: null,
    decisions: [],
    failure,
  };
}

/**
 * Every failure mode is fail-closed, so the classification only has to be
 * honest about which kind of failure it was, for the operator reading it.
 */
function failureKind(error: unknown): CollectionFailureKind {
  if (error instanceof BoardMissingError) return 'board-missing';
  if (error instanceof BoardTrustRequiredError || error instanceof BoardDeletedError) {
    return 'board-unverifiable';
  }
  if (error instanceof OperationLogVerificationError || error instanceof SignedBoardStoreError) {
    return 'board-state-rejected';
  }
  return 'board-read-failed';
}

/**
 * Reads the board and turns the result into a snapshot. Every failure of the
 * read -- a missing board, a board this client cannot verify, a log that no
 * longer validates, a transport error, or a read that returns something other
 * than verified state -- becomes one unverified snapshot rather than an error.
 * An unreadable board must leave every path protected rather than abort a
 * sweep or, worse, be treated as an empty registry.
 */
export async function readCollectionSnapshot(
  host: string,
  read: CollectionReader,
): Promise<CollectionSnapshot> {
  const scoped = canonicalHost(host);
  let value: VerifiedBoardRead;
  try {
    value = await read();
  } catch (error) {
    return unverifiedCollectionSnapshot(scoped, {
      kind: failureKind(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  // A reader that is not the board store can return anything at all, so the
  // shape that carries the board identity and the revision is checked before
  // the state is handed to the canonical parser.
  if (value === null
      || typeof value !== 'object'
      || typeof value.boardId !== 'string'
      || value.boardId.length === 0
      || typeof value.state?.head !== 'string') {
    return unverifiedCollectionSnapshot(scoped, {
      kind: 'board-state-rejected',
      message: 'Board read did not return verified board state',
    });
  }
  try {
    return collectionSnapshot({ boardId: value.boardId, state: value.state }, scoped);
  } catch (error) {
    return unverifiedCollectionSnapshot(scoped, {
      kind: 'board-state-rejected',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The answer for one path on this host, always `protected` or `collectible`.
 * A path this host's collector may not act on is protected: a path the snapshot
 * says nothing about is protected, and so is a path another host registered,
 * because absence of a decision is never an authorization to delete.
 */
export function protectionOf(snapshot: CollectionSnapshot, path: string): ProtectionVerdict {
  const target = canonicalPath(path);
  const decision = snapshot.verified
    ? snapshot.decisions.find((entry) => entry.path === target)
    : undefined;
  if (decision === undefined) {
    return {
      host: snapshot.host,
      path: target,
      status: 'protected',
      issues: [],
      basis: snapshot.verified ? 'not-registered' : 'snapshot-unverified',
    };
  }
  if (decision.host !== snapshot.host) {
    return {
      host: decision.host,
      path: decision.path,
      status: 'protected',
      issues: decision.issues,
      basis: 'other-host',
    };
  }
  return {
    host: decision.host,
    path: decision.path,
    status: decision.status,
    issues: decision.issues,
    basis: 'snapshot-verified',
  };
}

/**
 * The registered paths on this host that owe nothing to any open issue. Empty
 * for an unverified snapshot, because an unreadable board decides nothing.
 */
export function collectiblePaths(snapshot: CollectionSnapshot): string[] {
  if (!snapshot.verified) return [];
  return snapshot.decisions
    .filter((decision) => decision.host === snapshot.host && decision.status === 'collectible')
    .map((decision) => decision.path);
}

/**
 * A claim is the first state of the re-check protocol. It exists only for a
 * path one verified snapshot called collectible, and it pins the exact board
 * revision that said so, so a later read can be held against it.
 */
export interface CollectionClaim {
  state: 'claimed';
  host: string;
  path: string;
  boardId: string;
  snapshotHead: string;
}

/**
 * Claims a path for deletion. A protected path, a path another host owns, and
 * every path under an unverified snapshot have no claim to open, so a
 * "collectible" label cannot reach a destructive action without a verified
 * board revision behind it.
 */
export function openCollectionClaim(snapshot: CollectionSnapshot, path: string): CollectionClaim {
  const verdict = protectionOf(snapshot, path);
  if (!snapshot.verified || verdict.status !== 'collectible') {
    throw new Error(
      `Refusing to claim ${verdict.path} for collection: it is ${verdict.status} (${verdict.basis})`,
    );
  }
  return {
    state: 'claimed',
    host: snapshot.host,
    path: verdict.path,
    boardId: snapshot.boardId,
    snapshotHead: snapshot.head,
  };
}

export interface CollectionResolution {
  outcome: 'collect' | 'withheld';
  reason:
    | 'still-collectible'
    | 'became-protected'
    | 'unregistered'
    | 'board-unverifiable'
    | 'wrong-board';
  host: string;
  path: string;
  /** The revision the resolution was made from, or `null` when unreadable. */
  recheckHead: string | null;
  status: ProtectionStatus;
}

/** Module-private: not exported, so no caller can construct a seal. */
const authorizationSeal: unique symbol = Symbol('antonina.collection.authorization');

/**
 * The second state: an authorization produced only by a completed re-check
 * against an authoritative read. It is what a caller may hand to the
 * destructive step, and it can be spent exactly once.
 *
 * The `[authorizationSeal]` key is module-private, so no caller can construct
 * one of these: the only way to obtain an authorization is a completed re-check.
 */
export interface AuthorizedCollection {
  readonly [authorizationSeal]: true;
  state: 'authorized';
  outcome: 'collect' | 'withheld';
  reason: CollectionResolution['reason'];
  host: string;
  path: string;
  boardId: string;
  snapshotHead: string;
  recheckHead: string | null;
  status: ProtectionStatus;
}


/**
 * The authorizations this process has issued and not yet committed. Membership
 * is what makes a record a live authorization, so neither a hand-built
 * look-alike nor a copy of an issued one is accepted.
 */
const liveAuthorizations = new WeakSet<AuthorizedCollection>();

/**
 * The moment immediately before the destructive action, as a protocol and not
 * as a comment:
 *
 * 1. The caller holds a claim naming the path, its host, and the board
 *    revision that called the path collectible.
 * 2. The caller must re-verify that exact path against a fresh authoritative
 *    read of the same board: a new `readCollectionSnapshot` over a new
 *    `CollectionReader`, never the snapshot the claim came from and never a
 *    local copy of the board.
 * 3. The re-check authorizes deletion only if the fresh verified state still
 *    calls the path collectible. Every disagreement withholds: the path is
 *    protected now, the path is no longer registered at all, the board cannot
 *    be read or verified, or the read came back from a different board.
 * 4. A re-check that cannot be completed is a `withheld`, never a retry with
 *    the stale snapshot. There is no third option.
 *
 * The residual window is the interval between the completed re-check read and
 * the destructive step itself. The signed board log is append-only with no
 * compare-and-delete or lease primitive, so this protocol can only promise
 * that the path was unowed at the last authoritative read, and the integrating
 * collector must keep that interval as small as it can make it.
 */
export async function recheckCollectionClaim(
  claim: CollectionClaim,
  read: CollectionReader,
): Promise<AuthorizedCollection> {
  const snapshot = await readCollectionSnapshot(claim.host, read);
  const issue = (
    outcome: AuthorizedCollection['outcome'],
    reason: CollectionResolution['reason'],
    status: ProtectionStatus,
    head: string | null,
  ): AuthorizedCollection => {
    const authorization: AuthorizedCollection = {
      [authorizationSeal]: true,
      state: 'authorized',
      outcome,
      reason,
      host: claim.host,
      path: claim.path,
      boardId: claim.boardId,
      snapshotHead: claim.snapshotHead,
      recheckHead: head,
      status,
    };
    liveAuthorizations.add(authorization);
    return authorization;
  };

  if (!snapshot.verified) return issue('withheld', 'board-unverifiable', 'protected', null);
  if (snapshot.boardId !== claim.boardId) {
    return issue('withheld', 'wrong-board', 'protected', snapshot.head);
  }

  const verdict = protectionOf(snapshot, claim.path);
  if (verdict.status !== 'collectible') {
    return issue(
      'withheld',
      verdict.basis === 'not-registered' ? 'unregistered' : 'became-protected',
      verdict.status,
      snapshot.head,
    );
  }
  return issue('collect', 'still-collectible', 'collectible', snapshot.head);
}

/** The terminal state: what a caller actually did with an authorization. */
export interface CompletedCollection {
  state: 'spent';
  outcome: 'collect' | 'withheld';
  reason: CollectionResolution['reason'];
  host: string;
  path: string;
  recheckHead: string | null;
}

/**
 * An authorization is accepted only while it is the live record this process
 * issued for a completed re-check, and committing it consumes it: one
 * completed re-check can authorize at most one destructive action, and a copy
 * of the record is not that authorization. A withheld authorization reports
 * `withheld`, and the caller leaves the path alone.
 */
export function commitCollectionDeletion(authorized: AuthorizedCollection): CompletedCollection {
  if (!liveAuthorizations.has(authorized)) {
    throw new Error(
      `Collection authorization for ${authorized.path} is not a live authorization: `
      + 'it was already committed, or it was not issued by a completed re-check',
    );
  }
  liveAuthorizations.delete(authorized);
  return {
    state: 'spent',
    outcome: authorized.outcome,
    reason: authorized.reason,
    host: authorized.host,
    path: authorized.path,
    recheckHead: authorized.recheckHead,
  };
}
