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

/**
 * A managed collection root, in both coordinate systems it needs.
 *
 * `spelled` is the path exactly as the host configured it and as the board
 * records paths, so a candidate can be located inside it by name. `resolved` is
 * that same directory after every symlink on the way to it has been followed;
 * containment and escape questions are only answerable here, because a root
 * reached through a symlinked ancestor (`/workspace` -> `/data/work`) shares no
 * prefix with anything a candidate resolves to.
 */
export interface ManagedCollectionRoot {
  /** The canonical absolute path as configured. */
  readonly spelled: string;
  /** The resolved absolute path of the same directory. */
  readonly resolved: string;
}

/** Why a configured root set cannot be used for collection at all. */
export type ManagedRootDefect =
  | { readonly kind: 'empty' }
  | { readonly kind: 'malformed-root' }
  | { readonly kind: 'path-form'; readonly path: string; readonly defect: PathFormDefect }
  | { readonly kind: 'duplicate'; readonly path: string }
  | { readonly kind: 'nested'; readonly path: string; readonly within: string };

const MANAGED_ROOTS = Symbol('antonina.managedRoots');

/**
 * A validated, frozen set of managed collection roots.
 *
 * The unique symbol makes the value opaque: it is not exported, so no other
 * module can name it and only `validateManagedRoots` can produce a
 * `ManagedRoots`. In type-checked code an unusable root configuration therefore
 * cannot reach the decision function as if it were usable; the decision trusts
 * the caller that hands it a root set.
 */
export interface ManagedRoots {
  readonly [MANAGED_ROOTS]: true;
  /** The configured roots, in the order they were configured. */
  readonly roots: readonly ManagedCollectionRoot[];
}

export type ManagedRootsResult =
  | { readonly ok: true; readonly roots: ManagedRoots }
  | { readonly ok: false; readonly defect: ManagedRootDefect };

/** Why a candidate path may not be touched. */
export type ManagedPathRefusal =
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
      /**
       * The only path a collector may act on: the candidate exactly as the board
       * recorded it, unchanged. A collector is never handed a path spelled
       * differently from the board-recorded one, so a name can never quietly
       * come to mean some other directory.
       */
      readonly path: string;
      /** The root the candidate was found in. */
      readonly root: ManagedCollectionRoot;
      /**
       * Whether the final component of the candidate is itself a symlink. An
       * eligible symlink is unlinked at `path`, never followed and never recursed
       * into: its target is inside the managed root, but recursing into it is not
       * this decision's permission.
       */
      readonly unlinkFinalComponent: boolean;
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
 * guesses instead of gathering them has opted out of the guarantees below. The
 * same gathering answers a root's `resolved` path, so roots and candidates are
 * always compared in the same coordinate system.
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

function pathsOf(inputs: readonly ManagedCollectionRoot[], key: 'spelled' | 'resolved'): string[] | null {
  const paths: string[] = [];
  for (const input of inputs) {
    if (typeof input?.[key] !== 'string') return null;
    paths.push(input[key]);
  }
  return paths;
}

/**
 * Validates a set of explicitly configured managed collection roots. A root set
 * is refused when an entry is not a spelled/resolved pair, when either form of
 * a root is not absolute and canonical, when a root repeats in either coordinate
 * system, or when one root sits inside another in either coordinate system:
 * nested roots would make "the root this path belongs to" ambiguous, and a
 * collector must not have to guess which configured root authorises a deletion.
 */
export function validateManagedRoots(inputs: readonly ManagedCollectionRoot[]): ManagedRootsResult {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, defect: { kind: 'empty' } };
  }

  const spelled = pathsOf(inputs, 'spelled');
  const resolved = pathsOf(inputs, 'resolved');
  if (spelled === null || resolved === null) {
    return { ok: false, defect: { kind: 'malformed-root' } };
  }

  const roots: ManagedCollectionRoot[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const rootPath = spelled[index] as string;
    const rootResolved = resolved[index] as string;
    for (const path of [rootPath, rootResolved]) {
      const defect = pathFormDefect(path);
      if (defect !== null) return { ok: false, defect: { kind: 'path-form', path, defect } };
    }
    roots.push(Object.freeze({ spelled: rootPath, resolved: rootResolved }));
  }

  for (const coordinates of [spelled, resolved]) {
    const seen = new Set<string>();
    for (const path of coordinates) {
      if (seen.has(path)) return { ok: false, defect: { kind: 'duplicate', path } };
      seen.add(path);
    }
  }

  for (const [index, root] of roots.entries()) {
    for (const [otherIndex, other] of roots.entries()) {
      if (index === otherIndex) continue;
      if (isWithin(other.spelled, root.spelled)) {
        return { ok: false, defect: { kind: 'nested', path: root.spelled, within: other.spelled } };
      }
      if (isWithin(other.resolved, root.resolved)) {
        return { ok: false, defect: { kind: 'nested', path: root.spelled, within: other.spelled } };
      }
    }
  }

  return {
    ok: true,
    roots: Object.freeze({
      [MANAGED_ROOTS]: true,
      roots: Object.freeze(roots),
    }) as ManagedRoots,
  };
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

  const defect = pathFormDefect(path);
  if (defect !== null) return refuse(path, defectOfPathForm(defect));

  // The candidate is named the way the board records paths, so it is located in a
  // root by its spelled form; every question about where it really is is answered
  // in the root's resolved coordinates below.
  const root = roots.roots.find((entry) => isWithin(entry.spelled, path));
  if (root === undefined) {
    const nearMiss = roots.roots.some((entry) => isStringPrefix(entry.spelled, path));
    return refuse(path, nearMiss ? 'near-miss-root-prefix' : 'outside-managed-roots');
  }

  // A configured root is not collectible through the roots that define it. A
  // symlink inside the root that points back at the root is not the root: the
  // link is the collector's target and unlinking it removes nothing but the link.
  if (path === root.spelled) return refuse(path, 'candidate-is-managed-root');

  // The candidate's own location and the location of the directory holding it must
  // both be inside the same root. Either can escape through a symlink, and only
  // one of the two can be checked from a spelled path alone.
  if (!isWithin(root.resolved, parentResolvedPath)) {
    return refuse(path, 'containing-directory-escapes-managed-root');
  }
  // A spelled path that agrees with its resolved path has been checked already.
  // A disagreement means a symlink was crossed: either the final component was
  // one, or a directory above it was, and the resolved path must land back
  // inside the resolved root that authorised the candidate.
  if (resolvedPath !== path && !isWithin(root.resolved, resolvedPath)) {
    return refuse(path, 'symlink-escapes-managed-root');
  }

  return { eligible: true, path, root, unlinkFinalComponent: finalComponentIsSymlink };
}
