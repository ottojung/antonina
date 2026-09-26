import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/metadata.js';
import {
  beginInvocation,
  beginStopLike,
  deriveState,
  exitCodeFor,
  finalizeTerminal,
  popSteerIntoPending,
  queueSteer,
  reconcileDeadMeta,
  reservationInFlight,
  signalInvocation,
  steerQueue,
} from '../dist/lifecycle.js';

function statLine(start = 1234, pgrp = 4242) {
  const fields = ['S', '1', String(pgrp), '0', '0', '0', '0', '0', '0', '0', '0', '7', '11', '0', '0', '0', '0', '0', '0', String(start)];
  return `4242 (worker) ${fields.join(' ')}`;
}

function procRoot(t, iid = 'b'.repeat(32)) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-life-'));
  const dir = join(root, '4242');
  mkdirSync(dir);
  writeFileSync(join(dir, 'stat'), statLine());
  writeFileSync(join(dir, 'environ'), `ANTONINA_AGENT_ID=a11d\0ANTONINA_INVOCATION_ID=${iid}\0`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('idle/running/terminal state derivation keeps startup grace', () => {
  const idle = idleMeta('a11d', '/tmp', null, 100);
  assert.equal(deriveState(idle, 100), 'idle');
  beginInvocation(idle, 'work', 101, 1);
  assert.equal(deriveState(idle, 120), 'running');
  assert.equal(deriveState(idle, 200), 'unknown');
  finalizeTerminal(idle, 'succeeded', 201, 0, null);
  assert.equal(deriveState(idle, 202), 'succeeded');
  assert.equal(exitCodeFor(idle), 0);
});

test('steers are strict FIFO and promote into pending work', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  assert.equal(queueSteer(meta, 'first', 2), true);
  assert.equal(queueSteer(meta, 'second', 3), true);
  assert.deepEqual(steerQueue(meta)?.map((entry) => entry.prompt), ['first', 'second']);
  assert.equal(popSteerIntoPending(meta, 4), 'first');
  assert.equal(meta.pending_prompt, 'first');
  assert.equal(meta.prompt_count, 1);
  assert.deepEqual(steerQueue(meta)?.map((entry) => entry.prompt), ['second']);
});

test('malformed steer metadata fails closed instead of being normalized', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  meta.steer_seq = '1';
  assert.equal(steerQueue(meta), null);
  assert.equal(queueSteer(meta, 'work', 2), false);
});

test('reservation in flight has a short spawn grace then becomes recoverable when owner is gone', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  meta.active_runner = true;
  meta.runner_reservation = { state: 'reserved', gen: 1, mode: 'new', reserved_at: 100, owner_pid: 99999999, owner_start_ticks: 1 };
  assert.equal(reservationInFlight(meta, 102), true);
  assert.equal(reservationInFlight(meta, 110), false);
  meta.runner_reservation = { state: 'bad', gen: 1, mode: 'new' };
  assert.equal(reservationInFlight(meta, 110), true);
  meta.active_runner = false;
  assert.equal(reservationInFlight(meta, 110), false);
});

test('stop intent clears queued work and malformed reservation blocks mutation', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  meta.pending_prompt = 'work';
  meta.steer_queue = [{ seq: 1, prompt: 'redirect', queued_at: 2 }];
  meta.steer_seq = 1;
  assert.equal(beginStopLike(meta, 'stop', 3), true);
  assert.equal(meta.intent, 'stop');
  assert.equal(meta.pending_prompt, null);
  assert.deepEqual(meta.steer_queue, []);

  const malformed = idleMeta('a11d', '/tmp', null, 1);
  malformed.runner_reservation = { state: 'wat' };
  assert.equal(beginStopLike(malformed, 'kill', 2), false);
  assert.equal(malformed.intent, null);
});

test('invocation group signalling checks metadata then uses normal negative pgid', (t) => {
  const iid = 'b'.repeat(32);
  const root = procRoot(t, iid);
  const calls = [];
  const meta = {
    id: 'a11d',
    pid: 4242,
    pgid: 4242,
    start_time: 1234,
    invocation_id: iid,
  };
  assert.equal(signalInvocation(meta, 'SIGTERM', {
    procRoot: root,
    signal: (pid, signal) => { calls.push([pid, signal]); return true; },
  }), true);
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});


test('dead running metadata reconciles to failed once no runner or reservation can execute it', () => {
  const meta = idleMeta('a11d', '/tmp', null, 1);
  beginInvocation(meta, 'work', 10, 1);
  meta.active_runner = false;
  assert.equal(reconcileDeadMeta(meta, 80), true);
  assert.equal(meta.state, 'failed');
  assert.equal(meta.active_runner, false);
  assert.match(String(meta.error), /disappeared/);
});


test('partial legacy invocation identity never authorizes signalling', (t) => {
  const root = procRoot(t);
  const calls = [];
  const legacy = {
    id: 'a11d',
    pid: 4242,
    start_time: 1234,
  };
  assert.equal(signalInvocation(legacy, 'SIGTERM', {
    procRoot: root,
    signal: (pid, signal) => { calls.push([pid, signal]); return true; },
  }), false);
  assert.deepEqual(calls, []);
});
