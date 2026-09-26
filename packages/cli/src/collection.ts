import { rm as rmCall, unlink as unlinkCall } from 'node:fs/promises';

import { AntoninaApiError, type BoardApi } from '../../core/src/api.js';
import {
  boardApiCollectionReader,
  collectiblePaths,
  commitCollectionDeletion,
  openCollectionClaim,
  protectionOf,
  readCollectionSnapshot,
  recheckCollectionClaim,
  removeAuthorizedPath as coreRemoveAuthorizedPath,
  type AuthorizedCollection,
  type AuthorizedRemoval,
  type AuthorizedRemovalFs,
  type CollectionFailureKind,
  type CollectionOutcomeReason,
  type CollectionSnapshot,
  type CompletedCollection,
} from '../../core/src/collection.js';
// The node-side gatherer `recheckCollectionClaim` requires. It is the
// implementation core's docstring points at, it is imported rather than
// rewritten, and it is passed through unwrapped: one path in,
// `Promise<CandidatePathFacts | null>` out, which is exactly
// `CandidateFactsGatherer`.
import { gatherCandidatePathFacts } from '../../agent-runtime/src/candidate-facts.js';
// The managed-root loader is not implemented here. It is imported from
// `packages/agent-runtime`, which owns the one `realpath` of a configured root
// and is the package a future non-CLI collector (`agent clean`, whose managed
// root is `agentsDir()`) can also reach. This file owns only what is specific to
// the `collect` commands: the operator-facing rendering of a refusal.
import {
  MANAGED_ROOTS_ENV,
  loadManagedRoots,
  type ManagedRootsConfigDefect,
  type RootsFs,
} from '../../agent-runtime/src/managed-roots-config.js';
import { canonicalHost, pathFormDefect } from '../../core/src/model.js';

/**
 * Why the `collect` commands are refusing, in core's own vocabulary.
 *
 * A board the collector cannot read or cannot verify is reported with the
 * snapshot's own `CollectionFailureKind` and its own message, never as an empty
 * list and never as a flattened reason: an operator reading a transport failure
 * is told the read failed, not that the board was unverifiable. `board.ts` turns
 * `kind` into the same advice every other board command gives.
 */
export class CollectBoardError extends Error {
  constructor(readonly kind: CollectionFailureKind, message: string) {
    super(message);
  }
}

/**
 * A re-check that withheld the authorization, or a claim that could not be
 * opened. `reason` is the `CollectionOutcomeReason` verbatim, and `kind` is the
 * board-state failure inside it when the reason is one, so a board that cannot
 * be read is still advised about as a board that cannot be read.
 */
export class CollectRefusedError extends Error {
  constructor(
    readonly reason: CollectionOutcomeReason,
    message: string,
    readonly kind: CollectionFailureKind | null = null,
  ) {
    super(message);
  }
}

/** A configured root set that cannot be used, reported against its spelling. */
export class CollectRootsError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

const COLLECTION_FAILURE_KINDS: readonly CollectionFailureKind[] = [
  'board-missing',
  'board-unverifiable',
  'board-read-failed',
  'board-state-rejected',
  'host-not-canonical',
];

export function isCollectionFailureKind(reason: string): reason is CollectionFailureKind {
  return COLLECTION_FAILURE_KINDS.includes(reason as CollectionFailureKind);
}

/**
 * The host a collection command is scoped to. It is mandatory and explicit on
 * both subcommands, and it is checked before any board read: a decision can only
 * be scoped to a host that is already canonical, so a value that is not one is a
 * usage error rather than a board failure.
 */
export function requireCollectionHost(host: string | undefined, usage: string): string {
  if (host === undefined) throw new AntoninaApiError(`${usage} requires --host`);
  try {
    return canonicalHost(host);
  } catch {
    throw new AntoninaApiError(
      '--host must be a lubko://<non-empty-server-name> host identity, not ' + JSON.stringify(host),
    );
  }
}

/** The revision a report names, rendered so a null revision is still a value. */
export function renderRevision(head: string | null): string {
  return head === null ? 'rev unavailable' : 'rev ' + head;
}

/**
 * How a defect is rendered to an operator: the loader's own `kind` first, so the
 * vocabulary an operator reads is the vocabulary the judgment used, and the
 * configured spelling after it, so the offending entry is named.
 *
 * The judgment itself is not re-derived here: core's `ManagedRootDefect` members
 * are rendered by their own `kind`, and the loader's own kinds are rendered from
 * the same fields the loader refused on.
 */
export function describeRootsDefect(result: {
  readonly spelling: string | null;
  readonly defect: ManagedRootsConfigDefect;
}): string {
  const { spelling, defect } = result;
  if (defect.kind === 'roots-not-configured') {
    return `roots-not-configured: no managed collection roots are configured in ${defect.variable}; `
      + `set it to a ":"-separated list of absolute directories the collector may remove from`;
  }
  if (defect.kind === 'malformed-root') {
    return `malformed-root: a configured managed root is not a spelled/resolved pair${spelling === null ? '' : ` (${spelling})`}`;
  }
  if (defect.kind === 'path-form') {
    return `path-form: configured managed root ${defect.path} is not a canonical absolute POSIX path (${defect.defect})`;
  }
  if (defect.kind === 'duplicate') {
    return `duplicate: configured managed root ${defect.path} is listed twice`;
  }
  if (defect.kind === 'nested') {
    return `nested: configured managed root ${defect.path} is inside configured managed root ${defect.within}`;
  }
  if (defect.kind === 'root-is-filesystem-root') {
    return `root-is-filesystem-root: configured managed root ${defect.path} is the filesystem root; `
      + 'it would make every absolute path collectible';
  }
  if (defect.kind === 'root-resolves-to-filesystem-root') {
    return `root-resolves-to-filesystem-root: configured managed root ${defect.path} resolves to the `
      + `filesystem root ${defect.resolved}; it would make every absolute path collectible`;
  }
  if (defect.kind === 'unresolvable-root') {
    return `unresolvable-root: ${defect.message}`;
  }
  // Totality over the type, not a live case. `ManagedRootsConfigDefect` carries
  // core's whole `ManagedRootDefect` because core's defect is handed back by
  // identity rather than re-derived, so this function is total over a union that
  // still names `empty`. The loader can never produce it: an absent or
  // separator-only variable is refused above, as `roots-not-configured`, before
  // `validateManagedRoots` is reached, so core is never asked to judge an empty
  // set. It is rendered from the kind it was handed rather than as a second
  // copy of the `roots-not-configured` sentence -- one situation, one wording.
  return `${defect.kind}: the configured managed root set was refused by validation`
    + (spelling === null ? '' : ` (${spelling})`);
}
/**
 * The verified snapshot both subcommands answer from, or the board's own
 * failure.
 *
 * The read is `readCollectionSnapshot` over `boardApiCollectionReader(api)`, the
 * verifying reader, and never a reader hand-built from `loadState()`: the signed
 * log is what makes the revision verified, and only this reader verifies it. An
 * unverified snapshot is reported and the command exits non-zero -- it is never
 * rendered as an empty registry, which is the one answer that would let an
 * unreadable board look like a board with nothing to collect.
 */
async function verifiedSnapshot(
  api: BoardApi,
  host: string,
): Promise<Extract<CollectionSnapshot, { verified: true }>> {
  const snapshot = await readCollectionSnapshot(host, boardApiCollectionReader(api));
  if (!snapshot.verified) throw new CollectBoardError(snapshot.failure.kind, snapshot.failure.message);
  return snapshot;
}

/**
 * One line of `collect list`: a path, the host that owns the decision, and the
 * board and revision the answer came from. The board identity and the revision
 * are read off the *same snapshot object* every decision was derived from, so
 * the printed revision is by construction the revision the printed answers came
 * from.
 */
export interface CollectListEntry {
  host: string;
  path: string;
  boardId: string;
  revision: string;
  /** The closed issues that used to owe this path protection, for the human line. */
  closedDependents: number[];
}

export interface CollectListResult {
  mode: 'collect-list';
  value: CollectListEntry[];
}

/**
 * The dry run: every path on this host that one verified board revision calls
 * collectible, and nothing else.
 *
 * It touches no filesystem, needs no credential, and needs no managed roots: it
 * is the answerable-from-the-board half, deliberately separate from the half that
 * may remove something. That also means it is *not* a promise any of these paths
 * can be removed -- the re-check re-reads the board and the managed roots
 * immediately before a destructive step, and may say no to any of them.
 */
export async function collectList(api: BoardApi, host: string): Promise<CollectListResult> {
  const scoped = requireCollectionHost(host, 'collect list');
  const snapshot = await verifiedSnapshot(api, scoped);
  const value = collectiblePaths(snapshot).map((path) => {
    // The dependent-issue view, for the human line. A collectible path has no
    // open dependent issue by definition; these are the closed ones that used to
    // owe it protection, which is what makes the answer surprising enough to be
    // worth showing.
    const verdict = protectionOf(snapshot, path);
    return {
      host: snapshot.host,
      path: verdict.path,
      boardId: snapshot.boardId,
      revision: snapshot.head,
      closedDependents: verdict.issues.map((issue) => issue.number),
    };
  });
  return { mode: 'collect-list', value };
}

/**
 * How the collector's path-safety side removes an authorized path, and the
 * residual window it sits inside.
 *
 * The removal itself is core's `removeAuthorizedPath`, and this module only binds
 * it to the node filesystem. There is one implementation: the shape of a removal
 * -- `AuthorizedCollection.unlinkFinalComponent`, the explicit instruction that
 * an eligible symlink is unlinked at `path`, never followed, never recursed
 * into -- is decided by the re-check from the facts its own gatherer gathered,
 * and carried on the authorization. This module used to do a second `lstat` of
 * the authorized path and branch on the answer, which added one I/O to the end of
 * the interval the intent record measures and re-derived a safety instruction
 * the re-check had already issued. That `lstat` and its branch are gone, not
 * superseded: there is no fallback and no optional path here.
 *
 * The residual window is real, and this does not close it -- it cannot. It is
 * not bounded by the final component, which the authorization now pins. Between
 * the re-check's facts and the removal, *any* other component can change,
 * including the containing directory: if the directory holding the authorized
 * path is replaced by a symlink, the `rm` below resolves through it and
 * recursively removes a directory outside the managed root, one the re-check
 * never judged at any component. Re-listing the parent immediately before the
 * `rm` would only move the interval, not remove it: there is no
 * compare-and-remove on a path, so every check is a read followed by a window.
 * The signed board log has no compare-and-delete or lease primitive either, so
 * the protocol can only promise the path was unowed at the last authoritative
 * read. This is one named function so it is greppable if core ever grows an
 * `openat`-style handle that would actually close the interval.
 *
 * `rm(..., { recursive: true })` also descends into a mount point inside the
 * candidate: a bind mount, a devcontainer mount, or an sshfs mount under a
 * worktree is removed from the mounted side, which is standard `rm -rf`
 * semantics and not something this narrows.
 */
export type RemovalFs = AuthorizedRemovalFs;

const DEFAULT_REMOVAL_FS: RemovalFs = {
  rm: rmCall,
  unlink: unlinkCall,
};

/**
 * Core's `removeAuthorizedPath`, bound to the node filesystem. This is the whole
 * CLI half: the algorithm -- which of the two calls a removal takes, and what it
 * reports -- is core's and is not written again here.
 */
export async function removeAuthorizedPath(
  authorized: AuthorizedCollection,
  fs: RemovalFs = DEFAULT_REMOVAL_FS,
): Promise<AuthorizedRemoval> {
  return coreRemoveAuthorizedPath(authorized, fs);
}

/**
 * What `collect delete` reports, in both the pending and the completed case, so
 * a script reads one shape.
 *
 * `recheckHead` is the revision this command acted on: the one its own re-check
 * read and verified. `snapshotHead` is the revision the *claim* named, and it is
 * `null` whenever the re-check landed on a different revision -- the normal case
 * when the board advanced in between, not a warning and not a failure. The two
 * key names are distinct on purpose, so a script cannot read `snapshotHead` as
 * authority; only `recheckHead` is one.
 */
export interface CollectDeleteReportBase {
  host: string;
  boardId: string;
  path: string;
  outcome: 'collect' | 'withheld';
  reason: CollectionOutcomeReason;
  recheckHead: string | null;
  snapshotHead: string | null;
}

export interface CollectDeleteReport extends CollectDeleteReportBase {
  /**
   * Which of `removeAuthorizedPath`'s three results the command is reporting: the
   * path itself was removed, a symlink was unlinked as a link, or the path was
   * already absent and nothing was removed. It is absent from the pending
   * report, where no removal has been attempted.
   */
  readonly removal: AuthorizedRemoval;
}

export type CollectDeleteResult = {
  mode: 'collect-pending';
  value: CollectDeleteReportBase;
} | {
  mode: 'collect-deleted';
  value: CollectDeleteReport;
};

export interface CollectDeleteOptions {
  host: string;
  path: string;
  confirm: boolean;
  env: Record<string, string | undefined>;
  rootsFs?: RootsFs;
  removalFs?: RemovalFs;
  /**
   * The spender, overridable only so a test can see the completion record that
   * lives behind a module-private door. It is core's `commitCollectionDeletion`
   * in every real call, and nothing here re-implements, wraps or relaxes it.
   */
  commit?: CollectionCommit;
}

/**
 * What spends an authorization. Core's `commitCollectionDeletion` is the only
 * spender, and this is its type, not a second one.
 */
export type CollectionCommit = (authorized: AuthorizedCollection) => CompletedCollection;

/**
 * The destructive half, in this order and no other: configured roots, then a
 * fresh verified snapshot, then a claim, then a re-check, then the confirmation
 * gate, then the removal, then the commit.
 *
 * Each step is fail-closed at its own boundary. An unusable root set is reported
 * before any board read, so a misconfigured collector never learns what the board
 * says. A claim cannot be opened for a protected, foreign, unregistered or
 * non-canonical path. The re-check is core's, with the real node-side gatherer as
 * its required fourth argument: the gatherer is asked about `claim.path` and
 * nothing else, and the re-check builds its own verifying read, so the CLI
 * supplies no reader and no board state of its own. A withheld outcome touches
 * nothing and spends nothing.
 *
 * Without `--confirm` the command stops after a *real* re-check and reports the
 * pending action. The claim is simply dropped; the gate is not a cached verdict
 * re-used at confirmation time, so a path that stopped being collectible in
 * between is refused rather than deleted.
 */
export async function collectDelete(
  api: BoardApi,
  options: CollectDeleteOptions,
): Promise<CollectDeleteResult> {
  const host = requireCollectionHost(options.host, 'collect delete');

  // 1. Managed roots. A configuration error is reported verbatim and nothing is
  //    read from the board.
  const managed = options.rootsFs === undefined
    ? await loadManagedRoots(options.env)
    : await loadManagedRoots(options.env, MANAGED_ROOTS_ENV, options.rootsFs);
  if (!managed.ok) throw new CollectRootsError(describeRootsDefect(managed));

  // A path that is not canonical is a usage error, refused before the board is
  // read: it could not be located in the registry, so no decision about it
  // exists.
  const candidate = options.path.trim();
  const formDefect = pathFormDefect(candidate);
  if (formDefect !== null) {
    throw new AntoninaApiError(
      `collect delete requires a canonical absolute POSIX path, not ${JSON.stringify(options.path)} (${formDefect})`,
    );
  }

  // 2. A fresh verified snapshot for the host.
  const snapshot = await verifiedSnapshot(api, host);

  // 3. The claim, which pins the revision that called the path collectible.
  let claim;
  try {
    claim = openCollectionClaim(snapshot, candidate);
  } catch {
    // The message below restates the claim's own refusal -- the same path, the
    // same status, the same basis -- with the classified reason named, so the
    // operator reads one line in core's vocabulary instead of a stack.
    const verdict = protectionOf(snapshot, candidate);
    // The claim's own refusal, classified from the basis it was refused for. A
    // path another host registered is reported as a different board, a path no
    // host registered as unregistered, and a path this host still owes
    // protection to as became-protected.
    const reason: CollectionOutcomeReason = verdict.basis === 'other-host'
      ? 'wrong-board'
      : verdict.basis === 'not-registered'
        ? 'unregistered'
        : 'became-protected';
    throw new CollectRefusedError(
      reason,
      `refusing to claim ${verdict.path} for collection: ${reason} (${verdict.status}, ${verdict.basis})`,
    );
  }

  // 4. The re-check: four arguments, the last of them the node-side gatherer
  //    `recheckCollectionClaim` requires. It is core's own function, unwrapped.
  const authorized = await recheckCollectionClaim(
    claim,
    api,
    managed.roots,
    gatherCandidatePathFacts,
  );

  const report: CollectDeleteReportBase = {
    host: authorized.host,
    boardId: authorized.boardId,
    path: authorized.path,
    outcome: authorized.outcome,
    reason: authorized.reason,
    recheckHead: authorized.recheckHead,
    snapshotHead: authorized.snapshotHead,
  };

  // 5. Anything but `collect` is a refusal: printed verbatim, with board-state
  //    advice when the reason is a board-state failure, and nothing touched.
  if (authorized.outcome !== 'collect') {
    throw new CollectRefusedError(
      authorized.reason,
      `refusing to collect ${authorized.path} on ${authorized.host}: ${authorized.reason}`,
      isCollectionFailureKind(authorized.reason) ? authorized.reason : null,
    );
  }

  // 6. The confirmation gate. Everything above has already happened for real.
  if (!options.confirm) return { mode: 'collect-pending', value: report };

  // 7. The removal, at the board-recorded spelling and in the shape the re-check
  //    authorized. The authorization names one path and the CLI acts on that path
  //    and no other; it observes nothing about the path to work out how to remove
  //    it, because the re-check already decided that. The removal takes the path
  //    and the shape from core's module-private record of the issue rather than
  //    from this object, so anything written onto the authorization between the
  //    re-check and here is refused before the filesystem is reached -- there is
  //    no step at which a re-pointed shape is acted on and caught afterwards.
  // 8. The authorization is spent exactly once, and the spend belongs to *this*
  //    step: `removeAndCommit` below commits on the error path too, because a
  //    `rm` that takes a prefix of the tree and then fails has already performed
  //    a removal that no re-run will undo, and an uncommitted one is a second
  //    removal waiting to happen from the same re-check.
  const removal = await removeAndCommit(
    authorized,
    options.removalFs ?? DEFAULT_REMOVAL_FS,
    options.commit ?? commitCollectionDeletion,
  );
  return { mode: 'collect-deleted', value: { ...report, removal } };
}

/**
 * One removal followed by the one completion record it is owed, on the error path
 * as well as the success path.
 *
 * The obligation is asymmetric on purpose: a removal that was *not* performed
 * owes nothing, and a removal that was performed -- even one that failed half way
 * through, leaving the tree partly gone and no way back -- owes exactly one
 * commit. So the commit rides a `finally` over the removal, and it is armed by the
 * filesystem being reached at all, not by the removal succeeding. `rm --recursive`
 * deletes as it descends, so a failure part way down has already destroyed
 * something; the boolean is set *before* the call, because "the call was made" is
 * the point at which the promise is owed, and the failure being on its way out of
 * the call says nothing about how much of the tree is already gone.
 *
 * The commit cannot displace the failure it was owed for. Inside a `finally` a
 * throwing commit would otherwise replace a real removal error with a bookkeeping
 * one, and the operator would be told about the wrong failure entirely; so when
 * the removal threw, the commit's own failure is swallowed and the removal's error
 * propagates untouched -- the same object, so the same kind and the same message.
 * When the removal succeeded there is no real failure to protect, and a commit
 * that cannot be written is itself the failure worth reporting, so it propagates.
 *
 * Nothing here relaxes core's single-use guarantee: the spender is core's
 * `commitCollectionDeletion`, called once with the authorization the re-check
 * issued, and the refusal and the un-confirmed pending path never arrive here at
 * all -- the commit belongs to the removal step, not to the function.
 */
export async function removeAndCommit(
  authorized: AuthorizedCollection,
  removalFs: RemovalFs,
  commit: CollectionCommit = commitCollectionDeletion,
): Promise<AuthorizedRemoval> {
  let reached = false;
  const observed: RemovalFs = {
    rm: async (path, options) => {
      reached = true;
      return removalFs.rm(path, options);
    },
    unlink: async (path) => {
      reached = true;
      return removalFs.unlink(path);
    },
  };
  let removal: AuthorizedRemoval;
  try {
    removal = await coreRemoveAuthorizedPath(authorized, observed);
  } catch (error) {
    if (reached) {
      try {
        commit(authorized);
      } catch {
        // Swallowed on purpose: the caller is told about the removal failure,
        // which is the one that describes what happened on disk.
      }
    }
    throw error;
  }
  if (reached) commit(authorized);
  return removal;
}
