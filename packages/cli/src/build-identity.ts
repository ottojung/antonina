// Runtime accessor for the generated build identity.
import {
  CLI_BUILD_IDENTITY,
  type BuildIdentity,
  type BuildIdentitySource,
} from './build-identity.generated.js';

import { agePhrase, displayTimestamp } from './time-display.js';

export type { BuildIdentity, BuildIdentitySource };

export function buildIdentity(): BuildIdentity {
  return CLI_BUILD_IDENTITY;
}

export function isDirtyBuild(): boolean {
  return CLI_BUILD_IDENTITY.dirty;
}

export function versionLine(): string {
  return `antonina ${CLI_BUILD_IDENTITY.describe}`;
}

export function versionFields(): string[] {
  const {
    version,
    commit,
    dirty,
    source,
    commitTime,
    deployTime,
  } = CLI_BUILD_IDENTITY;
  return [
    `version ${version}`,
    `commit ${commit}`,
    ...(dirty ? ['dirty true'] : []),
    `commit-source ${source}`,
    `commit-time ${displayTimestamp(commitTime)} (${agePhrase(commitTime)})`,
    `deploy-time ${displayTimestamp(deployTime)} (${agePhrase(deployTime)})`,
  ];
}

export function versionJson(): unknown {
  const {
    version,
    commit,
    shortCommit,
    dirty,
    source,
    describe,
    commitTime,
    deployTime,
  } = CLI_BUILD_IDENTITY;
  return {
    name: 'antonina',
    version,
    commit,
    shortCommit,
    dirty,
    commitSource: source,
    describe,
    commitTime,
    deployTime,
  };
}
