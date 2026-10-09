// Board 159.
//
// Three managed agents died on 2026-10-02 inside one ~30 minute window on the
// identical string, printed by the backend itself:
//
//   Error: Failed to execute statement
//
// and all three had already done their work. The durable records of all three
// (agents/94d01, agents/92a01, agents/136d) read:
//
//   state "failed", exit_code 1, exit_signal null, backend_error null,
//   error null
//
// A terminal state with no reason recorded anywhere. In durable state that is
// indistinguishable from a record in which the runtime lost the invocation
// before any exit status existed, which is the whole point: the cause is
// upstream (the backend reported a failure and exited non-zero), and the
// runtime's only duty here is to record which of the two happened.
//
// Before this fix, `classifyBackendFailure` matched exactly one marker,
// 'Unexpected server error', and returned null for every other non-zero exit,
// so the note could never be written. Each assertion below is red on e54359d9
// and green with the fix; the runs are recorded in the report.
//
// Every helper here is local to this file. Nothing reads or writes the
// operator's state or config: scratch() points both XDG homes at a throwaway
// directory, and the fake backend is spawned, exited and reaped inside the test.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import * as backendModule from '../dist/packages/agent-runtime/src/backend.js';
import { reconcileDeadMeta } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';

// Read through the namespace rather than a named import on purpose: on the
// pre-fix runtime this export does not exist, and a named import would abort the
// whole file with a module-load SyntaxError, which is not the same thing as the
// behavioural failure these tests exist to demonstrate. Reading it here means the
// pre-fix run reaches the assertions and fails on them.
const UNRECOGNIZED_BACKEND_FAILURE = backendModule.UNRECOGNIZED_BACKEND_FAILURE
  ?? 'unrecognized_backend_failure';
const describeBackendDeath = typeof backendModule.describeBackendDeath === 'function'
  ? backendModule.describeBackendDeath
  : () => null;

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');

// The literal the three dead fronts' records implied but did not contain. It is
// asserted by string rather than by importing a constant, so that a change to
// the runtime's wording cannot quietly make this test agree with itself.
const RUNTIME_LOST_NOTE = 'runner/model process disappeared without a captured exit status';

function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' ok\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  return !result.error && result.status === 0 && result.stdout.trim() === 'ok';
}

function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

function fakeBackend(t, body) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-b159-'));
    } catch (error) {
      failures.push(`${parent}: ${error.message}`);
      continue;
    }
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      pruneFixtureParent(t);
    });
    if (execProbe(root, 'probe-')) {
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

// The launcher-shaped reservations below name this process as their owner, and
// the `self` verdict now requires the owner token minted for the reservation as
// well as pid plus start time: a record cannot establish its own ownership. The
// product mints a token on every reservation it writes and hands it to the
// runner, so these fixtures carry and present one -- which is what the product
// does, not a licence invented for the test.
const LAUNCHER_TOKEN = mintRunnerReservationOwnerToken();

function scratch(t, backend) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b159-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ANTONINA_OPENCODE_BIN: backend, ANTONINA_RUNNER_OWNER_TOKEN: LAUNCHER_TOKEN };
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

function agent(t, options, overrides = {}) {
  const id = 'b159';
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-b159-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  meta.runner_gen = 7;
  meta.runner_reservation = {
    state: 'reserved',
    gen: 7,
    mode: 'new',
    reserved_at: 1,
    owner_pid: process.pid,
    // The launcher that would really have written this reservation names
    // itself, so it names its own real start time. Zero is not a start
    // time and would be refused by the `self` verdict.
    owner_start_ticks: procStartTicks(process.pid),
    // ...and the token the launcher minted for it, which the `self` verdict now
    // requires as well: see runner-launch-gate.test.mjs.
    owner_token: LAUNCHER_TOKEN,
  };
  meta.pending_prompt = 'work';
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, options);
  return id;
}

// Wait until the child is published *and* has demonstrably passed its own setup
// and printed, so the pid in the record is the live one, then make the durable
// invocation marker stop matching /proc so every poll tick's signalInvocation
// is refused while the child is alive. Nothing is signalled; the child is left
// running on purpose and the runner's own close handler reaps it.
async function refuseEverySignal(t, id, options, logPath, overrides = {}) {
  let tampered = false;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    const live = readMeta(id, options);
    if (live === null || live.state !== 'running' || !Number.isSafeInteger(live.pid)) continue;
    if (!existsSync(logPath) || !readFileSync(logPath, 'utf8').includes('backend up')) continue;
    // Still well-formed 32-hex, so the identity resolves and only the
    // ANTONINA_INVOCATION_ID check in identityMatches fails.
    live.invocation_id = 'f'.repeat(32);
    Object.assign(live, overrides);
    writeMeta(id, live, options);
    tampered = true;
    break;
  }
  assert.equal(tampered, true, 'the durable invocation marker was never invalidated while the child ran');
}

async function runToCompletion(t, id, options) {
  let watchdog = null;
  try {
    await Promise.race([
      runManagedRunner(id, 'new', 7, options),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('the runner did not return')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
  return readMeta(id, options);
}

// The observed death, reproduced at the level the runtime sees it: the backend
// prints the string and exits 1. Everything before it is a complete turn.
test('a backend that reports Failed to execute statement records a named failure reason', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(
    t,
    '#!/bin/sh\nprintf \'%s\\n\' "Wrote file successfully."\nprintf \'%s\\n\' "Error: Failed to execute statement"\nexit 1\n',
  );
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options);
  const after = await runToCompletion(t, id, options);

  assert.equal(after.state, 'failed');
  assert.equal(after.exit_code, 1);
  assert.equal(after.exit_signal, null);
  assert.equal(after.active_runner, false, 'the invocation converged and released its claim');
  assert.notEqual(after.pid, null, 'the spawn identity is durable, so the invocation is not a leak');

  // Red on e54359d9: backend_error was null here, and so was error.
  assert.ok(after.backend_error !== null, 'the backend failure is classified, not left blank');
  assert.equal(after.backend_error.classification, 'backend_statement_execution_error');
  assert.equal(after.backend_error.provider, 'opencode');
  assert.equal(after.backend_error.transient, false, 'nothing observed says a retry of a completed turn is safe');
  assert.equal(after.backend_error.automatic_retry_safe, false);

  assert.ok(typeof after.error === 'string' && after.error.length > 0, 'a reason is recorded');
  assert.match(after.error, /backend/);
  assert.match(after.error, /Failed to execute statement/, 'the reason quotes what the backend said');
});

test('a recognised-but-unmodelled backend failure still gets a classification and a reason', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t, '#!/bin/sh\nprintf \'%s\\n\' "Error: the widget sprocket failed"\nexit 3\n');
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options);
  const after = await runToCompletion(t, id, options);

  assert.equal(after.state, 'failed');
  assert.equal(after.exit_code, 3);
  // Red on e54359d9: both were null.
  assert.ok(after.backend_error !== null, 'an unmodelled non-zero exit is still a backend failure');
  assert.equal(after.backend_error.classification, UNRECOGNIZED_BACKEND_FAILURE);
  assert.ok(typeof after.error === 'string' && after.error.length > 0, 'a reason is recorded');
  assert.match(after.error, /does not recognise/, 'the record says the failure is not modelled here');
  assert.match(after.error, /the widget sprocket failed/, 'the last line the backend wrote is quoted');
});

test('the recorded reason distinguishes the backend dying from the runtime losing it', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(t, '#!/bin/sh\nprintf \'%s\\n\' "Error: Failed to execute statement"\nexit 1\n');
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options);
  const after = await runToCompletion(t, id, options);
  assert.ok(typeof after.error === 'string' && after.error.length > 0, 'the backend-death note exists');

  // The other case, produced by the code that owns it, so the comparison is
  // against the real wording rather than a copy of it.
  const lost = idleMeta('b159d', tmpdir(), null, 1);
  lost.state = 'running';
  lost.pid = 0x7ffffffe;
  lost.pgid = 0x7ffffffe;
  lost.start_time = 1;
  lost.invocation_id = 'a'.repeat(32);
  lost.runner_pid = 0x7ffffffe;
  lost.runner_start_time = 1;
  lost.started_at = 1;
  const reconciled = reconcileDeadMeta(lost, Date.now() / 1000 + 120);
  assert.equal(reconciled, true, 'the runtime-lost path does force a terminal record');
  assert.equal(lost.state, 'failed');
  assert.equal(lost.exit_code, null, 'the runtime-lost case has no exit status at all');
  assert.equal(lost.error, RUNTIME_LOST_NOTE);

  assert.notEqual(after.error, lost.error, 'the two reasons must not read the same');
  assert.doesNotMatch(after.error, /disappeared/, 'the backend died; the runtime did not lose it');
  assert.equal(typeof describeBackendDeath(after.backend_error, null), 'string');
});

test('a quoted backend excerpt never carries a credential-shaped run', async (t) => {
  if (!requireProc(t)) return;
  const secret = 'sk-live-AAAABBBBCCCCDDDDEEEEFFFF';
  const backend = fakeBackend(
    t,
    `#!/bin/sh\nprintf '%s\\n' "Error: Failed to execute statement (key ${secret})"\nexit 1\n`,
  );
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options);
  const after = await runToCompletion(t, id, options);

  assert.ok(typeof after.error === 'string' && after.error.length > 0, 'a reason is recorded');
  assert.doesNotMatch(after.error, /sk-live-/, 'the credential-shaped run is not persisted');
  assert.match(after.error, /\[redacted\]/, 'it is replaced rather than merely dropped');

  // The transcript itself is left whole: the log is the evidence, and this fix
  // only decides what the record says about it.
  const log = readFileSync(join(options.env.XDG_STATE_HOME, 'antonina', 'agents', id, 'output.log'), 'utf8');
  assert.ok(log.includes(secret), 'the partial transcript is preserved verbatim');
  assert.ok(existsSync(join(options.env.XDG_STATE_HOME, 'antonina', 'agents', id, 'output.log')));
});

// A backend that traps the runner's own SIGTERM and exits non-zero comes back
// from `close` as (code = 1, signal = null), which is indistinguishable by exit
// status alone from a backend that failed on its own. `ChildResult
// .operatorSignalled` is what separates them, and it is set in the same poll
// that sends the signal. Without the gate on that flag the durable record read
// state "failed", exit_code 1, stop_reason "steer", error "the backend process
// exited unsuccessfully ..." — a cause the runtime's own evidence contradicts,
// on a record that says the operator asked for the death.
test('a steer the operator asked for is not recorded as a backend failure', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(
    t,
    '#!/bin/sh\ntrap \'printf "%s\\n" "Error: trapped bye"\nexit 1\' TERM\nprintf \'%s\\n\' "Wrote file successfully."\nsleep 5\n',
  );
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, { intent: 'steer', stop_reason: 'steer' });
  const after = await runToCompletion(t, id, options);

  // The state mapping is not the subject of this fix: an operator-signalled
  // death with no usable signal is still `failed`, as it was before board 159.
  assert.equal(after.state, 'failed');
  assert.equal(after.exit_code, 1);
  assert.equal(after.exit_signal, null, 'the backend caught the SIGTERM and exited on its own');
  assert.equal(after.stop_reason, 'steer', 'the record still says the operator asked for this');
  assert.equal(after.active_runner, false, 'the invocation converged and released its claim');

  // Red without the gate: this was the misattributed backend-death note.
  assert.equal(after.error, null, 'no reason is invented for a death this runner asked for');
});

// A refused signal is not a delivered one. `signalInvocation` returns false
// when the durable identity no longer resolves or the pid/start-time/marker
// checks fail against live /proc; `ChildResult.operatorSignalled` is set
// before the send regardless, so gating the note on that flag alone also
// swallowed the death of a backend this runner never reached: the child kept
// running and then exited non-zero on its own, and the record read, field for
// field, like the delivered case above.
//
// This reproduces exactly that: a real runManagedRunner, a real live child,
// with the durable invocation marker made not to match /proc after the child is
// demonstrably running, so every poll tick's signalInvocation is refused. The
// backend prints its own diagnostic and exits non-zero by itself. The record
// must say the runtime did not deliver a signal, durably, so a later pass
// reading meta.json alone can tell this apart from the delivered case.
test('a steer the runtime refused to deliver is recorded as not delivered', async (t) => {
  if (!requireProc(t)) return;
  const backend = fakeBackend(
    t,
    '#!/bin/sh\nprintf \'%s\\n\' "backend up"\nsleep 4\nprintf \'%s\\n\' "Error: the widget sprocket failed on its own"\nexit 1\n',
  );
  if (backend === null) return;
  const options = scratch(t, backend);
  const id = agent(t, options, { intent: 'steer', stop_reason: 'steer' });
  const logPath = join(options.env.XDG_STATE_HOME, 'antonina', 'agents', id, 'output.log');

  // Start the runner in the background of this test only, so the marker can be
  // invalidated while the child is alive; runToCompletion's watchdog still
  // reaps the whole thing and the child is waited on by the runner's own close.
  const running = runToCompletion(t, id, options);

  await refuseEverySignal(t, id, options, logPath);

  const after = await running;

  const log = readFileSync(logPath, 'utf8');
  assert.equal(log.includes('backend up'), true);
  assert.equal(log.includes('Terminated'), false, 'no SIGTERM ever reached the backend process group');

  // The record shape is unchanged, exactly as before this correction.
  assert.equal(after.state, 'failed');
  assert.equal(after.exit_code, 1);
  assert.equal(after.exit_signal, null, 'the backend died on its own, not on a signal');
  assert.equal(after.stop_reason, 'steer', 'the operator did ask, and the record still says so');
  assert.equal(after.active_runner, false, 'the invocation converged and released its claim');

  // Distinguishable from the delivered case purely by reading meta.json: this
  // one carries a reason, and that reason names the non-delivery.
  assert.equal(typeof after.error, 'string', 'a refused signal must not be recorded as no reason at all');
  assert.match(after.error, /did not deliver a signal to the backend process group/);
});

// Board 167, the A/A2 shape. The steer case above lands on state `failed`, so
// the note gate's `state === 'failed'` term is satisfied and the reason is
// recorded. A refused `stop` or `kill` is the same evidence with a different
// terminal state: the runtime knew the backend died, it never delivered the
// signal the operator asked for, and the state mapping honours the recorded
// intent and calls it `stopped` / `killed`. The gate therefore suppressed the
// note and the record read
//
//   exit_code 1, exit_signal null, stop_reason stop, error null,
//   backend_error.classification unrecognized_backend_failure
//
// which claims a clean operator stop while carrying a classified backend
// failure it explains nowhere. The rule is not "failed records get a reason":
// it is "a record whose intended signal was never delivered gets one",
// whatever the terminal state is.
//
// The intent is recorded while the invocation is live, as the CLI does, because
// a `stop` / `kill` already in the record before the spawn is refused by
// recordSpawned (`stopLikeOrMalformed`) and never reaches the note gate at all.
// It lands in the same atomic write that invalidates the marker, so the runner's
// very first poll tick sees an intent it tries to act on and an identity it
// cannot act on -- the production shape, not a staged one.
for (const intent of ['stop', 'kill']) {
  test(`a ${intent} the runtime refused to deliver still records a reason`, async (t) => {
    if (!requireProc(t)) return;
    const backend = fakeBackend(
      t,
      '#!/bin/sh\nprintf \'%s\\n\' "backend up"\nsleep 4\nprintf \'%s\\n\' "Error: the widget sprocket failed on its own"\nexit 1\n',
    );
    if (backend === null) return;
    const options = scratch(t, backend);
    const id = agent(t, options);
    const logPath = join(options.env.XDG_STATE_HOME, 'antonina', 'agents', id, 'output.log');

    const running = runToCompletion(t, id, options);
    await refuseEverySignal(t, id, options, logPath, { intent, stop_reason: intent });
    const after = await running;

    const log = readFileSync(logPath, 'utf8');
    assert.equal(log.includes('backend up'), true);
    assert.equal(/Terminated|Killed/.test(log), false, 'no signal ever reached the backend process group');

    // The terminal state follows the recorded intent and is NOT what this fix
    // changes; the stop/kill state mapping is coherent and stays as it is.
    assert.equal(after.state, intent === 'stop' ? 'stopped' : 'killed');
    assert.equal(after.exit_code, 1);
    assert.equal(after.exit_signal, null, 'the backend died on its own, not on a signal');
    assert.equal(after.stop_reason, intent, 'the operator did ask, and the record still says so');
    assert.equal(after.active_runner, false, 'the invocation converged and released its claim');
    assert.equal(after.backend_error.classification, UNRECOGNIZED_BACKEND_FAILURE);

    // Red on 2f51caa7: error was null, so the record claimed a clean operator
    // stop while carrying an unexplained classified backend failure.
    assert.equal(typeof after.error, 'string', 'an undelivered signal must leave a reason, whatever the state');
    assert.match(after.error, /did not deliver a signal to the backend process group/);
  });
}

test('a refused signal does not make a backend death look delivered either', () => {
  // The wording is honest in the other direction too: nothing here says the
  // operator stopped the backend, because nothing was sent to it.
  const note = describeBackendDeath(null, null, true);
  assert.equal(typeof note, 'string');
  assert.match(note, /did not deliver a signal to the backend process group/);
  assert.equal(/operator (stopped|asked to stop)/.test(note), false);
  // The flag defaults off, so every existing caller keeps its exact wording.
  assert.equal(describeBackendDeath(null, null), 'the backend process exited unsuccessfully without writing a diagnostic this runtime could read');
});

test('classifyBackendFailure still declines an empty log window', () => {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b159-empty-'));
  const path = join(root, 'output.log');
  writeFileSync(path, '');
  // A spawn that produced no bytes at all also exits non-zero, and calling that
  // a backend failure would misattribute a spawn error to the backend.
  assert.equal(backendModule.classifyBackendFailure(path, 0, 127, false), null);
  rmSync(root, { recursive: true, force: true });
});