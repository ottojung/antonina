/**
 * Compiler-checked conformance between the two declarations of
 * `CandidatePathFacts`:
 *
 *  - the recipe, in `@antonina/core` (`managed-roots.ts`), which is now
 *    re-exported from the published surface `@antonina/core`'s `api.ts`; and
 *  - the node-side declaration in `../src/candidate-facts.ts`, which
 *    `@antonina/agent-runtime` keeps because it does not depend on
 *    `@antonina/core` (a type-only import of the core declaration would, under
 *    this package's `rootDir`, drag core's sources into the runtime build --
 *    see `tsconfig.conformance.json` for the separate program that can read
 *    both without that).
 *
 * The prose in `candidate-facts.ts` used to be the only thing holding the two
 * together. It is not checked, so it cannot be allowed to be the only thing.
 * The assertions below are bidirectional assignability, so a field added,
 * removed, or retyped on either side stops the build here instead of drifting
 * silently into a gatherer that a core re-check accepts without a question.
 *
 * This file is type-only: it emits nothing (`noEmit`), imports nothing at
 * runtime, and is not part of the published `dist`.
 */
import type { CandidatePathFacts as CoreCandidatePathFacts } from '../../core/src/managed-roots.js';
import type { CandidatePathFacts as RuntimeCandidatePathFacts } from '../src/candidate-facts.js';

// `false`, not `never`, on a mismatch: `never` satisfies every constraint, so a
// `never` result would sail through `Assert` and this check would be a comment.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

// Core -> runtime: every fact core can require, the runtime gatherer supplies.
export type RuntimeSatisfiesCore = Assert<
  MutuallyAssignable<RuntimeCandidatePathFacts, CoreCandidatePathFacts>
>;

// Runtime -> core: and no extra field sneaks in that core would silently ignore.
export type CoreSatisfiesRuntime = Assert<
  MutuallyAssignable<CoreCandidatePathFacts, RuntimeCandidatePathFacts>
>;

// The gatherer's declared return type must be nameable through core's published
// surface: this is exactly what `api.ts` re-exports.
import type { CandidateFactsGatherer, CandidatePathFacts as PublishedCandidatePathFacts } from '../../core/src/api.js';

export type PublishedFactsAreTheRecipe = Assert<
  MutuallyAssignable<PublishedCandidatePathFacts, CoreCandidatePathFacts>
>;

export type PublishedGathererIsUsable = Assert<
  MutuallyAssignable<CandidateFactsGatherer, (path: string) => Promise<PublishedCandidatePathFacts | null>>
>;
