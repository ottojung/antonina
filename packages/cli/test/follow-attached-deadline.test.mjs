import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

// Board issue 114: `followAttached` (packages/cli/src/agent.ts) is the attached
// (non-detached) `antonina agent run` observer. It is a read-only observer, and
// it must still be a bounded one.
//
// The contract, in one sentence: a foreground `agent run` always terminates --
// with `exitCodeFor(meta)` when the agent finishes, with EXIT_NOT_FOUND (3) when
// the agent disappears, or with EXIT_TIMEOUT (124) once the attached-follow
// budget expires -- and the timeout path only reports, never signals.
//
// This file covers the four cases the issue enumerates:
//   1. a wedged agent driven to the deadline (124, and a diagnostic that names
//      the state the agent was actually in),
//   2. a healthy agent that finishes inside the budget (unchanged 0),
//   3. the EXIT_NOT_FOUND path (unchanged 3),
//   4. the timeout as a pure observer: no metadata write, no `active_runner`
//      clear, no signal to a live runner, and stop/kill/delete still coherent.
//
// Everything here is test-owned: XDG_STATE_HOME and XDG_CONFIG_HOME are both
// temporary directories, so no test can read or write the operator's
// trust.json/credential.json or touch ambient Antonina state. Every spawned
// process is reaped before its test returns, and every test carries an explicit
// timeout: `node --test` has no default one, so a hang here is a 6-hour CI job.
const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

// A wedged agent must be able to still be wedged when the follow budget
// expires, but never for longer than the budget needs. 60s is far longer than
// any budget used below; reaping is the test's job, not the sleep's.
const WEDGE_SECONDS = 60;
const TEST_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 60_000;

function harness(t, id) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-follow-deadline-'));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    ANTONINA_OPENCODE_BIN: join(root, 'bin', 'opencode'),
  };
  const work = join(root, 'work');
  mkdirSync(env.ANTONINA_OPENCODE_BIN.replace(/\/opencode$/, ''), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, 'config', 'antonina'), { recursive: true });
  // A backend that answers, reports a model, and -- for the prompt text
  // `wedge` -- never returns. It is a shell script, so `sleep` is a child of
  // the invocation group and dies with the group signal.
  writeFileSync(env.ANTONINA_OPENCODE_BIN, `#!/bin/sh
case "$1" in
  models) echo "opencode/space-bunny-free"; exit 0 ;;
  session) echo '[{"id":"ses_follow","title":"antonina-${id}","created":100}]'; exit 0 ;;
  run)
    last=""
    for arg in "$@"; do last="$arg"; done
    echo "wedged:$last"
    if [ "$last" = "wedge" ]; then sleep ${WEDGE_SECONDS}; exit 0; fi
    echo "FAKE:$last"
    exit 0
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env, work, id, metaPath: join(root, 'state', 'antonina', 'agents', id, 'meta.json') };
}

function run(args, env, timeout = RUN_TIMEOUT_MS) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout });
}

function readMeta(handle) {
  return JSON.parse(readFileSync(handle.metaPath, 'utf8'));
}

function create(handle) {
  const created = run(['agent', 'new', '--id', handle.id, '--cwd', handle.work], handle.env);
  assert.equal(created.status, 0, created.stderr);
}

function procStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(after[19]);
}

function pidPresent(pid) {
  try {
    return existsSync(`/proc/${pid}/stat`);
  } catch {
    return false;
  }
}

async function waitForGone(pid) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!pidPresent(pid)) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return !pidPresent(pid);
}

async function waitForRunning(handle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const meta = readMeta(handle);
      if (meta.state === 'running' && typeof meta.pid === 'number' && typeof meta.runner_pid === 'number') return meta;
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`agent ${handle.id} never reached the running state`);
}

// The runner is detached from every test here, so the test reaps it whether or
// not the command under test did. Group signal first (the invocation is a
// group leader), then the bare pid, then wait for the /proc entry to go.
function reaper(handle) {
  let pids = [];
  try {
    const meta = readMeta(handle);
    pids = [meta.pid, meta.runner_pid].filter((pid) => typeof pid === 'number' && pid > 1);
  } catch {}
  return async () => {
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    for (const pid of pids) await waitForGone(pid);
    // A `sh` fixture child (its `sleep`) is in the invocation group, so the
    // group signal above normally reaps it; this is the belt-and-braces pass
    // for anything that survived the group.
    try {
      run(['agent', 'kill', '--id', handle.id], handle.env, 20_000);
    } catch {}
  };
}

test('a wedged agent run exits with the distinct timeout code and a diagnostic naming the real state', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const handle = harness(t, '1111');
  create(handle);
  t.after(reaper(handle));

  const started = Date.now();
  const followed = run(['agent', 'run', '--id', handle.id, '--prompt', 'wedge', '--follow-timeout', '2'], handle.env);
  const elapsed = Date.now() - started;

  assert.equal(followed.status, 124, followed.stderr);
  assert.notEqual(followed.status, 1, 'the timeout must be distinguishable from the generic failure code');
  assert.notEqual(followed.status, 0, 'a wedged agent must not report success');
  // The observer returned because of its own budget, not because the agent
  // finished. Two seconds of budget may not elapse into minutes.
  assert.ok(elapsed < 30_000, `the follow budget was not enforced (took ${elapsed}ms)`);
  // The diagnostic must name the state the agent was actually in, so an
  // operator can tell a slow run from a wedged one, and it must say the agent
  // was left alone.
  assert.match(
    followed.stderr,
    /antonina: run: agent 1111 did not finish within 2s \(state running, runner active, prompts 1\)/,
    followed.stderr,
  );
  assert.match(followed.stderr, /left untouched/, followed.stderr);
  assert.match(followed.stderr, /agent log --id 1111 --follow/, followed.stderr);
  // The already-produced output is still streamed before the deadline.
  assert.match(followed.stdout, /wedged:wedge/);

  const meta = readMeta(handle);
  assert.equal(meta.state, 'running', 'the observer must not have terminated the agent');
  assert.equal(meta.active_runner, true, 'the observer must not have cleared the runner flag');
  assert.equal(meta.prompt_count, 1);
});

test('a healthy agent that finishes inside the budget is unaffected', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const handle = harness(t, '2222');
  create(handle);
  t.after(reaper(handle));

  const followed = run(
    ['agent', 'run', '--id', handle.id, '--prompt', 'quick', '--follow-timeout', '60'],
    handle.env,
  );
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(followed.status, 0, 'a successful agent must still report exitCodeFor(meta) === 0');
  assert.match(followed.stdout, /FAKE:quick/);
  const meta = readMeta(handle);
  assert.equal(meta.state, 'succeeded');
  assert.equal(meta.active_runner, false);
});

test('the EXIT_NOT_FOUND path is unchanged: the agent disappearing mid-follow exits 3, not 124', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const handle = harness(t, '3333');
  create(handle);
  t.after(reaper(handle));

  // A wedged agent so the follow is guaranteed to be still polling when the
  // agent directory is removed underneath it.
  const started = run(['agent', 'run', '--id', handle.id, '--prompt', 'wedge', '--detach'], handle.env);
  assert.equal(started.status, 0, started.stderr);
  const live = await waitForRunning(handle);
  const invocationPid = live.pid;
  const runnerPid = live.runner_pid;

  // Delete the agent out from under the observer. `delete --force` reaps the
  // runner and removes the directory, so the follower's next readMeta is null.
  const followed = spawn(
    process.execPath,
    [CLI, 'agent', 'run', '--id', handle.id, '--prompt', 'wedge', '--steer', '--follow-timeout', '45'],
    { env: handle.env, stdio: 'ignore', detached: true },
  );
  followed.unref();
  const exited = new Promise((resolve) => followed.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    try { process.kill(-followed.pid, 'SIGKILL'); } catch {}
    try { process.kill(followed.pid, 'SIGKILL'); } catch {}
    for (const pid of [invocationPid, runnerPid]) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForGone(pid);
    }
  });
  // Give the follower time to enter its poll loop before the agent vanishes.
  await new Promise((done) => setTimeout(done, 2_000));

  const deleted = run(['agent', 'delete', '--id', handle.id, '--force'], handle.env);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(existsSync(handle.metaPath), false, 'delete --force must have removed the agent directory');

  // The agent vanished, so the observer must take its EXIT_NOT_FOUND path (3)
  // -- not the deadline path, even though the 45s budget has not expired.
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'still-running', signal: null }), 20_000)),
  ]);
  assert.notEqual(result.code, 'still-running', 'the follower did not terminate after the agent was deleted');
  assert.equal(result.code, 3, `the follower's exit code changed on the EXIT_NOT_FOUND path: ${JSON.stringify(result)}`);
  assert.equal(result.signal, null, 'the follower must exit normally, not by a signal');
});

test('the timeout is a pure observer: no metadata write, no runner signal, and stop/kill/delete stay coherent', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const handle = harness(t, '4444');
  create(handle);
  t.after(reaper(handle));

  const before = run(['agent', 'run', '--id', handle.id, '--prompt', 'wedge', '--follow-timeout', '2'], handle.env);
  assert.equal(before.status, 124, before.stderr);
  const afterTimeout = readMeta(handle);
  const live = await waitForRunning(handle);

  // The observer wrote nothing: the run it was following is still the one it
  // accepted, and no stop/kill/delete field was set.
  assert.equal(afterTimeout.prompt_count, 1);
  assert.equal(afterTimeout.last_prompt, 'wedge');
  assert.equal(afterTimeout.state, 'running');
  assert.equal(afterTimeout.active_runner, true, 'the timeout must not clear the runner flag');
  assert.equal(afterTimeout.stop_reason ?? null, null, 'the timeout must not record a stop reason');
  assert.equal(afterTimeout.exit_code ?? null, null, 'the timeout must not record an exit code');

  // The runner is still alive, still owns the same process identity, and was
  // not signalled: same PID, same /proc start ticks, and its invocation group
  // is intact.
  assert.equal(afterTimeout.runner_pid, live.runner_pid);
  assert.equal(procStartTicks(live.runner_pid), afterTimeout.runner_start_time);
  assert.equal(procStartTicks(live.pid), afterTimeout.start_time);
  assert.equal(pidPresent(live.runner_pid), true, 'the timeout must not have killed the runner');
  assert.equal(pidPresent(live.pid), true, 'the timeout must not have signalled the invocation');

  // kill/stop/delete remain coherent on an agent a timed-out observer walked
  // away from: the durable authority is exactly what the runner still holds.
  // `kill` first, while the runner and its invocation are still live -- that is
  // the path that must still own a real process and reach a real terminal
  // state, which it could not if the timeout had disturbed the authority.
  const killed = run(['agent', 'kill', '--id', handle.id], handle.env, 30_000);
  assert.equal(killed.status, 0, killed.stderr);
  const afterKill = readMeta(handle);
  assert.equal(afterKill.state, 'killed');
  assert.equal(afterKill.active_runner, false);
  assert.equal(afterKill.stop_reason, 'kill');
  // The runner polls its own metadata, so it exits shortly after the kill
  // rather than synchronously; convergence, not instant reaping, is the claim.
  assert.equal(await waitForGone(live.runner_pid), true, 'kill must have reaped the runner');

  // `stop` on the now-terminal agent is the already-stopped no-op path, and
  // must not rewrite the terminal state `kill` recorded.
  const stopped = run(['agent', 'stop', '--id', handle.id], handle.env, 30_000);
  assert.equal(stopped.status, 0, stopped.stderr);
  const afterStop = readMeta(handle);
  assert.equal(afterStop.state, 'killed');
  assert.equal(afterStop.stop_reason, 'kill');

  const deleted = run(['agent', 'delete', '--id', handle.id, '--force'], handle.env, 30_000);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(existsSync(handle.metaPath), false);
});
