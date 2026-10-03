import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  signalMarkedInvocationProcesses,
  splitProcStatFields,
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

// Every test isolates both Antonina XDG roots so no test can read or write the
// operator's real ~/.local/state/antonina or ~/.config/antonina. The two roots are
// separate directories: the state root and the config root are not the same tree.
function withIsolatedXdg(t) {
  const stateRoot = mkdtempSync(join('/tmp', `antonina-xdg-state-${process.pid}-`));
  const configRoot = mkdtempSync(join('/tmp', `antonina-xdg-config-${process.pid}-`));
  const previous = {
    state: process.env.XDG_STATE_HOME,
    config: process.env.XDG_CONFIG_HOME,
  };
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
  return { stateRoot, configRoot };
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

test('an identity whose start ticks agree but which carries no agent marker is not ours', (t) => {
  withIsolatedXdg(t);
  const iid = 'e'.repeat(32);
  const noMarker = withProc(t, {
    4242: { stat: statLine({ start: 1234 }), environ: `ANTONINA_INVOCATION_ID=${iid}\0OTHER=x\0` },
    4243: { stat: statLine({ start: 1234 }), environ: `ANTONINA_AGENT_ID=ffff\0ANTONINA_INVOCATION_ID=${iid}\0` },
    4244: { stat: statLine({ start: 1234 }), environ: '' },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12' };
  const withInvocation = { ...identity, invocationId: iid };

  for (const probe of [identity, withInvocation]) {
    const alive = recordingSignal();
    assert.equal(isIdentityAlive(probe, { procRoot: noMarker, signal: alive.send }), false);
    assert.deepEqual(alive.calls, []);

    const signalled = recordingSignal();
    assert.equal(signalIdentityChecked(probe, 15, { procRoot: noMarker, signal: signalled.send }), false);
    assert.deepEqual(signalled.calls, []);

    const grouped = recordingSignal();
    assert.equal(signalGroupChecked(probe, 4242, 15, { procRoot: noMarker, signal: grouped.send }), false);
    assert.deepEqual(grouped.calls, []);
  }

  // A different agent id on the same pid is a different owner, and an unreadable
  // environ is not evidence of ownership either.
  for (const pid of [4243, 4244]) {
    const signal = recordingSignal();
    assert.equal(isIdentityAlive({ pid, startTicks: 1234, agentId: 'ab12' }, { procRoot: noMarker, signal: signal.send }), false);
    assert.deepEqual(signal.calls, []);
  }
});

test('a stat tail shorter than the kernel field count is not a stat record', (t) => {
  withIsolatedXdg(t);
  const full = statLine();
  // The comm field contains its own parentheses, so the stat tail must be cut at
  // the LAST ')' -- otherwise this would collapse to a single malformed field.
  const cut = full.lastIndexOf(')');
  const truncated = `${full.slice(0, cut + 1)} ${full.slice(cut + 1).trim().split(/\s+/).slice(0, 19).join(' ')}`;
  assert.equal(splitProcStatFields(full).length, 20);
  // Guard the fixture itself: the tail really is 19 well-formed fields, one short
  // of the kernel minimum, so the rejection is attributable to the field count.
  assert.equal(truncated.slice(truncated.lastIndexOf(')') + 1).trim().split(/\s+/).length, 19);
  assert.equal(splitProcStatFields(truncated), null);
  assert.equal(parseProcStat(truncated), null);
  assert.notEqual(parseProcStat(full), null);
});

test('the state field is exactly one character', (t) => {
  withIsolatedXdg(t);
  assert.equal(parseProcStat(statLine({ state: 'SR' })), null);
  assert.equal(parseProcStat(statLine({ state: 'S' })).state, 'S');
  assert.equal(parseProcStat(statLine({ state: 'Z' })).state, 'Z');
});

test('a persisted invocation id is exactly 32 hex characters in either case', (t) => {
  withIsolatedXdg(t);
  assert.equal(persistedInvocationId('A1B2C3D4'.repeat(4)), 'A1B2C3D4'.repeat(4));
  for (const value of ['a'.repeat(31), 'a'.repeat(33), '', 'A1B2C3D4'.repeat(4) + 'a', 123, null]) {
    assert.equal(persistedInvocationId(value), null);
  }
});

test('a non-positive or fractional pgid is never signalled as a process group', (t) => {
  withIsolatedXdg(t);
  const iid = 'f'.repeat(32);
  const root = withProc(t, {
    4242: { stat: statLine({ start: 1234, pgrp: 4242 }), environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0` },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid };
  for (const pgid of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const signal = recordingSignal();
    assert.equal(signalGroupChecked(identity, pgid, 'SIGTERM', { procRoot: root, signal: signal.send }), false);
    assert.deepEqual(signal.calls, []);
  }
  const ok = recordingSignal();
  assert.equal(signalGroupChecked(identity, 4242, 'SIGTERM', { procRoot: root, signal: ok.send }), true);
  assert.deepEqual(ok.calls, [[-4242, 'SIGTERM']]);
});


test('invocation-marker sweep reaps detached descendants without touching other work', (t) => {
  const iid = '1'.repeat(32);
  const otherIid = '2'.repeat(32);
  const root = withProc(t, {
    // There is deliberately no surviving leader. These are descendants that
    // may have been reparented or moved into their own process groups.
    5001: {
      stat: statLine({ ppid: 1, pgrp: 9001 }),
      environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0`,
    },
    5002: {
      stat: statLine({ ppid: 1, pgrp: 9002 }),
      environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${otherIid}\0`,
    },
    5003: {
      stat: statLine({ ppid: 1, pgrp: 9003 }),
      environ: `ANTONINA_AGENT_ID=ffff\0ANTONINA_INVOCATION_ID=${iid}\0`,
    },
    5004: {
      stat: statLine({ ppid: 1, pgrp: 9004 }),
      environ: 'OTHER=x\0',
    },
  });
  const signal = recordingSignal();

  assert.equal(signalMarkedInvocationProcesses(
    'ab12',
    iid,
    'SIGKILL',
    { procRoot: root, signal: signal.send },
  ), 1);
  assert.deepEqual(signal.calls, [[5001, 'SIGKILL']]);
});

// Board issue 159. `kill(2)` against a process group whose only member is a
// zombie returns success on Linux while delivering nothing: the signal is
// discarded and the zombie is reaped unchanged. Measured on this host, a
// zombie that is its own process-group leader -- the shape `runner.ts` records,
// `meta.pgid = pid` from a `detached` spawn -- answers `kill(-pgid, SIGKILL)`
// and `kill(-pgid, 0)` with success, and stays in state `Z` afterwards. A
// runtime that reported delivery from the success of the `kill` would therefore
// record `operatorSignalDelivered: true` for an invocation that was already
// dead, and classify a host SIGKILL as an operator-requested stop with a null
// `backend_error`.
//
// What already prevents it is `identityMatches`, and specifically its
// environment-marker check: a zombie has no `mm`, so `/proc/<zombie>/environ`
// is present but unreadable (`EACCES` on this host), the marker probe fails, and
// the refusal happens *before* any `kill`. The start-time check does not help --
// `/proc/<zombie>/stat` still resolves, so a zombie's identity start ticks still
// agree, which is exactly why the marker check is load-bearing.
//
// `withUnreadableEnviron` models that unreadable-but-present environ with a
// directory, the closest portable stand-in for a permission-denied read
// (`envHasEntry` treats every throw as "no such marker").
function withUnreadableEnviron(t, entries) {
  const root = join('/tmp', `antonina-zombie-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  for (const [pid, entry] of Object.entries(entries)) {
    const dir = join(root, pid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stat'), entry.stat);
    // A directory where a file is expected: present, and not readable as a file.
    mkdirSync(join(dir, 'environ'), { recursive: true });
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a zombie whose start ticks still agree is not reported as signalled', (t) => {
  const iid = '3'.repeat(32);
  // State `Z`, and the start ticks still resolve to the recorded identity -- the
  // exact shape that makes this a live-looking dead process.
  const root = withUnreadableEnviron(t, {
    4242: { stat: statLine({ state: 'Z', pgrp: 4242, start: 1234 }) },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid };
  // The sender succeeds. That is the whole point: if this runtime trusted the
  // result of the `kill`, it would report delivery for a process that is dead.
  const send = recordingSignal(true);

  assert.equal(processIsZombie(4242, root), true);
  assert.equal(signalGroupChecked(identity, 4242, 'SIGKILL', { procRoot: root, signal: send.send }), false);
  assert.equal(signalIdentityChecked(identity, 'SIGKILL', { procRoot: root, signal: send.send }), false);
  assert.equal(isIdentityAlive(identity, { procRoot: root, signal: send.send }), false);
  // Not merely a false return value: the dangerous group signal is never
  // attempted, so no `kill(-pgid, ...)` can succeed against the zombie.
  assert.deepEqual(send.calls, []);
});

test('an already-reaped invocation is not reported as signalled', (t) => {
  // Distinct from the zombie: `/proc/<pid>` is gone entirely, so the identity
  // fails on the start-time check instead of the marker check. Both must refuse.
  const root = withUnreadableEnviron(t, {});
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: '4'.repeat(32) };
  const send = recordingSignal(true);

  assert.equal(signalGroupChecked(identity, 4242, 'SIGKILL', { procRoot: root, signal: send.send }), false);
  assert.deepEqual(send.calls, []);
});

test('the zombie `Z` state alone does not withhold the signal: the marker check is what does', (t) => {
  // This is the non-vacuity anchor for the two tests above. If a future change
  // "fixed" the zombie problem by trusting `kill(2)`, or by short-circuiting on
  // the state character, this case is what shows the guard is gone: with the
  // markers still readable the runtime signals the group, because `stat` state
  // is not consulted by `identityMatches` at all. Refusing on `Z` would be
  // over-tightening and would break the ordinary death race, where a real
  // invocation is on its way out and a legitimate operator signal still lands.
  const iid = '5'.repeat(32);
  const root = withProc(t, {
    4242: {
      stat: statLine({ state: 'Z', pgrp: 4242, start: 1234 }),
      environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0`,
    },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid };
  const send = recordingSignal(true);

  assert.equal(processIsZombie(4242, root), true);
  assert.equal(signalGroupChecked(identity, 4242, 'SIGKILL', { procRoot: root, signal: send.send }), true);
  assert.deepEqual(send.calls, [[-4242, 'SIGKILL']]);
});

test('a live invocation leader in its own process group is still genuinely signalled', (t) => {
  // The complement of the zombie cases, and the guard against over-correcting
  // them into a runtime that never signals anything. A live leader with readable
  // markers that is a member of the targeted group must report delivery.
  const iid = '6'.repeat(32);
  const root = withProc(t, {
    4242: {
      stat: statLine({ state: 'S', pgrp: 4242, start: 1234 }),
      environ: `ANTONINA_AGENT_ID=ab12\0ANTONINA_INVOCATION_ID=${iid}\0`,
    },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid };
  const send = recordingSignal(true);

  assert.equal(processIsZombie(4242, root), false);
  assert.equal(signalGroupChecked(identity, 4242, 'SIGTERM', { procRoot: root, signal: send.send }), true);
  assert.deepEqual(send.calls, [[-4242, 'SIGTERM']]);
});

test('a live leader whose environ is unreadable is refused, not signalled blind', (t) => {
  // The same unreadable-environ shape as the zombie case, but on a process that
  // is alive. It must refuse identically: the runtime cannot distinguish "alive
  // but unreadable" from "dead but unreadable", and reporting delivery on the
  // `kill` alone would be wrong for both.
  const iid = '7'.repeat(32);
  const root = withUnreadableEnviron(t, {
    4242: { stat: statLine({ state: 'S', pgrp: 4242, start: 1234 }) },
  });
  const identity = { pid: 4242, startTicks: 1234, agentId: 'ab12', invocationId: iid };
  const send = recordingSignal(true);

  assert.equal(processIsZombie(4242, root), false);
  assert.equal(signalGroupChecked(identity, 4242, 'SIGKILL', { procRoot: root, signal: send.send }), false);
  assert.deepEqual(send.calls, []);
});
