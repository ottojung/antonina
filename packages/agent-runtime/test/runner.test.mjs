import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-RUNNER-FIXTURE-EXEC-OK';

// The runner spawns its backend detached and awaits it, so the fixture backend
// has to be a real executable. On a host whose tmpdir() is mounted noexec a
// fixture there would fail with EACCES; probe the candidate parents and skip
// loudly rather than silently reaching for some other program.
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

// A successful fixture backend: exit 0, no output. Every red direction below
// therefore converges on its own (the runner awaits the child), so no case can
// leak a process.
function fakeBackend(t) {
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
      writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return bin;
    }
    failures.push(`${root}: fixture is not exec-capable`);
  }
  t.skip(`no exec-capable fixture directory for the fake opencode backend; tried: ${failures.join('; ')}`);
  return null;
}

// claimRunner persists the runner's own /proc start ticks, so a host without
// /proc cannot express claimed-runner identity at all.
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
    owner_start_ticks: 0,
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

// The four rejection cases share one assertion shape: a runner that does not own
// the reservation must leave the durable record exactly as it found it, prompt
// included. Every one of these is also a control case: the final test claims the
// very same record with a matching generation, so a rejection above can only
// come from the mismatch and not from a fixture that never runs.
function assertUntouched(id, options, reservationState = 'reserved') {
  const after = readMeta(id, options);
  assert.equal(after.runner_reservation.state, reservationState);
  assert.equal(after.runner_reservation.gen, 7);
  assert.equal(after.runner_reservation.mode, 'new');
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_pid, null);
  assert.equal(after.runner_start_time, null);
  assert.equal(after.state, 'idle');
  assert.equal(after.pending_prompt, 'work');
  assert.equal(after.pid, null);
  assert.equal(after.pgid, null);
  assert.equal(after.invocation_id, null);
  assert.equal(after.started_at, null);
  assert.equal(after.finished_at, null);
  assert.equal(after.exit_code, null);
  assert.equal(after.prompt_count, 0);
}

test('a runner from a superseded generation cannot claim the reservation', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // Generation 6 lost the race for this reservation and must not take it.
  await runManagedRunner(id, 'new', 6, options);

  assertUntouched(id, options);
});

test('a runner claiming the other mode cannot claim the reservation', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, mode: 'new' }),
    pending_prompt: 'work',
  });

  // A 'continue' runner must never take a 'new' reservation: a fresh session
  // would be lost and the wrong native conversation would be continued.
  await runManagedRunner(id, 'continue', 7, options);

  assertUntouched(id, options);
});

test('an already claimed reservation cannot be claimed a second time', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7, state: 'claimed' }),
    pending_prompt: 'work',
  });

  // Two runners racing for one reservation: the loser must find nothing left to
  // claim rather than become a second owner of the same invocation.
  await runManagedRunner(id, 'new', 7, options);

  assertUntouched(id, options, 'claimed');
});

test('a delete-pending agent is never claimed by a runner', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    delete_pending: true,
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // Deletion owns the agent. A runner must not take the reservation, claim the
  // pending prompt, or record itself as the runner.
  await runManagedRunner(id, 'new', 7, options);

  assertUntouched(id, options);
});

test('the owning generation does claim the reservation and its prompt', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, options);

  const after = readMeta(id, options);
  assert.equal(after.runner_pid, process.pid);
  assert.equal(typeof after.runner_start_time, 'number');
  assert.equal(after.active_runner, false);
  assert.equal(after.pending_prompt, null);
  assert.equal(after.prompt_count, 0);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.exit_code, 0);
  assert.equal(after.runner_reservation, null);
});
