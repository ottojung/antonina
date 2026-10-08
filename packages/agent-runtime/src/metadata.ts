import { isAbsolute } from 'node:path';

import { persistedAgentId, persistedInvocationId, persistedProcessInteger } from './process.js';

export const AGENT_META_VERSION = 4;
export const DEFAULT_VARIANT = 'high';
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

/**
 * Optional byte cursor into `output.log`: the offset at which the output of the
 * currently accepted invocation begins. It is validated when present and allowed
 * to be absent, exactly like `BACKEND_SIGNAL_FIELDS`, because a record written
 * before this field existed has no run-scoped cursor and must still be a
 * canonical record. `null` and absence both mean "no invocation has been
 * accepted yet", not a malformed record.
 */
const RUN_LOG_CURSOR_FIELD = 'run_log_offset';

/**
 * Optional, top-level *observation* fields. Validated when present, tolerated
 * when absent, exactly like {@link BACKEND_SIGNAL_FIELDS} below.
 *
 * `invocation_cwd` records where an invocation was actually launched, so
 * `status` can report an observation rather than a declaration. It is not
 * lifecycle authority, and that is a claim about the code rather than about the
 * name: nothing that accepts, refuses, orders or owns work reads it. The
 * launch directory is resolved from `cwd` alone, by
 * {@link requiredAgentCwd}, and `invocation_cwd` is written by the runner only
 * after a child has actually been spawned. Launching from the declaration and
 * writing the observation at the spawn are what keep this field an observation
 * in the strict sense -- a value here is always a directory some front really
 * ran in, never a directory somebody intended one to run in.
 *
 * That strictness is what makes the tolerated absence defensible under intent
 * record `5081437296412058`. The record requires version 4 records to
 * "explicitly contain every lifecycle authority field" and forbids answering
 * a schema change with a dual-read path; an observation field is neither an
 * authority field nor a second way to decide anything, so admitting records
 * written before it existed carries no interpretive risk. The record is
 * written with the field present (`null`) on every new record, so the
 * tolerated absence only ever applies to a pre-existing on-disk population,
 * and it reads as "nothing observed" -- never as a value synthesised from the
 * declaration.
 *
 * `run_log_offset` (board issue 177) sits in the same set and on the same
 * footing: it is a cursor into the run's own log, written when the prompt is
 * accepted, and nothing about accepting, refusing, ordering or owning work reads
 * it. It was carried in separately by 177 and merged here into one list, so
 * there is a single statement of which top-level keys may be absent rather than
 * two that each claim to be the whole set.
 *
 * Exported so the closed-schema test can read the exemptions from here instead
 * of restating them: a test that lists them itself drifts, and a drifted
 * exemption list turns the "missing field is rejected" loop into a loop that
 * quietly stops rejecting.
 */
export const OPTIONAL_TOP_LEVEL_FIELDS = [
  'invocation_cwd',
  RUN_LOG_CURSOR_FIELD,
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

/**
 * Optional, signal-death-only detail. Kept separate from
 * `BACKEND_ERROR_FIELDS` because those nine are always present and
 * `exactKeys` enforces that; these are validated when present so a record
 * written by an older runtime still validates, while a present-but-wrong one
 * is still rejected.
 */
const BACKEND_SIGNAL_FIELDS = [
  'signal',
  'signal_name',
  'oom_evidence',
  'oom_delta',
  'oom_kill_delta',
  'lifetime_seconds',
] as const;

const SIGNAL_DEATH_CLASSIFICATION = 'external_signal_kill';

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

/**
 * Every required field is present, nothing is present beyond the required set
 * plus the optional one, and no duplicates are possible in a JSON object. An
 * unknown key is still a rejection: the top-level metadata shape is exact, and
 * a backend error is a closed record rather than a bag of extras.
 */
function exactKeysWithOptional(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  return required.every((key) => Object.hasOwn(record, key));
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
  if (!exactKeysWithOptional(record, BACKEND_ERROR_FIELDS, BACKEND_SIGNAL_FIELDS)) return false;
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
    ||     record.diagnostic_bytes > 16 * 1024
  ) return false;
  for (const key of BACKEND_SIGNAL_FIELDS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === null) continue;
    if (key === 'signal_name') {
      if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
    } else if (key === 'oom_evidence') {
      if (value !== 'observed' && value !== 'unavailable') return false;
    } else if (key === 'lifetime_seconds') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    } else if (key === 'signal') {
      if (persistedProcessInteger(value, 1) === null) return false;
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return false;
    }
  }
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
  if (!exactKeysWithOptional(meta, TOP_LEVEL_FIELDS, OPTIONAL_TOP_LEVEL_FIELDS)) {
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
  persistedInvocationCwd(meta);
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
  if (persistedRunLogOffset(meta) === null && meta[RUN_LOG_CURSOR_FIELD] !== null && meta[RUN_LOG_CURSOR_FIELD] !== undefined) {
    throw new MalformedAgentMetadataError('managed-agent run_log_offset is malformed');
  }
}

/**
 * The byte offset into `output.log` where the currently accepted invocation's
 * output begins, or `null` when no invocation has been accepted (absent field,
 * an explicit `null`, or a malformed value).
 */
export function persistedRunLogOffset(meta: AgentMetadata): number | null {
  if (!hasOwn(meta, RUN_LOG_CURSOR_FIELD)) return null;
  const value = meta[RUN_LOG_CURSOR_FIELD];
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The fixed-literal prefix of the note an invocation records when the directory
 * it was launched in is not an existing directory (board issue 178). Exported
 * so `agent status`'s display allowlist can match it deliberately instead of
 * withholding it as free text, and kept here rather than in `runner.ts` so the
 * CLI's display allowlist does not have to import the runner's module graph.
 */
export const LAUNCH_DIRECTORY_MISSING = 'cannot launch: working directory does not exist';

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

/**
 * The working directory an operator declared for this front, or `null` when
 * none was ever declared. `null` is a real, canonical state and not a
 * malformed record: a front is not created in whatever directory happened to
 * invoke the CLI, so an agent with no declared directory has no directory to
 * report, and saying so is the only truthful answer. A non-null value is still
 * held to the absolute-path rule, so a present-but-wrong one is rejected.
 */
export function persistedAgentCwd(meta: AgentMetadata): string | null {
  if (!hasOwn(meta, 'cwd')) {
    throw new MalformedAgentMetadataError('managed-agent cwd is missing');
  }
  const value = meta.cwd;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new MalformedAgentMetadataError('managed-agent cwd is malformed');
  }
  return value;
}

/**
 * The single definition of "where does the next invocation launch", for every
 * caller. Board issue 178: the launch directory used to be read twice, once by
 * the command builder for `--dir` and once by the runner for `spawn({cwd})`,
 * with nothing forcing the two reads to agree; one function consumed by both is
 * what makes the report-vs-record invariant hold.
 *
 * It reads the declaration (`cwd`), never the observation
 * (`invocation_cwd`). That is not a simplification. Launching from the
 * declaration is what keeps the observation an observation: `agent run --cwd P`
 * writes `cwd` in the same durable transaction that accepts the prompt, so the
 * declaration is authoritative from the moment the prompt is accepted, and
 * `invocation_cwd` is written later and only by the runner, once a child has
 * actually been spawned. An invocation that is accepted and then never launches
 * leaves the record's observation naming the directory the *previous* invocation
 * ran in, which is the truth, rather than naming one nobody ever entered.
 *
 * A null declaration is not silently replaced by anything: the launch is
 * refused rather than inheriting the invoking shell's directory.
 */
export function requiredAgentCwd(meta: AgentMetadata): string {
  const value = persistedAgentCwd(meta);
  if (value === null) throw new MalformedAgentMetadataError('managed-agent cwd is undeclared');
  return value;
}

/**
 * The directory the current or most recent invocation was *launched in*, or
 * `null` when no invocation has ever been launched.
 *
 * Absent is a real, canonical state, not a malformed record: every record
 * written before board issue 178 has no such field, and the product does not
 * maintain a dual-read compatibility path or synthesise a legacy default. What
 * it does instead is treat absence as "nothing observed", which is the truthful
 * reading of a record that predates the observation. A present-but-wrong value
 * is still rejected, and `null` is still a legitimate present value.
 *
 * This is deliberately *not* a second declaration, and the two are written by
 * different actors at different times. `cwd` is what the operator declared, and
 * the accepting command writes it in the same durable transaction that accepts
 * the prompt. `invocation_cwd` is written by the runner, in the same durable
 * transaction that publishes the spawned process identity, so a value here is
 * always a directory a real front was actually launched in. On a record that has
 * run they usually agree; where they can disagree is an invocation that was
 * accepted and never launched, or a record that has never run at all, and then
 * this field is the one that is null.
 */
export function persistedInvocationCwd(meta: AgentMetadata): string | null {
  if (!hasOwn(meta, 'invocation_cwd')) return null;
  const value = meta.invocation_cwd;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new MalformedAgentMetadataError('managed-agent invocation_cwd is malformed');
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

export function idleMeta(agentId: string, cwd: string | null, title: string | null, now = Date.now() / 1000): AgentMetadata {
  if (persistedAgentId(agentId) !== agentId) throw new MalformedAgentMetadataError('managed-agent id is malformed');
  if (cwd !== null && !isAbsolute(cwd)) throw new MalformedAgentMetadataError('managed-agent cwd is malformed');
  if (title !== null && typeof title !== 'string') throw new MalformedAgentMetadataError('managed-agent title is malformed');
  if (persistedTimestamp(now) === null) throw new MalformedAgentMetadataError('managed-agent creation time is malformed');
  const meta: AgentMetadata = {
    id: agentId,
    created_at: now,
    last_activity_at: now,
    state: 'idle',
    cwd,
    invocation_cwd: null,
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
    run_log_offset: null,
    agent_version: AGENT_META_VERSION,
  };
  validateAgentMetadata(meta);
  return meta;
}
