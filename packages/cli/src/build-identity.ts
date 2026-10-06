// Runtime accessor for the generated build identity.
import {
  CLI_BUILD_IDENTITY,
  type BuildIdentity,
  type BuildIdentitySource,
} from './build-identity.generated.js';

export type { BuildIdentity, BuildIdentitySource };

export function buildIdentity(): BuildIdentity {
  return CLI_BUILD_IDENTITY;
}

export function isDirtyBuild(): boolean {
  return CLI_BUILD_IDENTITY.dirty;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function displayTimestamp(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function agePhrase(iso: string, now = Date.now()): string {
  let seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const units: Array<[string, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const parts: string[] = [];
  for (const [name, size] of units) {
    if (parts.length == 2) break;
    const count = Math.floor(seconds / size);
    if (count > 0 || (size === 1 && parts.length === 0)) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      seconds -= count * size;
    }
  }
  return `${parts.join(' and ')} ago`;
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
