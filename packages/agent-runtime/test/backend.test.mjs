import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AGENT_MODEL,
  BACKEND_DIAGNOSTIC_MAX_BYTES,
  BACKEND_RETRY_BASE_MS,
  DEFAULT_OPENCODE_BIN,
  OPENCODE_BIN_ENV,
  backendRetryDelay,
  buildAgentCommand,
  classifyBackendFailure,
  configuredModelAvailable,
  resolveOpencode,
  sanitizeBackendError,
} from '../dist/packages/agent-runtime/src/backend.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-FIXTURE-EXEC-OK';

// A fixture backend is only useful if it can actually exec. On a host whose
// tmpdir() is mounted noexec the fake would fail with EACCES and a bare
// `opencode` lookup would then fall through to a real host backend. Probe
// candidate parents and fail loudly instead of substituting another program.
function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  if (result.error) return { ok: false, reason: String(result.error.code ?? result.error.message) };
  if (result.status !== 0) return { ok: false, reason: `probe exited with status ${result.status}` };
  if (result.stdout.trim() !== PROBE_SENTINEL) {
    return { ok: false, reason: `probe produced ${JSON.stringify(result.stdout)}` };
  }
  return { ok: true, reason: 'exec ok' };
}

// Removing the repo-local fixture parent is best effort, and only ever happens
// once it is empty: rmdir fails with ENOTEMPTY while a sibling suite's root is
// still live, which is expected. Any other failure is a real leftover and is
// reported rather than swallowed. (`rmSync(path, { recursive: false })` cannot
// be used here: on a directory it fails EISDIR on Node 22+, which is why the
// earlier bare `catch {}` never removed anything.)
function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t?.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

// The root's cleanup is registered here, inside selectExecRoot, at the moment
// the directory is created and before the no-exec throw path can be reached:
// a probe failure, a mid-suite abort or a stray file must not leave a directory
// in the worktree.
function selectExecRoot(prefix, parents = [tmpdir(), REPO_FIXTURE_PARENT], probe = execProbe, t) {
  const failures = [];
  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      failures.push(`${parent}: cannot create fixture parent (${error.message})`);
      continue;
    }
    const outcome = probe(parent, prefix);
    if (outcome.ok) {
      const root = mkdtempSync(join(parent, prefix));
      t?.after(() => {
        rmSync(root, { recursive: true, force: true });
        pruneFixtureParent(t);
      });
      return root;
    }
    failures.push(`${parent}: ${outcome.reason}`);
  }
  pruneFixtureParent(t);
  const error = new Error(
    `no exec-capable fixture directory for the fake opencode; tried: ${failures.join('; ')}`,
  );
  error.code = 'ANTONINA_FIXTURE_NOEXEC';
  throw error;
}

function fixture(t) {
  return selectExecRoot('antonina-backend-', undefined, undefined, t);
}

test('recognized OpenCode server failure becomes bounded structured diagnostics', (t) => {
  const root = fixture(t);
  const log = join(root, 'output.log');
  writeFileSync(log, 'old failure\n');
  const start = Buffer.byteLength('old failure\n');
  writeFileSync(
    log,
    'old failure\n{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_abc123"}}\n',
  );
  const error = classifyBackendFailure(log, start, 1, false);
  assert.equal(error?.classification, 'transient_backend_server_error');
  assert.equal(error?.reference, 'err_abc123');
  assert.equal(error?.request_boundary, 'fresh_session');
  assert.equal(error?.fresh_session_useful, false);
  assert.equal(error?.transient, true);
  assert.equal(error?.automatic_retry_safe, false);
  assert.ok((error?.diagnostic_bytes ?? Infinity) <= BACKEND_DIAGNOSTIC_MAX_BYTES);
});

test('ordinary task failure is not misclassified and continuation stays explicit', (t) => {
  const root = fixture(t);
  const log = join(root, 'output.log');
  writeFileSync(log, 'deterministic task failure\n');
  assert.equal(classifyBackendFailure(log, 0, 1), null);

  writeFileSync(log, 'Unexpected server error\n');
  const continuation = classifyBackendFailure(log, 0, 1, true);
  assert.equal(continuation?.request_boundary, 'continuation');
  assert.equal(continuation?.fresh_session_useful, null);
});

test('retry policy requires positive replay-safety evidence and is bounded', () => {
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: false }, 0), null);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 0), BACKEND_RETRY_BASE_MS);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 1), BACKEND_RETRY_BASE_MS * 2);
  assert.equal(backendRetryDelay({ classification: 'x', transient: true, automatic_retry_safe: true }, 2), null);
});

test('status sanitizer drops arbitrary persisted backend data', () => {
  const sanitized = sanitizeBackendError({
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    model: AGENT_MODEL,
    request_boundary: 'continuation',
    reference: 'err_abc',
    transient: true,
    automatic_retry_safe: false,
    fresh_session_useful: null,
    backend_scope: 'unknown',
    diagnostic_bytes: 42,
    secret: 'must-not-escape',
  });
  assert.deepEqual(sanitized, {
    classification: 'transient_backend_server_error',
    provider: 'opencode',
    model: AGENT_MODEL,
    request_boundary: 'continuation',
    reference: 'err_abc',
    transient: true,
    automatic_retry_safe: false,
    fresh_session_useful: null,
    backend_scope: 'unknown',
    diagnostic_bytes: 42,
  });
  assert.equal(sanitizeBackendError({ classification: '' }), null);
});

test('configured model catalog distinguishes absence from transport failure', (t) => {
  const root = fixture(t);
  const bin = join(root, 'opencode');
  const pathBin = join(root, 'path-bin');
  mkdirSync(pathBin);
  const escapes = join(root, 'path-escapes.log');
  const calls = join(root, 'fixture-calls.log');
  // Any bare `opencode` lookup in this environment must land on the recorded
  // trap, never on a real host backend.
  writeFileSync(join(pathBin, 'opencode'), `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >>'${escapes}'
exit 70
`, { mode: 0o755 });
  writeFileSync(bin, `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >>'${calls}'
if [ "$1" = models ]; then
  printf "%s\\n" other/model opencode/space-bunny-free
  exit 0
fi
exit 2
`, { mode: 0o755 });

  const env = { [OPENCODE_BIN_ENV]: bin, PATH: pathBin };
  assert.equal(env[OPENCODE_BIN_ENV], bin);
  assert.ok(isAbsolute(bin));
  // Positive control: the fixture is exec-able at the exact path that is passed
  // to the production code.
  const direct = spawnSync(bin, ['models'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(direct.status, 0, `fixture is not runnable: ${direct.error?.code ?? direct.stderr}`);
  assert.match(direct.stdout, new RegExp(AGENT_MODEL));

  rmSync(calls, { force: true });
  assert.equal(configuredModelAvailable(env), true);
  assertFixtureRan(bin, calls, escapes);

  writeFileSync(bin, '#!/bin/sh\necho other/model\n', { mode: 0o755 });
  assert.equal(configuredModelAvailable(env), false);
  assertFixtureRan(bin, calls, escapes);

  writeFileSync(bin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(configuredModelAvailable(env), null);
  assertFixtureRan(bin, calls, escapes);
});

function recordedInvocations(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function assertFixtureRan(bin, calls, escapes) {
  assert.deepEqual(
    recordedInvocations(escapes),
    [],
    'a non-fixture opencode was executed via PATH',
  );
  const recorded = recordedInvocations(calls);
  assert.ok(recorded.length > 0, 'the fixture backend did not run');
  for (const line of recorded) {
    assert.equal(line.split(' ')[0], bin, `a different program ran as the backend: ${line}`);
  }
  assert.equal(recorded.at(-1).split(' ').slice(1).join(' '), 'models');
}

test('backend executable resolves to an exact configured path, not a PATH lookup', (t) => {
  const root = fixture(t);
  const bin = join(root, 'opencode');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.equal(resolveOpencode({}), DEFAULT_OPENCODE_BIN);
  assert.equal(resolveOpencode({ PATH: '/nowhere' }), DEFAULT_OPENCODE_BIN);
  assert.equal(resolveOpencode({ [OPENCODE_BIN_ENV]: bin }), bin);

  const meta = idleMeta('a11d', root, null, 1);
  const fresh = buildAgentCommand(meta, 'work', false, { [OPENCODE_BIN_ENV]: bin });
  assert.equal(fresh[0], bin, 'buildAgentCommand must not fall back to a bare backend name');
  assert.equal(buildAgentCommand(meta, 'work', false, {})[0], DEFAULT_OPENCODE_BIN);
});

test('a malformed backend override is rejected instead of silently ignored', () => {
  for (const value of ['', ' ', ' opencode', 'opencode ', '-opencode']) {
    assert.throws(
      () => resolveOpencode({ [OPENCODE_BIN_ENV]: value }),
      new RegExp(OPENCODE_BIN_ENV),
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test('a non-absolute backend override is refused, so it cannot fall back to PATH', () => {
  // spawn() would resolve these against PATH (or the cwd) and could run a real
  // host backend, which is the defect the override exists to prevent.
  for (const value of ['opencode', './bin/opencode', '../bin/opencode', 'bin/opencode']) {
    assert.throws(
      () => resolveOpencode({ [OPENCODE_BIN_ENV]: value }),
      new RegExp(`${OPENCODE_BIN_ENV} must be an absolute path`),
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
  assert.equal(resolveOpencode({ [OPENCODE_BIN_ENV]: '/opt/opencode/bin/opencode' }), '/opt/opencode/bin/opencode');
});

test('fixture guard: a non-exec-able fixture location is a named failure, never a substitution', (t) => {
  // The candidate parents are directories this suite owns and has just created,
  // never host paths like `/tmp` or `/workspace`. Whether the host lets a test
  // `mkdir /workspace` is the host's business, not the invariant under test:
  // an uncreatable parent reports through the *create* branch, which says
  // "cannot create fixture parent", not the probe reason this case is about.
  // Pinning host paths here made the guard assert the create-failure wording on
  // a runner that refuses the mkdir, so it failed there while passing locally.
  const base = mkdtempSync(join(tmpdir(), 'antonina-fixture-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const parents = [join(base, 'noexec-a'), join(base, 'noexec-b')];

  assert.throws(
    () => selectExecRoot('antonina-backend-', parents, () => ({ ok: false, reason: 'EACCES' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      for (const parent of parents) {
        assert.ok(
          error.message.includes(`${parent}: EACCES`),
          `expected a per-parent EACCES reason for ${parent}, got: ${error.message}`,
        );
      }
      // No substitution: a bare `opencode` lookup must never become the fallback.
      assert.doesNotMatch(error.message, /cannot create fixture parent/);
      return true;
    },
  );
});

test('fixture guard: an uncreatable fixture parent is a named failure, never a substitution', (t) => {
  // The other branch of the same fail-closed guard, pinned with a parent that
  // cannot be created on any host and for any user: a path underneath a regular
  // file fails ENOTDIR even as root, where a permission-based fixture would
  // succeed.
  const base = mkdtempSync(join(tmpdir(), 'antonina-fixture-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const blocker = join(base, 'blocker');
  writeFileSync(blocker, 'not a directory\n');
  const parents = [join(blocker, 'nested'), join(blocker, 'other')];

  assert.throws(
    () => selectExecRoot('antonina-backend-', parents, () => ({ ok: true, reason: 'exec ok' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      for (const parent of parents) {
        assert.ok(
          error.message.includes(`${parent}: cannot create fixture parent`),
          `expected a per-parent create failure for ${parent}, got: ${error.message}`,
        );
      }
      return true;
    },
  );
});

test('continuation command uses persisted session and configured variant', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  meta.native_session_id = 'ses_123';
  meta.variant = 'high';
  assert.deepEqual(buildAgentCommand(meta, 'continue work', true, {}), [
    'opencode', 'run', '--auto',
    '--session', 'ses_123',
    '--model', AGENT_MODEL,
    '--variant', 'high',
    '--thinking',
    '--dir', '/tmp',
    'continue work',
  ]);
});


test('agent command rejects malformed durable cwd and variant', () => {
  for (const cwd of ['', 0, false, null, [], 'relative', './relative', '../relative']) {
    const meta = idleMeta('a11d', '/tmp', null, 1);
    meta.cwd = cwd;
    assert.throws(() => buildAgentCommand(meta, 'work', false, {}), /cwd is malformed/);
  }
  for (const variant of [null, '', 0, 123, true, false, 1.5, [], {}]) {
    const meta = idleMeta('a11d', '/tmp', null, 1);
    meta.variant = variant;
    assert.throws(() => buildAgentCommand(meta, 'work', false, {}), /variant is malformed/);
  }
});
