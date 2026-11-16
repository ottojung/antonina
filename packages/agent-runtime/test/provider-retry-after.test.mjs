import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyBackendFailure, providerCooldownSeconds } from '../dist/packages/agent-runtime/src/backend.js';
import { InvocationActivity, MODEL_STEP_SILENCE_MS, recoverableOpenCodeError } from '../dist/packages/agent-runtime/src/liveness.js';
import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  adoptSharedModelCooldowns, modelAvailability, recordSharedModelCooldown, sharedModelCooldowns,
  withSharedModelCooldowns,
} from '../dist/packages/agent-runtime/src/model-cooldowns.js';
import { coolDownAgentModel, PERMANENT_EXCLUSION_UNTIL } from '../dist/packages/agent-runtime/src/model-failover.js';
import { procStartTicks, readProcStat } from '../dist/packages/agent-runtime/src/process.js';
import {
  MAX_PROVIDER_COOLDOWN_SECONDS, lastProviderErrorEvent, providerRetryAfterSeconds, typedProviderFailure,
} from '../dist/packages/agent-runtime/src/provider-errors.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const LUNA = 'example.test/luna';
const BEAM = 'example.test/beam';
const PREFS = [{ model: LUNA, comment: 'fixture' }, { model: BEAM, comment: 'fixture' }];

// The exact shapes recorded in billy-dev agent logs, 2026-11-06..15.
const RATE_LIMIT = { type: 'provider.rate-limit', message: 'Rate limit exceeded. Please try again later.', status: 429,
  response: { body: '{"error":{"type":"rate_limit_error","message":"Rate limit exceeded. Please try again later."}}' },
  retryAfterMs: 71_818_000 };
const GO_QUOTA = { type: 'provider.quota',
  message: 'OpenCode Go usage limit reached (weekly, resets in 2d 18h). To keep going now, turn on Extra Usage' };
const FREE_LIMIT = { type: 'provider.free-limit',
  message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.' };
const OAUTH_LIMIT = { type: 'provider.invalid-request',
  message: 'ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.' };

test('OpenCode V2 typed provider errors are classified, not left unrecognized', () => {
  assert.equal(typedProviderFailure(RATE_LIMIT), 'upstream_rate_limited');
  assert.equal(typedProviderFailure(GO_QUOTA), 'model_quota_exhausted');
  assert.equal(typedProviderFailure(FREE_LIMIT), 'model_quota_exhausted');
  assert.equal(typedProviderFailure(OAUTH_LIMIT), 'model_quota_exhausted');
  assert.equal(typedProviderFailure({ type: 'provider.no-route', message: 'Variant unavailable for x/y: low' }), 'model_unavailable');
  assert.equal(typedProviderFailure({ type: 'provider.internal', message: 'server_error' }), 'transient_backend_server_error');
  assert.equal(typedProviderFailure({ type: 'provider.invalid-request', message: 'bad schema' }), null,
    'an ordinary invalid request is not model-switching authority');
  assert.equal(typedProviderFailure({ type: 'unknown', message: 'Transport: ECONNRESET' }), null);
  assert.equal(typedProviderFailure({ name: 'APIError', data: { statusCode: 429 } }), null, 'legacy shape is handled elsewhere');
  for (const error of [RATE_LIMIT, GO_QUOTA, FREE_LIMIT, OAUTH_LIMIT]) {
    assert.equal(recoverableOpenCodeError({ type: 'error', sessionID: 'ses_x', error }), typedProviderFailure(error));
  }
});

test('the provider-stated wait is honoured, bounded and never invented', () => {
  assert.equal(providerRetryAfterSeconds(RATE_LIMIT), 71_818 + 30);
  assert.equal(providerRetryAfterSeconds(GO_QUOTA), 2 * 86_400 + 18 * 3_600 + 30);
  assert.equal(providerRetryAfterSeconds({ message: 'limit reached (resets in 5h 3m)' }), 5 * 3_600 + 180 + 30);
  assert.equal(providerRetryAfterSeconds({ retryAfterMs: 1_000 }), 60, 'never shorter than a minute');
  assert.equal(providerRetryAfterSeconds({ retryAfterMs: 1e15 }), MAX_PROVIDER_COOLDOWN_SECONDS);
  assert.equal(providerRetryAfterSeconds(FREE_LIMIT), null, 'no hint means the caller keeps its default');
  assert.equal(providerRetryAfterSeconds({ retryAfterMs: -5 }), null);
  assert.equal(providerRetryAfterSeconds(null), null);
});

test('only a top-level error event can supply the retry hint', () => {
  const tool = JSON.stringify({ type: 'tool_use', sessionID: 'ses_x',
    part: { output: JSON.stringify({ type: 'error', error: { retryAfterMs: 999_000_000 } }) } });
  const real = JSON.stringify({ type: 'error', sessionID: 'ses_x', error: RATE_LIMIT });
  assert.equal(lastProviderErrorEvent(tool + '\nprose retryAfterMs 5\n'), null);
  assert.deepEqual(lastProviderErrorEvent(real + '\n' + tool + '\n> build · luna\n'), RATE_LIMIT);

  const dir = mkdtempSync(join(tmpdir(), 'antonina-retry-after-'));
  try {
    const log = join(dir, 'output.log');
    writeFileSync(log, 'earlier invocation\n');
    const start = Buffer.byteLength('earlier invocation\n');
    appendFileSync(log, JSON.stringify({ type: 'error', sessionID: 'ses_x', error: GO_QUOTA }) + '\n');
    assert.equal(providerCooldownSeconds(log, start), 2 * 86_400 + 18 * 3_600 + 30);
    const classified = classifyBackendFailure(log, start, 1, true);
    assert.equal(classified?.classification, 'model_quota_exhausted', 'was unrecognized_backend_failure before');
    assert.equal(classified?.transient, false);
    assert.equal(providerCooldownSeconds(log, Buffer.byteLength(readFileSync(log))), null, 'an empty window has no hint');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a re-issued step_start for the same message does not restart the silence clock', () => {
  const pid = process.pid;
  const ticks = procStartTicks(pid);
  const dir = mkdtempSync(join(tmpdir(), 'antonina-reissue-'));
  const step = (messageID) => JSON.stringify({ type: 'step_start', sessionID: 'ses_live',
    part: { type: 'step-start', messageID } }) + '\n';
  try {
    const log = join(dir, 'output.log');
    writeFileSync(log, '');
    const monitor = new InvocationActivity(log, 0, 0, () => ({ ...readProcStat(pid), state: 'S' }));
    appendFileSync(log, step('msg_a'));
    assert.equal(monitor.observe(pid, ticks, 100, 1000).diagnosis, 'progressing_or_uncertain');
    // OpenCode times the request out and issues it again, twice.
    appendFileSync(log, step('msg_a'));
    assert.equal(monitor.observe(pid, ticks, 700, 1000).diagnosis, 'progressing_or_uncertain');
    appendFileSync(log, step('msg_a'));
    const stalled = monitor.observe(pid, ticks, 1200, 1000);
    assert.equal(stalled.diagnosis, 'model_step_silent', 'measured from the first issue at t=100, not the last at t=1200');
    assert.ok(stalled.silentMs >= 1100);
    // A step for a different message is a new request with a new clock.
    appendFileSync(log, step('msg_b'));
    assert.equal(monitor.observe(pid, ticks, 1300, 1000).diagnosis, 'progressing_or_uncertain');
    // Real progress ends the step clock; ordinary output silence applies again.
    appendFileSync(log, JSON.stringify({ type: 'reasoning', sessionID: 'ses_live' }) + '\n');
    assert.equal(monitor.observe(pid, ticks, 2250, 1000).diagnosis, 'progressing_or_uncertain');
    assert.equal(monitor.observe(pid, ticks, 3300, 1000).diagnosis, 'model_step_silent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(MODEL_STEP_SILENCE_MS < 15 * 60 * 1000, 'must be shorter than the backend request timeout it has to catch');
});

test('shared cooldowns are host-wide, never shortened, and ignore damaged files', () => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-shared-cooldown-'));
  try {
    const options = { env: { XDG_STATE_HOME: join(root, 'state') }, home: join(root, 'home') };
    const now = 1_000_000;
    assert.deepEqual(sharedModelCooldowns(options, now), []);
    recordSharedModelCooldown('agent-a', LUNA, 'rate_limited', now + 7_200, options, now);
    recordSharedModelCooldown('agent-b', LUNA, 'rate_limited', now + 600, options, now);
    assert.deepEqual(sharedModelCooldowns(options, now), [{ model: LUNA, reason: 'rate_limited', until: now + 7_200 }]);
    recordSharedModelCooldown('agent-b', LUNA, 'quota_exhausted', now + 1e12, options, now);
    assert.equal(sharedModelCooldowns(options, now)[0].until, now + MAX_PROVIDER_COOLDOWN_SECONDS);
    assert.deepEqual(sharedModelCooldowns(options, now + MAX_PROVIDER_COOLDOWN_SECONDS + 1), [], 'expired entries carry no authority');
    const dir = join(root, 'state', 'antonina', 'model-cooldowns');
    writeFileSync(join(dir, 'example.test@beam.json'), '{"model":"example.test/beam","reason":"model_unavailable","until":9e15}');
    writeFileSync(join(dir, 'junk.json'), 'not json');
    assert.equal(sharedModelCooldowns(options, now).length, 1, 'only quota and rate limits, well-formed, are shared');
    assert.throws(() => recordSharedModelCooldown('bad id!', LUNA, 'rate_limited', now + 5, options, now));
    assert.equal(readdirSync(dir).filter((file) => file.startsWith('.tmp-')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('availability: soft penalties stay eligible, hard exclusions on every model do not', () => {
  const now = 2_000_000;
  const meta = idleMeta('avail', '/tmp', null);
  assert.equal(modelAvailability(meta, PREFS, [], now).available, true);
  const shared = [{ model: LUNA, reason: 'rate_limited', until: now + 500 }];
  assert.equal(modelAvailability(meta, PREFS, shared, now).available, true, 'Beam is still free');
  assert.equal(meta.model_failover ?? null, idleMeta('avail', '/tmp', null).model_failover ?? null, 'the record itself is not modified');
  coolDownAgentModel(meta, BEAM, 'transient_backend', now);
  assert.equal(modelAvailability(meta, PREFS, shared, now).available, true, 'a soft penalty is not unavailability');
  coolDownAgentModel(meta, BEAM, 'quota_exhausted', now, 9_000);
  const blocked = modelAvailability(meta, PREFS, shared, now);
  assert.equal(blocked.available, false);
  assert.equal(blocked.earliestReturn, now + 500);
  assert.deepEqual(blocked.excluded.map((entry) => entry.model).sort(), [BEAM, LUNA].sort());
  assert.equal(modelAvailability(meta, PREFS, shared, now + 501).available, true, 'the shared cooldown expired');
  coolDownAgentModel(meta, LUNA, 'model_unavailable', now);
  coolDownAgentModel(meta, BEAM, 'model_unavailable', now);
  const permanent = modelAvailability(meta, PREFS, [], now + 10_000);
  assert.equal(permanent.available, false);
  assert.equal(permanent.earliestReturn, null);
  assert.equal(permanent.excluded.find((entry) => entry.model === LUNA).until, PERMANENT_EXCLUSION_UNTIL);

  const view = withSharedModelCooldowns(idleMeta('view', '/tmp', null), shared, now);
  assert.equal(view.model_failover.cooldowns[0].model, LUNA);
  const own = idleMeta('own', '/tmp', null);
  coolDownAgentModel(own, LUNA, 'quota_exhausted', now, 99_999);
  assert.equal(adoptSharedModelCooldowns(own, shared, now), false, 'a longer own exclusion is kept');
});

async function runFixture(t, name, lunaBehaviour, runnerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-retry-after-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config', 'antonina');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ models: PREFS }));
  const bin = join(root, 'opencode');
  const calls = join(root, 'calls.log');
  writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "session" ]; then echo "[]"; exit 0; fi',
    'model=""', 'prev=""',
    'for x in "$@"; do', '  if [ "$prev" = "--model" ]; then model="$x"; fi', '  prev="$x"', 'done',
    'model="${model%%#*}"',
    'echo "$model" >> "$ANTONINA_TEST_CALLS"',
    'if [ "$model" = "example.test/luna" ]; then',
    lunaBehaviour,
    'fi',
    'echo "BACKEND_SUCCEEDED"',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  const env = {
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    ANTONINA_OPENCODE_BIN: bin,
    ANTONINA_TEST_CALLS: calls,
    ANTONINA_RUNNER_OWNER_TOKEN: mintRunnerReservationOwnerToken(),
  };
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const options = { env, ...runnerOptions };
  const launch = async (id) => {
    assert.equal(createAgentDirectory(id, options), true);
    const meta = idleMeta(id, cwd, null);
    meta.native_session_id = 'ses_fixed';
    meta.runner_gen = 1;
    meta.runner_reservation = {
      state: 'reserved', gen: 1, mode: 'continue', reserved_at: 1,
      owner_pid: process.pid, owner_start_ticks: procStartTicks(process.pid),
      owner_token: env.ANTONINA_RUNNER_OWNER_TOKEN,
    };
    meta.pending_prompt = 'Continue the test work.';
    writeMeta(id, meta, options);
    const original = {};
    for (const [key, value] of Object.entries(env)) { original[key] = process.env[key]; process.env[key] = value; }
    try { await runManagedRunner(id, 'continue', 1, options); } finally {
      for (const key of Object.keys(env)) {
        if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
      }
    }
    return readMeta(id, options);
  };
  return { launch, options, // Model launches only: a session-abort call after an interrupt carries no --model.
    calls: () => readFileSync(calls, 'utf8').split('\n').filter((line) => line !== ''), name };
}

test('a rate limit with retry-after excludes the model for that long, host-wide', { timeout: 120000 }, async (t) => {
  const event = JSON.stringify({ type: 'error', sessionID: 'ses_fixed', error: RATE_LIMIT });
  const fixture = await runFixture(t, 'retry-after', `  printf '%s\\n' '${event}'\n  exit 1`);
  const before = Date.now() / 1000;
  const first = await fixture.launch('retry-after-one');
  assert.equal(first.state, 'clearexit', JSON.stringify({ state: first.state, error: first.error }));
  assert.deepEqual(fixture.calls(), [LUNA, BEAM]);
  const cooldown = first.model_failover.cooldowns.find((entry) => entry.model === LUNA);
  assert.equal(cooldown.reason, 'rate_limited');
  // Ninety seconds before this change, whatever the provider said.
  assert.ok(cooldown.until >= before + 71_818, `cooldown ${cooldown.until - before}s must honour retryAfterMs`);
  assert.ok(cooldown.until <= before + 71_818 + 120);
  const shared = sharedModelCooldowns(fixture.options);
  assert.deepEqual(shared.map((entry) => [entry.model, entry.reason]), [[LUNA, 'rate_limited']]);
  // A different agent, with no history of its own, does not spend a request on Luna.
  const second = await fixture.launch('retry-after-two');
  assert.equal(second.state, 'clearexit', JSON.stringify({ state: second.state, error: second.error }));
  assert.deepEqual(fixture.calls(), [LUNA, BEAM, BEAM]);
  assert.equal((second.model_failover?.cooldowns ?? []).length, 0, 'the shared cooldown is consulted, not copied into the record');
});

test('a backend that keeps re-issuing one silent request is interrupted and failed over', { timeout: 120000 }, async (t) => {
  const reissue = 'setInterval(() => console.log(JSON.stringify({type:"step_start",sessionID:"ses_fixed",'
    + 'part:{type:"step-start",messageID:"msg_same"}})), 250)';
  const fixture = await runFixture(t, 'reissue',
    '  exec ' + JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(reissue),
    { modelStepSilenceMs: 1500, backendErrorGraceMs: 700, livenessPollMs: 100 });
  const started = Date.now();
  const finished = await fixture.launch('reissue-one');
  assert.equal(finished.state, 'clearexit', JSON.stringify({ state: finished.state, error: finished.error }));
  assert.deepEqual(fixture.calls(), [LUNA, BEAM]);
  assert.ok(Date.now() - started < 60_000, 'output every 250 ms used to hold the agent indefinitely');
  const cooldown = finished.model_failover.cooldowns.find((entry) => entry.model === LUNA);
  assert.equal(cooldown.reason, 'transient_backend');
  assert.ok(cooldown.until - Date.now() / 1000 > 15 * 60, 'a silent stall earns more than the two-minute soft penalty');
  assert.equal(existsSync(join(fixture.options.env.XDG_STATE_HOME, 'antonina', 'model-cooldowns')), false,
    'a stall is not a statement by the provider and is never shared');
});
