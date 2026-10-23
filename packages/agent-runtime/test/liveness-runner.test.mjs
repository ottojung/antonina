import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, updateMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const LUNA = 'example.test/luna';
const BEAM = 'example.test/beam';
const nonRecoverable = new Set(['pending-tool', 'no-session', 'startup-no-session', 'error-auth']);

async function exercise(t, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-live-failover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config', 'antonina');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ models: [
    { model: LUNA, comment: 'fixture' }, { model: BEAM, comment: 'fixture' },
  ] }));
  const bin = join(root, 'opencode');
  const calls = join(root, 'calls.log');

  const jsonShell = (value) => "printf '%s\\n' '" + JSON.stringify(value) + "'";
  let eventCommand = jsonShell({ type: 'step_start', sessionID: 'ses_liveness', part: { type: 'step-start' } });
  if (fixture === 'pending-tool') {
    eventCommand = jsonShell({ type: 'tool_use', sessionID: 'ses_liveness',
      part: { type: 'tool', state: { status: 'running' } } });
  } else if (fixture === 'finished-tool') {
    eventCommand = jsonShell({ type: 'step_finish', sessionID: 'ses_liveness', part: { reason: 'tool-calls' } });
  } else if (fixture === 'no-session') {
    eventCommand = 'echo "unstructured backend output"';
  } else if (fixture === 'startup-no-session' || fixture === 'startup-resume') {
    eventCommand = ':';
  } else if (fixture.startsWith('error-')) {
    const code = fixture === 'error-quota' ? 429 : fixture === 'error-503' ? 503 : 401;
    const message = fixture === 'error-quota' ? 'The usage limit has been reached'
      : fixture === 'error-503' ? 'Gateway error' : 'invalid_api_key';
    eventCommand = jsonShell({
      type: 'error', sessionID: 'ses_liveness', error: {
        name: 'APIError', data: { message, statusCode: code, isRetryable: true },
      },
    }) + "\nprintf '\\033[0m> build · beam-free\\n'";
  }
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "session" ]; then echo "[]"; exit 0; fi',
    'model=""',
    'session=""',
    'format=""',
    'prev=""',
    'for x in "$@"; do',
    '  if [ "$prev" = "--model" ]; then model="$x"; fi',
    '  if [ "$prev" = "--session" ]; then session="$x"; fi',
    '  if [ "$prev" = "--format" ]; then format="$x"; fi',
    '  prev="$x"',
    'done',
    '[ "$format" = "json" ] || exit 48',
    'echo "$model" >> "$ANTONINA_LIVENESS_CALLS"',
    'if [ "$model" = "example.test/luna" ]; then',
    eventCommand,
    '  sleep 3600',
    '  exit 1',
    'fi',
    '[ "$session" = "ses_liveness" ] || exit 49',
    'echo "BACKEND_SUCCEEDED"',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(bin, script, { mode: 0o755 });

  const env = {
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    ANTONINA_OPENCODE_BIN: bin,
    ANTONINA_LIVENESS_CALLS: calls,
    ANTONINA_RUNNER_OWNER_TOKEN: mintRunnerReservationOwnerToken(),
  };
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  const id = 'liveness-' + fixture;
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const options = { env, modelStepSilenceMs: 700, backendErrorGraceMs: 700, livenessPollMs: 200 };
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null);
  const mode = fixture === 'resume' || fixture === 'startup-resume' ? 'continue' : 'new';
  if (mode === 'continue') meta.native_session_id = 'ses_liveness';
  meta.runner_gen = 1;
  meta.runner_reservation = {
    state: 'reserved', gen: 1, mode, reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: procStartTicks(process.pid),
    owner_token: env.ANTONINA_RUNNER_OWNER_TOKEN,
  };
  meta.pending_prompt = 'Work on a pure thought experiment.';
  writeMeta(id, meta, options);

  const original = {};
  for (const [key, value] of Object.entries(env)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const promise = runManagedRunner(id, mode, 1, options);
    if (nonRecoverable.has(fixture)) {
      await sleep(2300);
      const during = readMeta(id, options);
      assert.equal(during.state, 'running');
      assert.equal(during.model_failover?.cooldowns?.length ?? 0, 0);
      await updateMeta(id, m => { m.intent = 'stop'; }, options);
    }
    await promise;
  } finally {
    for (const key of Object.keys(env)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
  const finished = readMeta(id, options);
  const called = readFileSync(calls, 'utf8').trim().split('\n');
  if (nonRecoverable.has(fixture)) {
    assert.equal(finished.state, 'stopped');
    assert.deepEqual(called, [LUNA]);
    assert.equal(finished.model_failover.cooldowns.length, 0);
  } else {
    assert.equal(finished.state, 'succeeded', JSON.stringify({ state: finished.state, error: finished.error }));
    assert.equal(finished.model_failover.selected_model, BEAM);
    assert.equal(finished.model_failover.cooldowns[0].reason,
      fixture === 'error-quota' ? 'quota_exhausted' : 'transient_backend');
    assert.equal(finished.native_session_id, 'ses_liveness');
    assert.deepEqual(called, [LUNA, BEAM]);
  }
}

test('quiet model step switches to Beam and resumes the exact conversation', { timeout: 45000 }, t => exercise(t, 'fresh'));
test('quiet resumed model step switches to Beam with the same native session', { timeout: 45000 }, t => exercise(t, 'resume'));
test('silent resumed startup switches models while preserving the native session', { timeout: 45000 }, t => exercise(t, 'startup-resume'));
test('structured HTTP 429 hang triggers quota cooldown and same-session failover', { timeout: 45000 }, t => exercise(t, 'error-quota'));
test('structured HTTP 503 hang triggers transient cooldown and same-session failover', { timeout: 45000 }, t => exercise(t, 'error-503'));
test('finished tool step with no further progress switches to Beam', { timeout: 45000 }, t => exercise(t, 'finished-tool'));
test('pending tool never triggers model failover', { timeout: 45000 }, t => exercise(t, 'pending-tool'));
test('unstructured output never authorizes a model restart', { timeout: 45000 }, t => exercise(t, 'no-session'));
test('silent fresh startup without a native session is not replayed', { timeout: 45000 }, t => exercise(t, 'startup-no-session'));
test('HTTP 401 authentication errors are never switched as model failures', { timeout: 45000 }, t => exercise(t, 'error-auth'));
