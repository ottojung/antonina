import { realpath as realpathCall } from 'node:fs/promises';

import { AntoninaApiError, type BoardApi } from '../../core/src/api.js';
import {
  boardApiCollectionReader,
  collectiblePaths,
  openCollectionClaim,
  protectionOf,
  readCollectionSnapshot,
  type CollectionFailureKind,
  type CollectionOutcomeReason,
  type CollectionSnapshot,
} from '../../core/src/collection.js';
import { validateManagedRoots } from '../../core/src/managed-roots.js';
import type {
  ManagedCollectionRoot,
  ManagedRootDefect,
  ManagedRoots,
} from '../../core/src/managed-roots.js';
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
 * The operator-facing source of the managed collection roots, and the only one.
 *
 * The name sits beside the loader that reads it, and `board.ts` re-exports it
 * with the other `ANTONINA_BOARD_*` names the command surface owns, so the
 * environment block is still where an operator looks for it while there is
 * exactly one copy of the name and no import cycle between the two modules.
 */
export const COLLECT_ROOTS_ENV = 'ANTONINA_COLLECT_ROOTS';

/** The filesystem surface the roots loader needs, injected as `store.ts` does. */
export interface RootsFs {
  realpath: typeof realpathCall;
}

const DEFAULT_ROOTS_FS: RootsFs = { realpath: realpathCall };

/**
 * Why a configured root set cannot be used for collection. The `ManagedRootDefect`
 * members are core's own and are returned verbatim; `unresolvable-root` is the
 * one defect this loader owns, because only it runs `realpath`.
 */
export type CollectRootsDefect =
  | { readonly kind: 'unresolvable-root'; readonly path: string; readonly message: string }
  | ManagedRootDefect;

export type LoadManagedRootsResult =
  | { readonly ok: true; readonly roots: ManagedRoots }
  | {
    readonly ok: false;
    /**
     * The spelling the defect is reported against: the entry that could not be
     * resolved, the path a core defect names, or the first configured spelling.
     * `null` only when nothing was configured at all.
     */
    readonly spelling: string | null;
    readonly defect: CollectRootsDefect;
  };

/**
 * The spellings the environment names, in order.
 *
 * The separator is `:` (a POSIX path list) and empty entries are dropped after
 * trimming, so an unset variable and one that names only separators mean the
 * same thing: no roots configured, which core then reports as `{ kind: 'empty' }`.
 */
export function configuredRootSpellings(
  env: Record<string, string | undefined>,
  name: string = COLLECT_ROOTS_ENV,
): string[] {
  return (env[name] ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function defectSpelling(defect: ManagedRootDefect, spellings: readonly string[]): string | null {
  if ('path' in defect) return defect.path;
  return spellings[0] ?? null;
}

/**
 * Turns the configured spellings into the one `ManagedRoots` value core accepts.
 *
 * `spelled` is configuration and `resolved` is this process's own `realpath` of
 * it, and never anything else: `validateManagedRoots` trusts a caller-supplied
 * `resolved` coordinate without re-deriving it
 * (`packages/core/src/managed-roots.ts:135-138`), so a `resolved` that came from
 * configuration would defeat every containment and symlink guarantee below while
 * still producing a genuine branded `ManagedRoots`. There is no way to configure
 * a resolved coordinate here at all: the value is assigned from the `realpath`
 * below and from nowhere else.
 *
 * A root that cannot be resolved is a configuration error reported against its
 * own spelling, not silently dropped and not repaired -- a repaired root would
 * authorise deletions somewhere other than where the operator named.
 *
 * No `ManagedRoots` is ever built by hand and no brand is cast: a failed
 * validation hands core's own `defect` back verbatim, and the command prints it
 * rather than re-deriving it.
 */
export async function loadManagedRoots(
  env: Record<string, string | undefined>,
  name: string = COLLECT_ROOTS_ENV,
  fs: RootsFs = DEFAULT_ROOTS_FS,
): Promise<LoadManagedRootsResult> {
  const spellings = configuredRootSpellings(env, name);
  const roots: ManagedCollectionRoot[] = [];
  for (const spelling of spellings) {
    // A spelling that is not a canonical absolute path is refused in the same
    // shape, and for the same reason, core refuses it for: it checks both
    // coordinates' form before anything else (`managed-roots.ts:135-138`). The
    // form is checked here, before any I/O, so a relative spelling is never
    // resolved against this process's working directory and reported as some
    // path the operator never configured.
    const defect = pathFormDefect(spelling);
    if (defect !== null) {
      return { ok: false, spelling, defect: { kind: 'path-form', path: spelling, defect } };
    }
    let resolved: string;
    try {
      // The only place a `resolved` coordinate is ever produced in this front.
      resolved = await fs.realpath(spelling);
    } catch (error) {
      return {
        ok: false,
        spelling,
        defect: {
          kind: 'unresolvable-root',
          path: spelling,
          message: `configured managed root ${spelling} cannot be resolved: `
            + (error instanceof Error ? error.message : String(error)),
        },
      };
    }
    roots.push({ spelled: spelling, resolved });
  }

  const validated = validateManagedRoots(roots);
  if (!validated.ok) {
    return { ok: false, spelling: defectSpelling(validated.defect, spellings), defect: validated.defect };
  }
  return { ok: true, roots: validated.roots };
}

/** How a defect is rendered to an operator, in core's own vocabulary. */
export function describeRootsDefect(result: {
  readonly spelling: string | null;
  readonly defect: CollectRootsDefect;
}): string {
  const { spelling, defect } = result;
  const where = spelling === null ? '' : ` (${spelling})`;
  if (defect.kind === 'empty') {
    return `no managed collection roots are configured in ${COLLECT_ROOTS_ENV}; `
      + 'set it to a ":"-separated list of absolute directories the collector may remove from';
  }
  if (defect.kind === 'malformed-root') return `a configured managed root is not a spelled/resolved pair${where}`;
  if (defect.kind === 'path-form') {
    return `configured managed root ${defect.path} is not a canonical absolute POSIX path (${defect.defect})`;
  }
  if (defect.kind === 'duplicate') return `configured managed root ${defect.path} is listed twice`;
  if (defect.kind === 'nested') {
    return `configured managed root ${defect.path} is inside configured managed root ${defect.within}`;
  }
  return defect.message;
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
