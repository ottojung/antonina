import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_META_VERSION,
  activeRunnerFlag,
  deletePendingFlag,
  idleMeta,
  nextPromptCount,
  pendingPrompt,
  persistedControlField,
  persistedLifecycleState,
  persistedNativeSessionId,
  persistedTimestamp,
  persistedVariant,
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  stopLikeOrMalformed,
  validateAgentMetadata,
} from '../dist/metadata.js';

const badAuthority = [123, true, 1.5, [], {}, ''];

test('missing authority never receives a legacy default', () => {
  assert.throws(() => pendingPrompt({}), /not canonical/);
  assert.equal(nextPromptCount({}), null);
  assert.equal(activeRunnerFlag({}), null);
  assert.equal(deletePendingFlag({}), null);
  assert.equal(persistedLifecycleState({}), null);
  assert.deepEqual(persistedControlField({}, 'intent'), { value: null, malformed: true });
  assert.throws(() => persistedNativeSessionId({}), /missing/);
  assert.throws(() => persistedVariant({}), /missing/);
  assert.equal(runnerReservationState(undefined), 'malformed');
});

test('present authority accepts only canonical scalar values', () => {
  assert.equal(pendingPrompt({ pending_prompt: null }), null);
  assert.equal(pendingPrompt({ pending_prompt: 'work' }), 'work');
  for (const bad of badAuthority) assert.throws(() => pendingPrompt({ pending_prompt: bad }), /not canonical/);

  assert.equal(nextPromptCount({ prompt_count: 0 }), 1);
  assert.equal(nextPromptCount({ prompt_count: 7 }), 8);
  for (const bad of [true, 1.5, '1', [], {}, -1, null]) assert.equal(nextPromptCount({ prompt_count: bad }), null);

  assert.equal(activeRunnerFlag({ active_runner: true }), true);
  assert.equal(activeRunnerFlag({ active_runner: false }), false);
  assert.equal(deletePendingFlag({ delete_pending: true }), true);
  assert.equal(deletePendingFlag({ delete_pending: false }), false);
  for (const bad of [0, '', [], {}, 1, 'yes', null]) {
    assert.equal(activeRunnerFlag({ active_runner: bad }), null);
    assert.equal(deletePendingFlag({ delete_pending: bad }), null);
  }

  for (const state of ['idle', 'running', 'succeeded', 'failed', 'stopped', 'killed']) {
    assert.equal(persistedLifecycleState({ state }), state);
  }
  for (const bad of ['', 'bogus', true, 1, [], {}]) assert.equal(persistedLifecycleState({ state: bad }), null);

  assert.deepEqual(persistedControlField({ intent: null }, 'intent'), { value: null, malformed: false });
  assert.deepEqual(persistedControlField({ intent: 'steer' }, 'intent'), { value: 'steer', malformed: false });
  assert.deepEqual(persistedControlField({ stop_reason: 'kill' }, 'stop_reason'), { value: 'kill', malformed: false });
  assert.deepEqual(persistedControlField({ intent: 'bogus' }, 'intent'), { value: null, malformed: true });
  assert.equal(stopLikeOrMalformed({ intent: 'steer', stop_reason: null }), false);
  assert.equal(stopLikeOrMalformed({ intent: 'stop', stop_reason: null }), true);
  assert.equal(stopLikeOrMalformed({ intent: null, stop_reason: [] }), true);
});

test('runner reservation helpers do not coerce durable values', () => {
  assert.equal(runnerReservationState(null), 'absent');
  assert.equal(runnerReservationState({ state: 'reserved' }), 'reserved');
  assert.equal(runnerReservationState({ state: 'claimed' }), 'claimed');
  for (const bad of [undefined, '', 'other', true, 0, 1.5, [], {}]) {
    assert.equal(runnerReservationState(bad), 'malformed');
  }
  assert.equal(runnerReservationMode({ mode: 'new' }), 'new');
  assert.equal(runnerReservationMode({ mode: 'continue' }), 'continue');
  for (const bad of [undefined, '', 'fresh', true, 0, 1.5, [], {}]) assert.equal(runnerReservationMode({ mode: bad }), null);

  assert.equal(runnerGeneration(7), 7);
  for (const bad of [true, 1.0 + Number.EPSILON, '1', [], {}, 0, -1, null]) assert.equal(runnerGeneration(bad), null);
});

test('scalar continuation authority rejects coercion and non-finite time', () => {
  assert.equal(persistedTimestamp(0), 0);
  assert.equal(persistedTimestamp(1.5), 1.5);
  for (const bad of [-1, true, '1', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(persistedTimestamp(bad), null);

  assert.equal(persistedNativeSessionId({ native_session_id: null }), null);
  assert.equal(persistedNativeSessionId({ native_session_id: 'ses_abc' }), 'ses_abc');
  assert.throws(() => persistedNativeSessionId({ native_session_id: '' }), /malformed/);

  assert.equal(persistedVariant({ variant: 'high' }), 'high');
  assert.throws(() => persistedVariant({ variant: '' }), /malformed/);
});

test('idle metadata is a complete authoritative version-4 record', () => {
  const meta = idleMeta('a11d', '/tmp/work', null, 100.5);
  assert.equal(AGENT_META_VERSION, 4);
  assert.equal(meta.agent_version, 4);
  assert.equal(meta.id, 'a11d');
  assert.equal(meta.state, 'idle');
  assert.equal(meta.pending_prompt, null);
  assert.equal(meta.last_prompt, null);
  assert.equal(meta.error, null);
  assert.equal(meta.active_runner, false);
  assert.equal(meta.runner_gen, 0);
  assert.equal(meta.prompt_count, 0);
  assert.deepEqual(meta.steer_queue, []);
  assert.equal(meta.delete_pending, false);
  assert.doesNotThrow(() => validateAgentMetadata(meta));
});

test('schema v4 rejects old versions, missing fields and unknown fields', () => {
  const base = idleMeta('a11d', '/tmp/work', null, 100.5);

  const old = { ...base, agent_version: 3 };
  assert.throws(() => validateAgentMetadata(old), /unsupported managed-agent metadata version/);

  for (const key of Object.keys(base)) {
    const missing = { ...base };
    delete missing[key];
    assert.throws(
      () => validateAgentMetadata(missing),
      /fields are not canonical/,
      `missing field unexpectedly accepted: ${key}`,
    );
  }

  assert.throws(
    () => validateAgentMetadata({ ...base, legacy_field: true }),
    /fields are not canonical/,
  );
});

test('schema v4 rejects partial process identities and malformed structured authority', () => {
  const base = idleMeta('a11d', '/tmp/work', null, 100.5);

  assert.throws(
    () => validateAgentMetadata({ ...base, pid: 42 }),
    /invocation identity is malformed/,
  );
  assert.throws(
    () => validateAgentMetadata({ ...base, runner_pid: 42 }),
    /runner identity is malformed/,
  );
  assert.throws(
    () => validateAgentMetadata({
      ...base,
      runner_reservation: {
        state: 'reserved',
        gen: 1,
        owner_pid: 42,
        owner_start_ticks: 5,
        reserved_at: 101,
        mode: 'new',
        extra: true,
      },
    }),
    /runner_reservation is malformed/,
  );
  assert.throws(
    () => validateAgentMetadata({
      ...base,
      steer_seq: 1,
      steer_queue: [{ seq: 2, prompt: 'later', queued_at: 101 }],
    }),
    /steer_queue is malformed/,
  );
});
