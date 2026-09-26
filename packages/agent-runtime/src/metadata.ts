import { isAbsolute } from 'node:path';

import { persistedAgentId, persistedInvocationId, persistedProcessInteger } from './process.js';

export const AGENT_META_VERSION = 4;
export const DEFAULT_VARIANT = 'low';
export const TERMINAL_STATES = ['succeeded', 'failed', 'stopped', 'killed'] as const;
export const PERSISTED_AGENT_STATES = ['idle', 'running', ...TERMINAL_STATES] as const;
export const CONTROL_REASONS = ['steer', 'stop', 'kill'] as const;
export const STOP_REASONS = ['stop', 'kill'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];
export type PersistedAgentState = (typeof PERSISTED_AGENT_STATES)[number];
export type ControlReason = (typeof CONTROL_REASONS)[number];
export type RunnerReservationState = 'absent' | 'reserved' | 'claimed' | 'malformed';
export type RunnerReservationMode = 'new' | 'continue';
export type AgentMetadata = Record<string, unknown>;

const TOP_LEVEL_FIELDS = [
  'id',
  'created_at',
  'last_activity_at',
  'state',
  'cwd',
  'title',
  'variant',
  'native_session_id',
  'pid',
  'pgid',
  'start_time',
  'invocation_id',
  'runner_pid',
  'runner_start_time',
  'started_at',
  'finished_at',
  'exit_code',
  'exit_signal',
  'backend_error',
  'intent',
  'delete_pending',
  'stop_reason',
  'active_runner',
  'runner_gen',
  'runner_reservation',
  'steer_queue',
  'steer_seq',
  'prompt_count',
  'pending_prompt',
  'last_prompt',
  'error',
  'agent_version',
] as const;

const BACKEND_ERROR_FIELDS = [
  'classification',
  'provider',
  'model',
  'request_boundary',
  'reference',
  'transient',
  'automatic_retry_safe',
  'fresh_session_useful',
  'backend_scope',
  'diagnostic_bytes',
] as const;

export class MalformedPendingPromptMetadataError extends Error {
  constructor() {
    super('persisted pending prompt authority is not canonical');
    this.name = 'MalformedPendingPromptMetadataError';
  }
}

export class MalformedAgentMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedAgentMetadataError';
  }
}

function hasOwn(meta: AgentMetadata, key: string): boolean {
  return Object.hasOwn(meta, key);
}

function exactKeys(record: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function nullableString(value: unknown, allowEmpty = false): boolean {
  return value === null || (typeof value === 'string' && (allowEmpty || value.length > 0));
}

function nullableInteger(value: unknown, minimum: number): boolean {
  return value === null || persistedProcessInteger(value, minimum) !== null;
}

function canonicalControl(value: unknown): boolean {
  return value === null || (typeof value === 'string' && (CONTROL_REASONS as readonly string[]).includes(value));
}

function canonicalBackendError(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, BACKEND_ERROR_FIELDS)) return false;
  if (typeof record.classification !== 'string' || record.classification.length === 0 || record.classification.length > 80) return false;
  for (const key of ['provider', 'model', 'reference', 'backend_scope'] as const) {
    if (!nullableString(record[key], false)) return false;
    if (typeof record[key] === 'string' && record[key].length > 200) return false;
  }
  if (
    record.request_boundary !== null
    && record.request_boundary !== 'fresh_session'
    && record.request_boundary !== 'continuation'
  ) return false;
  if (typeof record.transient !== 'boolean' || typeof record.automatic_retry_safe !== 'boolean') return false;
  if (record.fresh_session_useful !== null && typeof record.fresh_session_useful !== 'boolean') return false;
  if (
    typeof record.diagnostic_bytes !== 'number'
    || !Number.isSafeInteger(record.diagnostic_bytes)
    || record.diagnostic_bytes < 0
    || record.diagnostic_bytes > 16 * 1024
  ) return false;
  return true;
}

function canonicalReservation(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = ['state', 'gen', 'owner_pid', 'owner_start_ticks', 'reserved_at', 'mode'] as const;
  if (!exactKeys(record, fields)) return false;
  if (record.state !== 'reserved' && record.state !== 'claimed') return false;
  if (runnerGeneration(record.gen, 1) === null) return false;
  if (persistedProcessInteger(record.owner_pid, 1) === null) return false;
  if (!nullableInteger(record.owner_start_ticks, 0)) return false;
  if (persistedTimestamp(record.reserved_at) === null) return false;
  return record.mode === 'new' || record.mode === 'continue';
}

function canonicalSteerQueue(value: unknown, sequence: number): boolean {
  if (!Array.isArray(value)) return false;
  let previous = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (!exactKeys(record, ['seq', 'prompt', 'queued_at'])) return false;
    if (
      typeof record.seq !== 'number'
      || !Number.isSafeInteger(record.seq)
      || record.seq <= previous
      || record.seq > sequence
      || typeof record.prompt !== 'string'
      || record.prompt.length === 0
      || persistedTimestamp(record.queued_at) === null
    ) return false;
    previous = record.seq;
  }
  return true;
}

export function validateAgentMetadata(meta: AgentMetadata): void {
  if (!exactKeys(meta, TOP_LEVEL_FIELDS)) {
    throw new MalformedAgentMetadataError('managed-agent metadata fields are not canonical');
  }
  if (meta.agent_version !== AGENT_META_VERSION) {
    throw new MalformedAgentMetadataError(`unsupported managed-agent metadata version: ${String(meta.agent_version)}`);
  }
  if (persistedAgentId(meta.id) === null) throw new MalformedAgentMetadataError('managed-agent id is malformed');
  if (persistedTimestamp(meta.created_at) === null) throw new MalformedAgentMetadataError('managed-agent created_at is malformed');
  if (persistedTimestamp(meta.last_activity_at) === null) throw new MalformedAgentMetadataError('managed-agent last_activity_at is malformed');
  if (persistedLifecycleState(meta) === null) throw new MalformedAgentMetadataError('managed-agent state is malformed');
  persistedAgentCwd(meta);
  if (!nullableString(meta.title, true)) throw new MalformedAgentMetadataError('managed-agent title is malformed');
  persistedVariant(meta);
  persistedNativeSessionId(meta);

  const pidFields = [meta.pid, meta.pgid, meta.start_time, meta.invocation_id];
  const invocationAbsent = pidFields.every((value) => value === null);
  const invocationPresent = (
    persistedProcessInteger(meta.pid, 1) !== null
    && persistedProcessInteger(meta.pgid, 1) !== null
    && persistedProcessInteger(meta.start_time, 0) !== null
    && persistedInvocationId(meta.invocation_id) !== null
  );
  if (!invocationAbsent && !invocationPresent) {
    throw new MalformedAgentMetadataError('managed-agent invocation identity is malformed');
  }

  const runnerAbsent = meta.runner_pid === null && meta.runner_start_time === null;
  const runnerPresent = (
    persistedProcessInteger(meta.runner_pid, 1) !== null
    && persistedProcessInteger(meta.runner_start_time, 0) !== null
  );
  if (!runnerAbsent && !runnerPresent) {
    throw new MalformedAgentMetadataError('managed-agent runner identity is malformed');
  }

  for (const [key, value] of [['started_at', meta.started_at], ['finished_at', meta.finished_at]] as const) {
    if (value !== null && persistedTimestamp(value) === null) {
      throw new MalformedAgentMetadataError(`managed-agent ${key} is malformed`);
    }
  }
  if (meta.exit_code !== null && (typeof meta.exit_code !== 'number' || !Number.isSafeInteger(meta.exit_code))) {
    throw new MalformedAgentMetadataError('managed-agent exit_code is malformed');
  }
  if (meta.exit_signal !== null && persistedProcessInteger(meta.exit_signal, 1) === null) {
    throw new MalformedAgentMetadataError('managed-agent exit_signal is malformed');
  }
  if (!canonicalBackendError(meta.backend_error)) {
    throw new MalformedAgentMetadataError('managed-agent backend_error is malformed');
  }
  if (!canonicalControl(meta.intent)) throw new MalformedAgentMetadataError('managed-agent intent is malformed');
  if (typeof meta.delete_pending !== 'boolean') throw new MalformedAgentMetadataError('managed-agent delete_pending is malformed');
  if (!canonicalControl(meta.stop_reason)) throw new MalformedAgentMetadataError('managed-agent stop_reason is malformed');
  if (typeof meta.active_runner !== 'boolean') throw new MalformedAgentMetadataError('managed-agent active_runner is malformed');
  if (runnerGeneration(meta.runner_gen, 0) === null) throw new MalformedAgentMetadataError('managed-agent runner_gen is malformed');
  if (!canonicalReservation(meta.runner_reservation)) {
    throw new MalformedAgentMetadataError('managed-agent runner_reservation is malformed');
  }
  const sequence = steerSequence(meta);
  if (sequence === null) throw new MalformedAgentMetadataError('managed-agent steer_seq is malformed');
  if (!canonicalSteerQueue(meta.steer_queue, sequence)) {
    throw new MalformedAgentMetadataError('managed-agent steer_queue is malformed');
  }
  if (
    typeof meta.prompt_count !== 'number'
    || !Number.isSafeInteger(meta.prompt_count)
    || meta.prompt_count < 0
  ) throw new MalformedAgentMetadataError('managed-agent prompt_count is malformed');
  pendingPrompt(meta);
  if (
    meta.last_prompt !== null
    && (typeof meta.last_prompt !== 'string' || meta.last_prompt.length === 0 || meta.last_prompt.length > 500)
  ) throw new MalformedAgentMetadataError('managed-agent last_prompt is malformed');
  if (meta.error !== null && (typeof meta.error !== 'string' || meta.error.length === 0)) {
    throw new MalformedAgentMetadataError('managed-agent error is malformed');
  }
}

export function persistedLifecycleState(meta: AgentMetadata): PersistedAgentState | null {
  if (!hasOwn(meta, 'state')) return null;
  const value = meta.state;
  return typeof value === 'string' && (PERSISTED_AGENT_STATES as readonly string[]).includes(value)
    ? value as PersistedAgentState
    : null;
}

export function pendingPrompt(meta: AgentMetadata): string | null {
  if (!hasOwn(meta, 'pending_prompt')) throw new MalformedPendingPromptMetadataError();
  if (meta.pending_prompt === null) return null;
  const value = meta.pending_prompt;
  if (typeof value !== 'string' || value.length === 0) throw new MalformedPendingPromptMetadataError();
  return value;
}

export function runnerGeneration(value: unknown, minimum = 1): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

export function runnerReservationState(reservation: unknown): RunnerReservationState {
  if (reservation === null) return 'absent';
  if (reservation === undefined || typeof reservation !== 'object' || Array.isArray(reservation)) return 'malformed';
  const state = (reservation as Record<string, unknown>).state;
  return state === 'reserved' || state === 'claimed' ? state : 'malformed';
}

export function runnerReservationMode(reservation: unknown): RunnerReservationMode | null {
  if (typeof reservation !== 'object' || reservation === null || Array.isArray(reservation)) return null;
  const mode = (reservation as Record<string, unknown>).mode;
  return mode === 'new' || mode === 'continue' ? mode : null;
}

export function nextPromptCount(meta: AgentMetadata): number | null {
  if (!hasOwn(meta, 'prompt_count')) return null;
  const value = meta.prompt_count;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value + 1 : null;
}

export function activeRunnerFlag(meta: AgentMetadata): boolean | null {
  if (!hasOwn(meta, 'active_runner')) return null;
  return typeof meta.active_runner === 'boolean' ? meta.active_runner : null;
}

export function deletePendingFlag(meta: AgentMetadata): boolean | null {
  if (!hasOwn(meta, 'delete_pending')) return null;
  return typeof meta.delete_pending === 'boolean' ? meta.delete_pending : null;
}

export function persistedControlField(
  meta: AgentMetadata,
  key: 'intent' | 'stop_reason',
): { value: ControlReason | null; malformed: boolean } {
  if (!hasOwn(meta, key)) return { value: null, malformed: true };
  if (meta[key] === null) return { value: null, malformed: false };
  const value = meta[key];
  if (typeof value !== 'string' || !(CONTROL_REASONS as readonly string[]).includes(value)) {
    return { value: null, malformed: true };
  }
  return { value: value as ControlReason, malformed: false };
}

export function stopLikeOrMalformed(meta: AgentMetadata): boolean {
  const intent = persistedControlField(meta, 'intent');
  const stopReason = persistedControlField(meta, 'stop_reason');
  return intent.malformed
    || stopReason.malformed
    || (intent.value !== null && (STOP_REASONS as readonly string[]).includes(intent.value))
    || (stopReason.value !== null && (STOP_REASONS as readonly string[]).includes(stopReason.value));
}

export function persistedTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function persistedNativeSessionId(meta: AgentMetadata): string | null {
  if (!hasOwn(meta, 'native_session_id')) {
    throw new MalformedAgentMetadataError('managed-agent native_session_id is missing');
  }
  const value = meta.native_session_id;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedAgentMetadataError('managed-agent native_session_id is malformed');
  }
  return value;
}

export function persistedVariant(meta: AgentMetadata): string {
  if (!hasOwn(meta, 'variant')) throw new MalformedAgentMetadataError('managed-agent variant is missing');
  const value = meta.variant;
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedAgentMetadataError('managed-agent variant is malformed');
  }
  return value;
}

export function persistedAgentCwd(meta: AgentMetadata): string {
  const value = meta.cwd;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new MalformedAgentMetadataError('managed-agent cwd is malformed');
  }
  return value;
}

export function requiredPersistedAgentId(meta: AgentMetadata): string {
  const value = persistedAgentId(meta.id);
  if (value === null) throw new MalformedAgentMetadataError('managed-agent id is malformed');
  return value;
}

export function steerSequence(meta: AgentMetadata): number | null {
  if (!hasOwn(meta, 'steer_seq')) return null;
  const value = meta.steer_seq;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function idleMeta(agentId: string, cwd: string, title: string | null, now = Date.now() / 1000): AgentMetadata {
  if (persistedAgentId(agentId) !== agentId) throw new MalformedAgentMetadataError('managed-agent id is malformed');
  if (!isAbsolute(cwd)) throw new MalformedAgentMetadataError('managed-agent cwd is malformed');
  if (title !== null && typeof title !== 'string') throw new MalformedAgentMetadataError('managed-agent title is malformed');
  if (persistedTimestamp(now) === null) throw new MalformedAgentMetadataError('managed-agent creation time is malformed');
  const meta: AgentMetadata = {
    id: agentId,
    created_at: now,
    last_activity_at: now,
    state: 'idle',
    cwd,
    title,
    variant: DEFAULT_VARIANT,
    native_session_id: null,
    pid: null,
    pgid: null,
    start_time: null,
    invocation_id: null,
    runner_pid: null,
    runner_start_time: null,
    started_at: null,
    finished_at: null,
    exit_code: null,
    exit_signal: null,
    backend_error: null,
    intent: null,
    delete_pending: false,
    stop_reason: null,
    active_runner: false,
    runner_gen: 0,
    runner_reservation: null,
    steer_queue: [],
    steer_seq: 0,
    prompt_count: 0,
    pending_prompt: null,
    last_prompt: null,
    error: null,
    agent_version: AGENT_META_VERSION,
  };
  validateAgentMetadata(meta);
  return meta;
}
