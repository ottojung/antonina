import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { constants } from 'node:os';

import { backendRetryDelay, buildAgentCommand, classifyBackendFailure, discoverSessionId, type BackendError } from './backend.js';
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
  agentDir,
  logPath,
  readMeta,
  updateMeta,
  type StatePathsOptions,
} from './store.js';

const CONTROL_POLL_MS = 200;
const CONTROL_GRACE_MS = 10_000;

export interface RunnerOptions extends StatePathsOptions {
  env?: Record<string, string | undefined>;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null;
  return constants.signals[signal] ?? null;
}

function childResult(child: ChildProcess, agentId: string, options: RunnerOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    let controlStartedAt: number | null = null;
    const timer = setInterval(() => {
      const meta = readMeta(agentId, options);
      if (meta === null) return;
      const intent = persistedControlField(meta, 'intent');
      if (intent.malformed || intent.value === null) return;
      if (intent.value === 'kill') {
        signalInvocation(meta, 'SIGKILL');
        return;
      }
      if (intent.value === 'stop' || intent.value === 'steer') {
        if (controlStartedAt === null) controlStartedAt = Date.now();
        const signal = Date.now() - controlStartedAt >= CONTROL_GRACE_MS ? 'SIGKILL' : 'SIGTERM';
        signalInvocation(meta, signal);
      }
    }, CONTROL_POLL_MS);
    child.once('close', (code, signal) => {
      clearInterval(timer);
      resolve({ code, signal });
    });
    child.once('error', () => {
      clearInterval(timer);
      resolve({ code: 127, signal: null });
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
): Promise<void> {
  await updateMeta(agentId, (meta) => {
    if (meta.state !== 'running') return;
    const intent = persistedControlField(meta, 'intent');
    const stopReason = persistedControlField(meta, 'stop_reason');
    if (intent.malformed || stopReason.malformed) return;
    const signal = signalNumber(result.signal);
    const code = result.code ?? (signal === null ? 1 : -signal);
    let state: 'succeeded' | 'failed' | 'stopped' | 'killed';
    if (intent.value === 'stop') state = 'stopped';
    else if (intent.value === 'kill') state = 'killed';
    else if (intent.value === 'steer') state = signal !== null ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
    else state = code === 0 ? 'succeeded' : 'failed';
    meta.stop_reason = intent.value;
    meta.backend_error = code === 0 ? null : backendError;
    finalizeTerminal(meta, state, Date.now() / 1000, code, signal);
  }, options);
}

async function rememberFreshSession(agentId: string, options: RunnerOptions): Promise<void> {
  const meta = readMeta(agentId, options);
  if (meta === null || persistedNativeSessionId(meta) !== null) return;
  const sessionId = discoverSessionId(agentId, options.env);
  if (sessionId === null) return;
  await updateMeta(agentId, (current) => {
    if (current.native_session_id === null || current.native_session_id === undefined) {
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
    const invocationId = randomBytes(16).toString('hex');
    const directory = agentDir(agentId, options);
    mkdirSync(directory, { recursive: true });
    const logFile = logPath(agentId, options);
    const fd = openSync(logFile, 'a', 0o600);
    const invocationLogStart = fstatSync(fd).size;
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
    const accepted = await recordSpawned(agentId, pid, procStartTicks(pid), invocationId, options);
    if (!accepted) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      return false;
    }

    const result = await childResult(child, agentId, options);
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
    await finalizeInvocation(agentId, result, backendError, options);
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
