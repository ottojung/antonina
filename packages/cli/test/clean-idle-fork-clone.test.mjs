// Board issue 129: `antonina agent clean` cannot classify an idle forked clone
// that inherited a terminal `finished_at`.
//
// The state this file is about, measured rather than assumed (see
// /workspace/BOARD129-CLEANFIX.md): `forkMetaSnapshot` sets `clone.state =
// 'idle'` and, by design, does NOT clear the source's `finished_at`. Every other
// writer of an agent's `state` pairs it coherently -- `idleMeta` writes idle
// with a null `finished_at`, `beginInvocation` writes running with a null
// `finished_at`, `finalizeTerminal` writes a terminal state with a `finished_at`.
// So `state: 'idle'` together with a non-null `finished_at` is produced by
// exactly one writer, the fork, and only when the source had already finished.
// It is a coherent state, not a corruption: the clone is a new agent that has
// not begun its own run, and the work it inherits already finished.
//
// Before board 129 the clean predicate read "state is terminal AND finished_at
// is older than the cutoff", so that record matched neither test and was retained
// forever, invisibly. These tests drive the state through the shipped
// executable, by really forking a finished source, so the fixture cannot drift
// from what fork.ts actually writes.
//
// The retention DECISION these tests pin, not just the classification: an idle
// clone's retention clock runs from the LATER of its inherited `finished_at` and
// its own `created_at`, i.e. from when the record came into existence if that is
// later. A clone is a new durable object that an operator just asked for, and
// keying its clock on the source's outcome would let `agent clean --days 14`
// delete a fork made seconds ago from a three-month-old session -- which is data
// loss of the artifact the operator deliberately created, and the last remaining
// copy of that history if the source is later deleted. The first test pins that
// the record is now classified and swept; the second pins that it is not swept
// early; the third pins that an ordinary idle agent is still not a candidate.
//
// Every test replaces BOTH Antonina XDG roots and launches no backend: `new`,
// `clean` and `--dry-run` never invoke OpenCode.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = resolve('packages/cli/dist/packages/cli/src/main.js');
const EXIT_OK = 0;

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-clean-clone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  return { root, env, work };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

function agentDir(root, id) {
  return join(root, 'state', 'antonina', 'agents', id);
}

function metaPath(root, id) {
  return join(agentDir(root, id), 'meta.json');
}

function readMeta(root, id) {
  return JSON.parse(readFileSync(metaPath(root, id), 'utf8'));
}

// Create a source agent and then make it look like one that ran and finished,
// at `finishedAt`. The record is edited in place because this file launches no
// backend: `agent new` cannot produce a finished agent without one, and the
// state under test is the fork's output, not the run's.
function finishedSource(t, id, finishedAt) {
  const handle = world(t);
  const created = run(['agent', 'new', '--id', id, '--cwd', handle.work], handle.env);
  assert.equal(created.status, EXIT_OK, created.stderr);
  const path = metaPath(handle.root, id);
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(meta, {
    state: 'succeeded',
    started_at: finishedAt,
    finished_at: finishedAt,
    exit_code: 0,
    exit_signal: null,
    prompt_count: 2,
    last_prompt: 'second prompt',
  });
  writeFileSync(path, JSON.stringify(meta, null, 2));
  return handle;
}

function forkSource(env, sourceId, cloneId) {
  const forked = run(['agent', 'new', '--id', cloneId, '--fork', sourceId], env);
  assert.equal(forked.status, EXIT_OK, forked.stderr);
}

function listed(args, env) {
  const result = run(args, env);
  assert.equal(result.status, EXIT_OK, result.stderr);
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

test('an idle fork of a finished agent is a retention candidate and is swept', (t) => {
  const { root, env } = finishedSource(t, 'a1', 1);

  forkSource(env, 'a1', 'b2');

  // The state the issue is about, asserted rather than assumed: a fork of a
  // finished source is idle AND carries the source's terminal finished_at.
  const clone = readMeta(root, 'b2');
  assert.equal(clone.state, 'idle');
  assert.equal(clone.finished_at, 1);

  // The classification: with a zero-day window the clone's work is unambiguously
  // past the cutoff, so `clean` must now select it. Before board 129 this
  // printed nothing, because 'idle' is not a terminal state.
  assert.deepEqual(listed(['agent', 'clean', '--days', '0', '--dry-run'], env).sort(), ['a1', 'b2']);

  // And the selection is honoured, including by the second-phase re-check under
  // the atomic update -- a fix that changed only the outer filter would list the
  // clone here and then refuse to delete it.
  const cleaned = run(['agent', 'clean', '--days', '0'], env);
  assert.equal(cleaned.status, EXIT_OK, cleaned.stderr);
  assert.match(cleaned.stdout, /deleted agent a1/);
  assert.match(cleaned.stdout, /deleted agent b2/);
  assert.equal(existsSync(agentDir(root, 'a1')), false);
  assert.equal(existsSync(agentDir(root, 'b2')), false);
});

test('a fresh fork of an ancient finished agent is not swept on the source clock', (t) => {
  // finished_at far outside any default retention window; the clone is seconds old.
  const { root, env } = finishedSource(t, 'a1', 1);
  forkSource(env, 'a1', 'b2');

  assert.equal(readMeta(root, 'b2').created_at > 1, true);

  // The recorded decision, pinned: the clone's retention clock runs from its own
  // creation, so a default 30-day window does not delete an artifact the operator
  // just made. This is the case that keying the clock on the inherited
  // finished_at alone would get wrong. (The old source `a1` is swept, correctly:
  // its own finished_at is ancient and it has nothing to inherit.)
  const selected = listed(['agent', 'clean', '--dry-run'], env);
  assert.equal(selected.includes('b2'), false, `clean selected the fresh clone: ${selected.join(',')}`);
  assert.equal(existsSync(agentDir(root, 'b2')), true);
});

test('an ordinary idle agent is still not a retention candidate', (t) => {
  const { root, env, work } = world(t);
  const created = run(['agent', 'new', '--id', 'a1', '--cwd', work], env);
  assert.equal(created.status, EXIT_OK, created.stderr);

  // Never run, so no finished_at at all. Widening the classification to idle must
  // not turn "has not started" into "finished long ago".
  assert.equal(readMeta(root, 'a1').finished_at, null);
  assert.deepEqual(listed(['agent', 'clean', '--days', '0', '--dry-run'], env), []);
  assert.equal(existsSync(agentDir(root, 'a1')), true);
});
