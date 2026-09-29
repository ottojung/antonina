// A wall-clock bound that bounds the PROCESS, not just the test.
//
// Board issue 98. A per-test `{ timeout }` bounds a test; it does not bound the
// test *file*, and it does not bound the test *runner*. The two are separate
// things, and the difference is the whole defect:
//
//   - When a test exceeds its own timeout, node reports it as a failure and
//     moves on. That is the bound working.
//   - The test's `t.after` hooks do NOT run for a test that timed out, and the
//     `ChildProcess` handle of a detached backend the runner spawned is still
//     ref'd. Both hold the event loop open, so the file process never exits,
//     `node --test` never returns, and `npm test` sits there until someone
//     kills it. Exit code 124 from an outer `timeout` is the only thing that
//     ever ends the run, and 124 is not a statement about the code.
//
// Measured on this host (Node v24.21.0) with a two-line `node:test` file and
// no Antonina code: one test with a live detached child and a fired per-test
// timeout, then nothing. Same file with `--test-force-exit`: exits 1, promptly,
// and leaves the detached child running as an orphan. Force-exit is therefore
// not the answer either -- it converts a hang into a truthful code and a leaked
// process, and this repository's own rule is that a test which spawns a process
// must converge and reap it before returning.
//
// So the bound lives here, one level below the runner, and it does three things
// in order: it names what it gave up on, it reaps what it can identify, and
// only then does it exit non-zero. Reaping is attempted from the durable
// records the product itself wrote -- a recorded pid, its process-group id and
// its /proc start ticks -- never from a process name, so the reaper cannot kill
// something that is not the invocation the runner recorded.
//
// Everything here is a bound, so nothing here is allowed to make a suite
// slower-looking-but-passing, nor to be loosened past its cap. `boundMs` caps
// whatever the environment asks for: a run can only ever be made shorter.

import { writeSync } from 'node:fs';
import { afterEach } from 'node:test';

/**
 * The exit code a bounded-out run leaves behind. 1 is node's own code for "a
 * test did not pass", and it is what a run whose assertions already failed is
 * exiting with anyway; the distinction between "an assertion failed" and "the
 * run could not finish" is carried by the `ANTONINA-TEST-BOUND` line on stderr,
 * which is the thing a human reads. A code of 0 would be a lie here, and a code
 * of 0 is the only thing a caller could mistake for a pass.
 */
export const BOUND_EXIT_CODE = 1;

const BOUND_PREFIX = 'ANTONINA-TEST-BOUND';

/**
 * A bound in milliseconds, from the environment if it asks for one and never
 * above `capMs`.
 *
 * The cap is the point. The environment is here so an experiment (a
 * deliberately wedged case, a slow-host rehearsal) can be run in seconds
 * instead of minutes, and the cap is here so that variable can only ever make a
 * run *shorter*. An unparseable or negative value falls back to the cap, which
 * is the safe direction: the cap is the bound, and a typo cannot remove it.
 */
export function boundMs(name, capMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return capMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return capMs;
  return Math.min(capMs, value);
}

// Reapers and cleaners registered by the suite. A reaper is handed the identity
// of a process the suite is responsible for and returns a one-line account of
// what it did with it; a cleaner removes a directory the suite created. They
// are drained in two separate passes, reapers first, because a reaper that
// cannot find its agent record cannot find the pid to kill, and deleting the
// record first would guarantee the miss.
const reapers = new Map();
const cleaners = new Map();
let nextRegistration = 0;

function register(table, label, fn) {
  const id = nextRegistration;
  nextRegistration += 1;
  table.set(id, { label, fn });
  return () => table.delete(id);
}

/**
 * Register a reaper for a process the suite spawned. The returned function
 * unregisters it, which a suite should do when the process has converged --
 * the point of the registry is that at bound time it holds only what is still
 * outstanding.
 */
export function registerReap(label, reap) {
  return register(reapers, label, reap);
}

/**
 * Register a directory the suite created and wants gone even if the run is
 * bounded out before its `t.after` hooks get the chance.
 */
export function registerCleanup(label, clean) {
  return register(cleaners, label, clean);
}

function drain(table) {
  const notes = [];
  for (const [id, { label, fn }] of [...table]) {
    table.delete(id);
    try {
      notes.push(`${label}: ${fn()}`);
    } catch (error) {
      notes.push(`${label}: reaping threw ${error && error.message ? error.message : String(error)}`);
    }
  }
  return notes;
}

function write(text) {
  // Synchronous, straight to the fd: a diagnostic that is lost because the
  // process exited before the pipe drained is the one diagnostic that matters
  // most here.
  writeSync(2, `${text}\n`);
}

/**
 * Install the bound for the calling test file.
 *
 * Two independent conditions, because they fail in different ways and the
 * cheaper of the two is not always the right one:
 *
 *   - `suiteMs` is an absolute ceiling on the file. Nothing about a run gets a
 *     exemption from it.
 *   - `stallMs` is a ceiling on the time since a test last finished. A host
 *     under load makes every test slower, and a slower host should not be
 *     killed for it; a host that is merely slow keeps reporting completed
 *     tests and keeps resetting the stall. Only a run that has stopped making
 *     progress can trip it. This is the condition that catches a wedge without
 *     imposing a load-proportional false red, which is the failure mode an
 *     absolute bound alone has.
 *
 * `reapGraceMs` is how long a bounded-out run waits for the reaper's SIGKILLs
 * to unwind the run on its own before the exit is forced. The grace timer is
 * deliberately unref'd: if the reaper worked and the event loop drained, the
 * process exits by itself with whatever code the run had already earned, which
 * is the most truthful outcome available. An unref'd timer still fires while
 * anything else is holding the loop open, which is exactly the case it is for.
 */
export function installSuiteBound({
  description,
  suiteMs,
  stallMs = null,
  reapGraceMs = 2_000,
  tickMs = 250,
}) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let fired = false;

  // A test file that finishes its last test and then cannot exit makes no more
  // progress, and that is the shape this exists for, so completion is taken
  // from node's own per-test hook rather than from anything the suite calls by
  // hand.
  afterEach(() => {
    lastProgressAt = Date.now();
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const sinceProgress = now - lastProgressAt;
    const sinceStart = now - startedAt;
    const tripped = sinceStart >= suiteMs
      ? `wall clock (${sinceStart}ms of ${suiteMs}ms)`
      : stallMs !== null && sinceProgress >= stallMs
        ? `progress (${sinceProgress}ms with no test completing, bound ${stallMs}ms)`
        : null;
    if (tripped === null) return;
    fired = true;
    clearInterval(timer);

    write(
      `${BOUND_PREFIX}: ${description} is bounded out on ${tripped}; the run cannot be `
      + 'trusted to finish, and a run that cannot finish is not a pass. Reaping what this '
      + 'suite can identify from the durable records it wrote, then exiting non-zero.',
    );
    // A run that the bound has caught is red whether or not the reaper manages
    // to unwind it, so the exit code is claimed here rather than in the forced
    // exit below. Without this, a reap that works lets the loop drain and the
    // process exits with whatever the assertions happened to have earned -- and
    // a suite whose tests were all still passing at the moment it wedged would
    // report success on a run that never finished. The bound firing is itself
    // the failure.
    //
    // The cleaners are drained here too, at exit, rather than immediately
    // below. A reap often does unwind the run, and a test that is resuming
    // after one still has assertions to make against the state home it was
    // given; deleting that state home out from under it would replace a real
    // failure with a `TypeError` about a null record, which is a worse
    // account of the same defect than the one already on stderr.
    process.on('exit', () => {
      process.exitCode = BOUND_EXIT_CODE;
      for (const note of drain(cleaners)) write(`${BOUND_PREFIX}: cleaned ${note}`);
    });
    for (const note of drain(reapers)) write(`${BOUND_PREFIX}: reaped ${note}`);

    setTimeout(() => {
      write(
        `${BOUND_PREFIX}: still running ${reapGraceMs}ms after the reap; exiting `
        + `${BOUND_EXIT_CODE} rather than waiting for a wedge that will not end.`,
      );
      process.exit(BOUND_EXIT_CODE);
    }, reapGraceMs).unref();
  }, tickMs);
  timer.unref();

  return {
    /** Whether the bound has already fired. A suite may assert on it. */
    fired: () => fired,
    /** Stop the bound. A suite that has its own hard bound may use it. */
    disarm: () => clearInterval(timer),
  };
}
