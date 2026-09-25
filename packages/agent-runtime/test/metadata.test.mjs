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
} from '../dist/metadata.js';

const badAuthority = [123, true, 1.5, [], {}, ''];

test('pending prompt preserves absence and rejects malformed presence', () => {
  assert.equal(pendingPrompt({}), null);
  assert.equal(pendingPrompt({ pending_prompt: null }), null);
  assert.equal(pendingPrompt({ pending_prompt: 'work' }), 'work');
  for (const bad of badAuthority) assert.throws(() => pendingPrompt({ pending_prompt: bad }), /not canonical/);
});

test('runner reservation authority accepts only exact canonical shapes', () => {
  assert.equal(runnerReservationState(null), 'absent');
  assert.equal(runnerReservationState({ state: 'reserved' }), 'reserved');
  assert.equal(runnerReservationState({ state: 'claimed' }), 'claimed');
  for (const bad of [undefined, '', 'other', true, 0, 1.5, [], {}]) {
    if (bad === undefined) assert.equal(runnerReservationState({}), 'malformed');
    else assert.equal(runnerReservationState({ state: bad }), 'malformed');
  }
  assert.equal(runnerReservationMode({ mode: 'new' }), 'new');
  assert.equal(runnerReservationMode({ mode: 'continue' }), 'continue');
  for (const bad of [undefined, '', 'fresh', true, 0, 1.5, [], {}]) assert.equal(runnerReservationMode({ mode: bad }), null);
});

test('generation and prompt counters never coerce durable values', () => {
  assert.equal(runnerGeneration(7), 7);
  for (const bad of [true, 1.0 + Number.EPSILON, '1', [], {}, 0, -1, null]) assert.equal(runnerGeneration(bad), null);
  assert.equal(nextPromptCount({}), 1);
  assert.equal(nextPromptCount({ prompt_count: 0 }), 1);
  assert.equal(nextPromptCount({ prompt_count: 7 }), 8);
  for (const bad of [true, 1.5, '1', [], {}, -1, null]) assert.equal(nextPromptCount({ prompt_count: bad }), null);
});

test('runner and deletion booleans preserve legacy absence but reject malformed presence', () => {
  assert.equal(activeRunnerFlag({}), false);
  assert.equal(activeRunnerFlag({ active_runner: true }), true);
  assert.equal(activeRunnerFlag({ active_runner: false }), false);
  assert.equal(deletePendingFlag({}), false);
  assert.equal(deletePendingFlag({ delete_pending: true }), true);
  for (const bad of [0, 0.0, '', [], {}, 1, 'yes', [1], null]) {
    assert.equal(activeRunnerFlag({ active_runner: bad }), null);
    assert.equal(deletePendingFlag({ delete_pending: bad }), null);
  }
});

test('lifecycle and control fields fail closed on malformed persisted authority', () => {
  assert.equal(persistedLifecycleState({}), 'idle');
  for (const state of ['idle', 'running', 'succeeded', 'failed', 'stopped', 'killed']) assert.equal(persistedLifecycleState({ state }), state);
  for (const bad of ['', 'bogus', true, 1, [], {}]) assert.equal(persistedLifecycleState({ state: bad }), null);
  assert.deepEqual(persistedControlField({}, 'intent'), { value: null, malformed: false });
  assert.deepEqual(persistedControlField({ intent: 'steer' }, 'intent'), { value: 'steer', malformed: false });
  assert.deepEqual(persistedControlField({ stop_reason: 'kill' }, 'stop_reason'), { value: 'kill', malformed: false });
  assert.deepEqual(persistedControlField({ intent: 'bogus' }, 'intent'), { value: null, malformed: true });
  assert.equal(stopLikeOrMalformed({ intent: 'steer' }), false);
  assert.equal(stopLikeOrMalformed({ intent: 'stop' }), true);
  assert.equal(stopLikeOrMalformed({ stop_reason: [] }), true);
});

test('scalar continuation authority rejects coercion and non-finite time', () => {
  assert.equal(persistedTimestamp(0), 0);
  assert.equal(persistedTimestamp(1.5), 1.5);
  for (const bad of [-1, true, '1', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(persistedTimestamp(bad), null);
  assert.equal(persistedNativeSessionId({}), null);
  assert.equal(persistedNativeSessionId({ native_session_id: 'ses_abc' }), 'ses_abc');
  assert.throws(() => persistedNativeSessionId({ native_session_id: '' }), /malformed/);
  assert.equal(persistedVariant({}), 'low');
  assert.equal(persistedVariant({ variant: 'high' }), 'high');
  assert.throws(() => persistedVariant({ variant: '' }), /malformed/);
});

test('idle metadata matches the version-3 durable authority baseline', () => {
  const meta = idleMeta('a11d', '/tmp/work', null, 100.5);
  assert.equal(meta.agent_version, AGENT_META_VERSION);
  assert.equal(meta.id, 'a11d');
  assert.equal(meta.created_at, 100.5);
  assert.equal(meta.last_activity_at, 100.5);
  assert.equal(meta.state, 'idle');
  assert.equal(meta.active_runner, false);
  assert.equal(meta.runner_gen, 0);
  assert.equal(meta.prompt_count, 0);
  assert.deepEqual(meta.steer_queue, []);
  assert.equal(meta.delete_pending, false);
});
