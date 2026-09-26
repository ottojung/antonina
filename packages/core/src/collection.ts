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
import {
  evaluateManagedCandidate,
  type CandidatePathFacts,
  type ManagedCollectionRoot,
  type ManagedPathRefusal,
  type ManagedRoots,
} from './managed-roots.js';

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
 *
 * What makes a revision *verified* is the read itself, not this module: only
 * the reader `boardApiCollectionReader` builds over a `BoardApi` verifies the
 * signed log. All this module does with a revision is put it back through the
 * canonical parser, so it can refuse state that is not a well-formed board.
 *
 * A snapshot may be read through any `CollectionReader`, so a snapshot is only
 * ever as trustworthy as the reader behind it. The destructive path is not: the
 * re-check builds its own verifying reader from a `BoardApi`, and it obtains the
 * candidate's filesystem facts through a required facts gatherer it calls with
 * `claim.path` and nothing else, and it refuses any facts that name another
 * path, so `outcome: 'collect'` cannot be minted from a hand-built state or
 * from facts about some path other than the one deleted.
 *
 * This module performs no filesystem I/O of its own. The gatherer is the
 * path-safety front's job, and `CandidatePathFacts` in `managed-roots.ts` is the
 * recipe for it; `packages/agent-runtime` holds the node-side implementation.
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
  | 'board-state-rejected'
  | 'host-not-canonical';

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
   * snapshot, the snapshot declining to answer, or an input this module refuses
   * to canonicalise.
   */
  basis:
    | 'snapshot-verified'
    | 'snapshot-unverified'
    | 'not-registered'
    | 'other-host'
    | 'path-not-canonical';
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
 * The host a decision is scoped to, without ever throwing. A host that is not
 * already canonical is not a host this module can scope a decision to, so the
 * answer is "not canonical" rather than an exception: a single malformed
 * argument must not abort a whole sweep.
 */
function scopedHost(host: string): { host: string; canonical: boolean } {
  try {
    return { host: canonicalHost(host), canonical: true };
  } catch {
    return { host: host.trim(), canonical: false };
  }
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
 *
 * A deleted board is unverified state here, and this module establishes that
 * invariant itself rather than inheriting it from `BoardApi` refusing to serve a
 * deleted board. `boardApiCollectionReader` never sees a deleted board, but a
 * `CollectionReader` can be anything, and a reader that handed back the last
 * pre-deletion revision's resources would otherwise produce a verified snapshot
 * full of collectible paths for a board that no longer exists.
 */
function collectionSnapshot(read: VerifiedBoardRead, host: string): CollectionSnapshot {
  const scoped = canonicalHost(host);
  if (read.state.deleted === true) {
    return unverifiedCollectionSnapshot(scoped, {
      kind: 'board-unverifiable',
      message: `Board ${read.boardId} is deleted, so it protects nothing and collects nothing`,
    });
  }
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
    host: scopedHost(host).host,
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
 * longer validates, a transport error, a read that returns something other
 * than verified state, a deleted board, or a host that is not already canonical
 * -- becomes one unverified snapshot rather than an error. An unreadable board
 * must leave every path protected rather than abort a sweep or, worse, be
 * treated as an empty registry.
 */
export async function readCollectionSnapshot(
  host: string,
  read: CollectionReader,
): Promise<CollectionSnapshot> {
  const scoping = scopedHost(host);
  if (!scoping.canonical) {
    return unverifiedCollectionSnapshot(host, {
      kind: 'host-not-canonical',
      message: 'Host must be lubko://<non-empty-server-name> before a decision can be scoped to it',
    });
  }
  const scoped = scoping.host;
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
 * says nothing about is protected, a path another host registered is protected
 * because absence of a decision is never an authorization to delete, and so is
 * a path that is not already canonical. That last one is fail-closed rather than
 * loud: a malformed candidate in a sweep must not take the whole sweep with it,
 * and a path this module cannot canonicalise is not a path it can locate in the
 * registry, so it decides nothing.
 */
export function protectionOf(snapshot: CollectionSnapshot, path: string): ProtectionVerdict {
  let target: string;
  try {
    target = canonicalPath(path);
  } catch {
    return {
      host: snapshot.host,
      path,
      status: 'protected',
      issues: [],
      basis: 'path-not-canonical',
    };
  }
  // A resource is identified by the `(host, path)` pair, not by `path` alone, so
  // this host's decision has to win over any other host's decision for the same
  // path. Looking up by path alone would let a foreign host's decision that
  // merely sorts first answer for a path this host also registered.
  const own = snapshot.verified
    ? snapshot.decisions.find((entry) => entry.host === snapshot.host && entry.path === target)
    : undefined;
  const foreign = own !== undefined || !snapshot.verified
    ? undefined
    : snapshot.decisions.find((entry) => entry.path === target);
  const decision = own ?? foreign;
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
 *
 * A claim is advisory: it is evidence of a past verdict, not the authority for
 * a destructive action. `recheckCollectionClaim` re-derives the board identity,
 * the path, and the protection status of the path from its own fresh
 * authoritative read, and it gathers the path's own filesystem facts -- asking
 * only about `path`, and refusing facts that name another path -- so a
 * hand-built claim can produce at most a `withheld` authorization, or one the
 * board actually supports.
 *
 * `host` and `path` are the caller's to fill in but are not trusted as
 * authority: `boardId` is compared against the board the re-check read, and the
 * protection answer is derived for `path` by that read. `snapshotHead` is not
 * authority either: it is a claim's own assertion, and a forged claim may name
 * any revision at all, so it is never re-derived into an answer on its own. The
 * re-check does compare it, but only to decide what to *report*: the claim's
 * revision is carried as `AuthorizedCollection.snapshotHead` exactly when the
 * revision the re-check itself read matches it, so an authorization never
 * asserts a revision this module did not verify.
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

/**
 * Why a re-check produced the outcome it did.
 *
 * An unverified snapshot contributes its own `CollectionFailureKind` rather than
 * one flattened reason, so a transport failure is reported to the operator as
 * `board-read-failed` and not as the `board-unverifiable` a different failure
 * would produce. Every member below is produced by exactly one branch.
 */
export type CollectionOutcomeReason =
  | 'still-collectible'
  | 'became-protected'
  | 'unregistered'
  | 'wrong-board'
  /**
   * The candidate is a configured managed root, so the roots that define it do
   * not authorise its removal.
   */
  | 'candidate-is-managed-root'
  /**
   * The candidate is canonical but lies in no configured managed root, so no
   * configured root authorises its removal.
   */
  | 'outside-managed-roots'
  /**
   * The candidate is inside a configured root but that root does not authorise
   * this particular path. The specific refusal is reported by the path-safety
   * front; here it is only ever a withheld outcome.
   */
  | 'not-managed-collectible'
  /**
   * The candidate's own filesystem facts were either not gathered at all -- the
   * gatherer answered `null`, meaning the path or the directory containing it
   * does not exist, or cannot be resolved -- or refused because they name a
   * path other than the one asked about, so in both cases no managed-root
   * judgment of the claimed path was possible. The gatherer was asked for
   * `claim.path` and only `claim.path`.
   */
  | 'candidate-facts-unavailable'
  /**
   * The re-check's own read of the board did not produce a verified snapshot,
   * for any of the reasons a snapshot classifies.
   */
  | CollectionFailureKind;

/**
 * The managed-root judgment as a re-check reason. The two refusals that name a
 * configured root -- the root itself, and a path no root contains -- are
 * reported under their own names, because they are the two cases a board could
 * otherwise authorise on its own authority. Everything else is a path-safety
 * detail and is reported as one reason.
 *
 * This is only ever handed a real `ManagedPathRefusal` from a judgment about
 * `claim.path`, so there is no case here for a candidate that is inside a
 * managed root but is not the claimed path: the facts are gathered for
 * `claim.path`, so a differently spelled candidate is not expressible.
 */
function managedReason(refusal: ManagedPathRefusal): CollectionOutcomeReason {
  if (refusal === 'candidate-is-managed-root') return 'candidate-is-managed-root';
  if (refusal === 'outside-managed-roots') return 'outside-managed-roots';
  return 'not-managed-collectible';
}

/**
 * How the collector's path-safety side answers a re-check's question about one
 * path: the `CandidatePathFacts` for that path, or `null` when they cannot be
 * obtained. A required input, with no default and no fallback, so a re-check can
 * never skip the question.
 */
export type CandidateFactsGatherer = (path: string) => Promise<CandidatePathFacts | null>;

/** Module-private: not exported, so no caller can construct a seal. */
const authorizationSeal: unique symbol = Symbol('antonina.collection.authorization');

/**
 * The fields every authorization carries, whichever way it came out.
 *
 * The `[authorizationSeal]` key is module-private, so no caller can construct
 * one of these: the only way to obtain an authorization is a completed re-check.
 *
 * Every carried field is `readonly`. That is the type-level half of the
 * guarantee, and it stops a caller from re-pointing an authorization in
 * TypeScript. It is not the guarantee itself: a `readonly` field is still an
 * ordinary writable property at runtime, so the runtime half is
 * `issuedAuthorizations` below, which records what this module handed out and
 * is what the commit function compares against.
 */
interface AuthorizationCommon {
  readonly [authorizationSeal]: true;
  readonly state: 'authorized';
  readonly reason: CollectionOutcomeReason;
  readonly host: string;
  /**
   * The path this authorization is about. It is the claim's own path, and the
   * re-check asks its gatherer about that path alone and refuses facts naming any
   * other, so on a `collect` authorization it is also the eligible candidate's
   * own `path` -- the same value the managed-root judgment returned. It is
   * therefore carried once, here, and the removal shape below does not repeat
   * it.
   */
  readonly path: string;
  readonly boardId: string;
  /**
   * The revision the claim named, but only when the re-check's own read landed on
   * that revision. `null` otherwise, so this field never carries a revision the
   * re-check did not verify.
   */
  readonly snapshotHead: string | null;
  readonly recheckHead: string | null;
  readonly status: ProtectionStatus;
}

/**
 * A re-check that authorized a removal, carrying the shape the removal must take.
 *
 * The managed-root judgment is made from the candidate's own filesystem facts --
 * the required gatherer `lstat`s the candidate and `evaluateManagedCandidate`
 * turns that into this instruction. The re-check already holds the result, so
 * carrying it here is what lets the destructive step act with *no* filesystem
 * observation of its own: a second `lstat` at that point would widen the
 * residual window the record measures, by an I/O the collector chose to add, for
 * a value it could have been handed.
 *
 * These two fields exist on no other variant. A `withheld` authorization has
 * none of them, so "no removal shape was ever authorized" is representable and a
 * collector cannot read `unlinkFinalComponent: false` off a refusal.
 */
export interface AuthorizedCollect extends AuthorizationCommon {
  readonly outcome: 'collect';
  /**
   * The configured managed root whose judgment authorized this path. Carried so a
   * caller can report which configured root it acted under without re-deriving
   * it, and so the removal is taken as the same root the judgment named.
   */
  readonly root: ManagedCollectionRoot;
  /**
   * Whether the final component of the authorized path is itself a symlink, as
   * the re-check's gatherer observed it. An eligible symlink is unlinked as a
   * link, never followed and never recursed into.
   */
  readonly unlinkFinalComponent: boolean;
}

/** A re-check that refused. It authorizes no removal and carries no removal shape. */
export interface AuthorizedWithheld extends AuthorizationCommon {
  readonly outcome: 'withheld';
}

/**
 * The second state: an authorization produced only by a completed re-check
 * against an authoritative read. It is what a caller may hand to the
 * destructive step, and it can be spent exactly once.
 *
 * The `[authorizationSeal]` key is module-private, so no caller can construct
 * one of these: the only way to obtain an authorization is a completed re-check.
 *
 * Every carried field is `readonly`. That is the type-level half of the
 * guarantee, and it stops a caller from re-pointing an authorization in
 * TypeScript. It is not the guarantee itself: a `readonly` field is still an
 * ordinary writable property at runtime, so the runtime half is
 * `issuedAuthorizations` below, which records what this module handed out and
 * is what the commit function compares against.
 *
 * It is a union on `outcome` rather than one interface with optional fields, so
 * the removal shape is not merely `undefined` on a refusal: a caller cannot even
 * name `authorized.root` on a `withheld` value.
 */
export type AuthorizedCollection = AuthorizedCollect | AuthorizedWithheld;

/**
 * The authorizations this process has issued and not yet committed. Membership
 * is what makes a record a live authorization, so neither a hand-built
 * look-alike nor a copy of an issued one is accepted.
 */
const liveAuthorizations = new WeakSet<AuthorizedCollection>();

/**
 * What each issued authorization carried at the moment it was issued, kept
 * module-private beside the `WeakSet` for the same reason: the commit function
 * reads `outcome`, `reason`, `host`, `path` and `recheckHead` back out of the
 * caller's object, and a caller still holds a writable reference to that object.
 * Membership alone therefore answers "did this process issue this?", but not
 * "does it still say what it said?", and an object whose `path` has been
 * re-pointed at a path no re-check ever read is still a live member. This
 * module-private record is the source of truth for the commit, so re-pointing
 * is refused rather than reported.
 *
 * This is a private record, not a brand: nothing here is exported, and no cast
 * or hand-built value can put an entry into it.
 */
const issuedAuthorizations = new WeakMap<AuthorizedCollection, IssuedAuthorization>();

/** The fields of an authorization, as recorded when the re-check issued it. */
type IssuedAuthorization = OmitSeal<AuthorizedCollection>;

/**
 * `Omit` over a union, member by member, so an issued record keeps the same
 * two-variant shape as the authorization it was copied from. `Omit` alone would
 * collapse the union to the fields the members share, and the removal shape --
 * the fields that distinguish them -- would vanish from the type of the very
 * record the commit compares against.
 */
type OmitSeal<T> = T extends unknown ? Omit<T, typeof authorizationSeal> : never;

/**
 * The moment immediately before the destructive action, as a protocol and not
 * as a comment:
 *
 * 1. The caller holds a claim naming the path, its host, and the board
 *    revision that called the path collectible.
 * 2. The caller must re-verify that exact path against a fresh authoritative
 *    read of the same board. The re-check builds that read itself, from the
 *    `BoardApi` it is given, through `boardApiCollectionReader`: a caller cannot
 *    hand the destructive step a reader of its own, so no fabricated state can
 *    reach an authorization. The read is a new one, never the snapshot the claim
 *    came from and never a local copy of the board.
 * 3. The re-check authorizes deletion only if the fresh verified state still
 *    calls the path collectible *and* a configured managed root authorises
 *    removing it, on the strength of filesystem facts the required `gatherFacts`
 *    gathered. Every disagreement withholds: the path is protected now, the path
 *    is no longer registered at all, the board cannot be read or verified, the
 *    read came back from a different board, the facts about the candidate cannot
 *    be gathered, or the managed-root judgment does not find the path
 *    collectible.
 * 4. A re-check that cannot be completed is a `withheld`, never a retry with
 *    the stale snapshot. There is no third option.
 *
 * The managed-root judgment is a required input, not advice. `protectionOf`
 * answers for any board-registered absolute path, so without this step a board
 * could authorise collecting a configured managed root itself, or an absolute
 * path that lies in no managed root at all.
 *
 * `gatherFacts` is a required input for the same reason, and is called with
 * `claim.path` and nothing else. It is a *function*, not facts: a caller cannot
 * hand the destructive step a `CandidatePathFacts` value of its own, and facts
 * naming any path but `claim.path` are refused outright, so a judgment about one
 * path can never stand in for the deletion of another.
 * The only path that can reach `outcome: 'collect'` is the one this re-check
 * named and asked about. A gatherer that returns `null` -- the path or its
 * containing directory could not be read or resolved -- yields a withheld
 * outcome, never an eligible candidate.
 *
 * What the re-check issues is the authority to act on one path, as it read it.
 * It is not a token a caller may re-point afterwards: the fields are `readonly`
 * in the interface, and both `removeAuthorizedPath` and `commitCollectionDeletion`
 * re-derive them from what this function recorded here, so assigning to any of
 * them after the re-check is refused rather than obeyed -- the removal before it
 * touches the filesystem, and the commit after.
 *
 * This module performs no filesystem I/O. `CandidatePathFacts` in
 * `managed-roots.ts` is the recipe a gatherer implements, and the node-side
 * implementation lives with the rest of the collector, in
 * `packages/agent-runtime`.
 *
 * The residual window is the interval between the completed re-check read and
 * the destructive step itself. The signed board log is append-only with no
 * compare-and-delete or lease primitive, so this protocol can only promise
 * that the path was unowed at the last authoritative read, and the integrating
 * collector must keep that interval as small as it can make it.
 *
 * This module shrinks its own end of that window rather than only documenting
 * it. The managed-root judgment needs the candidate's own filesystem facts, and
 * those facts already answer the only question the removal has left -- whether
 * the final component is a symlink -- so the answer is carried on the
 * authorization (`root` and `unlinkFinalComponent`, on the `collect` branch
 * only) and `removeAuthorizedPath` takes it from there. A collector must not
 * re-observe the path before removing it: that would widen the measured
 * interval by an I/O the collector chose to add, and re-derive a safety
 * instruction the re-check had already issued.
 */
export async function recheckCollectionClaim(
  claim: CollectionClaim,
  api: BoardApi,
  managed: ManagedRoots,
  gatherFacts: CandidateFactsGatherer,
): Promise<AuthorizedCollection> {
  const snapshot = await readCollectionSnapshot(claim.host, boardApiCollectionReader(api));
  // Every authorization is recorded the moment it is issued, and the record is
  // what the commit compares against. The two branches build different objects:
  // only a `collect` carries a removal shape, and a `withheld` carries none at
  // all rather than a `false` no collector could act on.
  const issue = (authorization: AuthorizedCollection): AuthorizedCollection => {
    liveAuthorizations.add(authorization);
    issuedAuthorizations.set(authorization, { ...authorization });
    return authorization;
  };
  const withhold = (
    reason: CollectionOutcomeReason,
    status: ProtectionStatus,
    head: string | null,
  ): AuthorizedCollection => issue({
    [authorizationSeal]: true,
    state: 'authorized',
    outcome: 'withheld',
    reason,
    host: claim.host,
    path: claim.path,
    boardId: claim.boardId,
    snapshotHead: head !== null && head === claim.snapshotHead ? head : null,
    recheckHead: head,
    status,
  });

  // The snapshot's own classification is carried through: an operator reading a
  // transport failure is told the read failed, not that the board was
  // unverifiable.
  if (!snapshot.verified) {
    return withhold(snapshot.failure.kind, 'protected', null);
  }
  if (snapshot.boardId !== claim.boardId) {
    return withhold('wrong-board', 'protected', snapshot.head);
  }

  const verdict = protectionOf(snapshot, claim.path);
  if (verdict.status !== 'collectible') {
    return withhold(
      verdict.basis === 'not-registered' ? 'unregistered' : 'became-protected',
      verdict.status,
      snapshot.head,
    );
  }

  // Path safety last, so an unowned or renamed candidate is reported as what it
  // is rather than as a managed-root refusal. The gatherer is asked about
  // `claim.path` and nothing else, so the judgment below is about the very path
  // the board recorded rather than about whatever facts a caller chose to pass.
  // Facts naming any other path are refused here, because a judgment is only
  // ever about the path it was judged from.
  const facts = await gatherFacts(claim.path);
  if (facts === null || facts.path !== claim.path) {
    return withhold('candidate-facts-unavailable', 'protected', snapshot.head);
  }
  const candidatePath = evaluateManagedCandidate(managed, facts);
  if (candidatePath.eligible !== true) {
    return withhold(managedReason(candidatePath.refusal), 'protected', snapshot.head);
  }

  // The removal shape is carried from the very `ManagedPathResult` this branch
  // already holds, so the destructive step takes it as it was authorized and
  // observes nothing. `candidatePath.path` is not repeated: the facts check above
  // refused anything but `claim.path`, so it is `claim.path`, which is carried
  // once as `AuthorizedCollection.path`.
  return issue({
    [authorizationSeal]: true,
    state: 'authorized',
    outcome: 'collect',
    reason: 'still-collectible',
    host: claim.host,
    path: claim.path,
    boardId: claim.boardId,
    snapshotHead: snapshot.head !== null && snapshot.head === claim.snapshotHead
      ? snapshot.head
      : null,
    recheckHead: snapshot.head,
    status: 'collectible',
    root: candidatePath.root,
    unlinkFinalComponent: candidatePath.unlinkFinalComponent,
  });
}

/** The terminal state: what a caller actually did with an authorization. */
export interface CompletedCollection {
  state: 'spent';
  outcome: 'collect' | 'withheld';
  reason: CollectionOutcomeReason;
  host: string;
  path: string;
  recheckHead: string | null;
}

/**
 * An authorization is accepted only while it is the live record this process
 * issued for a completed re-check, and only while it still says what it said
 * when it was issued: every field the commit reads back is compared against the
 * module-private record of the issue, so a caller cannot re-point the authority
 * at another path, host, board, revision, outcome or reason after the re-check
 * has completed. Committing consumes it: one completed re-check can authorize at
 * most one destructive action, and a copy of the record is not that
 * authorization. A withheld authorization reports `withheld`, and the caller
 * leaves the path alone.
 *
 * A refusal over changed fields does not consume the authorization: a caller
 * that wrote to it by mistake can put the re-check's own values back and commit
 * what was actually authorized, and nothing is granted by that, because the
 * values compared against are the ones the re-check recorded.
 *
 * The check is not this function's alone: `removeAuthorizedPath` takes the same
 * record through the same door, so the destructive step refuses a re-pointed
 * authorization before it calls the filesystem, not after.
 */
export function commitCollectionDeletion(authorized: AuthorizedCollection): CompletedCollection {
  const issued = issuedRecordOf(authorized);
  liveAuthorizations.delete(authorized);
  issuedAuthorizations.delete(authorized);
  return {
    state: 'spent',
    outcome: issued.outcome,
    reason: issued.reason,
    host: issued.host,
    path: issued.path,
    recheckHead: issued.recheckHead,
  };
}

/**
 * Every carried field, so a caller-owned edit to any one of them is a mismatch.
 *
 * The comparison is structural rather than a hand-written list of field names,
 * because the list is the trap: a field added to the authorization is recorded
 * here and, if the comparison named its predecessors instead of iterating, never
 * checked. So the key set comes from the issued record itself -- every field the
 * re-check recorded, and only those -- and the caller's key set must match it
 * both in membership and in length, so neither an added field nor a deleted one
 * nor a renamed one passes. The key set is what makes the check automatic: a
 * field added to the authorization later is compared with no edit here.
 *
 * The seal is a module-private symbol, so `Object.keys` leaves it out of this
 * comparison -- and out of the copy `{ ...authorization }` makes of the record --
 * without either place special-casing it, and its own value is not what decides
 * anything: liveness is membership in the process's own `WeakSet`.
 *
 * `root` is compared by identity, not field by field. It is the very frozen
 * object `validateManagedRoots` produced, and `validateManagedRoots` freezes
 * each entry, so its own contents cannot be edited in place; substituting a
 * different, equal-looking root is a mismatch and is refused.
 */
function isUnchanged<T extends object>(authorized: T, issued: T): boolean {
  const carried = Object.keys(issued) as (keyof T & string)[];
  const present = Object.keys(authorized) as (keyof T & string)[];
  if (present.length !== carried.length) return false;
  if (!carried.every((field) => present.includes(field))) return false;
  return carried.every((field) => Object.is(authorized[field], issued[field]));
}

/**
 * The module-private record of what the re-check issued for `authorized`, or a
 * refusal. One door, because two functions consume the record and neither may
 * reach the filesystem or report a completion on the caller's own values.
 *
 * So a caller holding a writable reference to the authorization cannot re-point
 * the authority anywhere: both the commit and the removal read the issued record
 * and refuse a divergent one, which is the whole of the guarantee. The fields are
 * not frozen -- `readonly` in the interface holds no force at runtime -- and this
 * is not a freeze; it is a comparison, and it is made *before* either consumer
 * acts, so a divergent authorization is refused with nothing done rather than
 * refused after the bytes are gone.
 */
function issuedRecordOf(authorized: AuthorizedCollection): IssuedAuthorization {
  const issued = liveAuthorizations.has(authorized)
    ? issuedAuthorizations.get(authorized)
    : undefined;
  if (issued === undefined) {
    throw new Error(
      `Collection authorization for ${authorized.path} is not a live authorization: `
      + 'it was already committed, or it was not issued by a completed re-check',
    );
  }
  if (!isUnchanged(authorized, issued)) {
    throw new Error(
      `Collection authorization for ${authorized.path} was changed after the re-check: `
      + 'an authorization authorizes only the path, host, board, revision, outcome, reason and '
      + 'removal shape the re-check read, and this one no longer carries them',
    );
  }
  return issued;
}

/**
 * The filesystem surface the removal needs, and the only two calls it can make.
 *
 * There is no `lstat` here, and that absence is the point: the shape of the
 * removal was decided by the re-check, from facts its own gatherer gathered, and
 * re-deriving it here would be a second observation of the very path the
 * re-check judged. `packages/core` performs no filesystem I/O, so the real
 * `node:fs/promises` functions are supplied by `packages/agent-runtime` or the
 * CLI; this module only calls what it is handed.
 */
export interface AuthorizedRemovalFs {
  unlink(path: string): Promise<void>;
  /**
   * `recursive` is not a convenience: a worktree is a directory, and a
   * non-recursive removal of one fails with `ENOTEMPTY` -- on exactly the
   * resources collection exists to remove.
   *
   * There is deliberately no `force`, so a path that is already gone fails with
   * `ENOENT` and is reported as `absent` rather than being silently counted as
   * removed.
   */
  rm(path: string, options: { readonly recursive: true }): Promise<void>;
}

/**
 * What a removal did, as `collect delete` reports it.
 *
 * A reportable outcome is only reachable from the issued record, never from the
 * caller's object: the path and the removal shape used here come out of
 * `issuedAuthorizations`, and an authorization whose carried fields have been
 * re-pointed since the re-check is refused before any `unlink` or `rm` call. The
 * fields are not frozen, and this is why that does not matter.
 */
export type AuthorizedRemoval = 'unlinked' | 'unlinked-symlink' | 'absent';

function isAbsent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Removes one authorized path, in the shape the re-check authorized, and takes
 * no filesystem observation of its own.
 *
 * This is the destructive step's half that the re-check made possible, and it is
 * exactly the `lstat`-then-branch the CLI used to do by hand: a final component
 * the gatherer found to be a symlink is unlinked as a link, never followed and
 * never recursed into, and anything else is removed recursively. What moved is
 * the *instruction*, not the algorithm, and there is one implementation of it --
 * the previous `lstat` and its branch are gone, not superseded.
 *
 * The residual window is not closed here; it cannot be. It is, however, not
 * widened by this function: a `lstat` at this point would add one I/O to the end
 * of the interval the record measures, chosen by the collector, for a value the
 * re-check had already computed and handed over.
 *
 * A path that is already gone is `absent`: the goal state already holds. Any
 * other failure throws, so an authorization is never spent on a removal that did
 * not happen. A `withheld` authorization is refused here, before any call.
 *
 * The path and the removal shape are read off the module-private record of the
 * re-check, not off the caller's object, and the same re-pointing comparison the
 * commit makes is made here first. That is the order the guarantee lives in: a
 * caller that writes `unlinkFinalComponent` or `path` after the re-check has
 * nothing to gain, because the refusal lands before `fs.unlink` or `fs.rm` is
 * reached -- the re-check's own values are what would have been used had the
 * caller left the record alone, and a divergent record is not acted on at all.
 * Nothing here freezes anything; a caller may still write to the object, and the
 * write costs it the removal.
 */
export async function removeAuthorizedPath(
  authorized: AuthorizedCollection,
  fs: AuthorizedRemovalFs,
): Promise<AuthorizedRemoval> {
  const issued = issuedRecordOf(authorized);
  if (issued.outcome !== 'collect') {
    throw new Error(
      `Refusing to remove ${issued.path}: this authorization withheld (${issued.reason}), `
      + 'so it carries no removal shape',
    );
  }
  const { path, unlinkFinalComponent } = issued;
  try {
    if (unlinkFinalComponent) {
      await fs.unlink(path);
    } else {
      await fs.rm(path, { recursive: true });
    }
  } catch (error) {
    if (isAbsent(error)) return 'absent';
    throw error;
  }
  return unlinkFinalComponent ? 'unlinked-symlink' : 'unlinked';
}
