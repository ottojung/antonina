import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
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
  setActiveRunner,
  signalInvocation,
  steerQueue,
} from '../dist/packages/agent-runtime/src/lifecycle.js';

const AGENT_ID = 'a11d';
const INVOCATION_ID = 'b'.repeat(32);

// Every test in this file runs against a throwaway XDG root so it can never read or
// write the operator's real ~/.local/state/antonina or ~/.config/antonina.
function isolatedXdg(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-xdg-'));
  const previous = {
    state: process.env.XDG_STATE_HOME,
    config: process.env.XDG_CONFIG_HOME,
  };
  process.env.XDG_STATE_HOME = join(root, 'state');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  t.after(() => {
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    rmSync(root, { recursive: true, force: true });
  });
}

function requireProc(t) {
  if (!existsSync('/proc/self/stat')) {
    t.skip('liveness here is decided on PID plus /proc/<pid>/stat start ticks, and /proc is unavailable');
    return false;
  }
  return true;
}

// A real child carrying the ANTONINA_AGENT_ID marker, so liveness is decided on
// PID + start ticks + env marker, never on a process name. Reaped before return.
function liveRunnerChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    env: { ...process.env, ANTONINA_AGENT_ID: AGENT_ID },
  });
  t.after(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  }));
  return child;
}

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


// ---------------------------------------------------------------- GAP-RT-2 ----

test('a running record is never reconciled to failed while a live runner or an in-flight reservation could still execute it', (t) => {
  isolatedXdg(t);
  if (!requireProc(t)) return;

  const child = liveRunnerChild(t);
  const startTicks = procStartTicks(child.pid);
  assert.notEqual(startTicks, null, 'the spawned runner must have readable start ticks');

  // 1. A live runner vetoes the transition to failed, even with no reservation.
  const withRunner = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(withRunner, 'work', 10, 1);
  withRunner.active_runner = false;
  withRunner.runner_pid = child.pid;
  withRunner.runner_start_time = startTicks;
  assert.equal(reconcileDeadMeta(withRunner, 80), false);
  assert.equal(withRunner.state, 'running');
  assert.equal(withRunner.finished_at, null);

  // 2. A reservation inside the grace window vetoes it with no live process at all.
  const reserved = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(reserved, 'work', 10, 1);
  reserved.active_runner = true;
  reserved.runner_reservation = {
    state: 'reserved', gen: 1, mode: 'new', reserved_at: 78, owner_pid: 99999999, owner_start_ticks: 1,
  };
  assert.equal(reservationInFlight(reserved, 80), true);
  assert.equal(reconcileDeadMeta(reserved, 80), false);
  assert.equal(reserved.state, 'running');

  // 3. The reservationInFlight ladder is pinned term by term.
  const noFlag = idleMeta(AGENT_ID, '/tmp', null, 1);
  delete noFlag.active_runner;
  assert.equal(reservationInFlight(noFlag, 80), true, 'a missing active_runner is not proof the reservation is dead');

  const claimed = idleMeta(AGENT_ID, '/tmp', null, 1);
  claimed.active_runner = true;
  claimed.runner_reservation = {
    state: 'claimed', gen: 1, mode: 'new', reserved_at: 1, owner_pid: 99999999, owner_start_ticks: 1,
  };
  assert.equal(reservationInFlight(claimed, 80), false, 'a claimed reservation is not in flight');

  const badGen = idleMeta(AGENT_ID, '/tmp', null, 1);
  badGen.active_runner = true;
  badGen.runner_reservation = {
    state: 'reserved', gen: 0, mode: 'new', reserved_at: 1, owner_pid: 99999999, owner_start_ticks: 1,
  };
  assert.equal(reservationInFlight(badGen, 80), true, 'a bad runner gen is not proof the reservation is dead');

  const badMode = idleMeta(AGENT_ID, '/tmp', null, 1);
  badMode.active_runner = true;
  badMode.runner_reservation = {
    state: 'reserved', gen: 1, mode: 'wat', reserved_at: 1, owner_pid: 99999999, owner_start_ticks: 1,
  };
  assert.equal(reservationInFlight(badMode, 80), true, 'a bad reservation mode is not proof the reservation is dead');
});

// ---------------------------------------------------------------- GAP-RT-4 ----

test('a corrupt durable steer queue is rejected rather than replayed or dropped', (t) => {
  isolatedXdg(t);

  // A repeated seq is not a strict FIFO ordering.
  const repeated = idleMeta(AGENT_ID, '/tmp', null, 1);
  repeated.steer_queue = [
    { seq: 1, prompt: 'first', queued_at: 2 },
    { seq: 1, prompt: 'second', queued_at: 3 },
  ];
  repeated.steer_seq = 2;
  assert.equal(steerQueue(repeated), null);
  assert.equal(popSteerIntoPending(repeated, 4), null);

  // A seq beyond the durable steer_seq ceiling must never be replayed.
  const beyond = idleMeta(AGENT_ID, '/tmp', null, 1);
  beyond.steer_queue = [{ seq: 5, prompt: 'ghost', queued_at: 2 }];
  beyond.steer_seq = 2;
  assert.equal(steerQueue(beyond), null);
  assert.equal(popSteerIntoPending(beyond, 4), null);

  // A meta with no steer_queue field of its own is not an empty queue. An
  // inherited value is not durable state either, so it must not be replayed.
  const absent = idleMeta(AGENT_ID, '/tmp', null, 1);
  delete absent.steer_queue;
  assert.equal(steerQueue(absent), null);
  assert.equal(popSteerIntoPending(absent, 4), null);
  assert.equal(queueSteer(absent, 'work', 5), false);

  const poisoned = Object.assign(
    Object.create({ steer_queue: [{ seq: 5, prompt: 'ghost', queued_at: 2 }] }),
    absent,
    { steer_seq: 5 },
  );
  assert.equal(Object.hasOwn(poisoned, 'steer_queue'), false);
  assert.equal(steerQueue(poisoned), null);
  assert.equal(popSteerIntoPending(poisoned, 4), null);
});

// ---------------------------------------------------------------- GAP-RT-10 ---

test('a new invocation drops every piece of the previous invocation identity', (t) => {
  isolatedXdg(t);

  const meta = idleMeta(AGENT_ID, '/tmp', null, 1);
  meta.state = 'running';
  meta.pid = 4242;
  meta.pgid = 4242;
  meta.start_time = 1234;
  meta.invocation_id = INVOCATION_ID;
  meta.exit_code = 7;
  meta.exit_signal = 9;
  meta.finished_at = 5;
  meta.intent = 'stop';
  meta.stop_reason = 'stop';

  beginInvocation(meta, 'next work', 10, 2);
  assert.equal(meta.pid, null);
  assert.equal(meta.pgid, null);
  assert.equal(meta.start_time, null);
  assert.equal(meta.invocation_id, null);
  assert.equal(meta.exit_code, null);
  assert.equal(meta.exit_signal, null);
  assert.equal(meta.finished_at, null);
  assert.equal(meta.intent, null);
  assert.equal(meta.stop_reason, null);
  assert.equal(meta.pending_prompt, 'next work');

  // A retained pid is exactly what would leave a running record pointing at a
  // previous, dead invocation; the state must not read it as alive.
  assert.equal(deriveState(meta, 11), 'running');
});

test('releasing the active runner also releases its reservation', (t) => {
  isolatedXdg(t);

  const meta = idleMeta(AGENT_ID, '/tmp', null, 1);
  meta.active_runner = true;
  meta.runner_reservation = {
    state: 'reserved', gen: 1, mode: 'new', reserved_at: 1, owner_pid: 4242, owner_start_ticks: 1,
  };
  setActiveRunner(meta, false);
  assert.equal(meta.active_runner, false);
  assert.equal(meta.runner_reservation, null);

  const held = idleMeta(AGENT_ID, '/tmp', null, 1);
  held.active_runner = false;
  held.runner_reservation = {
    state: 'reserved', gen: 1, mode: 'new', reserved_at: 1, owner_pid: 4242, owner_start_ticks: 1,
  };
  setActiveRunner(held, true);
  assert.equal(held.runner_reservation.state, 'reserved');
});

test('a failed record reports exit code 1 unless it captured a positive status', (t) => {
  isolatedXdg(t);

  const zero = idleMeta(AGENT_ID, '/tmp', null, 1);
  finalizeTerminal(zero, 'failed', 20, 0, null);
  assert.equal(exitCodeFor(zero), 1, 'exit_code 0 on a failed record must not report success');

  const negative = idleMeta(AGENT_ID, '/tmp', null, 1);
  finalizeTerminal(negative, 'failed', 20, -1, null);
  assert.equal(exitCodeFor(negative), 1, 'a negative exit_code is not a captured status');

  const real = idleMeta(AGENT_ID, '/tmp', null, 1);
  finalizeTerminal(real, 'failed', 20, 3, null);
  assert.equal(exitCodeFor(real), 3);

  const signalled = idleMeta(AGENT_ID, '/tmp', null, 1);
  finalizeTerminal(signalled, 'failed', 20, null, 9);
  assert.equal(exitCodeFor(signalled), 1);
});

test('the pid-less startup grace window is confined to a record with no pid and a reached launch time', (t) => {
  isolatedXdg(t);

  // A record that carries a pid must not be excused by the grace window when the
  // invocation is already gone.
  const withPid = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(withPid, 'work', 100, 1);
  withPid.pid = 4242;
  withPid.pgid = 4242;
  withPid.start_time = 1234;
  withPid.invocation_id = INVOCATION_ID;
  assert.equal(deriveState(withPid, 110), 'unknown');

  // The grace window has not started yet when the launch timestamp is in the future.
  const future = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(future, 'work', 100, 1);
  assert.equal(deriveState(future, 99), 'unknown');
  assert.equal(deriveState(future, 110), 'running');

  // ...and the same launch timestamp reached a whole 60s window ago is unknown.
  const stale = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(stale, 'work', 100, 1);
  assert.equal(deriveState(stale, 160), 'unknown');
});

test('a malformed intent survives finalization for forensics but a well-formed one is cleared', (t) => {
  isolatedXdg(t);

  const malformed = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(malformed, 'work', 10, 1);
  malformed.intent = 'wat';
  finalizeTerminal(malformed, 'failed', 20, null, null, 'disappeared');
  assert.equal(malformed.state, 'failed');
  assert.equal(malformed.intent, 'wat', 'a malformed intent must not be silently normalized away');
  assert.equal(malformed.exit_code, null);

  const wellFormed = idleMeta(AGENT_ID, '/tmp', null, 1);
  beginInvocation(wellFormed, 'work', 10, 1);
  wellFormed.intent = 'steer';
  finalizeTerminal(wellFormed, 'succeeded', 20, 0, null);
  assert.equal(wellFormed.intent, null);
  assert.equal(wellFormed.finished_at, 20);
  assert.equal(wellFormed.last_activity_at, 20);

  const missing = idleMeta(AGENT_ID, '/tmp', null, 1);
  delete missing.intent;
  finalizeTerminal(missing, 'stopped', 20, null, 15);
  assert.equal(missing.state, 'stopped');
  assert.equal(missing.exit_signal, 15);
});
