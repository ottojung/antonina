import { realpath as realpathCall } from 'node:fs/promises';

import { validateManagedRoots } from '../../core/src/managed-roots.js';
import type {
  ManagedCollectionRoot,
  ManagedRootDefect,
  ManagedRoots,
} from '../../core/src/managed-roots.js';
import { pathFormDefect } from '../../core/src/model.js';

/**
 * The operator-facing source of the managed collection roots.
 *
 * This is the only place a `resolved` coordinate is produced, and it lives here
 * rather than in `packages/core` because core's `managed-roots.ts` states that it
 * "performs no I/O and calls no `realpath`" and `packages/agent-runtime` is the
 * only package that may name `node:`. It is the node-side counterpart of
 * `candidate-facts.ts`: the registry half of collection is pure and lives in
 * core, and this is the half that has to look at the filesystem and hand core a
 * value it will trust.
 *
 * Two runtime edges reach core, and both are deliberate: `validateManagedRoots`
 * is the only thing that can produce a branded `ManagedRoots` (the brand symbol
 * is module-private to core), and `pathFormDefect` is core's single definition of
 * what a canonical POSIX path is, so the vocabulary of refusal is core's rather
 * than a second one. The types above are imported type-only and erase. Note that
 * `packages/agent-runtime` does not depend on `@antonina/core`; the specifier is
 * the repo-relative one the CLI front already uses
 * (`packages/cli/src/board.ts:20`), which is why this file cannot be compiled
 * under a `rootDir` of `packages/agent-runtime/src` alone.
 */
export const MANAGED_ROOTS_ENV = 'ANTONINA_COLLECT_ROOTS';

/**
 * The filesystem surface this loader needs, injected as `store.ts` and
 * `candidate-facts.ts` inject theirs: `realpath` is the only I/O performed, and
 * the seam is what makes the "before any I/O" half of the ordering rule below
 * observable in a test rather than merely asserted in a comment.
 */
export interface RootsFs {
  realpath: typeof realpathCall;
}

const DEFAULT_ROOTS_FS: RootsFs = { realpath: realpathCall };

/**
 * Why a configured root set cannot be used at all.
 *
 * The `ManagedRootDefect` members are core's own and are carried through by
 * identity, never re-derived: an operator-facing renderer prints core's `kind`
 * first, so the words read are the words the judgment used. The others are the
 * defects this loader owns, because they need the filesystem fact core's own
 * validator does not compute -- whether a spelling resolves, and what it
 * resolves to -- plus the one condition that is about the *absence* of
 * configuration and must never be reported as core's `empty`.
 *
 * `roots-not-configured` is deliberately a distinct kind rather than
 * `{ kind: 'empty' }`. An operator who never set the variable, an operator whose
 * variable names only separators, and an operator whose roots resolve to nothing
 * usable are in three different situations and only the first two share a fix.
 * More importantly, an absent variable is refused *here*, before
 * `validateManagedRoots` is reached, so "no roots configured" is never a state
 * this loader passes on as if it were a root set.
 */
export type ManagedRootsConfigDefect =
  | { readonly kind: 'roots-not-configured'; readonly variable: string }
  | { readonly kind: 'unresolvable-root'; readonly path: string; readonly message: string }
  | { readonly kind: 'root-is-filesystem-root'; readonly path: string }
  | { readonly kind: 'root-resolves-to-filesystem-root'; readonly path: string; readonly resolved: string }
  | ManagedRootDefect;

export type LoadManagedRootsResult =
  | { readonly ok: true; readonly roots: ManagedRoots }
  | {
    readonly ok: false;
    /**
     * The spelling the defect is reported against: the entry that could not be
     * resolved, the path a core defect names, or the first configured spelling.
     * `null` when nothing was configured at all.
     */
    readonly spelling: string | null;
    readonly defect: ManagedRootsConfigDefect;
  };

/**
 * The spellings the environment names, in configuration order.
 *
 * The separator is `:` (a POSIX path list) and empty entries are dropped after
 * trimming, so a variable holding only separators configures nothing. That
 * nothing is not "no roots, proceed": it is refused by name before any of this
 * is used for anything.
 */
export function configuredRootSpellings(
  env: Record<string, string | undefined>,
  name: string = MANAGED_ROOTS_ENV,
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
 * Turns configured spellings into the one `ManagedRoots` value core accepts.
 *
 * The invariants this exists to hold, each enforced by the order of the code
 * below rather than by a convention:
 *
 * (a) `resolved` is always this process's own `realpath` of `spelled`, never a
 *     configured value, a flag, or a default. There is exactly one assignment
 *     to a `resolved` coordinate in this module and it stores the return of the
 *     injected `realpath` call, so a spelling that names one directory and a
 *     resolved coordinate that names another cannot both be configured. This is
 *     what `$id-6841027395618472` requires -- every question about where a root
 *     really is is answered against its resolved path -- and what core's
 *     `managed-roots.ts:135-138` disclaims when it says it "trusts the caller".
 *     This loader is that caller.
 *
 * (b) A spelling that is not canonical is refused *before any I/O*, with core's
 *     own `pathFormDefect` and core's own `path-form` shape, so a relative or
 *     `..`-bearing spelling is never resolved against this process's working
 *     directory and reported back as some path the operator never configured.
 *     The order is load-bearing: form check, then the filesystem-root spelling
 *     check, then `realpath`, then the resolved-root check, then
 *     `validateManagedRoots`. Each step only knows what the previous one proved.
 *
 * (c) A spelling that cannot be resolved is a configuration error reported
 *     against *that* spelling, never dropped. Silently dropping it would leave a
 *     collector running with a smaller root set than the operator believes, and
 *     every later refusal would be reported against a path the operator believes
 *     is managed. This is the deliberate asymmetry with candidate facts, where a
 *     missing path is a legitimate fact: a root must exist, a candidate need not.
 *
 * (d) `/` is refused in both coordinates, with two distinct kinds, because they
 *     are two different operator mistakes and `isWithin` special-cases
 *     `root === '/'` to `path.startsWith('/')` -- so `/` as a root makes every
 *     containment check this module's own validator supports vacuous. The
 *     spelling is refused before I/O; the resolved coordinate is refused after
 *     the `realpath` that produces it, because one symlink hop from a plausible
 *     directory reaches that state. Neither reaches `validateManagedRoots`.
 *
 * (e) A failed validation hands core's `ManagedRootDefect` back by identity and
 *     the success path returns `validateManagedRoots`'s own `roots` value
 *     unchanged. No `ManagedRoots` is ever built here, no brand is cast, and the
 *     brand is module-private to core so no other module can.
 *
 * Nothing here reads the board, and a caller must call this before any board
 * read: a misconfigured collector must never learn what the board says.
 */
export async function loadManagedRoots(
  env: Record<string, string | undefined>,
  name: string = MANAGED_ROOTS_ENV,
  fs: RootsFs = DEFAULT_ROOTS_FS,
): Promise<LoadManagedRootsResult> {
  const spellings = configuredRootSpellings(env, name);
  if (spellings.length === 0) {
    return {
      ok: false,
      spelling: null,
      defect: { kind: 'roots-not-configured', variable: name },
    };
  }

  const roots: ManagedCollectionRoot[] = [];
  for (const spelling of spellings) {
    // (b), first: form, before anything else and before any I/O.
    const form = pathFormDefect(spelling);
    if (form !== null) {
      return { ok: false, spelling, defect: { kind: 'path-form', path: spelling, defect: form } };
    }
    // (d), first half: the spelling `/` is refused before the `realpath` that
    // would happily resolve it.
    if (spelling === '/') {
      return { ok: false, spelling, defect: { kind: 'root-is-filesystem-root', path: spelling } };
    }

    let resolved: string;
    try {
      // (a): the only assignment of a `resolved` coordinate in the product.
      // Nothing configurable reaches this field; its only input is the spelling.
      resolved = await fs.realpath(spelling);
    } catch (error) {
      // (c)
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

    // (d), second half: the hazard is a property of the *resolved* coordinate,
    // whatever the spelling was, and it has its own kind because the operator's
    // two mistakes differ.
    if (resolved === '/') {
      return {
        ok: false,
        spelling,
        defect: { kind: 'root-resolves-to-filesystem-root', path: spelling, resolved },
      };
    }

    roots.push({ spelled: spelling, resolved });
  }

  // (e): core decides, and its verdict is this function's verdict.
  const validated = validateManagedRoots(roots);
  if (!validated.ok) {
    return { ok: false, spelling: defectSpelling(validated.defect, spellings), defect: validated.defect };
  }
  return { ok: true, roots: validated.roots };
}
