// Board issue 197. Two guards, both in the spawn path of
// packages/agent-runtime/src/runner.ts, and both covered here from the outside
// so that deleting either one goes red.
//
// 1. The launch gate. The host-capability gate the CLI applies when it accepts
//    a prompt is an acceptance-time decision about a declaration: nothing has
//    been spawned yet, so refusing writes nothing. The spawn path never took
//    that decision again, so a reservation accepted while the backend could
//    honour a named directory could still be launched after the capability was
//    withdrawn -- and the backend then ran in a directory no capability answer
//    covered. Executed on this head before the fix: with
//    `ANTONINA_TEST_BACKEND_NO_INVOCATION_CWD=1` and a launcher-shaped
//    reservation, `_runner` exited 0, a real child ran in the declared
//    directory, and the record said `state succeeded` with `invocation_cwd`
//    set. `authorizeLaunch` re-decides the same question at the spawn.
//
// 2. The claim. `claimRunner` checked the reservation's generation and mode and
//    no owner identity at all, so any process that could name an agent id and a
//    generation could consume any reservation carrying that generation,
//    including one whose owner was alive and was somebody else. The claim is now
//    made against the identity that wrote the reservation: pid plus live
//    `/proc` start time, or the launcher's own stamp on this runner's
//    environment for the ordinary detached shape, where the kernel has already
//    reparented the runner and no parent link is left to verify. No process
//    name is read anywhere in that decision, or anywhere else in this package.
//
// Test safety, per AGENTS.md: both XDG homes are pointed at throwaway
// directories, so nothing here can read or write the operator's trust.json or
// credential.json, and the only processes spawned are the fixture backends,
// which exit on their own and are reaped by the runner or killed at teardown.

// The `2026-10-04` note below is not a date of the fix; it records that these
// cases were derived by execution on this head, not by reading the diff.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

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

// The backend under test records that it ran, and where, before exiting. The
// marker is what makes "no launch happened" an observation rather than an
// inference from the durable record: a runner that refused must leave no child,
// and a runner that launched must leave a child in the directory the record
// declares, not in the directory the runner process happened to sit in.
function fakeBackend(t, marker, body = `#!/bin/sh\nprintf '%s %s\\n' "$$" "$(pwd -P)" >> ${JSON.stringify(marker)}\nexit 0\n`) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-launch-gate-'));
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

// Both XDG homes, because a test that could reach the operator's
// trust.json/credential.json is a test that can corrupt them.
function scratch(t, backend, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-launch-gate-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const env = {
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    ANTONINA_OPENCODE_BIN: backend,
    ...extraEnv,
  };
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
    owner_start_ticks: 0,
    ...overrides,
  };
}

let agentCounter = 0;

function agent(t, options, overrides = {}) {
  // A unique id per call: several cases below need more than one record, and a
  // second `createAgentDirectory` on the same id returns false and would make a
  // fixture failure look like a lifecycle failure.
  agentCounter += 1;
  const id = `a197${agentCounter.toString(16)}`;
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-launch-gate-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, options);
  return { id, cwd };
}

function backendRuns(marker) {
  if (!existsSync(marker)) return [];
  return readFileSync(marker, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

test('a withdrawn invocation-cwd capability refuses the launch, and the refusal is a stated failed invocation', async (t) => {
  if (!requireProc(t)) return;
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-withdrawn.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend, { ANTONINA_TEST_BACKEND_NO_INVOCATION_CWD: '1' });
  const { id, cwd } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, options);

  assert.deepEqual(backendRuns(marker), [], 'no backend process may be spawned with the capability withdrawn');
  const after = readMeta(id, options);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /backend cannot run this invocation in the declared working directory/);
  // The observation of where a front ran stays unwritten, because no front ran.
  assert.equal(after.invocation_cwd, null);
  assert.equal(after.pid, null);
  assert.equal(after.started_at, null);
  // Coherent stop/kill/delete state: the claim is released, so a later control
  // command is not told this front is busy on a runner that will never run.
  // `runner_pid` keeps naming the process that held the claim and then refused
  // it, exactly as every other refusal on this path does; it names a process
  // that has exited, so it grants nothing.
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
  // The directory the front declared is untouched; refusing a launch is not
  // refusing the front.
  assert.equal(after.cwd, cwd);
});

test('the same launch with the capability intact still spawns in the declared directory', async (t) => {
  if (!requireProc(t)) return;
  // The gate above is a decision, not a blanket refusal. Without this half, a
  // guard that refused every launch would pass the case above.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-intact.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const { id, cwd } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, options);

  // The fake binary is also what the session-discovery probe executes, in the
  // runner's own directory, so the assertion is on the invocation's line rather
  // than on the number of lines.
  const invocations = backendRuns(marker).filter((line) => line.split(' ')[1] === cwd);
  assert.equal(invocations.length, 1, `exactly one invocation must have run in ${cwd}; saw ${JSON.stringify(backendRuns(marker))}`);
  const after = readMeta(id, options);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.invocation_cwd, cwd);
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
});

test('a runner cannot claim a reservation owned by another live process', async (t) => {
  if (!requireProc(t)) return;
  // A live, unrelated process: not this runner, and not this runner's parent --
  // a sibling the reservation merely names. Its identity is real and correct,
  // which is exactly what makes the case worth having: before the fix nothing
  // here was consulted at all, and any process that could name an agent id and
  // a generation consumed any reservation carrying that generation.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-live-owner.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const foreign = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => {
    try { process.kill(-foreign.pid, 'SIGKILL'); } catch {}
    try { process.kill(foreign.pid, 'SIGKILL'); } catch {}
  });
  const foreignTicks = procStartTicks(foreign.pid);
  if (foreignTicks === null) {
    t.skip('the foreign owner process has no readable start time');
    return;
  }

  for (const [label, owner] of [
    ['a live owner with a matching start time', { owner_pid: foreign.pid, owner_start_ticks: foreignTicks }],
    [
      'a live owner with a start time that is not its own',
      { owner_pid: foreign.pid, owner_start_ticks: foreignTicks + 1 },
    ],
  ]) {
    const { id } = agent(t, options, {
      state: 'running',
      runner_gen: 7,
      runner_reservation: reservation({ gen: 7, ...owner }),
      pending_prompt: 'work',
    });
    await runManagedRunner(id, 'new', 7, options);
    const after = readMeta(id, options);
    assert.equal(after.runner_reservation.state, 'reserved', `${label}: the reservation must stay unclaimed`);
    assert.equal(after.runner_pid, null, `${label}: the claim must not publish this process as the runner`);
    assert.equal(after.active_runner, false, `${label}: no runner may take an unverified reservation`);
    assert.equal(after.pending_prompt, 'work', `${label}: an unclaimed reservation keeps its accepted prompt`);
    assert.equal(after.state, 'running', `${label}: the reservation is still in flight, so the record is not rewritten`);
  }
  assert.deepEqual(backendRuns(marker), [], 'no backend process may be spawned off an unverified reservation');
});

test('a reservation whose owner is gone needs the launcher identity its own reservation was stamped with', async (t) => {
  if (!requireProc(t)) return;
  // The ordinary detached launch has the reserving CLI exit before the runner
  // reaches its first durable write, and the kernel reparents the runner, so the
  // owner is genuinely unverifiable by parentage there. What the runtime still
  // requires is the launcher's own stamp beside the argv it passed, plus this
  // process having been created after the recorded owner started. A reservation
  // that a process merely wrote for itself, with no such stamp, is refused --
  // that is the shape the hand-written reservation in the reproduced bypass had.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-reparented.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  // A pid no live process holds, and a start time before this one existed.
  const deadOwner = { owner_pid: 999999, owner_start_ticks: 1 };

  const unlaunched = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner }),
    pending_prompt: 'work',
  });
  await runManagedRunner(unlaunched.id, 'new', 7, options);
  const refused = readMeta(unlaunched.id, options);
  assert.equal(refused.runner_reservation.state, 'reserved', 'a dead owner alone must not authorize a claim');
  assert.equal(refused.runner_pid, null, 'the claim must not publish this process as the runner');
  assert.equal(refused.active_runner, false);
  assert.equal(refused.pending_prompt, 'work');
  assert.deepEqual(backendRuns(marker), [], 'nothing may be launched off a reservation this process cannot tie to a launcher');

  const launched = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner }),
    pending_prompt: 'work',
  });
  await runManagedRunner(launched.id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_AGENT_ID: launched.id, ANTONINA_RUNNER_GEN: '7' },
  });
  const accepted = readMeta(launched.id, options);
  assert.equal(accepted.state, 'succeeded', 'the legitimate detached shape must still run its invocation');
  assert.equal(accepted.invocation_cwd, launched.cwd);

  // And the stamp is read as identity, not as a constant: a stamp for another
  // front, or for another generation, is not this runner's to claim with.
  const mismatched = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner }),
    pending_prompt: 'work',
  });
  await runManagedRunner(mismatched.id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_AGENT_ID: 'a196', ANTONINA_RUNNER_GEN: '7' },
  });
  const wrongAgent = readMeta(mismatched.id, options);
  assert.equal(wrongAgent.runner_reservation.state, 'reserved', 'a stamp for another front must not authorize this claim');
  const wrongGeneration = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner }),
    pending_prompt: 'work',
  });
  await runManagedRunner(wrongGeneration.id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_AGENT_ID: wrongGeneration.id, ANTONINA_RUNNER_GEN: '6' },
  });
  assert.equal(
    readMeta(wrongGeneration.id, options).runner_reservation.state,
    'reserved',
    'a stamp for another generation must not authorize this claim',
  );
});

test('an invocation that finishes before its identity can be captured still records where it ran', async (t) => {
  if (!requireProc(t)) return;
  // The one branch `recordSpawned` cannot serve: the child is gone from `/proc`
  // by the time the runner looks for it, so there is no live process to
  // control and no identity to publish -- but the child *was* spawned and did
  // run in the declared directory. `invocation_cwd` is written on this path
  // alone, and deleting that write would leave `ran in:` claiming a front never
  // ran anywhere.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-fast-exit.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const { id, cwd } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, {
    ...options,
    // The identity seam, not a race: the real reading returns null only when
    // the process is already gone, and winning that race with a real backend
    // would be a test that passes or fails with host load.
    childStartTicks: () => null,
  });

  const runs = backendRuns(marker);
  assert.equal(
    runs.filter((line) => line.split(' ')[1] === cwd).length,
    1,
    `the backend must have run once in ${cwd}; saw ${JSON.stringify(runs)}`,
  );
  const after = readMeta(id, options);
  assert.equal(after.invocation_cwd, cwd, 'the observation of where this front ran must survive an unrecorded identity');
  // No partial identity is invented for a process that is already gone.
  assert.equal(after.start_time, null);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
});