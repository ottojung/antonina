import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Filesystem facts about one host-garbage-collection candidate.
 *
 * This is the shape of `CandidatePathFacts` in `@antonina/core`'s
 * `managed-roots.ts`, declared here rather than imported because
 * `@antonina/agent-runtime` does not depend on `@antonina/core`: the registry
 * half of collection is pure and lives in core, and the facts it needs are an
 * input to it, not part of it. `packages/core` performs no filesystem I/O and
 * names no `node:` module; this is the node-side implementation of the recipe
 * `CandidatePathFacts` documents, and it is what a collector passes as the
 * required facts gatherer to `recheckCollectionClaim`.
 *
 * The duplication is compiler-checked, not merely described: the two
 * declarations are asserted mutually assignable in
 * `../conformance/candidate-path-facts.conformance.ts`, which `npm run
 * typecheck` builds. A field added, removed, or retyped on either side fails
 * that check. What the compiler does *not* enforce is that this remains a
 * faithful restatement of the recipe: only the shape is checked, so the comments
 * above and in core's `managed-roots.ts` remain the only account of how the
 * facts are gathered.
 */
export interface CandidatePathFacts {
  /** The candidate path, exactly as the board recorded it. */
  readonly path: string;
  /** The path the candidate resolves to, with every symlink in the way followed. */
  readonly resolvedPath: string;
  /** Whether the final component of the candidate is itself a symlink. */
  readonly finalComponentIsSymlink: boolean;
  /** The resolved path of the directory containing the candidate. */
  readonly parentResolvedPath: string;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Gathers the `CandidatePathFacts` for one candidate, following the recipe in
 * `CandidatePathFacts`: the candidate's own `lstat`, the resolved path of the
 * directory containing it, and the candidate's resolved path -- a real
 * `realpath` for a path that exists, and the parent resolution with the final
 * component rejoined by `node:path` for one that does not, because a path that
 * does not exist yet is a real deletion target.
 *
 * `null` means the facts could not be gathered at all: the containing directory
 * does not exist or cannot be resolved, or the candidate exists but cannot be
 * resolved. It is not an eligible answer. `lstat` failing for any reason other
 * than "it is not there" -- a permission problem, a name too long -- is likewise
 * a failure to read, not a fact about a nonexistent path.
 */
export async function gatherCandidatePathFacts(candidate: string): Promise<CandidatePathFacts | null> {
  let finalComponentIsSymlink = false;
  let exists = true;
  try {
    finalComponentIsSymlink = (await lstat(candidate)).isSymbolicLink();
  } catch (error) {
    if (!isMissing(error)) return null;
    exists = false;
  }

  let parentResolvedPath: string;
  try {
    parentResolvedPath = await realpath(dirname(candidate));
  } catch {
    return null;
  }

  let resolvedPath: string;
  if (exists) {
    try {
      resolvedPath = await realpath(candidate);
    } catch {
      return null;
    }
  } else {
    resolvedPath = join(parentResolvedPath, basename(candidate));
  }

  return { path: candidate, resolvedPath, finalComponentIsSymlink, parentResolvedPath };
}
