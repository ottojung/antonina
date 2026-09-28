// Runs the real vite build over a minimal copy of the web app and asserts on the
// artifact it emits.
//
// A unit test that called `buildIdentityPlugin()` and inspected the returned
// object would pass even if the plugin were never registered in `vite.config.ts`,
// and would keep passing if vite stopped calling `generateBundle`. The only
// question worth asking is whether the emitted bundle names the revision it was
// built from, so this builds one and greps the output.
//
// The revision is supplied through the generated module rather than by arranging
// a Git repository with a chosen HEAD. A commit object name is a hash of content,
// so pinning one means amending until the hash matches, which costs tens of `git
// commit` rounds for no additional property: the path from a known commit to a
// bundle naming it is the same either way, and scripts/build-identity.test.mjs
// covers derivation from a real tree.
//
// The version and commit below are deliberately not any real value in this
// repository, so a pass cannot come from a constant that happens to be correct on
// this branch.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(webRoot, '..');

const EXPECTED_COMMIT = '1234567890abcdef1234567890abcdef12345678';
const EXPECTED_VERSION = '0.9.9';
const VITE_BIN = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

// Only what a vite build of this app reads. `web/node_modules` is symlinked
// rather than copied: it is large and a symlink is enough for the bundler.
const SOURCES = [
  'index.html', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'vite.config.ts', 'build-identity-plugin.ts', 'src',
];

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The sandbox is laid out as a repository root rather than as a bare app
// directory, because web/src imports ../../packages/core/src/*. Copying the app
// alone builds a different graph than the deployed one.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'antonina-web-identity-'));
  sandboxes.push(root);
  const app = join(root, 'web');
  mkdirSync(app);
  for (const entry of SOURCES) cpSync(join(webRoot, entry), join(app, entry), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  cpSync(join(repoRoot, 'packages', 'core'), join(root, 'packages', 'core'), { recursive: true });
  symlinkSync(join(webRoot, 'node_modules'), join(app, 'node_modules'), 'dir');
  writeGeneratedModule(app, { dirty: false });
  return app;
}

/** Writes the generated module the way `npm run generate:build-identity` does. */
function writeGeneratedModule(dir: string, { dirty }: { dirty: boolean }) {
  writeFileSync(join(dir, 'build-identity.generated.ts'), `// GENERATED FILE - do not edit, do not commit.

export type BuildIdentitySource = 'git' | 'env';

export interface BuildIdentity {
  readonly version: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly dirty: boolean;
  readonly source: BuildIdentitySource;
}

export const WEB_BUILD_IDENTITY: BuildIdentity = {
  version: ${JSON.stringify(EXPECTED_VERSION)},
  commit: ${JSON.stringify(EXPECTED_COMMIT)},
  shortCommit: ${JSON.stringify(EXPECTED_COMMIT.slice(0, 12))},
  dirty: ${dirty},
  source: "env",
};

export interface WebBuildProvenance {
  readonly product: 'antonina';
  readonly surface: 'web';
  readonly version: string;
  readonly commit: string;
  readonly shortCommit: string;
  readonly dirty: boolean;
  readonly source: BuildIdentitySource;
}

export const WEB_BUILD_PROVENANCE: WebBuildProvenance = {
  product: 'antonina',
  surface: 'web',
  version: WEB_BUILD_IDENTITY.version,
  commit: WEB_BUILD_IDENTITY.commit,
  shortCommit: WEB_BUILD_IDENTITY.shortCommit,
  dirty: WEB_BUILD_IDENTITY.dirty,
  source: WEB_BUILD_IDENTITY.source,
};
`);
}

function patchGeneratedModule(dir: string, from: RegExp | string, to: string) {
  const module = join(dir, 'build-identity.generated.ts');
  writeFileSync(module, readFileSync(module, 'utf8').replace(from as RegExp, to));
}

function build(dir: string) {
  return spawnSync(process.execPath, [VITE_BIN, 'build'], {
    encoding: 'utf8',
    timeout: 300_000,
    cwd: dir,
    env: process.env,
  });
}

const dist = (dir: string, ...parts: string[]) => join(dir, 'dist', ...parts);

describe('web build identity', () => {
  it('the emitted bundle names the revision it was built from', () => {
    const dir = sandbox();
    const result = build(dir);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const provenanceText = readFileSync(dist(dir, 'version.json'), 'utf8');
    expect(JSON.parse(provenanceText)).toEqual({
      product: 'antonina',
      surface: 'web',
      version: EXPECTED_VERSION,
      commit: EXPECTED_COMMIT,
      shortCommit: EXPECTED_COMMIT.slice(0, 12),
      dirty: false,
      source: 'env',
    });
    // The identity is text in a served file, which is what makes a deployed
    // bundle identifiable from a URL without a build of the repository.
    expect(provenanceText).toContain(EXPECTED_COMMIT);

    expect(readFileSync(dist(dir, 'index.html'), 'utf8'))
      .toMatch(new RegExp(`<meta name="antonina:build" content="${EXPECTED_VERSION}\\+${EXPECTED_COMMIT.slice(0, 12)}">`));
  });

  it('a dirty build says so in both places it is reported', () => {
    const dir = sandbox();
    patchGeneratedModule(dir, 'dirty: false,', 'dirty: true,');
    const result = build(dir);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(dist(dir, 'version.json'), 'utf8')).dirty).toBe(true);
    expect(readFileSync(dist(dir, 'index.html'), 'utf8'))
      .toContain(`content="${EXPECTED_VERSION}+${EXPECTED_COMMIT.slice(0, 12)}-dirty"`);
  });

  it('the build fails loudly when the generated identity is unusable', () => {
    // The generator refuses to write a bad identity, so this is the other door
    // into the same failure: a hand-edited or stale module. A bundle claiming an
    // unverifiable revision is worse than one claiming nothing, so the build stops.
    const dir = sandbox();
    patchGeneratedModule(dir, /shortCommit: "[0-9a-f]+"/, 'shortCommit: "not-a-prefix"');

    const result = build(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/identity is unusable|cannot be traced to a revision/);
    expect(existsSync(dist(dir, 'version.json'))).toBe(false);
  });

  it('the build fails when the commit is not an object name', () => {
    const dir = sandbox();
    patchGeneratedModule(dir, /commit: "[0-9a-f]{40}"/, 'commit: "not-a-sha"');
    const result = build(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not a 40-character object name/);
  });
});
