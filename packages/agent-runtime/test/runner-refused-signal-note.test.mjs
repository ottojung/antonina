// Board 167: where a refused-signal death under `stop`/`kill` intent should
// leave its note, measured on THIS head (e54359d9).
//
// The fixture manufactures the refusal externally, because the refusal is
// decided by the delivery path's identity checks and this issue is not allowed
// to change delivery. What it manufactures is not the outcome but the record:
// once the poll's signal is refused, the runner still believes it asked, and
// the death that follows is nobody's request. The record says so, or does not.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { idleMeta } from '../dist/packages/agent-runtime/src/metadata.js';
import { envHasAgentMarker, envHasInvocationMarker, procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { createAgentDirectory, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { boundMs, installSuiteBound, registerCleanup, registerReap } from './support/suite-bound.mjs';

const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-167-FIXTURE-EXEC-OK';

// Bounds first. The fixture signals nothing and waits out its own lifetime, so
// a runtime that never converges here would otherwise hang the file; the
// per-test timeout turns that into a failure with a number on it, and the
// suite bound is what reaps a wedged *file*, whose `t.after` hooks never run.
const FIXTURE_LIFETIME_MS = boundMs('ANTONINA_TEST_FIXTURE_LIFETIME_MS', 60_000);
const INTENT_TEST_TIMEOUT_MS = boundMs('ANTONINA_TEST_CASE_TIMEOUT_MS', 120_000);
const SUITE_STALL_MS = boundMs('ANTONINA_TEST_SUITE_STALL_MS', 180_000);
const SUITE_WALL_MS = boundMs('ANTONINA_TEST_SUITE_BOUND_MS', 300_000);

// Passed in the OPTIONS OBJECT, as the second argument to `test`. A trailing
// third argument is silently discarded by node, and then this file can wedge.
installSuiteBound({
  description: 'packages/agent-runtime/test/runner-refused-signal-note.test.mjs',
  suiteMs: SUITE_WALL_MS,
  stallMs: SUITE_STALL_MS,
});

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

function fakeBackend(t, body) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-167-'));
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
      return { bin, root };
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

// Both XDG homes are test-owned temporary directories and both are exported into
// the fixture's own environment, so nothing here can read or write the
// operator's ambient state or their `trust.json` / `credential.json`.
function scratch(t, backendBin) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-167-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const env = {
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    ANTONINA_OPENCODE_BIN: backendBin,
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
    owner_start_ticks: 0,
    ...overrides,
  };
}

function agent(t, options, overrides = {}) {
  const id = 'a11d';
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-167-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  registerCleanup(`agent cwd ${cwd}`, () => {
    rmSync(cwd, { recursive: true, force: true });
    return 'removed';
  });
  assert.equal(createAgentDirectory(id, options), true);
  const meta = idleMeta(id, cwd, null, 1);
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, options);
  registerReap(`agent ${id} invocation`, () => reapInvocation(id, options));
  return id;
}

// The same identity rule the product uses: recorded pid, matching /proc start
// ticks, and this invocation's environ markers -- in that order. Nothing is
// found by process name. If the ticks no longer match, the pid is somebody
// else's and is left alone.
function reapInvocation(id, options) {
  const live = readMeta(id, options);
  if (live === null) return 'no durable record, so no identity to signal';
  const { pid, pgid, start_time: startTime, invocation_id: invocationId } = live;
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'no recorded invocation pid, so nothing was left running';
  if (procStartTicks(pid) !== startTime) {
    return `pid ${pid} no longer has the recorded start ticks ${startTime}; not signalled`;
  }
  if (!envHasAgentMarker(pid, id) || !envHasInvocationMarker(pid, invocationId)) {
    return `pid ${pid} does not carry this invocation's environ markers; not signalled`;
  }
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return 'no process group recorded; not signalled';
  try {
    process.kill(-pgid, 'SIGKILL');
    return `SIGKILLed process group ${pgid} (pid ${pid}, start ticks ${startTime})`;
  } catch (error) {
    return `could not SIGKILL process group ${pgid}: ${error && error.code ? error.code : String(error)}`;
  }
}

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

// A backend that:
//   1. waits for `recordSpawned` to commit the invocation identity,
//   2. records the operator intent through the store's own `updateMeta`,
//   3. corrupts the recorded `start_time` so the delivery path's identity check
//      can no longer match, which is what makes the control poll's signal a
//      refusal -- the pid is real, its markers are real, only the recorded
//      identity no longer matches it,
//   4. writes a witness file if it is ever signalled,
//   5. and then kills itself with SIGKILL, so the death is unambiguously
//      external: signal 9, requested by nobody.
//
// `exec` keeps the recorded pid as the process group leader, so the poll aims
// at the very process this fixture is.
function refusedSignalFixture(t, id, options, config) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-167-refused-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  registerCleanup(`refused-signal fixture ${root}`, () => {
    rmSync(root, { recursive: true, force: true });
    return 'removed';
  });
  const signalled = join(root, 'was-signalled');
  const helper = join(root, 'refuse.mjs');
  writeFileSync(helper, [
    "import { writeFileSync } from 'node:fs';",
    'const [storeUrl, agentId, intent, signalled, stateHome, configHome] = process.argv.slice(2);',
    'const { readMeta, updateMeta } = await import(storeUrl);',
    'const options = { env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome } };',
    'const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };',
    'const backendArgv = process.argv.slice(8);',
    'if (backendArgv[0] === "session" || backendArgv[0] === "models") process.exit(0);',
    'if (backendArgv[0] !== "run") {',
    '  process.stderr.write(`refuse: unexpected backend invocation: ${backendArgv.join(" ")}\\n`);',
    '  process.exit(4);',
    '}',
    // If a signal ever does arrive, the refusal did not happen and this death
    // would be the operator's. The file is the only witness to that, and it is
    // asserted absent below.
    'process.on("SIGTERM", () => {',
    '  try { writeFileSync(signalled, "sigterm\\n"); } catch { /* best effort */ }',
    '  process.exit(0);',
    '});',
    'process.on("SIGINT", () => {',
    '  try { writeFileSync(signalled, "sigint\\n"); } catch { /* best effort */ }',
    '  process.exit(0);',
    '});',
    'const deadline = Date.now() + 30000;',
    'let meta = null;',
    'while (Date.now() < deadline) {',
    '  try { meta = readMeta(agentId, options); } catch { meta = null; }',
    '  if (meta !== null && meta.pid !== null && meta.pid !== undefined) break;',
    '  sleep(2);',
    '}',
    'if (meta === null || meta.pid === null || meta.pid === undefined) {',
    '  process.stderr.write("refuse: recordSpawned never committed; refusing to race it\\n");',
    '  process.exit(3);',
    '}',
    'await updateMeta(agentId, (current) => {',
    '  if (current.pid === null || current.pid === undefined) process.exit(3);',
    '  current.intent = intent;',
    '  current.stop_reason = intent;',
    '  // A pid that is real, in a real process group, carrying this invocation\'s',
    '  // markers, but whose recorded start ticks name no such process. The',
    '  // delivery path refuses on exactly this, by design.',
    '  current.start_time = (current.start_time + 4242) % 1000000;',
    '}, options);',
    // Long enough for the 200 ms control poll to run several times and be
    // refused, so the refusal is a fact about the run rather than a race.
    'sleep(1200);',
    // Nobody asked for this death.
    'process.kill(process.pid, "SIGKILL");',
    `sleep(${FIXTURE_LIFETIME_MS});`,
    'process.stderr.write("refuse: still running; giving up so the run can fail rather than hang\\n");',
    'process.exit(0);',
  ].join('\n'));
  const storeUrl = new URL('../dist/packages/agent-runtime/src/store.js', import.meta.url).href;
  const argv = [
    'node',
    helper,
    storeUrl,
    id,
    config.intent,
    signalled,
    options.env.XDG_STATE_HOME,
    options.env.XDG_CONFIG_HOME,
  ].map((value) => JSON.stringify(value)).join(' ');
  const backend = fakeBackend(t, `#!/bin/sh\necho "starting"\nexec ${argv} "$@"\n`);
  return { backend, signalledPath: signalled };
}

for (const intent of ['stop', 'kill']) {
  test(`167. a ${intent} whose signal was refused, then killed by signal 9, records why`, { timeout: INTENT_TEST_TIMEOUT_MS }, async (t) => {
    if (!requireProc(t)) return;
    const options = scratch(t, '/nonexistent/backend');
    const id = agent(t, options, {
      runner_gen: 7,
      runner_reservation: reservation({ gen: 7 }),
      pending_prompt: 'work',
    });
    const { backend, signalledPath } = refusedSignalFixture(t, id, options, { intent });
    if (backend === null) return;
    const run = { ...options, env: { ...options.env, ANTONINA_OPENCODE_BIN: backend.bin } };

    await runManagedRunner(id, 'new', 7, { ...run, capacity: { readText: cgroup(1) } });

    const after = readMeta(id, run);
    t.diagnostic(JSON.stringify({
      intent,
      state: after.state,
      exit_code: after.exit_code,
      exit_signal: after.exit_signal,
      stop_reason: after.stop_reason,
      error: after.error,
      backend_error: after.backend_error,
    }));

    // The witness. If this file exists the poll delivered a signal and the whole
    // case is measuring something else, so the refusal is asserted, not assumed.
    assert.equal(
      existsSync(signalledPath),
      false,
      'the fixture was signalled, so this run is not a refused-signal run',
    );

    // The death is unambiguously external: signal 9, and nobody asked for it.
    assert.equal(after.exit_signal, 9);
    assert.equal(after.stop_reason, intent);
    assert.equal(after.state, intent === 'stop' ? 'stopped' : 'killed');

    // The measurement. This is the assertion that fails on this head.
    assert.notEqual(
      after.error,
      null,
      'a death on signal 9 that the operator never asked for must leave a reason somewhere a reader looks',
    );
    assert.match(String(after.error), /SIGKILL \(signal 9\)/);
    assert.notEqual(
      after.backend_error,
      null,
      'the reason must be in backend_error as well as error, or in one of them and named',
    );
    assert.equal(after.backend_error.classification, 'external_signal_kill');

    // Coherent terminal state: no invocation identity survives, and the
    // reservation is discharged by the runner that owned it.
    assert.equal(after.active_runner, false);
    assert.equal(after.intent, null);
  });
}