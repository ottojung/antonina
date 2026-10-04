// Board issue 198: `antonina agent list` aborted on one unreadable meta.json.
//
// Measured on the operator host before the fix, in a temp-owned XDG world and
// never against the real state root: `agent list --page 1` exited 1 with
// "managed-agent metadata for <id> is incompatible or malformed: managed-agent
// metadata fields are not canonical", printing no rows at all, and
// `agent clean --dry-run` exited 1 the same way. The cause was
// `cmdList` calling `reconcileAgent` per directory with no isolation, so
// `readMeta`'s refusal -- correct, and still correct on this head -- aborted
// the sweep it was one member of.
//
// What these tests pin, and why each is here:
//
//   1. One malformed record among several readable ones must leave the
//      readable ones listed, and must be *named* rather than silently dropped.
//      Silence would be a different defect: the operator would be unable to
//      tell a deleted agent from an unreadable one.
//   2. `--json` must carry the unreadable record as data, so a machine reader
//      sees the same inventory the human sees.
//   3. Every command that acts on ONE named agent keeps its strict refusal
//      (exit 1, the validator's reason). The isolation is a property of the
//      sweep, not a weakening of validation, and this is the test that would go
//      red if someone "fixed" the list by loosening `validateAgentMetadata`.
//   4. `clean` still sweeps the readable expired record while retaining the
//      unreadable one: an unreadable record has no establishable age, so it
//      is not one the sweep may decide has expired.
//
// The unreadable fixture is built by hand, because a record this build refuses
// is exactly a record this build will not write. `invocation_cwd` is real: it
// is the board-178 field on this release line, and the value used here is the
// one that field carries when it is not an absolute path.
//
// Every test replaces BOTH Antonina XDG roots and launches no backend.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const READABLE = ['aaa1', 'bbb2', 'ccc3'];
const UNREADABLE = 'ddd4';

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-198-list-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  return { root, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

function metaPath(root, id) {
  return join(root, 'state', 'antonina', 'agents', id, 'meta.json');
}

/**
 * A version-4 record as a *previous* line wrote it: no `invocation_cwd`, which
 * is a canonical record here and a refusal on a binary that predates board 178.
 */
function record(id, overrides = {}) {
  return {
    id,
    created_at: 1,
    last_activity_at: 1,
    state: 'idle',
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
    finished_at: null,
    exit_code: null,
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
    ...overrides,
  };
}

function write(root, id, overrides) {
  const path = metaPath(root, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record(id, overrides), null, 2)}\n`);
}

// Three readable records, plus one that carries a `invocation_cwd` this build
// refuses. The two bad shapes the operator hit are both version skew: the field
// unknown to the installed binary, and a value it rejects.
function mixedWorld(t, unreadableOverrides) {
  const handle = world(t);
  for (const id of READABLE) write(handle.root, id);
  write(handle.root, UNREADABLE, unreadableOverrides);
  return handle;
}

test('one unreadable record does not empty the inventory, and it is named', (t) => {
  const { root, env } = mixedWorld(t, { invocation_cwd: 'relative/not/absolute' });

  const listed = run(['agent', 'list', '--page', '1'], env);
  assert.equal(listed.status, EXIT_OK, `expected the inventory to be served, got: ${listed.stdout}${listed.stderr}`);
  for (const id of READABLE) assert.match(listed.stdout, new RegExp(`^${id}\\b`, 'm'), `${id} must still be listed`);
  // Named, not silently dropped: the reason the validator gave is still there.
  assert.match(listed.stderr, new RegExp(`agent ${UNREADABLE} was not read and is not listed`));
  assert.match(listed.stderr, /invocation_cwd is malformed/);
  // Nothing about the unreadable record reaches stdout in the human table.
  assert.doesNotMatch(listed.stdout, new RegExp(UNREADABLE));

  const json = run(['agent', 'list', '--page', '1', '--json'], env);
  assert.equal(json.status, EXIT_OK, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.agents.map((entry) => entry.id).sort(), [...READABLE].sort());
  assert.deepEqual(payload.unreadable.map((entry) => entry.id), [UNREADABLE]);
  assert.match(payload.unreadable[0].reason, /incompatible or malformed/);
});

test('a record carrying a field this build does not know is also isolated, not fatal', (t) => {
  // The operator's exact shape: `invocation_cwd` is canonical on this release
  // line (board 178, `OPTIONAL_TOP_LEVEL_FIELDS` in
  // packages/agent-runtime/src/metadata.ts) and unknown to the older installed
  // binary. Here the value is well formed and the record is listed; what the
  // installed 0.1.2 does with it is board-198 diagnosis, not this test's claim.
  const { env } = mixedWorld(t, { invocation_cwd: '/tmp' });
  const listed = run(['agent', 'list', '--page', '1', '--json'], env);
  assert.equal(listed.status, EXIT_OK, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).unreadable.length, 0);
});

test('commands acting on one named agent keep the strict refusal', (t) => {
  const { env } = mixedWorld(t, { invocation_cwd: 'relative/not/absolute' });

  for (const args of [
    ['agent', 'status', '--id', UNREADABLE, '--json'],
    ['agent', 'stop', '--id', UNREADABLE],
    ['agent', 'kill', '--id', UNREADABLE],
    ['agent', 'delete', '--id', UNREADABLE],
    ['agent', 'run', '--id', UNREADABLE, '--prompt', 'x', '--detach'],
  ]) {
    const result = run(args, env);
    assert.equal(result.status, EXIT_ERROR, `${args.join(' ')} must still fail closed: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /invocation_cwd is malformed/);
  }

  // And a healthy agent is still fully controllable through the same surface.
  assert.equal(run(['agent', 'status', '--id', 'aaa1', '--json'], env).status, EXIT_OK);
});

test('clean sweeps the readable expired record and retains the unreadable one', (t) => {
  const { root, env } = mixedWorld(t, { invocation_cwd: 'relative/not/absolute' });
  // aaa1 finished long ago and is a legitimate retention candidate.
  write(root, 'aaa1', { state: 'stopped', finished_at: 1 });

  const dry = run(['agent', 'clean', '--dry-run', '--days', '1'], env);
  assert.equal(dry.status, EXIT_OK, `expected the sweep to run, got: ${dry.stdout}${dry.stderr}`);
  assert.match(dry.stdout, /^aaa1$/m);
  assert.doesNotMatch(dry.stdout, new RegExp(UNREADABLE));
  assert.match(dry.stderr, new RegExp(`agent ${UNREADABLE} was not read and was retained`));
  assert.ok(existsSync(metaPath(root, 'aaa1')), '--dry-run must not delete');

  const cleaned = run(['agent', 'clean', '--days', '1'], env);
  assert.equal(cleaned.status, EXIT_OK, `${cleaned.stdout}${cleaned.stderr}`);
  assert.ok(!existsSync(join(root, 'state', 'antonina', 'agents', 'aaa1')), 'the expired readable record must go');
  assert.ok(
    existsSync(metaPath(root, UNREADABLE)),
    'a record with no establishable age must be retained, not deleted',
  );
  // Untouched, byte for byte: retention withheld means the record is left alone.
  assert.match(readFileSync(metaPath(root, UNREADABLE), 'utf8'), /relative\/not\/absolute/);
});