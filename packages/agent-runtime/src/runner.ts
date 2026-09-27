import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { constants } from 'node:os';

import {
  backendRetryDelay,
  buildAgentCommand,
  classifyBackendFailure,
  classifySignalDeath,
  describeSignalDeath,
  discoverSessionId,
  type BackendError,
} from './backend.js';
import {
  checkHostLaunchCapacity,
  readOomCounters,
  type CapacityDecisionOptions,
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
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  type AgentMetadata,
} from './metadata.js';
import { procStartTicks } from './process.js';
import {
  logPath,
  readMeta,
  updateMeta,
  type StatePathsOptions,
} from './store.js';

const CONTROL_POLL_MS = 200;
const CONTROL_GRACE_MS = 10_000;

export interface RunnerOptions extends StatePathsOptions {
  env?: Record<string, string | undefined>;
  /**
   * Seam for the host capacity reading. Production leaves it unset so the
   * runner reads the real cgroup; tests point it at synthetic values rather
   * than asserting against live memory counters.
   */
  capacity?: HostCapacityReadOptions & CapacityDecisionOptions;
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
   * True when this runner is the process that asked for the invocation to end.
   *
   * A steer, a stop and a kill are all operator decisions, and this runner
   * signals the invocation for each of them. Without this flag the only
   * evidence available at death is the persisted intent, and the intent alone
   * cannot distinguish the death the operator asked for from a host kill that
   * happened to land while the intent was pending.
   */
  operatorSignalled: boolean;
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null;
  return constants.signals[signal] ?? null;
}

function childResult(child: ChildProcess, agentId: string, options: RunnerOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    let controlStartedAt: number | null = null;
    let operatorSignalled = false;
    const timer = setInterval(() => {
      const meta = readMeta(agentId, options);
      if (meta === null) return;
      const intent = persistedControlField(meta, 'intent');
      if (intent.malformed || intent.value === null) return;
      if (intent.value === 'kill') {
        operatorSignalled = true;
        signalInvocation(meta, 'SIGKILL');
        return;
      }
      if (intent.value === 'stop' || intent.value === 'steer') {
        if (controlStartedAt === null) controlStartedAt = Date.now();
        const signal = Date.now() - controlStartedAt >= CONTROL_GRACE_MS ? 'SIGKILL' : 'SIGTERM';
        operatorSignalled = true;
        signalInvocation(meta, signal);
      }
    }, CONTROL_POLL_MS);
    child.once('close', (code, signal) => {
      clearInterval(timer);
      resolve({ code, signal, operatorSignalled });
    });
    child.once('error', () => {
      clearInterval(timer);
      resolve({ code: 127, signal: null, operatorSignalled });
    });
  });
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
      popSteerIntoPending(meta, Date.now() / 1000);
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
  options: RunnerOptions,
): Promise<boolean> {
  let accepted = false;
  await updateMeta(agentId, (meta) => {
    if (deletePendingFlag(meta) !== false || stopLikeOrMalformed(meta)) return;
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
    meta.active_runner = true;
    accepted = true;
  }, options);
  return accepted;
}

async function finalizeInvocation(
  agentId: string,
  result: ChildResult,
  backendError: BackendError | null,
  options: RunnerOptions,
  oom: OomBracket | null,
  isContinue: boolean,
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
    // A stop and a kill are operator requests by construction. A steer is an
    // operator request too, but it is a *redirect*: the invocation is signalled
    // because this runner sent a signal for it, and `operatorSignalled` is the
    // only evidence separating that death from a host kill that happened to land
    // while the steer was still pending. Keying this off the persisted intent
    // alone made those two indistinguishable, which is what recorded a long
    // steered session killed by the OOM killer as a clean `stopped`.
    const operatorSignalled = intent.value === 'stop'
      || intent.value === 'kill'
      || (intent.value === 'steer' && result.operatorSignalled);
    const externalSignalDeath = signal !== null && !operatorSignalled;
    let state: 'succeeded' | 'failed' | 'stopped' | 'killed';
    if (intent.value === 'stop') state = 'stopped';
    else if (intent.value === 'kill') state = 'killed';
    else if (signal !== null) state = operatorSignalled ? 'stopped' : 'failed';
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
    meta.backend_error = code === 0 || death !== null ? death : backendError;
    finalizeTerminal(meta, state, Date.now() / 1000, code, signal, death === null ? undefined : describeSignalDeath(death) ?? undefined);
  }, options);
}

async function rememberFreshSession(agentId: string, options: RunnerOptions): Promise<void> {
  const meta = readMeta(agentId, options);
  if (meta === null || persistedNativeSessionId(meta) !== null) return;
  const sessionId = discoverSessionId(agentId, options.env);
  if (sessionId === null) return;
  await updateMeta(agentId, (current) => {
    if (current.native_session_id === null) {
      current.native_session_id = sessionId;
    }
  }, options);
}

async function runInvocation(
  agentId: string,
  prompt: string,
  isContinue: boolean,
  options: RunnerOptions,
): Promise<boolean> {
  const meta = readMeta(agentId, options);
  if (meta === null) return false;
  const command = buildAgentCommand(meta, prompt, isContinue, options.env);
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
    // Read the host before spawning, not after: the point of this guard is
    // that an operator learns the host is full *instead of* learning it from a
    // SIGKILL and an empty log twenty minutes later.
    const decision = checkHostLaunchCapacity({ env: options.env, ...options.capacity });
    if (decision.outcome === 'refused') {
      await updateMeta(agentId, (current) => {
        finalizeTerminal(current, 'failed', Date.now() / 1000, null, null, decision.reason);
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
    };
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd: String(meta.cwd),
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
    const startTicks = procStartTicks(pid);

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
        accepted = await recordSpawned(agentId, pid, startTicks, invocationId, options);
      } catch (error) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        await resultPromise.catch(() => undefined);
        throw error;
      }
      if (!accepted) {
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        await resultPromise.catch(() => undefined);
        return false;
      }
      result = await resultPromise;
    }

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
    await finalizeInvocation(agentId, result, backendError, options, oom, isContinue);
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
    if (!await runInvocation(agentId, prompt, isContinue, options)) return;
    isContinue = true;
    if (!await reclaimOrStop(agentId, options)) return;
  }
}
