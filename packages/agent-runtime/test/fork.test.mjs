// Board issue 126: `antonina agent new --id <NEW> --fork <OLD>`.
//
// The contract this file pins, in the order the tests pin it:
//
//   1. A fork is a snapshot. The clone gets the source's persisted work
//      identity (cwd, title, variant, native session, prompt history, terminal
//      outcome) and its own id and its own record.
//   2. The clone shares NO mutable object with the source, at any depth. This
//      is asserted by mutating each side and observing the other is byte-for-byte
//      unchanged -- twice, in both directions -- and by mutating the in-memory
//      snapshot and observing the source record is untouched. A shallow copy
//      fails the second of those; an aliased file fails the first.
//   3. A fork never inherits process ownership. A source that owns live work --
//      a live invocation, a live runner, a reservation in flight, an accepted
//      prompt, a record still saying `running`, or a deletion tombstone -- is
//      refused, and the refusal happens before anything is written.
//   4. Both required failure modes are exercised: an unknown source id, and a
//      new id that already exists. Neither leaves anything behind.
//
// Every test isolates BOTH Antonina XDG roots, so none of them can read or write
// the operator's real ~/.local/state/antonina or ~/.config/antonina.
//
// No test here spawns a process. The liveness fixtures are fabricated /proc
// trees (stat + environ), which is the same technique
// packages/agent-runtime/test/process.test.mjs uses, so there is nothing to reap.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentForkSourceBusyError,
  AgentForkSourceMissingError,
  AgentForkTargetExistsError,
  forkAgent,
  forkBlocker,
  forkMetaSnapshot,
} from '../dist/packages/agent-runtime/src/fork.js';
import { idleMeta, validateAgentMetadata } from '../dist/packages/agent-runtime/src/metadata.js';
import { updateMeta, createAgentDirectory, metaPath, readMeta, writeMeta } from '../dist/packages/agent-runtime/src/store.js';
import { procStartTicks } from '../dist/packages/agent-runtime/src/process.js';

const BACKEND_ERROR_FIELDS = 10;
const INVOCATION_ID = 'a'.repeat(32);

// Both XDG roots are replaced, and they are separate directories: the state root
// and the config root are not the same tree, and a test that only isolated one
// of them could still reach the operator's trust.json.
function withIsolatedXdg(t) {
  const stateRoot = mkdtempSync(join('/tmp', `antonina-fork-state-${process.pid}-`));
  const configRoot = mkdtempSync(join('/tmp', `antonina-fork-config-${process.pid}-`));
  const previous = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
  process.env.XDG_STATE_HOME = stateRoot;
  process.env.XDG_CONFIG_HOME = configRoot;
  t.after(() => {
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });
  return { stateRoot, configRoot, options: { env: process.env } };
}

// A record carrying a well-formed backend_error, so a fork has a nested mutable
// object to alias if the copy is shallow. backend_error is a closed record of
// ten fields; validateAgentMetadata enforces the count, so it is asserted here
// too rather than trusted.
function backendError(model) {
  return {
    classification: 'provider_rate_limit',
    provider: 'anthropic',
    model,
    request_boundary: 'continuation',
    reference: 'req-1',
    transient: true,
    automatic_retry_safe: true,
    fresh_session_useful: false,
    backend_scope: 'request',
    diagnostic_bytes: 12,
  };
}

function finishedMeta(agentId, overrides = {}) {
  const meta = {
    ...idleMeta(agentId, '/srv/work', 'original title', 1_000),
    native_session_id: 'sess-abcdef0123456789',
    state: 'failed',
    prompt_count: 3,
    last_prompt: 'third prompt',
    started_at: 1_010,
    finished_at: 1_020,
    exit_code: 7,
    exit_signal: null,
    error: 'boom',
    ...overrides,
  };
  validateAgentMetadata(meta);
  return meta;
}

function seed(agentId, meta) {
  assert.equal(createAgentDirectory(agentId, { env: process.env }), true);
  writeMeta(agentId, meta, { env: process.env });
}

function statLine({ state = 'S', ppid = 1, pgrp = 4242, start = 1234 } = {}) {
  const fields = [state, String(ppid), String(pgrp), '0', '0', '0', '0', '0', '0', '0', '0', '7', '11', '0', '0', '0', '0', '0', '0', String(start)];
  return `4242 (worker (nested) name) ${fields.join(' ')}`;
}

function withProc(t, entries) {
  const root = join('/tmp', `antonina-fork-proc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  for (const [pid, entry] of Object.entries(entries)) {
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stat'), entry.stat);
    writeFileSync(join(dir, 'environ'), entry.environ ?? '');
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function bytes(agentId) {
  return readFileSync(metaPath(agentId, { env: process.env }), 'utf8');
}

test('a fork carries the source work identity and takes a new identity of its own', (t) => {
  withIsolatedXdg(t);
  seed('a1', finishedMeta('a1', { backend_error: backendError('model-one') }));

  const clone = forkAgent('a1', 'b2', { env: process.env });

  assert.equal(clone.id, 'b2');
  // The session identity is what lets `run` continue the same conversation.
  assert.equal(clone.native_session_id, 'sess-abcdef0123456789');
  assert.equal(clone.cwd, '/srv/work');
  assert.equal(clone.title, 'original title');
  assert.equal(clone.variant, 'low');
  assert.equal(clone.prompt_count, 3);
  assert.equal(clone.last_prompt, 'third prompt');
  assert.equal(clone.state, 'failed');
  assert.equal(clone.exit_code, 7);
  assert.equal(clone.finished_at, 1_020);
  assert.deepEqual(clone.backend_error, backendError('model-one'));

  // Its own identity.
  assert.notEqual(clone.created_at, 1_000);
  // And no claim on live work or on a process.
  assert.equal(clone.pid, null);
  assert.equal(clone.pgid, null);
  assert.equal(clone.start_time, null);
  assert.equal(clone.invocation_id, null);
  assert.equal(clone.runner_pid, null);
  assert.equal(clone.runner_start_time, null);
  assert.equal(clone.active_runner, false);
  assert.equal(clone.runner_gen, 0);
  assert.equal(clone.runner_reservation, null);
  assert.equal(clone.pending_prompt, null);
  assert.deepEqual(clone.steer_queue, []);
  assert.equal(clone.steer_seq, 0);
  assert.equal(clone.intent, null);
  assert.equal(clone.delete_pending, false);

  // Both records are canonical, independently.
  validateAgentMetadata(readMeta('a1', { env: process.env }));
  validateAgentMetadata(readMeta('b2', { env: process.env }));
});

test('the snapshot shares no mutable object with the source, at any depth', (t) => {
  withIsolatedXdg(t);
  const source = finishedMeta('a1', { backend_error: backendError('model-one') });
  seed('a1', source);
  const sourceBytes = bytes('a1');

  const clone = forkMetaSnapshot(source, 'b2', 2_000);

  // Object identity, at the nested record the copy is most likely to alias.
  assert.notEqual(clone.backend_error, source.backend_error);
  assert.notEqual(clone.steer_queue, source.steer_queue);

  // Behaviour, not just reference inequality: mutate the clone's nested value
  // in place, the way a later write would, and the source must not see it.
  clone.backend_error.model = 'model-two';
  clone.backend_error.diagnostic_bytes = 999;
  assert.equal(source.backend_error.model, 'model-one');
  assert.equal(source.backend_error.diagnostic_bytes, 12);
  assert.deepEqual(source.backend_error, backendError('model-one'));

  // The source record on disk is untouched by the whole operation.
  assert.equal(bytes('a1'), sourceBytes);
});

test('mutating the clone leaves the source byte-identical, and the converse', async (t) => {
  withIsolatedXdg(t);
  seed('a1', finishedMeta('a1', { backend_error: backendError('model-one') }));
  forkAgent('a1', 'b2', { env: process.env });
  const sourceBefore = bytes('a1');
  const cloneBefore = bytes('b2');

  // Distinct files, and distinct inodes: a clone that was a hard link, a copy
  // of the same inode, or a symlink to the source would pass a naive
  // "different path" check while still being one object.
  const sourceIno = statSync(metaPath('a1', { env: process.env })).ino;
  const cloneIno = statSync(metaPath('b2', { env: process.env })).ino;
  assert.notEqual(metaPath('a1', { env: process.env }), metaPath('b2', { env: process.env }));
  assert.notEqual(sourceIno, cloneIno);

  // Direction one: write to the clone, source unchanged.
  await updateMeta('b2', (meta) => {
    meta.title = 'clone renamed';
    meta.prompt_count = 99;
    meta.backend_error = backendError('model-two');
  }, { env: process.env });
  assert.equal(bytes('a1'), sourceBefore);
  assert.notEqual(bytes('b2'), cloneBefore);
  const cloneAfterCloneWrite = bytes('b2');

  // Direction two: write to the source, clone unchanged.
  await updateMeta('a1', (meta) => {
    meta.title = 'source renamed';
    meta.cwd = '/srv/elsewhere';
  }, { env: process.env });
  assert.equal(bytes('b2'), cloneAfterCloneWrite);
  assert.equal(cloneAfterCloneWrite.includes('clone renamed'), true);
  assert.equal(cloneAfterCloneWrite.includes('source renamed'), false);
  assert.equal(cloneAfterCloneWrite.includes('/srv/elsewhere'), false);

  // And the source's own write landed only in the source.
  const sourceAfter = readFileSync(metaPath('a1', { env: process.env }), 'utf8');
  assert.equal(sourceAfter.includes('source renamed'), true);
  assert.equal(sourceAfter.includes('clone renamed'), false);
  assert.equal(sourceAfter.includes('/srv/elsewhere'), true);
});

test('a fork does not modify the source', (t) => {
  withIsolatedXdg(t);
  seed('a1', finishedMeta('a1'));
  const before = bytes('a1');
  const beforeStat = statSync(metaPath('a1', { env: process.env }));

  forkAgent('a1', 'b2', { env: process.env }, {}, 2_000);
  forkAgent('a1', 'c3', { env: process.env }, {}, 2_000);

  assert.equal(bytes('a1'), before);
  assert.equal(statSync(metaPath('a1', { env: process.env })).mtimeMs, beforeStat.mtimeMs);
  // Two forks of the same source are the same snapshot, in separate storage.
  const left = readMeta('b2', { env: process.env });
  const right = readMeta('c3', { env: process.env });
  assert.equal(JSON.stringify({ ...left, id: 'X' }), JSON.stringify({ ...right, id: 'X' }));
});

test('a fork of an unknown source id fails and creates nothing', (t) => {
  withIsolatedXdg(t);
  assert.throws(
    () => forkAgent('dead', 'b2', { env: process.env }),
    (error) => {
      assert.ok(error instanceof AgentForkSourceMissingError);
      assert.match(error.message, /dead/);
      return true;
    },
  );
  assert.equal(readMeta('b2', { env: process.env }), null);
});

test('a fork onto an existing agent id fails and leaves that agent untouched', (t) => {
  withIsolatedXdg(t);
  seed('a1', finishedMeta('a1'));
  seed('b2', finishedMeta('b2', { title: 'existing agent' }));
  const existing = bytes('b2');

  assert.throws(
    () => forkAgent('a1', 'b2', { env: process.env }),
    (error) => {
      assert.ok(error instanceof AgentForkTargetExistsError);
      assert.match(error.message, /already exists/);
      return true;
    },
  );
  assert.equal(bytes('b2'), existing);
  assert.equal(readMeta('b2', { env: process.env }).title, 'existing agent');
});

test('a source with live work is refused, and no clone directory is created', (t) => {
  withIsolatedXdg(t);
  // A real, live invocation: the pid is this very test process, and the record
  // carries the start ticks and the env marker the runtime actually checks. No
  // process is spawned, so there is nothing to reap.
  const live = {
    ...finishedMeta('a1'),
    state: 'running',
    pid: process.pid,
    pgid: process.pid,
    start_time: procStartTicks(process.pid),
    invocation_id: INVOCATION_ID,
    pending_prompt: 'accepted but not yet run',
  };
  validateAgentMetadata(live);
  seed('a1', live);
  const before = bytes('a1');
  const root = withProc(t, {
    [process.pid]: { stat: statLine({ start: procStartTicks(process.pid) }), environ: `ANTONINA_AGENT_ID=a1\0ANTONINA_INVOCATION_ID=${INVOCATION_ID}\0` },
  });

  assert.throws(
    () => forkAgent('a1', 'b2', { env: process.env }, { procRoot: root, signal: () => true }),
    (error) => {
      assert.ok(error instanceof AgentForkSourceBusyError);
      assert.match(error.message, /live backend process/);
      return true;
    },
  );
  assert.equal(readMeta('b2', { env: process.env }), null);
  assert.equal(bytes('a1'), before);
});

test('forkBlocker names every reason a source may not be forked', (t) => {
  withIsolatedXdg(t);
  const terminal = finishedMeta('a1');

  // Nothing to inherit: a terminal agent is forkable.
  assert.equal(forkBlocker(terminal), null);
  assert.equal(forkBlocker(idleMeta('a1', '/srv/work', null, 1_000)), null);

  assert.equal(
    forkBlocker({ ...terminal, delete_pending: true }),
    'delete_pending',
  );
  assert.equal(
    forkBlocker({ ...terminal, pending_prompt: 'waiting' }),
    'accepted_prompt',
  );
  assert.equal(
    forkBlocker({ ...terminal, state: 'running' }),
    'declared_running',
  );
  // Malformed pending-prompt authority is uncertainty, and uncertainty is a
  // refusal, not a licence to guess.
  const malformed = { ...terminal };
  delete malformed.pending_prompt;
  assert.equal(forkBlocker(malformed), 'accepted_prompt');

  // A live runner and a live reservation are separate rungs from the live
  // invocation above, and each is reachable on its own.
  const liveRunner = { ...terminal, runner_pid: process.pid, runner_start_time: procStartTicks(process.pid) };
  validateAgentMetadata(liveRunner);
  const root = withProc(t, {
    [process.pid]: { stat: statLine({ start: procStartTicks(process.pid) }), environ: 'ANTONINA_AGENT_ID=a1\0' },
  });
  assert.equal(forkBlocker(liveRunner, { procRoot: root, signal: () => true }), 'live_runner');

  const reserved = {
    ...terminal,
    active_runner: true,
    runner_gen: 2,
    runner_reservation: {
      state: 'reserved',
      gen: 2,
      owner_pid: process.pid,
      owner_start_ticks: procStartTicks(process.pid),
      reserved_at: Date.now() / 1000,
      mode: 'continue',
    },
  };
  validateAgentMetadata(reserved);
  assert.equal(forkBlocker(reserved), 'runner_reservation');

  // The same records with nothing alive behind them are forkable, so the rungs
  // above are about live work and not merely about fields being present.
  assert.equal(forkBlocker(liveRunner), null);
  assert.equal(forkBlocker({ ...terminal, active_runner: true }), null);
});

test('a fork keeps the record canonical even at a field boundary', (t) => {
  withIsolatedXdg(t);
  // backend_error is a closed record; if a future change widened the copy
  // rather than deep-cloning it, this is the shape that would notice.
  const source = finishedMeta('a1', { backend_error: backendError('model-one') });
  assert.equal(Object.keys(source.backend_error).length, BACKEND_ERROR_FIELDS);
  const clone = forkMetaSnapshot(source, 'b2', 2_000);
  assert.equal(Object.keys(clone.backend_error).length, BACKEND_ERROR_FIELDS);
  assert.throws(() => validateAgentMetadata({ ...clone, id: 'B2' }), /id is malformed/);
});
