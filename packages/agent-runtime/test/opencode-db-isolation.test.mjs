// Board 186: per-invocation OpenCode database isolation.
//
// Every Antonina front used to share one `~/.local/share/opencode/opencode.db`.
// OpenCode 1.18.32 hardcodes `busy_timeout = 5000` for that file and escalates a
// `SQLiteError: database is locked` timeout into a fatal
// `Error: Failed to execute statement`, which killed agents 9418/9419/9424/9425/
// 9427 and then eb60 and 186c01 on this very front. The fix confines each
// managed agent's backend invocations to a database named by its own durable
// record.
//
// This file exists on its own rather than as an addition to runner.test.mjs for
// the same coordination reason as runner-rejected-spawn.test.mjs: board 98's
// front owns runner.test.mjs exclusively and is live on this host, so the two
// fronts' test files have to stay disjoint for them to be able to run
// concurrently at all.
//
// Every case here is a RED case. Reverting the isolation -- making
// `opencodeBackendEnv` return `{}`, or dropping it from the spawn/probe env --
// turns each one red, and none of them is satisfied by the pre-change behaviour:
//
//   1. two different agent ids must resolve two different databases
//   2. the probe path and the spawn path must be given the same database
//   3. a record with no `opencode_db` must resolve to no override at all
//   4. an ambient `OPENCODE_DB` must not decide either
//   5. the directory must exist before OpenCode is told to open the file
//   6. a fork must keep the source's database
//   7. deleting a record must reap its database, and a fork clone must pin it
//
// Cases 8-10 were added by board 186's landing front. Cases 1-7 pin the
// isolation only where it is CALCULATED -- `opencodeBackendEnv` and the store's
// reap -- and every one of them supplies the environment itself. So the whole
// question of whether the runner and the CLI actually HAND that environment to
// OpenCode was unpinned: deleting `...opencodeBackendEnv(meta, options)` from
// `runner.ts`'s two probe/spawn call sites, or from `agent.ts`'s two call
// sites, left the whole runtime and cli suites green (reproduced at fce7f02c,
// both mutations, `test:runtime` 188/0 and `test:cli` 204/0). A refactor could
// have dropped the isolation without a single test noticing.
//
// The cases below close that, by execution and not by reading the source: a
// fixture backend that behaves differently depending on which OPENCODE_DB it
// was actually handed, driven through the shipped `runManagedRunner`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  OPENCODE_BIN_ENV,
  buildAgentCommand,
  discoverSessionId,
} from '../dist/packages/agent-runtime/src/backend.js';
import { forkMetaSnapshot } from '../dist/packages/agent-runtime/src/fork.js';
import { beginInvocation } from '../dist/packages/agent-runtime/src/lifecycle.js';
import { idleMeta, mintRunnerReservationOwnerToken } from '../dist/packages/agent-runtime/src/metadata.js';
import {
  envHasAgentMarker,
  envHasInvocationMarker,
  procStartTicks,
} from '../dist/packages/agent-runtime/src/process.js';
import { runManagedRunner } from '../dist/packages/agent-runtime/src/runner.js';
import { boundMs, installSuiteBound, registerCleanup, registerReap } from './support/suite-bound.mjs';
import {
  agentDir,
  createAgentDirectory,
  opencodeBackendEnv,
  opencodeDbDir,
  opencodeDbPath,
  readMeta,
  removeAgentDirectory,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';

const PROBE_SENTINEL = 'ANTONINA-B186-EXEC-OK';

// Cases 8-10 below drive a real detached backend through `runManagedRunner`, so
// this file can wedge rather than fail. The per-test timeout turns a wedge into
// a failure with a number on it; the suite bound is what reaps a wedged *file*,
// whose `t.after` hooks never run. Every value here is a ceiling an environment
// may shorten and never lengthen. The timeout is passed in the OPTIONS OBJECT,
// as the second argument to `test`: a trailing third argument is silently
// discarded by node, and then the file can wedge with nothing to show for it.
const CASE_TIMEOUT_MS = boundMs('ANTONINA_TEST_CASE_TIMEOUT_MS', 120_000);
const SUITE_STALL_MS = boundMs('ANTONINA_TEST_SUITE_STALL_MS', 180_000);
const SUITE_WALL_MS = boundMs('ANTONINA_TEST_SUITE_BOUND_MS', 300_000);

installSuiteBound({
  description: 'packages/agent-runtime/test/opencode-db-isolation.test.mjs',
  suiteMs: SUITE_WALL_MS,
  stallMs: SUITE_STALL_MS,
});

function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  return result.status === 0 && result.stdout.trim() === PROBE_SENTINEL;
}

// Both XDG homes point at a throwaway directory, so nothing here can read or
// write the operator's real trust.json or credential.json (AGENTS.md, Test
// safety). The databases this front names land under that same throwaway state
// root, never in the operator's real `~/.local/share/opencode`.
// The launcher-shaped reservations below name this process as their owner, and
// the `self` verdict now requires the owner token minted for the reservation as
// well as pid plus start time: a record cannot establish its own ownership. The
// product mints a token on every reservation it writes and hands it to the
// runner, so these fixtures carry and present one -- which is what the product
// does, not a licence invented for the test.
const LAUNCHER_TOKEN = mintRunnerReservationOwnerToken();

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b186-'));
  const env = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    // The launcher hands the runner the token it minted for the reservation it
    // just wrote, which is what `runnerAgent` below writes into the record.
    ANTONINA_RUNNER_OWNER_TOKEN: LAUNCHER_TOKEN,
  };
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return env;
}

function agent(t, env, id, overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-b186-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, { env }), true);
  const meta = idleMeta(id, cwd, null, 1);
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, { env });
  return { id, meta };
}

// A fake backend that appends the OPENCODE_DB it was actually given, and the
// argv it was given, to a log file. The path of the log is baked into the
// script, so the fixture needs nothing on PATH. The `session list` answer is
// what a real backend prints for a session titled `antonina-<id>`.
function fakeBackend(t, logFile, rows) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b186-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (!execProbe(root, 'probe-')) {
    t.skip('no exec-capable fixture directory for the fake opencode backend');
    return null;
  }
  const bin = join(root, 'opencode');
  writeFileSync(bin, `#!/bin/sh
printf '%s|%s\\n' "$OPENCODE_DB" "$*" >>'${logFile}'
case "$1" in
  session) printf '%s\\n' '${JSON.stringify(rows)}' ;;
esac
exit 0
`, { mode: 0o755 });
  return bin;
}

function recorded(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('|');
    return { db: line.slice(0, at), argv: line.slice(at + 1) };
  });
}

test('two agents with different ids resolve two different OpenCode databases', (t) => {
  const env = scratch(t);
  const one = agent(t, env, 'b18601');
  const two = agent(t, env, 'b18602');

  const first = opencodeBackendEnv(one.meta, { env }).OPENCODE_DB;
  const second = opencodeBackendEnv(two.meta, { env }).OPENCODE_DB;

  assert.ok(typeof first === 'string' && first.length > 0, 'agent one resolves no database');
  assert.ok(typeof second === 'string' && second.length > 0, 'agent two resolves no database');
  assert.notEqual(first, second, 'two agents shared one OpenCode database');

  // Both live under the state root's own directory, never in the shared
  // `~/.local/share/opencode` location that all fronts contended over.
  const root = opencodeDbDir({ env });
  assert.equal(first, join(root, 'b18601.db'));
  assert.equal(second, join(root, 'b18602.db'));
});

test('the recorded key, not the agent directory layout, decides the database', (t) => {
  const env = scratch(t);
  // A record whose `opencode_db` key is deliberately NOT its own id. The key is
  // what the record names, which is what lets a fork clone keep using the
  // source's database; deriving the path from the agent id instead would hand
  // the clone a fresh empty database and strand its inherited native_session_id.
  const forked = agent(t, env, 'b18603', { opencode_db: 'b18604' });
  assert.equal(
    opencodeBackendEnv(forked.meta, { env }).OPENCODE_DB,
    opencodeDbPath('b18604', { env }),
    'a record naming another key was given its own id\'s database instead',
  );
});

test('a record with no opencode_db resolves to no override at all', (t) => {
  const env = scratch(t);
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-b186-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  createAgentDirectory('b18605', { env });
  // The pre-isolation shape: an optional field that simply is not there. Its
  // sessions already live in the shared database, so moving it onto a fresh
  // empty one would strand its recorded native_session_id.
  const absent = idleMeta('b18605', cwd, null, 1);
  delete absent.opencode_db;
  writeMeta('b18605', absent, { env });

  const fromAbsent = opencodeBackendEnv(absent, { env });
  const fromNull = opencodeBackendEnv({ ...absent, opencode_db: null }, { env });

  // Explicitly `undefined`, not `{}`: `undefined` is what removes the variable
  // from the child's environment, so an operator's ambient OPENCODE_DB cannot
  // decide which database this front writes to.
  assert.equal('OPENCODE_DB' in fromAbsent, true, 'an unkeyed record produced no env entry to remove');
  assert.equal(fromAbsent.OPENCODE_DB, undefined);
  assert.equal(fromNull.OPENCODE_DB, undefined);

  // And the durable record round-trips as canonical rather than malformed: an
  // absent field is an answer, not corruption.
  assert.equal(readMeta('b18605', { env }) !== null, true);
  assert.equal(persistedKeyOf(readMeta('b18605', { env })), null);
});

function persistedKeyOf(meta) {
  if (meta === null) return undefined;
  if (!Object.hasOwn(meta, 'opencode_db')) return null;
  return meta.opencode_db;
}

test('an ambient OPENCODE_DB in the runner environment does not decide the database', (t) => {
  const env = scratch(t);
  const one = agent(t, env, 'b18606');

  const saved = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = '/operator/ambient/opencode.db';
  t.after(() => {
    if (saved === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = saved;
  });

  const resolved = opencodeBackendEnv(one.meta, { env }).OPENCODE_DB;
  assert.equal(resolved, opencodeDbPath('b18606', { env }), 'the ambient value won over the record');

  // And the value really does displace the ambient one at the child, rather
  // than merely differing from it in this process: Node drops an
  // undefined-valued env pair, so the unkeyed case reaches the backend with no
  // OPENCODE_DB at all instead of the operator's shell value.
  const seen = (childEnv) => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.OPENCODE_DB))'], {
      encoding: 'utf8',
      env: { ...process.env, ...childEnv },
    });
    return result.stdout;
  };
  assert.equal(seen(opencodeBackendEnv(one.meta, { env })), resolved);
  assert.equal(seen(opencodeBackendEnv({ ...one.meta, opencode_db: null }, { env })), 'undefined');
});

test('the database directory exists before OpenCode is told to open the file', (t) => {
  const env = scratch(t);
  const one = agent(t, env, 'b18607');
  const dir = opencodeDbDir({ env });
  assert.equal(existsSync(dir), false, 'the fixture did not start from a clean slate');

  const resolved = opencodeBackendEnv(one.meta, { env }).OPENCODE_DB;
  // OpenCode 1.18.32 answers `unable to open database file` when the parent
  // directory is missing, so naming the path without creating the directory
  // would produce a backend that dies before it can be classified.
  assert.equal(existsSync(dir), true, 'the database directory was not created');
  assert.equal(existsSync(join(dir, '..')), true);
  assert.ok(resolved.endsWith(join('opencode', 'b18607.db')));
});

test('the probe path and the spawn path are given the same database', (t) => {
  const env = scratch(t);
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-log-')), 'invocations.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const rows = [{ id: 'ses_b18608', title: 'antonina-b18608', created: 10 }];
  const bin = fakeBackend(t, logFile, rows);
  if (bin === null) return;

  const one = agent(t, env, 'b18608', { native_session_id: null });
  const backendEnv = { ...opencodeBackendEnv(one.meta, { env }), [OPENCODE_BIN_ENV]: bin };
  const expected = opencodeDbPath('b18608', { env });

  // The probe: `buildAgentCommand` in continue mode probes for the session to
  // continue when the record does not carry one, and `rememberFreshSession`
  // probes after an invocation. Both ask the same question of the same
  // database, so both must be pointed at the invocation's database.
  const command = buildAgentCommand(readMeta('b18608', { env }), 'work', true, backendEnv);
  assert.ok(command !== null, 'continue mode built no command');
  assert.deepEqual(command?.slice(1), [
    'run', '--auto', '--session', 'ses_b18608', '--model', 'opencode/space-bunny-free',
    '--variant', 'high', '--thinking', '--dir', command[command.length - 2], 'work',
  ]);

  assert.equal(discoverSessionId('b18608', backendEnv), 'ses_b18608');

  // Every recorded invocation -- probe and spawn alike -- saw the per-agent
  // database and never the shared one.
  const seen = recorded(logFile);
  assert.ok(seen.length >= 2, `expected a probe and a command build, saw ${seen.length}`);
  for (const entry of seen) {
    assert.equal(entry.db, expected, `invocation "${entry.argv}" was given ${entry.db}`);
  }
});

test('a fork keeps the source database it inherited a session from', (t) => {
  const env = scratch(t);
  const source = agent(t, env, 'b18609', { native_session_id: 'ses_source' });

  // `forkMetaSnapshot` clones the source record with `structuredClone`, so the
  // database key rides along with the native_session_id it is meaningless
  // without. This is the case that fails if the key is ever dropped from the
  // clone: the clone would inherit `ses_source` and then look for it in a
  // fresh, empty database.
  const clone = forkMetaSnapshot(source.meta, 'b1860a', 2);
  assert.equal(clone.opencode_db, source.meta.opencode_db, 'the clone was moved off the source database');
  assert.equal(clone.native_session_id, 'ses_source');
  assert.equal(
    opencodeBackendEnv(clone, { env }).OPENCODE_DB,
    opencodeDbPath(source.meta.opencode_db, { env }),
  );
});

test('deleting a record reaps its database, and a fork clone pins it', (t) => {
  const env = scratch(t);
  const source = agent(t, env, 'b1860b', { native_session_id: 'ses_gone' });
  const key = opencodeBackendEnv(source.meta, { env }).OPENCODE_DB;
  // Stand in for the file the backend would have created: this front is about
  // which files Antonina reaps, not about SQLite's own on-disk behaviour.
  writeFileSync(key, 'not really a database\n');
  writeFileSync(`${key}-wal`, 'wal\n');

  // A fork clone that still names the same key, written before the source goes.
  const cloneDir = join(agentDir('b1860c', { env }));
  mkdirSync(cloneDir, { recursive: true });
  writeMeta('b1860c', forkMetaSnapshot(source.meta, 'b1860c', 2), { env });

  removeAgentDirectory('b1860b', { env });
  assert.equal(existsSync(agentDir('b1860b', { env })), false, 'the record was not removed');
  assert.equal(
    existsSync(key), true,
    'deleting a source took the database out from under the clone still continuing it',
  );
  assert.equal(existsSync(`${key}-wal`), true);

  // Once nothing names the key, the database and its WAL/SHM siblings are
  // unreferenced garbage under the state root.
  removeAgentDirectory('b1860c', { env });
  assert.equal(existsSync(key), false, 'the unreferenced database was left behind');
  assert.equal(existsSync(`${key}-wal`), false, 'the unreferenced WAL was left behind');
});
// ---------------------------------------------------------------------------
// Cases 8-10: the runner's own env plumbing, driven through the shipped runner.
//
// Everything above supplies the environment itself, which is exactly why it
// cannot see the coupling being deleted. These three hand the decision to
// `runner.ts` and observe what the backend was ACTUALLY given.
const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');

// A fixture backend whose ANSWER DEPENDS ON THE DATABASE it was handed, which is
// the whole point: a probe pointed at the wrong OPENCODE_DB cannot see a session
// the invocation wrote into the right one, so a runner that dropped the
// isolation would answer `no session` where it must answer `yes`.
//
//   * `run` records a session for the agent into "$OPENCODE_DB.sessions" and
//     exits 0, so the runner converges on its own and reaps nothing.
//   * `session list` prints the row only if the sidecar file exists next to the
//     OPENCODE_DB IT WAS GIVEN, which is how a wrong database answers empty.
//   * every invocation appends "OPENCODE_DB|argv" to a log, so what each probe
//     and each spawn was handed is recorded rather than inferred.
function runnerBackend(t, id, logFile) {
  const failures = [];
  for (const parent of [tmpdir(), REPO_FIXTURE_PARENT]) {
    let root;
    try {
      mkdirSync(parent, { recursive: true });
      root = mkdtempSync(join(parent, 'antonina-b186-runner-'));
    } catch (error) {
      failures.push(`${parent}: ${error.message}`);
      continue;
    }
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      try {
        rmSync(REPO_FIXTURE_PARENT, { recursive: true, force: false });
      } catch {
        // A shared fixture parent that is still busy belongs to another case.
      }
    });
    if (!execProbe(root, 'probe-')) continue;
    const bin = join(root, 'opencode');
    const sessionId = `ses_${id.replace(/[^A-Za-z0-9]/g, '')}`;
    writeFileSync(bin, `#!/bin/sh
printf '%s|%s\\n' "$OPENCODE_DB" "$*" >>'${logFile}'
case "$1" in
  run) printf '%s\\n' '${sessionId}' > "$OPENCODE_DB.sessions" ;;
  session)
    if [ -f "$OPENCODE_DB.sessions" ]; then
      printf '[{"id":"%s","title":"antonina-${id}","created":1}]\\n' '${sessionId}'
    fi
    ;;
esac
exit 0
`, { mode: 0o755 });
    return { bin, sessionId };
  }
  t.skip(`no exec-capable fixture directory for the fake opencode backend; tried: ${failures.join('; ')}`);
  return null;
}

function runnerScratch(t, bin) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-b186-run-'));
  const env = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    [OPENCODE_BIN_ENV]: bin,
    // The launcher hands the runner the token it minted for the reservation
    // `runnerAgent` below writes, which is what the product does on every
    // reservation it writes.
    ANTONINA_RUNNER_OWNER_TOKEN: LAUNCHER_TOKEN,
  };
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  registerCleanup(`b186 scratch home ${root}`, () => {
    rmSync(root, { recursive: true, force: true });
    return 'removed';
  });
  return { env };
}

// A record the runner will actually claim and run: a reserved runner reservation
// at the generation the caller passes, an accepted prompt, and no recorded
// native session. Written through `beginInvocation`, which is what `antonina run`
// writes, so the shape under test is a shape the CLI produces.
function runnerAgent(t, env, id, mode, overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'antonina-b186-runner-cwd-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(createAgentDirectory(id, { env }), true);
  const meta = idleMeta(id, cwd, null, 1);
  beginInvocation(meta, 'do the work', 2, 1);
  meta.runner_gen = 4;
  meta.active_runner = true;
  meta.runner_reservation = {
    state: 'reserved',
    gen: 4,
    mode,
    reserved_at: 2,
    owner_pid: process.pid,
    // The launcher that would really have written this reservation names
    // itself, so it names its own real start time. Zero is not a start
    // time and would be refused by the `self` verdict.
    owner_start_ticks: procStartTicks(process.pid),
    // ...and the token the launcher minted for it, which the `self` verdict now
    // requires as well: see runner-launch-gate.test.mjs.
    owner_token: LAUNCHER_TOKEN,
  };
  for (const [key, value] of Object.entries(overrides)) meta[key] = value;
  writeMeta(id, meta, { env });
  const options = { env };
  registerReap(`b186 agent ${id} invocation`, () => reapInvocation(id, options));
  return { id, cwd, options };
}

// The product's own identity rule, in order: recorded pid, matching /proc start
// ticks, this invocation's environ markers. Nothing is found by process name.
function reapInvocation(id, options) {
  const live = readMeta(id, options);
  if (live === null) return 'no durable record, so no identity to signal';
  const { pid, pgid, start_time: startTime, invocation_id: invocationId } = live;
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'no recorded invocation pid, so nothing was left running';
  if (procStartTicks(pid) !== startTime) return `pid ${pid} no longer has the recorded start ticks ${startTime}; not signalled`;
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

function invocationLog(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('|');
    return { db: line.slice(0, at), argv: line.slice(at + 1) };
  });
}

test('the runner spawns the backend in the record database, and reaps it', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  if (procStartTicks(process.pid) === null) {
    t.skip('requires /proc/<pid>/stat for runner process identity');
    return;
  }
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-log-')), 'runner.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const fixture = runnerBackend(t, 'b1860d', logFile);
  if (fixture === null) return;
  const { env } = runnerScratch(t, fixture.bin);
  const one = runnerAgent(t, env, 'b1860d', 'new');

  await runManagedRunner(one.id, 'new', 4, one.options);

  const expected = opencodeDbPath('b1860d', { env });
  const seen = invocationLog(logFile);
  const spawns = seen.filter((entry) => entry.argv.startsWith('run '));
  assert.equal(spawns.length, 1, `expected exactly one spawned invocation, saw ${spawns.length}`);
  // The spawned process was handed this agent's database, not an inherited one.
  // Asserted on what the child recorded, not on what runner.ts was supposed to
  // compute: delete the spread at runner.ts:486 and this is empty.
  assert.equal(spawns[0].db, expected, 'the spawned backend was not given the record database');
  // And nothing was left running: the fixture exits 0 and the runner awaited it.
  const after = readMeta(one.id, one.options);
  assert.equal(after.state, 'succeeded');
  assert.equal(after.active_runner, false);
  assert.equal(after.runner_reservation, null);
  assert.throws(() => process.kill(after.pid, 0), /ESRCH/, 'a backend process was left running');
});

test('the runner probes for a fresh session in the database it spawned in', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  if (procStartTicks(process.pid) === null) {
    t.skip('requires /proc/<pid>/stat for runner process identity');
    return;
  }
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-log-')), 'probe.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const fixture = runnerBackend(t, 'b1860e', logFile);
  if (fixture === null) return;
  const { env } = runnerScratch(t, fixture.bin);
  const one = runnerAgent(t, env, 'b1860e', 'new');

  await runManagedRunner(one.id, 'new', 4, one.options);

  const expected = opencodeDbPath('b1860e', { env });
  const seen = invocationLog(logFile);
  // `rememberFreshSession` runs after a first (non-continue) invocation, because
  // a new session's id is only knowable once the backend has created it. The
  // fixture writes it into the database it was given, so this probe can only
  // answer with the session id if it was pointed at the same database.
  const probes = seen.filter((entry) => entry.argv.startsWith('session list'));
  assert.ok(probes.length >= 1, `the runner never probed for the fresh session; saw ${JSON.stringify(seen)}`);
  for (const probe of probes) {
    assert.equal(probe.db, expected, `a probe was given ${probe.db} instead of ${expected}`);
  }
  const after = readMeta(one.id, one.options);
  assert.equal(
    after.native_session_id, fixture.sessionId,
    'the post-invocation probe did not find the session the invocation had just created',
  );
});

test('a continuation probes in the record database, and fails without it', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  if (procStartTicks(process.pid) === null) {
    t.skip('requires /proc/<pid>/stat for runner process identity');
    return;
  }
  const logFile = join(mkdtempSync(join(tmpdir(), 'antonina-b186-log-')), 'cont.log');
  t.after(() => rmSync(join(logFile, '..'), { recursive: true, force: true }));
  const fixture = runnerBackend(t, 'b1860f', logFile);
  if (fixture === null) return;
  const { env } = runnerScratch(t, fixture.bin);
  const one = runnerAgent(t, env, 'b1860f', 'continue');

  // A session that already exists, recorded in the database this record names --
  // exactly the state an earlier invocation left behind. The record itself knows
  // no session id, which is why the runner has to probe for one.
  const expected = opencodeDbPath('b1860f', { env });
  mkdirSync(opencodeDbDir({ env }), { recursive: true });
  writeFileSync(`${expected}.sessions`, `${fixture.sessionId}\n`);

  await runManagedRunner(one.id, 'continue', 4, one.options);

  const seen = invocationLog(logFile);
  const probes = seen.filter((entry) => entry.argv.startsWith('session list'));
  assert.ok(probes.length >= 1, `continue mode built no probe; saw ${JSON.stringify(seen)}`);
  for (const probe of probes) {
    assert.equal(probe.db, expected, `the continuation probe was given ${probe.db} instead of ${expected}`);
  }
  const spawns = seen.filter((entry) => entry.argv.startsWith('run '));
  assert.equal(spawns.length, 1, 'the continuation did not run exactly one invocation');
  // The continuation ran the session it probed for. If the probe had been given
  // a different database it would have found nothing, `buildAgentCommand` would
  // have returned null, and the record would read `failed` with
  // "cannot continue: underlying session not available" -- so this assertion and
  // the argv assertion are two views of the same fact.
  assert.match(spawns[0].argv, new RegExp(`--session ${fixture.sessionId}(\\s|$)`));
  const after = readMeta(one.id, one.options);
  // The record still names no session: on the continue path the probed id is
  // used for the command and is not written back (`rememberFreshSession` runs
  // only after a first, non-continue invocation). The session id is observable in
  // the argv the backend was actually launched with, which is asserted above.
  assert.notEqual(after.state, 'failed', `the continuation failed: ${after.error}`);
  assert.throws(() => process.kill(after.pid, 0), /ESRCH/, 'a backend process was left running');
});
