import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  envHasAgentMarker,
  isIdentityAlive,
  normalizeAgentId,
  parseProcStat,
  persistedAgentId,
  persistedInvocationId,
  persistedProcessInteger,
  processIsZombie,
  processPgrp,
  signalGroupChecked,
  signalIdentityChecked,
} from '../dist/packages/agent-runtime/src/process.js';

function statLine({ state = 'S', ppid = 1, pgrp = 4242, start = 1234 } = {}) {
  const fields = [state, String(ppid), String(pgrp), '0', '0', '0', '0', '0', '0', '0', '0', '7', '11', '0', '0', '0', '0', '0', '0', String(start)];
  return `4242 (worker (nested) name) ${fields.join(' ')}`;
}

function withProc(t, entries) {
  const root = join('/tmp', `antonina-process-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function recordingSignal(result = true) {
  const calls = [];
  return {
    calls,
    send(pid, signal) {
      calls.push([pid, signal]);
      return result;
    },
  };
}

test('proc stat parser starts after the last comm parenthesis', () => {
  assert.deepEqual(parseProcStat(statLine()), {
    state: 'S', ppid: 1, pgrp: 4242, userTicks: 7, systemTicks: 11, startTicks: 1234,
  });
  assert.equal(parseProcStat('broken'), null);
});

test('process pgrp ignores zombie and unreadable state', (t) => {
  const root = withProc(t, {
    41: { stat: statLine({ state: 'S', pgrp: 400 }) },
    42: { stat: statLine({ state: 'Z', pgrp: 401 }) },
  });
  assert.equal(processPgrp(41, root), 400);
  assert.equal(processPgrp(42, root), null);
  assert.equal(processIsZombie(42, root), true);
  assert.equal(processIsZombie(99, root), true);
});

test('environment markers are exact NUL-delimited entries', (t) => {
  const root = withProc(t, {
    51: { stat: statLine(), environ: 'ANTONINA_AGENT_ID=a1b2c3d45\0OTHER=x\0' },
  });
  assert.equal(envHasAgentMarker(51, 'a1b2c3d4', root), false);
  assert.equal(envHasAgentMarker(51, 'a1b2c3d45', root), true);
});

test('persisted authority validators do not normalize durable values', () => {
  assert.equal(normalizeAgentId(' A1B2 '), 'a1b2');
  assert.equal(persistedAgentId('a1b2'), 'a1b2');
  for (const value of ['A1B2', '', 'not-hex', 123, true]) assert.equal(persistedAgentId(value), null);
  assert.equal(persistedInvocationId('a'.repeat(32)), 'a'.repeat(32));
  assert.equal(persistedInvocationId('g'.repeat(32)), null);
  assert.equal(persistedProcessInteger(123, 1), 123);
  for (const value of [0, -1, 1.5, '123', true]) assert.equal(persistedProcessInteger(value, 1), null);
});

test('liveness verifies persisted identity before ordinary Node signal probe', (t) => {
  const root = withProc(t, {
    4242: { stat: statLine({ start: 1234 }), environ: 'ANTONINA_AGENT_ID=ab12\0' },
  });
  const signal = recordingSignal();
  assert.equal(isIdentityAlive({ pid: 4242, startTicks: 1234, agentId: 'ab12' }, { procRoot: root, signal: signal.send }), true);
  assert.deepEqual(signal.calls, [[4242, 0]]);
});

test('identity mismatch withholds ordinary signal', (t) => {
  const root = withProc(t, {
    4242: { stat: statLine({ start: 9999 }), environ: 'ANTONINA_AGENT_ID=ab12\0' },
  });
  const signal = recordingSignal();
  assert.equal(signalIdentityChecked({ pid: 4242, startTicks: 1234, agentId: 'ab12' }, 15, { procRoot: root, signal: signal.send }), false);
  assert.deepEqual(signal.calls, []);
});

test('signal errors are treated as failure rather than runtime crashes', (t) => {
  const root = withProc(t, {
    4242: { stat: statLine({ start: 1234 }), environ: 'ANTONINA_AGENT_ID=ab12\0' },
  });
  assert.equal(signalIdentityChecked(
    { pid: 4242, startTicks: 1234, agentId: 'ab12' },
    15,
    { procRoot: root, signal: () => { throw new Error('ESRCH'); } },
  ), false);
});

test('invocation marker is part of identity when present', (t) => {
  const iid = 'b'.repeat(32);
  const root = withProc(t, {
    4242: { stat: statLine({ start: 1234 }), environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0` },
  });
  const ok = recordingSignal();
  assert.equal(signalIdentityChecked({ pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid }, 15, { procRoot: root, signal: ok.send }), true);
  assert.deepEqual(ok.calls, [[4242, 15]]);
  const wrong = recordingSignal();
  assert.equal(signalIdentityChecked({ pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: 'c'.repeat(32) }, 15, { procRoot: root, signal: wrong.send }), false);
  assert.deepEqual(wrong.calls, []);
});

test('process-group signal verifies leader then uses negative pgid', (t) => {
  const iid = 'd'.repeat(32);
  const root = withProc(t, {
    4242: { stat: statLine({ start: 1234, pgrp: 4242 }), environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0` },
  });
  const signal = recordingSignal();
  assert.equal(signalGroupChecked(
    { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid },
    4242,
    'SIGTERM',
    { procRoot: root, signal: signal.send },
  ), true);
  assert.deepEqual(signal.calls, [[-4242, 'SIGTERM']]);
});
