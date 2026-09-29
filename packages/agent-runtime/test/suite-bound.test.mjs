// The suite bound is asserted, not assumed.
//
// Board issue 98. Everything the agent-runtime runner suite does to stop itself
// hanging -- the fixture's own lifetime, the per-test timeout, the process-level
// bound in `support/suite-bound.mjs` -- is invisible in a green run, because a
// green run never reaches any of it. A bound that has been deleted, or a bound
// whose exit code is 0, or a bound that reaps nothing and leaks the process it
// was written to reap: all three produce exactly the same output as a correct
// bound, which is to say none. So the mechanism is exercised here against a
// run that really does wedge, and it is exercised in both directions: a run the
// bound can reach, and a run with the same code and the same wedged child and
// the bound out of reach. The second is what makes the first mean anything --
// without it, "the child exited" is evidence about the harness rather than
// about the bound.
//
// The two cases below are the whole argument, and they differ in exactly one
// line: the bound's own millisecond figure. Everything else -- the module, the
// reaper, the identity check, the wedged grandchild holding the event loop
// open -- is identical between them.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { processIsZombie, procStartTicks } from '../dist/packages/agent-runtime/src/process.js';
import { BOUND_EXIT_CODE, boundMs } from './support/suite-bound.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const SUITE_BOUND_URL = pathToFileURL(join(HERE, 'support', 'suite-bound.mjs')).href;
const PROCESS_URL = pathToFileURL(join(HERE, '..', 'dist', 'packages', 'agent-runtime', 'src', 'process.js')).href;

// Short enough that this file stays quick, long enough that an ordinary loaded
// host does not trip it by accident: the bound has to be reachable in a
// deliberate wedge, and unreachable in a run that is merely slow.
const REACHABLE_MS = 1_000;
const UNREACHABLE_MS = 10 * 60_000;
// If the bound does not work, the harness has to end the run anyway, or this
// suite is the thing that hangs. The margin over REACHABLE_MS is what turns
// "the bound fired" into an observation rather than a race.
const HARNESS_TIMEOUT_MS = 15_000;

// A run that cannot be reaped has to be reported, not silently forgotten.
function readIdentity(pidFile) {
  try {
    return JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

// The wedged run, as a script. `boundMsArg` is the only thing that varies
// between the two cases, and `reap` is what the reaper it registers is allowed
// to do; both are the same in the real suite, so both are the same here.
const WEDGED_SUITE = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [boundUrl, processUrl, identityPath, boundMsRaw, reap] = process.argv.slice(2);
const { installSuiteBound, registerCleanup, registerReap } = await import(boundUrl);
const { procStartTicks } = await import(processUrl);

// A detached child that never exits, held by a ref'd ChildProcess handle -- the
// exact shape of the defect: a live handle keeps the event loop (and so the
// file, and so \`node --test\`, and so \`npm test\`) open forever.
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
let startTicks = null;
const identityDeadline = Date.now() + 2000;
while (startTicks === null && Date.now() < identityDeadline) startTicks = procStartTicks(grandchild.pid);
writeFileSync(identityPath, JSON.stringify({ pid: grandchild.pid, startTicks }));

registerReap(\`grandchild \${grandchild.pid}\`, () => {
  if (reap !== 'reap') return 'declined: this run is the control, the bound is unreachable';
  if (startTicks === null) return 'declined: no /proc identity for the child, so it cannot be signalled safely';
  if (procStartTicks(grandchild.pid) !== startTicks) {
    return \`declined: pid \${grandchild.pid} is not the recorded process any more\`;
  }
  try {
    process.kill(-grandchild.pid, 'SIGKILL');
    return \`SIGKILLed process group \${grandchild.pid}\`;
  } catch (error) {
    return \`declined: \${error && error.code ? error.code : String(error)}\`;
  }
});
registerCleanup('the suite scratch home', () => 'nothing left to clean');

installSuiteBound({
  description: 'the suite-bound self-check',
  suiteMs: Number(boundMsRaw),
  stallMs: Number(boundMsRaw),
  reapGraceMs: 300,
});

// The wedge. Nothing below this line is ever reached.
await new Promise(() => {});
`;

/**
 * Run the wedged suite to completion, or to the harness's own bound, and
 * return what happened. Reaps anything the run left behind, on every path,
 * because a self-check that leaks the process it is checking for is the same
 * defect wearing a different hat.
 */
function runWedgedSuite(t, { boundMsRaw, reap }) {
  const root = mkdtempSync(join(tmpdir(), 'antonina-suite-bound-'));
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  mkdirSync(stateHome);
  mkdirSync(configHome);
  const script = join(root, 'wedged-suite.mjs');
  const identityPath = join(root, 'identity.json');
  writeFileSync(script, WEDGED_SUITE);

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [script, SUITE_BOUND_URL, PROCESS_URL, identityPath, String(boundMsRaw), reap], {
    encoding: 'utf8',
    timeout: HARNESS_TIMEOUT_MS,
    // Test-owned state homes: nothing here may read or write the operator's.
    env: { ...process.env, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome },
  });
  const elapsedMs = Date.now() - startedAt;
  const identity = readIdentity(identityPath);

  t.after(() => {
    if (identity !== null && !processIsZombie(identity.pid)) {
      try { process.kill(-identity.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  return { ...result, elapsedMs, identity, stderr: result.stderr ?? '' };
}

/** Wait, briefly, for a killed process to leave /proc or become a zombie. */
function convergesWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (processIsZombie(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return processIsZombie(pid);
}

test('the suite bound ends a wedged run non-zero, and reaps the process it identified', (t) => {
  const run = runWedgedSuite(t, { boundMsRaw: REACHABLE_MS, reap: 'reap' });

  // It ended itself. A signal here would mean the harness killed it, which is
  // the control case below and not evidence about the bound.
  assert.equal(run.signal, null, `the wedged run was killed from outside: ${run.stderr}`);
  assert.equal(run.error, undefined, `the wedged run could not be started: ${String(run.error)}`);
  // The literal, and not `BOUND_EXIT_CODE`. The whole point of the case is that
  // a bounded-out run is red, and comparing the observed code against the
  // module's own constant cannot fail for the one mutation that matters: set
  // that constant to 0 and a wedged run exits 0 while this file still reports
  // 3 pass / 0 fail, rc=0. So the expected code is written here, where the
  // module under test cannot reach it, and the constant is pinned against the
  // same literal -- if it moves, both of these assertions move red by name.
  assert.equal(
    run.status,
    1,
    `a bounded-out run must not exit 0; the run said:\n${run.stderr}`,
  );
  assert.match(run.stderr, /ANTONINA-TEST-BOUND: the suite-bound self-check is bounded out/);
  assert.match(run.stderr, /reaped grandchild \d+: SIGKILLed process group \d+/);
  // It ended on the bound's own clock, not somewhere near the harness's.
  assert.ok(
    run.elapsedMs < HARNESS_TIMEOUT_MS / 2,
    `the bound took ${run.elapsedMs}ms, which is not distinguishable from the harness's ${HARNESS_TIMEOUT_MS}ms`,
  );

  // And the thing the bound claimed to reap is actually gone, which is the
  // claim a `--test-force-exit`-shaped bound makes and does not keep.
  assert.ok(run.identity !== null, 'the wedged run never recorded the child it was supposed to leave behind');
  assert.ok(run.identity.startTicks !== null, `no /proc identity for pid ${run.identity.pid}`);
  assert.ok(
    convergesWithin(run.identity.pid, 10_000),
    `pid ${run.identity.pid} is still running after the bound reported reaping it`,
  );
});

test('the same wedged run, with the bound out of reach, is ended by nothing here', (t) => {
  // The control. Same module, same wedged child, same reaper, same hang: the
  // only difference is that the bound's figure is beyond the harness's, so it
  // never fires. If this case were to end on its own, the case above would be
  // measuring the harness rather than the bound.
  const run = runWedgedSuite(t, { boundMsRaw: UNREACHABLE_MS, reap: 'reap' });

  assert.equal(
    run.signal,
    'SIGTERM',
    `a wedged run whose bound is unreachable must still be running when the harness reaches it; `
    + `it exited with status ${run.status} instead:\n${run.stderr}`,
  );
  assert.doesNotMatch(run.stderr, /ANTONINA-TEST-BOUND/);
  assert.ok(
    run.elapsedMs >= HARNESS_TIMEOUT_MS * 0.5,
    `the control finished in ${run.elapsedMs}ms rather than running on to the harness's `
    + `${HARNESS_TIMEOUT_MS}ms, so the bound cannot be what ended the case above`,
  );

  // The reaper never ran, so the child is still there to be reaped by the
  // harness. `t.after` above does it; this is the assertion that the control
  // really did leave a live process behind, which is what makes it a control.
  assert.ok(run.identity !== null);
  assert.equal(
    convergesWithin(run.identity.pid, 0),
    false,
    'the control run left nothing running, so it is not the control this suite assumes',
  );
});

test("the module's own bound exit code is the non-zero code, pinned here", () => {
  // Its own test, and not a line inside the case above, so that it reports by
  // name: the literal in that case fails first and would take this one with it,
  // and a guarantee that is only ever checked as a side effect of another
  // assertion is the kind that silently stops being checked.
  //
  // The module's own header says why this is a guarantee at all: "a code of 0
  // would be a lie here, and a code of 0 is the only thing a caller could
  // mistake for a pass." The file that enforces the comment did not enforce the
  // code, so it is enforced here, against a literal the module cannot reach.
  assert.equal(
    BOUND_EXIT_CODE,
    1,
    'the module\'s own bound exit code is no longer the non-zero code this suite pins; '
    + 'a wedged run that exits 0 is indistinguishable from a pass to any caller',
  );
});

test('a bound can only be shortened, never lengthened past its ceiling', () => {
  // The ceilings are what make "bounded" a property of the suite rather than a
  // property of the environment. An environment that can raise a bound can
  // remove it, and a removed bound is the defect this file exists to make
  // visible.
  assert.equal(boundMs('ANTONINA_SUITE_BOUND_PROBE', 300_000), 300_000);
  process.env.ANTONINA_SUITE_BOUND_PROBE = '10';
  assert.equal(boundMs('ANTONINA_SUITE_BOUND_PROBE', 300_000), 10);
  process.env.ANTONINA_SUITE_BOUND_PROBE = '999999999';
  assert.equal(boundMs('ANTONINA_SUITE_BOUND_PROBE', 300_000), 300_000);
  process.env.ANTONINA_SUITE_BOUND_PROBE = 'not a number';
  assert.equal(boundMs('ANTONINA_SUITE_BOUND_PROBE', 300_000), 300_000);
  process.env.ANTONINA_SUITE_BOUND_PROBE = '-1';
  assert.equal(boundMs('ANTONINA_SUITE_BOUND_PROBE', 300_000), 300_000);
  delete process.env.ANTONINA_SUITE_BOUND_PROBE;
});
