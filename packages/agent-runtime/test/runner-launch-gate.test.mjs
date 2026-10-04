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
// 3. The owner token. For the reparented shape the kernel kept no evidence of
//    the launcher link at all, so that verdict fell back to two values the
//    claimant declared about itself in its own environment -- an agent id and a
//    generation, either of which it could simply write. The launcher now mints a
//    cryptographically random token per invocation, persists it in the
//    reservation, and passes it to the runner through the environment it already
//    builds; the runner verifies it instead of accepting a declaration. A
//    genuine token for a *different* invocation does not match, so a runner can
//    never hold authority over an invocation it was not created for.
//
// 4. The `self` verdict. A reservation that names the claiming process's own
//    pid used to be believed on the pid alone, so a record whose recorded
//    `owner_start_ticks` was demonstrably not that process's own start time
//    still published the claim and launched the backend. The `self` shape is
//    now pid plus start time, like `parent`, and the case below is the one that
//    would have failed before -- the head review's A4, which the old
//    `owner_start_ticks: 0` fixture could not have caught.
//
// 5. The two paths the head review found unpinned. The launch gate's
//    self-identity guard, and the fact that a *retry* re-decides the gate rather
//    than inheriting the first attempt's answer. Both need a seam the product
//    does not otherwise expose, and both seams are declared in `RunnerOptions`
//    next to the identity seam above; neither can authorise anything.
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

import {
  idleMeta,
  mintRunnerReservationOwnerToken,
  ownerTokensEqual,
} from '../dist/packages/agent-runtime/src/metadata.js';
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
  // `owner_start_ticks` is this process's own real start time, not `0`. The
  // default owner is this very process -- the launcher-shaped reservation -- and
  // the claim is now decided on pid *and* start time, so a fixture that left
  // the start time at zero was not exercising the shape it claimed to: three
  // cases that are not about ownership were relying on the loose `self` verdict,
  // which is exactly what hid the defect this head was reviewed for.
  return {
    state: 'reserved',
    gen: 7,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    owner_start_ticks: procStartTicks(process.pid) ?? 0,
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
    if (!after.runner_reservation) console.error('DEBUG', label, JSON.stringify(after));
    assert.equal(after.runner_reservation.state, 'reserved', `${label}: the reservation must stay unclaimed`);
    assert.equal(after.runner_pid, null, `${label}: the claim must not publish this process as the runner`);
    assert.equal(after.active_runner, false, `${label}: no runner may take an unverified reservation`);
    assert.equal(after.pending_prompt, 'work', `${label}: an unclaimed reservation keeps its accepted prompt`);
    assert.equal(after.state, 'running', `${label}: the reservation is still in flight, so the record is not rewritten`);
  }
  assert.deepEqual(backendRuns(marker), [], 'no backend process may be spawned off an unverified reservation');
});

test('a reservation whose owner is gone needs the owner token minted for that reservation', async (t) => {
  if (!requireProc(t)) return;
  // The ordinary detached launch: the reserving CLI exits before the runner
  // reaches its first durable write and the kernel reparents the runner, so
  // `/proc/self/stat` reads `ppid == 1` and there is no owner identity left for
  // the kernel to corroborate. The launcher's own token is the only evidence
  // that remains, and it is what this verdict now requires. A reservation that a
  // process merely wrote for itself -- no token -- is refused, which is the shape
  // the hand-written reservation in the reproduced bypass had.
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

  // Same record, plus the token the launcher minted when it wrote it. This is the
  // legitimate detached shape and it must still run its invocation.
  const token = mintRunnerReservationOwnerToken();
  const launched = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner, owner_token: token }),
    pending_prompt: 'work',
  });
  await runManagedRunner(launched.id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_RUNNER_OWNER_TOKEN: token },
  });
  const accepted = readMeta(launched.id, options);
  assert.equal(accepted.state, 'succeeded', 'the legitimate detached shape must still run its invocation');
  assert.equal(accepted.invocation_cwd, launched.cwd);

  // A record whose token is present but whose runner was handed a different one
  // is refused: the token is read as this invocation's identity, not as the mere
  // presence of a value.
  const other = mintRunnerReservationOwnerToken();
  const mismatched = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, ...deadOwner, owner_token: token }),
    pending_prompt: 'work',
  });
  await runManagedRunner(mismatched.id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_RUNNER_OWNER_TOKEN: other },
  });
  assert.equal(
    readMeta(mismatched.id, options).runner_reservation.state,
    'reserved',
    'a token for another value must not authorize this claim',
  );
});

test('a token minted for one invocation cannot be presented by the runner of another', async (t) => {
  if (!requireProc(t)) return;
  // The property that actually matters, and the one a forged declaration could
  // never have: a runner that holds a genuine token -- one this test minted, so
  // the value is real and correctly formed -- still cannot claim a reservation
  // that was created for a *different* invocation. Token equality is per
  // reservation, so authority over one invocation is not authority over any
  // other, and two tokens are never equal by construction.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-cross-token.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const deadOwner = { owner_pid: 999999, owner_start_ticks: 1 };

  // The record carries the token its own launcher minted; the runner presents a
  // different one. Both are real, correctly formed, independently minted values,
  // so nothing about the mismatch is a malformed-input artefact.
  const own = mintRunnerReservationOwnerToken();
  const ownedReservation = reservation({ gen: 7, ...deadOwner, owner_token: own });
  // The token is a real capability for its own reservation, not a decoration:
  // presented against the record it was minted for, the claim succeeds.
  assert.equal(ownerTokensEqual(ownedReservation.owner_token, own), true);
  const notOwn = mintRunnerReservationOwnerToken();
  assert.equal(ownerTokensEqual(ownedReservation.owner_token, notOwn), false);

  for (const [label, presented] of [
    ["another invocation's token", notOwn],
    ['a token minted for a third invocation', mintRunnerReservationOwnerToken()],
    ['an empty value', ''],
    ['a value of the right shape but one character long', own.slice(0, -1)],
  ]) {
    const { id } = agent(t, options, {
      state: 'running',
      runner_gen: 7,
      runner_reservation: { ...ownedReservation },
      pending_prompt: 'work',
    });
    await runManagedRunner(id, 'new', 7, { ...options, env: { ...options.env, ANTONINA_RUNNER_OWNER_TOKEN: presented } });
    const after = readMeta(id, options);
    assert.equal(after.runner_reservation.state, 'reserved', `${label}: the reservation must stay unclaimed`);
    assert.equal(after.runner_pid, null, `${label}: the claim must not publish this process as the runner`);
    assert.equal(after.active_runner, false, `${label}: no runner may take another invocation's reservation`);
    assert.equal(after.pending_prompt, 'work', `${label}: an unclaimed reservation keeps its accepted prompt`);
    assert.equal(after.state, 'running', `${label}: the reservation is still in flight, so the record is not rewritten`);
  }
  assert.deepEqual(backendRuns(marker), [], 'no backend process may be spawned off another invocation\'s token');
});

test('the owner token is not handed to the backend the runner spawns', async (t) => {
  if (!requireProc(t)) return;
  // The token authorises this runner's claim on this reservation and nothing
  // else. It rides in on the runner's own environment, so it is removed before
  // that environment is passed on to the backend: a descendant has no business
  // holding authority over the claim, and `/proc/<pid>/environ` is readable by
  // anything running as this user.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-token-env.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  // One line per backend process: whether the token was present, its pid, and the
  // directory it ran in. The verdict and the observation share a line so that
  // "ran in the declared directory" and "did not receive the token" are one
  // record of the same process rather than two records that have to be matched up.
  const backend = fakeBackend(t, marker, `#!/bin/sh
if [ -n "\${ANTONINA_RUNNER_OWNER_TOKEN+x}" ]; then verdict=token-present; else verdict=token-absent; fi
printf '%s %s %s\\n' "$verdict" "$$" "$(pwd -P)" >> ${JSON.stringify(marker)}
exit 0
`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const token = mintRunnerReservationOwnerToken();
  const { id, cwd } = agent(t, options, {
    state: 'running',
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, owner_pid: 999999, owner_start_ticks: 1, owner_token: token }),
    pending_prompt: 'work',
  });
  await runManagedRunner(id, 'new', 7, {
    ...options,
    env: { ...options.env, ANTONINA_RUNNER_OWNER_TOKEN: token },
  });

  const runs = backendRuns(marker);
  assert.equal(
    runs.filter((line) => line.split(' ')[2] === cwd).length,
    1,
    `the backend must have run once in ${cwd}; saw ${JSON.stringify(runs)}`,
  );
  // Every process this runner started reports the token absent -- the invocation
  // and the post-run session probe alike -- and none reports it present.
  assert.deepEqual(
    runs.filter((line) => !line.startsWith('token-absent ')),
    [],
    `every backend process must run without the token; saw ${JSON.stringify(runs)}`,
  );
  assert.equal(readMeta(id, options).state, 'succeeded', 'the claim itself is unaffected by what the backend inherits');
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
test('the launcher-shaped reservation is claimed against this process own start time, not its pid alone', async (t) => {
  if (!requireProc(t)) return;
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-self-owner.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const selfTicks = procStartTicks(process.pid);

  // Each recorded start time that is not this process's own. `real + 424242`
  // is strictly greater than the real start time, so it cannot be the start
  // time of any process that is claiming; `real - 1` is the near miss; `0` is
  // the value the old fixture helper carried on every case in this file.
  for (const [label, ownerStart] of [
    ['a start time later than this process own', selfTicks + 424242],
    ['a start time one tick earlier than this process own', selfTicks - 1],
    ['no recorded start time at all', 0],
  ]) {
    const { id, cwd } = agent(t, options, {
      runner_gen: 7,
      runner_reservation: reservation({ gen: 7, owner_pid: process.pid, owner_start_ticks: ownerStart }),
      pending_prompt: 'work',
    });

    await runManagedRunner(id, 'new', 7, options);

    const after = readMeta(id, options);
    assert.equal(after.runner_reservation.state, 'reserved', `${label}: the reservation must stay unclaimed`);
    assert.equal(after.runner_pid, null, `${label}: the claim must not publish this process as the runner`);
    assert.equal(after.active_runner, false, `${label}: an unverified claim leaves no active runner`);
    assert.equal(after.state, 'idle', `${label}: a refused claim writes nothing else`);
    assert.equal(after.invocation_cwd, null, `${label}: nothing ran`);
    assert.equal(after.cwd, cwd);
    assert.deepEqual(
      backendRuns(marker).filter((line) => line.split(' ')[1] === cwd),
      [],
      `${label}: a record whose owner identity is false must not launch a backend`,
    );
  }

  // The control, in the same run with the same fixture: the identical record
  // with this process's real start time is claimed and launched. Without it, a
  // check that refused everything would pass the loop above.
  const { id, cwd } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, owner_pid: process.pid, owner_start_ticks: selfTicks }),
    pending_prompt: 'work',
  });
  await runManagedRunner(id, 'new', 7, options);
  assert.equal(
    backendRuns(marker).filter((line) => line.split(' ')[1] === cwd).length,
    1,
    'the real start time must still be accepted, or the case above proves nothing',
  );
  assert.equal(readMeta(id, options).state, 'succeeded');
});

test('a runner that cannot name itself in /proc refuses the launch, with the capability intact', async (t) => {
  if (!requireProc(t)) return;
  // The launch gate's second guard. Before the case existed, making it
  // unreachable left this whole file green: it is load-bearing prose with no
  // test behind it. Driven through the declared seam rather than by needing a
  // host whose `/proc/<pid>/stat` is unreadable, which is not a thing a test
  // can arrange. The capability is *intact* here, so a gate that refused
  // everything would pass this case; the refusal has to be the identity.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-no-self.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker);
  if (backend === null) return;
  const options = scratch(t, backend);
  const { id } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, { ...options, selfStartTicks: () => null });

  assert.deepEqual(backendRuns(marker), [], 'a runner with no readable identity must not spawn anything');
  const after = readMeta(id, options);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /cannot establish its own process identity/);
  assert.equal(after.invocation_cwd, null);
  assert.equal(after.pid, null);
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
});

test('a retry re-decides the launch gate, so a capability withdrawn after the first attempt refuses the second', async (t) => {
  if (!requireProc(t)) return;
  // The retry half of the guarantee. The gate lives inside the attempt loop, so
  // a second attempt is a second launch with its own decision; hoisting the
  // gate above the loop would let this backend run twice in the declared
  // directory. As shipped the classifier marks every backend failure as not
  // automatically retry-safe, so this branch is unreachable without the
  // declared retry seam -- which is why no assertion in the tree could fail if
  // the gate were hoisted. The seam only adds an attempt; the flip below is the
  // capability being withdrawn from the runner's own environment in the window
  // between the two attempts, which is the situation a gate evaluated once
  // would get wrong.
  const marker = join(tmpdir(), `antonina-launch-gate-${process.pid}-retry.marker`);
  rmSync(marker, { force: true });
  t.after(() => rmSync(marker, { force: true }));
  const backend = fakeBackend(t, marker, `#!/bin/sh\nprintf '%s %s\\n' "$$" "$(pwd -P)" >> ${JSON.stringify(marker)}\nprintf '%s\\n' 'Unexpected server error'\nexit 1\n`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const { id, cwd } = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });
  const retryable = { ...options };
  let retryDelayRequests = 0;

  await runManagedRunner(id, 'new', 7, {
    ...retryable,
    retryDelayMs: (attempt) => {
      retryDelayRequests += 1;
      if (attempt !== 0) return null;
      // Withdraw the capability in the runner's own environment, exactly as a
      // host change between the two attempts would. `authorizeLaunch` reads
      // `{ ...process.env, ...options.env }` at each decision.
      retryable.env.ANTONINA_TEST_BACKEND_NO_INVOCATION_CWD = '1';
      return 1;
    },
  });

  assert.equal(
    backendRuns(marker).filter((line) => line.split(' ')[1] === cwd).length,
    1,
    `exactly one attempt may have launched in ${cwd}; saw ${JSON.stringify(backendRuns(marker))}`,
  );
  assert.equal(retryDelayRequests, 1, 'the retry branch must actually have been taken');
  const after = readMeta(id, options);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /backend cannot run this invocation in the declared working directory/);
  // Coherent stop/kill/delete state after a refused retry: the claim is
  // released, exactly as after a refused first attempt.
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
});
