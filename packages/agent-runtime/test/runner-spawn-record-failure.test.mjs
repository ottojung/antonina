// Board 112, class B. This file is separate from runner.test.mjs (owned live by
// board 98's front) and from runner-rejected-spawn.test.mjs (class A), because
// the human instruction for issue 112 requires the two defect classes to stay
// separate in code and in tests, and because the fronts on this host must not
// share a file.
//
// Class A, in runner-rejected-spawn.test.mjs: a spawn rejected because an
// operator stop committed between the runner's read and recordSpawned's write.
// There the rejecting control path owns the durable record.
//
// Class B, here: recordSpawned's DURABLE WRITE FAILS. The store throws, the
// write is abandoned, and the runner has already claimed the pass
// (active_runner true, runner_reservation in state `claimed`, state `running`)
// and consumed the prompt. Nothing writes a terminal record, so the record is
// left claiming a `running` invocation that was never recorded and whose child
// has been killed. That is the leak: in class A somebody owns the record, here
// nobody does.
//
// Every helper below is duplicated from runner.test.mjs on main so that no
// shared file has to be edited. Nothing here reads or writes the operator's
// real state: scratch() points both XDG homes at a throwaway directory.
import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { beginStopLike, finalizeTerminal } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-RUNNER-FIXTURE-EXEC-OK';

function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  if (result.error) return { ok: false, reason: String(result.error.code ?? result.error.message) };
  if (result.status !== 0) return { ok: false, reason: `probe exited with status ${result.status}` };
  if (result.stdout.trim() !== PROBE_SENTINEL) return { ok: false, reason: 'probe produced no sentinel' };
  return { ok: true, reason: 'exec ok' };
}

function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

function fakeBackend(t, body = '#!/bin/sh\nexit 0\n') {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-runner-'));
    } catch (error) {
      failures.push(`${parent}: ${error.message}`);
      continue;
    }
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      pruneFixtureParent(t);
    });
    if (execProbe(root, 'probe-').ok) {
      const bin = join(root, 'opencode');
      writeFileSync(bin, body, { mode: 0o755 });
      return bin;
    }
    failures.push(`${root}: fixture is not exec-capable`);
  }
  t.skip(`no exec-capable fixture directory for the fake opencode backend; tried: ${failures.join('; ')}`);
  return null;
}

function requireProc(t) {
  if (procStartTicks(process.pid) === null) {
    t.skip('requires /proc/<pid>/stat for runner process identity');
    return false;
  }
  return true;
}

function scratch(t, backend) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-runner-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ANTONINA_OPENCODE_BIN: backend };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  return { env };
}

function reservation(overrides = {}) {
  return {
    state: 'reserved',
    gen: 7,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: procStartTicks(process.pid),
    ...overrides,
  };
}

function agent(t, options, overrides = {}) {
  const id = 'a11d';
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-runner-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, options);
  return id;
}

// The failure seam. It substitutes the durable write and nothing else: every
// other fs call, the lock, the read, the rename, the directory fsync, the
// runner's own callback, its real kill and its real rethrow are the production
// ones.
//
// It fires on exactly one write: the one that would publish a spawn identity.
// Distinguishing it that way rather than by call count is deliberate, because
// the writes before it (claimRunner, claimPendingPrompt) must succeed for the
// leak to exist at all, and the writes after it are the ones the fix has to
// survive. writeMeta only reaches this call after validateAgentMetadata, and
// the only store writes carrying a non-null integer pid are recordSpawned's.
// The fixture backend publishes its pid from inside the child, and the child is
// killed the instant the seam fails, so without a barrier the test can read the
// pid file before the shell has ever written it and learn nothing about the
// child. This waits, synchronously, for the file to appear. Bounded, and it is
// a barrier on a real file rather than a sleep, so it costs nothing on a quiet
// host and cannot pass by accident.
function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  return true;
}

function failingSpawnWriteFs(spawnMarkerPath) {
  const state = { failed: false, attempts: 0, sawSpawn: false };
  const fs = {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync(target, data, ...rest) {
      if (!state.failed && typeof target === 'number' && typeof data === 'string' && data.includes('"agent_version"') && /"pid":\s*\d/.test(data)) {
        state.failed = true;
        state.attempts += 1;
        state.sawSpawn = waitForFile(spawnMarkerPath);
        const error = new Error('simulated EIO');
        error.code = 'EIO';
        throw error;
      }
      return writeFileSync(target, data, ...rest);
    },
  };
  return { fs, state };
}

// The cross-class guard, and the reason the class B fix carries a guard at all.
// The class A case (runner-rejected-spawn.test.mjs) proves the runner writes
// nothing when recordSpawned *returns false*. It cannot cover the path this
// file's fix introduces, because there the store throws rather than returning:
// the runner has to make a release write of its own, and a release write is
// exactly the shape of write that would overwrite an operator's stop if it were
// unguarded. So the two failures are combined here -- a durable write that
// fails, and a stop that commits before the release write reads -- and the
// assertion is that the stop still wins.
//
// This is deliberately in the class B file and not the class A one: the code
// under test is the class B release path. The two classes' assertions are still
// never mixed, because they cannot be: the fixtures differ (this one fails a
// write and commits a stop; the class A one commits a stop and writes nothing)
// and they are separate tests with separate seams.
function stopAfterFailingSpawnWriteFs(id, options, spawnMarkerPath, onCommit) {
  const base = failingSpawnWriteFs(spawnMarkerPath);
  const target = metaPath(id, options);
  // Deliberately the same object, not a copy: the base seam's writeFileSync
  // closure mutates base.state, so a spread here would leave the assertions
  // reading a stale snapshot that never changes.
  const state = base.state;
  state.committed = false;
  state.stop = null;
  const fs = {
    ...base.fs,
    readFileSync(path, ...rest) {
      const text = readFileSync(path, ...rest);
      // The release write's read is the second read that sees the runner's
      // in-flight signature. The first is recordSpawned's own, and committing
      // there would turn this into the class A case (a false return, no write to
      // fail), which is the other file's test.
      if (state.committed || path !== target || typeof text !== 'string') return text;
      if (!state.failed) return text;
      const observed = JSON.parse(text);
      if (observed.pending_prompt !== null || observed.active_runner !== true) return text;
      if (observed.state !== 'running' || observed.pid !== null) return text;
      state.committed = true;
      const stop = JSON.parse(text);
      const now = Date.now() / 1000;
      beginStopLike(stop, 'stop', now);
      stop.pending_prompt = null;
      stop.steer_queue = [];
      stop.active_runner = false;
      stop.runner_reservation = null;
      finalizeTerminal(stop, 'stopped', now, null, null);
      stop.stop_reason = 'stop';
      writeMeta(id, stop, { env: options.env });
      state.stop = stop;
      onCommit(stop);
      return `${JSON.stringify(stop, null, 2)}\n`;
    },
  };
  return { fs, state };
}

test('a recordSpawned durable-write failure leaves no claimed running record', async (t) => {
  if (!requireProc(t)) return;
  const pidFile = join(tmpdir(), `antonina-spawn-write-failure-${process.pid}.pid`);
  // A backend that outlives its spawn, so the case also proves the child is
  // killed and reaped on the write-failure path rather than abandoned.
  const backend = fakeBackend(t, `#!/bin/sh\nprintf '%s\\n' "$$" > ${pidFile}\nexec sleep 300\n`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  const seam = failingSpawnWriteFs(pidFile);
  const run = { ...options, fs: seam.fs };

  const spawnedBackendPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null);
  const reapBackend = () => {
    const pid = spawnedBackendPid();
    if (pid === null) return;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    rmSync(pidFile, { force: true });
  };
  t.after(reapBackend);

  let backendPid = null;
  let thrown = null;
  let watchdog = null;
  try {
    await Promise.race([
      runManagedRunner(id, 'new', 7, run).catch((error) => { thrown = error; }),
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('the runner did not return: the spawn was left running')),
          20_000,
        );
      }),
    ]);
    backendPid = spawnedBackendPid();
  } finally {
    clearTimeout(watchdog);
    reapBackend();
  }

  // The seam actually fired, and exactly once: without this the rest of the
  // assertions could be passing because nothing went wrong at all.
  assert.equal(seam.state.failed, true, 'the recordSpawned durable write was actually failed by the seam');
  assert.equal(seam.state.attempts, 1, 'only the spawn-identity write was failed');
  assert.equal(seam.state.sawSpawn, true, 'a real backend process was spawned and running before the write failed');
  assert.ok(backendPid !== null, 'a real backend process was spawned before the write failed');
  assert.throws(() => process.kill(backendPid, 0), /ESRCH/, 'the unrecorded child was killed, not left running');
  // The store error still reaches the caller. The fix releases the claim; it
  // does not make a failed durable write look like a successful invocation.
  assert.ok(thrown !== null, 'the durable write failure still propagates to the caller');
  assert.match(String(thrown.message), /failed to persist metadata/);

  const after = readMeta(id, options);
  // No spawn was ever recorded, and the record must not claim one is running.
  assert.equal(after.pid, null);
  assert.equal(after.pgid, null);
  assert.equal(after.start_time, null);
  assert.equal(after.invocation_id, null);
  assert.equal(after.started_at, null);
  // This is the leak the test exists for. A record left here reads as a live
  // `running` invocation for a process that no longer exists, with the claim
  // still held by a dead owner. It is not permanently unrecoverable -- the
  // next `run` reserves afresh, and reconcileDeadMeta eventually forces it to
  // `failed` -- but until then the board and every reader are told a process is
  // running, and the reconciliation that does eventually fire attributes it to
  // "runner/model process disappeared" rather than to the write that actually
  // failed. The cause has to be durable at the moment it happens.
  assert.notEqual(after.state, 'running', 'the record must not be left claiming a running invocation');
  assert.equal(after.state, 'failed');
  assert.equal(after.active_runner, false, 'the claim must be released, not left held by a dead invocation');
  assert.equal(after.runner_reservation, null, 'the runner reservation must not stay claimed');
  // runner_pid and runner_start_time are deliberately left in place, matching
  // every other terminal write in runner.ts: they are the identity evidence
  // runnerAlive and reservationInFlight use to decide whether this runner is
  // still winding down, and clearing them early would let a second runner steal
  // the reservation out from under a runner that has not finished unwinding.
  assert.equal(after.runner_pid, process.pid);
  assert.equal(after.pending_prompt, null);
  // The reason has to be durable, or the operator sees a failure they cannot
  // explain.
  assert.match(String(after.error), /persist/i);
  assert.equal(after.backend_error, null);
});

test('a stop that commits during the write-failure release still owns the record', async (t) => {
  if (!requireProc(t)) return;
  const pidFile = join(tmpdir(), `antonina-spawn-write-stop-${process.pid}.pid`);
  const backend = fakeBackend(t, `#!/bin/sh\nprintf '%s\\n' "$$" > ${pidFile}\nexec sleep 300\n`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  let stopped = null;
  const seam = stopAfterFailingSpawnWriteFs(id, options, pidFile, (stop) => { stopped = stop; });

  const spawnedBackendPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null);
  const reapBackend = () => {
    const pid = spawnedBackendPid();
    if (pid === null) return;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    rmSync(pidFile, { force: true });
  };
  t.after(reapBackend);

  let thrown = null;
  let watchdog = null;
  try {
    await Promise.race([
      runManagedRunner(id, 'new', 7, { ...options, fs: seam.fs }).catch((error) => { thrown = error; }),
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('the runner did not return: the spawn was left running')),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    reapBackend();
  }

  // Both halves actually happened, or the assertions below prove nothing.
  assert.equal(seam.state.failed, true, 'the recordSpawned durable write failed');
  assert.equal(seam.state.committed, true, 'a stop committed before the release write read the record');
  assert.ok(thrown !== null, 'the durable write failure still propagates to the caller');

  const after = readMeta(id, options);
  // The operator's stop owns the record. The release write must not turn it
  // into a `failed` the operator never asked for, and must not stamp a second
  // ending's timestamps over the stop's.
  assert.equal(after.state, 'stopped');
  assert.equal(after.stop_reason, 'stop');
  assert.equal(after.finished_at, stopped.finished_at);
  assert.equal(after.last_activity_at, stopped.last_activity_at);
  assert.equal(after.error, null, 'the release must not write a diagnosis over the stop record');
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
  assert.equal(after.pid, null);
  assert.equal(after.invocation_id, null);
  assert.equal(after.started_at, null);
});
