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
// `spawn`, not `spawnSync`, is board 98's: the reaper cases at the foot of this
// file spawn a real process and assert on its markers. Board 112's rejected-spawn
// case needs the nine-member StoreFs seam above and nothing from
// `node:child_process`, so the two import sets are disjoint and the union is
// both boards' requirements with neither one's assertion dropped.
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { beginInvocation, beginStopLike, finalizeTerminal } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { envHasAgentMarker, envHasInvocationMarker, procStartTicks, processIsZombie } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { boundMs, installSuiteBound, registerCleanup, registerReap } from './support/suite-bound.mjs';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-RUNNER-FIXTURE-EXEC-OK';

// The two intent cases drive a real detached backend and wait for a recorded
// signal, so they are the only tests in this file that can wedge rather than
// fail. A wall-clock bound turns a hang into a failed test with a number on it,
// which is the difference between a usable gate and an unusable one; it is
// deliberately generous, because the bound is here to stop a deadlock and not
// to ration a passing run.
//
// The bound has to be passed in the OPTIONS OBJECT, as the second argument:
// `test(name, options, fn)`. Written as a trailing third argument it looks
// equivalent and is not -- node reads the second argument as `options`, so a
// trailing `{ timeout }` is silently discarded and the test runs unbounded. A
// deliberate hang (the intent fixture never recording an intent, so the control
// poll never signals) is the only way to see this, because a healthy run never
// reaches the bound and so cannot distinguish a bound that fires from one that
// was thrown away.
//
// It is only half a bound. A per-test timeout bounds the test; it does not
// bound this file, because a test that times out never runs its `t.after` hooks
// and the `ChildProcess` handle of the detached backend stays ref'd, so the
// file process never exits and `npm test` never returns. The four constants
// below are the other halves, and they are in increasing order of bluntness:
// the fixture's own lifetime (it never waits to be signalled forever), the
// per-test timeout (a wedged test becomes a failed test), and the two suite
// bounds (a wedged *file* reaps its invocation and exits non-zero). Every one
// of them is a ceiling: the environment may shorten a bound, never lengthen
// it, so no value of any of these variables can put a run back where it
// started. See `support/suite-bound.mjs` for the process-level half.
const FIXTURE_LIFETIME_MS = boundMs('ANTONINA_TEST_FIXTURE_LIFETIME_MS', 60_000);
const INTENT_TEST_TIMEOUT_MS = boundMs('ANTONINA_TEST_CASE_TIMEOUT_MS', 120_000);
const SUITE_STALL_MS = boundMs('ANTONINA_TEST_SUITE_STALL_MS', 180_000);
const SUITE_WALL_MS = boundMs('ANTONINA_TEST_SUITE_BOUND_MS', 300_000);

// The bound is installed before the first test is declared, so it is armed for
// the whole file including the module-level work. `stallMs` is the condition
// that does the work on a loaded host: this file takes about 12s green, so
// three minutes without a single test completing is not a slow host, it is a
// wedge.
installSuiteBound({
  description: 'packages/agent-runtime/test/runner.test.mjs',
  suiteMs: SUITE_WALL_MS,
  stallMs: SUITE_STALL_MS,
});

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
  // The scratch home is removed by the hook above on every path that reaches
  // it. A test that wedges never reaches it, so the suite bound is also given
  // the path, to keep a bounded-out run from leaving a state home behind.
  registerCleanup(`scratch home ${root}`, () => {
    rmSync(root, { recursive: true, force: true });
    return 'removed';
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
  registerCleanup(`agent cwd ${cwd}`, () => {
    rmSync(cwd, { recursive: true, force: true });
    return 'removed';
  });
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, options);
  // The suite bound's reaper for this agent. It is registered here, before the
  // runner has spawned anything, because the moment it would be useful to
  // register it -- after the spawn is on the record -- is exactly the moment a
  // wedged test never reaches.
  //
  // The body is `reapInvocation`, named and top-level rather than inline, so the
  // tests below can call the reaper this suite actually ships instead of a
  // copy of it. A reaper that can only be observed in a wedge is a reaper with
  // no coverage at all, and the start-ticks check in particular is the one line
  // here that must never be deleted silently.
  registerReap(`agent ${id} invocation`, () => reapInvocation(id, options));
  return id;
}

// The reaper the runner suite registers, and the one the tests below drive.
// It identifies the invocation the way the product does: from the durable record
// the runner itself wrote, requiring the pid's /proc start ticks to match the
// ones recorded beside it AND the target's own environ to carry this agent's
// and this invocation's markers, and only then signalling the recorded process
// group. That is `process.ts:148-152`, in the same order, for the same reason:
// a pid whose start ticks do not match is a recycled pid belonging to somebody
// else, and a pid that is not carrying our markers is not our invocation at all,
// so both are reported and left alone. Nothing here is ever found by process
// name. The markers are defence in depth -- the record is only ever written by
// the runner immediately after `spawn` -- but a reaper that is going to
// SIGKILL a whole process group on the strength of a pid and a tick count
// should be held to the same identity rule as the product, and a comment that
// claims a check the code does not make is worse than no comment.
function reapInvocation(id, options) {
  const live = readMeta(id, options);
  if (live === null) return 'no durable record, so no identity to signal';
  const { pid, pgid, start_time: startTime, invocation_id: invocationId } = live;
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'no recorded invocation pid, so nothing was left running by the runner';
  if (procStartTicks(pid) !== startTime) {
    return `pid ${pid} no longer has the recorded start ticks ${startTime}; not signalled`;
  }
  if (!envHasAgentMarker(pid, id) || !envHasInvocationMarker(pid, invocationId)) {
    return `pid ${pid} is the recorded pid but does not carry this invocation's environ markers; not signalled`;
  }
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    return `pid ${pid} is the recorded invocation but no process group is recorded; not signalled`;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
    return `SIGKILLed process group ${pgid} (pid ${pid}, start ticks ${startTime})`;
  } catch (error) {
    return `could not SIGKILL process group ${pgid}: ${error && error.code ? error.code : String(error)}`;
  }
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
//
// The fixture waits for the spawn to be on the record before it writes, and it
// writes through the store's own `updateMeta` rather than onto the file. It is
// the backend the runner itself spawned, so it used to start racing the
// runner's own `recordSpawned` read-modify-write on the very same `meta.json`,
// and only one of the three possible orderings is safe. If the intent landed
// before `recordSpawned` read, `stopLikeOrMalformed` made `recordSpawned`
// refuse, and the runner killed its own child and returned without finalising
// anything, leaving `state: 'running'`. If it landed inside that read/write
// window the intent was silently clobbered, the control poll never saw an
// intent, no signal was ever sent, and the run hung forever leaving an orphan.
// Both halves of that window were real at different rates: the ordering was
// only ever narrowed by waiting, and the write itself was a plain
// `writeFileSync` that the runner's reader could observe truncated. So the
// helper does what production does -- `updateMeta` under the metadata lock,
// committed by a temp file and an atomic rename -- and the wait for a non-null
// `pid` stays as well, putting the write strictly after `recordSpawned` has
// committed, which is the only safe ordering. The runner performs no other
// metadata write between that commit and finalisation, so nothing can clobber
// the intent afterwards either. This is the test's ordering obligation, not a
// product change.
function intentFixture(t, id, options, { intent, marker = '', die = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-intent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registerCleanup(`intent fixture ${root}`, () => {
    rmSync(root, { recursive: true, force: true });
    return 'removed';
  });
  // The file the fixture writes if it gives up waiting to be signalled. It is
  // not a diagnostic: it is how the tests below tell a real signal from a
  // fixture that gave up, which the durable record cannot. A runner that never
  // signals leaves an invocation that ends anyway, and the record of an
  // invocation that ended by itself with a `stop` intent on it reads exactly
  // like the record of one the runner stopped. `intentBackend` hands the path
  // back to the test that has to assert on it.
  const gaveUp = join(root, 'gave-up');
  const helper = join(root, 'record-intent.mjs');
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs';",
    'const [storeUrl, agentId, intent, marker, gaveUp, die, stateHome, configHome] = process.argv.slice(2);',
    'const { readMeta, updateMeta } = await import(storeUrl);',
    'const options = { env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome } };',
    'const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };',
    // The same fake backend serves every `<opencode> ...` invocation the runner
    // makes, so the helper's own arguments come first and the backend's follow.
    // `session list` and `models` are metadata probes: the answer is "no
    // session" and "model unknown", which the runner already reads off a zero
    // exit with empty output. They used to fall through to the wait below and
    // burn the whole probe timeout, once per invocation and per test, on a
    // path that can never produce a record to write into.
    'const backendArgv = process.argv.slice(10);',
    'if (backendArgv[0] === "session" || backendArgv[0] === "models") process.exit(0);',
    'if (backendArgv[0] !== "run") {',
    '  process.stderr.write(`record-intent: unexpected backend invocation: ${backendArgv.join(" ")}\\n`);',
    '  process.exit(4);',
    '}',
    // `pid` is set only by `recordSpawned`, and only after it has taken the
    // metadata lock, committed, and released it. Polling `readMeta` rather than
    // parsing the file keeps a torn read from looking like a missing record.
    'const deadline = Date.now() + 30000;',
    'let meta = null;',
    'while (Date.now() < deadline) {',
    '  try { meta = readMeta(agentId, options); } catch { meta = null; }',
    '  if (meta !== null && meta.pid !== null && meta.pid !== undefined) break;',
    '  sleep(2);',
    '}',
    'if (meta === null || meta.pid === null || meta.pid === undefined) {',
    '  // The spawn never reached the record, so there is no safe ordering to',
    '  // write into. Exiting non-zero ends the invocation immediately instead',
    '  // of racing it, so a regression here fails the assertions rather than',
    '  // hanging the suite and leaking a detached child.',
    '  process.stderr.write("record-intent: recordSpawned never committed; refusing to race it\\n");',
    '  process.exit(3);',
    '}',
    // The intent is written through the store\'s own updateMeta, so it takes the',
    // metadata lock, lands via a temp file and an atomic rename, and cannot',
    // interleave with the runner\'s read-modify-write or be read half-written.',
    'await updateMeta(agentId, (current) => {',
    '  if (current.pid === null || current.pid === undefined) process.exit(3);',
    '  current.intent = intent;',
    '  current.stop_reason = intent;',
    '}, options);',
    'if (marker !== "") writeFileSync(marker, "");',
    'if (die === "1") process.kill(process.pid, "SIGKILL");',
    // Otherwise: wait to be signalled, but not forever. This used to be
    // `setInterval(() => {}, 1000)`, which is "wait for a signal a broken
    // runtime may never send, indefinitely". A fixture that waits forever
    // decides the outcome of the whole run: the runner awaits this child, so
    // nothing converges, the file's `t.after` hooks never run, the child stays
    // alive, and the suite hangs rather than failing. Nothing about that hang
    // is evidence about the runtime.
    //
    // Giving up is not the same as passing, and the difference has to be
    // legible from outside this process, because the durable record cannot
    // express it: an invocation that ends by itself with a `stop` intent
    // already on it records `state: stopped`, `stop_reason: stop`, a null
    // `backend_error` and a null `error` -- byte for byte the record of an
    // invocation the runner signalled. So the give-up is announced on the file
    // the tests pass in, and asserted absent. The exit code is left alone: a
    // non-zero one would be classified as a backend failure, which is a
    // different claim, and would make the record say something untrue about why
    // this invocation ended.
    //
    // It costs a healthy run nothing: the control poll runs 200ms after the
    // intent lands, so a green run is signalled long before this line.
    //
    // These three lines are written as outer template literals on purpose.
    // Written as plain single-quoted strings they would leave
    // `${FIXTURE_LIFETIME_MS}` in the generated source for the FIXTURE to
    // interpolate, and the fixture has no such binding: the give-up would throw
    // a ReferenceError and exit 1 without ever writing the file the test
    // asserts on, which is the one failure mode this whole arrangement exists
    // to prevent. The numbers are substituted here, where they are in scope.
    `sleep(${FIXTURE_LIFETIME_MS});`,
    `process.stderr.write("record-intent: still unsignalled after ${FIXTURE_LIFETIME_MS}ms; giving up so the run can fail rather than hang\\n");`,
    `writeFileSync(gaveUp, "${FIXTURE_LIFETIME_MS}\\n");`,
    'process.exit(0);',
  ].join('\n'));
  const storeUrl = new URL('../dist/packages/agent-runtime/src/store.js', import.meta.url).href;
  const argv = [
    helper,
    storeUrl,
    id,
    intent,
    marker,
    gaveUp,
    die ? '1' : '0',
    options.env.XDG_STATE_HOME,
    options.env.XDG_CONFIG_HOME,
  ]
    .map((value) => JSON.stringify(value))
    .join(' ');
  return { command: `node ${argv}`, gaveUpPath: gaveUp };
}

// A fake backend whose first act is to record an operator intent and then either
// die on its own or wait to be signalled. `exec` keeps the recorded pid as the
// process group leader, so the runner signals the very process the fixture is.
// `"$@"` matters: the runner reaches this same binary for `session list` and
// `models` as well as for the invocation itself, and the helper tells those
// apart by the subcommand it is handed.
//
// `gaveUpPath` is the file the fixture writes if it stops waiting without ever
// being signalled. A test that is about a signal the runner sent has to assert
// that the file is absent, because the durable record cannot tell a signalled
// invocation from one that gave up waiting: see `intentFixture`.
function intentBackend(t, id, options, config) {
  const fixture = intentFixture(t, id, options, config);
  const backend = fakeBackend(t, `#!/bin/sh\necho "starting"\nexec ${fixture.command} "$@"\n`);
  return { backend, gaveUpPath: fixture.gaveUpPath };
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

test('e. a kill intent does not excuse a host kill that beat the control poll', { timeout: INTENT_TEST_TIMEOUT_MS }, async (t) => {
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
  const { backend, gaveUpPath } = intentBackend(t, id, options, { intent: 'kill', marker, die: true });
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

test('e. a stop intent the runner itself signalled is still a clean stopped', { timeout: INTENT_TEST_TIMEOUT_MS }, async (t) => {
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
  const { backend, gaveUpPath } = intentBackend(t, id, options, { intent: 'stop' });
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
  // The four assertions above are about the record, and the record cannot tell
  // this test's subject from its opposite: an invocation that ends by itself
  // with a `stop` intent already on it records exactly the same four values. So
  // the thing this test is named for -- that the RUNNER sent the signal -- is
  // asserted here, on the one witness that can witness it. The fixture writes
  // this file only when it stops waiting without having been signalled, so its
  // absence is the claim, and without it this case would pass on a runtime
  // that never signals anything.
  assert.equal(
    existsSync(gaveUpPath),
    false,
    'the fixture gave up waiting to be signalled, so the runner never sent this stop; '
    + 'the clean stopped record above is the fixture ending by itself, not the runner stopping it',
  );
});

// ---------------------------------------------------------------------------
// The reaper this suite ships, exercised directly.
//
// `reapInvocation` above is the function the suite bound drains when this file
// wedges. A green run never reaches the drain, so the cases below are the only
// place it is observed at all: without them the reaper's identity rule -- the
// /proc start-ticks check, which is this repository's hard rule that ownership
// is never inferred from anything but recorded identity -- can be deleted from
// the shipped code and the whole suite stays green, which is exactly what an
// independent review demonstrated.
//
// The subject is the shipped function, not a copy of it. Each case puts a
// durable record on disk naming a process this test really spawned, then calls
// `reapInvocation(id, options)` -- the same call `registerReap` holds -- and
// asserts both halves of the claim: what it reported, and what it did to the
// process. The negative cases assert the process is still running, which is the
// half that matters: a reaper that reports a decline and signals anyway is
// worse than one that signals nothing.
// ---------------------------------------------------------------------------

// A live process in a process group of its own, so a group kill aimed at it
// cannot reach this test file. `markers` puts this invocation's identity in the
// child's environ, which is what the runner does for the backend it spawns and
// what the reaper's marker check reads back out of /proc.
function standInProcess(t, { markers = true, invocationId }) {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...(markers
          ? { ANTONINA_AGENT_ID: 'a11d', ANTONINA_INVOCATION_ID: invocationId }
          : {}),
      },
    },
  );
  // Converge on every path, including the ones where the reaper declines: a
  // coverage test for a reaper that leaks the process it is checking is the
  // same defect in a different hat.
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  return child;
}

// `/proc` is read synchronously and immediately, but the child has to be there
// to be read, so this waits for the stat line rather than assuming it.
function startTicksOf(pid) {
  const deadline = Date.now() + 5_000;
  let ticks = null;
  while (ticks === null && Date.now() < deadline) {
    ticks = procStartTicks(pid);
    if (ticks === null) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return ticks;
}

const STAND_IN_INVOCATION = 'a'.repeat(32);

// The record the reaper reads, built by writing a real meta the way the runner
// does, so the reaper is driven through the same durable state and the same
// validator rather than being handed an object.
function recordStanding(t, options, overrides) {
  return agent(t, options, {
    runner_gen: 7,
    runner_reservation: reservation({ gen: 7 }),
    pending_prompt: 'work',
    ...overrides,
  });
}

test('f. the shipped reaper leaves a pid whose start ticks are not the recorded ones', async (t) => {
  if (!requireProc(t)) return;
  const options = scratch(t, '/nonexistent/backend');
  const child = standInProcess(t, { invocationId: STAND_IN_INVOCATION });
  const ticks = startTicksOf(child.pid);
  assert.ok(ticks !== null, 'no /proc start ticks for the stand-in process');
  const id = recordStanding(t, options, {
    pid: child.pid,
    pgid: child.pid,
    // A pid on the record whose start ticks are not the ones the runner recorded
    // is a pid that has been recycled: the number now belongs to somebody else.
    // The reaper must say so and must not signal it.
    start_time: ticks + 1,
    invocation_id: STAND_IN_INVOCATION,
  });

  const report = reapInvocation(id, options);

  assert.match(
    report,
    new RegExp(`pid ${child.pid} no longer has the recorded start ticks ${ticks + 1}; not signalled`),
    `the reaper did not report the start-ticks mismatch; it said: ${report}`,
  );
  assert.equal(
    processIsZombie(child.pid),
    false,
    'the reaper signalled a pid whose start ticks were not the recorded ones',
  );
});

test('f. the shipped reaper leaves a pid that does not carry this invocation\'s markers', async (t) => {
  if (!requireProc(t)) return;
  const options = scratch(t, '/nonexistent/backend');
  const child = standInProcess(t, { markers: false, invocationId: STAND_IN_INVOCATION });
  const ticks = startTicksOf(child.pid);
  assert.ok(ticks !== null, 'no /proc start ticks for the stand-in process');
  // Right pid, right start ticks, own process group -- and not our invocation.
  // The product's own identity check (`process.ts:148-152`) declines this on
  // the environ markers, so the reaper has to decline it too.
  const id = recordStanding(t, options, {
    pid: child.pid,
    pgid: child.pid,
    start_time: ticks,
    invocation_id: STAND_IN_INVOCATION,
  });

  const report = reapInvocation(id, options);

  assert.match(report, /does not carry this invocation's environ markers; not signalled/, `the reaper said: ${report}`);
  assert.equal(
    processIsZombie(child.pid),
    false,
    'the reaper signalled a pid that carries no marker of this invocation, on the strength of a pid and a tick count',
  );
});

test('f. the shipped reaper does signal the invocation its record really names', async (t) => {
  if (!requireProc(t)) return;
  // The control, and it is what makes the two cases above mean anything: a
  // reaper that declines everything is not a safe reaper, it is a reaper that
  // leaks the process it exists to reap. Every field here is the truth about a
  // process this test spawned, carrying this invocation's markers, in its own
  // process group -- so the reaper must kill it, and must say that it did.
  const options = scratch(t, '/nonexistent/backend');
  const child = standInProcess(t, { invocationId: STAND_IN_INVOCATION });
  const ticks = startTicksOf(child.pid);
  assert.ok(ticks !== null, 'no /proc start ticks for the stand-in process');
  const id = recordStanding(t, options, {
    pid: child.pid,
    pgid: child.pid,
    start_time: ticks,
    invocation_id: STAND_IN_INVOCATION,
  });

  const report = reapInvocation(id, options);

  assert.match(
    report,
    new RegExp(`SIGKILLed process group ${child.pid} \\(pid ${child.pid}, start ticks ${ticks}\\)`),
    `the reaper declined an invocation its record really names; it said: ${report}`,
  );
  // And the process is actually gone, so this is a reap and not a report.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} survived the reaper's SIGKILL`)), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(processIsZombie(child.pid), true, `pid ${child.pid} is still running after the reaper reported reaping it`);
});

test('f. the shipped reaper declines a record with no invocation identity on it', (t) => {
  if (!requireProc(t)) return;
  const options = scratch(t, '/nonexistent/backend');
  const id = recordStanding(t, options, {});

  const report = reapInvocation(id, options);

  assert.equal(report, 'no recorded invocation pid, so nothing was left running by the runner');
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
