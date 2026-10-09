#!/usr/bin/env node
// Derives Antonina's build identity from the repository that is actually being
// built, and writes it into the two TypeScript modules the CLI and the web
// bundle import.
//
// Why this exists: board issue 76 exists because a build could not say which
// source revision it came from, and the 0.1.0 -> 0.1.1 incident cost real
// investigation reconstructing it. The tempting fix is a version constant in a
// source file. That is exactly the false assurance this script replaces: a
// constant is a claim about a build, and it is wrong the moment anyone forgets
// to edit it. So every value written below is read from the build itself.
//
// Sources, in the order they are trusted:
//
//   1. ANTONINA_BUILD_COMMIT, when set to a full 40-hex object name. CI sets
//      this from the checked-out revision, so the deploy path never depends on
//      git being present inside the builder container.
//   2. `git rev-parse HEAD` in the repository root.
//
// If neither yields a commit this throws. There is deliberately no third source
// and no `unknown` sentinel: an artifact that cannot name its revision is the
// condition this issue was filed against, so producing one silently is the one
// outcome worse than a failed build. See docs/build-identity-and-rollback.md
// for why the deploy path can still be loud without being fragile.
//
// Determinism: nothing timestamped is written. Two builds of the same commit
// with the same tracked content produce byte-identical generated modules, so the
// metadata is a fingerprint rather than noise that defeats artifact diffing.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHORT_COMMIT_LENGTH = 12;

function normalizeTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BuildIdentityError(
      `build identity: ${label} must be a valid timestamp, got ${JSON.stringify(value)}`,
    );
  }
  return date.toISOString();
}

function describeFromGit(repoRoot) {
  try {
    const value = git(repoRoot, ['describe']).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

function commitTimeFromGit(repoRoot, commit) {
  try {
    const value = git(repoRoot, ['show', '-s', '--format=%cI', commit]).trim();
    return value === '' ? null : normalizeTimestamp(value, 'Git commit time');
  } catch {
    return null;
  }
}

function resolveDescribe(repoRoot, env) {
  const override = env.ANTONINA_BUILD_DESCRIBE;
  if (override !== undefined && override !== '') return override;
  const value = describeFromGit(repoRoot);
  if (value !== null) return value;
  throw new BuildIdentityError(
    'build identity: cannot determine `git describe` output; set ANTONINA_BUILD_DESCRIBE when Git history is unavailable',
  );
}

function resolveCommitTime(repoRoot, env, commit) {
  const override = env.ANTONINA_BUILD_COMMIT_TIME;
  if (override !== undefined && override !== '') {
    return normalizeTimestamp(override, 'ANTONINA_BUILD_COMMIT_TIME');
  }
  const value = commitTimeFromGit(repoRoot, commit);
  if (value !== null) return value;
  throw new BuildIdentityError(
    'build identity: cannot determine commit time; set ANTONINA_BUILD_COMMIT_TIME when Git history is unavailable',
  );
}

function resolveDeployTime(env) {
  const value = env.ANTONINA_DEPLOY_TIME;
  return normalizeTimestamp(
    value === undefined || value === '' ? new Date().toISOString() : value,
    'ANTONINA_DEPLOY_TIME',
  );
}

export const CLI_VERSION_MANIFEST = 'packages/cli/package.json';
export const WEB_VERSION_MANIFEST = 'web/package.json';

export class BuildIdentityError extends Error {}

function readManifestVersion(manifestFile) {
  const text = readFileSync(manifestFile, 'utf8');
  const version = JSON.parse(text).version;
  if (typeof version !== 'string' || version === '') {
    throw new BuildIdentityError(
      `build identity: ${manifestFile} declares no usable "version" string`,
    );
  }
  return version;
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commitFromGit(repoRoot) {
  let commit;
  try {
    commit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
  if (!COMMIT_PATTERN.test(commit)) return null;

  // A dirty tree at build time is recorded rather than rejected: the revision
  // still identifies the source, and an uncommitted build that claims to be a
  // clean one is the misleading case. Ignored paths (dist, node_modules, and the
  // generated modules this script writes) are not counted, so the identity does
  // not depend on whether the build has already run.
  let dirty;
  try {
    dirty = git(repoRoot, ['status', '--porcelain']).trim() !== '';
  } catch {
    dirty = false;
  }
  return { commit, dirty, source: 'git' };
}

function commitFromEnv(repoRoot, env) {
  const override = env.ANTONINA_BUILD_COMMIT;
  // An empty value means "not set" rather than "invalid". The usual reason to see
  // one is a shell or CI step that interpolates a variable which resolved to
  // nothing, and failing a build over that would make the override harder to use
  // than the thing it exists to replace. A non-empty value that is not an object
  // name is a different matter and is rejected below.
  if (override === undefined || override === '') return null;
  if (!COMMIT_PATTERN.test(override)) {
    // A malformed override is an error rather than a reason to fall through to
    // git: falling through would let a typo produce a build that carries a
    // different revision than the caller asked for, and nothing would say so.
    throw new BuildIdentityError(
      'build identity: ANTONINA_BUILD_COMMIT must be a full 40-character lowercase'
        + ` object name, got ${JSON.stringify(override)}`,
    );
  }
  // Dirtiness is a property of the working tree, so it is still asked of git
  // when git is reachable. CI exports a commit for a freshly checked-out clean
  // tree, where a false here is correct rather than a guess.
  let dirty = false;
  try {
    dirty = git(repoRoot, ['status', '--porcelain']).trim() !== '';
  } catch {
    dirty = false;
  }
  return { commit: override, dirty, source: 'env' };
}

/**
 * Resolves the build identity for `repoRoot`.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{
 *   cli: { version: string, commit: string, shortCommit: string, dirty: boolean, source: 'git' | 'env' },
 *   web: { version: string, commit: string, shortCommit: string, dirty: boolean, source: 'git' | 'env' },
 * }}
 */
export function resolveBuildIdentity(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;

  // The commit is resolved once and shared: the two surfaces are built from one
  // tree in one run, and letting them disagree would produce a CLI and a web UI
  // that each claim to be a different build of the same checkout.
  const resolved = commitFromEnv(repoRoot, env) ?? commitFromGit(repoRoot);
  if (resolved === null) {
    throw new BuildIdentityError(
      'build identity: cannot determine the source Git commit.'
        + ' Neither ANTONINA_BUILD_COMMIT nor git rev-parse HEAD yielded one in ' + repoRoot + '.'
        + ' Refusing to build an artifact that cannot name its own revision.'
        + ' In CI this is set from the checked-out revision; locally it means this'
        + ' is not a Git checkout, so pass ANTONINA_BUILD_COMMIT explicitly.',
    );
  }

  const commitTime = resolveCommitTime(repoRoot, env, resolved.commit);
  const shared = {
    commit: resolved.commit,
    shortCommit: resolved.commit.slice(0, SHORT_COMMIT_LENGTH),
    dirty: resolved.dirty,
    source: resolved.source,
    describe: resolveDescribe(repoRoot, env),
    commitTime,
    deployTime: resolveDeployTime(env),
  };
  return {
    cli: { version: readManifestVersion(join(repoRoot, CLI_VERSION_MANIFEST)), ...shared },
    web: { version: readManifestVersion(join(repoRoot, WEB_VERSION_MANIFEST)), ...shared },
  };
}

const GENERATED_BANNER = [
  '// GENERATED FILE - do not edit, do not commit.',
  '//',
  '// Written by scripts/build-identity.mjs from the tree this build ran in.',
  '// The values below are read from Git and from the package manifests at build',
  '// time; there is no hand-maintained version or commit constant anywhere in',
  '// this repository, and regenerating this file is what `npm run',
  '// generate:build-identity` does. Editing it by hand would be reverted by the',
  '// next build and would be invisible until someone compared the two.',
].join('\n');

function renderModule(exportName, identity, extra = []) {
  return [
    GENERATED_BANNER,
    '',
    'export type BuildIdentitySource = \'git\' | \'env\';',
    '',
    'export interface BuildIdentity {',
    '  /** Semantic version declared by this surface\'s own package manifest. */',
    '  readonly version: string;',
    '  /** Full 40-character source Git commit this surface was built from. */',
    '  readonly commit: string;',
    '  /** `commit` truncated for display; never the only identifier recorded. */',
    '  readonly shortCommit: string;',
    '  /** Whether the source tree had tracked modifications when it was built. */',
    '  readonly dirty: boolean;',
    '  /** Where the commit came from: the working tree, or an explicit override. */',
    '  readonly source: BuildIdentitySource;',
    '  /** Exact output of `git describe` for this source revision. */',
    '  readonly describe: string;',
    '  /** Committer timestamp of the source revision, normalized to ISO 8601. */',
    '  readonly commitTime: string;',
    '  /** Timestamp when this installed artifact was produced. */',
    '  readonly deployTime: string;',
    '}',
    '',
    `export const ${exportName}: BuildIdentity = {`,
    `  version: ${JSON.stringify(identity.version)},`,
    `  commit: ${JSON.stringify(identity.commit)},`,
    `  shortCommit: ${JSON.stringify(identity.shortCommit)},`,
    `  dirty: ${JSON.stringify(identity.dirty)},`,
    `  source: ${JSON.stringify(identity.source)},`,
    `  describe: ${JSON.stringify(identity.describe)},`,
    `  commitTime: ${JSON.stringify(identity.commitTime)},`,
    `  deployTime: ${JSON.stringify(identity.deployTime)},`,
    '};',
    ...extra,
    '',
  ].join('\n');
}

export const CLI_GENERATED_MODULE = 'packages/cli/src/build-identity.generated.ts';
export const WEB_GENERATED_MODULE = 'web/build-identity.generated.ts';

export function renderCliModule(identity) {
  return renderModule('CLI_BUILD_IDENTITY', identity);
}

export function renderWebModule(identity) {
  return renderModule('WEB_BUILD_IDENTITY', identity, [
    '',
    '/**',
    ' * The provenance written into the deployed web bundle. Serialized verbatim to',
    ' * `version.json` next to the bundle, so the served artifact names its own',
    ' * revision and a rollback target can be read from a URL instead of inferred.',
    ' */',
    'export interface WebBuildProvenance {',
    '  readonly product: \'antonina\';',
    '  readonly surface: \'web\';',
    '  readonly version: string;',
    '  readonly commit: string;',
    '  readonly shortCommit: string;',
    '  readonly dirty: boolean;',
    '  readonly source: BuildIdentitySource;',
    '}',
    '',
    'export const WEB_BUILD_PROVENANCE: WebBuildProvenance = {',
    '  product: \'antonina\',',
    '  surface: \'web\',',
    '  version: WEB_BUILD_IDENTITY.version,',
    '  commit: WEB_BUILD_IDENTITY.commit,',
    '  shortCommit: WEB_BUILD_IDENTITY.shortCommit,',
    '  dirty: WEB_BUILD_IDENTITY.dirty,',
    '  source: WEB_BUILD_IDENTITY.source,',
    '};',
  ]);
}

export function writeGeneratedModules(identity, { repoRoot = REPO_ROOT } = {}) {
  const written = [];
  for (const [relative, contents] of [
    [CLI_GENERATED_MODULE, renderCliModule(identity.cli)],
    [WEB_GENERATED_MODULE, renderWebModule(identity.web)],
  ]) {
    const target = join(repoRoot, relative);
    writeFileSync(target, contents);
    written.push(target);
  }
  return written;
}

function isMainModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const identity = resolveBuildIdentity();
    for (const target of writeGeneratedModules(identity)) {
      process.stdout.write(
        `build identity: wrote ${target} `
          + `(${identity.cli.version} ${identity.cli.shortCommit}, from ${identity.cli.source})\n`,
      );
    }
  } catch (error) {
    if (error instanceof BuildIdentityError) {
      process.stderr.write(`build identity: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
