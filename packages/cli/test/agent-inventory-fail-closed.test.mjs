// Board issue 198 R2: `agentIds` swallowed an unreadable managed-agent state
// root and reported it as an empty inventory.
//
// Measured on a518fb86 by execution, in a throwaway XDG world and never
// against the operator's real state root. Three distinct failures of the
// `readdir` of the agents state root, and for each the observed result:
//
//   | state root                          | stdout          | stderr | exit |
//   |-------------------------------------|-----------------|--------|------|
//   | `agents/` absent                    | `(no agents)`   | empty  | 0    |
//   | `agents` a regular file             | `(no agents)`   | empty  | 0    |
//   | `agents/` mode 000                  | `(no agents)`   | empty  | 0    |
//
//   `agent list --page 1 --json` printed `{"agents":[],"unreadable":[]}` and
//   `agent clean --dry-run --days 1` printed nothing, both exit 0. An
//   orchestrator polling the inventory was told, confidently and
//   successfully, that the machine has no managed agents.
//
// The cause is `agentIds` in packages/cli/src/agent.ts: a bare
// `catch { return []; }` around the enumeration. a518fb86 isolated each
// *record's* read inside the sweep and kept naming what it could not read; it
// left the root of the sweep itself answerable from nothing. Per-record
// isolation makes a sweep robust. It cannot make a sweep that never ran report
// an answer.
//
// What these tests pin:
//
//   1. A state root that cannot be read is refused: exit 1, the path and the
//      OS errno named on stderr, and *no inventory on stdout at all* -- not in
//      the human table and not in `--json`. A machine reader must see a failed
//      command, not an empty array it would have to guess about.
//   2. `clean` refuses too, and deletes nothing. The enumeration is the first
//      statement of the sweep, so the refusal arrives before any removal; the
//      non-vacuous form of that is an expired, deletion-eligible agent that
//      survives a refused sweep.
//   3. An inventory that *was* read is still served: a readable `agents/`
//      holding no agent directories still prints `(no agents)` and exits 0.
//      This is the control that keeps the refusal from degenerating into "the
//      sweep always fails", and it is the case that distinguishes a read
//      refusal from a proven-empty inventory.
//   4. Every command acting on ONE named agent still fails closed with its own
//      validator's reason -- the root-sweep refusal is not allowed to leak into
//      them, and they are not loosened because the sweep got stricter.
//
// Every test replaces BOTH Antonina XDG roots and launches no backend.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const EXIT_OK = 0;
const EXIT_ERROR = 1;

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-198r2-inventory-'));
  // One hook, so the per-test permission restores below are guaranteed to run
  // before the removal: a fixture that leaves a directory mode 000 would
  // otherwise fail the cleanup itself rather than the assertion.
  const restored = [];
  t.after(() => {
    for (const dir of restored.reverse()) chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  return { root, env, denyReaddir: (dir) => { restored.push(dir); chmodSync(dir, 0o000); } };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

function agentsPath(root) {
  return join(root, 'state', 'antonina', 'agents');
}

/**
 * A deletion-eligible record: stopped long ago, no active runner, no pending
 * prompt, so `clean` really would remove it if the sweep ran. Written by hand
 * as a version-4 record, the shape this build writes.
 */
function writeExpired(root, id) {
  const dir = join(agentsPath(root), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
    id,
    created_at: 1,
    last_activity_at: 1,
    state: 'stopped',
    cwd: null,
    title: null,
    variant: 'low',
    native_session_id: null,
    pid: null,
    pgid: null,
    start_time: null,
    invocation_id: null,
    runner_pid: null,
    runner_start_time: null,
    started_at: null,
    finished_at: 1,
    exit_code: 0,
    exit_signal: null,
    backend_error: null,
    intent: null,
    delete_pending: false,
    stop_reason: null,
    active_runner: false,
    runner_gen: 0,
    runner_reservation: null,
    steer_queue: [],
    steer_seq: 0,
    prompt_count: 0,
    pending_prompt: null,
    last_prompt: null,
    error: null,
    agent_version: 4,
  }, null, 2)}\n`);
}

/**
 * Assert the refusal, for both commands and both output shapes. The three
 * properties are what makes this non-vacuous: a non-zero exit, the reason on
 * stderr, and *nothing* on stdout -- an inventory reported by a run that could
 * not read one is the defect, whatever its exit code.
 */
function assertRefused(result, command, expectedErrno, root, label) {
  assert.equal(
    result.status,
    EXIT_ERROR,
    `${label}: ${command} must refuse, not report an inventory: ${result.stdout}${result.stderr}`,
  );
  assert.match(result.stderr, new RegExp(`${command}: refused to read the managed-agent state root`));
  assert.match(result.stderr, new RegExp(expectedErrno));
  assert.ok(
    result.stderr.includes(agentsPath(root)),
    `${label}: the refusal must name the path it could not read: ${result.stderr}`,
  );
  assert.doesNotMatch(result.stdout, /\(no agents\)/, `${label}: ${command} must not print an empty inventory`);
  assert.equal(result.stdout.trim(), '', `${label}: ${command} must write no inventory to stdout: ${result.stdout}`);
}

test('an absent state root is refused, not reported as an empty inventory', (t) => {
  const { root, env } = world(t);
  // No `state/antonina/agents` at all: nothing has ever been created here.
  assert.ok(!existsSync(agentsPath(root)));

  assertRefused(run(['agent', 'list', '--page', '1'], env), 'list', 'ENOENT', root, 'absent root');
  assertRefused(run(['agent', 'list', '--page', '1', '--json'], env), 'list', 'ENOENT', root, 'absent root, --json');
  assertRefused(run(['agent', 'clean', '--dry-run', '--days', '1'], env), 'clean', 'ENOENT', root, 'absent root');
});

test('a state root that is not a directory is refused', (t) => {
  const { root, env } = world(t);
  mkdirSync(join(root, 'state', 'antonina'), { recursive: true });
  writeFileSync(agentsPath(root), 'not a directory\n');

  assertRefused(run(['agent', 'list', '--page', '1'], env), 'list', 'ENOTDIR', root, 'root is a file');
  assertRefused(run(['agent', 'list', '--page', '1', '--json'], env), 'list', 'ENOTDIR', root, 'root is a file, --json');
  assertRefused(run(['agent', 'clean', '--days', '1'], env), 'clean', 'ENOTDIR', root, 'root is a file');
});

test('a state root whose readdir is denied is refused, and clean deletes nothing', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.diagnostic('running as root: a mode-000 directory is still readable, so EACCES cannot be produced here');
    t.skip('cannot deny readdir to uid 0');
  }
  const { root, env, denyReaddir } = world(t);
  writeExpired(root, 'aaa1');
  const dir = agentsPath(root);
  denyReaddir(dir);
  assert.throws(() => readdirSync(dir), 'fixture precondition: readdir must be denied');

  assertRefused(run(['agent', 'list', '--page', '1'], env), 'list', 'EACCES', root, 'denied readdir');
  assertRefused(run(['agent', 'list', '--page', '1', '--json'], env), 'list', 'EACCES', root, 'denied readdir, --json');

  const cleaned = run(['agent', 'clean', '--days', '1'], env);
  assertRefused(cleaned, 'clean', 'EACCES', root, 'denied readdir');
  assert.doesNotMatch(cleaned.stdout, /deleted agent/);
  // The load-bearing assertion: an expired, deletion-eligible record is still
  // there afterwards. A sweep that could not read its inventory must not have
  // deleted anything on the strength of that. The mode is restored first, so
  // this observes the filesystem rather than this test's own denial.
  chmodSync(dir, 0o755);
  assert.ok(
    existsSync(join(agentsPath(root), 'aaa1', 'meta.json')),
    'a refused sweep must not delete a deletion-eligible record',
  );
});

test('an inventory that was read is still served: an empty root lists empty', (t) => {
  const { root, env } = world(t);
  mkdirSync(agentsPath(root), { recursive: true });

  const listed = run(['agent', 'list', '--page', '1'], env);
  assert.equal(listed.status, EXIT_OK, `a readable empty root must still serve the sweep: ${listed.stdout}${listed.stderr}`);
  assert.match(listed.stdout, /\(no agents\)/);
  assert.equal(listed.stderr, '');

  const json = run(['agent', 'list', '--page', '1', '--json'], env);
  assert.equal(json.status, EXIT_OK, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { agents: [], unreadable: [] });

  // A sweep with nothing to delete exits 0 and deletes nothing.
  const cleaned = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(cleaned.status, EXIT_OK, cleaned.stderr);
  assert.equal(cleaned.stdout.trim(), '');
});

test('a readable root still sweeps its expired record (the refusal did not break retention)', (t) => {
  const { root, env } = world(t);
  writeExpired(root, 'aaa1');

  const dry = run(['agent', 'clean', '--dry-run', '--days', '1'], env);
  assert.equal(dry.status, EXIT_OK, dry.stderr);
  assert.match(dry.stdout, /^aaa1$/m);
  assert.ok(existsSync(join(agentsPath(root), 'aaa1', 'meta.json')), '--dry-run must not delete');

  const cleaned = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(cleaned.status, EXIT_OK, cleaned.stderr);
  assert.match(cleaned.stdout, /^deleted agent aaa1$/m);
  assert.ok(!existsSync(join(agentsPath(root), 'aaa1')), 'the expired record must go');
});

test('commands acting on one named agent keep their own validator reason', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.diagnostic('running as root: a mode-000 directory is still readable, so EACCES cannot be produced here');
    t.skip('cannot deny readdir to uid 0');
  }
  const { root, env, denyReaddir } = world(t);
  writeExpired(root, 'aaa1');
  denyReaddir(agentsPath(root));

  for (const args of [
    ['agent', 'status', '--id', 'aaa1', '--json'],
    ['agent', 'log', '--id', 'aaa1'],
    ['agent', 'wait', '--id', 'aaa1', '--timeout', '1'],
    ['agent', 'stop', '--id', 'aaa1'],
    ['agent', 'kill', '--id', 'aaa1'],
    ['agent', 'delete', '--id', 'aaa1'],
    ['agent', 'run', '--id', 'aaa1', '--prompt', 'x', '--detach'],
  ]) {
    const result = run(args, env);
    assert.equal(
      result.status,
      EXIT_ERROR,
      `${args.join(' ')} must still fail closed: ${result.stdout}${result.stderr}`,
    );
    // The per-agent validator's own reason, not the root-sweep refusal: the
    // stricter sweep must not have become the explanation a single-agent
    // command gives.
    assert.match(result.stderr, /failed to read metadata for agent aaa1/, args.join(' '));
    assert.doesNotMatch(result.stderr, /refused to read the managed-agent state root/, args.join(' '));
  }
});

function readdirProbe(dir) {
  // eslint-disable-next-line no-undef
  return require('node:fs').readdirSync(dir);
}