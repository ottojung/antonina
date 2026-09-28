import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Board issue 76: the CLI could not say which build it was.
//
// Every assertion here pairs the printed text with the process exit status,
// because the defect being fixed was precisely that pairing: `--version` used to
// be answered by the usage-error branch and reported success while doing it. A
// test that only checked stdout would have passed against the broken build, so
// the exit code is asserted in each case rather than in one of them.

// Resolved from this file, not from process.cwd(): `node --test` runs a suite
// with the working directory set to the suite's own directory, so a repo-root
// path built from cwd resolves to packages/packages/... and every case fails with
// a module-not-found that has nothing to do with what is under test.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'packages', 'cli', 'src', 'main.js');

function runCli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    // A test-owned state and config home, so a version query cannot read or
    // write the operator's durable state or board credential.
    env: { ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'antonina-version-state-')), XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'antonina-version-config-')), ...env },
  });
  assert.equal(result.error, undefined, `CLI failed to run: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('--version prints the identity and exits 0', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0, `--version must exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /^antonina \d+\.\d+\.\d+ \(/m);
  // The full object name, not only the short one. A 12-character prefix is a
  // prefix; matching a rollback record needs the commit itself.
  assert.match(result.stdout, /^commit [0-9a-f]{40}$/m, result.stdout);
  assert.equal(result.stderr, '');
});

test('-V is the short form and behaves identically', () => {
  const long = runCli(['--version']);
  const short = runCli(['-V']);
  assert.equal(short.status, 0, `-V must exit 0, got ${short.status}: ${short.stderr}`);
  assert.equal(short.stdout, long.stdout);
});

test('--version --json emits a machine-readable identity and exits 0', () => {
  const result = runCli(['--version', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.name, 'antonina');
  assert.match(parsed.version, /^\d+\.\d+\.\d+/);
  assert.match(parsed.commit, /^[0-9a-f]{40}$/);
  assert.ok(parsed.commit.startsWith(parsed.shortCommit));
  assert.equal(typeof parsed.dirty, 'boolean');
  assert.ok(['git', 'env'].includes(parsed.commitSource));
  // The text and JSON forms must agree, or an operator reading one and a script
  // reading the other are told different things.
  assert.equal(parsed.version, runCli(['--version']).stdout.match(/^version (\S+)$/m)[1]);
});

test('a genuine usage error still exits non-zero', () => {
  // The regression the issue names. Before the fix this branch was the only
  // thing `--version` could reach, and it exited 0.
  for (const args of [['board'], ['nonsense'], ['--nope']]) {
    const result = runCli(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} must exit non-zero`);
    assert.match(result.stderr, /antonina:/);
  }
});

test('a malformed --version invocation is a usage error, not a silent success', () => {
  const result = runCli(['--version', 'extra-argument']);
  assert.equal(result.status, 2, `stray argument must exit 2, got ${result.status}`);
  assert.match(result.stderr, /unexpected argument to --version/);
  assert.equal(result.stdout, '');
});

test('the reported commit is this checkout\'s commit, not a stored constant', () => {
  // Provenance has to be derived, so it must equal what Git says about the tree
  // the binary was built from. A hardcoded value in a source file would fail
  // here the first time the branch moved.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const reported = JSON.parse(runCli(['--version', '--json']).stdout);
  assert.equal(reported.commit, head);
  assert.equal(reported.commitSource, 'git');
});

test('--help still exits 0 and is unaffected by the version branch', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: antonina/);
});
