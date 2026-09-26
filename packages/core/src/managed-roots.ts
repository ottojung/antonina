import { pathFormDefect, type PathFormDefect } from './model.js';

/**
 * Managed-root path safety.
 *
 * This module owns one question and only that question: given a candidate path a
 * collector wants to remove and the set of explicitly configured managed
 * collection roots, may that path be touched at all? It never reads the board,
 * never asks whether a path is still needed, and never sweeps anything. "Should
 * this path be deleted" belongs to the resource registry; "may it" belongs here.
 *
 * Every decision is a pure function of its arguments, including the filesystem
 * facts about symlinks. This module performs no I/O and calls no `realpath`; see
 * `CandidatePathFacts` for the facts a caller must gather first.
 */

/** A managed collection root: an absolute canonical POSIX path Antonina manages. */
export interface ManagedCollectionRoot {
  readonly path: string;
}

/** Why a configured root set cannot be used for collection at all. */
export type ManagedRootDefect =
  | { readonly kind: 'empty' }
  | { readonly kind: 'path-form'; readonly path: string; readonly defect: PathFormDefect }
  | { readonly kind: 'duplicate'; readonly path: string }
  | { readonly kind: 'nested'; readonly path: string; readonly within: string };

/**
 * A validated, frozen set of managed collection roots. A caller can only hold one
 * by passing `validateManagedRoots`, so an unusable root configuration cannot
 * reach the decision function as if it were usable.
 */
export interface ManagedRoots {
  readonly roots: readonly ManagedCollectionRoot[];
}

export type ManagedRootsResult =
  | { readonly ok: true; readonly roots: ManagedRoots }
  | { readonly ok: false; readonly defect: ManagedRootDefect };

/** Why a candidate path may not be touched. */
export type ManagedPathRefusal =
  /** No managed collection root is configured, so nothing is Antonina's to touch. */
  | 'no-managed-roots'
  /** The candidate is empty, relative, contains `..`, or is otherwise not canonical. */
  | { readonly kind: 'candidate-path-form'; readonly defect: PathFormDefect }
  /** The candidate is canonical but lives in no managed collection root. */
  | 'outside-managed-roots'
  /**
   * The candidate is a configured root itself. A root is what the roots define,
   * not a path one of them may authorise the removal of.
   */
  | 'candidate-is-managed-root'
  /**
   * The candidate is a string prefix extension of a root but not a path
   * extension of it (`/workspace/foobar` against the root `/workspace/foo`).
   * Refused like any other unmanaged path, but named so a caller does not have
   * to re-derive that a plausible-looking name was the reason.
   */
  | 'near-miss-root-prefix'
  /**
   * The candidate's own components resolve, through a symlink, to a path outside
   * its managed root.
   */
  | 'symlink-escapes-managed-root'
  /**
   * The directory containing the candidate resolves, through a symlink, to a
   * directory outside the managed root, so the candidate's location is not the
   * one its name claims even when the candidate's own resolved path looks safe.
   */
  | 'containing-directory-escapes-managed-root';

export type ManagedPathResult =
  | {
      readonly eligible: true;
      /** The canonical path, unchanged. */
      readonly path: string;
      /** The root the candidate was found in. */
      readonly root: ManagedCollectionRoot;
      /**
       * The candidate's resolved path, which may differ from `path` when the
       * candidate is itself a symlink pointing inside the managed root. The
       * caller must remove the resolved path, never the spelled one, unless
       * `finalComponentIsSymlink` says the candidate is the link.
       */
      readonly resolvedPath: string;
      /**
       * Whether the candidate is itself a symlink. An eligible symlink is
       * unlinked, not followed: its target is inside the managed root, but
       * recursing into it is not this decision's permission.
       */
      readonly finalComponentIsSymlink: boolean;
    }
  | { readonly eligible: false; readonly path: string; readonly refusal: ManagedPathRefusal };

/**
 * The filesystem facts a caller must gather for one candidate before asking
 * whether it may be touched. The decision needs symlink knowledge, and a
 * `realpath` call buried inside a decision would make the rule untestable and
 * would hide which fact drove the answer, so the facts are inputs instead.
 *
 * A caller gathers them, for the candidate as the board recorded it, with
 * something like:
 *
 * ```ts
 * const lstat = await fs.lstat(path);
 * const finalComponentIsSymlink = lstat.isSymbolicLink();
 * const parentResolvedPath = await fs.realpath(path.dirname(path));
 * // A path that does not exist yet is a real deletion target, so resolve its
 * // parent and rejoin the final component rather than giving up.
 * const resolvedPath = finalComponentIsSymlink || await pathExists(path)
 *   ? await fs.realpath(path)
 *   : path.join(parentResolvedPath, path.basename(path));
 * ```
 *
 * The decision trusts these facts. It does not re-check them, so a caller that
 * guesses instead of gathering them has opted out of the guarantees below.
 */
export interface CandidatePathFacts {
  /** The candidate path, exactly as the caller intends to name it. */
  readonly path: string;
  /** The path the candidate resolves to, with every symlink in the way followed. */
  readonly resolvedPath: string;
  /** Whether the final component of the candidate is itself a symlink. */
  readonly finalComponentIsSymlink: boolean;
  /** The resolved path of the directory containing the candidate. */
  readonly parentResolvedPath: string;
}

function isWithin(root: string, path: string): boolean {
  if (root === '/') return path.startsWith('/');
  return path === root || path.startsWith(`${root}/`);
}

function isStringPrefix(root: string, path: string): boolean {
  return path.startsWith(root) && path !== root;
}

function defectOfPathForm(defect: PathFormDefect): ManagedPathRefusal {
  return { kind: 'candidate-path-form', defect };
}

/**
 * Validates a set of explicitly configured managed collection roots. A root set
 * is refused when a root is not absolute and canonical, when a root repeats, or
 * when one root sits inside another: nested roots would make "the root this path
 * belongs to" ambiguous, and a collector must not have to guess which configured
 * root authorises a deletion.
 */
export function validateManagedRoots(paths: readonly string[]): ManagedRootsResult {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, defect: { kind: 'empty' } };
  }

  const roots: ManagedCollectionRoot[] = [];
  for (const path of paths) {
    const defect = pathFormDefect(path);
    if (defect !== null) return { ok: false, defect: { kind: 'path-form', path, defect } };
    roots.push(Object.freeze({ path }));
  }

  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.path)) return { ok: false, defect: { kind: 'duplicate', path: root.path } };
    seen.add(root.path);
  }

  for (const root of roots) {
    for (const other of roots) {
      if (root !== other && isWithin(other.path, root.path)) {
        return { ok: false, defect: { kind: 'nested', path: root.path, within: other.path } };
      }
    }
  }

  return { ok: true, roots: Object.freeze({ roots: Object.freeze(roots) }) };
}

function refuse(path: string, refusal: ManagedPathRefusal): ManagedPathResult {
  return { eligible: false, path, refusal };
}

/**
 * Decides whether a candidate path may be touched by a collector, given the
 * validated managed collection roots. `eligible` means only "not refused": it is
 * not a claim that the path is unused, and it never substitutes for the board
 * resource registry.
 */
export function evaluateManagedCandidate(
  roots: ManagedRoots,
  candidate: CandidatePathFacts,
): ManagedPathResult {
  const { path, resolvedPath, finalComponentIsSymlink, parentResolvedPath } = candidate;
  const rootPaths = roots.roots.map((root) => root.path);
  if (rootPaths.length === 0) return refuse(path, 'no-managed-roots');

  const defect = pathFormDefect(path);
  if (defect !== null) return refuse(path, defectOfPathForm(defect));

  const root = rootPaths.find((configured) => isWithin(configured, path));
  if (root === undefined) {
    const nearMiss = rootPaths.find((configured) => isStringPrefix(configured, path));
    return refuse(path, nearMiss === undefined ? 'outside-managed-roots' : 'near-miss-root-prefix');
  }

  // A configured root is not collectible through the roots that define it.
  if (path === root) return refuse(path, 'candidate-is-managed-root');

  // The candidate's own location and the location of the directory holding it
  // must both be inside the same root. Either can escape through a symlink, and
  // only one of the two can be checked from a spelled path alone.
  if (!isWithin(root, parentResolvedPath)) {
    return refuse(path, 'containing-directory-escapes-managed-root');
  }
  // A spelled path that agrees with its resolved path has been checked already.
  // A disagreement means a symlink was crossed: either the final component was
  // one, or a directory above it was, and the resolved path must land back
  // inside the root that authorised the candidate.
  if (resolvedPath !== path && !isWithin(root, resolvedPath)) {
    return refuse(path, 'symlink-escapes-managed-root');
  }

  return {
    eligible: true,
    path,
    root: Object.freeze({ path: root }),
    resolvedPath,
    finalComponentIsSymlink,
  };
}
