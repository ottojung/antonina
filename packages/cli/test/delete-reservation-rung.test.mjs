import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  activeRunnerFlag,
  idleMeta,
  validateAgentMetadata,
} from '../dist/packages/agent-runtime/src/metadata.js';
import { reservationInFlight } from '../dist/packages/agent-runtime/src/lifecycle.js';
import {
  createAgentDirectory,
  metaPath,
  readMeta,
  writeMeta,
} from '../dist/packages/agent-runtime/src/store.js';

// Board 119 asked for a `cmdDelete` test that exercises the reservation rung in
// `ownsWork`. That test cannot exist, and this file is the reason, pinned.
//
// `cmdDelete` (packages/cli/src/agent.ts) builds `ownsWork` as a disjunction and
// the reservation disjunct has been REMOVED, because it was unreachable:
//
//   const ownsWork = deriveState(observed) === 'running'
//     || invocationAlive(observed)
//     || activeRunnerFlag(observed) === true
//     || pending !== null;
//
// The argument has two halves, and both are asserted below rather than asserted
// in prose. First, `reservationInFlight` (packages/agent-runtime/src/lifecycle.ts)
// consults `runner_reservation` only when `activeRunnerFlag(meta)` is true: a
// false flag returns false on its second line, and a null flag returns true on
// its first. So the rung can only be satisfied under `active === null` or
// `active === true`. Second, `active === true` is the disjunct immediately ahead
// of where the rung used to sit, so `||` short-circuits and the rung was never
// evaluated; and `active === null` is unreachable from `cmdDelete` at all,
// because `requireMeta` reads through `readMeta`, which runs
// `validateAgentMetadata`, and that rejects a missing or non-boolean
// `active_runner` before any of this code runs.
//
// The consequence is stronger than "the rung never decided anything": no meta
// shape can make the deleted disjunct true, so restoring it would be a no-op at
// runtime. That is exactly why a behavioural refusal test is not the right
// instrument here -- there is no behaviour left to observe -- and why this file
// pins the absence structurally instead. The rung is NOT dead globally: it is
// live and load-bearing on the `reconcileDeadMeta`, `stopLike`, `prompt` and
// `clean` paths, which have no `activeRunnerFlag` disjunct in front of them.
// Do not read this file as a licence to remove `reservationInFlight` itself.

const CLI_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent.ts'),
  'utf8',
);

// The `ownsWork` disjunction as it is actually written, extracted from the
// source rather than restated, so this test fails if the shape is refactored
// away instead of silently testing a copy.
function cmdDeleteOwnsWork() {
  const start = CLI_SOURCE.indexOf('async function cmdDelete(');
  assert.notEqual(start, -1, 'cmdDelete is missing from packages/cli/src/agent.ts');
  const body = CLI_SOURCE.slice(start, CLI_SOURCE.indexOf('\nasync function ', start + 1));
  const match = body.match(/const ownsWork =[\s\S]*?;/);
  assert.notEqual(match, null, 'cmdDelete no longer assigns ownsWork');
  return match[0];
}

function ticks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// The strongest possible reservation: reserved, well-formed, long out of
// grace, and owned by this (genuinely live, correctly identified) process. If
// any fixture could satisfy the rung, this one would.
function strongestReservation() {
  const realTicks = ticks(process.pid);
  assert.notEqual(realTicks, null, 'this host must expose /proc start ticks for the fixture to mean anything');
  return {
    state: 'reserved',
    gen: 1,
    mode: 'new',
    owner_pid: process.pid,
    owner_start_ticks: realTicks,
    reserved_at: 1,
  };
}

test('cmdDelete ownsWork carries no reservation disjunct', () => {
  const ownsWork = cmdDeleteOwnsWork();

  assert.equal(
    ownsWork.includes('reservationInFlight'),
    false,
    `cmdDelete's ownsWork consults reservationInFlight again:\n${ownsWork}\n`
      + 'The rung is only satisfiable under an active_runner of true, which is the '
      + 'preceding disjunct, or of null, which readMeta rejects before cmdDelete runs. '
      + 'Re-adding it cannot change any delete outcome; if the intent is for delete to '
      + 'refuse on a live reservation, that is a change to the active_runner disjunct '
      + 'and belongs in a board decision, not a silent re-addition.',
  );

  // The disjunction that replaced it must still be the real one, so this test
  // cannot be satisfied by gutting `ownsWork` or renaming the helper.
  for (const guard of [
    "deriveState(observed) === 'running'",
    'invocationAlive(observed)',
    'activeRunnerFlag(observed) === true',
    'pending !== null',
  ]) {
    assert.ok(ownsWork.includes(guard), `cmdDelete's ownsWork lost the guard ${guard}:\n${ownsWork}\n`);
  }
});

test('the deleted rung could not have been satisfied by any meta shape', () => {
  // The strongest reservation, on a terminal agent that owns no other work.
  // The cwd is a throwaway path; nothing here touches the filesystem.
  const terminal = idleMeta('abcd', '/nonexistent-119-rung-cwd', null, 1);
  Object.assign(terminal, {
    state: 'stopped',
    active_runner: false,
    runner_pid: null,
    runner_start_time: null,
    pending_prompt: null,
    runner_gen: 1,
    started_at: 1,
    runner_reservation: strongestReservation(),
  });
  validateAgentMetadata(terminal);

  // Precondition 1: the rung really is false here. This is the whole claim --
  // the fixture is maximally favourable and the rung still declines, because a
  // false active_runner returns false before the reservation is ever read.
  assert.equal(activeRunnerFlag(terminal), false);
  assert.equal(reservationInFlight(terminal), false);

  // Precondition 2: it is false specifically because of the early return, not
  // because the reservation facts are inert. Flip the flag to true and the very
  // same reservation satisfies the rung. So the reservation data is live; the
  // delete path is simply blind to it by construction.
  const flagged = structuredClone(terminal);
  flagged.active_runner = true;
  validateAgentMetadata(flagged);
  assert.equal(reservationInFlight(flagged), true);

  // Precondition 3: the one remaining door -- a null active_runner, for which
  // the rung returns true -- is shut by validation before cmdDelete can observe
  // the record. Both a missing and a non-boolean flag are rejected outright.
  for (const [label, mutate] of [
    ['missing', (meta) => { delete meta.active_runner; }],
    ['non-boolean', (meta) => { meta.active_runner = 'yes'; }],
  ]) {
    const holed = structuredClone(terminal);
    mutate(holed);
    assert.equal(activeRunnerFlag(holed), null, `the ${label} flag must read as null`);
    assert.equal(reservationInFlight(holed), true, `a null flag satisfies the rung in isolation`);
    assert.throws(
      () => validateAgentMetadata(holed),
      /active_runner is malformed|not canonical/,
      `a ${label} active_runner must be rejected by readMeta, or the rung becomes reachable from cmdDelete`,
    );
  }
});

test('a null active_runner never reaches cmdDelete, because readMeta refuses the record', (t) => {
  // Precondition 3, end to end. The gate that closes the rung's only remaining
  // door is `readMeta`, the function `requireMeta` calls at agent.ts:770 -- not
  // merely `validateAgentMetadata` in isolation. So drive the real store.
  const root = mkdtempSync(join(tmpdir(), 'antonina-119-rung-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { env: { XDG_STATE_HOME: join(root, 'state') } };

  assert.equal(createAgentDirectory('beef', paths), true);
  const path = metaPath('beef', paths);
  // `writeMeta` validates too, so the malformed record is written the only way
  // a corrupted-on-disk record can appear: written directly.
  const holed = idleMeta('beef', root, null, 1);
  Object.assign(holed, { state: 'stopped', runner_reservation: strongestReservation() });
  delete holed.active_runner;
  writeFileSync(path, `${JSON.stringify(holed, null, 2)}\n`, 'utf8');

  // `readMeta` throws, so `requireMeta` propagates and `ownsWork` is never
  // evaluated. Had it returned, `activeRunnerFlag` would be null and the
  // rung would have been satisfiable.
  assert.throws(
    () => readMeta('beef', paths),
    /active_runner is malformed|not canonical/,
    'readMeta must refuse a record with a missing active_runner',
  );

  // Control: the same record with a well-formed false flag reads back cleanly,
  // so the refusal above is about the flag and not about the fixture.
  const sound = idleMeta('beef', root, null, 1);
  Object.assign(sound, { state: 'stopped', active_runner: false, runner_reservation: strongestReservation() });
  writeMeta('beef', sound, paths);
  assert.equal(readMeta('beef', paths)?.active_runner, false);
});
