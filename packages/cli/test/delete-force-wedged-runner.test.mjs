import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

// The second runner-reaping guard in cmdDelete (packages/cli/src/agent.ts:758-763).
//
// The contract, in one sentence: when `delete --force` removes an agent whose
// OpenCode invocation is already gone but whose runner process is still alive,
// the runner must be reaped before the agent directory is removed -- including
// by the explicit SIGKILL fallback, not only by the runner noticing the kill
// intent and exiting on its own.
//
// Why this is a distinct case from the e2e suite's `delete --force` tests: a real
// runner polls its metadata every 200ms, sees the `kill` intent and terminates
// itself, so the fallback at agent.ts:760 is never the thing that reaps it. Here
// the runner is a real, marked, live process that does not run that poll loop
// (it is a plain node process carrying only ANTONINA_AGENT_ID), so the invocation
// group signal cannot reach it and nothing else would ever kill it. The first
// waitForRunnerGone therefore times out after its full 2s and the SIGKILL
// fallback is load-bearing: the delete must take at least two seconds, and the
// runner PID must be gone when it returns.
//
// The sibling throw at agent.ts:762 -- the "did not terminate" backstop -- is not
// pinned by this file and cannot be: reaching it requires a process that both
// passes the identity probe (PID + /proc start ticks + env marker) and survives a
// delivered SIGKILL for two seconds. See the note at the bottom of this file.
const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

const AGENT_ID = '0c0de1';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-delete-force-runner-'));
  // Both homes are test-owned: nothing here can read or write the operator's
  // trust.json or credential.json, and no ambient Antonina state is touched.
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, 'config', 'antonina'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = spawnSync(process.execPath, [CLI, 'agent', 'new', '--id', AGENT_ID, '--cwd', work], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(created.status, 0, created.stderr);
  return { root, env, work, metaPath: join(root, 'state', 'antonina', 'agents', AGENT_ID, 'meta.json') };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30_000 });
}

// Liveness is decided on PID + /proc start ticks, never on a process name.
function procStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(after[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

function pidPresent(pid) {
  try {
    return existsSync(`/proc/${pid}/stat`);
  } catch {
    return false;
  }
}

// /proc must be readable for this file to mean anything; say so out loud rather
// than silently passing if this host does not expose it.
async function waitForIdentity(t, pid) {
  if (!existsSync('/proc/self/stat')) {
    t.skip('this host does not expose /proc, so PID + start-tick identity cannot be established');
    return null;
  }
  for (let attempt = 0; attempt < 400; attempt += 1) {
    let ticks = null;
    try {
      ticks = procStartTicks(pid);
    } catch {
      ticks = null;
    }
    if (ticks !== null) return ticks;
    await new Promise((done) => setTimeout(done, 25));
  }
  t.skip(`/proc/${pid}/stat never became readable, so process identity could not be established`);
  return null;
}

async function waitForGone(pid) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!pidPresent(pid)) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return !pidPresent(pid);
}

test('delete --force SIGKILLs a runner that the invocation group signal cannot reach', async (t) => {
  const { env, root, work, metaPath } = harness(t);

  // A real, live, detached process carrying the runner's ownership marker. It is
  // in its own process group, so the SIGKILL that stopLike sends to the (here
  // absent) invocation group cannot touch it.
  const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...env, ANTONINA_AGENT_ID: AGENT_ID },
    detached: true,
    stdio: 'ignore',
  });
  runner.unref();
  t.after(async () => {
    try { process.kill(runner.pid, 'SIGKILL'); } catch {}
    await waitForGone(runner.pid);
  });

  const ticks = await waitForIdentity(t, runner.pid);
  if (ticks === null) return;
  assert.ok(pidPresent(runner.pid), 'the runner must be alive before delete runs');

  // An accepted prompt plus state running: delete must consider this agent as
  // owning work, and the invocation is recorded as already gone.
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  Object.assign(meta, {
    state: 'running',
    active_runner: true,
    runner_pid: runner.pid,
    runner_start_time: ticks,
    pid: null,
    pgid: null,
    start_time: null,
    invocation_id: null,
    pending_prompt: 'make the runner survive its invocation',
    runner_reservation: null,
    cwd: work,
  });
  writeFileSync(metaPath, JSON.stringify(meta));

  const startedAt = Date.now();
  const forced = run(['agent', 'delete', '--id', AGENT_ID, '--force'], env);
  const elapsed = Date.now() - startedAt;

  assert.equal(forced.status, 0, forced.stderr);
  assert.doesNotMatch(forced.stderr, /did not terminate/, 'the fallback SIGKILL must reap the runner');
  assert.match(forced.stdout, new RegExp(`deleted agent ${AGENT_ID}`));
  assert.ok(
    elapsed >= 2_000,
    `the first runner wait must have timed out before the fallback SIGKILL (took ${elapsed}ms); ` +
      'if it did not, this file is not exercising the fallback at all',
  );
  assert.ok(
    await waitForGone(runner.pid),
    `runner ${runner.pid} must be reaped before delete --force returns`,
  );
  assert.ok(!existsSync(join(root, 'state', 'antonina', 'agents', AGENT_ID)));
});

// Why the throw at agent.ts:762 has no test and cannot get one here:
//
//   * runnerAlive() and signalRunner() share identityMatches()
//     (packages/agent-runtime/src/process.ts:148-152, reached from
//     lifecycle.ts:63-66 and :272-280), and isIdentityAlive() only reports alive
//     after process.kill(pid, 0) has already succeeded. So whenever the second
//     waitForRunnerGone can report a survivor, the SIGKILL was permitted and was
//     actually sent to that exact PID.
//   * Only writers of runner_pid/runner_start_time are claimRunner() and
//     recordSpawned() (packages/agent-runtime/src/runner.ts:96-97, :164-165),
//     and both bail out when delete_pending !== false -- which cmdDelete has
//     already persisted at agent.ts:746-751 before either wait. So the identity
//     signalled is the identity observed, and no replacement runner can appear
//     between the two waits.
//   * An exited-but-unreaped runner cannot hold the guard open: a zombie has an
//     empty /proc/<pid>/environ, so envHasAgentMarker() is false for it.
//   * What remains is a process the kernel refuses to kill (uninterruptible
//     sleep). That is precisely the fail-closed condition the throw exists for,
//     and it is not reproducible from a test without wedging kernel I/O.
