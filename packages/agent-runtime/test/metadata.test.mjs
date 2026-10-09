import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_META_VERSION,
  activeRunnerFlag,
  deletePendingFlag,
  idleMeta,
  nextPromptCount,
  OPTIONAL_TOP_LEVEL_FIELDS,
  pendingPrompt,
  persistedControlField,
  persistedInvocationCwd,
  persistedLifecycleState,
  persistedNativeSessionId,
  persistedOpencodeDbKey,
  persistedRunLogOffset,
  persistedTimestamp,
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  stopLikeOrMalformed,
  validateAgentMetadata,
} from '../dist/packages/agent-runtime/src/metadata.js';

const badAuthority = [123, true, 1.5, [], {}, ''];


test('missing authority never receives a legacy default', () => {
  assert.throws(() => pendingPrompt({}), /not canonical/);
  assert.equal(nextPromptCount({}), null);
  assert.equal(activeRunnerFlag({}), null);
  assert.equal(deletePendingFlag({}), null);
  assert.equal(persistedLifecycleState({}), null);
  assert.deepEqual(persistedControlField({}, 'intent'), { value: null, malformed: true });
  assert.throws(() => persistedNativeSessionId({}), /missing/);
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
    // `invocation_cwd` (board issue 178), `run_log_offset` (board issue 177) and
    // `opencode_db` (board issue 186) are the fields a record is allowed to
    // omit, for the same reason: each was added after records already existed
    // on disk, and a record written before it existed must still be canonical
    // rather than rejected. For `opencode_db` absence additionally carries a
    // meaning -- "predates isolation, keeps using the shared OpenCode
    // database" -- so it is not merely tolerated but load-bearing.
    //
    // The exemptions are read from the schema rather than restated here: a
    // closed-schema check that grows one hard-coded skip per feature is how a
    // schema stops being closed, and restating them here would let the test and
    // the schema disagree about what is exempt without either noticing.
    // `invocation_cwd`'s shapes are asserted separately, below.
    if (OPTIONAL_TOP_LEVEL_FIELDS.includes(key)) continue;
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

// Board issue 178: the observation. Optional for the same reason as
// `run_log_offset` and `opencode_db` below -- records existed before it did --
// and held to the same rule: a present-but-wrong value is a rejection, and
// absence reads as "nothing observed" rather than as a value synthesised from the
// declaration.
test('invocation_cwd is optional, canonical when absent, and validated when present', () => {
  const base = idleMeta('a11d', '/tmp/work', null, 100.5);
  // A new record has run nowhere, so it observes nothing. This is written
  // explicitly (`null`) rather than left absent, which is what keeps the
  // tolerated absence applying only to a pre-existing on-disk population.
  assert.equal(base.invocation_cwd, null);

  const absent = { ...base };
  delete absent.invocation_cwd;
  assert.doesNotThrow(() => validateAgentMetadata(absent));
  assert.equal(persistedInvocationCwd(absent), null);
  assert.equal(persistedInvocationCwd(base), null);
  assert.equal(persistedInvocationCwd({ ...base, invocation_cwd: '/srv/ran-here' }), '/srv/ran-here');

  // A present-but-wrong value is a rejection on both routes, not something the
  // runtime silently reads as "nothing observed": the reader must not be able to
  // see a corrupt observation where the record would have been refused.
  for (const malformed of ['', 'relative/path', 42, true, {}, []]) {
    assert.throws(
      () => persistedInvocationCwd({ ...base, invocation_cwd: malformed }),
      /invocation_cwd is malformed/,
      `persistedInvocationCwd read a malformed value as null: ${JSON.stringify(malformed)}`,
    );
    assert.throws(
      () => validateAgentMetadata({ ...base, invocation_cwd: malformed }),
      /invocation_cwd is malformed/,
      `malformed invocation_cwd unexpectedly accepted: ${JSON.stringify(malformed)}`,
    );
  }
});

test('a record may omit run_log_offset, but a present one must be a byte cursor', () => {
  const base = idleMeta('a11d', '/tmp/work', null, 100.5);
  assert.equal(base.run_log_offset, null);

  const absent = { ...base };
  delete absent.run_log_offset;
  assert.doesNotThrow(() => validateAgentMetadata(absent));
  assert.equal(persistedRunLogOffset(absent), null);

  assert.equal(persistedRunLogOffset(base), null);
  assert.equal(persistedRunLogOffset({ ...base, run_log_offset: 0 }), 0);
  assert.equal(persistedRunLogOffset({ ...base, run_log_offset: 4096 }), 4096);

  for (const malformed of [-1, 1.5, '0', Number.NaN, {}]) {
    assert.equal(persistedRunLogOffset({ ...base, run_log_offset: malformed }), null);
    assert.throws(
      () => validateAgentMetadata({ ...base, run_log_offset: malformed }),
      /run_log_offset is malformed/,
      `malformed run_log_offset unexpectedly accepted: ${JSON.stringify(malformed)}`,
    );
  }
});

test('a record may omit opencode_db, but a present one must be an agent-id-shaped key', () => {
  const base = idleMeta('a11d', '/tmp/work', null, 100.5);
  // A new record names its own database from birth.
  assert.equal(persistedOpencodeDbKey(base), 'a11d');

  const absent = { ...base };
  delete absent.opencode_db;
  assert.doesNotThrow(() => validateAgentMetadata(absent));
  assert.equal(persistedOpencodeDbKey(absent), null);
  assert.equal(persistedOpencodeDbKey({ ...base, opencode_db: null }), null);

  for (const malformed of [42, 'A11D', 'not an id', '', {}, []]) {
    assert.equal(persistedOpencodeDbKey({ ...base, opencode_db: malformed }), null);
    assert.throws(
      () => validateAgentMetadata({ ...base, opencode_db: malformed }),
      /opencode_db is malformed/,
      `malformed opencode_db unexpectedly accepted: ${JSON.stringify(malformed)}`,
    );
  }
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
