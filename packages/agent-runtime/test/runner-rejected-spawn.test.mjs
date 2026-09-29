// Board 112, class A. This file exists as its own file rather than as an
// addition to runner.test.mjs for a coordination reason, not a stylistic one:
// board issue 98's front owns runner.test.mjs exclusively and is live on this
// host, so the two fronts' test files have to stay disjoint for them to be able
// to run concurrently at all. Everything runner.test.mjs needs is therefore
// duplicated here rather than imported, and runner.test.mjs is not modified.
//
// Every helper below is a copy of the one in runner.test.mjs on current main,
// except where noted. Where main and the release line differ, the difference is
// marked.
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

import { beginInvocation, beginStopLike, finalizeTerminal } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-RUNNER-FIXTURE-EXEC-OK';

// Copied from runner.test.mjs on main.
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

// Copied from runner.test.mjs on main.
function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

// Copied from runner.test.mjs on main, with the one change this file needs:
// runner.test.mjs's fakeBackend is hard-coded to `exit 0`, because every case
// there converges on its own. The rejected-spawn case needs a backend that
// outlives its spawn, or the assertion that the process group is killed would
// be satisfied by a backend that had already exited on its own. So the body is
// a parameter here, and the caller owns what the fixture does.
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

// Copied from runner.test.mjs on main.
function requireProc(t) {
  if (procStartTicks(process.pid) === null) {
    t.skip('requires /proc/<pid>/stat for runner process identity');
    return false;
  }
  return true;
}

// Copied from runner.test.mjs on main. The returned env points both XDG homes
// at a throwaway directory, so nothing here can read or write the operator's
// real trust.json or credential.json.
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

// Copied from runner.test.mjs on main.
function reservation(overrides = {}) {
  return {
    state: 'reserved',
    gen: 7,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: 0,
    ...overrides,
  };
}

// Copied from runner.test.mjs on main.
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

// Board 112, class A. A spawn can be started and then rejected by a control path
// that commits between the runner's own read of the record and its write of it:
// recordSpawned's callback (runner.ts:159 on main) returns early on
// `deletePendingFlag(meta) !== false || stopLikeOrMalformed(meta)`, so
// runInvocation kills the process group and returns false at runner.ts:360-363
// without ever calling finalizeInvocation.
//
// The claim under test is that this is correct, and this test is what would fail
// if it stopped being correct. The property is not "nothing happened": the
// property is that the rejecting control path owns the durable record. The stop
// is a real terminal `stopped` that has already released the claim
// (active_runner false, runner_reservation null), so the runner must neither
// record the spawn it just abandoned nor write a second terminal state over the
// operator's. Either would destroy the only record of why the invocation ended:
// a recorded spawn would leave a dead pid published as authoritative, and a
// second terminal would overwrite `stopped` with a `failed` the operator never
// asked for.
//
// The interleaving is injected rather than raced. The real window is the gap
// between the runner's read and its write inside the metadata lock, which is
// sub-millisecond, and a fixture that tried to win it from another process
// would be a timing test that passes or fails with host load. The StoreFs seam
// substitutes the interleaving and nothing else: the document the runner reads
// under the lock is the one the stop really committed, written durably through
// the ordinary writeMeta path, so the runner then runs its real callback, its
// real rejection, its real process-group kill and its real return.
function stopRaceFs(id, options, onCommit) {
  const target = metaPath(id, options);
  let committed = false;
  const fs = {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync(path, ...rest) {
      const text = readFileSync(path, ...rest);
      if (committed || path !== target || typeof text !== 'string') return text;
      const observed = JSON.parse(text);
      // The exact durable signature of the window: the runner has claimed the
      // pass and consumed the prompt, and has published no identity yet.
      if (observed.pending_prompt !== null || observed.active_runner !== true) return text;
      if (observed.state !== 'running' || observed.pid !== null) return text;
      committed = true;
      // Byte for byte the CLI's own `!invocationAlive` branch of stopLike,
      // packages/cli/src/agent.ts:691-700, committed through the real writer.
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
      onCommit(stop);
      return `${JSON.stringify(stop, null, 2)}\n`;
    },
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
  };
  return { fs, didCommit: () => committed };
}

test('a spawn rejected by a stop between the runner read and its write leaves the stop record and no spawn record', async (t) => {
  if (!requireProc(t)) return;
  // A backend that outlives its spawn would hang the runner if the rejection
  // ever stopped killing the process group, so it sleeps rather than exiting and
  // the case doubles as the check that the group kill still happens.
  const pidFile = join(tmpdir(), `antonina-rejected-spawn-${process.pid}.pid`);
  const backend = fakeBackend(t, `#!/bin/sh\nprintf '%s\\n' "$$" > ${pidFile}\nexec sleep 300\n`);
  if (backend === null) return;
  // A second, ordinary backend for the resume below: the point of that half is
  // the durable record, not the backend.
  const resumeBackend = fakeBackend(t);
  if (resumeBackend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  let stopped = null;
  const race = stopRaceFs(id, options, (stop) => { stopped = stop; });
  // Note the absence of a `capacity` option, which the release-line version of
  // this test passed. Main's runner.ts has no host-capacity/OOM classification
  // (it was removed when the release-only backend work was dropped), so
  // RunnerOptions on main has no `capacity` field and there is nothing to
  // stub. Nothing else about the seam changed: StoreFs has the same nine
  // members on main as on the release line.
  const run = { ...options, fs: race.fs };

  // Registered before the runner starts, and reading the pid file at teardown
  // rather than capturing a pid, so that a regression which leaves the spawn
  // running is still reaped: a leaked backend would keep the suite alive after
  // the failure had already been reported.
  const spawnedBackendPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null);
  const reapBackend = () => {
    const pid = spawnedBackendPid();
    if (pid === null) return;
    try { process.kill(pid, 'SIGKILL'); } catch {}
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    rmSync(pidFile, { force: true });
  };
  t.after(reapBackend);

  // Bounded, so that a regression which forgets the process-group kill fails on
  // a named assertion instead of hanging the suite on a sleeping backend.
  let watchdog = null;
  let backendPid = null;
  try {
    await Promise.race([
      runManagedRunner(id, 'new', 7, run),
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('the runner did not return: the rejected spawn was left running')),
          20_000,
        );
      }),
    ]);
    backendPid = spawnedBackendPid();
  } finally {
    clearTimeout(watchdog);
    reapBackend();
  }

  assert.equal(race.didCommit(), true, 'the stop was committed inside the window, so the branch was exercised');
  assert.ok(backendPid !== null, 'a real backend process was spawned before the rejection');
  assert.throws(() => process.kill(backendPid, 0), /ESRCH/, 'the rejected spawn was killed, not left running');

  const after = readMeta(id, options);
  // The control path's record survives whole. A second terminal state here would
  // replace the operator's `stopped` with a failure they never asked for.
  assert.equal(after.state, 'stopped');
  assert.equal(after.stop_reason, 'stop');
  assert.equal(after.finished_at, stopped.finished_at);
  assert.equal(after.last_activity_at, stopped.last_activity_at);
  // No spawn record. The spawn was never accepted, so there is no invocation to
  // point at, and a published identity here would be a dead pid presented as
  // authoritative.
  assert.equal(after.pid, null);
  assert.equal(after.pgid, null);
  assert.equal(after.start_time, null);
  assert.equal(after.invocation_id, null);
  assert.equal(after.started_at, null);
  assert.equal(after.pending_prompt, null);
  assert.equal(after.steer_queue.length, 0);
  // The claim is released. This is the part a survivor of runner.ts:360 would
  // get wrong: the runner returns without calling reclaimOrStop, so nothing but
  // the stop itself clears the reservation.
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
  assert.equal(after.error, null);
  assert.equal(after.backend_error, null);

  // And the agent is not wedged. The resume goes through beginInvocation, which
  // is what `antonina run` does to the same record, rather than hand-patching
  // the fields a naive resume would set: a stale stop_reason is stop-like and
  // would refuse the next claim, so a resume that skipped it would be testing a
  // state the CLI never produces.
  const resumed = readMeta(id, options);
  const now = Date.now() / 1000;
  beginInvocation(resumed, 'work again', now, 2);
  resumed.active_runner = true;
  resumed.runner_gen = 8;
  resumed.runner_reservation = reservation({ gen: 8, owner_pid: process.pid, reserved_at: now });
  writeMeta(id, resumed, options);
  await runManagedRunner(id, 'new', 8, {
    env: { ...options.env, ANTONINA_OPENCODE_BIN: resumeBackend },
  });
  const rerun = readMeta(id, options);
  assert.equal(rerun.state, 'succeeded', 'a stop that rejected a spawn does not block the next run');
  assert.equal(rerun.active_runner, false);
  assert.equal(rerun.runner_reservation, null);
});
