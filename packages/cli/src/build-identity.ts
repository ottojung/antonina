// Runtime accessor for the build identity that scripts/build-identity.mjs
// wrote into this module at build time.
//
// This file is hand-written and holds no version or commit of its own. Every
// value it re-exports is derived, so `antonina --version` cannot drift from the
// tree the running binary was compiled out of.

import {
  CLI_BUILD_IDENTITY,
  type BuildIdentity,
  type BuildIdentitySource,
} from './build-identity.generated.js';

export type { BuildIdentity, BuildIdentitySource };

/**
 * The identity of the running binary. Always the values baked in at build time;
 * there is no runtime fallback to the environment, because a binary that asked
 * the environment where it came from would be reporting its surroundings rather
 * than its own provenance.
 */
export function buildIdentity(): BuildIdentity {
  return CLI_BUILD_IDENTITY;
}

/** True when the build was made from a tree with tracked modifications. */
export function isDirtyBuild(): boolean {
  return CLI_BUILD_IDENTITY.dirty;
}

/**
 * The single line a human reads: `antonina 0.1.2 (079a5cc91776)`.
 *
 * `dirty` is spelled out when set rather than folded into the commit, so a
 * locally modified build is never mistaken for a released one at a glance.
 */
export function versionLine(): string {
  const { version, shortCommit, dirty } = CLI_BUILD_IDENTITY;
  return `antonina ${version} (${shortCommit}${dirty ? '-dirty' : ''})`;
}

/**
 * Key/value lines for the human-readable `--version` output.
 *
 * The full 40-character commit is included, not only the short one: an operator
 * confirming a rollback target is matching a 40-hex object name against a
 * deployment record, and a 12-character prefix is a prefix, not an identity.
 */
export function versionFields(): string[] {
  const { version, commit, dirty, source } = CLI_BUILD_IDENTITY;
  return [
    `version ${version}`,
    `commit ${commit}`,
    ...(dirty ? ['dirty true'] : []),
    `commit-source ${source}`,
  ];
}

/**
 * The machine-readable `--version --json` payload.
 *
 * `identityIsDerivable` is not a field; its absence is the signal. There is no
 * `unknown` value a consumer has to special-case, because the build refuses to
 * produce an identity at all when it cannot derive one.
 */
export function versionJson(): unknown {
  const { version, commit, shortCommit, dirty, source } = CLI_BUILD_IDENTITY;
  return {
    name: 'antonina',
    version,
    commit,
    shortCommit,
    dirty,
    commitSource: source,
  };
}
