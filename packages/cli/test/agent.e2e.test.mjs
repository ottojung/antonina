import assert from 'node:assert/strict';
import {
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
import { spawnSync } from 'node:child_process';
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

test('fixture guard: a non-exec-able fixture location is a named failure, never a substitution', () => {
  assert.throws(
    () => selectExecRoot('antonina-cli-e2e-', ['/tmp', '/workspace'], () => ({ ok: false, reason: 'EACCES' })),
    (error) => {
      assert.equal(error.code, 'ANTONINA_FIXTURE_NOEXEC');
      assert.match(error.message, /no exec-capable fixture directory/);
      assert.match(error.message, /\/tmp: EACCES/);
      assert.match(error.message, /\/workspace: EACCES/);
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
