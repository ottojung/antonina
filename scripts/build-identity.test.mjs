import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The generator is the only place Antonina's build identity comes from. These
// cases pin the two properties that make it worth trusting: it is derived from
// the tree, and when it cannot derive one it fails loudly instead of emitting
// something that reads like an answer.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generator = join(repoRoot, 'scripts', 'build-identity.mjs');
const CLI_GENERATED = join(repoRoot, 'packages', 'cli', 'src', 'build-identity.generated.ts');
const WEB_GENERATED = join(repoRoot, 'web', 'build-identity.generated.ts');

const { resolveBuildIdentity, BuildIdentityError, renderCliModule, renderWebModule } =
  await import(generator);

function runGenerator(env = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [generator], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
    env: { ...process.env, ANTONINA_BUILD_COMMIT: undefined, ...env },
  });
}

test('the identity is derived from the tree being built', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const identity = resolveBuildIdentity({ repoRoot, env: {} });
  assert.equal(identity.cli.commit, head);
  assert.equal(identity.web.commit, head, 'the two surfaces must not disagree about the revision');
  assert.equal(identity.cli.source, 'git');
  assert.equal(identity.cli.shortCommit, head.slice(0, 12));
});

test('each surface reports its own manifest version', () => {
  const identity = resolveBuildIdentity({ repoRoot, env: {} });
  const cliManifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  const webManifest = JSON.parse(readFileSync(join(repoRoot, 'web/package.json'), 'utf8'));
  assert.equal(identity.cli.version, cliManifest.version);
  assert.equal(identity.web.version, webManifest.version);
});

test('an explicit commit override wins over the working tree', () => {
  // The deploy path sets this, so a builder container without a usable .git can
  // still produce a correctly identified artifact.
  const override = 'a'.repeat(40);
  const identity = resolveBuildIdentity({ repoRoot, env: { ANTONINA_BUILD_COMMIT: override } });
  assert.equal(identity.cli.commit, override);
  assert.equal(identity.cli.source, 'env');
  assert.equal(identity.web.commit, override);
});

test('a malformed commit override fails rather than falling through to git', () => {
  // Falling through would let a typo silently produce a build carrying a
  // different revision than the caller asked for, with nothing reporting it.
  for (const bad of ['HEAD', 'abc', 'z'.repeat(40), 'A'.repeat(40), '079a5cc']) {
    assert.throws(
      () => resolveBuildIdentity({ repoRoot, env: { ANTONINA_BUILD_COMMIT: bad } }),
      (error) => error instanceof BuildIdentityError && /40-character/.test(error.message),
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('an empty override means unset, not invalid', () => {
  // `ANTONINA_BUILD_COMMIT= npm run build` must not fail the build over an
  // empty variable; it must fall through to git like no override at all.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const identity = resolveBuildIdentity({ repoRoot, env: { ANTONINA_BUILD_COMMIT: '' } });
  assert.equal(identity.cli.commit, head);
  assert.equal(identity.cli.source, 'git');
});

test('no git and no override is a loud failure, never a silent unknown', () => {
  // A non-repository directory is the shape of the "absent .git" case.
  const empty = mkdtempSync(join(tmpdir(), 'antonina-no-git-'));
  try {
    assert.throws(
      () => resolveBuildIdentity({ repoRoot: empty, env: {} }),
      (error) => error instanceof BuildIdentityError
        && /cannot determine the source Git commit/.test(error.message)
        && /ANTONINA_BUILD_COMMIT/.test(error.message),
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the generator exits non-zero and writes nothing when it cannot derive a commit', () => {
  const empty = mkdtempSync(join(tmpdir(), 'antonina-no-git-'));
  const outputs = join(empty, 'cli.ts');
  const result = spawnSync(process.execPath, [generator], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: empty,
    env: { ...process.env, ANTONINA_BUILD_COMMIT: undefined, PATH: '/nonexistent' },
  });
  try {
    assert.notEqual(result.status, 0, 'a build that cannot name its revision must not succeed');
    assert.match(result.stderr, /cannot determine the source Git commit/);
    assert.equal(existsSync(outputs), false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the generated modules are ignored, not committed', () => {
  // A committed copy would be a hand-maintained constant wearing a generated
  // file's name: it would go stale silently and look derived.
  //
  // `git check-ignore -q` is asked once per path, because `--quiet` takes a
  // single pathname and exits 128 on two, and its exit status is the answer:
  // 0 means ignored, 1 means not.
  for (const generated of [CLI_GENERATED, WEB_GENERATED]) {
    const relative = generated.slice(repoRoot.length + 1);
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', relative], {
      cwd: repoRoot, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${relative} must be gitignored`);
  }
  const tracked = execFileSync('git', ['ls-files', '--',
    'packages/cli/src/build-identity.generated.ts', 'web/build-identity.generated.ts'],
  { encoding: 'utf8' }).trim();
  assert.equal(tracked, '');
});

test('regenerating is deterministic: no timestamp, no churn between runs', () => {
  const first = runGenerator();
  assert.equal(first.status, 0, first.stderr);
  const before = [CLI_GENERATED, WEB_GENERATED].map((f) => readFileSync(f, 'utf8'));
  const second = runGenerator();
  assert.equal(second.status, 0, second.stderr);
  const after = [CLI_GENERATED, WEB_GENERATED].map((f) => readFileSync(f, 'utf8'));
  assert.deepEqual(after, before, 'two builds of one commit must produce identical files');
  // Belt and braces on the same property: no date-shaped value is written.
  for (const text of after) {
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    assert.match(text, /GENERATED FILE - do not edit/);
  }
});

test('rendered modules carry the identity and declare no fallback value', () => {
  const identity = resolveBuildIdentity({ repoRoot, env: {} });
  for (const [name, text] of [['cli', renderCliModule(identity.cli)], ['web', renderWebModule(identity.web)]]) {
    assert.match(text, new RegExp(`commit: "${identity.cli.commit}"`), name);
    assert.doesNotMatch(text, /unknown/i, `${name} module must contain no "unknown" identity value`);
  }
  // The web module is the one that becomes a deployed artifact, so its
  // provenance object has to carry the full commit too.
  const web = renderWebModule(identity.web);
  assert.match(web, /WEB_BUILD_PROVENANCE/);
  assert.match(web, /surface: 'web'/);
});
