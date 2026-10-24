import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { createAgentDirectory, readMeta, writeMeta, updateMeta } from '../dist/packages/agent-runtime/src/store.js';
import { runManagedRunner, reconciliationPrompt, recoverableModelFailure, recoveryDelayMs } from '../dist/packages/agent-runtime/src/runner.js';

function fixture(t, { withSession = true, failures = 3, diagnostic = 'Unexpected server error' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-transient-recovery-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const cwd = join(root, 'work');
  const state = join(root, 'state');
  const config = join(root, 'config');
  mkdirSync(cwd);
  mkdirSync(state);
  mkdirSync(join(config, 'antonina'), { recursive: true });
  writeFileSync(join(config, 'antonina', 'config.json'),
    JSON.stringify({ models: [{ model: 'fixture.mock/transient', comment: 'isolated fixture' }] }));
  const counter = join(root, 'counter');
  const calls = join(root, 'calls');
  const backend = join(root, 'opencode');
  const code = [
    '#!/bin/sh',
    'if [ "$1" = models ]; then echo fixture.mock/transient; exit 0; fi',
    'if [ "$1" = session ]; then echo "[]"; exit 0; fi',
    'printf "%s\n" "$*" >> "$RECOVERY_CALLS"',
    'n=0; if [ -f "$RECOVERY_COUNTER" ]; then n=$(cat "$RECOVERY_COUNTER"); fi',
    'n=$((n+1)); printf "%s\n" "$n" > "$RECOVERY_COUNTER"',
    withSession ? "printf '%s\\n' '{\"type\":\"step_start\",\"sessionID\":\"ses_recovery\"}'" : ':',
    'if [ "$n" -le "$RECOVERY_FAILURES" ]; then echo "Error: ' + diagnostic + '"; exit 1; fi',
    'printf "%s\n" "SUCCESS_RECONCILED"; exit 0',
  ].join('\n') + '\n';
  writeFileSync(backend, code, { mode: 0o755 });
  chmodSync(backend, 0o755);
  const check = spawnSync(backend, ['models'], { encoding: 'utf8' });
  assert.equal(check.status, 0);
  const token = mintRunnerReservationOwnerToken();
  const env = {
    XDG_STATE_HOME: state, XDG_CONFIG_HOME: config,
    ANTONINA_OPENCODE_BIN: backend, ANTONINA_RUNNER_OWNER_TOKEN: token,
    RECOVERY_CALLS: calls, RECOVERY_COUNTER: counter, RECOVERY_FAILURES: String(failures),
  };
  const id = 'recoverfixture';
  const options = { env };
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, 'Transient recovery fixture', 1);
  meta.runner_gen = 7;
  meta.runner_reservation = {
    state: 'reserved', gen: 7, mode: 'new', reserved_at: 1,
    owner_pid: process.pid, owner_start_ticks: procStartTicks(process.pid),
    owner_token: token,
  };
  meta.pending_prompt = 'ORIGINAL_SIDE_EFFECTING_INSTRUCTION';
  writeMeta(id, meta, options);
  return { id, root, counter, calls, options };
}

const bounded = { timeout: 35_000 };

test('recovery prompt explicitly distinguishes continuing from re-playing', () => {
  const fromSession = reconciliationPrompt('ORIGINAL_DO_NOT_REPEAT', true);
  const fresh = reconciliationPrompt('ORIGINAL_DO_NOT_REPEAT', false);
  assert.doesNotMatch(fromSession, /ORIGINAL_DO_NOT_REPEAT/);
  assert.match(fresh, /ORIGINAL_DO_NOT_REPEAT/);
  assert.match(fresh, /CONTEXT/);
  assert.match(fromSession, /Do NOT repeat/);
  assert.equal(recoverableModelFailure({ classification: 'transient_backend_server_error', transient: true }),
    'transient_backend');
  assert.equal(recoverableModelFailure({ classification: 'new_5xx', transient: true }), 'transient_backend');
  assert.equal(recoverableModelFailure({ classification: 'backend_statement_execution_error', transient: false }), null);
  assert.equal(recoveryDelayMs(1000, 0), 30_000);
});

test('four consecutive transient 5xx failures retain the same session and ultimately complete', bounded, async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t);
  await runManagedRunner(f.id, 'new', 7, f.options);
  const meta = readMeta(f.id, f.options);
  assert.equal(meta.state, 'succeeded');
  assert.equal(meta.active_runner, false);
  assert.equal(meta.prompt_count, 0, 'direct runner fixture, not the CLI acceptor, owns prompt count');
  assert.equal(meta.backend_error, null);
  assert.equal(meta.native_session_id, 'ses_recovery');
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').filter((line) => line.startsWith('run --auto'));
  assert.equal(calls.length, 4);
  assert.match(calls[0], /ORIGINAL_SIDE_EFFECTING_INSTRUCTION/);
  for (const call of calls.slice(1)) {
    assert.match(call, /--session ses_recovery/);
    assert.match(call, /Antonina is recovering/);
    assert.doesNotMatch(call, /ORIGINAL_SIDE_EFFECTING_INSTRUCTION/);
  }
  assert.equal(Number(readFileSync(f.counter, 'utf8')), 4);
});

test('without a native session, transient errors use a fresh reconciliation task, not replay', bounded, async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, { withSession: false, failures: 1 });
  await runManagedRunner(f.id, 'new', 7, f.options);
  const meta = readMeta(f.id, f.options);
  assert.equal(meta.state, 'succeeded');
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').filter((line) => line.startsWith('run --auto'));
  assert.equal(calls.length, 2);
  assert.match(calls[0], /ORIGINAL_SIDE_EFFECTING_INSTRUCTION$/);
  assert.match(readFileSync(f.calls, 'utf8'), /CONTEXT/);
  assert.match(calls[1], /Do NOT repeat/);
  assert.doesNotMatch(calls[1], /--session/);
});

test('permanent unrecognized backend errors still fail instead of looping', bounded, async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, { withSession: true, failures: 10, diagnostic: 'Failed to execute statement' });
  await runManagedRunner(f.id, 'new', 7, f.options);
  const meta = readMeta(f.id, f.options);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.backend_error.classification, 'backend_statement_execution_error');
  assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
});

test('operator stop preempts indefinite transient recovery without replaying work', bounded, async (t) => {
  if (procStartTicks(process.pid) === null) return t.skip('requires /proc');
  const f = fixture(t, { failures: 999 });
  const task = runManagedRunner(f.id, 'new', 7, f.options);
  let observed = false;
  for (let i = 0; i < 200; i += 1) {
    const meta = readMeta(f.id, f.options);
    if (meta.state === 'running' && meta.backend_error?.classification === 'transient_backend_server_error') {
      observed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(observed, true, 'retry was not observable as an active recovery');
  await updateMeta(f.id, (current) => { current.intent = 'stop'; }, f.options);
  await task;
  const meta = readMeta(f.id, f.options);
  assert.equal(meta.state, 'stopped', 'operator control takes priority over recovery');
  assert.equal(meta.active_runner, false);
  assert.ok(Number(readFileSync(f.counter, 'utf8')) < 4, 'control cancelled retries promptly');
});
