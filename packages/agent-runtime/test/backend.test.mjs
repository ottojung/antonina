import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function selectExecRoot(prefix, parents = [tmpdir(), REPO_FIXTURE_PARENT], probe = execProbe) {
  const failures = [];
  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      failures.push(`${parent}: cannot create fixture parent (${error.message})`);
      continue;
    }
    const outcome = probe(parent, prefix);
    if (outcome.ok) return mkdtempSync(join(parent, prefix));
    failures.push(`${parent}: ${outcome.reason}`);
  }
  const error = new Error(
    `no exec-capable fixture directory for the fake opencode; tried: ${failures.join('; ')}`,
  );
  error.code = 'ANTONINA_FIXTURE_NOEXEC';
  throw error;
}

function fixture(t) {
  const root = selectExecRoot('antonina-backend-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    try { rmSync(REPO_FIXTURE_PARENT, { recursive: false }); } catch {}
  });
  return root;
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

test('fixture guard: a non-exec-able fixture location is a named failure, never a substitution', () => {
  assert.throws(
    () => selectExecRoot('antonina-backend-', ['/tmp', '/workspace'], () => ({ ok: false, reason: 'EACCES' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      assert.match(error.message, /\/tmp: EACCES/);
      assert.match(error.message, /\/workspace: EACCES/);
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
