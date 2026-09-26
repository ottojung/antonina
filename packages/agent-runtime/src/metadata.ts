import { isAbsolute } from 'node:path';

import { persistedAgentId } from './process.js';

export const AGENT_META_VERSION = 3;
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

export function persistedLifecycleState(meta: AgentMetadata): PersistedAgentState | null {
  if (!hasOwn(meta, 'state')) return 'idle';
  const value = meta.state;
  return typeof value === 'string' && (PERSISTED_AGENT_STATES as readonly string[]).includes(value)
    ? value as PersistedAgentState
    : null;
}

export function pendingPrompt(meta: AgentMetadata): string | null {
  if (!hasOwn(meta, 'pending_prompt') || meta.pending_prompt === null) return null;
  const value = meta.pending_prompt;
  if (typeof value !== 'string' || value.length === 0) throw new MalformedPendingPromptMetadataError();
  return value;
}

export function runnerGeneration(value: unknown, minimum = 1): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

export function runnerReservationState(reservation: unknown): RunnerReservationState {
  if (reservation === null || reservation === undefined) return 'absent';
  if (typeof reservation !== 'object' || Array.isArray(reservation)) return 'malformed';
  const state = (reservation as Record<string, unknown>).state;
  return state === 'reserved' || state === 'claimed' ? state : 'malformed';
}

export function runnerReservationMode(reservation: unknown): RunnerReservationMode | null {
  if (typeof reservation !== 'object' || reservation === null || Array.isArray(reservation)) return null;
  const mode = (reservation as Record<string, unknown>).mode;
  return mode === 'new' || mode === 'continue' ? mode : null;
}

export function nextPromptCount(meta: AgentMetadata): number | null {
  if (!hasOwn(meta, 'prompt_count')) return 1;
  const value = meta.prompt_count;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value + 1 : null;
}

export function activeRunnerFlag(meta: AgentMetadata): boolean | null {
  if (!hasOwn(meta, 'active_runner')) return false;
  return typeof meta.active_runner === 'boolean' ? meta.active_runner : null;
}

export function deletePendingFlag(meta: AgentMetadata): boolean | null {
  if (!hasOwn(meta, 'delete_pending')) return false;
  return typeof meta.delete_pending === 'boolean' ? meta.delete_pending : null;
}

export function persistedControlField(
  meta: AgentMetadata,
  key: 'intent' | 'stop_reason',
): { value: ControlReason | null; malformed: boolean } {
  if (!hasOwn(meta, key) || meta[key] === null) return { value: null, malformed: false };
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
  const value = meta.native_session_id;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedAgentMetadataError('managed-agent native_session_id is malformed');
  }
  return value;
}

export function persistedVariant(meta: AgentMetadata): string {
  if (!hasOwn(meta, 'variant')) return DEFAULT_VARIANT;
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

export function idleMeta(agentId: string, cwd: string, title: string | null, now = Date.now() / 1000): AgentMetadata {
  if (persistedAgentId(agentId) !== agentId) throw new MalformedAgentMetadataError('managed-agent id is malformed');
  if (!isAbsolute(cwd)) throw new MalformedAgentMetadataError('managed-agent cwd is malformed');
  if (title !== null && typeof title !== 'string') throw new MalformedAgentMetadataError('managed-agent title is malformed');
  if (persistedTimestamp(now) === null) throw new MalformedAgentMetadataError('managed-agent creation time is malformed');
  return {
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
    unresolved_invocation: null,
    steer_queue: [],
    steer_seq: 0,
    prompt_count: 0,
    agent_version: AGENT_META_VERSION,
  };
}
