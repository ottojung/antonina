import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { constants } from 'node:os';

import {
  backendCapabilities,
  backendRetryDelay,
  buildAgentCommand,
  classifyBackendFailure,
  classifySignalDeath,
  describeBackendDeath,
  describeSignalDeath,
  discoverSessionId,
  honoursInvocationCwd,
  lastLogLineExcerpt,
  type BackendError,
} from './backend.js';
import {
  readOomCounters,
  type HostCapacityReadOptions,
  type OomCounters,
} from './host-capacity.js';
import {
  finalizeTerminal,
  popSteerIntoPending,
  setActiveRunner,
  signalInvocation,
  steerQueue,
  steerSequence,
  stopLikeOrMalformed,
} from './lifecycle.js';
import {
  activeRunnerFlag,
  deletePendingFlag,
  pendingPrompt,
  persistedControlField,
  persistedNativeSessionId,
  requiredAgentCwd,
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  type AgentMetadata,
} from './metadata.js';
import { procStartTicks, persistedProcessInteger, signalMarkedInvocationProcesses } from './process.js';
import {
  logPath,
  logSize,
  opencodeBackendEnv,
  readMeta,
  updateMeta,
  type StatePathsOptions,
} from './store.js';

const CONTROL_POLL_MS = 200;
const CONTROL_GRACE_MS = 10_000;

/**
 * The identity the launcher stamps on the runner it spawns, beside the argv it
 * already passes. Read only as corroboration for a reservation whose recorded
 * owner is no longer live, and never as a substitute for a verified identity
 * where one is available: see `verifyReservationOwner`.
 */
const RUNNER_AGENT_ENV = 'ANTONINA_AGENT_ID';
const RUNNER_GENERATION_ENV = 'ANTONINA_RUNNER_GEN';

export interface RunnerOptions extends StatePathsOptions {
  env?: Record<string, string | undefined>;
  /**
   * Seam for the host memory reading used to classify a death. Production
   * leaves it unset so the runner reads the real cgroup; tests point it at
   * synthetic values rather than asserting against live memory counters. It
   * affects diagnosis only: no reading here can refuse, delay or suppress a
   * launch.
   */
  capacity?: HostCapacityReadOptions;
  /**
   * Seam for the `/proc` reading that captures a just-spawned child's identity.
   * Production leaves it unset so the reading is the real one, which returns
   * `null` only when the process is genuinely gone from `/proc` by the time the
   * runner looks. Tests point it at `() => null` to drive the one branch that
   * is otherwise a race to lose: a backend that finishes before its identity
   * can be captured. It cannot grant a launch: the value it returns is the
   * value `recordSpawned` publishes and every later control path verifies.
   */
  childStartTicks?: (pid: number) => number | null;
}

/** The OOM bracket captured around one backend spawn. */
interface OomBracket {
  before: OomCounters | null;
  startedAt: number;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /**
   * True when this runner is the process that *delivered* the signal asking for
   * the invocation to end.
   *
   * A steer, a stop and a kill are all operator decisions, and this runner
   * signals the invocation for each of them. Without this flag the only
   * evidence available at death is the persisted intent, and the intent alone
   * cannot distinguish the death the operator asked for from a host kill that
   * happened to land while the intent was pending.
   *
   * "Delivered", not "asked for": `signalInvocation` returns whether it
   * actually sent anything, having refused on its identity checks. Recording the
   * attempt instead of the outcome told the classification that a death nobody
   * requested was the operator's, and a death on a signal under a `stop` or
   * `kill` intent was then recorded as a clean operator-initiated terminal
   * state with a null `error` and a null `backend_error` -- a SIGKILL from the
   * host, the OOM killer or anywhere else, recorded as if the operator had
   * asked for it and saying nothing at all about why it ended.
   *
   * Sticky once true: a later refused poll cannot un-deliver a signal that
   * already arrived, so this is a latch, not a snapshot of the last poll.
   */
  operatorSignalled: boolean;
  /**
   * True only when `signalInvocation` accepted at least one operator signal
   * for this invocation, i.e. the runtime delivered it to the backend process
   * group rather than only intending to.
   *
   * `operatorSignalled` is set before the send and whether or not it succeeds:
   * `signalInvocation` returns false whenever the durable identity no longer
   * resolves, or the pid/start-time/marker checks fail against live `/proc`, or
   * the signal itself fails. Without this second flag a refused signal is
   * indistinguishable from a delivered one in durable state.
   */
  operatorSignalDelivered: boolean;
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null;
  return constants.signals[signal] ?? null;
}

function childResult(child: ChildProcess, agentId: string, options: RunnerOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    let controlStartedAt: number | null = null;
    let operatorSignalled = false;
    let operatorSignalDelivered = false;
    const timer = setInterval(() => {
      const meta = readMeta(agentId, options);
      if (meta === null) return;
      const intent = persistedControlField(meta, 'intent');
      if (intent.malformed || intent.value === null) return;
      if (intent.value === 'kill') {
        operatorSignalled = true;
        if (signalInvocation(meta, 'SIGKILL')) operatorSignalDelivered = true;
        return;
      }
      if (intent.value === 'stop' || intent.value === 'steer') {
        if (controlStartedAt === null) controlStartedAt = Date.now();
        const signal = Date.now() - controlStartedAt >= CONTROL_GRACE_MS ? 'SIGKILL' : 'SIGTERM';
        operatorSignalled = true;
        if (signalInvocation(meta, signal)) operatorSignalDelivered = true;
      }
    }, CONTROL_POLL_MS);
    child.once('close', (code, signal) => {
      clearInterval(timer);
      resolve({ code, signal, operatorSignalled, operatorSignalDelivered });
    });
    child.once('error', () => {
      clearInterval(timer);
      resolve({ code: 127, signal: null, operatorSignalled, operatorSignalDelivered });
    });
  });
}

/**
 * What evidence the claiming runner has that the reservation it is about to
 * consume was written by whoever launched it.
 *
 * `self` -- the reservation names this process as its owner. A pid that
 * resolves to this very process is this process, so there is no second identity
 * it could be confused with.
 *
 * `parent` -- the reservation names the process that spawned this one, and the
 * recorded start time matches that live process in `/proc`. Pid plus start time,
 * never a pid alone (a recycled pid is a different process) and never a process
 * name (a name is not an identity, and is not consulted anywhere in this
 * package).
 *
 * `declared` -- the recorded owner names a process that is no longer live and
 * is not this process's parent. This is the ordinary detached launch: the CLI
 * writes the reservation, spawns the runner detached, and exits, so by the time
 * the runner reaches its first durable write the kernel has already reparented
 * it and there is no parent link left to verify. What remains is checked
 * instead: this runner cannot have existed before the recorded owner started,
 * and the launcher stamped this agent id and generation on the runner's own
 * environment beside the argv it passed.
 *
 * `refused` -- anything else, including a reservation whose recorded owner is a
 * *different* live process, a recorded start time that does not match the live
 * process it names, and any of the `declared` conditions failing.
 */
type OwnerIdentityVerdict = 'self' | 'parent' | 'declared' | 'refused';

function verifyReservationOwner(
  reservation: Record<string, unknown>,
  agentId: string,
  generation: number,
  env: Record<string, string | undefined>,
): OwnerIdentityVerdict {
  const ownerPid = persistedProcessInteger(reservation.owner_pid, 1);
  const ownerStart = persistedProcessInteger(reservation.owner_start_ticks, 0);
  if (ownerPid === null || ownerStart === null) return 'refused';
  if (ownerPid === process.pid) return 'self';
  const selfTicks = procStartTicks(process.pid);
  if (selfTicks === null) return 'refused';
  if (ownerPid === process.ppid) {
    if (ownerStart < 1) return 'refused';
    return procStartTicks(ownerPid) === ownerStart ? 'parent' : 'refused';
  }
  if (procStartTicks(ownerPid) !== null) return 'refused';
  if (selfTicks <= ownerStart) return 'refused';
  if (env[RUNNER_AGENT_ENV] !== agentId) return 'refused';
  if (env[RUNNER_GENERATION_ENV] !== String(generation)) return 'refused';
  return 'declared';
}

async function claimRunner(
  agentId: string,
  mode: 'new' | 'continue',
  generation: number,
  options: RunnerOptions,
): Promise<boolean> {
  let claimed = false;
  await updateMeta(agentId, (meta) => {
    if (deletePendingFlag(meta) !== false) return;
    const reservation = meta.runner_reservation;
    if (runnerReservationState(reservation) !== 'reserved') return;
    if (typeof reservation !== 'object' || reservation === null || Array.isArray(reservation)) return;
    const record = reservation as Record<string, unknown>;
    if (runnerGeneration(record.gen, 1) !== generation) return;
    if (runnerReservationMode(record) !== mode) return;
    // Board 197: a reservation is authority, and authority is claimed against
    // the identity that wrote it. Before this, a claim checked the
    // reservation's generation and mode and nothing else, so any process that
    // could name an agent id and a generation could consume any reservation
    // with that generation -- including one whose owner was alive and was
    // somebody else entirely. The check is pid plus start time against live
    // `/proc`, never a name.
    if (verifyReservationOwner(record, agentId, generation, options.env ?? process.env) === 'refused') return;
    meta.runner_pid = process.pid;
    meta.runner_start_time = procStartTicks(process.pid);
    meta.runner_reservation = { ...record, state: 'claimed' };
    meta.active_runner = true;
    meta.state = 'running';
    claimed = true;
  }, options);
  return claimed;
}

async function claimPendingPrompt(agentId: string, prompt: string, options: RunnerOptions): Promise<boolean> {
  let claimed = false;
  await updateMeta(agentId, (meta) => {
    if (deletePendingFlag(meta) !== false || stopLikeOrMalformed(meta)) return;
    if (pendingPrompt(meta) !== prompt) return;
    meta.pending_prompt = null;
    claimed = true;
  }, options);
  if (!claimed) {
    await updateMeta(agentId, (meta) => setActiveRunner(meta, false), options);
  }
  return claimed;
}

async function reclaimOrStop(agentId: string, options: RunnerOptions): Promise<boolean> {
  let busy = false;
  await updateMeta(agentId, (meta) => {
    if (stopLikeOrMalformed(meta)) {
      setActiveRunner(meta, false);
      return;
    }
    const prompt = pendingPrompt(meta);
    const sequence = steerSequence(meta);
    const queue = steerQueue(meta, sequence);
    if (sequence === null || queue === null) {
      setActiveRunner(meta, false);
      return;
    }
    if (prompt !== null) {
      meta.active_runner = true;
      busy = true;
      return;
    }
    if (queue.length > 0) {
      // The drained continuation begins where the log ends right now, so its own
      // run scope excludes everything the interrupted invocation wrote.
      popSteerIntoPending(meta, Date.now() / 1000, { logOffset: logSize(agentId, options) });
      meta.active_runner = true;
      busy = true;
      return;
    }
    setActiveRunner(meta, false);
  }, options);
  return busy;
}

async function recordSpawned(
  agentId: string,
  pid: number,
  startTicks: number | null,
  invocationId: string,
  launchCwd: string,
  options: RunnerOptions,
): Promise<boolean> {
  let accepted = false;
  await updateMeta(agentId, (meta) => {
    if (deletePendingFlag(meta) !== false || stopLikeOrMalformed(meta)) return;
    // Board issue 178: the observation is written here, in the same durable
    // write that publishes the spawned process identity, and nowhere earlier.
    // Everything that can precede a spawn -- accepting the prompt, queueing a
    // steer, refusing to continue, refusing to launch -- reaches this point
    // without a child, so this write is the first and only moment at which a
    // value here can be true. A value is therefore never a directory some front
    // was merely going to enter.
    meta.invocation_cwd = launchCwd;
    meta.pid = pid;
    meta.pgid = pid;
    meta.start_time = startTicks;
    meta.invocation_id = invocationId;
    meta.runner_pid = process.pid;
    meta.runner_start_time = procStartTicks(process.pid);
    meta.started_at = Date.now() / 1000;
    meta.last_activity_at = Date.now() / 1000;
    meta.state = 'running';
    meta.finished_at = null;
    meta.exit_code = null;
    meta.exit_signal = null;
    meta.backend_error = null;
    // As in `beginInvocation`: a note an earlier invocation recorded stays on
    // the record until some invocation replaces it. Every field that would give
    // it a run to belong to is reset just above, so it cannot be read as this
    // spawn's outcome, and `meta.backend_error` being cleared here is what
    // stops `displayableAgentError` from re-deriving and quoting it against this
    // record. Board issue 167 owns the recording policy and resolved it as
    // persistence.
    meta.active_runner = true;
    accepted = true;
  }, options);
  return accepted;
}

// A rejected spawn falls into two classes that must not be confused.
//
// If recordSpawned returned false, a control path committed between the
// runner's read of the record and its write of it and that path already owns
// the durable record, so the runner writes nothing. This helper is not for that
// case and must never be called for it.
//
// If recordSpawned threw, no control path committed anything: the write failed,
// so the spawn was never published, and the runner is left holding a claim
// (active_runner true, runner_reservation claimed), a consumed prompt, a
// `running` state and no pid. The child has just been killed. Nothing owns a
// terminal record, and that is the leak this releases.
//
// The guard is the class A invariant expressed as a condition rather than as a
// separate code path: a stop-like record, a terminal state, or a published
// spawn identity all mean some other actor already decided how this invocation
// ends, and this write must not overrule it.
async function releaseUnrecordedSpawn(agentId: string, options: RunnerOptions): Promise<void> {
  await updateMeta(agentId, (meta) => {
    if (stopLikeOrMalformed(meta)) {
      setActiveRunner(meta, false);
      return;
    }
    if (meta.state !== 'running' || meta.pid !== null) return;
    finalizeTerminal(
      meta,
      'failed',
      Date.now() / 1000,
      null,
      null,
      'could not persist the spawned OpenCode process identity; the process was killed and never recorded',
    );
    setActiveRunner(meta, false);
  }, options);
}

async function finalizeInvocation(
  agentId: string,
  result: ChildResult,
  backendError: BackendError | null,
  options: RunnerOptions,
  oom: OomBracket | null,
  isContinue: boolean,
  tailExcerpt: string | null = null,
): Promise<void> {
  // Read outside the metadata callback: the callback runs under the state lock,
  // and it should be doing durable-state work, not file I/O against /sys and
  // /proc. A death is classified from the bracket, not from a live reading.
  const oomAfter = readOomCounters(options.capacity);
  await updateMeta(agentId, (meta) => {
    if (meta.state !== 'running') return;
    const intent = persistedControlField(meta, 'intent');
    const stopReason = persistedControlField(meta, 'stop_reason');
    if (intent.malformed || stopReason.malformed) return;
    const signal = signalNumber(result.signal);
    const code = result.code ?? (signal === null ? 1 : -signal);
    // Every operator intent that ends an invocation does so because *this*
    // runner sent a signal for it, and the flag is set in the same poll that
    // sends it. So the flag is the evidence for all three intents, and the
    // persisted intent is not: an intent can be recorded and then lose the race
    // to a host SIGKILL landing inside a poll interval, in which case the
    // intent says the operator asked for this death and the flag says nobody
    // did. Keying stop and kill off the intent alone therefore still recorded a
    // host OOM kill as a clean `stopped` or `killed` with a null backend_error,
    // which is the exact failure this classification exists to remove. A
    // reparented runner does not weaken this argument: the poll belongs to the
    // process that spawned the child, and a reparented runner polls the *next*
    // invocation, never the one that just died under this process.
    //
    // The flag is the delivery, not the attempt: `signalInvocation` refuses on
    // its invocation-identity checks and says so, and a refusal means this
    // runner never got a signal into the invocation. Reading the attempt as if
    // it were the delivery classified a refused-signal death as the operator's,
    // which under `stop` and `kill` intent is the silence board 167 is about.
    const operatorSignalDelivered = result.operatorSignalDelivered;
    const externalSignalDeath = signal !== null && !operatorSignalDelivered;
    let state: 'succeeded' | 'failed' | 'stopped' | 'killed';
    if (intent.value === 'stop') state = 'stopped';
    else if (intent.value === 'kill') state = 'killed';
    else if (signal !== null) state = operatorSignalDelivered ? 'stopped' : 'failed';
    else state = code === 0 ? 'succeeded' : 'failed';
    // The pending steer is left recorded even when the invocation died without
    // it taking effect: the operator did ask for it, and `error` below names the
    // death that actually ended the invocation.
    meta.stop_reason = intent.value;
    // An unsignalled death on a signal was killed from outside the agent. This
    // is classified on the signal and the absence of a signalled request,
    // deliberately independent of the resulting state, so that no path through
    // the state mapping above can leave an external kill recorded as a clean
    // terminal state with a null backend error.
    const death = externalSignalDeath
      ? classifySignalDeath({
        signal,
        isContinue,
        before: oom?.before ?? null,
        after: oomAfter,
        lifetimeSeconds: oom === null ? null : Date.now() / 1000 - oom.startedAt,
      })
      : null;
    // A death on a signal is not a backend failure, whatever the log says: the
    // signal death (external) or the operator signal (clean stop/kill) already
    // accounts for it.
    meta.backend_error = code === 0 || signal !== null || death !== null ? death : backendError;
    // Board 159. A `failed` with no signal and a captured non-zero exit is the
    // backend saying it failed, and that record used to carry no reason at all:
    // `state failed`, `exit_code 1`, `backend_error null`, `error null`. It was
    // therefore indistinguishable, in durable state, from a record in which the
    // runtime lost the invocation before any exit status existed. The note names
    // which one this is, and it is only ever written for this path, so the
    // runtime-lost case keeps its own distinct wording from reconcileDeadMeta.
    //
    // A backend that *catches* the signal this runner sent and then exits
    // non-zero comes back from `close` as (code !== 0, signal === null) with
    // `operatorSignalled === true`, so the condition below matched an
    // operator-driven death too and recorded "the backend process exited
    // unsuccessfully" for a steer or stop the operator asked for, on a record
    // whose own `stop_reason` said the operator asked. `operatorSignalled` is
    // the runtime's evidence that it sent that signal itself, so it gates the
    // note: the same misattribution this note exists to remove, in the opposite
    // direction.
    //
    // That gate must not become a blanket either. `operatorSignalled` is set
    // before the send and regardless of whether it lands: `signalInvocation`
    // returns false when the durable identity no longer resolves or the
    // pid/start-time/marker checks fail against live `/proc`. In that case
    // nothing reaches the backend, the child keeps running and then dies on its
    // own, and suppressing the note would swallow an unexplained failure behind a
    // record that reads, field for field, like a delivered one. So the note is
    // withheld only when a signal was actually delivered, and otherwise it says
    // what was measured: the runtime did not deliver one.
    //
    // Board 167, second half. That withholding keys on the delivered-signal fact
    // and on nothing else. It used to also require `state === 'failed'`, which
    // is not a fact about this invocation at all -- it is one term of the state
    // mapping above, which honours the recorded intent -- so a refused `stop` or
    // `kill` produced `state stopped` / `state killed` with `error null` while
    // `backend_error.classification` said `unrecognized_backend_failure`: the
    // runtime knew the backend died, the operator signal was never delivered,
    // and the record claimed a clean operator stop and explained the failure
    // nowhere. The same evidence, the same delivery fact, a different terminal
    // state, and the reason disappeared with it.
    //
    // `code !== 0` and `signal === null` are kept: an invocation that exited
    // cleanly, or that died on a signal, has no unexplained non-signal exit to
    // account for, and a signal death is `death`'s subject above. What is left
    // is exactly "this invocation ended with a non-zero exit that nothing
    // explains, and no operator signal was delivered for it", which is the
    // shape the note describes.
    const note = death !== null
      ? describeSignalDeath(death) ?? undefined
      : code !== 0 && signal === null && !operatorSignalDelivered
        ? describeBackendDeath(backendError, tailExcerpt, result.operatorSignalled) ?? undefined
        : undefined;
    finalizeTerminal(meta, state, Date.now() / 1000, code, signal, note);
  }, options);
}

async function rememberFreshSession(agentId: string, options: RunnerOptions): Promise<void> {
  const meta = readMeta(agentId, options);
  if (meta === null || persistedNativeSessionId(meta) !== null) return;
  // Board 186: the probe must be given the same database the invocation was
  // given, or it asks the shared OpenCode database about a session the isolated
  // invocation wrote somewhere else and answers `null` for a session that
  // exists.
  const sessionId = discoverSessionId(agentId, { ...options.env, ...opencodeBackendEnv(meta, options) });
  if (sessionId === null) return;
  await updateMeta(agentId, (current) => {
    if (current.native_session_id === null) {
      current.native_session_id = sessionId;
    }
  }, options);
}

interface LaunchAuthorization {
  allowed: boolean;
  reason: string | null;
}

/**
 * The launch gate, re-decided at the only place a launch can happen.
 *
 * The capability gate the CLI applies at acceptance time (`requireInvocationCwdCapability`
 * in `packages/cli`) is an acceptance-time decision about a *declaration*: at
 * that moment nothing has been spawned, so a refusal writes nothing and costs
 * nothing. Board 197 is that the decision was never taken again afterwards. The
 * spawn path read the record, built a command from the declared directory and
 * called `spawn`, so a reservation accepted while the capability held could be
 * launched after it was withdrawn, and the backend ran in a directory whose
 * invocation-cwd capability no backend had answered for. Reproduced on this head:
 * with `ANTONINA_TEST_BACKEND_NO_INVOCATION_CWD=1` and a hand-written
 * reservation, `_runner` exited 0 and recorded `state succeeded` with
 * `invocation_cwd` set.
 *
 * So the acceptance-time answer is not trusted to survive: it is re-decided
 * here, from the same `backendCapabilities`/`honoursInvocationCwd` pair, and
 * `honoursInvocationCwd` fails closed on anything it does not recognise. What
 * spawn will accept is therefore not "a reservation once passed this gate" but
 * "the backend can still honour the directory this launch names, decided at the
 * moment of the spawn".
 *
 * The gate reads no durable record, and that is deliberate. Ownership of the
 * launch is already a durable fact re-verified at the only write that publishes
 * a spawned process (`recordSpawned`), whose rejection kills the process group
 * and leaves the control path's record whole; adding a second read here would
 * move the window in which a stop between the runner's read and its write is
 * observed, and would make this gate a second, weaker copy of an invariant that
 * is already enforced where it can be enforced atomically. This gate covers the
 * one thing the durable write cannot: the capability answer, which is not in
 * the record at all.
 */
async function authorizeLaunch(options: RunnerOptions): Promise<LaunchAuthorization> {
  const refused = (reason: string): LaunchAuthorization => ({ allowed: false, reason });
  if (!honoursInvocationCwd(backendCapabilities({ ...process.env, ...options.env }))) {
    return refused(
      'the configured backend cannot run this invocation in the declared working directory; refusing to spawn',
    );
  }
  // A runner that cannot name its own process in `/proc` cannot be the owner of
  // anything it then writes, so it does not get to launch.
  if (procStartTicks(process.pid) === null) {
    return refused('this runner cannot establish its own process identity; refusing to spawn');
  }
  return { allowed: true, reason: null };
}

async function runInvocation(
  agentId: string,
  prompt: string,
  isContinue: boolean,
  generation: number,
  options: RunnerOptions,
): Promise<boolean> {
  const meta = readMeta(agentId, options);
  if (meta === null) return false;
  let command: string[] | null;
  // Resolved once, from this one snapshot of the record, and then used for both
  // `--dir` and `spawn({cwd})` and for the observation written below. It is the
  // declaration (`cwd`) and never the observation (`invocation_cwd`): a value is
  // recorded only once a child exists, so launching from the declaration is what
  // keeps the observation an observation.
  let launchCwd: string;
  try {
    launchCwd = requiredAgentCwd(meta);
    // The same database the invocation will be spawned with, because
    // `buildAgentCommand` may itself probe for the session to continue.
    command = buildAgentCommand(meta, prompt, isContinue, { ...options.env, ...opencodeBackendEnv(meta, options) });
  } catch (error) {
    // A durable record the backend cannot be launched from -- an undeclared
    // working directory, a malformed one -- is a failed invocation with a
    // stated reason. Letting it escape would leave the runner holding a
    // reservation it never discharges.
    const reason = error instanceof Error ? error.message : String(error);
    await updateMeta(agentId, (current) => {
      finalizeTerminal(current, 'failed', Date.now() / 1000, null, null, reason);
      setActiveRunner(current, false);
    }, options);
    return false;
  }
  if (command === null) {
    await updateMeta(agentId, (current) => {
      finalizeTerminal(current, 'failed', Date.now() / 1000, null, null, 'cannot continue: underlying session not available');
      setActiveRunner(current, false);
    }, options);
    return false;
  }
  if (!await claimPendingPrompt(agentId, prompt, options)) return false;

  let attempt = 0;
  while (true) {
    // Inside the loop, not above it: a retry is a launch too, so every spawn
    // this invocation can perform is decided by the same gate against the
    // record as it stands at that moment. A refusal is a failed invocation with
    // a stated reason, exactly like the refusals above it, so the accepted
    // prompt is never left pending behind a front that will not run it.
    const authorization = await authorizeLaunch(options);
    if (!authorization.allowed) {
      await updateMeta(agentId, (current) => {
        finalizeTerminal(current, 'failed', Date.now() / 1000, null, null, authorization.reason!);
        setActiveRunner(current, false);
      }, options);
      return false;
    }
    const invocationId = randomBytes(16).toString('hex');
    const logFile = logPath(agentId, options);
    const fd = openSync(logFile, 'a', 0o600);
    const invocationLogStart = fstatSync(fd).size;
    const oom: OomBracket = { before: readOomCounters(options.capacity), startedAt: Date.now() / 1000 };
    const env = {
      ...process.env,
      ...options.env,
      ANTONINA_AGENT_ID: agentId,
      ANTONINA_INVOCATION_ID: invocationId,
      ANTONINA_PROMPT: prompt,
      NO_COLOR: '1',
      // Board 186. Spread last, so which database this front's session and
      // message writes go to is decided by this record and not inherited from
      // the runner's own environment. This is the whole fix for the
      // cross-front lock contention: OpenCode hardcodes `busy_timeout = 5000`
      // and turns a `database is locked` timeout into a fatal
      // `Failed to execute statement`, so the databases must not be shared.
      ...opencodeBackendEnv(meta, options),
    };
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd: launchCwd,
        env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      closeSync(fd);
      await updateMeta(agentId, (current) => {
        finalizeTerminal(current, 'failed', Date.now() / 1000, 127, null, String(error));
        setActiveRunner(current, false);
      }, options);
      return false;
    }
    closeSync(fd);
    const pid = child.pid;
    if (pid === undefined) {
      await updateMeta(agentId, (current) => {
        finalizeTerminal(current, 'failed', Date.now() / 1000, 127, null, 'OpenCode process had no pid');
        setActiveRunner(current, false);
      }, options);
      return false;
    }
    const resultPromise = childResult(child, agentId, options);
    const startTicks = (options.childStartTicks ?? procStartTicks)(pid);

    let result: ChildResult;
    if (startTicks === null) {
      const quick = await Promise.race([
        resultPromise.then((value) => ({ done: true as const, value })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 25)),
      ]);
      if (quick.done) {
        // The backend finished before /proc identity could be captured. There
        // is no live process left to control, so finalize the observed result
        // without persisting a partial identity.
        //
        // The observation is still recorded, because the child *was* spawned and
        // did run in `launchCwd`; only its process identity went unrecorded.
        // `recordSpawned` is the normal home for that write and is unreachable
        // here, so this is the one other place a front can be shown to have run
        // somewhere. Leaving it out would make `ran in:` wrong in the opposite
        // direction -- "never ran" for a front that ran.
        await updateMeta(agentId, (current) => {
          // The same ownership guard `recordSpawned` and
          // `releaseUnrecordedSpawn` apply: a stop-like record means some other
          // actor already decided how this invocation ends, and a runner that
          // has lost the record must not add a durable write to it.
          if (deletePendingFlag(current) !== false || stopLikeOrMalformed(current)) return;
          current.invocation_cwd = launchCwd;
        }, options);
        result = quick.value;
      } else {
        // A still-running process without durable identity cannot safely be
        // managed. Kill the process group and fail this accepted invocation.
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        result = await resultPromise;
        const signal = signalNumber(result.signal);
        const code = result.code ?? (signal === null ? 1 : -signal);
        await updateMeta(agentId, (current) => {
          finalizeTerminal(
            current,
            'failed',
            Date.now() / 1000,
            code,
            signal,
            'could not establish canonical OpenCode process identity',
          );
          setActiveRunner(current, false);
        }, options);
        return false;
      }
    } else {
      let accepted: boolean;
      try {
        accepted = await recordSpawned(agentId, pid, startTicks, invocationId, launchCwd, options);
      } catch (error) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        await resultPromise.catch(() => undefined);
        // The store failure still reaches the caller: a spawn that could not be
        // recorded is not a clean return. But the record must not be left
        // claiming a running invocation whose process no longer exists, so make
        // the release attempt first. It is best effort by construction, because
        // the same failing write may still be failing, and a release write that
        // throws must not replace the real diagnosis with the release's.
        try {
          await releaseUnrecordedSpawn(agentId, options);
        } catch {}
        throw error;
      }
      if (!accepted) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        await resultPromise.catch(() => undefined);
        return false;
      }
      result = await resultPromise;
    }

    // The backend leader may be gone while commands it launched survive in
    // different process groups. Reap by the unique inherited invocation
    // markers before retrying or finalizing this invocation.
    signalMarkedInvocationProcesses(agentId, invocationId, 'SIGKILL');

    const signal = signalNumber(result.signal);
    const code = result.code ?? (signal === null ? 1 : -signal);
    const backendError = classifyBackendFailure(logFile, invocationLogStart, code, isContinue);
    const retryDelay = backendRetryDelay(backendError, attempt);
    if (retryDelay !== null) {
      await updateMeta(agentId, (current) => {
        current.backend_error = backendError;
        current.last_activity_at = Date.now() / 1000;
      }, options);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      attempt += 1;
      continue;
    }

    // A fresh OpenCode invocation may create its session before a steer/stop
    // interrupts it. Preserve that session whenever it can be discovered so
    // queued steering continues the same native conversation.
    if (!isContinue) await rememberFreshSession(agentId, options);
    // Only read for a note: a successful exit and a signalled death both ignore
    // it, so the file is not read on the paths where nothing is written.
    const tailExcerpt = code !== 0 && result.signal === null ? lastLogLineExcerpt(logFile, invocationLogStart) : null;
    await finalizeInvocation(agentId, result, backendError, options, oom, isContinue, tailExcerpt);
    return true;
  }
}

export async function runManagedRunner(
  agentId: string,
  mode: 'new' | 'continue',
  generation: number,
  options: RunnerOptions = {},
): Promise<void> {
  if (!await claimRunner(agentId, mode, generation, options)) return;
  let isContinue = mode === 'continue';
  while (true) {
    const meta = readMeta(agentId, options);
    if (meta === null || deletePendingFlag(meta) !== false || activeRunnerFlag(meta) !== true) return;
    const prompt = pendingPrompt(meta);
    if (prompt === null) {
      if (await reclaimOrStop(agentId, options)) continue;
      return;
    }
    if (!await runInvocation(agentId, prompt, isContinue, generation, options)) return;
    isContinue = true;
    if (!await reclaimOrStop(agentId, options)) return;
  }
}
