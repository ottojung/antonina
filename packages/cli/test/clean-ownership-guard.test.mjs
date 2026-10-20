import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

// Ownership guard for `antonina agent clean` (packages/cli/src/agent.ts, cmdClean,
// the updateMeta re-check block). The contract, in one sentence: before removing a
// retention-selected agent directory, `clean` must re-read the durable record under
// the atomic update and refuse to remove it unless the agent owns no work at all —
// no live invocation, no active runner, no in-flight reservation, no accepted
// pending prompt, no deletion tombstone, still terminal and still past the cutoff.
//
// This file is deliberately disjoint from agent.e2e.test.mjs and needs no fake
// backend: `new`, `clean --dry-run` and `clean` never invoke OpenCode, so this seam
// is exercised on a plain temp XDG_STATE_HOME and stays green even on a noexec
// checkout (where the exec-probing fixture cannot be built). Board issue 320:
// `agent new` mints its own id, captured from stdout rather than named.
const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');

function stateDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-clean-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 15_000 });
}

function agentDir(root, id) {
  return join(root, 'state', 'antonina', 'agents', id);
}

function metaPath(root, id) {
  return join(agentDir(root, id), 'meta.json');
}

function createAgent(env, args) {
  const created = run(['agent', 'new', ...args], env);
  assert.equal(created.status, 0, created.stderr);
  return created.stdout.trim();
}

function newAgent(t) {
  const { root, env } = stateDir(t);
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const id = createAgent(env, ['--cwd', work]);
  return { root, env, work, id };
}

// A terminal, long-finished agent that nonetheless still holds an accepted prompt
// and a freshly reserved runner. It is a retention candidate for the outer filter
// (terminal state, finished_at far in the past) and must be refused by the guard.
function ageAndArmOwnership(t) {
  const handle = newAgent(t);
  const path = metaPath(handle.root, handle.id);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'succeeded',
    // created_at is aged alongside finished_at (board issue 129). The retention
    // anchor is the LATER of the two, so an agent that was created seconds ago
    // and claims to have finished in 1970 is a record no writer in this
    // repository can produce, and backdating only finished_at would now make
    // these fixtures assert about an unreachable state instead of about the
    // ownership guard they exist to pin.
    created_at: 1,
    finished_at: 1,
    exit_code: 0,
    active_runner: true,
    runner_pid: null,
    runner_start_time: null,
    prompt_count: 1,
    pending_prompt: 'accepted',
    runner_gen: 1,
    runner_reservation: {
      state: 'reserved',
      gen: 1,
      mode: 'new',
      // This test process is genuinely alive and these are its real identity
      // facts, so the reservation is a well-formed one held by a real live
      // owner rather than a shape no run could ever produce. It is NOT
      // isolated ownership and this file proves nothing about the
      // `reservationOwnerAlive` rung: the fixture also sets `active_runner`,
      // and `cmdClean` tests `activeRunnerFlag(meta) !== false` before
      // `reservationInFlight(meta)`, so that term short-circuits first. The
      // rung is in fact unreachable from this guard — `reservationInFlight`
      // returns false outright when `active_runner` is false, so the only
      // fixtures that get past the earlier term are exactly the ones where the
      // reservation term is already false. See the `owned` fixture in the
      // "GAP-RT-2" test in `lifecycle.test.mjs` for the case that does pin the
      // rung's true branch.
      owner_pid: process.pid,
      owner_start_ticks: procStartTicks(process.pid),
      reserved_at: 1,
    },
  });
  writeFileSync(path, JSON.stringify(meta));
  return { ...handle, path };
}

test('clean selects an agent that owns an accepted prompt and reserved runner', (t) => {
  const { env, path, id } = ageAndArmOwnership(t);
  const dry = run(['agent', 'clean', '--days', '1', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(id), 'the candidate filter must still select this agent');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'succeeded', 'dry-run must not mutate');
});

test('clean refuses to remove an agent holding an accepted prompt and reserved runner', (t) => {
  const { env, root, path, id } = ageAndArmOwnership(t);
  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(!clean.stdout.includes(`deleted agent ${id}`), 'the ownership guard must refuse this removal');
  assert.ok(existsSync(agentDir(root, id)), 'the guarded agent directory must survive clean');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.pending_prompt, 'accepted', 'the accepted prompt must be preserved');
  assert.equal(after.active_runner, true, 'runner ownership must be preserved');
  assert.equal(after.runner_reservation.state, 'reserved', 'the reservation must be preserved');
  assert.equal(after.delete_pending ?? false, false, 'a refused agent must not be tombstoned');
});

test('clean still removes an unowned terminal agent alongside a guarded one', (t) => {
  const { env, root, id: guardedId } = ageAndArmOwnership(t);
  const freeId = createAgent(env, ['--cwd', join(root, 'work')]);
  const freeMeta = metaPath(root, freeId);
  const free = JSON.parse(readFileSync(freeMeta, 'utf8'));
  Object.assign(free, {
    state: 'failed',
    created_at: 1,
    finished_at: 1,
    active_runner: false,
    runner_reservation: null,
    pending_prompt: null,
  });
  writeFileSync(freeMeta, JSON.stringify(free));

  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(clean.stdout.includes(`deleted agent ${freeId}`), 'an unowned old terminal agent is still collectable');
  assert.ok(existsSync(agentDir(root, guardedId)), 'the guarded agent must survive the same run');
  assert.ok(!existsSync(agentDir(root, freeId)), 'the unowned agent must be removed');
});

test('clean refuses an agent whose only ownership is a live marked invocation', async (t) => {
  const { root, work, env, id } = newAgent(t);
  const invocationId = 'c'.repeat(32);
  // A real child carrying the ownership markers the runtime checks, so
  // `invocationAlive` is true on its own merits (PID + start time + env markers)
  // rather than on a stubbed seam. Reaped before this test returns.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, ANTONINA_AGENT_ID: id, ANTONINA_INVOCATION_ID: invocationId },
    detached: true,
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    child.unref();
  });
  await waitForIdentity(child.pid);

  const path = metaPath(root, id);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'succeeded',
    finished_at: 1,
    active_runner: false,
    runner_reservation: null,
    pending_prompt: null,
    pid: child.pid,
    pgid: child.pid,
    start_time: procStartTicks(child.pid),
    invocation_id: invocationId,
    cwd: work,
  });
  writeFileSync(path, JSON.stringify(meta));

  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(!clean.stdout.includes(`deleted agent ${id}`), 'a live invocation must block removal');
  assert.ok(existsSync(agentDir(root, id)));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, child.pid);
  assert.equal(child.exitCode, null, 'the child must still be alive after the refused clean');
});

// /proc entries for a freshly spawned process can lag; wait until the identity
// facts this test records are actually readable.
async function waitForIdentity(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (procStartTicks(pid) !== null) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`process ${pid} never became inspectable`);
}

function procStartTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(after[19]);
  return Number.isFinite(ticks) ? ticks : null;
}
