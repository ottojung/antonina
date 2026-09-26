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
// checkout (where the exec-probing fixture cannot be built).
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

function newAgent(t, id) {
  const { root, env } = stateDir(t);
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const created = run(['agent', 'new', '--id', id, '--cwd', work], env);
  assert.equal(created.status, 0, created.stderr);
  return { root, env, work };
}

// A terminal, long-finished agent that nonetheless still holds an accepted prompt
// and a freshly reserved runner. It is a retention candidate for the outer filter
// (terminal state, finished_at far in the past) and must be refused by the guard.
function ageAndArmOwnership(t, id) {
  const handle = newAgent(t, id);
  const path = metaPath(handle.root, id);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'succeeded',
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
      // facts, so the reservation owner check holds and `reservationInFlight`
      // is true on its own merits, with no reliance on the 5s grace window.
      owner_pid: process.pid,
      owner_start_ticks: procStartTicks(process.pid),
      reserved_at: 1,
    },
  });
  writeFileSync(path, JSON.stringify(meta));
  return { ...handle, path };
}

test('clean selects an agent that owns an accepted prompt and reserved runner', (t) => {
  const { env, path } = ageAndArmOwnership(t, '0a1b2c');
  const dry = run(['agent', 'clean', '--days', '1', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /0a1b2c/, 'the candidate filter must still select this agent');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'succeeded', 'dry-run must not mutate');
});

test('clean refuses to remove an agent holding an accepted prompt and reserved runner', (t) => {
  const { env, root, path } = ageAndArmOwnership(t, '0ceef');
  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /deleted agent 0ceef/, 'the ownership guard must refuse this removal');
  assert.ok(existsSync(agentDir(root, '0ceef')), 'the guarded agent directory must survive clean');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.pending_prompt, 'accepted', 'the accepted prompt must be preserved');
  assert.equal(after.active_runner, true, 'runner ownership must be preserved');
  assert.equal(after.runner_reservation.state, 'reserved', 'the reservation must be preserved');
  assert.equal(after.delete_pending ?? false, false, 'a refused agent must not be tombstoned');
});

test('clean still removes an unowned terminal agent alongside a guarded one', (t) => {
  const { env, root } = ageAndArmOwnership(t, '0beef1');
  assert.equal(run(['agent', 'new', '--id', '0fee7', '--cwd', join(root, 'work')], env).status, 0);
  const freeMeta = metaPath(root, '0fee7');
  const free = JSON.parse(readFileSync(freeMeta, 'utf8'));
  Object.assign(free, {
    state: 'failed',
    finished_at: 1,
    active_runner: false,
    runner_reservation: null,
    pending_prompt: null,
  });
  writeFileSync(freeMeta, JSON.stringify(free));

  const clean = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /deleted agent 0fee7/, 'an unowned old terminal agent is still collectable');
  assert.ok(existsSync(agentDir(root, '0beef1')), 'the guarded agent must survive the same run');
  assert.ok(!existsSync(agentDir(root, '0fee7')), 'the unowned agent must be removed');
});

test('clean refuses an agent whose only ownership is a live marked invocation', async (t) => {
  const { root, work, env } = newAgent(t, '0a17e');
  const invocationId = 'c'.repeat(32);
  // A real child carrying the ownership markers the runtime checks, so
  // `invocationAlive` is true on its own merits (PID + start time + env markers)
  // rather than on a stubbed seam. Reaped before this test returns.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, ANTONINA_AGENT_ID: '0a17e', ANTONINA_INVOCATION_ID: invocationId },
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

  const path = metaPath(root, '0a17e');
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
  assert.doesNotMatch(clean.stdout, /deleted agent 0a17e/, 'a live invocation must block removal');
  assert.ok(existsSync(agentDir(root, '0a17e')));
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
