import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const OPENCODE_BIN_ENV = 'ANTONINA_OPENCODE_BIN';
const REPO_FIXTURE_PARENT = resolve('.antonina-test-tmp');
const PROBE_SENTINEL = 'ANTONINA-FIXTURE-EXEC-OK';

// The fixture must be exec-able: on hosts where tmpdir() is mounted noexec the
// fake backend would fail to exec, and a bare `opencode` lookup would then
// fall through to whatever real backend is on PATH. Probe candidate parents
// and pick the first that can actually exec a script, so a non-exec-able
// location becomes a loud, named host problem instead of a silent substitution.
function execProbe(parent, name) {
  const dir = mkdtempSync(join(parent, name));
  const probe = join(dir, 'probe.sh');
  writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "${PROBE_SENTINEL}"\n`, { mode: 0o755 });
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 15_000 });
  rmSync(dir, { recursive: true, force: true });
  if (result.error) return { ok: false, reason: String(result.error.code ?? result.error.message) };
  if (result.status !== 0) return { ok: false, reason: `probe exited with status ${result.status}` };
  if (result.stdout.trim() !== PROBE_SENTINEL) {
    return { ok: false, reason: `probe produced ${JSON.stringify(result.stdout)}` };
  }
  return { ok: true, reason: 'exec ok' };
}

function candidateParents() {
  return [tmpdir(), REPO_FIXTURE_PARENT];
}

// Removing the repo-local fixture parent is best effort, and only ever happens
// once it is empty: rmdir fails with ENOTEMPTY while a sibling suite's root is
// still live, which is expected. Any other failure is a real leftover and is
// reported rather than swallowed. (`rmSync(path, { recursive: false })` cannot
// be used here: on a directory it fails EISDIR on Node 22+, which is why the
// earlier bare `catch {}` never removed anything.)
function pruneFixtureParent(t) {
  try {
    rmdirSync(REPO_FIXTURE_PARENT);
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') return;
    t?.diagnostic(`fixture parent ${REPO_FIXTURE_PARENT} left behind: ${error.message}`);
  }
}

// The root's cleanup is registered here, inside selectExecRoot, at the moment
// the directory is created and before the no-exec throw path can be reached:
// a probe failure, a mid-suite abort or a stray file must not leave a directory
// in the worktree.
function selectExecRoot(prefix, parents = candidateParents(), probe = execProbe, t) {
  const failures = [];
  for (const parent of parents) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      failures.push(`${parent}: cannot create fixture parent (${error.message})`);
      continue;
    }
    const outcome = probe(parent, prefix);
    if (outcome.ok) {
      const root = mkdtempSync(join(parent, prefix));
      t?.after(() => {
        rmSync(root, { recursive: true, force: true });
        pruneFixtureParent(t);
      });
      return root;
    }
    failures.push(`${parent}: ${outcome.reason}`);
  }
  pruneFixtureParent(t);
  const error = new Error(
    `no exec-capable fixture directory for the fake opencode; tried: ${failures.join('; ')}`,
  );
  error.code = 'ANTONINA_FIXTURE_NOEXEC';
  throw error;
}

function fixture(t) {
  const root = selectExecRoot('antonina-cli-e2e-', undefined, undefined, t);
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  const opencode = join(bin, 'opencode');
  const pathBin = join(root, 'path-bin');
  mkdirSync(pathBin);
  const invocations = join(root, 'fixture-invocations.log');
  const escapes = join(root, 'path-escapes.log');
  // Bare `opencode` on PATH resolves to this trap, never to a real backend.
  writeFileSync(join(pathBin, 'opencode'), `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >>'${escapes}'
echo "antonina-test: PATH resolved a non-fixture opencode ($0)" >&2
exit 70
`, { mode: 0o755 });
  writeFileSync(opencode, `#!/bin/sh
printf '%s %s\\n' "$0" "$*" >>'${invocations}'
case "$1" in
  models)
    echo "opencode/space-bunny-free"
    exit 0
    ;;
  session)
    echo '[{"id":"ses_fake","title":"antonina-a11d","created":100},{"id":"ses_beef","title":"antonina-beef","created":100}]'
    exit 0
    ;;
  run)
    if [ -n "$ANTONINA_TEST_CALLS" ]; then
      printf '%s\n' "$*" >>"$ANTONINA_TEST_CALLS"
    fi
    last=""
    for arg in "$@"; do last="$arg"; done
    if [ "$last" = "slow" ]; then
      echo "slow-start"
      sleep 30
      exit 0
    fi
    if [ "$last" = "term-trap" ]; then
      # A backend that refuses to die politely: SIGTERM is ignored, so only a
      # SIGKILL escalation to the recorded process group can stop it.
      trap '' TERM
      echo "term-trap-armed"
      sleep 300
      exit 0
    fi
    if [ "$last" = "server-error" ]; then
      echo '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_e2e"}}'
      exit 1
    fi
    echo "FAKE:$last"
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(opencode, 0o755);
  const env = {
    ...process.env,
    PATH: `${pathBin}:${process.env.PATH ?? ''}`,
    XDG_STATE_HOME: join(root, 'state'),
    // Trust/credential configuration must also be test-owned: without this the
    // suite would read the operator's real ~/.config/antonina.
    XDG_CONFIG_HOME: join(root, 'config'),
    ANTONINA_TEST_CALLS: join(root, 'opencode-calls.log'),
    [OPENCODE_BIN_ENV]: opencode,
  };
  // Positive control: the fixture about to be used is exec-able and answers.
  const direct = spawnSync(opencode, ['models'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(
    direct.status,
    0,
    `fake opencode fixture ${opencode} is not runnable here: ${direct.error?.code ?? direct.stderr}`,
  );
  assert.match(direct.stdout, /opencode\/space-bunny-free/);
  // Negative control: a bare `opencode` lookup in this environment hits the
  // trap, so any PATH fall-through is recorded instead of reaching a real host
  // backend.
  const trapped = spawnSync('opencode', ['models'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(trapped.status, 70, 'the PATH trap for bare `opencode` is not armed');
  // Discard the controls' own records; only test-time invocations are asserted.
  rmSync(escapes, { force: true });
  rmSync(invocations, { force: true });
  t.after(() => {
    assert.deepEqual(
      pathEscapes({ escapes }),
      [],
      'a non-fixture opencode was executed via PATH during this test',
    );
  });
  return { root, work, env, opencode, escapes, invocations };
}

function fixtureInvocations(env) {
  if (!existsSync(env.ANTONINA_TEST_CALLS)) return [];
  return readFileSync(env.ANTONINA_TEST_CALLS, 'utf8').split('\n').filter(Boolean);
}

function pathEscapes(fixtureHandle) {
  const { escapes } = fixtureHandle;
  if (!existsSync(escapes)) return [];
  return readFileSync(escapes, 'utf8').split('\n').filter(Boolean);
}

// Asserts the fake backend, at its exact absolute path, is the program that ran.
function assertFixtureInvoked(fixtureHandle, expected) {
  const { env, opencode } = fixtureHandle;
  const escapes = pathEscapes(fixtureHandle);
  assert.deepEqual(
    escapes,
    [],
    `a non-fixture opencode was executed via PATH: ${escapes.join(' | ')}`,
  );
  assert.ok(isAbsolute(opencode), 'the backend fixture must be addressed by absolute path');
  const recorded = existsSync(fixtureHandle.invocations)
    ? readFileSync(fixtureHandle.invocations, 'utf8').split('\n').filter(Boolean)
    : [];
  for (const line of recorded) {
    assert.equal(
      line.split(' ')[0],
      opencode,
      `a program other than the fixture backend was executed as the backend: ${line}`,
    );
  }
  if (expected === undefined) return;
  const calls = fixtureInvocations(env);
  assert.ok(
    calls.some((line) => line.includes(expected)),
    `expected the fixture backend (${opencode}) to be invoked with ${JSON.stringify(expected)}; saw ${JSON.stringify(calls)}`,
  );
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

function metaPath(root, id) {
  return join(root, 'state', 'antonina', 'agents', id, 'meta.json');
}

async function waitFor(root, id, predicate, timeoutMs = 8_000) {
  const path = metaPath(root, id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8'));
      if (predicate(meta)) return meta;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for agent ${id}`);
}

test('built CLI runs a fresh prompt then continues the discovered OpenCode session', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  const created = run(['agent', 'new', '--id', 'a11d', '--cwd', work, '--json'], env);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).state, 'idle');

  const first = run(['agent', 'prompt', '--id', 'a11d', '--detach', 'hello'], env);
  assert.equal(first.status, 0, first.stderr);
  const firstDone = await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.active_runner === false);
  assert.equal(firstDone.native_session_id, 'ses_fake');
  assert.equal(firstDone.prompt_count, 1);

  const second = run(['agent', 'prompt', '--id', 'a11d', '--detach', 'again'], env);
  assert.equal(second.status, 0, second.stderr);
  const secondDone = await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.prompt_count === 2 && meta.active_runner === false);
  assert.equal(secondDone.native_session_id, 'ses_fake');
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'a11d', 'output.log'), 'utf8');
  assert.match(log, /FAKE:hello/);
  assert.match(log, /FAKE:again/);
  assertFixtureInvoked(handle, 'hello');
  assertFixtureInvoked(handle, 'again');
});

test('hard steer interrupts the running process group and drains redirect FIFO', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'beef', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'beef', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'beef', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const steer = run(['agent', 'prompt', '--id', 'beef', '--steer', '--detach', 'redirect'], env);
  assert.equal(steer.status, 0, steer.stderr);
  const done = await waitFor(root, 'beef', (meta) => meta.state === 'succeeded' && meta.prompt_count === 2 && meta.active_runner === false, 12_000);
  assert.equal(done.native_session_id, 'ses_beef');
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'beef', 'output.log'), 'utf8');
  assert.match(log, /slow-start/);
  assert.match(log, /FAKE:redirect/);
  assertFixtureInvoked(handle, 'slow');
  assertFixtureInvoked(handle, 'redirect');
});

test('ordinary prompt remains busy while an invocation is running', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'cafe', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'cafe', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'cafe', (meta) => meta.state === 'running' && typeof meta.pid === 'number');
  const busy = run(['agent', 'prompt', '--id', 'cafe', '--detach', 'second'], env);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /still running/);
  const killed = run(['agent', 'kill', '--id', 'cafe'], env);
  assert.equal(killed.status, 0, killed.stderr);
  assertFixtureInvoked(handle, 'slow');
});


test('stale reserved work is recovered without overwriting the accepted prompt', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'd00d', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'd00d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: true,
    pending_prompt: 'accepted',
    prompt_count: 1,
    runner_gen: 1,
    runner_reservation: {
      state: 'reserved',
      gen: 1,
      mode: 'new',
      owner_pid: 99999999,
      owner_start_ticks: 1,
      reserved_at: 1,
    },
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));

  const recovery = run(['agent', 'prompt', '--id', 'd00d', '--detach', 'replacement'], env);
  assert.equal(recovery.status, 1);
  assert.match(recovery.stderr, /recovering an already accepted prompt/);
  const done = await waitFor(root, 'd00d', (value) => value.state === 'succeeded' && value.active_runner === false);
  assert.equal(done.prompt_count, 1);
  const log = readFileSync(join(root, 'state', 'antonina', 'agents', 'd00d', 'output.log'), 'utf8');
  assert.match(log, /FAKE:accepted/);
  assert.doesNotMatch(log, /FAKE:replacement/);
  assertFixtureInvoked(handle, 'accepted');
});

test('status reconciles abandoned running metadata to an explicit failure', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'dead', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'dead');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: false,
    pending_prompt: null,
    runner_reservation: null,
    pid: 99999999,
    pgid: 99999999,
    start_time: 1,
    invocation_id: 'a'.repeat(32),
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));

  const status = run(['agent', 'status', '--id', 'dead', '--json'], env);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'failed');
  assert.match(readFileSync(path, 'utf8'), /disappeared without a captured exit status/);
});


test('stop on idle is a no-op and preserves idle state', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'fade', '--cwd', work], env).status, 0);
  const stopped = run(['agent', 'stop', '--id', 'fade'], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /already stopped/);
  const meta = JSON.parse(readFileSync(metaPath(root, 'fade'), 'utf8'));
  assert.equal(meta.state, 'idle');
});

test('clean dry-run observes and clean removes old terminal agents', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'f00d', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'f00d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, { state: 'succeeded', finished_at: 1, active_runner: false });
  writeFileSync(path, JSON.stringify(meta));

  const dry = run(['agent', 'clean', '--days', '1', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /f00d/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'succeeded');

  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /deleted agent f00d/);
  assert.throws(() => readFileSync(path, 'utf8'));
});


test('delete without force refuses live work and force converges before removal', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'feed', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'feed', '--detach', 'slow'], env).status, 0);
  await waitFor(root, 'feed', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const refused = run(['agent', 'delete', '--id', 'feed'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /use --force/);
  assert.equal(JSON.parse(readFileSync(metaPath(root, 'feed'), 'utf8')).state, 'running');

  const forced = run(['agent', 'delete', '--id', 'feed', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /deleted agent feed/);
  assert.throws(() => readFileSync(metaPath(root, 'feed'), 'utf8'));
});

// The --force runner-reaping block in cmdDelete (packages/cli/src/agent.ts).
// The invariant, in one sentence: when `delete --force` removes an agent that
// owns work, it must first reap the reserved/live runner process itself --
// killing the invocation, escalating to SIGKILL on the runner, and failing
// closed if the runner survives -- so that no orphan runner outlives the
// directory it is writing into. The test below pins the outcome with real
// process identity (PID + start ticks), not with a stubbed seam: a mutant that
// drops the block still prints "deleted agent" and still removes the state
// directory, so only the surviving process distinguishes them.
test('delete --force reaps the live runner process before removing the agent', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'feed1', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'feed1', '--detach', 'slow'], env).status, 0);
  const live = await waitFor(
    root,
    'feed1',
    (meta) => meta.state === 'running'
      && typeof meta.pid === 'number'
      && meta.active_runner === true
      && typeof meta.runner_pid === 'number'
      && meta.runner_pid > 1,
  );
  const runnerPid = live.runner_pid;
  const runnerTicks = live.runner_start_time;
  const invocationPid = live.pid;
  assert.equal(typeof runnerTicks, 'number', 'the live runner must carry recorded identity facts');
  assert.ok(
    procStartTicks(runnerPid) === runnerTicks,
    `runner ${runnerPid} must be alive with the recorded start ticks before delete`,
  );
  // The runner is detached from this test, so it is reaped here whether or not
  // the command under test did it. On the shipped path delete already killed
  // it, and the group kill below is then a no-op on a dead process group.
  t.after(() => {
    for (const pid of [runnerPid, invocationPid]) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });

  const forced = run(['agent', 'delete', '--id', 'feed1', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /deleted agent feed1/);
  assert.throws(() => readFileSync(metaPath(root, 'feed1'), 'utf8'), 'the agent directory must be removed');

  assert.equal(
    procStartTicks(runnerPid),
    null,
    `the reserved runner ${runnerPid} must be reaped before delete --force returns`,
  );
  assert.equal(
    procStartTicks(invocationPid),
    null,
    `the runner's OpenCode invocation ${invocationPid} must be reaped before delete --force returns`,
  );
  assertFixtureInvoked(handle, 'slow');
});

// A reservation that no runner has claimed yet, owned by this (genuinely live)
// test process. The reaping block must still drive the agent to a terminal
// record and say so, instead of silently tombstoning and dropping the
// reservation on the floor: a reserved runner is work that was accepted.
test('delete --force cancels an in-flight runner reservation and reports it', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'feed2', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'feed2');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: true,
    runner_pid: null,
    runner_start_time: null,
    pending_prompt: 'accepted',
    prompt_count: 1,
    runner_gen: 1,
    started_at: 1,
    runner_reservation: {
      state: 'reserved',
      gen: 1,
      mode: 'new',
      // This test process is alive and these are its real identity facts, so
      // the reservation owner check holds without relying on the grace window.
      owner_pid: process.pid,
      owner_start_ticks: procStartTicks(process.pid),
      reserved_at: 1,
    },
  });
  writeFileSync(path, JSON.stringify(meta));

  const refused = run(['agent', 'delete', '--id', 'feed2'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /use --force/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runner_reservation.state, 'reserved');

  const forced = run(['agent', 'delete', '--id', 'feed2', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(
    forced.stdout,
    /cancelled reserved runner work/,
    'delete --force must reap the reservation, not just tombstone it',
  );
  assert.match(forced.stdout, /deleted agent feed2/);
  assert.throws(() => readFileSync(path, 'utf8'));
});

// /proc entries for a freshly spawned process can lag, and a reaped process has
// no entry at all: null means "gone", which is what these tests assert on.
function procStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(after[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

// The process group a PID actually belongs to, read the same way the runtime
// reads it. A recorded pgid that disagrees with this is a signal into a group
// the victim is not in, which is a silent no-op.
function procPgrp(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}

// A process is gone when it has no /proc entry at all, and also when the entry
// it does have belongs to a different process (PID reuse). Comparing the start
// ticks is what makes the second case decidable without a name.
function sameProcess(pid, ticks) {
  const observed = procStartTicks(pid);
  return observed !== null && observed === ticks;
}

test('delete tombstone blocks later prompt reservation', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'face', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'face');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.delete_pending = true;
  writeFileSync(path, JSON.stringify(meta));

  const prompt = run(['agent', 'prompt', '--id', 'face', '--detach', 'must-not-run'], env);
  assert.equal(prompt.status, 1);
  assert.match(prompt.stderr, /still running|redirect/);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.pending_prompt ?? null, null);
  assert.equal(after.active_runner, false);
  assert.equal(after.prompt_count, 0);
});


test('backend server failure is persisted and sanitized through status', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'bad1', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'bad1', '--detach', 'server-error'], env).status, 0);
  await waitFor(root, 'bad1', (meta) => meta.state === 'failed' && meta.active_runner === false);

  const status = run(['agent', 'status', '--id', 'bad1', '--json'], env);
  assert.equal(status.status, 0, status.stderr);
  const body = JSON.parse(status.stdout);
  assert.equal(body.state, 'failed');
  assert.equal(body.backend_error.classification, 'transient_backend_server_error');
  assert.equal(body.backend_error.reference, 'err_e2e');
  assert.equal(body.backend_error.automatic_retry_safe, false);
  assert.equal(body.backend_error.request_boundary, 'fresh_session');
  assertFixtureInvoked(handle, 'server-error');
});


test('prompt recovers an existing OpenCode session when durable session id was lost', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'a11d', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'a11d', '--detach', 'first'], env).status, 0);
  await waitFor(root, 'a11d', (meta) => meta.state === 'succeeded' && meta.active_runner === false);

  const path = metaPath(root, 'a11d');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.native_session_id = null;
  writeFileSync(path, JSON.stringify(meta));

  assert.equal(run(['agent', 'prompt', '--id', 'a11d', '--detach', 'recovered'], env).status, 0);
  const done = await waitFor(
    root,
    'a11d',
    (value) => value.state === 'succeeded' && value.prompt_count === 2 && value.active_runner === false,
  );
  assert.equal(done.native_session_id, 'ses_fake');

  const calls = readFileSync(env.ANTONINA_TEST_CALLS, 'utf8');
  assert.match(calls, /run --auto --session ses_fake .* recovered/);
  assertFixtureInvoked(handle, 'recovered');
});


test('agent ids canonicalize at every CLI boundary and preserve exit-code distinctions', (t) => {
  const { root, work, env } = fixture(t);
  const created = run(['agent', 'new', '--id', 'A11CE', '--cwd', work], env);
  assert.equal(created.status, 0, created.stderr);
  assert.doesNotThrow(() => readFileSync(metaPath(root, 'a11ce'), 'utf8'));

  for (const id of ['a11ce', 'A11CE', 'a11Ce']) {
    const status = run(['agent', 'status', '--id', id, '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).id, 'a11ce');
  }

  assert.equal(run(['agent', 'status', '--id', 'not-hex', '--json'], env).status, 2);
  assert.equal(run(['agent', 'status', '--id', 'deadbeef', '--json'], env).status, 3);
});

test('list and status fail closed on malformed or old metadata', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'cab1e', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'cab1e');

  let meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.created_at = {};
  writeFileSync(path, JSON.stringify(meta));

  const status = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(status.status, 1);
  assert.match(status.stderr, /created_at is malformed/);

  const listed = run(['agent', 'list', '--json'], env);
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /created_at is malformed/);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.created_at = 1;
  meta.agent_version = 3;
  writeFileSync(path, JSON.stringify(meta));
  const oldVersion = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(oldVersion.status, 1);
  assert.match(oldVersion.stderr, /unsupported managed-agent metadata version: 3/);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.agent_version = 4;
  delete meta.active_runner;
  writeFileSync(path, JSON.stringify(meta));
  const missing = run(['agent', 'status', '--id', 'cab1e', '--json'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /metadata fields are not canonical/);
});

test('prompt rejects malformed durable execution configuration before reservation', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', 'c0de', '--cwd', work], env).status, 0);
  const path = metaPath(root, 'c0de');

  const malformedCwd = JSON.parse(readFileSync(path, 'utf8'));
  malformedCwd.cwd = 'relative';
  writeFileSync(path, JSON.stringify(malformedCwd));
  const cwdPrompt = run(['agent', 'prompt', '--id', 'c0de', '--detach', 'must-not-run'], env);
  assert.equal(cwdPrompt.status, 1);
  assert.match(cwdPrompt.stderr, /cwd is malformed/);
  let after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.prompt_count, 0);
  assert.equal(after.active_runner, false);

  after.cwd = work;
  after.variant = '';
  writeFileSync(path, JSON.stringify(after));
  const variantPrompt = run(['agent', 'prompt', '--id', 'c0de', '--detach', 'must-not-run'], env);
  assert.equal(variantPrompt.status, 1);
  assert.match(variantPrompt.stderr, /variant is malformed/);
  after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.prompt_count, 0);
  assert.equal(after.active_runner, false);
});

test('legacy top-level agent command spellings are not accepted', (t) => {
  const { env } = fixture(t);
  const result = run(['list', '--json'], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /expected "agent" or "board"/);
});


test('attached prompt streams output and returns invocation status', (t) => {
  const handle = fixture(t);
  const { work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'ac1d', '--cwd', work], env).status, 0);
  const prompt = run(['agent', 'prompt', '--id', 'ac1d', 'attached'], env);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /FAKE:attached/);
  assertFixtureInvoked(handle, 'attached');
});

test('graceful stop and wait timeout expose stable lifecycle results', async (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '5a0f', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', '5a0f', '--detach', 'slow'], env).status, 0);
  await waitFor(root, '5a0f', (meta) => meta.state === 'running' && typeof meta.pid === 'number');

  const timed = run(['agent', 'wait', '--id', '5a0f', '--timeout', '1'], env);
  assert.equal(timed.status, 124);
  assert.match(timed.stderr, /still running after 1s/);

  const stopped = run(['agent', 'stop', '--id', '5a0f'], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  const meta = JSON.parse(readFileSync(metaPath(root, '5a0f'), 'utf8'));
  assert.equal(meta.state, 'stopped');

  const waited = run(['agent', 'wait', '--id', '5a0f', '--timeout', '1'], env);
  assert.equal(waited.status, 1);
});

test('status exposes canonical and malformed steer metadata', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '57ee', '--cwd', work], env).status, 0);
  const path = metaPath(root, '57ee');
  let meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.steer_seq = 2;
  meta.steer_queue = [{ seq: 2, prompt: 'first line\nsecond line', queued_at: 1.5 }];
  meta.intent = 'steer';
  writeFileSync(path, JSON.stringify(meta));

  let status = JSON.parse(run(['agent', 'status', '--id', '57ee', '--json'], env).stdout);
  assert.equal(status.steers_pending, 1);
  assert.equal(status.next_steer, 'first line');
  assert.equal(status.steer_preempting, true);
  assert.equal(status.steer_metadata_error, null);

  meta = JSON.parse(readFileSync(path, 'utf8'));
  meta.intent = null;
  meta.steer_seq = false;
  meta.steer_queue = [];
  writeFileSync(path, JSON.stringify(meta));
  const malformed = run(['agent', 'status', '--id', '57ee', '--json'], env);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /steer_seq is malformed/);
});

test('fixture guard: the backend is pinned to an absolute exec-able fixture path', (t) => {
  const handle = fixture(t);
  const { env, opencode } = handle;
  assert.equal(env[OPENCODE_BIN_ENV], opencode);
  assert.ok(isAbsolute(opencode));
  assert.equal(execProbe(dirname(opencode), 'probe-').ok, true, 'the fixture directory must be exec-able');
  assertFixtureInvoked(handle);
});

test('fixture guard: a non-exec-able fixture location is a named failure, never a substitution', (t) => {
  // Candidate parents are directories this suite owns, not host paths such as
  // `/tmp` or `/workspace`: whether the host permits a test `mkdir /workspace` is
  // host-dependent, and an uncreatable parent reports through the *create*
  // branch ("cannot create fixture parent") rather than the probe reason pinned
  // here. See the matching guard in packages/agent-runtime/test/backend.test.mjs.
  const base = mkdtempSync(join(tmpdir(), 'antonina-fixture-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const parents = [join(base, 'noexec-a'), join(base, 'noexec-b')];

  assert.throws(
    () => selectExecRoot('antonina-cli-e2e-', parents, () => ({ ok: false, reason: 'EACCES' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      for (const parent of parents) {
        assert.ok(
          error.message.includes(`${parent}: EACCES`),
          `expected a per-parent EACCES reason for ${parent}, got: ${error.message}`,
        );
      }
      assert.doesNotMatch(error.message, /cannot create fixture parent/);
      return true;
    },
  );
});

test('fixture guard: an uncreatable fixture parent is a named failure, never a substitution', (t) => {
  // A parent beneath a regular file fails ENOTDIR on every host and for every
  // user, so this pins the create branch without depending on host permissions.
  const base = mkdtempSync(join(tmpdir(), 'antonina-fixture-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const blocker = join(base, 'blocker');
  writeFileSync(blocker, 'not a directory\n');
  const parents = [join(blocker, 'nested'), join(blocker, 'other')];

  assert.throws(
    () => selectExecRoot('antonina-cli-e2e-', parents, () => ({ ok: true, reason: 'exec ok' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      for (const parent of parents) {
        assert.ok(
          error.message.includes(`${parent}: cannot create fixture parent`),
          `expected a per-parent create failure for ${parent}, got: ${error.message}`,
        );
      }
      return true;
    },
  );
});

test('fixture guard: an unpinned backend falls into the PATH trap instead of a real opencode', async (t) => {
  const handle = fixture(t);
  const { root, work, env, escapes, invocations } = handle;
  // Simulate the defect: no exact backend path, so a bare `opencode` lookup is
  // the only option and must hit the recorded trap rather than a real backend.
  const unpinned = { ...env };
  delete unpinned[OPENCODE_BIN_ENV];
  assert.equal(run(['agent', 'new', '--id', 'b00b', '--cwd', work], unpinned).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', 'b00b', '--detach', 'unpinned'], unpinned).status, 0);
  const done = await waitFor(root, 'b00b', (meta) => meta.state !== 'running' && meta.active_runner === false);
  assert.equal(done.state, 'failed');
  assert.equal(done.exit_code, 70);
  const trapped = readFileSync(escapes, 'utf8');
  assert.match(trapped, /path-bin\/opencode/);
  assert.equal(existsSync(invocations), false, 'the fixture backend must not have run');
  // The escape was produced on purpose here; clear it so the shared guard does
  // not double-report it.
  rmSync(escapes, { force: true });
});

// ---------------------------------------------------------------- GAP-CLI-1
// The invariant, in one sentence: an attached (non-detached) prompt's exit code
// is the invocation's own outcome, so a backend that failed is reported as a
// failure by the foreground command that ran it -- success is never reported
// for work that failed.
test('attached prompt reports the invocation outcome, not unconditional success', (t) => {
  const handle = fixture(t);
  const { work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', 'a7ac', '--cwd', work], env).status, 0);
  const failing = run(['agent', 'prompt', '--id', 'a7ac', 'server-error'], env);
  assert.equal(
    failing.status,
    1,
    `an attached prompt whose backend failed must exit non-zero; stderr: ${failing.stderr}`,
  );
  assertFixtureInvoked(handle, 'server-error');
  // The succeeding path stays pinned too: the same command, same exit-code
  // wiring, opposite outcome.
  assert.equal(run(['agent', 'new', '--id', 'a7ad', '--cwd', work], env).status, 0);
  const succeeding = run(['agent', 'prompt', '--id', 'a7ad', 'ok'], env);
  assert.equal(succeeding.status, 0, succeeding.stderr);
  assert.match(succeeding.stdout, /FAKE:ok/);
});

// ---------------------------------------------------------------- GAP-CLI-2
// cmdLog's own tail window: `--lines N` is the count the user asked for, not a
// fixed default, and the default itself is 50. The log below is written by the
// test (the invocation is not run) so the tail boundary is exact.
test('log tails exactly the requested number of lines, defaulting to fifty', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '1099', '--cwd', work], env).status, 0);
  const logPath = join(root, 'state', 'antonina', 'agents', '1099', 'output.log');
  const lines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`);
  writeFileSync(logPath, `${lines.join('\n')}\n`);

  const three = run(['agent', 'log', '--id', '1099', '--lines', '3'], env);
  assert.equal(three.status, 0, three.stderr);
  assert.deepEqual(three.stdout.split('\n').filter(Boolean), ['line-58', 'line-59', 'line-60']);

  const fifty = run(['agent', 'log', '--id', '1099'], env);
  assert.equal(fifty.status, 0, fifty.stderr);
  const shown = fifty.stdout.split('\n').filter(Boolean);
  assert.equal(shown.length, 50, 'the default tail window is 50 lines');
  assert.equal(shown[0], 'line-11');
  assert.equal(shown.at(-1), 'line-60');
});

test('log on an agent with no output yet says so and succeeds', (t) => {
  const { root, work, env } = fixture(t);
  assert.equal(run(['agent', 'new', '--id', '109a', '--cwd', work], env).status, 0);
  assert.equal(existsSync(join(root, 'state', 'antonina', 'agents', '109a', 'output.log')), false);
  const result = run(['agent', 'log', '--id', '109a'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\(no output yet\)/);
});

// An async front end is required for anything that must stay open across a live
// invocation: `--follow` must stay attached, and `stop` must stay across its own
// grace period.
function spawnCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => err.push(chunk.toString('utf8')));
  const exited = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout: out.join(''), stderr: err.join('') }));
  });
  return { child, exited, stdout: () => out.join(''), stderr: () => err.join('') };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Condition-based waits, so a slow host cannot turn "not yet" into "never".
// Fixed sleeps are only ever used as the racing timeout, never as the trigger.
async function waitUntil(read, describe, timeoutMs = 15_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe}`);
}

function outputLogPath(root, id) {
  return join(root, 'state', 'antonina', 'agents', id, 'output.log');
}

test('log --follow streams a live invocation and returns when it reaches a terminal state', async (t) => {
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', '109b', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', '109b', '--detach', 'slow'], env).status, 0);
  const live = await waitFor(root, '109b', (meta) => meta.state === 'running' && typeof meta.pid === 'number');
  t.after(() => {
    try { process.kill(-live.pid, 'SIGKILL'); } catch {}
    try { process.kill(live.pid, 'SIGKILL'); } catch {}
  });

  const followed = spawnCli(['agent', 'log', '--id', '109b', '--follow'], env);
  // Wait until the follower has actually produced its up-front tail, so the
  // marker appended below provably arrives *after* --follow attached.
  await waitUntil(
    () => followed.stdout().includes('slow-start'),
    'log --follow to print the invocation\'s own output',
  );
  assert.equal(
    followed.child.exitCode,
    null,
    'log --follow must keep following while the invocation is still running',
  );

  // Content that did not exist when the follower attached: only the incremental
  // read can surface it, and the up-front tailLines window cannot.
  const marker = `follow-live-${Date.now()}-${process.pid}`;
  assert.doesNotMatch(
    readFileSync(outputLogPath(root, '109b'), 'utf8'),
    new RegExp(marker),
    'the marker must be unique to this run',
  );
  appendFileSync(outputLogPath(root, '109b'), `${marker}\n`);
  await waitUntil(
    () => followed.stdout().includes(marker),
    `the post-attach marker ${marker} to be streamed to the follower's stdout`,
  );
  assert.equal(
    followed.child.exitCode,
    null,
    'log --follow must still be following after streaming live content',
  );

  assert.equal(run(['agent', 'stop', '--id', '109b'], env).status, 0);
  const result = await Promise.race([
    followed.exited,
    delay(20_000).then(() => null),
  ]);
  assert.notEqual(result, null, 'log --follow must return once the agent reaches a terminal state');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(marker), 'the streamed marker must be in the returned output');
  assert.match(followed.stdout(), /slow-start/);
  assertFixtureInvoked(handle, 'slow');
  await waitFor(root, '109b', (meta) => meta.state === 'stopped');
});

test('log --follow reports a vanished agent directory instead of following forever', async (t) => {
  if (!existsSync('/proc/self/stat')) {
    t.skip('/proc is unavailable on this host: process identity cannot be checked');
    return;
  }
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', '109c', '--cwd', work], env).status, 0);
  assert.equal(run(['agent', 'prompt', '--id', '109c', '--detach', 'slow'], env).status, 0);
  const live = await waitFor(
    root,
    '109c',
    (meta) => meta.state === 'running' && typeof meta.pid === 'number' && meta.pid > 1,
  );
  // The agent's state is removed from under a live --follow; the runner and its
  // invocation outlive the directory they were writing into, so both are reaped
  // by this test rather than by the command under test.
  t.after(() => {
    for (const pid of [live.pid, live.runner_pid]) {
      if (typeof pid !== 'number') continue;
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });

  const followed = spawnCli(['agent', 'log', '--id', '109c', '--follow'], env);
  await waitUntil(
    () => followed.stdout().length > 0,
    'log --follow to attach and print the invocation\'s own output',
  );
  assert.equal(followed.child.exitCode, null, 'log --follow must be following while the agent is live');
  rmSync(join(root, 'state', 'antonina', 'agents', '109c'), { recursive: true, force: true });

  const result = await Promise.race([followed.exited, delay(20_000).then(() => null)]);
  assert.notEqual(result, null, 'log --follow must return when the agent directory vanishes');
  assert.equal(result.status, 3, `expected EXIT_NOT_FOUND, stderr: ${result.stderr}`);
  assertFixtureInvoked(handle, 'slow');
});

// ---------------------------------------------------------------- GAP-CLI-3
// The invariant, in one sentence: `stop` escalates SIGTERM to SIGKILL on the
// recorded process group for a backend that refuses to die politely, and only
// reports the agent stopped once the invocation is actually gone.
//
// The recorded invocation here is deliberately NOT a child of a live runner. A
// runner's own control poller signals SIGKILL to the recorded group at its
// CONTROL_GRACE_MS boundary, so a fixture driven by a real runner cannot tell
// the CLI's escalation from the runner's: deleting the CLI's escalation leaves
// such a test green. This fixture is spawned by the test process, leads its own
// process group, and carries real PID + start ticks + env markers with no
// runner recorded at all, so the only process anywhere that can deliver the
// SIGKILL is `agent stop` itself. The recorded pgid is the invocation's real
// group, so the escalation is a real signal rather than a no-op into a group
// that does not exist.
test('stop escalates SIGTERM to SIGKILL for a backend that ignores SIGTERM', async (t) => {
  if (!existsSync('/proc/self/stat')) {
    t.skip('/proc is unavailable on this host: liveness cannot be decided on PID plus start ticks');
    return;
  }
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', '7e40', '--cwd', work], env).status, 0);

  const invocationId = 'e'.repeat(32);
  // A live backend that refuses to die politely: SIGTERM is observed and
  // ignored, so only SIGKILL stops it.
  const victim = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"],
    {
      env: { ...env, ANTONINA_AGENT_ID: '7e40', ANTONINA_INVOCATION_ID: invocationId },
      stdio: 'ignore',
      detached: true,
    },
  );
  const reaped = new Promise((resolve) => victim.on('close', () => resolve()));
  t.after(async () => {
    try { process.kill(-victim.pid, 'SIGKILL'); } catch {}
    try { victim.kill('SIGKILL'); } catch {}
    await reaped;
  });

  const ticks = await waitUntil(
    () => procStartTicks(victim.pid),
    'the stubborn invocation to be alive with real start ticks',
  );
  const pgid = procPgrp(victim.pid);
  assert.equal(pgid, victim.pid, 'the invocation must lead its own process group');

  const path = metaPath(root, '7e40');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    // No runner and no reservation: nothing else polls this invocation and can
    // escalate on its own.
    active_runner: false,
    runner_pid: null,
    runner_start_time: null,
    runner_reservation: null,
    pending_prompt: null,
    pid: victim.pid,
    pgid,
    start_time: ticks,
    invocation_id: invocationId,
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));
  assert.equal(procStartTicks(meta.pid), ticks, 'the recorded invocation must be alive before stop');

  // stop waits 10s for a polite death, then escalates, then allows 5s more, so
  // it cannot use the 15s default timeout of run().
  const startedAt = Date.now();
  const stopped = spawnCli(['agent', 'stop', '--id', '7e40'], env);
  // Watch the victim while stop runs, so the moment of the SIGKILL is observed
  // instead of being inferred from the command's own report.
  let diedAt = null;
  const watcher = (async () => {
    while (diedAt === null) {
      if (!sameProcess(victim.pid, ticks)) diedAt = Date.now();
      else if (Date.now() - startedAt > 30_000) return;
      await delay(25);
    }
  })();
  const result = await Promise.race([stopped.exited, delay(45_000).then(() => null)]);
  await watcher;
  const elapsed = Date.now() - startedAt;

  assert.notEqual(result, null, 'stop must return while the invocation is being escalated');
  assert.equal(result.status, 0, `stop must succeed via escalation; stderr: ${result.stderr}`);
  assert.match(result.stdout, /stopped agent 7e40/);
  assert.notEqual(diedAt, null, 'the invocation must actually be gone, not merely reported gone');
  // The SIGKILL landed inside stop's own post-escalation window, and it could
  // only have come from stop: the whole grace period elapsed first (SIGTERM was
  // ignored throughout it, and no runner existed to escalate on its own), and
  // the kill landed with a second to spare before the 5s post-escalation wait
  // expired.
  assert.ok(
    diedAt - startedAt >= 10_000,
    `stop must wait out the SIGTERM grace period before escalating; killed after ${diedAt - startedAt}ms`,
  );
  assert.ok(
    diedAt - startedAt <= 14_000,
    `the escalation must land inside stop's post-escalation window, not at its deadline; killed after ${diedAt - startedAt}ms`,
  );
  assert.ok(elapsed < 15_000, `stop must not spend its full post-escalation window; took ${elapsed}ms`);
  assert.equal(
    procStartTicks(victim.pid),
    null,
    'the invocation must be gone once stop reports success, escalation or not',
  );
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'stopped');
});

// The mirror invariant: when even SIGKILL does not make the invocation go away,
// stop must fail closed rather than record a stop that never happened. The
// target is a real live process (real PID, real start ticks, real env markers)
// whose recorded *group* does not exist, so the group signal is a no-op and the
// process cannot be reaped. Liveness is decided on PID plus start ticks, never
// on a process name.
test('stop refuses to report success when the invocation cannot be terminated', async (t) => {
  if (!existsSync('/proc/self/stat')) {
    t.skip('/proc is unavailable on this host: liveness cannot be decided on PID plus start ticks');
    return;
  }
  const handle = fixture(t);
  const { root, work, env } = handle;
  assert.equal(run(['agent', 'new', '--id', '7e41', '--cwd', work], env).status, 0);

  const invocationId = 'c'.repeat(32);
  // A live, harmless bystander that carries the markers the runtime uses to
  // confirm ownership, and that the test reaps itself.
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    env: { ...env, ANTONINA_AGENT_ID: '7e41', ANTONINA_INVOCATION_ID: invocationId },
    stdio: 'ignore',
  });
  const reaped = new Promise((resolve) => victim.on('close', () => resolve()));
  t.after(async () => {
    try { victim.kill('SIGKILL'); } catch {}
    await reaped;
  });

  const ticks = procStartTicks(victim.pid);
  assert.equal(typeof ticks, 'number', 'the bystander must be alive with real start ticks');

  const path = metaPath(root, '7e41');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: false,
    pending_prompt: null,
    runner_reservation: null,
    pid: victim.pid,
    // No such process group: the escalation signal is a no-op, so the
    // invocation stays alive through SIGTERM and SIGKILL alike.
    pgid: 99999999,
    start_time: ticks,
    invocation_id: invocationId,
    started_at: 1,
  });
  writeFileSync(path, JSON.stringify(meta));

  // stop waits 10s for a polite death and 5s more after escalating.
  const stopped = spawnSync(process.execPath, [CLI, 'agent', 'stop', '--id', '7e41'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(
    stopped.status,
    1,
    `stop must fail closed when the invocation survives escalation; stderr: ${stopped.stderr}`,
  );
  assert.match(stopped.stderr, /did not terminate/);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.notEqual(
    after.state,
    'stopped',
    'a stop that never terminated the invocation must not be recorded as stopped',
  );
  victim.kill('SIGKILL');
  await reaped;
});

// ---------------------------------------------------------------- GAP-CLI-4
// The invariant, in one sentence: `agent new` refuses a --cwd that is not an
// existing directory, and it refuses it *before* creating any state, so a typo
// cannot leave a half-built agent on disk.
test('new refuses a --cwd that is not an existing directory and creates no state', (t) => {
  const { root, work, env } = fixture(t);
  const missing = join(root, 'no-such-directory');
  const result = run(['agent', 'new', '--id', '4ec1', '--cwd', missing], env);
  assert.equal(result.status, 1, `expected a refusal, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /working directory does not exist/);
  assert.equal(existsSync(missing), false, 'the refused working directory must not be created');
  assert.equal(
    existsSync(join(root, 'state', 'antonina', 'agents', '4ec1')),
    false,
    'a refused new must not leave an agent directory behind',
  );

  // A path that exists but is a regular file is the other half of the same
  // guard: isDirectory must be consulted, not just existence.
  const file = join(work, 'not-a-directory');
  writeFileSync(file, 'regular file\n');
  const asFile = run(['agent', 'new', '--id', '4ec2', '--cwd', file], env);
  assert.equal(asFile.status, 1, `expected a refusal, got: ${asFile.stdout}${asFile.stderr}`);
  assert.match(asFile.stderr, /working directory does not exist/);
  assert.equal(
    existsSync(join(root, 'state', 'antonina', 'agents', '4ec2')),
    false,
    'a refused new must not leave an agent directory behind',
  );

  // The positive direction, so the guard cannot be satisfied by refusing every
  // --cwd: a real existing directory is still accepted.
  const accepted = run(['agent', 'new', '--id', '4ec3', '--cwd', work, '--json'], env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).cwd, work);
  assert.equal(existsSync(join(root, 'state', 'antonina', 'agents', '4ec3', 'meta.json')), true);
});
