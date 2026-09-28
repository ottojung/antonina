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
// leak a process. `body` overrides the script for cases that need a backend
// which dies some other way, and must still resolve through the same exec-root
// probe: a fixture on a noexec tmpdir would silently skip instead of testing.
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
  const env = {
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    ANTONINA_OPENCODE_BIN: backend,
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

// A synthetic cgroup for the runner's capacity seam. 30 GiB limit; `used` GiB of
// usage, so the headroom the guard sees is (30 - used) GiB.
function cgroup(usedGiB, extra = {}) {
  const gib = 1024 * 1024 * 1024;
  const files = new Map([
    ['/sys/fs/cgroup/memory.max', String(30 * gib)],
    ['/sys/fs/cgroup/memory.current', String(Math.round(usedGiB * gib))],
    ['/sys/fs/cgroup/memory.events', 'oom 39\noom_kill 3\n'],
    ['/proc/self/cgroup', '0::/\n'],
    ...Object.entries(extra),
  ]);
  return (path) => files.get(path) ?? null;
}

test('a. a completely full host still launches, because launch is not host-capacity policy', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // memory.current equals memory.max: zero headroom, the exact host this issue
  // was written on. The previous branch refused here, so on this host every
  // launch was impossible. The intent record requires that the launch proceed
  // and that host state be reported rather than enforced, so this asserts the
  // launch happened and consumed its prompt normally.
  await runManagedRunner(id, 'new', 7, { ...options, capacity: { readText: cgroup(30) } });

  const after = readMeta(id, options);
  assert.equal(after.state, 'succeeded', 'a full host must not block a valid launch');
  assert.equal(after.exit_code, 0);
  assert.equal(after.error, null);
  assert.equal(after.pending_prompt, null, 'the accepted prompt was delivered, not refused');
  assert.ok(after.invocation_id !== null, 'an invocation really was spawned');
});

// Records an operator intent into the agent metadata mid-invocation, the way
// `antonina agent stop`/`kill` does, and optionally marks the synthetic OOM
// drift marker on the way. It cannot be seeded into the metadata up front
// instead: `claimPendingPrompt` refuses to claim a prompt for a stop-like
// agent, so a pre-seeded intent would stop the invocation from ever starting,
// and the two cases below are precisely about what happens when the intent
// lands while an invocation is already live. `die` selects whether the fixture
// then SIGKILLs itself; it is the whole difference between the two cases.
function intentFixture(t, id, options, { intent, marker = '', die = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, 'record-intent.mjs');
  writeFileSync(helper, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const [path, intent, marker, die] = process.argv.slice(2);',
    'const meta = JSON.parse(readFileSync(path, "utf8"));',
    'meta.intent = intent;',
    'meta.stop_reason = intent;',
    'writeFileSync(path, JSON.stringify(meta));',
    'if (marker !== "") writeFileSync(marker, "");',
    'if (die === "1") process.kill(process.pid, "SIGKILL");',
    'else setInterval(() => {}, 1000);',
  ].join('\n'));
  const argv = [helper, metaPath(id, options), intent, marker, die ? '1' : '0']
    .map((value) => JSON.stringify(value))
    .join(' ');
  return `node ${argv}`;
}

// A fake backend whose first act is to record an operator intent and then either
// die on its own or wait to be signalled. `exec` keeps the recorded pid as the
// process group leader, so the runner signals the very process the fixture is.
function intentBackend(t, id, options, config) {
  return fakeBackend(t, `#!/bin/sh\necho "starting"\nexec ${intentFixture(t, id, options, config)}\n`);
}

test('a. a queued steer is delivered on a full host rather than dropped', async (t) => {
  if (!requireProc(t)) return;
  // The steer path used to reach runInvocation with a prompt popped out of the
  // steer queue and had no pre-check of its own, so a capacity refusal consumed
  // the steer and dropped it. With the refusal removed there is no longer a
  // refusal path, and this pins the property that actually matters: FIFO steer
  // ordering is preserved and a steer on a full host is delivered, not lost.
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    prompt_count: 1,
    steer_seq: 1,
    steer_queue: [{ seq: 1, prompt: 'redirect the run', queued_at: 1 }],
  });

  await runManagedRunner(id, 'new', 7, { ...options, capacity: { readText: cgroup(30) } });

  const after = readMeta(id, options);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.steer_queue.length, 0, 'the queued steer was delivered, not dropped');
  assert.ok(after.prompt_count >= 1, 'the steer was delivered to the backend');
  assert.equal(after.error, null);
});

test('a. the runner spawns and succeeds on a host with headroom', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // 20 GiB of headroom. The same path as the full-host case, which now also
  // succeeds: host memory is observed for diagnostics, never used to decide.
  await runManagedRunner(id, 'new', 7, { ...options, capacity: { readText: cgroup(10) } });

  const after = readMeta(id, options);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.exit_code, 0);
  assert.equal(after.error, null);
});

test('c. the runner proceeds, with a stated reason, when no cgroup limit can be read', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // memory.max reads "max": no hard limit, so headroom is unknown. The launch
  // proceeds and the degraded reading is simply absent from the death record.
  await runManagedRunner(id, 'new', 7, {
    ...options,
    capacity: { readText: cgroup(1, { '/sys/fs/cgroup/memory.max': 'max\n' }) },
  });

  const after = readMeta(id, options);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.error, null);
});

// A cgroup whose OOM counters advance while the child is alive. The fixture
// backend touches `markerPath` immediately before killing itself, and the
// cgroup reading reports the post-death counters once that marker exists. This
// is what makes the before/after bracket mean something: the kernel's counters
// are cumulative, so a constant fixture would make every delta zero and the
// bracket would assert nothing at all.
function cgroupWithOomDrift(usedGiB, markerPath) {
  const base = cgroup(usedGiB);
  return (path) => {
    if (path.endsWith('memory.events')) {
      return existsSync(markerPath)
        ? 'oom 40\noom_kill 4\n'
        : 'oom 39\noom_kill 3\n';
    }
    return base(path);
  };
}

test('e. a backend killed by a signal is recorded as an external kill, not a backend failure', async (t) => {
  if (!requireProc(t)) return;
  // A backend that kills itself with SIGKILL: the runner observes the child
  // exit on signal 9, with a log that never names a backend error. It touches
  // the marker on its way out, so the cgroup's OOM counters have advanced by
  // the time the runner takes its post-death reading.
  const marker = join(mkdtempSync(join(tmpdir(), 'antonina-oom-')), 'died');
  t.after(() => rmSync(join(marker, '..'), { recursive: true, force: true }));
  const backend = fakeBackend(t, `#!/bin/sh\necho "starting"\n: >'${marker}'\nkill -KILL $$\n`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  await runManagedRunner(id, 'new', 7, {
    ...options,
    capacity: { readText: cgroupWithOomDrift(1, marker) },
  });

  const after = readMeta(id, options);
  assert.equal(after.state, 'failed');
  assert.equal(after.exit_signal, 9);
  // The classification, not the exit code, is what a reader acts on.
  assert.equal(after.backend_error.classification, 'external_signal_kill');
  assert.notEqual(after.backend_error.classification, 'transient_backend_server_error');
  assert.equal(after.backend_error.signal, 9);
  assert.equal(after.backend_error.signal_name, 'SIGKILL');
  // The OOM counters rose across the lifetime, which is the kernel's own
  // statement that the OOM killer fired inside the window.
  assert.equal(after.backend_error.oom_evidence, 'observed');
  assert.equal(after.backend_error.oom_delta, 1);
  assert.equal(after.backend_error.oom_kill_delta, 1);
  // A host kill is not a retryable model failure.
  assert.equal(after.backend_error.transient, false);
  assert.equal(after.backend_error.automatic_retry_safe, false);
  assert.match(after.error, /SIGKILL \(signal 9\)/);
  assert.match(after.error, /OOM killer fired inside the agent lifetime/);
});

test('e. a signal death with no readable OOM counters says the evidence is unavailable', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t, '#!/bin/sh\nkill -KILL $$\n');
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });

  // No memory.events at all: the record must not read as "no OOM happened".
  const noEvents = cgroup(1);
  await runManagedRunner(id, 'new', 7, {
    ...options,
    capacity: {
      readText: (path) => (path.endsWith('memory.events') ? null : noEvents(path)),
    },
  });

  const after = readMeta(id, options);
  assert.equal(after.state, 'failed');
  assert.equal(after.backend_error.classification, 'external_signal_kill');
  assert.equal(after.backend_error.oom_evidence, 'unavailable');
  assert.equal(after.backend_error.oom_kill_delta, null);
  assert.match(after.error, /OOM involvement is unknown rather than absent/);
});

test('e. a signal death with a steer pending and no operator signal is an external kill', async (t) => {
  if (!requireProc(t)) return;
  // The steer intent is persisted, so the guard sees an operator request. What
  // makes this an external death is that the process is gone before the
  // runner's first control poll at CONTROL_POLL_MS (200ms) can signal it, which
  // is the same timing shape the test above already relies on: a /bin/sh that
  // SIGKILLs itself exits in single-digit milliseconds. Before this was
  // classified, the persisted steer mapped this death to a clean `stopped` with
  // a null backend_error, which reads as an intentional stop and invites no
  // investigation of a host that was killing agents.
  const marker = join(mkdtempSync(join(tmpdir(), 'antonina-steer-')), 'died');
  t.after(() => rmSync(join(marker, '..'), { recursive: true, force: true }));
  const backend = fakeBackend(t, `#!/bin/sh\necho "starting"\n: >'${marker}'\nkill -KILL $$\n`);
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
    intent: 'steer',
    stop_reason: 'steer',
    steer_seq: 0,
    steer_queue: [],
  });

  await runManagedRunner(id, 'new', 7, {
    ...options,
    capacity: { readText: cgroupWithOomDrift(1, marker) },
  });

  const after = readMeta(id, options);
  // Not a stop: nothing here stopped it, and a `stopped` reading is exactly the
  // misdiagnosis this test exists to prevent.
  assert.equal(after.state, 'failed');
  assert.equal(after.exit_signal, 9);
  assert.equal(after.backend_error.classification, 'external_signal_kill');
  assert.equal(after.backend_error.signal, 9);
  assert.equal(after.backend_error.backend_scope, 'host');
  assert.equal(after.backend_error.oom_evidence, 'observed');
  assert.equal(after.backend_error.oom_kill_delta, 1);
  assert.match(after.error, /SIGKILL \(signal 9\)/);
  // The steer is still on the record: the operator did ask for it, it simply
  // never took effect.
  assert.equal(after.stop_reason, 'steer');
});

test('e. a steer the runner itself signalled is still recorded as a clean stopped', async (t) => {
  if (!requireProc(t)) return;
  // The complement of the case above, and the guard against over-correcting it.
  // A steer that this runner signalled is an operator decision, so classifying
  // it as an external kill would be a false positive. This backend outlives the
  // control poll, so the runner really does send the signal.
  const backend = fakeBackend(t, '#!/bin/sh\necho "starting"\nsleep 30\n');
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
    intent: 'steer',
    stop_reason: 'steer',
    steer_seq: 0,
    steer_queue: [],
  });

  await runManagedRunner(id, 'new', 7, {
    ...options,
    capacity: { readText: cgroup(1) },
  });

  const after = readMeta(id, options);
  assert.equal(after.state, 'stopped');
  assert.equal(after.stop_reason, 'steer');
  // An operator-requested termination is not an external kill, and saying so
  // would point the next reader at the host instead of at their own steer.
  assert.equal(after.backend_error, null);
  assert.equal(after.error, null);
});

test('e. a kill intent does not excuse a host kill that beat the control poll', async (t) => {
  if (!requireProc(t)) return;
  // A persisted kill intent is not evidence that the operator's signal reached
  // the invocation. This invocation records the intent and then SIGKILLs itself
  // in the same process, so it dies before the 200 ms control poll can run again
  // and observe what it wrote. The death is the host's, and the classification
  // has to say so. Keying the classification off the intent instead recorded a
  // null `backend_error` and no death classification at all, which is the exact
  // failure this classification exists to remove, and the reason the steer case
  // needed `operatorSignalled` in the first place.
  // The agent record has to exist before the fixture can be told where to write
  // the intent, so the backend is bound after `scratch` and re-pointed here.
  const options = scratch(t, '/nonexistent/backend');
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });
  const marker = join(mkdtempSync(join(tmpdir(), 'antonina-oom-')), 'died');
  t.after(() => rmSync(join(marker, '..'), { recursive: true, force: true }));
  const backend = intentBackend(t, id, options, { intent: 'kill', marker, die: true });
  if (backend === null) return;
  const run = { ...options, env: { ...options.env, ANTONINA_OPENCODE_BIN: backend } };

  await runManagedRunner(id, 'new', 7, {
    ...run,
    capacity: { readText: cgroupWithOomDrift(1, marker) },
  });

  const after = readMeta(id, run);
  // The operator's own kill request is still on the record, and `state` still
  // answers "what did the operator ask for", because the durable intent is a
  // real operator-authored fact and discarding it would contradict the very
  // stop/kill coherence this repository treats as non-negotiable. What changed
  // is the other half: the death itself is now classified. Before the fix this
  // was a null `backend_error` with no death classification and a null `error`,
  // which is a host OOM kill indistinguishable from a clean operator kill.
  assert.equal(after.stop_reason, 'kill');
  assert.equal(after.state, 'killed');
  assert.equal(after.exit_signal, 9);
  assert.equal(after.backend_error.classification, 'external_signal_kill');
  assert.equal(after.backend_error.signal_name, 'SIGKILL');
  assert.equal(after.backend_error.oom_evidence, 'observed');
  assert.equal(after.backend_error.oom_kill_delta, 1);
  // A host kill is not a retryable model failure, and this one is nobody's
  // request, so it must not be advertised as safe to retry.
  assert.equal(after.backend_error.transient, false);
  assert.equal(after.backend_error.automatic_retry_safe, false);
  assert.match(after.error, /SIGKILL \(signal 9\)/);
  assert.match(after.error, /OOM killer fired inside the agent lifetime/);
});

test('e. a stop intent the runner itself signalled is still a clean stopped', async (t) => {
  if (!requireProc(t)) return;
  // The complement of the case above, and the guard against over-correcting it.
  // The invocation is still alive when the control poll runs, so the poll really
  // does send the signal and the death is the operator's. Reporting it as a host
  // kill would point the next reader at the host instead of at their own stop.
  // The agent record has to exist before the fixture can be told where to write
  // the intent, so the backend is bound after `scratch` and re-pointed here.
  const options = scratch(t, '/nonexistent/backend');
  const id = agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
  });
  const backend = intentBackend(t, id, options, { intent: 'stop' });
  if (backend === null) return;
  const run = { ...options, env: { ...options.env, ANTONINA_OPENCODE_BIN: backend } };

  await runManagedRunner(id, 'new', 7, {
    ...run,
    capacity: { readText: cgroup(1) },
  });

  const after = readMeta(id, run);
  assert.equal(after.stop_reason, 'stop');
  assert.equal(after.state, 'stopped');
  assert.equal(after.backend_error, null);
  assert.equal(after.error, null);
});

// Board 112. A spawn can be started and then rejected by a control path that
// commits between the runner's own read of the record and its write of it:
// recordSpawned's callback (runner.ts:199) returns early on
// `deletePendingFlag(meta) !== false || stopLikeOrMalformed(meta)`, so
// runInvocation kills the process group and returns false at runner.ts:396
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
// sub-millisecond, and a fixture that tried to win it from another process would
// be a timing test that passes or fails with host load. The StoreFs seam
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
      // packages/cli/src/agent.ts:727-737, committed through the real writer.
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
  const run = { ...options, fs: race.fs, capacity: { readText: cgroup(1) } };

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
  // The claim is released. This is the part a survivor of runner.ts:396 would
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
    capacity: { readText: cgroup(1) },
  });
  const rerun = readMeta(id, options);
  assert.equal(rerun.state, 'succeeded', 'a stop that rejected a spawn does not block the next run');
  assert.equal(rerun.active_runner, false);
  assert.equal(rerun.runner_reservation, null);
});
