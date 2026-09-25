import {
  CONTROL_REASONS,
  STOP_REASONS,
  activeRunnerFlag,
  nextPromptCount,
  pendingPrompt,
  persistedControlField,
  persistedLifecycleState,
  persistedTimestamp,
  runnerGeneration,
  runnerReservationMode,
  runnerReservationState,
  type AgentMetadata,
  type PersistedAgentState,
} from './metadata.js';
import {
  isIdentityAlive,
  persistedAgentId,
  persistedInvocationId,
  persistedProcessInteger,
  procStartTicks,
  signalGroupChecked,
  signalIdentityChecked,
  type ProcessIdentity,
  type ProcessProbeOptions,
} from './process.js';

export const PID_START_WINDOW_SECONDS = 60;

export interface InvocationIdentity extends ProcessIdentity {
  pgid: number;
}

export interface RunnerIdentity extends ProcessIdentity {}

export function invocationIdentity(meta: AgentMetadata): InvocationIdentity | null {
  const pid = persistedProcessInteger(meta.pid, 1);
  const pgid = meta.pgid === null || meta.pgid === undefined
    ? pid
    : persistedProcessInteger(meta.pgid, 1);
  const startTicks = persistedProcessInteger(meta.start_time, 0);
  const agentId = persistedAgentId(meta.id);
  if (pid === null || pgid === null || startTicks === null || agentId === null) return null;
  let invocationId: string | undefined;
  if (meta.invocation_id !== null && meta.invocation_id !== undefined) {
    const parsed = persistedInvocationId(meta.invocation_id);
    if (parsed === null) return null;
    invocationId = parsed;
  }
  return invocationId === undefined
    ? { pid, pgid, startTicks, agentId }
    : { pid, pgid, startTicks, agentId, invocationId };
}

export function runnerIdentity(meta: AgentMetadata): RunnerIdentity | null {
  const pid = persistedProcessInteger(meta.runner_pid, 1);
  const startTicks = persistedProcessInteger(meta.runner_start_time, 0);
  const agentId = persistedAgentId(meta.id);
  return pid === null || startTicks === null || agentId === null
    ? null
    : { pid, startTicks, agentId };
}

export function invocationAlive(meta: AgentMetadata, options: ProcessProbeOptions = {}): boolean {
  const identity = invocationIdentity(meta);
  return identity !== null && isIdentityAlive(identity, options);
}

export function runnerAlive(meta: AgentMetadata, options: ProcessProbeOptions = {}): boolean {
  const identity = runnerIdentity(meta);
  return identity !== null && isIdentityAlive(identity, options);
}

export function deriveState(meta: AgentMetadata | null, now = Date.now() / 1000): PersistedAgentState | 'unknown' {
  if (meta === null) return 'unknown';
  const state = persistedLifecycleState(meta);
  if (state === null) return 'unknown';
  if (state !== 'running') return state;
  if (invocationAlive(meta)) return 'running';
  if (meta.pid === null || meta.pid === undefined) {
    const launched = persistedTimestamp(meta.started_at) ?? persistedTimestamp(meta.created_at);
    if (launched !== null && now >= launched && now - launched < PID_START_WINDOW_SECONDS) return 'running';
  }
  return 'unknown';
}

export function exitCodeFor(meta: AgentMetadata | null): number {
  const state = deriveState(meta);
  if (state === 'succeeded') return 0;
  if (state === 'failed') {
    const value = meta?.exit_code;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
  }
  return 1;
}

export function setActiveRunner(meta: AgentMetadata, value: boolean): void {
  meta.active_runner = value;
  if (!value) meta.runner_reservation = null;
}

export function beginInvocation(meta: AgentMetadata, prompt: string, now: number, promptCount: number): void {
  meta.state = 'running';
  meta.started_at = now;
  meta.last_activity_at = now;
  meta.finished_at = null;
  meta.exit_code = null;
  meta.exit_signal = null;
  meta.intent = null;
  meta.stop_reason = null;
  meta.pid = null;
  meta.pgid = null;
  meta.start_time = null;
  meta.invocation_id = null;
  meta.pending_prompt = prompt;
  meta.last_prompt = prompt.slice(0, 500);
  meta.prompt_count = promptCount;
}

export function finalizeTerminal(
  meta: AgentMetadata,
  state: 'succeeded' | 'failed' | 'stopped' | 'killed',
  now: number,
  exitCode: number | null,
  exitSignal: number | null,
  note?: string,
): void {
  meta.state = state;
  meta.exit_code = exitCode;
  meta.exit_signal = exitSignal;
  meta.finished_at = now;
  meta.last_activity_at = now;
  const intent = persistedControlField(meta, 'intent');
  if (!intent.malformed) meta.intent = null;
  if (note) meta.error = note;
}

export interface SteerItem {
  seq: number;
  prompt: string;
  queued_at: number;
}

export function steerSequence(meta: AgentMetadata): number | null {
  if (!Object.hasOwn(meta, 'steer_seq')) return 0;
  const value = meta.steer_seq;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function steerQueue(meta: AgentMetadata, sequence = steerSequence(meta)): SteerItem[] | null {
  if (sequence === null) return null;
  if (!Object.hasOwn(meta, 'steer_queue')) return [];
  const value = meta.steer_queue;
  if (!Array.isArray(value)) return null;
  const result: SteerItem[] = [];
  let previous = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const seq = record.seq;
    const prompt = record.prompt;
    const queuedAt = record.queued_at;
    if (
      typeof seq !== 'number'
      || !Number.isSafeInteger(seq)
      || seq <= previous
      || seq > sequence
      || typeof prompt !== 'string'
      || prompt.length === 0
      || typeof queuedAt !== 'number'
      || !Number.isFinite(queuedAt)
    ) return null;
    result.push({ seq, prompt, queued_at: queuedAt });
    previous = seq;
  }
  return result;
}

export function queueSteer(meta: AgentMetadata, prompt: string, now: number): boolean {
  const sequence = steerSequence(meta);
  const queue = steerQueue(meta, sequence);
  if (sequence === null || queue === null || prompt.length === 0) return false;
  const seq = sequence + 1;
  queue.push({ seq, prompt, queued_at: now });
  meta.steer_queue = queue;
  meta.steer_seq = seq;
  meta.last_activity_at = now;
  return true;
}

export function popSteerIntoPending(meta: AgentMetadata, now: number): string | null {
  const count = nextPromptCount(meta);
  const sequence = steerSequence(meta);
  const queue = steerQueue(meta, sequence);
  if (count === null || sequence === null || queue === null || queue.length === 0) return null;
  const item = queue.shift();
  if (!item) return null;
  meta.steer_queue = queue;
  beginInvocation(meta, item.prompt, now, count);
  return item.prompt;
}

export function stopLikeOrMalformed(meta: AgentMetadata): boolean {
  const intent = persistedControlField(meta, 'intent');
  const reason = persistedControlField(meta, 'stop_reason');
  return intent.malformed
    || reason.malformed
    || (intent.value !== null && (STOP_REASONS as readonly string[]).includes(intent.value))
    || (reason.value !== null && (STOP_REASONS as readonly string[]).includes(reason.value));
}

export function beginStopLike(meta: AgentMetadata, intent: 'stop' | 'kill', now: number): boolean {
  if (!(CONTROL_REASONS as readonly string[]).includes(intent)) return false;
  try {
    pendingPrompt(meta);
  } catch {
    return false;
  }
  if (runnerReservationState(meta.runner_reservation) === 'malformed') return false;
  meta.intent = intent;
  meta.last_activity_at = now;
  meta.steer_queue = [];
  meta.pending_prompt = null;
  return true;
}

export function reservationInFlight(meta: AgentMetadata): boolean {
  const active = activeRunnerFlag(meta);
  if (active === null) return true;
  if (!active) return false;
  if (runnerAlive(meta)) return true;
  const state = runnerReservationState(meta.runner_reservation);
  if (state === 'malformed') return true;
  if (state !== 'reserved') return false;
  const reservation = meta.runner_reservation as Record<string, unknown>;
  return runnerGeneration(reservation.gen, 1) !== null && runnerReservationMode(reservation) !== null;
}

export function signalInvocation(
  meta: AgentMetadata,
  signal: NodeJS.Signals | number,
  options: ProcessProbeOptions = {},
): boolean {
  const identity = invocationIdentity(meta);
  if (identity === null) return false;
  return signalGroupChecked(identity, identity.pgid, signal, options);
}

export function signalRunner(
  meta: AgentMetadata,
  signal: NodeJS.Signals | number,
  options: ProcessProbeOptions = {},
): boolean {
  const identity = runnerIdentity(meta);
  if (identity === null) return false;
  return signalIdentityChecked(identity, signal, options);
}

export async function waitForInvocationGone(
  meta: AgentMetadata,
  timeoutMs: number,
  options: ProcessProbeOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!invocationAlive(meta, options)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !invocationAlive(meta, options);
}

export function currentProcessStartTicks(): number | null {
  return procStartTicks(process.pid);
}
